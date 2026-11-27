/**
 * Owner decisions (November 2026) at the till, with finance's real invoices:
 * - Kaart (terminal): a card taken on a separate terminal is paid at once (reference kept), issues
 *   the paid invoice, has its own day close line and is never recorded twice;
 * - Op rekening: the order stays open on the client (no expiry, seats confirmed), shows in the
 *   follow-up feed and on the person, and each settle path (at the till, the open invoice, the
 *   payment link) closes it once, cancelling an open transfer it no longer waits for.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, makePerson, makeProduct, makeSession, makeUser } from "@beam/db/testing";
import type { DbHandle, Tx } from "@beam/db";
import { auditLog, bookings, invoices, orderLines, orders, payments, refunds } from "@beam/db/schema";
import type { WebhookHandlerDefinition } from "@/lib/webhooks";

vi.mock("next/headers", () => ({ cookies: () => Promise.resolve({ get: () => undefined }), headers: () => Promise.resolve(new Headers()) }));
vi.mock("next/server", () => ({ after: () => undefined }));

process.env.VOUCHER_CODE_SECRET = "voucher-secret-for-tests-0123456789";

const { posSell, posPayOrder } = await import("./pos");
const { issueOnAccountInvoice, getPersonOpenAccount } = await import("./on-account");
const { recordBankTransferPaid } = await import("./bank-transfer");
const { startPayment } = await import("./payments");
const { businessDayOf, computePosDayTotals } = await import("./pos-day");
const { getAttentionFeed } = await import("./attention");
const { scanExpired } = await import("./expiry");
const { issueRefund } = await import("./refunds");
const { createCtx, eq, and } = await import("@/lib/ctx");
const { makeCtx, makeJobCtx, resetRuntime, createFakeIntegrations, staffActor } = await import("@/lib/testing");
const { WEBHOOK_HANDLERS } = await import("@/registry/webhooks.generated");

let h: DbHandle;
let fake: ReturnType<typeof createFakeIntegrations>;
let staffUserId: string;
type Ctx = ReturnType<typeof createCtx>;
/** A pinned "now" just ahead (prices are valid from their creation); the day close reads its Brussels day. */
const NOW = new Date(Date.now() + 5 * 60_000);

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

const PERMS = ["commerce.sell", "commerce.refund", "invoices.issue"];
function asStaff<T>(fn: (tx: Tx, ctx: Ctx) => Promise<T>, now?: Date): Promise<T> {
  return h.db.transaction((tx) => fn(tx, createCtx({ tx, actor: staffActor({ userId: staffUserId, permissions: PERMS }), durableMode: "immediate", ...(now ? { now } : {}) })));
}

const orderRow = async (id: string) => (await h.db.select().from(orders).where(eq(orders.id, id)))[0]!;
const paymentsOf = (orderId: string) => h.db.select().from(payments).where(eq(payments.orderId, orderId));
const invoicesOf = (orderId: string) => h.db.select().from(invoices).where(and(eq(invoices.orderId, orderId), eq(invoices.kind, "invoice")));
const item = (priceCents = 4500) => makeProduct(h.db, { kind: "item", priceCents, itemCategory: "merchandise" });
const openFeed = async (orderId: string) => (await getAttentionFeed(h.db, { limit: 500 })).filter((r) => r.kind === "on_account" && r.orderId === orderId);

async function onAccountSale(priceCents = 4500) {
  const person = await makePerson(h.db);
  const merch = await item(priceCents);
  const out = await asStaff((tx, ctx) => posSell(tx, ctx, { personId: person.id, items: [{ productId: merch.id, quantity: 1 }], method: "on_account", clientKey: randomUUID() }));
  return { person, orderId: out.orderId, out };
}

const handle = (providerPaymentId: string) =>
  h.db.transaction(async (tx) => {
    const ctx = makeJobCtx(h.db, "webhook.process", { integrations: fake, tx });
    await (WEBHOOK_HANDLERS as unknown as Record<string, WebhookHandlerDefinition>).mollie!.handle(ctx, { id: randomUUID(), payload: { id: providerPaymentId } });
  });

describe("Kaart (terminal)", () => {
  it("marks the order paid with the reference, issues the paid invoice and counts in its own day close line", async () => {
    const merch = await item(3000);
    const clientKey = randomUUID();
    const day = businessDayOf(NOW);
    const before = await computePosDayTotals(h.db, day);
    const sell = () => asStaff((tx, ctx) => posSell(tx, ctx, { items: [{ productId: merch.id, quantity: 1 }], method: "card_terminal", terminalReference: "4821", clientKey }), NOW);
    const out = await sell();
    expect(out.status).toBe("paid");
    const [pay] = await paymentsOf(out.orderId);
    expect(pay).toMatchObject({ provider: "terminal", method: "external_card", status: "paid", amountCents: 3000, providerPaymentId: null, raw: { terminal_reference: "4821" } });
    expect(await invoicesOf(out.orderId)).toMatchObject([{ status: "paid", paymentId: pay!.id, paymentMethod: "terminal" }]);

    // A double submit records nothing more.
    expect(await sell()).toMatchObject({ orderId: out.orderId, status: "paid" });
    expect(await paymentsOf(out.orderId)).toHaveLength(1);

    const totals = await computePosDayTotals(h.db, day);
    expect(totals.card_terminal - before.card_terminal).toBe(3000);
    expect(totals.terminal).toBe(before.terminal);
    expect(totals.cash).toBe(before.cash);
  });

  it("never records a second payment on the same order and refunds by hand (sent until confirmed)", async () => {
    const { orderId } = await onAccountSale(2000);
    const pay = (clientKey: string) => asStaff((tx, ctx) => posPayOrder(tx, ctx, { orderId, method: "card_terminal", clientKey }));
    expect((await pay(randomUUID())).status).toBe("paid");
    expect((await pay(randomUUID())).status).toBe("paid");
    const rows = await paymentsOf(orderId);
    expect(rows).toHaveLength(1);

    const [line] = await h.db.select().from(orderLines).where(eq(orderLines.orderId, orderId));
    const r = await asStaff((tx, ctx) => issueRefund(tx, ctx, { orderId, lines: [{ orderLineId: line!.id, quantity: 1 }], reason: "customer request", kind: "refund" }));
    expect(await h.db.select().from(refunds).where(eq(refunds.id, r.refundIds[0]!))).toMatchObject([{ status: "sent", paymentId: rows[0]!.id }]);
  });
});

describe("Op rekening", () => {
  it("needs a client", async () => {
    const merch = await item();
    await expect(asStaff((tx, ctx) => posSell(tx, ctx, { items: [{ productId: merch.id, quantity: 1 }], method: "on_account", clientKey: randomUUID() }))).rejects.toMatchObject({
      fields: { personId: "person_required" },
    });
  });

  it("keeps the order open without expiry, confirms the walk-in seat, and shows it in follow-up and on the person", async () => {
    const person = await makePerson(h.db);
    const product = await makeProduct(h.db, { kind: "session", priceCents: 3500 });
    const session = await makeSession(h.db, { capacitySeats: 10, startsAt: new Date(Date.now() + 3 * 3_600_000), productId: product.id });
    const clientKey = randomUUID();
    const sell = () => asStaff((tx, ctx) => posSell(tx, ctx, { personId: person.id, items: [{ productId: product.id, quantity: 1, sessionId: session.id }], method: "on_account", clientKey }));
    const out = await sell();
    expect(out.status).toBe("pending_payment");
    expect(await sell()).toMatchObject({ orderId: out.orderId, status: "pending_payment" });
    const order = await orderRow(out.orderId);
    expect(order.onAccountAt).not.toBeNull();
    expect(order.expiresAt).toBeNull();
    expect(await paymentsOf(out.orderId)).toHaveLength(0);
    const [line] = await h.db.select().from(orderLines).where(eq(orderLines.orderId, out.orderId));
    expect((await h.db.select().from(bookings).where(eq(bookings.orderLineId, line!.id)))[0]?.status).toBe("confirmed");
    expect(await h.db.select().from(auditLog).where(and(eq(auditLog.entityId, out.orderId), eq(auditLog.action, "pos.on_account")))).toHaveLength(1);

    expect(await openFeed(out.orderId)).toMatchObject([{ amountCents: 3500, personId: person.id, paymentId: null }]);
    expect(await getPersonOpenAccount(h.db, person.id)).toMatchObject({ dueCents: 3500, orders: [{ orderId: out.orderId, dueCents: 3500 }] });

    // The expiry scan leaves it alone.
    await h.db.transaction((tx) => scanExpired(makeJobCtx(h.db, "payments.scan_expired", { integrations: fake, tx })));
    expect((await orderRow(out.orderId)).status).toBe("pending_payment");

    // Paid at the till later (cash): closed once, the seat stays confirmed.
    const payKey = randomUUID();
    const payCash = () => asStaff((tx, ctx) => posPayOrder(tx, ctx, { orderId: out.orderId, method: "cash", cashReceivedCents: 5000, clientKey: payKey }));
    expect(await payCash()).toMatchObject({ status: "paid", changeCents: 1500 });
    expect(await payCash()).toMatchObject({ status: "paid" });
    expect(await paymentsOf(out.orderId)).toMatchObject([{ provider: "cash", status: "paid", amountCents: 3500 }]);
    expect(await invoicesOf(out.orderId)).toMatchObject([{ status: "paid" }]);
    expect(await openFeed(out.orderId)).toHaveLength(0);
    expect((await getPersonOpenAccount(h.db, person.id)).dueCents).toBe(0);
  });

  it("is settled by the open invoice: structured communication, paid once by the transfer", async () => {
    const { person, orderId } = await onAccountSale(6000);
    const out = await asStaff((tx, ctx) => issueOnAccountInvoice(tx, ctx, { orderId }));
    const [inv] = await invoicesOf(orderId);
    expect(inv).toMatchObject({ id: out.invoiceId, status: "open", dueOn: out.dueOn });
    expect(inv!.paymentReference).toMatch(/^\+\+\+\d{3}\/\d{4}\/\d{5}\+\+\+$/);
    expect((await orderRow(orderId)).status).toBe("pending_payment");
    expect(await openFeed(orderId)).toHaveLength(1);

    const paid = () => asStaff((tx, ctx) => recordBankTransferPaid(tx, ctx, { orderId, paidOn: "2026-11-20", reference: inv!.number }));
    expect(await paid()).toEqual({ applied: true });
    expect(await paid()).toEqual({ applied: false });
    expect((await orderRow(orderId)).status).toBe("paid");
    expect(await paymentsOf(orderId)).toMatchObject([{ provider: "bank_transfer", status: "paid", amountCents: 6000 }]);
    expect(await invoicesOf(orderId)).toMatchObject([{ id: inv!.id, status: "paid" }]);
    expect((await getPersonOpenAccount(h.db, person.id)).orders).toHaveLength(0);
  });

  it("is settled by the payment link even after the invoice was issued; the open transfer is cancelled, the invoice paid once", async () => {
    const { orderId } = await onAccountSale(2500);
    await asStaff((tx, ctx) => issueOnAccountInvoice(tx, ctx, { orderId }));
    const started = await h.db.transaction((tx) => startPayment(tx, createCtx({ tx, actor: { kind: "public" }, durableMode: "immediate" }), { orderId }));
    expect((await orderRow(orderId)).expiresAt).toBeNull();
    const [link] = (await paymentsOf(orderId)).filter((p) => p.id === started.paymentId);
    fake.payments.settle(link!.providerPaymentId!, "paid");
    await handle(link!.providerPaymentId!);
    await handle(link!.providerPaymentId!);

    expect((await orderRow(orderId)).status).toBe("paid");
    const rows = await paymentsOf(orderId);
    expect(rows.filter((p) => p.status === "paid")).toMatchObject([{ id: link!.id, amountCents: 2500 }]);
    expect(rows.find((p) => p.provider === "bank_transfer")?.status).toBe("cancelled");
    expect(await invoicesOf(orderId)).toMatchObject([{ status: "paid", paymentId: link!.id }]);
    // A transfer reported afterwards changes nothing.
    expect(await asStaff((tx, ctx) => recordBankTransferPaid(tx, ctx, { orderId, paidOn: "2026-11-20", reference: "x" }))).toEqual({ applied: false });
    expect(await openFeed(orderId)).toHaveLength(0);
  });

  it("is paid at the till by card beside an open invoice", async () => {
    const { orderId } = await onAccountSale(1800);
    await asStaff((tx, ctx) => issueOnAccountInvoice(tx, ctx, { orderId }));
    expect(await asStaff((tx, ctx) => posPayOrder(tx, ctx, { orderId, method: "card_terminal", clientKey: randomUUID() }))).toMatchObject({ status: "paid" });
    const rows = await paymentsOf(orderId);
    expect(rows.filter((p) => p.status === "paid")).toMatchObject([{ provider: "terminal", method: "external_card", amountCents: 1800 }]);
    expect(rows.find((p) => p.provider === "bank_transfer")?.status).toBe("cancelled");
    expect(await invoicesOf(orderId)).toMatchObject([{ status: "paid" }]);
  });
});
