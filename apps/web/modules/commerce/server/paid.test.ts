/**
 * commerce-P4a the paid transaction (rules 19, 28, 31, 32, 45, 54; edge cases 4 and 28): a package
 * line of quantity 2 calls `grantCredits` twice with keys `grant:order_line:<id>:<n>`; a membership
 * calls `activateMembership`; a renewal order calls `applyRenewalPayment`; vouchers are activated;
 * `confirmBookingsForOrder` runs once; `issueInvoice` with status `paid`; paid after local expiry
 * moves `expired -> paid` and re-confirms the redemption; unavailable seats enqueue
 * `commerce.refund_unavailable_lines` once; a failing `grantCredits` rolls everything back.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makePerson, makeProduct, makeSession, makeUser } from "@beam/db/testing";
import { makeOrder, makeOrderLine } from "@beam/db/testing/commerce-factories";
import { makeMembership } from "@beam/db/testing/credits-factories";
import type { DbHandle, Tx } from "@beam/db";
import { activityEvents, jobs, mandates, orders, payments, priceVersions, promotionRedemptions, promotions, vouchers } from "@beam/db/schema";
import { computeExpiresAt } from "@beam/core/credits";

vi.mock("next/headers", () => ({ cookies: () => Promise.resolve({ get: () => undefined }), headers: () => Promise.resolve(new Headers()) }));
vi.mock("next/server", () => ({ after: () => undefined }));

const credits = {
  grantCredits: vi.fn(),
  activateMembership: vi.fn(),
  applyRenewalPayment: vi.fn(),
  applyRenewalFailure: vi.fn(),
};
vi.mock("@/modules/credits/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  grantCredits: (...a: unknown[]) => credits.grantCredits(...a),
  activateMembership: (...a: unknown[]) => credits.activateMembership(...a),
  applyRenewalPayment: (...a: unknown[]) => credits.applyRenewalPayment(...a),
  applyRenewalFailure: (...a: unknown[]) => credits.applyRenewalFailure(...a),
}));
const confirmBookingsForOrder = vi.fn();
vi.mock("@/modules/booking/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  confirmBookingsForOrder: (...a: unknown[]) => confirmBookingsForOrder(...a),
}));
const issueInvoice = vi.fn();
vi.mock("@/modules/finance/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  issueInvoice: (...a: unknown[]) => issueInvoice(...a),
}));

const { finalizePaidOrder, brusselsMidnight } = await import("./paid");
const { applyProviderStatus } = await import("./payments");
const { createCtx, eq, and } = await import("@/lib/ctx");
const { makeCtx, resetRuntime, createFakeIntegrations } = await import("@/lib/testing");

let h: DbHandle;
let staffUserId: string;

beforeAll(async () => {
  process.env.VOUCHER_CODE_SECRET ??= "test-voucher-secret-0123456789abcdef";
  h = await createTestDb();
  makeCtx(h.db, { integrations: createFakeIntegrations() });
  staffUserId = (await makeUser(h.db)).id;
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(() => {
  credits.grantCredits.mockReset().mockImplementation(() => Promise.resolve({ grantId: randomUUID(), created: true }));
  credits.activateMembership.mockReset().mockResolvedValue({ membershipId: randomUUID(), status: "active", created: true });
  credits.applyRenewalPayment.mockReset().mockResolvedValue({ periodStartAt: new Date(), periodEndAt: new Date(), applied: true });
  credits.applyRenewalFailure.mockReset().mockResolvedValue({ status: "past_due", dunningAttempt: 1, applied: true });
  confirmBookingsForOrder.mockReset().mockResolvedValue({ confirmedBookingIds: [], unavailableOrderLineIds: [] });
  issueInvoice.mockReset().mockResolvedValue({ status: "issued", invoiceId: randomUUID(), number: "2026-000001" });
});

const NOW = new Date("2026-11-04T10:00:00.000Z");

function inTx<T>(fn: (tx: Tx, ctx: ReturnType<typeof createCtx>) => Promise<T>, now = NOW): Promise<T> {
  return h.db.transaction((tx) => fn(tx, createCtx({ tx, actor: { kind: "system", jobId: "" }, durableMode: "immediate", now })));
}

async function openOrder(totalCents: number, extra: Parameters<typeof makeOrder>[1] = {}) {
  const person = await makePerson(h.db);
  const order = await makeOrder(h.db, { personId: person.id, channel: "portal", status: "pending_payment", subtotalCents: totalCents, totalCents, ...extra });
  return { person, order };
}

async function paidProviderPayment(orderId: string, amountCents: number) {
  const [p] = await h.db.insert(payments).values({ orderId, provider: "mollie", providerPaymentId: `tr_${randomUUID().slice(0, 8)}`, status: "open", amountCents }).returning();
  return p!;
}

describe("finalizePaidOrder", () => {
  it("grants a package line of quantity 2 once per unit with grant:order_line:<id>:<n> (rule 32)", async () => {
    const pkg = await makeProduct(h.db, { kind: "package", creditKind: "day", creditUnits: 5, validityDays: 180, priceCents: 20_000 });
    const { person, order } = await openOrder(60_000);
    const line = await makeOrderLine(h.db, { orderId: order.id, productId: pkg.id, quantity: 2, unitAmountCents: 20_000 });
    const later = await makeOrderLine(h.db, { orderId: order.id, productId: pkg.id, quantity: 1, unitAmountCents: 20_000, data: { start_on: "2026-12-01" } });

    const result = await inTx((tx, ctx) => finalizePaidOrder(tx, ctx, order.id));
    expect(credits.grantCredits).toHaveBeenCalledTimes(3);
    const calls = credits.grantCredits.mock.calls.map((c) => c[2] as Record<string, unknown>);
    expect(calls.map((c) => c.key)).toEqual([`grant:order_line:${line.id}:1`, `grant:order_line:${line.id}:2`, `grant:order_line:${later.id}:1`]);
    expect(calls[0]).toMatchObject({
      personId: person.id,
      kind: "day",
      units: 5,
      source: "purchase",
      productId: pkg.id,
      orderLineId: line.id,
      lineUnitIndex: 1,
      unitValueCents: 4000,
      startsAt: NOW,
      expiresAt: computeExpiresAt(NOW, 180),
    });
    expect(calls[1]).toMatchObject({ lineUnitIndex: 2 });
    const startsAt = brusselsMidnight("2026-12-01");
    expect(startsAt.toISOString()).toBe("2026-11-30T23:00:00.000Z");
    expect(calls[2]).toMatchObject({ startsAt, expiresAt: computeExpiresAt(startsAt, 180) });
    expect(result.delivered.filter((d) => d.result === "credits_granted")).toHaveLength(2);

    const [after] = await h.db.select().from(orders).where(eq(orders.id, order.id));
    expect(after).toMatchObject({ status: "paid", version: order.version + 1 });
    expect(after!.paidAt?.toISOString()).toBe(NOW.toISOString());
    // Online package: 14-day withdrawal (rule 54).
    expect(after!.withdrawalUntilAt?.toISOString()).toBe(new Date(NOW.getTime() + 14 * 86_400_000).toISOString());
    expect(issueInvoice).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ orderId: order.id, status: "paid" }));
    const events = await h.db.select().from(activityEvents).where(and(eq(activityEvents.kind, "order.paid"), eq(activityEvents.personId, person.id)));
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toMatchObject({ order_id: order.id, reference: order.reference, total_cents: 60_000, channel: "portal", product_kinds: ["package"] });
    expect(await h.db.select().from(jobs).where(eq(jobs.idempotencyKey, `receipt:${order.id}`))).toHaveLength(1);
  });

  it("is a no-op for an order that is already paid (edge case 28)", async () => {
    const pkg = await makeProduct(h.db, { kind: "package", priceCents: 20_000 });
    const { order } = await openOrder(20_000);
    await makeOrderLine(h.db, { orderId: order.id, productId: pkg.id, quantity: 1, unitAmountCents: 20_000 });
    await inTx((tx, ctx) => finalizePaidOrder(tx, ctx, order.id));
    const second = await inTx((tx, ctx) => finalizePaidOrder(tx, ctx, order.id));
    expect(second.delivered).toEqual([]);
    expect(credits.grantCredits).toHaveBeenCalledTimes(1);
    expect(issueInvoice).toHaveBeenCalledTimes(1);
  });

  it("activates a membership with the payment's mandate and applies a renewal payment instead for renewal orders", async () => {
    const plan = await makeProduct(h.db, { kind: "membership", priceCents: 8900 });
    const [pv] = await h.db.select().from(priceVersions).where(eq(priceVersions.productId, plan.id));
    const { person, order } = await openOrder(8900);
    const line = await makeOrderLine(h.db, { orderId: order.id, productId: plan.id, quantity: 1, unitAmountCents: 8900, priceVersionId: pv!.id });
    const payment = await paidProviderPayment(order.id, 8900);
    await inTx((tx, ctx) => applyProviderStatus(tx, ctx, payment, { status: "paid", method: "creditcard", mandateId: "mdt_test1", customerId: "cst_test1" }));
    const [mandate] = await h.db.select().from(mandates).where(eq(mandates.providerMandateId, "mdt_test1"));
    expect(mandate).toMatchObject({ personId: person.id, providerCustomerId: "cst_test1", status: "valid" });
    expect(credits.activateMembership).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      personId: person.id,
      productId: plan.id,
      orderId: order.id,
      priceVersionId: pv!.id,
      mandateId: mandate!.id,
      startsAt: NOW,
    });
    void line;

    const membership = await makeMembership(h.db, { personId: person.id, productId: plan.id });
    const renewal = await makeOrder(h.db, { personId: person.id, channel: "recurring", status: "pending_payment", subtotalCents: 8900, totalCents: 8900, renewalMembershipId: membership.id, renewalPeriodEndOn: "2026-12-04" });
    await makeOrderLine(h.db, { orderId: renewal.id, productId: plan.id, quantity: 1, unitAmountCents: 8900, priceVersionId: pv!.id });
    credits.activateMembership.mockClear();
    await inTx((tx, ctx) => finalizePaidOrder(tx, ctx, renewal.id));
    expect(credits.applyRenewalPayment).toHaveBeenCalledTimes(1);
    expect(credits.applyRenewalPayment).toHaveBeenCalledWith(expect.anything(), expect.anything(), { membershipId: membership.id, orderId: renewal.id });
    expect(credits.activateMembership).not.toHaveBeenCalled();
  });

  it("activates vouchers without a credits call and confirms bookings once for all session lines", async () => {
    const voucherProduct = await makeProduct(h.db, { kind: "voucher", validityDays: 730, priceCents: 5000 });
    const sessionProduct = await makeProduct(h.db, { kind: "session", priceCents: 4500 });
    const { order } = await openOrder(14_000);
    const vLine = await makeOrderLine(h.db, { orderId: order.id, productId: voucherProduct.id, quantity: 1, unitAmountCents: 5000, vatRatePct: "0.00", vatCents: 0 });
    const [v] = await h.db.insert(vouchers).values({ orderLineId: vLine.id, amountCents: 5000, status: "pending" }).returning();
    const s1 = await makeSession(h.db);
    await makeOrderLine(h.db, { orderId: order.id, productId: sessionProduct.id, sessionId: s1.id, unitAmountCents: 4500, data: { booking_ids: [randomUUID()] } });
    await makeOrderLine(h.db, { orderId: order.id, productId: sessionProduct.id, sessionId: s1.id, unitAmountCents: 4500, data: { booking_ids: [randomUUID()] } });

    const r = await inTx((tx, ctx) => finalizePaidOrder(tx, ctx, order.id));
    expect(credits.grantCredits).not.toHaveBeenCalled();
    expect(confirmBookingsForOrder).toHaveBeenCalledTimes(1);
    expect(confirmBookingsForOrder).toHaveBeenCalledWith(expect.anything(), expect.anything(), { orderId: order.id });
    const [active] = await h.db.select().from(vouchers).where(eq(vouchers.id, v!.id));
    expect(active).toMatchObject({ status: "active", codeLast4: expect.stringMatching(/^[0-9A-Z]{4}$/) });
    expect(active!.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(active!.activatedAt?.toISOString()).toBe(NOW.toISOString());
    expect(active!.expiresAt?.toISOString()).toBe(new Date(NOW.getTime() + 730 * 86_400_000).toISOString());
    expect(r.delivered.map((d) => d.result).sort()).toEqual(["booking_confirmed", "booking_confirmed", "voucher_activated"]);
  });

  it("settles a payment that expired locally, moves the order expired -> paid and re-confirms the redemption (rule 28)", async () => {
    const item = await makeProduct(h.db, { kind: "item", priceCents: 4000 });
    const [promo] = await h.db
      .insert(promotions)
      .values({ code: "LATE10", name: { en: "Late", "nl-BE": "Laat", "fr-BE": "Tard" }, kind: "fixed", value: 400, startsAt: new Date("2026-01-01"), maxUses: 1, usesCount: 0, createdByUserId: staffUserId })
      .returning();
    const { order } = await openOrder(3600, { status: "expired", subtotalCents: 4000, discountCents: 400, totalCents: 3600, promotionId: promo!.id });
    await makeOrderLine(h.db, { orderId: order.id, productId: item.id, unitAmountCents: 4000, discountCents: 400, promotionId: promo!.id });
    await h.db.insert(promotionRedemptions).values({ promotionId: promo!.id, orderId: order.id, personId: order.personId, status: "released" });
    const [p] = await h.db
      .insert(payments)
      .values({
        orderId: order.id,
        provider: "mollie",
        providerPaymentId: `tr_late${randomUUID().slice(0, 6)}`,
        status: "expired",
        amountCents: 3600,
        statusHistory: [{ status: "expired", at: NOW.toISOString(), source: "local_timeout" }],
      })
      .returning();
    const r = await inTx((tx, ctx) => applyProviderStatus(tx, ctx, p!, { status: "paid", method: "bancontact" }));
    expect(r).toEqual({ changed: true, becamePaid: true });
    expect((await h.db.select().from(orders).where(eq(orders.id, order.id)))[0]!.status).toBe("paid");
    expect((await h.db.select().from(promotionRedemptions).where(eq(promotionRedemptions.orderId, order.id)))[0]!.status).toBe("confirmed");
    expect((await h.db.select().from(promotions).where(eq(promotions.id, promo!.id)))[0]!.usesCount).toBe(1);
    const [after] = await h.db.select().from(payments).where(eq(payments.id, p!.id));
    expect(after!.statusHistory.map((s) => `${s.status}:${s.source}`)).toEqual(["expired:local_timeout", "paid:provider"]);
    // A provider-reported expiry is final: a later paid is ignored.
    const [p2] = await h.db.insert(payments).values({ orderId: order.id, provider: "mollie", providerPaymentId: `tr_fin${randomUUID().slice(0, 6)}`, status: "expired", amountCents: 3600, statusHistory: [{ status: "expired", at: NOW.toISOString(), source: "provider" }] }).returning();
    expect(await inTx((tx, ctx) => applyProviderStatus(tx, ctx, p2!, { status: "paid" }))).toEqual({ changed: false, becamePaid: false });
  });

  it("hands seats lost after a late payment to commerce.refund_unavailable_lines once (edge case 4)", async () => {
    const sessionProduct = await makeProduct(h.db, { kind: "session", priceCents: 4500 });
    const { order } = await openOrder(4500);
    const line = await makeOrderLine(h.db, { orderId: order.id, productId: sessionProduct.id, unitAmountCents: 4500, data: { booking_ids: [randomUUID()] } });
    confirmBookingsForOrder.mockResolvedValue({ confirmedBookingIds: [], unavailableOrderLineIds: [line.id] });
    const payment = await paidProviderPayment(order.id, 4500);
    const r = await inTx((tx, ctx) => applyProviderStatus(tx, ctx, payment, { status: "paid" }));
    expect(r.becamePaid).toBe(true);
    await inTx((tx, ctx) => finalizePaidOrder(tx, ctx, order.id));
    const queued = await h.db.select().from(jobs).where(eq(jobs.idempotencyKey, `refund_unavailable:${order.id}`));
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ kind: "commerce.refund_unavailable_lines", payload: { orderId: order.id, orderLineIds: [line.id] } });
  });

  it("rolls the whole paid transaction back when grantCredits fails", async () => {
    const pkg = await makeProduct(h.db, { kind: "package", priceCents: 20_000 });
    const { person, order } = await openOrder(40_000);
    await makeOrderLine(h.db, { orderId: order.id, productId: pkg.id, quantity: 2, unitAmountCents: 20_000 });
    const payment = await paidProviderPayment(order.id, 40_000);
    credits.grantCredits.mockResolvedValueOnce({ grantId: randomUUID(), created: true }).mockRejectedValueOnce(new Error("ledger down"));
    await expect(inTx((tx, ctx) => applyProviderStatus(tx, ctx, payment, { status: "paid" }))).rejects.toThrow("ledger down");
    expect((await h.db.select().from(orders).where(eq(orders.id, order.id)))[0]).toMatchObject({ status: "pending_payment", paidAt: null });
    const [p] = await h.db.select().from(payments).where(eq(payments.id, payment.id));
    expect(p).toMatchObject({ status: "open", statusHistory: [] });
    expect(await h.db.select().from(activityEvents).where(eq(activityEvents.personId, person.id))).toHaveLength(0);
    expect(await h.db.select().from(jobs).where(eq(jobs.idempotencyKey, `receipt:${order.id}`))).toHaveLength(0);
  });

  it("records payment.failed and queues commerce.payment_failed once for a failed payment (rule 33)", async () => {
    const { person, order } = await openOrder(4500);
    const payment = await paidProviderPayment(order.id, 4500);
    await inTx((tx, ctx) => applyProviderStatus(tx, ctx, payment, { status: "failed" }));
    const [again] = await h.db.select().from(payments).where(eq(payments.id, payment.id));
    expect(await inTx((tx, ctx) => applyProviderStatus(tx, ctx, again!, { status: "failed" }))).toEqual({ changed: false, becamePaid: false });
    const events = await h.db.select().from(activityEvents).where(and(eq(activityEvents.kind, "payment.failed"), eq(activityEvents.personId, person.id)));
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toEqual({ order_id: order.id, reason: "failed" });
    const emails = await h.db.select().from(jobs).where(and(eq(jobs.kind, "email.send")));
    expect(emails.filter((j) => (j.payload as { template?: string }).template === "commerce.payment_failed").length).toBeGreaterThanOrEqual(1);
    expect(credits.applyRenewalFailure).not.toHaveBeenCalled();
  });
});
