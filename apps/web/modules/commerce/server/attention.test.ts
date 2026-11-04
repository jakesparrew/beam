/**
 * commerce-P6 attention feed (`v_payment_attention`, rules 33 to 35, edge cases 14 and 26): each
 * feed kind appears while its cause exists and disappears once it is gone.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import { makeOrder } from "@beam/db/testing/commerce-factories";
import type { DbHandle } from "@beam/db";
import { orders, payments, refunds } from "@beam/db/schema";

const { listPaymentAttention, getAttentionFeed, groupAttention } = await import("./attention");
const { eq } = await import("@/lib/ctx");

let h: DbHandle;
let userId: string;

beforeAll(async () => {
  h = await createTestDb();
  userId = (await makeUser(h.db)).id;
});
afterAll(async () => {
  await h.close();
});

const MIN = 60_000;
const ago = (ms: number) => new Date(Date.now() - ms);

async function kindsFor(orderId: string): Promise<string[]> {
  return (await listPaymentAttention(h.db, { limit: 500 })).filter((i) => i.orderId === orderId).map((i) => i.reason);
}

async function pendingOrder() {
  const person = await makePerson(h.db);
  return makeOrder(h.db, { personId: person.id, channel: "admin" });
}

describe("the payment attention feed", () => {
  it("payment_failed shows for 7 days unless the order is paid later", async () => {
    const order = await pendingOrder();
    await h.db.insert(payments).values({ orderId: order.id, provider: "mollie", status: "failed", amountCents: 4500, updatedAt: ago(MIN) });
    expect(await kindsFor(order.id)).toEqual(["payment_failed"]);
    await h.db.update(orders).set({ status: "paid", paidAt: new Date() }).where(eq(orders.id, order.id));
    expect(await kindsFor(order.id)).toEqual([]);
  });

  it("payment_pending_15m shows a provider payment open for more than 15 minutes", async () => {
    const order = await pendingOrder();
    const [p] = await h.db.insert(payments).values({ orderId: order.id, provider: "mollie", status: "open", amountCents: 4500, createdAt: ago(20 * MIN) }).returning();
    expect(await kindsFor(order.id)).toEqual(["payment_pending_15m"]);
    await h.db.update(payments).set({ status: "paid", paidAt: new Date() }).where(eq(payments.id, p!.id));
    expect(await kindsFor(order.id)).toEqual([]);
  });

  it("bank_transfer_overdue shows an open transfer past its due date until it is cancelled", async () => {
    const order = await pendingOrder();
    const [p] = await h.db.insert(payments).values({ orderId: order.id, provider: "bank_transfer", status: "open", amountCents: 4500, expiresAt: ago(MIN) }).returning();
    expect(await kindsFor(order.id)).toEqual(["bank_transfer_overdue"]);
    await h.db.update(payments).set({ status: "cancelled" }).where(eq(payments.id, p!.id));
    expect(await kindsFor(order.id)).toEqual([]);
  });

  it("refund_failed shows a failed refund until staff retry it", async () => {
    const person = await makePerson(h.db);
    const order = await makeOrder(h.db, { personId: person.id, status: "paid" });
    const [p] = await h.db.insert(payments).values({ orderId: order.id, provider: "mollie", status: "paid", amountCents: 4500, paidAt: new Date() }).returning();
    const [r] = await h.db
      .insert(refunds)
      .values({ paymentId: p!.id, orderId: order.id, amountCents: 4500, reason: "test", lines: [], creditAction: "none", status: "failed", createdByUserId: userId })
      .returning();
    expect(await kindsFor(order.id)).toEqual(["refund_failed"]);
    await h.db.update(refunds).set({ status: "pending" }).where(eq(refunds.id, r!.id));
    expect(await kindsFor(order.id)).toEqual([]);
  });

  it("chargeback shows for 30 days", async () => {
    const person = await makePerson(h.db);
    const order = await makeOrder(h.db, { personId: person.id, status: "paid" });
    const [p] = await h.db.insert(payments).values({ orderId: order.id, provider: "mollie", status: "paid", amountCents: 4500, chargebackCents: 4500, paidAt: new Date() }).returning();
    expect(await kindsFor(order.id)).toEqual(["chargeback"]);
    const feed = (await getAttentionFeed(h.db, { limit: 500 })).filter((r) => r.orderId === order.id);
    expect(feed[0]).toMatchObject({ kind: "chargeback", paymentId: p!.id, reference: order.reference, amountCents: 4500, personId: person.id });
    expect(groupAttention(feed).chargeback).toHaveLength(1);
    await h.db.update(payments).set({ updatedAt: ago(31 * 24 * 60 * MIN) }).where(eq(payments.id, p!.id));
    expect(await kindsFor(order.id)).toEqual([]);
  });
});
