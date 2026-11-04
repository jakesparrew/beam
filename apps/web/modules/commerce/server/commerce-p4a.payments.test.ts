/**
 * commerce-P4a `startPayment` (rules 22, 23, 29; edge cases 1 and 8): the inline `payments.create`
 * runs inside the caller's transaction; a live provider payment is reused; a provider outage
 * leaves the order `pending_payment` with a `failed` payment; a paid order goes to the return page.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makePerson, makeProduct } from "@beam/db/testing";
import { makeOrder, makeOrderLine } from "@beam/db/testing/commerce-factories";
import type { DbHandle, Tx } from "@beam/db";
import { jobs, orders, payments } from "@beam/db/schema";

vi.mock("next/headers", () => ({ cookies: () => Promise.resolve({ get: () => undefined }), headers: () => Promise.resolve(new Headers()) }));
vi.mock("next/server", () => ({ after: () => undefined }));
vi.mock("@/modules/finance/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  issueInvoice: () => Promise.resolve({ status: "issued", invoiceId: randomUUID(), number: "2026-000001" }),
}));

const { startPayment } = await import("./payments");
const { createCtx, eq } = await import("@/lib/ctx");
const { makeCtx, resetRuntime, createFakeIntegrations } = await import("@/lib/testing");

let h: DbHandle;
let fake: ReturnType<typeof createFakeIntegrations>;

beforeAll(async () => {
  h = await createTestDb();
});
beforeEach(() => {
  fake = createFakeIntegrations();
  makeCtx(h.db, { integrations: fake });
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

function inTx<T>(fn: (tx: Tx, ctx: ReturnType<typeof createCtx>) => Promise<T>): Promise<T> {
  return h.db.transaction((tx) => fn(tx, createCtx({ tx, actor: { kind: "public" }, durableMode: "immediate" })));
}

async function pendingOrder(amountCents = 4500, extra: Parameters<typeof makeOrder>[1] = {}) {
  const person = await makePerson(h.db);
  const product = await makeProduct(h.db, { kind: "item", priceCents: amountCents });
  const order = await makeOrder(h.db, {
    personId: person.id,
    channel: "portal",
    subtotalCents: amountCents,
    totalCents: amountCents,
    expiresAt: new Date(Date.now() + 5 * 60_000),
    ...extra,
  });
  await makeOrderLine(h.db, { orderId: order.id, productId: product.id, unitAmountCents: amountCents });
  return order;
}

describe("startPayment", () => {
  it("creates the provider payment inline in the caller's transaction and extends the expiry", async () => {
    const order = await pendingOrder();
    const r = await inTx((tx, ctx) => startPayment(tx, ctx, { orderId: order.id }));
    const [p] = await h.db.select().from(payments).where(eq(payments.orderId, order.id));
    expect(p).toMatchObject({ id: r.paymentId, provider: "mollie", status: "open", amountCents: 4500, sequenceType: "oneoff" });
    expect(r.redirectUrl).toBe(p!.checkoutUrl);
    expect(r.redirectUrl).toContain(`/api/dev/fake-pay/${p!.providerPaymentId}`);
    const created = fake.payments.payment(p!.providerPaymentId!)!;
    expect(created.redirectUrl).toMatch(new RegExp(`/nl/account/checkout/return/${order.id}$`));
    expect(created.webhookUrl).toMatch(/\/api\/webhooks\/mollie/);
    const [job] = await h.db.select().from(jobs).where(eq(jobs.idempotencyKey, `payment_create:${p!.id}`));
    expect(job).toMatchObject({ kind: "payments.create", status: "succeeded" });
    const [after] = await h.db.select().from(orders).where(eq(orders.id, order.id));
    expect(after!.expiresAt!.getTime() - Date.now()).toBeGreaterThan(25 * 60_000);

    // A second start (double click) reuses the live payment (rule 23, edge case 1).
    const again = await inTx((tx, ctx) => startPayment(tx, ctx, { orderId: order.id, returnPath: "/account/membership" }));
    expect(again).toEqual(r);
    expect(fake.payments.calls.filter((c) => c.operation === "payments.create")).toHaveLength(1);
  });

  it("keeps the order pending with a failed payment when the provider is down (edge case 8)", async () => {
    const order = await pendingOrder();
    fake.payments.failNext("payments.create", { status: 503 });
    const r = await inTx((tx, ctx) => startPayment(tx, ctx, { orderId: order.id }));
    expect(new URL(r.redirectUrl).searchParams.get("payment")).toBe("unavailable");
    const [p] = await h.db.select().from(payments).where(eq(payments.orderId, order.id));
    expect(p).toMatchObject({ status: "failed", failedReason: "payment_unavailable", providerPaymentId: null });
    expect((await h.db.select().from(orders).where(eq(orders.id, order.id)))[0]!.status).toBe("pending_payment");

    // The retry is a new payment row (rule 23).
    const retry = await inTx((tx, ctx) => startPayment(tx, ctx, { orderId: order.id }));
    expect(retry.paymentId).not.toBe(p!.id);
    expect(retry.redirectUrl).toContain("/api/dev/fake-pay/");
  });

  it("fails the payment on a provider 4xx and keeps admin expiries and paid orders untouched", async () => {
    const until = new Date(Date.now() + 3 * 3600_000);
    const order = await pendingOrder(4500, { channel: "admin", expiresAt: until });
    fake.payments.failNext("payments.create", { status: 422 });
    const r = await inTx((tx, ctx) => startPayment(tx, ctx, { orderId: order.id }));
    expect(new URL(r.redirectUrl).searchParams.get("payment")).toBe("failed");
    expect(new URL(r.redirectUrl).pathname).toBe(`/admin/orders/${order.id}`);
    expect((await h.db.select().from(payments).where(eq(payments.orderId, order.id)))[0]).toMatchObject({ status: "failed", failedReason: "provider_rejected" });
    expect((await h.db.select().from(orders).where(eq(orders.id, order.id)))[0]!.expiresAt!.getTime()).toBe(until.getTime());

    const paid = await pendingOrder(4500, { status: "paid", paidAt: new Date() });
    expect(await inTx((tx, ctx) => startPayment(tx, ctx, { orderId: paid.id }))).toMatchObject({ paymentId: null });
    const expired = await pendingOrder(4500, { status: "expired" });
    await expect(inTx((tx, ctx) => startPayment(tx, ctx, { orderId: expired.id }))).rejects.toMatchObject({ code: "conflict" });
  });
});
