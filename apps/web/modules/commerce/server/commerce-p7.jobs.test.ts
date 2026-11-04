/**
 * commerce-P7 jobs run twice (conventions: every job passes the double-run test):
 * `payments.terminal` sends one amount to the device and keeps its provider id;
 * `payments.cancel_terminal` cancels a staff-cancelled terminal payment on the device once, and
 * opens one finance task when the device already took the money.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makePerson, makeProduct, makeUser } from "@beam/db/testing";
import { makeOrder, makeOrderLine } from "@beam/db/testing/commerce-factories";
import type { DbHandle } from "@beam/db";
import { payments, tasks } from "@beam/db/schema";

vi.mock("next/headers", () => ({ cookies: () => Promise.resolve({ get: () => undefined }), headers: () => Promise.resolve(new Headers()) }));
vi.mock("next/server", () => ({ after: () => undefined }));

const { eq } = await import("@/lib/ctx");
const { makeCtx, resetRuntime, runJobTwice, createFakeIntegrations } = await import("@/lib/testing");

let h: DbHandle;
let fake: ReturnType<typeof createFakeIntegrations>;

beforeAll(async () => {
  h = await createTestDb();
  await makeUser(h.db, { roleKey: "finance" });
});
beforeEach(() => {
  fake = createFakeIntegrations();
  makeCtx(h.db, { integrations: fake });
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

async function terminalPayment(amountCents = 4500) {
  const person = await makePerson(h.db);
  const product = await makeProduct(h.db, { kind: "item", priceCents: amountCents, itemCategory: "merchandise" });
  const order = await makeOrder(h.db, { personId: person.id, channel: "pos", subtotalCents: amountCents, totalCents: amountCents });
  await makeOrderLine(h.db, { orderId: order.id, productId: product.id, unitAmountCents: amountCents });
  const [payment] = await h.db.insert(payments).values({ orderId: order.id, provider: "terminal", method: "pointofsale", status: "open", amountCents, terminalId: "term_xxx" }).returning();
  return { order, payment: payment! };
}

const row = async (id: string) => (await h.db.select().from(payments).where(eq(payments.id, id)))[0]!;

describe("commerce-P7 jobs run twice", () => {
  it("payments.terminal creates one terminal payment at the provider", async () => {
    const { payment } = await terminalPayment();
    const { first, second } = await runJobTwice(h.db, "payments.terminal", { paymentId: payment.id, terminalId: "term_xxx" }, { integrations: fake });
    expect(second).toEqual(first);
    expect((await row(payment.id)).providerPaymentId).toMatch(/^tr_/);
    expect(fake.payments.calls.filter((c) => c.operation === "payments.create_terminal")).toHaveLength(1);
  });

  it("payments.terminal fails the payment on a provider 4xx and skips it on the second run", async () => {
    const { payment } = await terminalPayment();
    fake.payments.failNext("payments.create_terminal", { status: 422 });
    const { first, second } = await runJobTwice(h.db, "payments.terminal", { paymentId: payment.id, terminalId: "term_xxx" }, { integrations: fake });
    expect(first).toEqual({ failed: true, reason: "provider_rejected" });
    expect(second).toEqual({ skipped: true, status: "failed" });
  });

  it("payments.cancel_terminal cancels the device payment once", async () => {
    const { payment } = await terminalPayment();
    await runJobTwice(h.db, "payments.terminal", { paymentId: payment.id, terminalId: "term_xxx" }, { integrations: fake });
    const providerPaymentId = (await row(payment.id)).providerPaymentId!;
    await h.db.update(payments).set({ status: "cancelled" }).where(eq(payments.id, payment.id));
    const { first, second } = await runJobTwice(h.db, "payments.cancel_terminal", { paymentId: payment.id }, { integrations: fake });
    expect(first).toEqual({ cancelled: true, paidAtProvider: false });
    // The second run finds it cancelled at the provider already: nothing paid, no task.
    expect(second).toEqual({ cancelled: false, paidAtProvider: false });
    expect(fake.payments.payment(providerPaymentId)?.status).toBe("cancelled");
  });

  it("payments.cancel_terminal opens one finance task when the device already took the money", async () => {
    const { payment } = await terminalPayment();
    await runJobTwice(h.db, "payments.terminal", { paymentId: payment.id, terminalId: "term_xxx" }, { integrations: fake });
    const providerPaymentId = (await row(payment.id)).providerPaymentId!;
    await h.db.update(payments).set({ status: "cancelled" }).where(eq(payments.id, payment.id));
    fake.payments.settle(providerPaymentId, "paid");
    const { first, second } = await runJobTwice(h.db, "payments.cancel_terminal", { paymentId: payment.id }, { integrations: fake });
    expect(first).toEqual({ cancelled: false, paidAtProvider: true });
    expect(second).toEqual(first);
    expect(await h.db.select().from(tasks).where(eq(tasks.dedupeKey, `terminal_paid_after_cancel:${payment.id}`))).toHaveLength(1);
    expect((await row(payment.id)).status).toBe("cancelled");
  });

  it("payments.cancel_terminal does nothing for a payment the device never received", async () => {
    const { payment } = await terminalPayment();
    const { first, second } = await runJobTwice(h.db, "payments.cancel_terminal", { paymentId: payment.id }, { integrations: fake });
    expect(first).toEqual({ cancelled: false, paidAtProvider: false });
    expect(second).toEqual(first);
  });
});
