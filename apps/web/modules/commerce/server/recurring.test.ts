/**
 * commerce-P4b renewal orders for credits (rule 22c, rule 41, edge cases 27 and 36):
 * `createRecurringCharge` twice for one period reuses the order and creates two payments (after a
 * failed attempt); `payments.charge_recurring` passes the job key as `Idempotency-Key`; a provider
 * failure calls `applyRenewalFailure`; `createRenewalLinkOrder` is idempotent per period;
 * `getPayLinkForOrder` returns the same URL until expiry; `cancelRenewalOrder` with an open
 * recurring payment enqueues `payments.cancel`; a late `paid` on a cancelled renewal order is
 * refunded and calls no credits function.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makePerson, makeProduct } from "@beam/db/testing";
import { ensureTermsVersion } from "@beam/db/testing/commerce-factories";
import { makeMembership } from "@beam/db/testing/credits-factories";
import type { DbHandle, Tx } from "@beam/db";
import { activityEvents, jobs, mandates, orderLines, orders, payments, priceVersions } from "@beam/db/schema";

vi.mock("next/headers", () => ({ cookies: () => Promise.resolve({ get: () => undefined }), headers: () => Promise.resolve(new Headers()) }));
vi.mock("next/server", () => ({ after: () => undefined }));

const credits = {
  applyRenewalFailure: vi.fn<(...a: unknown[]) => unknown>(),
  applyRenewalPayment: vi.fn<(...a: unknown[]) => unknown>(),
  activateMembership: vi.fn<(...a: unknown[]) => unknown>(),
  grantCredits: vi.fn<(...a: unknown[]) => unknown>(),
};
vi.mock("@/modules/credits/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  applyRenewalFailure: (...a: unknown[]) => credits.applyRenewalFailure(...a),
  applyRenewalPayment: (...a: unknown[]) => credits.applyRenewalPayment(...a),
  activateMembership: (...a: unknown[]) => credits.activateMembership(...a),
  grantCredits: (...a: unknown[]) => credits.grantCredits(...a),
}));
const issueInvoice = vi.fn<(...a: unknown[]) => unknown>();
vi.mock("@/modules/finance/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  issueInvoice: (...a: unknown[]) => issueInvoice(...a),
}));

let termsVersionId = "";
vi.mock("@/modules/site/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getCurrentLegalVersion: () => Promise.resolve({ versionId: termsVersionId }),
}));

const { createRecurringCharge, createRenewalLinkOrder, chargeRecurringPayment, getActiveMandate } = await import("./recurring");
const { getPayLinkForOrder, findOrderByPayToken } = await import("./payment-links");
const { cancelRenewalOrder } = await import("./cancel");
const { createCtx, eq, and } = await import("@/lib/ctx");
const { makeCtx, makeJobCtx, resetRuntime, runJobTwice, createFakeIntegrations } = await import("@/lib/testing");

let h: DbHandle;
let fake: ReturnType<typeof createFakeIntegrations>;

beforeAll(async () => {
  process.env.VOUCHER_CODE_SECRET ??= "test-voucher-secret-0123456789abcdef";
  h = await createTestDb();
  termsVersionId = (await ensureTermsVersion(h.db)).id;
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(() => {
  fake = createFakeIntegrations();
  makeCtx(h.db, { integrations: fake });
  for (const f of Object.values(credits)) f.mockReset();
  credits.applyRenewalFailure.mockResolvedValue({ status: "past_due", dunningAttempt: 1, applied: true });
  issueInvoice.mockReset().mockResolvedValue({ status: "issued", invoiceId: randomUUID(), number: "BEAM-2026-000001" });
});

const NOW = new Date("2026-11-04T10:00:00.000Z");
const DAY = 86_400_000;

function inTx<T>(fn: (tx: Tx, ctx: ReturnType<typeof createCtx>) => Promise<T>, now = NOW): Promise<T> {
  return h.db.transaction((tx) => fn(tx, createCtx({ tx, actor: { kind: "system", jobId: "" }, durableMode: "immediate", now })));
}

/** A member with a valid mandate (also known to the payments fake, so its recurring charges settle `paid`). */
async function member() {
  const person = await makePerson(h.db);
  // makeProduct's priceCents stamps the price version at the real clock (later than the fixed NOW after
  // 10:00 UTC); price versions are insert-only, so write it here valid from well before NOW.
  const plan = await makeProduct(h.db, { kind: "membership" });
  await h.db.insert(priceVersions).values({ productId: plan.id, version: 1, audience: "public", amountCents: 8900, validFromAt: new Date(NOW.getTime() - 365 * DAY) });
  const membership = await makeMembership(h.db, { personId: person.id, productId: plan.id });
  const customerId = `cst_${randomUUID().slice(0, 8)}`;
  const { mandateId: providerMandateId } = await fake.payments.createMandate({ customerId, method: "directdebit", consumerName: "Test", iban: "BE00000000000000" });
  const [mandate] = await h.db
    .insert(mandates)
    .values({ personId: person.id, provider: "mollie", providerMandateId, providerCustomerId: customerId, method: "directdebit", detailsSummary: "BE** 0000", status: "valid" })
    .returning();
  return { person, plan, membership, mandate: mandate! };
}

describe("createRecurringCharge", () => {
  it("creates the renewal order at the public price and reuses it on a dunning retry with a new payment", async () => {
    const { person, plan, membership, mandate } = await member();
    const input = { membershipId: membership.id, personId: person.id, productId: plan.id, mandateId: mandate.id, periodEndOn: "2026-12-04" };
    const first = await inTx((tx, ctx) => createRecurringCharge(tx, ctx, input));
    const [order] = await h.db.select().from(orders).where(eq(orders.id, first.orderId));
    expect(order).toMatchObject({
      channel: "recurring",
      status: "pending_payment",
      totalCents: 8900,
      discountCents: 0,
      promotionId: null,
      renewalMembershipId: membership.id,
      renewalPeriodEndOn: "2026-12-04",
    });
    expect(order!.expiresAt!.toISOString()).toBe("2026-12-13T23:00:00.000Z"); // period end (Brussels midnight) + 10 days
    const lines = await h.db.select().from(orderLines).where(eq(orderLines.orderId, first.orderId));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ productId: plan.id, productKind: "membership", quantity: 1, unitAmountCents: 8900, lineTotalCents: 8900, promotionId: null });
    const [p1] = await h.db.select().from(payments).where(eq(payments.id, first.paymentId));
    expect(p1).toMatchObject({ sequenceType: "recurring", status: "open", amountCents: 8900, mandateId: mandate.id });
    const queued = await h.db.select().from(jobs).where(eq(jobs.idempotencyKey, `charge_recurring:${first.paymentId}`));
    expect(queued).toHaveLength(1);
    expect(queued[0]!.kind).toBe("payments.charge_recurring");

    // While the payment is in flight a repeated call returns it (rule 23).
    expect(await inTx((tx, ctx) => createRecurringCharge(tx, ctx, input))).toEqual(first);

    // The attempt failed: the retry reuses the order with a second payment.
    await h.db.update(payments).set({ status: "failed" }).where(eq(payments.id, first.paymentId));
    const second = await inTx((tx, ctx) => createRecurringCharge(tx, ctx, input));
    expect(second.orderId).toBe(first.orderId);
    expect(second.paymentId).not.toBe(first.paymentId);
    expect(await h.db.select().from(payments).where(eq(payments.orderId, first.orderId))).toHaveLength(2);
    expect(await h.db.select().from(orders).where(eq(orders.renewalMembershipId, membership.id))).toHaveLength(1);
  });

  it("refuses a mandate that is not valid", async () => {
    const { person, plan, membership, mandate } = await member();
    await h.db.update(mandates).set({ status: "revoked" }).where(eq(mandates.id, mandate.id));
    await expect(
      inTx((tx, ctx) => createRecurringCharge(tx, ctx, { membershipId: membership.id, personId: person.id, productId: plan.id, mandateId: mandate.id, periodEndOn: "2026-12-04" })),
    ).rejects.toMatchObject({ code: "conflict", message: "mandate_invalid" });
    expect(await getActiveMandate(h.db, person.id)).toBeNull();
  });
});

describe("payments.charge_recurring", () => {
  it("creates the provider payment with the job key as Idempotency-Key", async () => {
    const { person, plan, membership, mandate } = await member();
    const r = await inTx((tx, ctx) => createRecurringCharge(tx, ctx, { membershipId: membership.id, personId: person.id, productId: plan.id, mandateId: mandate.id, periodEndOn: "2026-12-04" }));
    const spy = vi.spyOn(fake.payments, "createRecurringPayment");
    const key = `charge_recurring:${r.paymentId}`;
    const result = await h.db.transaction((tx) => chargeRecurringPayment(makeJobCtx(h.db, "payments.charge_recurring", { tx, integrations: fake, key }), { paymentId: r.paymentId }));
    expect((result as { providerPaymentId: string }).providerPaymentId).toMatch(/^tr_/);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toMatchObject({
      customerId: mandate.providerCustomerId,
      mandateId: mandate.providerMandateId,
      amountCents: 8900,
      idempotencyKey: key,
      metadata: { orderId: r.orderId, paymentId: r.paymentId },
    });
    const [row] = await h.db.select().from(payments).where(eq(payments.id, r.paymentId));
    expect(row!.providerPaymentId).toBe((result as { providerPaymentId: string }).providerPaymentId);
  });

  it("fails the payment on a provider 4xx and calls applyRenewalFailure", async () => {
    const { person, plan, membership, mandate } = await member();
    const r = await inTx((tx, ctx) => createRecurringCharge(tx, ctx, { membershipId: membership.id, personId: person.id, productId: plan.id, mandateId: mandate.id, periodEndOn: "2026-12-04" }));
    fake.payments.failNext("payments.create_recurring", { status: 422 });
    const { first } = await runJobTwice(h.db, "payments.charge_recurring", { paymentId: r.paymentId }, { integrations: fake });
    expect(first).toEqual({ failed: true, reason: "provider_rejected" });
    expect((await h.db.select().from(payments).where(eq(payments.id, r.paymentId)))[0]!.status).toBe("failed");
    expect(credits.applyRenewalFailure).toHaveBeenCalledTimes(1);
    expect(credits.applyRenewalFailure).toHaveBeenCalledWith(expect.anything(), expect.anything(), { membershipId: membership.id, paymentId: r.paymentId, reason: "provider_rejected" });
  });
});

describe("createRenewalLinkOrder and getPayLinkForOrder", () => {
  it("is idempotent per membership and period and returns the same pay link until it expires", async () => {
    const { person, plan, membership } = await member();
    const input = { membershipId: membership.id, personId: person.id, productId: plan.id, periodEndOn: "2026-12-04" };
    const a = await inTx((tx, ctx) => createRenewalLinkOrder(tx, ctx, input));
    const b = await inTx((tx, ctx) => createRenewalLinkOrder(tx, ctx, input), new Date(NOW.getTime() + DAY));
    expect(b).toEqual(a);
    const [order] = await h.db.select().from(orders).where(eq(orders.id, a.orderId));
    expect(order).toMatchObject({ channel: "link", status: "pending_payment", renewalPeriodEndOn: "2026-12-04" });
    expect(order!.termsVersionId).toBe(termsVersionId);
    expect(a.payUrl).toMatch(/\/nl\/pay\/[A-Za-z0-9_-]{43}$/);
    expect(order!.payTokenExpiresAt!.toISOString()).toBe(new Date(NOW.getTime() + 14 * DAY).toISOString());

    const same = await inTx((tx, ctx) => getPayLinkForOrder(tx, ctx, { orderId: a.orderId }), new Date(NOW.getTime() + 13 * DAY));
    expect(same.payUrl).toBe(a.payUrl);
    const token = a.payUrl.split("/").pop()!;
    expect(await findOrderByPayToken(h.db, token)).toEqual({ orderId: a.orderId, expiresAt: order!.payTokenExpiresAt });

    const later = new Date(NOW.getTime() + 15 * DAY);
    const renewed = await inTx((tx, ctx) => getPayLinkForOrder(tx, ctx, { orderId: a.orderId }), later);
    expect(renewed.payUrl).not.toBe(a.payUrl);
    expect(renewed.expiresAt.toISOString()).toBe(new Date(later.getTime() + 14 * DAY).toISOString());
    expect(await findOrderByPayToken(h.db, token)).toBeNull();
  });
});

describe("cancelRenewalOrder and a late paid", () => {
  it("enqueues payments.cancel for the open recurring payment and refunds a paid that still arrives", async () => {
    const { person, plan, membership, mandate } = await member();
    const r = await inTx((tx, ctx) => createRecurringCharge(tx, ctx, { membershipId: membership.id, personId: person.id, productId: plan.id, mandateId: mandate.id, periodEndOn: "2026-12-04" }));
    await runJobTwice(h.db, "payments.charge_recurring", { paymentId: r.paymentId }, { integrations: fake });
    const [charged] = await h.db.select().from(payments).where(eq(payments.id, r.paymentId));
    expect(charged!.status).toBe("open"); // the final status comes through the webhook

    await inTx((tx, ctx) => cancelRenewalOrder(tx, ctx, { orderId: r.orderId, reason: "membership_expired" }));
    expect((await h.db.select().from(orders).where(eq(orders.id, r.orderId)))[0]!.status).toBe("cancelled");
    const queued = await h.db.select().from(jobs).where(and(eq(jobs.kind, "payments.cancel"), eq(jobs.idempotencyKey, `payment_cancel:${r.paymentId}`)));
    expect(queued).toHaveLength(1);

    // The SEPA debit already went through at the provider: not cancelable.
    const cancel = await runJobTwice(h.db, "payments.cancel", { paymentId: r.paymentId }, { integrations: fake });
    expect(cancel.first).toEqual({ notCancelable: true });

    // The webhook's sync records the paid payment; the cancelled order is refunded in full.
    await runJobTwice(h.db, "payments.sync", { providerPaymentId: charged!.providerPaymentId! }, { integrations: fake });
    const [after] = await h.db.select().from(payments).where(eq(payments.id, r.paymentId));
    expect(after).toMatchObject({ status: "refunded", refundedCents: 8900 });
    expect(fake.payments.payment(charged!.providerPaymentId!)!.refunds).toHaveLength(1);
    expect((await h.db.select().from(orders).where(eq(orders.id, r.orderId)))[0]!.status).toBe("cancelled");
    expect(credits.applyRenewalPayment).not.toHaveBeenCalled();
    expect(credits.activateMembership).not.toHaveBeenCalled();
    expect(credits.grantCredits).not.toHaveBeenCalled();
    expect(issueInvoice).not.toHaveBeenCalled();
    const refunded = await h.db.select().from(activityEvents).where(and(eq(activityEvents.kind, "order.refunded"), eq(activityEvents.personId, person.id)));
    expect(refunded).toHaveLength(1);
    expect(refunded[0]!.data).toMatchObject({ order_id: r.orderId, amount_cents: 8900, reason: "order_cancelled" });
  });

  it("cancels the recurring payment at the provider when it is still cancelable", async () => {
    const { person, plan, membership, mandate } = await member();
    const r = await inTx((tx, ctx) => createRecurringCharge(tx, ctx, { membershipId: membership.id, personId: person.id, productId: plan.id, mandateId: mandate.id, periodEndOn: "2026-12-04" }));
    await runJobTwice(h.db, "payments.charge_recurring", { paymentId: r.paymentId }, { integrations: fake });
    const [charged] = await h.db.select().from(payments).where(eq(payments.id, r.paymentId));
    // Make the provider payment still pending (SEPA in progress).
    Object.assign(fake.payments.payment(charged!.providerPaymentId!)!, { status: "pending", paidAt: null });
    await inTx((tx, ctx) => cancelRenewalOrder(tx, ctx, { orderId: r.orderId, reason: "membership_cancelled" }));
    const cancel = await runJobTwice(h.db, "payments.cancel", { paymentId: r.paymentId }, { integrations: fake });
    expect(cancel.first).toEqual({ cancelled: true });
    expect(cancel.second).toEqual({ skipped: true, status: "cancelled" });
    expect((await h.db.select().from(payments).where(eq(payments.id, r.paymentId)))[0]!.status).toBe("cancelled");
    expect(credits.applyRenewalFailure).not.toHaveBeenCalled();
  });
});
