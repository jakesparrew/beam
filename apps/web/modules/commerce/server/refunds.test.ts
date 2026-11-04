/**
 * commerce-P6 refunds (rules 36 to 40, 37a, 38, edge cases 12 to 14, 35): a partial package
 * refund revokes only unused units; session lines cancel their booking through
 * `cancelBookingsForOrderLine` (`refunded`); `refundOrderLine` from booking never calls booking
 * back and is idempotent; a membership line calls `cancelMembershipForRefund` with a day pro-rata
 * default; vouchers refund only while unredeemed and withdraw a scheduled email; credit balance
 * first (`releaseCredits` for the whole amount, `grantCredits` for a part); above € 500 needs
 * `invoices.issue`; one credit note per refund and `markCreditNoteSettled` when it is refunded; a
 * provider failure fails the refund and Retry makes it pending again; no credit note without invoice.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makePerson, makeProduct, makeUser } from "@beam/db/testing";
import { makeOrderLine, makePaidOrder } from "@beam/db/testing/commerce-factories";
import { makeMembership } from "@beam/db/testing/credits-factories";
import type { DbHandle, Tx } from "@beam/db";
import { activityEvents, emailMessages, invoices, jobs, orders, payments, refunds, vouchers } from "@beam/db/schema";

vi.mock("next/headers", () => ({ cookies: () => Promise.resolve({ get: () => undefined }), headers: () => Promise.resolve(new Headers()) }));
vi.mock("next/server", () => ({ after: () => undefined }));

const cancelBookingsForOrderLine = vi.fn<(...a: unknown[]) => unknown>();
vi.mock("@/modules/booking/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  cancelBookingsForOrderLine: (...a: unknown[]) => cancelBookingsForOrderLine(...a),
}));
const getGrantUsage = vi.fn<(...a: unknown[]) => unknown>();
const revokeGrantRemainder = vi.fn<(...a: unknown[]) => unknown>();
const cancelMembershipForRefund = vi.fn<(...a: unknown[]) => unknown>();
const releaseCredits = vi.fn<(...a: unknown[]) => unknown>();
const grantCredits = vi.fn<(...a: unknown[]) => unknown>();
vi.mock("@/modules/credits/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getGrantUsage: (...a: unknown[]) => getGrantUsage(...a),
  revokeGrantRemainder: (...a: unknown[]) => revokeGrantRemainder(...a),
  cancelMembershipForRefund: (...a: unknown[]) => cancelMembershipForRefund(...a),
  releaseCredits: (...a: unknown[]) => releaseCredits(...a),
  grantCredits: (...a: unknown[]) => grantCredits(...a),
}));
const getInvoiceForOrder = vi.fn<(...a: unknown[]) => unknown>();
const issueCreditNote = vi.fn<(...a: unknown[]) => unknown>();
const markCreditNoteSettled = vi.fn<(...a: unknown[]) => unknown>();
vi.mock("@/modules/finance/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getInvoiceForOrder: (...a: unknown[]) => getInvoiceForOrder(...a),
  issueCreditNote: (...a: unknown[]) => issueCreditNote(...a),
  markCreditNoteSettled: (...a: unknown[]) => markCreditNoteSettled(...a),
}));
const createTask = vi.fn<(...a: unknown[]) => unknown>();
vi.mock("@/modules/crm/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createTask: (...a: unknown[]) => createTask(...a),
}));
const cancelScheduledMessage = vi.fn<(...a: unknown[]) => unknown>();
vi.mock("@/modules/email/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  cancelScheduledMessage: (...a: unknown[]) => cancelScheduledMessage(...a),
}));

const { issueRefund, refundOrderLine, retryRefund, confirmManualRefund, runProviderRefund } = await import("./refunds");
const { createCtx, eq, and } = await import("@/lib/ctx");
const { makeCtx, makeJobCtx, resetRuntime, createFakeIntegrations, staffActor } = await import("@/lib/testing");

let h: DbHandle;
let staffUserId: string;

beforeAll(async () => {
  h = await createTestDb();
  makeCtx(h.db, { integrations: createFakeIntegrations() });
  staffUserId = (await makeUser(h.db)).id;
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(() => {
  cancelBookingsForOrderLine.mockReset().mockResolvedValue({ cancelledBookingIds: [randomUUID()] });
  getGrantUsage.mockReset().mockResolvedValue({ grants: [] });
  revokeGrantRemainder.mockReset().mockResolvedValue({ revokedUnits: 5, grants: [] });
  cancelMembershipForRefund.mockReset().mockResolvedValue(undefined);
  releaseCredits.mockReset().mockResolvedValue({ releasedUnits: 1000 });
  grantCredits.mockReset().mockResolvedValue({ grantId: randomUUID(), created: true });
  getInvoiceForOrder.mockReset().mockResolvedValue({ id: randomUUID(), kind: "invoice", number: "2026-000001", issuedOn: "2026-11-01", status: "paid", totalCents: 1, isCompany: false, pdfReady: true });
  issueCreditNote.mockReset().mockImplementation(async (tx: unknown, _ctx: unknown, input: unknown) => ({ creditNoteId: await creditNoteRow(tx as Tx, (input as { orderId: string }).orderId), number: "CN-2026-000001", totalCents: -1 }));
  markCreditNoteSettled.mockReset().mockResolvedValue(undefined);
  cancelScheduledMessage.mockReset().mockResolvedValue({ cancelled: true });
  createTask.mockReset().mockResolvedValue({ taskId: randomUUID(), created: true });
});

const NOW = new Date("2026-11-04T10:00:00.000Z");
const ALL = ["commerce.refund", "commerce.sell", "invoices.issue"];

/** A stand-in finance row in the caller's transaction, so `refunds.credit_note_id -> invoices.id` holds (the finance mock returns its id). */
async function creditNoteRow(tx: Tx, orderId: string): Promise<string> {
  const seq = 1 + Math.floor(Math.random() * 999_998);
  const [row] = await tx
    .insert(invoices)
    .values({
      kind: "invoice",
      number: `BEAM-2026-${String(seq).padStart(6, "0")}`,
      orderId,
      locale: "nl-BE",
      customerSnapshot: { anonymised: true } as never,
      sellerSnapshot: {} as never,
      lines: [{}] as never,
      vatBreakdown: [] as never,
      subtotalCents: 1,
      vatCents: 0,
      totalCents: 1,
      issuedOn: "2026-11-04",
      fiscalYear: 2026,
      sequenceNumber: seq,
      status: "paid",
      paidAt: NOW,
      issuedBy: { kind: "system", id: null } as never,
    })
    .returning({ id: invoices.id });
  return row!.id;
}

function inTx<T>(fn: (tx: Tx, ctx: ReturnType<typeof createCtx>) => Promise<T>, permissions: string[] = ALL): Promise<T> {
  return h.db.transaction((tx) =>
    fn(tx, createCtx({ tx, actor: staffActor({ userId: staffUserId, permissions }), durableMode: "immediate", now: NOW })),
  );
}

async function paidWith(personId: string, lines: Parameters<typeof makePaidOrder>[1]["lines"], pays: Array<{ provider: "mollie" | "credit_balance" | "cash" | "bank_transfer"; amountCents: number }>) {
  const { order, lines: rows } = await makePaidOrder(h.db, { personId, lines, order: { paidAt: new Date("2026-11-01T10:00:00Z") } });
  const paymentRows = [];
  for (const p of pays) {
    const [row] = await h.db
      .insert(payments)
      .values({ orderId: order.id, provider: p.provider, status: "paid", amountCents: p.amountCents, paidAt: order.paidAt, providerPaymentId: p.provider === "mollie" ? `tr_${randomUUID().replace(/-/g, "").slice(0, 10)}` : null })
      .returning();
    paymentRows.push(row!);
  }
  return { order, lines: rows, payments: paymentRows };
}

const orderRow = async (id: string) => (await h.db.select().from(orders).where(eq(orders.id, id)))[0]!;

describe("issueRefund", () => {
  it("refunds the unused unit of a partly used package and revokes only its grant", async () => {
    // Without an invoice in this case, so the finance mock needs no credit-note row.
    getInvoiceForOrder.mockResolvedValue(null);
    const person = await makePerson(h.db);
    const product = await makeProduct(h.db, { kind: "package" });
    const { order, lines, payments: [card] } = await paidWith(person.id, [{ productId: product.id, productKind: "package", quantity: 2, unitAmountCents: 20_000 }], [{ provider: "mollie", amountCents: 40_000 }]);
    getGrantUsage.mockResolvedValue({
      grants: [
        { grantId: "g-used", unitsGranted: 5, usedUnits: 3, remainingUnits: 2, status: "active", unitValueCents: 4000 },
        { grantId: "g-free", unitsGranted: 5, usedUnits: 0, remainingUnits: 5, status: "active", unitValueCents: 4000 },
      ],
    });
    const out = await inTx((tx, ctx) => issueRefund(tx, ctx, { orderId: order.id, lines: [{ orderLineId: lines[0]!.id, quantity: 1 }], reason: "customer request", kind: "refund", checkSecondPermission: true }));
    expect(out.amountCents).toBe(20_000);
    expect(revokeGrantRemainder).toHaveBeenCalledWith(expect.anything(), expect.anything(), { orderLineId: lines[0]!.id, grantIds: ["g-free"], refundId: out.refundIds[0], reason: "refund" });
    const [refund] = await h.db.select().from(refunds).where(eq(refunds.orderId, order.id));
    expect(refund).toMatchObject({ status: "pending", amountCents: 20_000, creditAction: "revoke", paymentId: card!.id, createdByUserId: staffUserId });
    expect(refund!.lines).toEqual([{ order_line_id: lines[0]!.id, quantity: 1, amount_cents: 20_000 }]);
    expect((await orderRow(order.id)).status).toBe("partially_refunded");
    expect((await h.db.select().from(payments).where(eq(payments.id, card!.id)))[0]).toMatchObject({ refundedCents: 20_000, status: "partially_refunded" });
    expect(await h.db.select().from(jobs).where(eq(jobs.idempotencyKey, `refund:${refund!.id}`))).toHaveLength(1);
    expect(issueCreditNote).not.toHaveBeenCalled();
    const events = await h.db.select().from(activityEvents).where(and(eq(activityEvents.kind, "order.refunded"), eq(activityEvents.personId, person.id)));
    expect(events).toHaveLength(1);
  });

  it("cancels the booking of a session line through cancelBookingsForOrderLine with refunded", async () => {
    getInvoiceForOrder.mockResolvedValue(null);
    const person = await makePerson(h.db);
    const { order, lines } = await paidWith(person.id, [{ productKind: "session", unitAmountCents: 4500, data: { booking_ids: [randomUUID()] } }], [{ provider: "cash", amountCents: 4500 }]);
    await inTx((tx, ctx) => issueRefund(tx, ctx, { orderId: order.id, lines: [{ orderLineId: lines[0]!.id, quantity: 1 }], reason: "staff refund", kind: "refund" }));
    expect(cancelBookingsForOrderLine).toHaveBeenCalledWith(expect.anything(), expect.anything(), { orderLineId: lines[0]!.id, reason: "refunded" });
    expect((await orderRow(order.id)).status).toBe("refunded");
    // Cash is paid at the counter: refunded at once.
    expect((await h.db.select().from(refunds).where(eq(refunds.orderId, order.id)))[0]!.status).toBe("refunded");
  });

  it("calls cancelMembershipForRefund with a default pro rata to the unused days", async () => {
    getInvoiceForOrder.mockResolvedValue(null);
    const person = await makePerson(h.db);
    const product = await makeProduct(h.db, { kind: "membership" });
    const { order, lines } = await paidWith(person.id, [{ productId: product.id, productKind: "membership", unitAmountCents: 9000 }], [{ provider: "cash", amountCents: 9000 }]);
    const membership = await makeMembership(h.db, {
      personId: person.id,
      productId: product.id,
      firstOrderId: order.id,
      startedAt: new Date(NOW.getTime() - 10 * 86_400_000),
      currentPeriodStartAt: new Date(NOW.getTime() - 10 * 86_400_000),
      currentPeriodEndAt: new Date(NOW.getTime() + 20 * 86_400_000),
    });
    const out = await inTx((tx, ctx) => issueRefund(tx, ctx, { orderId: order.id, lines: [{ orderLineId: lines[0]!.id, quantity: 1 }], reason: "moving abroad", kind: "refund" }));
    expect(out.amountCents).toBe(6000);
    expect(cancelMembershipForRefund).toHaveBeenCalledWith(expect.anything(), expect.anything(), { membershipId: membership.id, reason: "refund" });
  });

  it("refunds a voucher only while unredeemed, voids it and withdraws its scheduled email", async () => {
    getInvoiceForOrder.mockResolvedValue(null);
    const person = await makePerson(h.db);
    const product = await makeProduct(h.db, { kind: "voucher" });
    const { order, lines } = await paidWith(person.id, [{ productId: product.id, productKind: "voucher", quantity: 2, unitAmountCents: 5000, vatRatePct: "0.00" }], [{ provider: "cash", amountCents: 10_000 }]);
    const [message] = await h.db.insert(emailMessages).values({ kind: "transactional", locale: "nl-BE", idempotencyKey: `test:${randomUUID()}`, sendAt: new Date(NOW.getTime() + 5 * 86_400_000) }).returning();
    const [active] = await h.db.insert(vouchers).values({ orderLineId: lines[0]!.id, amountCents: 5000, status: "active", expiresAt: new Date("2028-11-01"), emailMessageId: message!.id }).returning();
    await h.db.insert(vouchers).values({ orderLineId: lines[0]!.id, amountCents: 5000, status: "redeemed", expiresAt: new Date("2028-11-01") });

    await expect(inTx((tx, ctx) => issueRefund(tx, ctx, { orderId: order.id, lines: [{ orderLineId: lines[0]!.id, quantity: 2 }], reason: "gift not wanted", kind: "refund" }))).rejects.toMatchObject({ message: "voucher_used" });
    const out = await inTx((tx, ctx) => issueRefund(tx, ctx, { orderId: order.id, lines: [{ orderLineId: lines[0]!.id, quantity: 1 }], reason: "gift not wanted", kind: "refund" }));
    expect(out.amountCents).toBe(5000);
    expect((await h.db.select().from(vouchers).where(eq(vouchers.id, active!.id)))[0]).toMatchObject({ status: "void", voidedReason: "refunded" });
    expect(cancelScheduledMessage).toHaveBeenCalledWith(expect.anything(), { messageId: message!.id });
  });

  it("goes to credit balance first: a whole credit-balance refund releases, a part grants", async () => {
    getInvoiceForOrder.mockResolvedValue(null);
    const person = await makePerson(h.db);
    const { order, lines, payments: [credit] } = await paidWith(person.id, [{ unitAmountCents: 3000 }, { unitAmountCents: 2000 }], [{ provider: "credit_balance", amountCents: 1000 }, { provider: "cash", amountCents: 4000 }]);
    // 500 of the item go back: all of it from the 1000 credit balance (a part) -> grant.
    const part = await inTx((tx, ctx) => issueRefund(tx, ctx, { orderId: order.id, lines: [{ orderLineId: lines[1]!.id, quantity: 1, amountCents: 500 }], reason: "goodwill", kind: "refund" }));
    expect(releaseCredits).not.toHaveBeenCalled();
    expect(grantCredits).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      personId: person.id,
      kind: "euro",
      units: 500,
      source: "manual",
      refundId: part.refundIds[0],
      vatRatePct: null,
      expiresAt: null,
      key: `grant:refund:${part.refundIds[0]}`,
      reason: "partial_refund",
    });
    const [creditAfter] = await h.db.select().from(payments).where(eq(payments.id, credit!.id));
    expect(creditAfter).toMatchObject({ refundedCents: 500, status: "partially_refunded" });

    // A fresh order whose whole credit balance goes back: releaseCredits with reason refund.
    const second = await paidWith(person.id, [{ unitAmountCents: 1000 }], [{ provider: "credit_balance", amountCents: 1000 }]);
    grantCredits.mockClear();
    await inTx((tx, ctx) => issueRefund(tx, ctx, { orderId: second.order.id, lines: [{ orderLineId: second.lines[0]!.id, quantity: 1 }], reason: "goodwill", kind: "refund" }));
    expect(releaseCredits).toHaveBeenCalledWith(expect.anything(), expect.anything(), { ref: { type: "order", id: second.order.id }, reason: "refund" });
    expect(grantCredits).not.toHaveBeenCalled();
  });

  it("needs invoices.issue above € 500, and refuses more than was paid", async () => {
    getInvoiceForOrder.mockResolvedValue(null);
    const person = await makePerson(h.db);
    const { order, lines } = await paidWith(person.id, [{ unitAmountCents: 60_000 }], [{ provider: "cash", amountCents: 60_000 }]);
    await expect(
      inTx((tx, ctx) => issueRefund(tx, ctx, { orderId: order.id, lines: [{ orderLineId: lines[0]!.id, quantity: 1 }], reason: "big refund", kind: "refund", checkSecondPermission: true }), ["commerce.refund"]),
    ).rejects.toMatchObject({ name: "ForbiddenError" });
    await expect(
      inTx((tx, ctx) => issueRefund(tx, ctx, { orderId: order.id, lines: [{ orderLineId: lines[0]!.id, quantity: 1, amountCents: 70_000 }], reason: "too much", kind: "refund" })),
    ).rejects.toMatchObject({ message: "refund_too_high" });
    const ok = await inTx((tx, ctx) => issueRefund(tx, ctx, { orderId: order.id, lines: [{ orderLineId: lines[0]!.id, quantity: 1 }], reason: "big refund", kind: "refund", checkSecondPermission: true }));
    expect(ok.amountCents).toBe(60_000);
  });

  it("issues one credit note per refund and settles it when the refund is refunded", async () => {
    const person = await makePerson(h.db);
    const { order, lines } = await paidWith(person.id, [{ unitAmountCents: 4500 }], [{ provider: "cash", amountCents: 4500 }]);
    const out = await inTx((tx, ctx) => issueRefund(tx, ctx, { orderId: order.id, lines: [{ orderLineId: lines[0]!.id, quantity: 1 }], reason: "wrong item", kind: "refund" }));
    expect(issueCreditNote).toHaveBeenCalledTimes(1);
    expect(issueCreditNote).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      orderId: order.id,
      refundId: out.refundIds[0],
      reason: "wrong item",
      lines: [{ orderLineId: lines[0]!.id, amountCents: 4500 }],
    });
    expect(out.creditNoteId).not.toBeNull();
    expect(markCreditNoteSettled).toHaveBeenCalledWith(expect.anything(), expect.anything(), { refundId: out.refundIds[0], settledAt: NOW });
    const mails = await h.db.select().from(emailMessages).where(eq(emailMessages.idempotencyKey, `refund:${out.refundIds[0]}:confirmation`));
    expect(mails).toHaveLength(1);
  });

  it("issues no credit note for an order without invoice (0 total)", async () => {
    getInvoiceForOrder.mockResolvedValue(null);
    const person = await makePerson(h.db);
    const { order, lines } = await paidWith(person.id, [{ unitAmountCents: 2000 }], [{ provider: "cash", amountCents: 2000 }]);
    await inTx((tx, ctx) => issueRefund(tx, ctx, { orderId: order.id, lines: [{ orderLineId: lines[0]!.id, quantity: 1 }], reason: "no invoice", kind: "refund" }));
    expect(issueCreditNote).not.toHaveBeenCalled();
  });
});

describe("refundOrderLine (rule 37a)", () => {
  it("refunds the full line without calling booking back, once per line and reason", async () => {
    getInvoiceForOrder.mockResolvedValue(null);
    const person = await makePerson(h.db);
    const { order, lines } = await paidWith(person.id, [{ productKind: "session", unitAmountCents: 4500, data: { booking_ids: [randomUUID()] } }, { unitAmountCents: 1000 }], [{ provider: "mollie", amountCents: 5500 }]);
    const run = () =>
      h.db.transaction((tx) => refundOrderLine(tx, createCtx({ tx, actor: { kind: "system", jobId: "" }, durableMode: "immediate", now: NOW }), { orderLineId: lines[0]!.id, reason: "cancelled_in_policy" }));
    const first = await run();
    const second = await run();
    expect(first.amountCents).toBe(4500);
    expect(second).toEqual(first);
    expect(cancelBookingsForOrderLine).not.toHaveBeenCalled();
    const rows = await h.db.select().from(refunds).where(eq(refunds.orderId, order.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reason: "cancelled_in_policy", amountCents: 4500, status: "pending" });
    expect((await orderRow(order.id)).status).toBe("partially_refunded");
  });

  it("returns no refund for an unpaid order", async () => {
    const person = await makePerson(h.db);
    const line = await makeOrderLine(h.db, { orderId: (await paidWith(person.id, [], [])).order.id });
    await h.db.update(orders).set({ status: "pending_payment", paidAt: null }).where(eq(orders.id, line.orderId));
    const out = await h.db.transaction((tx) => refundOrderLine(tx, createCtx({ tx, actor: { kind: "system", jobId: "" }, durableMode: "immediate", now: NOW }), { orderLineId: line.id, reason: "session_cancelled" }));
    expect(out).toEqual({ refundId: null, amountCents: 0 });
  });
});

describe("provider refunds", () => {
  it("a provider failure fails the refund; Retry makes it pending with a retry job", async () => {
    getInvoiceForOrder.mockResolvedValue(null);
    const fake = createFakeIntegrations();
    const person = await makePerson(h.db);
    const { order, lines } = await paidWith(person.id, [{ unitAmountCents: 4500 }], [{ provider: "mollie", amountCents: 4500 }]);
    const out = await inTx((tx, ctx) => issueRefund(tx, ctx, { orderId: order.id, lines: [{ orderLineId: lines[0]!.id, quantity: 1 }], reason: "provider test", kind: "refund" }));
    const refundId = out.refundIds[0]!;
    // The fake does not know this payment: the refund is refused (4xx) -> failed.
    const result = await h.db.transaction((tx) => runProviderRefund(makeJobCtx(h.db, "payments.refund", { integrations: fake, tx, key: `refund:${refundId}` }), { refundId }));
    expect(result).toMatchObject({ status: "failed" });
    expect(createTask).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ kind: "payment", ownerRole: "finance", dedupeKey: `refund_failed:${refundId}` }));
    expect((await h.db.select().from(refunds).where(eq(refunds.id, refundId)))[0]).toMatchObject({ status: "failed", failedReason: "provider_rejected" });

    await inTx((tx, ctx) => retryRefund(tx, ctx, { refundId }));
    expect((await h.db.select().from(refunds).where(eq(refunds.id, refundId)))[0]!.status).toBe("pending");
    expect(await h.db.select().from(jobs).where(eq(jobs.idempotencyKey, `refund:${refundId}:retry:1`))).toHaveLength(1);
  });

  it("a bank-transfer refund is sent until staff confirm it", async () => {
    getInvoiceForOrder.mockResolvedValue(null);
    const person = await makePerson(h.db);
    const { order, lines } = await paidWith(person.id, [{ unitAmountCents: 4500 }], [{ provider: "bank_transfer", amountCents: 4500 }]);
    const out = await inTx((tx, ctx) => issueRefund(tx, ctx, { orderId: order.id, lines: [{ orderLineId: lines[0]!.id, quantity: 1 }], reason: "transfer back", kind: "refund" }));
    const refundId = out.refundIds[0]!;
    expect((await h.db.select().from(refunds).where(eq(refunds.id, refundId)))[0]!.status).toBe("sent");
    await inTx((tx, ctx) => confirmManualRefund(tx, ctx, { refundId }));
    expect((await h.db.select().from(refunds).where(eq(refunds.id, refundId)))[0]!.status).toBe("refunded");
    await expect(inTx((tx, ctx) => confirmManualRefund(tx, ctx, { refundId }))).rejects.toMatchObject({ message: "invalid_transition" });
  });
});
