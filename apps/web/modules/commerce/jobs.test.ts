/**
 * commerce jobs run twice (conventions: every job passes the double-run test). commerce-P4a:
 * `payments.create`, `payments.sync`, `commerce.render_receipt` and
 * `commerce.refund_unavailable_lines`. commerce-P4b: `payments.scan_expired`,
 * `payments.charge_recurring`, `payments.cancel`, `commerce.revoke_mandate` and
 * `commerce.erase_provider_customer`. commerce-P6: `payments.refund`, `payments.create_link`,
 * `commerce.issue_voucher_email` and `commerce.expire_vouchers`. Later commerce packages add
 * their jobs to this file.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makePerson, makeProduct, makeUser } from "@beam/db/testing";
import { makeOrder, makeOrderLine } from "@beam/db/testing/commerce-factories";
import type { DbHandle } from "@beam/db";
import { activityEvents, emailMessages, files, mandates, orders, payments, refunds, vouchers } from "@beam/db/schema";
import { deriveVoucherCode, hashVoucherCode } from "@beam/core/commerce";
import { makeMembership } from "@beam/db/testing/credits-factories";

vi.mock("next/headers", () => ({ cookies: () => Promise.resolve({ get: () => undefined }), headers: () => Promise.resolve(new Headers()) }));
vi.mock("next/server", () => ({ after: () => undefined }));
const issueInvoice = vi.fn<(...a: unknown[]) => unknown>();
vi.mock("@/modules/finance/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  issueInvoice: (...a: unknown[]) => issueInvoice(...a),
}));
const applyRenewalFailure = vi.fn<(...a: unknown[]) => unknown>();
vi.mock("@/modules/credits/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  applyRenewalFailure: (...a: unknown[]) => applyRenewalFailure(...a),
}));
const refundOrderLine = vi.fn<(...a: unknown[]) => unknown>();
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
  applyRenewalFailure.mockReset().mockResolvedValue({ status: "past_due", dunningAttempt: 1, applied: true });
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

describe("commerce-P4b jobs run twice", () => {
  /** A renewal payment on a mandate the payments fake knows. */
  async function renewalPayment(status: "open" | "pending" = "open", withProviderPayment = false) {
    const person = await makePerson(h.db);
    const plan = await makeProduct(h.db, { kind: "membership", priceCents: 8900 });
    const membership = await makeMembership(h.db, { personId: person.id, productId: plan.id });
    const customerId = (await fake.payments.createCustomer({ name: "Test", email: "member@example.com", locale: "nl-BE" })).customerId;
    const { mandateId } = await fake.payments.createMandate({ customerId, method: "directdebit", consumerName: "Test", iban: "BE00000000000000" });
    const [mandate] = await h.db.insert(mandates).values({ personId: person.id, provider: "mollie", providerMandateId: mandateId, providerCustomerId: customerId, method: "directdebit", status: "valid" }).returning();
    const order = await makeOrder(h.db, { personId: person.id, channel: "recurring", subtotalCents: 8900, totalCents: 8900, renewalMembershipId: membership.id, renewalPeriodEndOn: "2026-12-04" });
    await makeOrderLine(h.db, { orderId: order.id, productId: plan.id, unitAmountCents: 8900 });
    let providerPaymentId: string | null = null;
    if (withProviderPayment) {
      providerPaymentId = (await fake.payments.createRecurringPayment({ customerId, mandateId, amountCents: 8900, description: order.reference, webhookUrl: "http://localhost/api/webhooks/mollie", metadata: {}, idempotencyKey: randomUUID() })).providerPaymentId;
      Object.assign(fake.payments.payment(providerPaymentId)!, { status, paidAt: null });
    }
    const [payment] = await h.db
      .insert(payments)
      .values({ orderId: order.id, provider: "mollie", sequenceType: "recurring", status, amountCents: 8900, mandateId: mandate!.id, providerPaymentId })
      .returning();
    return { order, payment: payment!, mandate: mandate!, customerId };
  }

  it("payments.scan_expired expires an order once", async () => {
    const created = new Date(Date.now() - 40 * 60_000);
    const person = await makePerson(h.db);
    const order = await makeOrder(h.db, { personId: person.id, expiresAt: new Date(created.getTime() + 30 * 60_000) });
    await makeOrderLine(h.db, { orderId: order.id });
    const [p] = await h.db.insert(payments).values({ orderId: order.id, provider: "mollie", providerPaymentId: `tr_scan${randomUUID().slice(0, 8)}`, status: "open", amountCents: 4500, createdAt: created }).returning();
    const { first, second } = await runJobTwice(h.db, "payments.scan_expired", {}, { integrations: fake });
    expect((first as { expiredOrderIds: string[] }).expiredOrderIds).toContain(order.id);
    expect((second as { expiredOrderIds: string[] }).expiredOrderIds).not.toContain(order.id);
    const [o] = await h.db.select().from(orders).where(eq(orders.id, order.id));
    expect(o!.status).toBe("expired");
    expect(o!.version).toBe(order.version + 1);
    const [after] = await h.db.select().from(payments).where(eq(payments.id, p!.id));
    expect(after!.statusHistory).toHaveLength(1);
  });

  it("payments.charge_recurring creates one provider payment", async () => {
    const { payment } = await renewalPayment();
    const { first, second } = await runJobTwice(h.db, "payments.charge_recurring", { paymentId: payment.id }, { integrations: fake });
    expect(second).toEqual(first);
    expect(fake.payments.calls.filter((c) => c.operation === "payments.create_recurring")).toHaveLength(1);
    expect((await h.db.select().from(payments).where(eq(payments.id, payment.id)))[0]!.providerPaymentId).toBe((first as { providerPaymentId: string }).providerPaymentId);
  });

  it("payments.cancel cancels at the provider once", async () => {
    const { payment } = await renewalPayment("pending", true);
    const { first, second } = await runJobTwice(h.db, "payments.cancel", { paymentId: payment.id }, { integrations: fake });
    expect(first).toEqual({ cancelled: true });
    expect(second).toEqual({ skipped: true, status: "cancelled" });
    expect(fake.payments.calls.filter((c) => c.operation === "payments.cancel")).toHaveLength(1);
    expect(applyRenewalFailure).not.toHaveBeenCalled();
  });

  it("commerce.revoke_mandate revokes at the provider and locally; the second run is a no-op", async () => {
    const { mandate } = await renewalPayment();
    const { first, second } = await runJobTwice(h.db, "commerce.revoke_mandate", { mandateId: mandate.id }, { integrations: fake });
    expect(first).toEqual({ revoked: true, atProvider: "revoked" });
    expect(second).toEqual(first);
    expect((await h.db.select().from(mandates).where(eq(mandates.id, mandate.id)))[0]!.status).toBe("revoked");
    expect((await fake.payments.getMandate({ customerId: mandate.providerCustomerId, mandateId: mandate.providerMandateId })).status).toBe("invalid");
  });

  it("commerce.erase_provider_customer revokes the mandates and deletes the customer; the second run changes nothing", async () => {
    const { mandate, customerId } = await renewalPayment();
    const payload = { providerCustomerId: customerId, mandateIds: [mandate.providerMandateId] };
    const { first, second } = await runJobTwice(h.db, "commerce.erase_provider_customer", payload, { integrations: fake });
    expect(first).toEqual({ mandatesRevoked: 1, customer: "deleted" });
    expect(second).toEqual(first);
    expect(fake.payments.calls.filter((c) => c.operation === "customers.delete")).toHaveLength(2);
    expect((await fake.payments.getMandate({ customerId, mandateId: mandate.providerMandateId })).status).toBe("invalid");
  });
});

describe("commerce-P6 jobs run twice", () => {
  beforeAll(() => {
    process.env.VOUCHER_CODE_SECRET ??= "test-jobs-secret";
  });

  it("payments.refund refunds at the provider once", async () => {
    const { order, line } = await openOrderWithPayment();
    const user = await makeUser(h.db);
    const created = await fake.payments.createPayment({
      amountCents: 4500,
      description: order.reference,
      redirectUrl: "http://localhost/return",
      webhookUrl: "http://localhost/api/webhooks/mollie",
      locale: "nl-BE",
      sequenceType: "oneoff",
      metadata: { orderId: order.id, paymentId: randomUUID() },
      idempotencyKey: randomUUID(),
    });
    fake.payments.settle(created.providerPaymentId, "paid");
    await h.db.update(orders).set({ status: "paid", paidAt: new Date() }).where(eq(orders.id, order.id));
    const [paid] = await h.db.insert(payments).values({ orderId: order.id, provider: "mollie", providerPaymentId: created.providerPaymentId, status: "paid", amountCents: 4500, paidAt: new Date() }).returning();
    const [refund] = await h.db
      .insert(refunds)
      .values({ paymentId: paid!.id, orderId: order.id, amountCents: 4500, reason: "test refund", lines: [{ order_line_id: line.id, quantity: 1, amount_cents: 4500 }], creditAction: "none", status: "pending", createdByUserId: user.id })
      .returning();
    const { first, second } = await runJobTwice(h.db, "payments.refund", { refundId: refund!.id }, { integrations: fake });
    expect(first).toMatchObject({ status: "refunded" });
    expect(second).toEqual({ skipped: true, status: "refunded" });
    expect(fake.payments.calls.filter((c) => c.operation === "refunds.create")).toHaveLength(1);
    expect(await h.db.select().from(emailMessages).where(eq(emailMessages.idempotencyKey, `refund:${refund!.id}:confirmation`))).toHaveLength(1);
  });

  it("payments.create_link sends one payment-link email", async () => {
    const person = await makePerson(h.db);
    const order = await makeOrder(h.db, { personId: person.id, channel: "link", expiresAt: new Date(Date.now() + 14 * 86_400_000) });
    await makeOrderLine(h.db, { orderId: order.id });
    const { first, second } = await runJobTwice(h.db, "payments.create_link", { orderId: order.id, email: "payer@example.com", version: order.version }, { integrations: fake });
    expect(second).toEqual(first);
    expect(await h.db.select().from(emailMessages).where(eq(emailMessages.idempotencyKey, `pay_link:${order.id}:${order.version}`))).toHaveLength(1);
  });

  it("commerce.issue_voucher_email sends one voucher email", async () => {
    const person = await makePerson(h.db);
    const product = await makeProduct(h.db, { kind: "voucher" });
    const order = await makeOrder(h.db, { personId: person.id, status: "paid" });
    const line = await makeOrderLine(h.db, { orderId: order.id, productId: product.id, unitAmountCents: 2500, vatRatePct: "0.00" });
    const id = randomUUID();
    const code = await deriveVoucherCode(process.env.VOUCHER_CODE_SECRET!, id);
    await h.db.insert(vouchers).values({ id, orderLineId: line.id, amountCents: 2500, purchaserPersonId: person.id, recipientEmail: "friend@example.com", status: "active", activatedAt: new Date(), expiresAt: new Date(Date.now() + 730 * 86_400_000), codeHash: await hashVoucherCode(code) });
    const { first, second } = await runJobTwice(h.db, "commerce.issue_voucher_email", { voucherId: id, n: 0 }, { integrations: fake });
    expect((second as { emailMessageId: string }).emailMessageId).toBe((first as { emailMessageId: string }).emailMessageId);
    expect(await h.db.select().from(emailMessages).where(eq(emailMessages.idempotencyKey, `voucher:${id}:email:0`))).toHaveLength(1);
    expect(await h.db.select().from(files).where(eq(files.name, `voucher-${id}.pdf`))).toHaveLength(1);
  });

  it("commerce.expire_vouchers expires a voucher once", async () => {
    const person = await makePerson(h.db);
    const product = await makeProduct(h.db, { kind: "voucher" });
    const order = await makeOrder(h.db, { personId: person.id, status: "paid" });
    const line = await makeOrderLine(h.db, { orderId: order.id, productId: product.id, unitAmountCents: 2500, vatRatePct: "0.00" });
    const [v] = await h.db.insert(vouchers).values({ orderLineId: line.id, amountCents: 2500, purchaserPersonId: person.id, status: "active", activatedAt: new Date(Date.now() - 800 * 86_400_000), expiresAt: new Date(Date.now() - 60_000) }).returning();
    const { first, second } = await runJobTwice(h.db, "commerce.expire_vouchers", {}, { integrations: fake });
    expect((first as { expired: number }).expired).toBeGreaterThanOrEqual(1);
    expect((second as { expired: number }).expired).toBe(0);
    expect((await h.db.select().from(vouchers).where(eq(vouchers.id, v!.id)))[0]!.status).toBe("expired");
    expect(await h.db.select().from(activityEvents).where(eq(activityEvents.dedupeKey, `voucher:${v!.id}:expired`))).toHaveLength(1);
  });
});
