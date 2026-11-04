/**
 * commerce jobs run twice (conventions: every job passes the double-run test). commerce-P4a:
 * `payments.create`, `payments.sync`, `commerce.render_receipt` and
 * `commerce.refund_unavailable_lines`. Later commerce packages add their jobs to this file.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makePerson, makeProduct } from "@beam/db/testing";
import { makeOrder, makeOrderLine } from "@beam/db/testing/commerce-factories";
import type { DbHandle } from "@beam/db";
import { emailMessages, files, orders, payments } from "@beam/db/schema";

vi.mock("next/headers", () => ({ cookies: () => Promise.resolve({ get: () => undefined }), headers: () => Promise.resolve(new Headers()) }));
vi.mock("next/server", () => ({ after: () => undefined }));
const issueInvoice = vi.fn();
vi.mock("@/modules/finance/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  issueInvoice: (...a: unknown[]) => issueInvoice(...a),
}));
const refundOrderLine = vi.fn();
vi.mock("@/modules/commerce/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  refundOrderLine: (...a: unknown[]) => refundOrderLine(...a),
}));

const { eq } = await import("@/lib/ctx");
const { makeCtx, resetRuntime, runJobTwice, createFakeIntegrations } = await import("@/lib/testing");

let h: DbHandle;
let fake: ReturnType<typeof createFakeIntegrations>;

beforeAll(async () => {
  h = await createTestDb();
});
beforeEach(() => {
  fake = createFakeIntegrations();
  makeCtx(h.db, { integrations: fake });
  issueInvoice.mockReset().mockResolvedValue({ status: "issued", invoiceId: randomUUID(), number: "2026-000001" });
  refundOrderLine.mockReset().mockResolvedValue({ refundId: randomUUID(), amountCents: 4500 });
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

async function openOrderWithPayment(amountCents = 4500) {
  const person = await makePerson(h.db);
  const product = await makeProduct(h.db, { kind: "item", priceCents: amountCents });
  const order = await makeOrder(h.db, { personId: person.id, channel: "portal", subtotalCents: amountCents, totalCents: amountCents });
  const line = await makeOrderLine(h.db, { orderId: order.id, productId: product.id, unitAmountCents: amountCents });
  const [payment] = await h.db.insert(payments).values({ orderId: order.id, provider: "mollie", status: "open", amountCents }).returning();
  return { person, order, line, payment: payment! };
}

describe("commerce jobs run twice", () => {
  it("payments.create creates one provider payment", async () => {
    const { payment } = await openOrderWithPayment();
    const { first, second } = await runJobTwice(h.db, "payments.create", { paymentId: payment.id }, { integrations: fake });
    expect(second).toEqual(first);
    const [row] = await h.db.select().from(payments).where(eq(payments.id, payment.id));
    expect(row!.providerPaymentId).toMatch(/^tr_/);
    expect(row!.checkoutUrl).toContain(`/api/dev/fake-pay/${row!.providerPaymentId}`);
    expect(fake.payments.calls.filter((c) => c.operation === "payments.create")).toHaveLength(1);
  });

  it("payments.create fails the payment on a provider 4xx and stays failed on the second run", async () => {
    const { payment } = await openOrderWithPayment();
    fake.payments.failNext("payments.create", { status: 422 });
    const { first, second } = await runJobTwice(h.db, "payments.create", { paymentId: payment.id }, { integrations: fake });
    expect(first).toEqual({ failed: true, reason: "provider_rejected" });
    expect(second).toEqual({ skipped: true, status: "failed" });
    expect((await h.db.select().from(payments).where(eq(payments.id, payment.id)))[0]!.status).toBe("failed");
  });

  it("payments.sync applies a paid payment once", async () => {
    const { order, payment } = await openOrderWithPayment();
    await runJobTwice(h.db, "payments.create", { paymentId: payment.id }, { integrations: fake });
    const [row] = await h.db.select().from(payments).where(eq(payments.id, payment.id));
    fake.payments.settle(row!.providerPaymentId!, "paid");
    const { first, second } = await runJobTwice(h.db, "payments.sync", { providerPaymentId: row!.providerPaymentId! }, { integrations: fake });
    expect(first).toMatchObject({ ignored: false, status: "paid", changed: true, becamePaid: true });
    expect(second).toMatchObject({ ignored: false, status: "paid", changed: false, becamePaid: false });
    expect((await h.db.select().from(orders).where(eq(orders.id, order.id)))[0]!.status).toBe("paid");
    expect(issueInvoice).toHaveBeenCalledTimes(1);
  });

  it("payments.sync ignores an unknown id", async () => {
    const { first, second } = await runJobTwice(h.db, "payments.sync", { providerPaymentId: "tr_doesnotexist" }, { integrations: fake });
    expect(first).toEqual({ ignored: true, reason: "unknown" });
    expect(second).toEqual(first);
  });

  it("commerce.render_receipt stores one PDF and queues one confirmation", async () => {
    const { order } = await openOrderWithPayment();
    await h.db.update(orders).set({ status: "paid", paidAt: new Date() }).where(eq(orders.id, order.id));
    const { first, second } = await runJobTwice(h.db, "commerce.render_receipt", { orderId: order.id }, { integrations: fake });
    expect(second).toEqual(first);
    const stored = await h.db.select().from(files).where(eq(files.name, `receipt-${order.reference}.pdf`));
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ kind: "receipt", mime: "application/pdf" });
    const mails = await h.db.select().from(emailMessages).where(eq(emailMessages.idempotencyKey, `order:${order.id}:receipt`));
    expect(mails).toHaveLength(1);
    expect(mails[0]!.attachments).toEqual([{ fileId: stored[0]!.id, filename: `BEAM-${order.reference}.pdf` }]);
  });

  it("commerce.refund_unavailable_lines refunds each line through the idempotent refundOrderLine", async () => {
    const { order, line } = await openOrderWithPayment();
    const { first, second } = await runJobTwice(h.db, "commerce.refund_unavailable_lines", { orderId: order.id, orderLineIds: [line.id] }, { integrations: fake });
    expect(second).toEqual(first);
    expect(refundOrderLine).toHaveBeenCalledWith(expect.anything(), expect.anything(), { orderLineId: line.id, reason: "seat_no_longer_available" });
  });
});
