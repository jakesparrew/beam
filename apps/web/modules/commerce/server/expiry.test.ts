/**
 * commerce-P4b `payments.scan_expired` (rules 22, 22a, 34; edge cases 3, 9, 11): a payment open
 * for 35 minutes times out (`local_timeout`) after a `payments.sync` was queued, and its order
 * expires 30 minutes after the payment with `releaseBookingsForOrder` (`payment_expired`), the
 * euro credit, the promotion redemption and the pending vouchers released; a draft untouched for
 * 30 days is cancelled; a payment pending 16 minutes raises `notifySlack` with fingerprint
 * `commerce:payment_pending_15m`, one pending 14 minutes does not.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makePerson, makeProduct, makeUser } from "@beam/db/testing";
import { makeOrder, makeOrderLine } from "@beam/db/testing/commerce-factories";
import type { DbHandle, Tx } from "@beam/db";
import { activityEvents, jobs, orders, payments, promotionRedemptions, promotions, vouchers } from "@beam/db/schema";

vi.mock("next/headers", () => ({ cookies: () => Promise.resolve({ get: () => undefined }), headers: () => Promise.resolve(new Headers()) }));
vi.mock("next/server", () => ({ after: () => undefined }));

const releaseBookingsForOrder = vi.fn<(...a: unknown[]) => unknown>();
vi.mock("@/modules/booking/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  releaseBookingsForOrder: (...a: unknown[]) => releaseBookingsForOrder(...a),
}));
const releaseCredits = vi.fn<(...a: unknown[]) => unknown>();
const applyRenewalFailure = vi.fn<(...a: unknown[]) => unknown>();
vi.mock("@/modules/credits/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  releaseCredits: (...a: unknown[]) => releaseCredits(...a),
  applyRenewalFailure: (...a: unknown[]) => applyRenewalFailure(...a),
}));

const { scanExpired, PENDING_ALERT_FINGERPRINT } = await import("./expiry");
const { localHourKey } = await import("@beam/core/platform");
const { createCtx, eq, and, sql } = await import("@/lib/ctx");
const like = (col: unknown, pattern: string) => sql`${col} like ${pattern}`;
const { makeCtx, resetRuntime, createFakeIntegrations } = await import("@/lib/testing");

let h: DbHandle;
let staffUserId: string;

beforeAll(async () => {
  h = await createTestDb();
  makeCtx(h.db, { integrations: createFakeIntegrations() });
  staffUserId = (await makeUser(h.db)).id;
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(() => {
  releaseBookingsForOrder.mockReset().mockResolvedValue({ releasedBookingIds: [] });
  releaseCredits.mockReset().mockResolvedValue({ releasedUnits: 1500 });
  applyRenewalFailure.mockReset().mockResolvedValue({ status: "past_due", dunningAttempt: 1, applied: true });
});

const MIN = 60_000;
const DAY = 86_400_000;

function scanAt(now: Date) {
  return h.db.transaction((tx: Tx) => scanExpired(createCtx({ tx, actor: { kind: "system", jobId: "" }, durableMode: "immediate", now })));
}

const slackJobs = () => h.db.select().from(jobs).where(and(eq(jobs.kind, "notify.slack"), like(jobs.idempotencyKey, `slack:${PENDING_ALERT_FINGERPRINT}:%`)));

describe("the 15-minute pending alert (rule 34)", () => {
  const T0 = new Date("2026-11-01T09:00:00.000Z");
  let paymentId: string;

  it("does not alert for a payment pending 14 minutes", async () => {
    const order = await makeOrder(h.db, { expiresAt: new Date(T0.getTime() + 20 * MIN) });
    const [p] = await h.db
      .insert(payments)
      .values({ orderId: order.id, provider: "mollie", providerPaymentId: `tr_alert${randomUUID().slice(0, 8)}`, status: "pending", amountCents: 4500, createdAt: new Date(T0.getTime() - 14 * MIN) })
      .returning();
    paymentId = p!.id;
    const r = await scanAt(T0);
    expect(r.pendingAlert).toBeNull();
    expect(await slackJobs()).toHaveLength(0);
  });

  it("alerts with the fingerprint, counts and ids once the payment is pending 16 minutes", async () => {
    const r = await scanAt(new Date(T0.getTime() + 2 * MIN));
    expect(r.pendingAlert).toEqual({ count: 1, paymentIds: [paymentId] });
    const queued = await slackJobs();
    expect(queued).toHaveLength(1);
    expect(queued[0]!.payload).toMatchObject({ fingerprint: PENDING_ALERT_FINGERPRINT, severity: "high" });
    expect(String((queued[0]!.payload as { text: string }).text)).toContain(paymentId);
    // Bank transfers never count.
    const transferOrder = await makeOrder(h.db, { expiresAt: null });
    await h.db.insert(payments).values({ orderId: transferOrder.id, provider: "bank_transfer", status: "open", amountCents: 4500, createdAt: new Date(T0.getTime() - 60 * MIN) });
    const again = await scanAt(new Date(T0.getTime() + 3 * MIN));
    expect(again.pendingAlert?.count).toBe(1);
  });
});

describe("30-minute expiry (rule 22)", () => {
  it("times the payment out and expires the order with its releases", async () => {
    const now = new Date("2026-11-03T12:00:00.000Z");
    const person = await makePerson(h.db);
    const [promo] = await h.db
      .insert(promotions)
      .values({ code: `EXP${randomUUID().slice(0, 6).toUpperCase()}`, name: { en: "Five", "nl-BE": "Vijf", "fr-BE": "Cinq" }, kind: "fixed", value: 500, startsAt: new Date("2026-01-01"), usesCount: 3, createdByUserId: staffUserId })
      .returning();
    const createdAt = new Date(now.getTime() - 36 * MIN);
    const order = await makeOrder(h.db, {
      personId: person.id,
      channel: "portal",
      subtotalCents: 7500,
      discountCents: 500,
      totalCents: 7000,
      promotionId: promo!.id,
      expiresAt: new Date(createdAt.getTime() + 30 * MIN),
    });
    await makeOrderLine(h.db, { orderId: order.id, productKind: "session", unitAmountCents: 4500, data: { booking_ids: [randomUUID()] } });
    const voucherProduct = await makeProduct(h.db, { kind: "voucher" });
    const vLine = await makeOrderLine(h.db, { orderId: order.id, productId: voucherProduct.id, unitAmountCents: 3000, discountCents: 500, vatRatePct: "0.00" });
    const [voucher] = await h.db.insert(vouchers).values({ orderLineId: vLine.id, amountCents: 3000, status: "pending" }).returning();
    await h.db.insert(promotionRedemptions).values({ promotionId: promo!.id, orderId: order.id, personId: person.id, status: "reserved" });
    const [credit] = await h.db
      .insert(payments)
      .values({ orderId: order.id, provider: "credit_balance", method: "credit_balance", status: "paid", amountCents: 1500, paidAt: createdAt, createdAt })
      .returning();
    const providerPaymentId = `tr_exp${randomUUID().slice(0, 8)}`;
    const [card] = await h.db
      .insert(payments)
      .values({ orderId: order.id, provider: "mollie", providerPaymentId, status: "open", amountCents: 5500, createdAt })
      .returning();

    const r = await scanAt(now);
    expect(r.expiredOrderIds).toContain(order.id);
    expect(r.timedOut).toBeGreaterThanOrEqual(1);

    // A lost webhook is caught up: one sync per payment and minute.
    const syncs = await h.db.select().from(jobs).where(and(eq(jobs.kind, "payments.sync"), like(jobs.idempotencyKey, `payment_sync:${providerPaymentId}:%`)));
    expect(syncs).toHaveLength(1);
    expect(syncs[0]!.idempotencyKey).toBe(`payment_sync:${providerPaymentId}:2026-11-03T13:00`);

    const [cardAfter] = await h.db.select().from(payments).where(eq(payments.id, card!.id));
    expect(cardAfter!.status).toBe("expired");
    expect(cardAfter!.statusHistory.at(-1)).toMatchObject({ status: "expired", source: "local_timeout" });
    expect((await h.db.select().from(orders).where(eq(orders.id, order.id)))[0]!.status).toBe("expired");
    expect(releaseBookingsForOrder).toHaveBeenCalledWith(expect.anything(), expect.anything(), { orderId: order.id, reason: "payment_expired" });
    expect(releaseCredits).toHaveBeenCalledWith(expect.anything(), expect.anything(), { ref: { type: "order", id: order.id }, reason: "order_expired" });
    expect((await h.db.select().from(payments).where(eq(payments.id, credit!.id)))[0]!.status).toBe("cancelled");
    expect((await h.db.select().from(promotionRedemptions).where(eq(promotionRedemptions.orderId, order.id)))[0]!.status).toBe("released");
    expect((await h.db.select().from(promotions).where(eq(promotions.id, promo!.id)))[0]!.usesCount).toBe(2);
    expect((await h.db.select().from(vouchers).where(eq(vouchers.id, voucher!.id)))[0]).toMatchObject({ status: "void", voidedReason: "order_expired" });
    const events = await h.db.select().from(activityEvents).where(and(eq(activityEvents.kind, "order.expired"), eq(activityEvents.personId, person.id)));
    expect(events).toHaveLength(1);

    // A second scan changes nothing for this order.
    releaseCredits.mockClear();
    const second = await scanAt(new Date(now.getTime() + MIN));
    expect(second.expiredOrderIds).not.toContain(order.id);
    expect(releaseCredits).not.toHaveBeenCalled();
  });

  it("keeps an order whose payment is still young, and never times out a recurring payment", async () => {
    const now = new Date("2026-11-03T15:00:00.000Z");
    const young = await makeOrder(h.db, { expiresAt: new Date(now.getTime() + 10 * MIN) });
    await h.db.insert(payments).values({ orderId: young.id, provider: "mollie", providerPaymentId: `tr_young${randomUUID().slice(0, 8)}`, status: "open", amountCents: 4500, createdAt: new Date(now.getTime() - 20 * MIN) });
    const renewal = await makeOrder(h.db, { channel: "recurring", expiresAt: new Date(now.getTime() + 10 * DAY) });
    const [rec] = await h.db
      .insert(payments)
      .values({ orderId: renewal.id, provider: "mollie", sequenceType: "recurring", providerPaymentId: `tr_sepa${randomUUID().slice(0, 8)}`, status: "pending", amountCents: 4500, createdAt: new Date(now.getTime() - 2 * DAY) })
      .returning();
    const r = await scanAt(now);
    expect(r.expiredOrderIds).not.toContain(young.id);
    expect((await h.db.select().from(orders).where(eq(orders.id, young.id)))[0]!.status).toBe("pending_payment");
    expect((await h.db.select().from(payments).where(eq(payments.id, rec!.id)))[0]!.status).toBe("pending");
    expect(applyRenewalFailure).not.toHaveBeenCalled();
  });
});

describe("draft expiry (rule 22a)", () => {
  it("cancels a draft untouched for 30 days and keeps a younger one", async () => {
    const now = new Date("2026-11-04T08:00:00.000Z");
    const stale = await makeOrder(h.db, { status: "draft", expiresAt: null, updatedAt: new Date(now.getTime() - 31 * DAY) });
    const fresh = await makeOrder(h.db, { status: "draft", expiresAt: null, updatedAt: new Date(now.getTime() - 29 * DAY) });
    const r = await scanAt(now);
    expect(r.cancelledDraftIds).toContain(stale.id);
    expect(r.cancelledDraftIds).not.toContain(fresh.id);
    const [s] = await h.db.select().from(orders).where(eq(orders.id, stale.id));
    expect(s).toMatchObject({ status: "cancelled" });
    expect((await h.db.select().from(orders).where(eq(orders.id, fresh.id)))[0]!.status).toBe("draft");
  });
});

describe("sync batch with a backlog of pending SEPA debits (review fix 6)", () => {
  it("syncs a 31-minute card payment despite 201 older recurring debits, and debits only once per hour", async () => {
    const now = new Date("2026-11-05T14:00:00.000Z");
    const run = randomUUID().slice(0, 8);
    const renewal = await makeOrder(h.db, { channel: "recurring", expiresAt: new Date(now.getTime() + 10 * DAY) });
    const debits = Array.from({ length: 201 }, (_, i) => ({
      orderId: renewal.id,
      provider: "mollie" as const,
      sequenceType: "recurring" as const,
      providerPaymentId: `tr_sepa${run}_${i}`,
      status: "pending" as const,
      amountCents: 4500,
      createdAt: new Date(now.getTime() - 3 * DAY + i * MIN),
    }));
    await h.db.insert(payments).values(debits);
    const card = await makeOrder(h.db, { expiresAt: new Date(now.getTime() + 10 * MIN) });
    const cardPaymentId = `tr_card${run}`;
    await h.db.insert(payments).values({ orderId: card.id, provider: "mollie", providerPaymentId: cardPaymentId, status: "pending", amountCents: 4500, createdAt: new Date(now.getTime() - 31 * MIN) });

    await scanAt(now);
    const cardSyncs = await h.db.select().from(jobs).where(and(eq(jobs.kind, "payments.sync"), like(jobs.idempotencyKey, `payment_sync:${cardPaymentId}:%`)));
    expect(cardSyncs).toHaveLength(1);
    const debitSyncs = () => h.db.select().from(jobs).where(and(eq(jobs.kind, "payments.sync"), like(jobs.idempotencyKey, `payment_sync:tr_sepa${run}_%`)));
    const first = await debitSyncs();
    expect(first.length).toBeGreaterThan(0);
    expect(first.length).toBeLessThan(201);
    const hour = localHourKey(now);
    for (const j of first) expect(j.idempotencyKey).toMatch(new RegExp(`^payment_sync:tr_sepa${run}_\\d+:${hour}$`));
    // A minute later in the same hour: a new card sync, no new sync for the debits already queued.
    const queued = new Set(first.map((j) => j.idempotencyKey));
    await scanAt(new Date(now.getTime() + MIN));
    expect(await h.db.select().from(jobs).where(and(eq(jobs.kind, "payments.sync"), like(jobs.idempotencyKey, `payment_sync:${cardPaymentId}:%`)))).toHaveLength(2);
    const after = await debitSyncs();
    expect(after.filter((j) => !queued.has(j.idempotencyKey))).toHaveLength(0);
    await h.db.update(payments).set({ status: "failed" }).where(eq(payments.orderId, renewal.id));
  });
});
