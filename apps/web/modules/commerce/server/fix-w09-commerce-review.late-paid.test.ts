/**
 * fix-w09-commerce-review, findings 4 and 5 (edge case 4, rule 28): a provider `paid` that
 * arrives after the order expired locally.
 *
 * - Finding 4: the order paid partly with euro credit (released by the expiry). With enough
 *   balance the credit is consumed again and the order is finalised; with too little, the
 *   provider payment is refunded in full with reason `order_expired`.
 * - Finding 5: the vouchers the expiry voided (`order_expired`) are activated by the late paid and
 *   are the ones the voucher emails go to.
 *
 * Credits run for real (grants, consume, release); finance's invoice is mocked.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makePerson, makeProduct } from "@beam/db/testing";
import { makeOrder, makeOrderLine } from "@beam/db/testing/commerce-factories";
import { makeCreditGrant } from "@beam/db/testing/credits-factories";
import type { DbHandle, Tx } from "@beam/db";
import { activityEvents, jobs, orders, payments, vouchers } from "@beam/db/schema";

vi.mock("next/headers", () => ({ cookies: () => Promise.resolve({ get: () => undefined }), headers: () => Promise.resolve(new Headers()) }));
vi.mock("next/server", () => ({ after: () => undefined }));

const issueInvoice = vi.fn<(...a: unknown[]) => unknown>();
vi.mock("@/modules/finance/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  issueInvoice: (...a: unknown[]) => issueInvoice(...a),
}));

const { expireOrder } = await import("./expiry");
const { finalizePaidOrder } = await import("./paid");
const { consumeCredits, getEuroBalance } = await import("@/modules/credits/api");
const { createCtx, eq, and } = await import("@/lib/ctx");
const { makeCtx, resetRuntime, runJobTwice, createFakeIntegrations } = await import("@/lib/testing");

let h: DbHandle;
let fake: ReturnType<typeof createFakeIntegrations>;

beforeAll(async () => {
  process.env.VOUCHER_CODE_SECRET ??= "test-voucher-secret-0123456789abcdef";
  h = await createTestDb();
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(() => {
  fake = createFakeIntegrations();
  makeCtx(h.db, { integrations: fake });
  issueInvoice.mockReset().mockResolvedValue({ status: "issued", invoiceId: randomUUID(), number: "2026-000001" });
});

const MIN = 60_000;

function inTx<T>(fn: (tx: Tx, ctx: ReturnType<typeof createCtx>) => Promise<T>): Promise<T> {
  return h.db.transaction((tx) => fn(tx, createCtx({ tx, actor: { kind: "system", jobId: "" }, durableMode: "immediate", now: new Date() })));
}

/**
 * A 50 EUR voucher order: 20 EUR paid with euro credit, 30 EUR card payment that timed out
 * locally (the provider still holds it), the order past its expiry, then expired by the scan.
 */
async function expiredVoucherOrder(euroGrantCents: number, creditCents = 2000) {
  const person = await makePerson(h.db);
  if (euroGrantCents > 0) await makeCreditGrant(h.db, { personId: person.id, creditKind: "euro", units: euroGrantCents, expiresAt: null });
  const product = await makeProduct(h.db, { kind: "voucher", priceCents: 5000, validityDays: 730 });
  const order = await makeOrder(h.db, { personId: person.id, channel: "portal", status: "pending_payment", totalCents: 5000, subtotalCents: 5000, expiresAt: new Date(Date.now() - MIN) });
  const line = await makeOrderLine(h.db, { orderId: order.id, productId: product.id, productKind: "voucher", unitAmountCents: 5000, lineTotalCents: 5000 });
  const [voucher] = await h.db.insert(vouchers).values({ orderLineId: line.id, amountCents: 5000, purchaserPersonId: person.id, status: "pending" }).returning();
  if (creditCents > 0) {
    await inTx((tx, ctx) => consumeCredits(tx, ctx, { personId: person.id, beneficiaryPersonId: person.id, kind: "euro", units: creditCents, ref: { type: "order", id: order.id } }));
    await h.db.insert(payments).values({
      orderId: order.id,
      provider: "credit_balance",
      method: "credit_balance",
      status: "paid",
      amountCents: creditCents,
      paidAt: new Date(),
      statusHistory: [{ status: "paid", at: new Date().toISOString(), source: "provider" }],
    });
  }
  const cardCents = 5000 - creditCents;
  const created = await fake.payments.createPayment({
    amountCents: cardCents,
    description: order.reference,
    redirectUrl: "http://localhost:3000/return",
    webhookUrl: "http://localhost:3000/api/webhooks/mollie",
    locale: "en",
    sequenceType: "oneoff",
    metadata: { orderId: order.id, paymentId: randomUUID() },
    idempotencyKey: `late-paid-test:${order.id}`,
  });
  const at = new Date(Date.now() - 40 * MIN).toISOString();
  const [card] = await h.db
    .insert(payments)
    .values({
      orderId: order.id,
      provider: "mollie",
      providerPaymentId: created.providerPaymentId,
      status: "expired",
      amountCents: cardCents,
      statusHistory: [
        { status: "open", at, source: "provider" },
        { status: "expired", at, source: "local_timeout" },
      ],
    })
    .returning();
  expect(await inTx((tx, ctx) => expireOrder(tx, ctx, order.id))).toBe(true);
  return { person, order, line, voucher: voucher!, card: card! };
}

const orderStatus = async (id: string) => (await h.db.select().from(orders).where(eq(orders.id, id)))[0]!.status;

describe("late provider paid on an expired order that used euro credit (review fix 4)", () => {
  it("consumes the released credit again and finalises the order when the balance covers it", async () => {
    const { person, order, voucher, card } = await expiredVoucherOrder(2000);
    expect(await orderStatus(order.id)).toBe("expired");
    expect((await getEuroBalance(h.db, person.id)).remainingCents).toBe(2000); // released by the expiry

    fake.payments.settle(card.providerPaymentId!, "paid");
    await runJobTwice(h.db, "payments.sync", { providerPaymentId: card.providerPaymentId! }, { integrations: fake });

    expect(await orderStatus(order.id)).toBe("paid");
    const rows = await h.db.select().from(payments).where(eq(payments.orderId, order.id));
    const credit = rows.filter((p) => p.provider === "credit_balance");
    expect(credit.map((p) => [p.status, p.amountCents]).sort()).toEqual([
      ["cancelled", 2000],
      ["paid", 2000],
    ]);
    expect(rows.find((p) => p.id === card.id)).toMatchObject({ status: "paid", refundedCents: 0 });
    expect((await getEuroBalance(h.db, person.id)).remainingCents).toBe(0);
    expect(fake.payments.payment(card.providerPaymentId!)!.refunds).toHaveLength(0);
    // Finding 5 on the same order: the voided voucher is active and gets its email.
    const [v] = await h.db.select().from(vouchers).where(eq(vouchers.id, voucher.id));
    expect(v).toMatchObject({ status: "active", voidedReason: null });
    expect(v!.codeHash).toBeTruthy();
    expect(await h.db.select().from(jobs).where(eq(jobs.idempotencyKey, `voucher_email:${voucher.id}:0`))).toHaveLength(1);
  });

  it("refunds the provider payment in full with order_expired when the balance no longer covers it", async () => {
    const { person, order, voucher, card } = await expiredVoucherOrder(2000);
    // The released credit was spent elsewhere before the late paid arrived.
    await inTx((tx, ctx) => consumeCredits(tx, ctx, { personId: person.id, beneficiaryPersonId: person.id, kind: "euro", units: 1500, ref: { type: "order", id: randomUUID() } }));

    fake.payments.settle(card.providerPaymentId!, "paid");
    await runJobTwice(h.db, "payments.sync", { providerPaymentId: card.providerPaymentId! }, { integrations: fake });

    expect(await orderStatus(order.id)).toBe("expired");
    const [after] = await h.db.select().from(payments).where(eq(payments.id, card.id));
    expect(after).toMatchObject({ status: "refunded", refundedCents: 3000 });
    expect(fake.payments.payment(card.providerPaymentId!)!.refunds).toHaveLength(1);
    expect(await h.db.select().from(payments).where(and(eq(payments.orderId, order.id), eq(payments.provider, "credit_balance"), eq(payments.status, "paid")))).toHaveLength(0);
    expect((await getEuroBalance(h.db, person.id)).remainingCents).toBe(500);
    const refunded = await h.db.select().from(activityEvents).where(and(eq(activityEvents.kind, "order.refunded"), eq(activityEvents.personId, person.id)));
    expect(refunded).toHaveLength(1);
    expect(refunded[0]!.data).toMatchObject({ order_id: order.id, amount_cents: 3000, reason: "order_expired" });
    expect((await h.db.select().from(vouchers).where(eq(vouchers.id, voucher.id)))[0]!.status).toBe("void");
    expect(issueInvoice).not.toHaveBeenCalled();
  });
});

describe("late paid after expiry activates the vouchers the expiry voided (review fix 5)", () => {
  it("finalising an expired voucher order activates the void voucher and lists it in voucherIds", async () => {
    const { order, line, voucher } = await expiredVoucherOrder(0, 0);
    const [voided] = await h.db.select().from(vouchers).where(eq(vouchers.id, voucher.id));
    expect(voided).toMatchObject({ status: "void", voidedReason: "order_expired" });

    const result = await inTx((tx, ctx) => finalizePaidOrder(tx, ctx, order.id));
    expect(result.delivered).toContainEqual(expect.objectContaining({ orderLineId: line.id, result: "voucher_activated", voucherIds: [voucher.id] }));
    const [v] = await h.db.select().from(vouchers).where(eq(vouchers.id, voucher.id));
    expect(v).toMatchObject({ status: "active", voidedReason: null });
    expect(v!.codeLast4).toHaveLength(4);
    expect(v!.codeHash).toBeTruthy();
    expect(v!.expiresAt).toBeTruthy();
    expect(await orderStatus(order.id)).toBe("paid");
  });

  it("does not revive a voucher voided for another reason, nor list it", async () => {
    const { order, line, voucher } = await expiredVoucherOrder(0, 0);
    await h.db.update(vouchers).set({ voidedReason: "refunded" }).where(eq(vouchers.id, voucher.id));
    const result = await inTx((tx, ctx) => finalizePaidOrder(tx, ctx, order.id));
    expect(result.delivered).toContainEqual(expect.objectContaining({ orderLineId: line.id, voucherIds: [] }));
    expect((await h.db.select().from(vouchers).where(eq(vouchers.id, voucher.id)))[0]!.status).toBe("void");
  });
});
