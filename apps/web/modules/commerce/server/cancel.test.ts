/**
 * commerce-P4b cancellation (rule 22b, cross-module D31): draft and pending orders are cancelled
 * with their releases (`releaseBookingsForOrder` with `order_cancelled`, euro credit, promotion
 * redemptions, pending vouchers) and `{ cancelled: true }`; a live provider payment or a paid
 * order returns `{ cancelled: false }` without throwing; an open bank-transfer order issues one
 * credit note with `noRefund`, also when finance calls `cancelOrder` inside its own transaction
 * after its own full credit note.
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
vi.mock("@/modules/credits/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  releaseCredits: (...a: unknown[]) => releaseCredits(...a),
}));
const getInvoiceForOrder = vi.fn<(...a: unknown[]) => unknown>();
const issueCreditNote = vi.fn<(...a: unknown[]) => unknown>();
vi.mock("@/modules/finance/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getInvoiceForOrder: (...a: unknown[]) => getInvoiceForOrder(...a),
  issueCreditNote: (...a: unknown[]) => issueCreditNote(...a),
}));

const { cancelOrder, cancelRenewalOrder } = await import("./cancel");
const { createCtx, eq, and } = await import("@/lib/ctx");
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
  releaseCredits.mockReset().mockResolvedValue({ releasedUnits: 1000 });
  getInvoiceForOrder.mockReset().mockResolvedValue(null);
  issueCreditNote.mockReset().mockResolvedValue({ creditNoteId: randomUUID(), number: "CN-2026-000001", totalCents: -4500 });
});

const NOW = new Date("2026-11-04T10:00:00.000Z");

function inTx<T>(fn: (tx: Tx, ctx: ReturnType<typeof createCtx>) => Promise<T>): Promise<T> {
  return h.db.transaction((tx) => fn(tx, createCtx({ tx, actor: { kind: "system", jobId: "" }, durableMode: "immediate", now: NOW })));
}

const orderRow = async (id: string) => (await h.db.select().from(orders).where(eq(orders.id, id)))[0]!;

describe("cancelOrder", () => {
  it("cancels a pending order and releases bookings, euro credit, redemptions and pending vouchers", async () => {
    const person = await makePerson(h.db);
    const [promo] = await h.db
      .insert(promotions)
      .values({ code: `CXL${randomUUID().slice(0, 6).toUpperCase().replace(/[^A-Z0-9]/g, "A")}`, name: { en: "Ten", "nl-BE": "Tien", "fr-BE": "Dix" }, kind: "fixed", value: 500, startsAt: new Date("2026-01-01"), usesCount: 1, createdByUserId: staffUserId })
      .returning();
    const order = await makeOrder(h.db, { personId: person.id, channel: "portal", subtotalCents: 7500, discountCents: 500, totalCents: 7000, promotionId: promo!.id });
    await makeOrderLine(h.db, { orderId: order.id, productKind: "session", unitAmountCents: 4500, data: { booking_ids: [randomUUID()] } });
    const voucherProduct = await makeProduct(h.db, { kind: "voucher" });
    const vLine = await makeOrderLine(h.db, { orderId: order.id, productId: voucherProduct.id, unitAmountCents: 3000, discountCents: 500, vatRatePct: "0.00" });
    const [voucher] = await h.db.insert(vouchers).values({ orderLineId: vLine.id, amountCents: 3000, status: "pending" }).returning();
    await h.db.insert(promotionRedemptions).values({ promotionId: promo!.id, orderId: order.id, personId: person.id, status: "reserved" });
    const [credit] = await h.db
      .insert(payments)
      .values({ orderId: order.id, provider: "credit_balance", method: "credit_balance", status: "paid", amountCents: 1000, paidAt: NOW })
      .returning();

    const r = await inTx((tx, ctx) => cancelOrder(tx, ctx, { orderId: order.id, reason: "customer_request" }));
    expect(r).toEqual({ cancelled: true });

    const after = await orderRow(order.id);
    expect(after.status).toBe("cancelled");
    expect(after.cancelledAt?.toISOString()).toBe(NOW.toISOString());
    expect(after.version).toBe(order.version + 1);
    expect(releaseBookingsForOrder).toHaveBeenCalledWith(expect.anything(), expect.anything(), { orderId: order.id, reason: "order_cancelled" });
    expect(releaseCredits).toHaveBeenCalledWith(expect.anything(), expect.anything(), { ref: { type: "order", id: order.id }, reason: "order_expired" });
    expect((await h.db.select().from(payments).where(eq(payments.id, credit!.id)))[0]!.status).toBe("cancelled");
    expect((await h.db.select().from(promotionRedemptions).where(eq(promotionRedemptions.orderId, order.id)))[0]!.status).toBe("released");
    expect((await h.db.select().from(promotions).where(eq(promotions.id, promo!.id)))[0]!.usesCount).toBe(0);
    expect((await h.db.select().from(vouchers).where(eq(vouchers.id, voucher!.id)))[0]).toMatchObject({ status: "void", voidedReason: "order_cancelled" });
    const events = await h.db.select().from(activityEvents).where(and(eq(activityEvents.kind, "order.cancelled"), eq(activityEvents.personId, person.id)));
    expect(events).toHaveLength(1);
    expect(issueCreditNote).not.toHaveBeenCalled();

    // A second call finds a cancelled order: no throw, nothing released twice.
    releaseCredits.mockClear();
    expect(await inTx((tx, ctx) => cancelOrder(tx, ctx, { orderId: order.id, reason: "customer_request" }))).toEqual({ cancelled: false });
    expect(releaseCredits).not.toHaveBeenCalled();
  });

  it("cancels a draft without a booking call (no dated lines)", async () => {
    const order = await makeOrder(h.db, { status: "draft", expiresAt: null });
    await makeOrderLine(h.db, { orderId: order.id });
    expect(await inTx((tx, ctx) => cancelOrder(tx, ctx, { orderId: order.id, reason: "staff" }))).toEqual({ cancelled: true });
    expect((await orderRow(order.id)).status).toBe("cancelled");
    expect(releaseBookingsForOrder).not.toHaveBeenCalled();
    expect(releaseCredits).not.toHaveBeenCalled();
  });

  it("returns { cancelled: false } for a live provider payment and for a paid order, without throwing", async () => {
    const live = await makeOrder(h.db, {});
    await h.db.insert(payments).values({ orderId: live.id, provider: "mollie", providerPaymentId: `tr_live${randomUUID().slice(0, 8)}`, status: "pending", amountCents: 4500 });
    expect(await inTx((tx, ctx) => cancelOrder(tx, ctx, { orderId: live.id, reason: "staff" }))).toEqual({ cancelled: false });
    expect((await orderRow(live.id)).status).toBe("pending_payment");

    const paid = await makeOrder(h.db, { status: "paid" });
    expect(await inTx((tx, ctx) => cancelOrder(tx, ctx, { orderId: paid.id, reason: "staff" }))).toEqual({ cancelled: false });
    expect((await orderRow(paid.id)).status).toBe("paid");
    expect(releaseBookingsForOrder).not.toHaveBeenCalled();
  });

  it("cancels an open bank-transfer order with one credit note (noRefund) and the transfer payment cancelled", async () => {
    const order = await makeOrder(h.db, { channel: "pos", personId: (await makePerson(h.db)).id, expiresAt: null });
    await makeOrderLine(h.db, { orderId: order.id });
    const [transfer] = await h.db
      .insert(payments)
      .values({ orderId: order.id, provider: "bank_transfer", method: "banktransfer", status: "open", amountCents: 4500, expiresAt: new Date("2026-11-18T22:59:00Z") })
      .returning();
    getInvoiceForOrder.mockResolvedValue({ id: randomUUID(), kind: "invoice", number: "BEAM-2026-000010", issuedOn: "2026-11-04", status: "open", totalCents: 4500, isCompany: false, pdfReady: true });

    expect(await inTx((tx, ctx) => cancelOrder(tx, ctx, { orderId: order.id, reason: "transfer_not_received" }))).toEqual({ cancelled: true });
    expect(issueCreditNote).toHaveBeenCalledTimes(1);
    expect(issueCreditNote).toHaveBeenCalledWith(expect.anything(), expect.anything(), { orderId: order.id, reason: "transfer_not_received", noRefund: true });
    const [p] = await h.db.select().from(payments).where(eq(payments.id, transfer!.id));
    expect(p!.status).toBe("cancelled");
    expect(p!.statusHistory.at(-1)).toMatchObject({ status: "cancelled", source: "staff" });
  });

  it("issues no second credit note when finance already credited the invoice and cancels inside its transaction", async () => {
    const order = await makeOrder(h.db, { expiresAt: null });
    await makeOrderLine(h.db, { orderId: order.id });
    await h.db.insert(payments).values({ orderId: order.id, provider: "bank_transfer", status: "open", amountCents: 4500 });
    // Finance's manual credit note has fully credited the invoice (status cancelled) before it calls commerce.
    getInvoiceForOrder.mockResolvedValue({ id: randomUUID(), kind: "invoice", number: "BEAM-2026-000011", issuedOn: "2026-11-04", status: "cancelled", totalCents: 4500, isCompany: false, pdfReady: true });
    const r = await inTx(async (tx, ctx) => {
      await issueCreditNote(tx, ctx, { orderId: order.id, reason: "manual", noRefund: true }); // finance's own call
      return cancelOrder(tx, ctx, { orderId: order.id, reason: "manual" });
    });
    expect(r).toEqual({ cancelled: true });
    expect(issueCreditNote).toHaveBeenCalledTimes(1);
  });
});

describe("cancelRenewalOrder", () => {
  it("cancels despite an open recurring payment and enqueues payments.cancel for it", async () => {
    const order = await makeOrder(h.db, { channel: "recurring", renewalMembershipId: null });
    await makeOrderLine(h.db, { orderId: order.id, productKind: "membership" });
    const [rec] = await h.db
      .insert(payments)
      .values({ orderId: order.id, provider: "mollie", sequenceType: "recurring", providerPaymentId: `tr_rec${randomUUID().slice(0, 8)}`, status: "pending", amountCents: 4500 })
      .returning();
    const [notSent] = await h.db.insert(payments).values({ orderId: order.id, provider: "mollie", sequenceType: "recurring", status: "open", amountCents: 4500 }).returning();

    await inTx((tx, ctx) => cancelRenewalOrder(tx, ctx, { orderId: order.id, reason: "membership_expired" }));
    expect((await orderRow(order.id)).status).toBe("cancelled");
    const queued = await h.db.select().from(jobs).where(and(eq(jobs.kind, "payments.cancel"), eq(jobs.idempotencyKey, `payment_cancel:${rec!.id}`)));
    expect(queued).toHaveLength(1);
    // The provider still holds the first payment: its status follows the provider's answer.
    expect((await h.db.select().from(payments).where(eq(payments.id, rec!.id)))[0]!.status).toBe("pending");
    // The one the provider never received is cancelled locally.
    expect((await h.db.select().from(payments).where(eq(payments.id, notSent!.id)))[0]!.status).toBe("cancelled");
  });
});
