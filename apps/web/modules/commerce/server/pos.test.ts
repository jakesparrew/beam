/**
 * commerce-P7 front-desk POS (rules 21, 25, 26b, 42, 43, 55; edge cases 16, 31, 34): anonymous
 * sales only for items and vouchers; cash change; bank transfer opens the invoice and defers the
 * delivery and is refused for session lines; a walk-in session line is written without booking
 * ids and booked through booking's `createBookingForPosLine` in the `posSell` transaction
 * (`session_full` rolls the sale back as `sold_out`); the booking is confirmed by the paid
 * transaction and released at expiry when its terminal payment failed; the `?order=` deep link
 * and `posPayOrder` by cash; the company toggle stores the billing details before the payment;
 * terminal paid through the fake webhook; staff cancel a hanging terminal payment; voucher
 * redemption at the counter; cash refused on a closed day.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makePerson, makeProduct, makeSession, makeUser } from "@beam/db/testing";
import { makePaidOrder } from "@beam/db/testing/commerce-factories";
import type { DbHandle, Tx } from "@beam/db";
import { auditLog, bookings, creditGrants, jobs, orderLines, orders, payments, vouchers } from "@beam/db/schema";
import { deriveVoucherCode, hashVoucherCode, voucherCodeLast4 } from "@beam/core/commerce";
import type { WebhookHandlerDefinition } from "@/lib/webhooks";

vi.mock("next/headers", () => ({ cookies: () => Promise.resolve({ get: () => undefined }), headers: () => Promise.resolve(new Headers()) }));
vi.mock("next/server", () => ({ after: () => undefined }));

const issueInvoice = vi.fn<(...a: unknown[]) => unknown>();
const setOrderBillingDetails = vi.fn<(...a: unknown[]) => unknown>();
vi.mock("@/modules/finance/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  issueInvoice: (...a: unknown[]) => issueInvoice(...a),
  setOrderBillingDetails: (...a: unknown[]) => setOrderBillingDetails(...a),
}));

const SECRET = "voucher-secret-for-tests-0123456789";
process.env.VOUCHER_CODE_SECRET = SECRET;

const { posSell, posPayOrder, posCancelTerminal, runCancelTerminal, getPosOrder, getPosPaymentState } = await import("./pos");
const { closePosDay } = await import("./pos-day");
const { createOrder } = await import("./orders");
const { scanExpired } = await import("./expiry");
const { redeemVoucher } = await import("./vouchers");
const { createCtx, eq, and } = await import("@/lib/ctx");
const { makeCtx, makeJobCtx, resetRuntime, createFakeIntegrations, staffActor } = await import("@/lib/testing");
const { WEBHOOK_HANDLERS } = await import("@/registry/webhooks.generated");

let h: DbHandle;
let fake: ReturnType<typeof createFakeIntegrations>;
let staffUserId: string;
type Ctx = ReturnType<typeof createCtx>;

beforeAll(async () => {
  h = await createTestDb();
  fake = createFakeIntegrations();
  makeCtx(h.db, { integrations: fake });
  staffUserId = (await makeUser(h.db)).id;
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(() => {
  issueInvoice.mockReset().mockResolvedValue({ status: "issued", invoiceId: randomUUID(), number: "BEAM-2026-000001" });
  setOrderBillingDetails.mockReset().mockResolvedValue(undefined);
});

function asStaff<T>(fn: (tx: Tx, ctx: Ctx) => Promise<T>, opts: { now?: Date; permissions?: string[] } = {}): Promise<T> {
  return h.db.transaction((tx) =>
    fn(tx, createCtx({ tx, actor: staffActor({ userId: staffUserId, permissions: opts.permissions ?? ["commerce.sell"] }), durableMode: "immediate", ...(opts.now ? { now: opts.now } : {}) })),
  );
}

const orderRow = async (id: string) => (await h.db.select().from(orders).where(eq(orders.id, id)))[0]!;
const paymentsOf = (orderId: string) => h.db.select().from(payments).where(eq(payments.orderId, orderId));
const item = (priceCents = 4500) => makeProduct(h.db, { kind: "item", priceCents, itemCategory: "merchandise" });

async function walkInSession(capacitySeats = 10) {
  const person = await makePerson(h.db);
  const product = await makeProduct(h.db, { kind: "session", priceCents: 3500 });
  const session = await makeSession(h.db, { capacitySeats, startsAt: new Date(Date.now() + 3 * 3_600_000), productId: product.id });
  return { person, product, session };
}

const handle = (providerPaymentId: string) =>
  h.db.transaction(async (tx) => {
    const ctx = makeJobCtx(h.db, "webhook.process", { integrations: fake, tx });
    await (WEBHOOK_HANDLERS as unknown as Record<string, WebhookHandlerDefinition>).mollie!.handle(ctx, { id: randomUUID(), payload: { id: providerPaymentId } });
  });

describe("posSell: buyers and cash (rules 42, 43)", () => {
  it("allows anonymous sales only for items and vouchers", async () => {
    const pkg = await makeProduct(h.db, { kind: "package", priceCents: 20000 });
    await expect(asStaff((tx, ctx) => posSell(tx, ctx, { items: [{ productId: pkg.id, quantity: 1 }], method: "cash", cashReceivedCents: 20000, clientKey: randomUUID() }))).rejects.toMatchObject({
      fields: { personId: "person_required" },
    });
    const merch = await item(2500);
    const out = await asStaff((tx, ctx) => posSell(tx, ctx, { items: [{ productId: merch.id, quantity: 2 }], method: "cash", cashReceivedCents: 5000, clientKey: randomUUID() }));
    expect(out.status).toBe("paid");
    expect(await orderRow(out.orderId)).toMatchObject({ channel: "pos", personId: null, status: "paid", totalCents: 5000 });
  });

  it("pays cash at once, returns the change and audits pos.sale; a repeated submit returns the same order", async () => {
    const person = await makePerson(h.db);
    const merch = await item(4500);
    const clientKey = randomUUID();
    const sell = () => asStaff((tx, ctx) => posSell(tx, ctx, { personId: person.id, items: [{ productId: merch.id, quantity: 1 }], method: "cash", cashReceivedCents: 5000, clientKey }));
    const out = await sell();
    expect(out).toMatchObject({ status: "paid", changeCents: 500 });
    expect(await paymentsOf(out.orderId)).toMatchObject([{ provider: "cash", status: "paid", amountCents: 4500, cashReceivedCents: 5000 }]);
    expect(issueInvoice).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ orderId: out.orderId, status: "paid" }));
    const audits = await h.db.select().from(auditLog).where(and(eq(auditLog.entityId, out.orderId), eq(auditLog.action, "pos.sale")));
    expect(audits).toHaveLength(1);
    const receiptJobs = await h.db.select().from(jobs).where(eq(jobs.idempotencyKey, `receipt:${out.orderId}`));
    expect(receiptJobs).toHaveLength(1);

    const again = await sell();
    expect(again).toMatchObject({ orderId: out.orderId, status: "paid" });
    expect(await paymentsOf(out.orderId)).toHaveLength(1);
  });

  it("refuses cash below the amount due", async () => {
    const merch = await item(4500);
    await expect(asStaff((tx, ctx) => posSell(tx, ctx, { items: [{ productId: merch.id, quantity: 1 }], method: "cash", cashReceivedCents: 4000, clientKey: randomUUID() }))).rejects.toMatchObject({
      fields: { cashReceivedCents: "too_low" },
    });
  });
});

describe("posSell: bank transfer (rule 43)", () => {
  it("opens the transfer with its open invoice and delivers nothing yet", async () => {
    const person = await makePerson(h.db);
    const pkg = await makeProduct(h.db, { kind: "package", priceCents: 20000 });
    const out = await asStaff((tx, ctx) => posSell(tx, ctx, { personId: person.id, items: [{ productId: pkg.id, quantity: 1 }], method: "bank_transfer", clientKey: randomUUID() }));
    expect(out.status).toBe("pending_payment");
    expect(out.dueOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(await paymentsOf(out.orderId)).toMatchObject([{ provider: "bank_transfer", status: "open", amountCents: 20000 }]);
    expect(issueInvoice).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ orderId: out.orderId, status: "open", dueOn: out.dueOn }));
    expect(await h.db.select().from(creditGrants).where(eq(creditGrants.personId, person.id))).toHaveLength(0);
  });

  it("is refused for session lines before anything is written", async () => {
    const { person, product, session } = await walkInSession();
    const clientKey = randomUUID();
    await expect(
      asStaff((tx, ctx) => posSell(tx, ctx, { personId: person.id, items: [{ productId: product.id, quantity: 1, sessionId: session.id }], method: "bank_transfer", clientKey })),
    ).rejects.toMatchObject({ message: "bank_transfer_not_allowed" });
    expect(await h.db.select().from(orders).where(eq(orders.clientKey, clientKey))).toHaveLength(0);
  });

  it("stores the company billing details before the payment (rule 26b)", async () => {
    const person = await makePerson(h.db);
    const merch = await item(4500);
    const billingDetails = { isCompany: true, legalName: "Example BV", vatNumber: "BE0123456789", address: { line1: "Kerkstraat 1", postal_code: "2000", city: "Antwerpen", country: "BE" } };
    const out = await asStaff((tx, ctx) =>
      posSell(tx, ctx, { personId: person.id, items: [{ productId: merch.id, quantity: 1 }], method: "cash", cashReceivedCents: 4500, billingDetails, clientKey: randomUUID() }),
    );
    expect(setOrderBillingDetails).toHaveBeenCalledWith(expect.anything(), expect.anything(), { orderId: out.orderId, details: billingDetails });
    expect(setOrderBillingDetails.mock.invocationCallOrder[0]!).toBeLessThan(issueInvoice.mock.invocationCallOrder[0]!);
  });
});

describe("posSell: walk-in sessions (rule 21, edge case 34)", () => {
  it("writes the line without booking ids, books it in the same transaction and confirms it when paid", async () => {
    const { person, product, session } = await walkInSession();
    const out = await asStaff((tx, ctx) =>
      posSell(tx, ctx, { personId: person.id, items: [{ productId: product.id, quantity: 1, sessionId: session.id }], method: "cash", cashReceivedCents: 3500, clientKey: randomUUID() }),
    );
    expect(out.status).toBe("paid");
    const [line] = await h.db.select().from(orderLines).where(eq(orderLines.orderId, out.orderId));
    expect(line!.data.booking_ids).toBeUndefined();
    const rows = await h.db.select().from(bookings).where(eq(bookings.orderLineId, line!.id));
    expect(rows).toMatchObject([{ status: "confirmed", personId: person.id, sessionId: session.id }]);
  });

  it("rolls the whole sale back as sold_out when the session is full", async () => {
    const { person, product, session } = await walkInSession(1);
    const other = await makePerson(h.db);
    await h.db.insert(bookings).values({ sessionId: session.id, personId: other.id, status: "confirmed", paidWith: "free", source: "admin" });
    const clientKey = randomUUID();
    await expect(
      asStaff((tx, ctx) => posSell(tx, ctx, { personId: person.id, items: [{ productId: product.id, quantity: 1, sessionId: session.id }], method: "cash", cashReceivedCents: 3500, clientKey })),
    ).rejects.toMatchObject({ code: "conflict", message: "sold_out", fields: { items: "session_full" } });
    expect(await h.db.select().from(orders).where(eq(orders.clientKey, clientKey))).toHaveLength(0);
    expect(await h.db.select().from(bookings).where(and(eq(bookings.sessionId, session.id), eq(bookings.personId, person.id)))).toHaveLength(0);
  });

  it("needs a person for a session line", async () => {
    const { product, session } = await walkInSession();
    await expect(
      asStaff((tx, ctx) => posSell(tx, ctx, { items: [{ productId: product.id, quantity: 1, sessionId: session.id }], method: "cash", cashReceivedCents: 3500, clientKey: randomUUID() })),
    ).rejects.toMatchObject({ fields: { personId: "person_required" } });
  });
});

describe("terminal payments (rule 43, edge case 16)", () => {
  it("is paid through the fake webhook and confirms the walk-in booking", async () => {
    const { person, product, session } = await walkInSession();
    const out = await asStaff((tx, ctx) =>
      posSell(tx, ctx, { personId: person.id, items: [{ productId: product.id, quantity: 1, sessionId: session.id }], method: "terminal", terminalId: "term_xxx", clientKey: randomUUID() }),
    );
    expect(out.status).toBe("pending_payment");
    const [pay] = await paymentsOf(out.orderId);
    expect(pay).toMatchObject({ provider: "terminal", method: "pointofsale", status: "open", terminalId: "term_xxx" });
    expect(pay!.providerPaymentId).toMatch(/^tr_/);
    const [line] = await h.db.select().from(orderLines).where(eq(orderLines.orderId, out.orderId));
    expect((await h.db.select().from(bookings).where(eq(bookings.orderLineId, line!.id)))[0]?.status).toBe("reserved");

    fake.payments.settle(pay!.providerPaymentId!, "paid");
    await handle(pay!.providerPaymentId!);
    expect((await orderRow(out.orderId)).status).toBe("paid");
    expect((await h.db.select().from(bookings).where(eq(bookings.orderLineId, line!.id)))[0]?.status).toBe("confirmed");
    expect(await getPosPaymentState(h.db, pay!.id)).toMatchObject({ paymentStatus: "paid", orderStatus: "paid" });
  });

  it("releases the walk-in booking when the sale expires unpaid after a failed terminal payment", async () => {
    const { person, product, session } = await walkInSession();
    const out = await asStaff((tx, ctx) =>
      posSell(tx, ctx, { personId: person.id, items: [{ productId: product.id, quantity: 1, sessionId: session.id }], method: "terminal", terminalId: "term_xxx", clientKey: randomUUID() }),
    );
    const [pay] = await paymentsOf(out.orderId);
    fake.payments.settle(pay!.providerPaymentId!, "failed");
    await handle(pay!.providerPaymentId!);
    expect((await paymentsOf(out.orderId))[0]?.status).toBe("failed");
    await h.db.update(orders).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(orders.id, out.orderId));
    await h.db.transaction((tx) => scanExpired(makeJobCtx(h.db, "payments.scan_expired", { integrations: fake, tx })));
    expect((await orderRow(out.orderId)).status).toBe("expired");
    const [line] = await h.db.select().from(orderLines).where(eq(orderLines.orderId, out.orderId));
    expect(await h.db.select().from(bookings).where(eq(bookings.orderLineId, line!.id))).toMatchObject([{ status: "cancelled", cancelReasonCode: "payment_expired" }]);
  });

  it("refuses an unknown terminal", async () => {
    const merch = await item();
    await expect(asStaff((tx, ctx) => posSell(tx, ctx, { items: [{ productId: merch.id, quantity: 1 }], method: "terminal", terminalId: "term_nope", clientKey: randomUUID() }))).rejects.toMatchObject({
      fields: { terminalId: "unknown_terminal" },
    });
  });

  it("staff cancel a hanging terminal payment, which is cancelled on the device too, and pay another way", async () => {
    const merch = await item(4500);
    const person = await makePerson(h.db);
    const out = await asStaff((tx, ctx) => posSell(tx, ctx, { personId: person.id, items: [{ productId: merch.id, quantity: 1 }], method: "terminal", terminalId: "term_xxx", clientKey: randomUUID() }));
    const [pay] = await paymentsOf(out.orderId);
    await asStaff((tx, ctx) => posCancelTerminal(tx, ctx, { paymentId: pay!.id }));
    const [after] = await paymentsOf(out.orderId);
    expect(after!.status).toBe("cancelled");
    expect(after!.statusHistory.at(-1)).toMatchObject({ status: "cancelled", source: "staff" });
    expect(await h.db.select().from(auditLog).where(and(eq(auditLog.entityId, pay!.id), eq(auditLog.action, "pos.terminal_cancelled")))).toHaveLength(1);
    expect(await h.db.select().from(jobs).where(eq(jobs.idempotencyKey, `payment_terminal_cancel:${pay!.id}`))).toHaveLength(1);

    const job = await h.db.transaction((tx) => runCancelTerminal(makeJobCtx(h.db, "payments.cancel_terminal", { integrations: fake, tx }), { paymentId: pay!.id }));
    expect(job).toEqual({ cancelled: true, paidAtProvider: false });
    expect(fake.payments.payment(pay!.providerPaymentId!)?.status).toBe("cancelled");
    await expect(asStaff((tx, ctx) => posCancelTerminal(tx, ctx, { paymentId: pay!.id }))).rejects.toMatchObject({ message: "invalid_transition" });

    const paid = await asStaff((tx, ctx) => posPayOrder(tx, ctx, { orderId: out.orderId, method: "cash", cashReceivedCents: 5000, clientKey: randomUUID() }));
    expect(paid).toMatchObject({ status: "paid", changeCents: 500 });
  });
});

describe("posPayOrder and the ?order= deep link", () => {
  it("loads a pay-at-desk order and pays it by cash, confirming its booking", async () => {
    const { person, product, session } = await walkInSession();
    // booking's pay-at-desk order: a reserved row first, then createOrder with its booking id.
    const [booking] = await h.db
      .insert(bookings)
      .values({ sessionId: session.id, personId: person.id, status: "reserved", paidWith: "order", source: "admin", reservedUntil: session.endsAt })
      .returning();
    const created = await asStaff((tx, ctx) =>
      createOrder(tx, ctx, {
        personId: person.id,
        channel: "admin",
        items: [{ productId: product.id, quantity: 1, sessionId: session.id, bookingIds: [booking!.id] }],
        clientKey: randomUUID(),
        locale: "nl-BE",
        expiresAt: session.endsAt,
      }),
    );
    await h.db.update(bookings).set({ orderLineId: created.lineIds[0]! }).where(eq(bookings.id, booking!.id));

    const view = await getPosOrder(h.db, created.orderId);
    expect(view).toMatchObject({ status: "pending_payment", channel: "admin", personId: person.id, totalCents: 3500, dueCents: 3500, hasDatedLines: true, liveTerminalPaymentId: null });
    expect(view!.lines).toHaveLength(1);

    await expect(asStaff((tx, ctx) => posPayOrder(tx, ctx, { orderId: created.orderId, method: "bank_transfer", clientKey: randomUUID() }))).rejects.toMatchObject({
      message: "bank_transfer_not_allowed",
    });
    const clientKey = randomUUID();
    const paid = await asStaff((tx, ctx) => posPayOrder(tx, ctx, { orderId: created.orderId, method: "cash", cashReceivedCents: 4000, clientKey }));
    expect(paid).toMatchObject({ status: "paid", changeCents: 500 });
    expect((await orderRow(created.orderId)).channel).toBe("admin");
    expect((await h.db.select().from(bookings).where(eq(bookings.id, booking!.id)))[0]?.status).toBe("confirmed");
    expect(await h.db.select().from(auditLog).where(and(eq(auditLog.entityId, created.orderId), eq(auditLog.action, "pos.order_paid")))).toHaveLength(1);
    // A repeated submit answers with the paid state and takes nothing twice.
    expect(await asStaff((tx, ctx) => posPayOrder(tx, ctx, { orderId: created.orderId, method: "cash", cashReceivedCents: 4000, clientKey }))).toMatchObject({ status: "paid" });
    expect(await paymentsOf(created.orderId)).toHaveLength(1);
  });

  it("returns null for an unknown order", async () => {
    expect(await getPosOrder(h.db, randomUUID())).toBeNull();
  });
});

describe("vouchers at the counter (rule 45)", () => {
  it("redeems a voucher for the buyer and pays the sale with the euro credit", async () => {
    const buyer = await makePerson(h.db);
    const voucherProduct = await makeProduct(h.db, { kind: "voucher" });
    const { lines } = await makePaidOrder(h.db, { personId: buyer.id, lines: [{ productId: voucherProduct.id, productKind: "voucher", unitAmountCents: 5000, vatRatePct: "0.00" }] });
    const id = randomUUID();
    const code = await deriveVoucherCode(SECRET, id);
    await h.db.insert(vouchers).values({
      id,
      orderLineId: lines[0]!.id,
      amountCents: 5000,
      purchaserPersonId: buyer.id,
      status: "active",
      activatedAt: new Date(),
      expiresAt: new Date(Date.now() + 730 * 86_400_000),
      codeHash: await hashVoucherCode(code),
      codeLast4: voucherCodeLast4(code),
    });
    const redeemer = await makePerson(h.db);
    await asStaff((tx, ctx) => redeemVoucher(tx, ctx, { code, personId: redeemer.id }));

    const merch = await item(3000);
    const out = await asStaff((tx, ctx) =>
      posSell(tx, ctx, { personId: redeemer.id, items: [{ productId: merch.id, quantity: 1 }], method: "cash", cashReceivedCents: 0, useEuroCredit: true, clientKey: randomUUID() }),
    );
    expect(out.status).toBe("paid");
    expect(await paymentsOf(out.orderId)).toMatchObject([{ provider: "credit_balance", status: "paid", amountCents: 3000 }]);
  });
});

describe("closed days (rule 55, edge case 31)", () => {
  it("refuses cash on a closed business day but still takes the terminal", async () => {
    // A day after today, so the prices valid now apply and the close of today's other sales is untouched.
    const base = new Date(Date.now() + 2 * 86_400_000);
    const dayOn = base.toISOString().slice(0, 10);
    const day = new Date(`${dayOn}T10:00:00Z`);
    await asStaff((tx, ctx) => closePosDay(tx, ctx, { businessDayOn: dayOn, countedCashCents: 15_000 }), { now: new Date(`${dayOn}T19:00:00Z`) });
    const merch = await item(2000);
    await expect(
      asStaff((tx, ctx) => posSell(tx, ctx, { items: [{ productId: merch.id, quantity: 1 }], method: "cash", cashReceivedCents: 2000, clientKey: randomUUID() }), { now: day }),
    ).rejects.toMatchObject({ message: "day_closed" });
    const out = await asStaff((tx, ctx) => posSell(tx, ctx, { items: [{ productId: merch.id, quantity: 1 }], method: "terminal", terminalId: "term_xxx", clientKey: randomUUID() }), { now: day });
    expect(out.status).toBe("pending_payment");
  });
});
