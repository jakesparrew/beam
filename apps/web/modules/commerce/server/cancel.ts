/**
 * Order cancellation (commerce spec rules 22b, 22c and 25; cross-module D31; commerce-P4b).
 *
 * `cancelOrder` works on `draft` and `pending_payment` orders: it closes an open bank-transfer
 * payment, credits an open bank-transfer invoice (`finance.issueCreditNote` with `noRefund`),
 * releases what the order held (`releaseOrderHolds`: bookings, euro credit, promotion
 * redemptions, pending vouchers), sets the order `cancelled` and writes `order.cancelled`. A
 * non-cancellable order (any other status, or a live provider payment) returns
 * `{ cancelled: false }`; it never throws for the status. `cancelRenewalOrder` is the same
 * without the live-payment refusal: an open recurring payment is cancelled at the provider by
 * the job `payments.cancel`.
 *
 * `releaseOrderHolds` is shared with the expiry scan (`server/expiry.ts`).
 */
import { orderLines, orders, payments, promotionRedemptions, promotions, vouchers } from "@beam/db/schema";
import {
  DATED_PRODUCT_KINDS,
  nextOrderStatus,
  nextPaymentStatus,
  nextRedemptionStatus,
  nextVoucherStatus,
  type PaymentStatus,
  type StatusSource,
} from "@beam/core/commerce";
import { and, eq, inArray, notInArray, sql, NotFoundError, type Ctx, type Tx } from "@/lib/ctx";
import { releaseCredits } from "@/modules/credits/api";
import { getInvoiceForOrder, issueCreditNote } from "@/modules/finance/api";
import { lockOrder, orderSubject, PAID_PAYMENT_STATUSES, type OrderRow, type PaymentRow } from "./paid";

/** booking's api is loaded on first use (booking's order flow imports commerce's api; see paid.ts). */
const bookingApi = () => import("@/modules/booking/api");

/** Payments still in flight (rule 23). */
export const LIVE_STATUSES = ["open", "pending", "authorized"] as const satisfies readonly PaymentStatus[];
/** Providers that never call out (rule 29). */
export const LOCAL_PROVIDERS = ["cash", "bank_transfer", "credit_balance"] as const;

export type CancelOutcome =
  | { cancelled: true; livePaymentIds: string[] }
  | { cancelled: false; reason: "invalid_transition" | "payment_in_progress" };

/**
 * Sets a payment's status without the provider failure path (no `payment.failed`, no email):
 * used when commerce itself closes a payment because its order ends. Forward moves only; the one
 * exception is a paid `credit_balance` payment, which becomes `cancelled` once its euro credit was
 * released (rule 25). Returns whether the row changed.
 */
export async function setPaymentStatusLocally(
  tx: Tx,
  ctx: Ctx,
  payment: PaymentRow,
  to: PaymentStatus,
  source: StatusSource,
  reason?: string,
): Promise<boolean> {
  const history = payment.statusHistory ?? [];
  const creditRelease = payment.provider === "credit_balance" && payment.status === "paid" && to === "cancelled";
  const next = creditRelease ? to : nextPaymentStatus(payment.status, to, source, history.at(-1)?.source ?? "provider");
  if (next === null) return false;
  await tx
    .update(payments)
    .set({
      status: next,
      statusHistory: [...history, { status: next, at: ctx.now.toISOString(), source }],
      ...(reason ? { failedReason: reason } : {}),
      updatedAt: ctx.now,
    })
    .where(eq(payments.id, payment.id));
  return true;
}

/**
 * Releases everything an unpaid order held (rules 19, 22, 25): its bookings
 * (`booking.releaseBookingsForOrder`, only when it has dated lines), its euro credit
 * (`credits.releaseCredits` with reason `order_expired`, the only order reason credits allows
 * besides `refund`; the `credit_balance` payment becomes `cancelled`), its reserved promotion
 * redemptions (`released`, `uses_count` decremented) and its `pending` vouchers (`void`).
 * Idempotent: a second call finds nothing left to release.
 */
export async function releaseOrderHolds(
  tx: Tx,
  ctx: Ctx,
  order: OrderRow,
  input: { bookingReason: "payment_expired" | "order_cancelled"; source: StatusSource },
): Promise<void> {
  const lines = await tx.select({ id: orderLines.id, kind: orderLines.productKind }).from(orderLines).where(eq(orderLines.orderId, order.id));
  if (lines.some((l) => (DATED_PRODUCT_KINDS as readonly string[]).includes(l.kind))) {
    await (await bookingApi()).releaseBookingsForOrder(tx, ctx, { orderId: order.id, reason: input.bookingReason });
  }

  const credit = await tx
    .select()
    .from(payments)
    .where(and(eq(payments.orderId, order.id), eq(payments.provider, "credit_balance"), inArray(payments.status, [...PAID_PAYMENT_STATUSES])))
    .for("update");
  if (credit.length && order.personId) {
    await releaseCredits(tx, ctx, { ref: { type: "order", id: order.id }, reason: "order_expired" });
  }
  for (const p of credit) await setPaymentStatusLocally(tx, ctx, p, "cancelled", input.source, input.bookingReason);

  const reserved = await tx
    .select()
    .from(promotionRedemptions)
    .where(and(eq(promotionRedemptions.orderId, order.id), eq(promotionRedemptions.status, "reserved")))
    .for("update");
  for (const r of reserved) {
    if (nextRedemptionStatus(r.status, "released") === null) continue;
    await tx.update(promotionRedemptions).set({ status: "released", updatedAt: ctx.now }).where(eq(promotionRedemptions.id, r.id));
    await tx
      .update(promotions)
      .set({ usesCount: sql`greatest(${promotions.usesCount} - 1, 0)`, updatedAt: ctx.now })
      .where(eq(promotions.id, r.promotionId));
  }

  if (lines.length) {
    const pending = await tx
      .select({ id: vouchers.id, status: vouchers.status })
      .from(vouchers)
      .where(and(inArray(vouchers.orderLineId, lines.map((l) => l.id)), eq(vouchers.status, "pending")))
      .for("update");
    const voidIds = pending.filter((v) => nextVoucherStatus(v.status, "void") !== null).map((v) => v.id);
    if (voidIds.length) {
      await tx
        .update(vouchers)
        .set({ status: "void", voidedReason: input.bookingReason === "payment_expired" ? "order_expired" : "order_cancelled", updatedAt: ctx.now })
        .where(inArray(vouchers.id, voidIds));
    }
  }
}

/** The order's provider payments that are still in flight (they block `cancelOrder`). */
export async function liveProviderPayments(tx: Tx, orderId: string): Promise<PaymentRow[]> {
  return tx
    .select()
    .from(payments)
    .where(and(eq(payments.orderId, orderId), inArray(payments.status, [...LIVE_STATUSES]), notInArray(payments.provider, [...LOCAL_PROVIDERS])))
    .for("update");
}

/**
 * The cancellation itself (rule 22b). `allowLivePayments` is the renewal variant (rule 22c): live
 * provider payments do not block and are returned so the caller can cancel them at the provider.
 */
export async function cancelOrderDetailed(
  tx: Tx,
  ctx: Ctx,
  input: { orderId: string; reason: string },
  opts: { allowLivePayments?: boolean } = {},
): Promise<CancelOutcome> {
  const order = await lockOrder(tx, input.orderId);
  if (!order) throw new NotFoundError("order_not_found");
  if (nextOrderStatus(order.status, "cancelled") === null) return { cancelled: false, reason: "invalid_transition" };
  const live = await liveProviderPayments(tx, order.id);
  if (live.length && !opts.allowLivePayments) return { cancelled: false, reason: "payment_in_progress" };

  // An open bank transfer does not block: the payment is cancelled and its open invoice credited
  // in this transaction (finance rule 25). When finance itself cancels after its own full credit
  // note, the invoice is no longer open and no second credit note is issued.
  const transfers = await tx
    .select()
    .from(payments)
    .where(and(eq(payments.orderId, order.id), eq(payments.provider, "bank_transfer"), eq(payments.status, "open")))
    .for("update");
  for (const p of transfers) await setPaymentStatusLocally(tx, ctx, p, "cancelled", "staff", "order_cancelled");
  const invoice = await getInvoiceForOrder(tx, order.id);
  if (invoice && invoice.status === "open") {
    await issueCreditNote(tx, ctx, { orderId: order.id, reason: input.reason, noRefund: true });
  }

  await releaseOrderHolds(tx, ctx, order, { bookingReason: "order_cancelled", source: "staff" });
  await tx
    .update(orders)
    .set({ status: "cancelled", cancelledAt: ctx.now, version: sql`${orders.version} + 1`, updatedAt: ctx.now })
    .where(eq(orders.id, order.id));
  const subject = orderSubject(order);
  if (subject) {
    await ctx.recordEvent({
      kind: "order.cancelled",
      ...subject,
      ref: { type: "order", id: order.id },
      dedupeKey: `order:${order.id}:cancelled`,
      data: { order_id: order.id },
    });
  }
  return { cancelled: true, livePaymentIds: live.map((p) => p.id) };
}

/** api `cancelOrder` (rule 22b): `{ cancelled: false }` for a non-cancellable order, never a throw for its status. */
export async function cancelOrder(tx: Tx, ctx: Ctx, input: { orderId: string; reason: string }): Promise<{ cancelled: boolean }> {
  const outcome = await cancelOrderDetailed(tx, ctx, input);
  return { cancelled: outcome.cancelled };
}

/**
 * api `cancelRenewalOrder` (rule 22c): `cancelOrder` without the `payment_in_progress` refusal.
 * A live recurring payment the provider already holds is cancelled there by `payments.cancel`
 * (its local status follows the provider's answer, so a late `paid` is still recorded and then
 * refunded); one the provider never received is cancelled locally at once.
 */
export async function cancelRenewalOrder(tx: Tx, ctx: Ctx, input: { orderId: string; reason: string }): Promise<void> {
  const outcome = await cancelOrderDetailed(tx, ctx, input, { allowLivePayments: true });
  if (!outcome.cancelled) return;
  for (const paymentId of outcome.livePaymentIds) {
    const [p] = await tx.select().from(payments).where(eq(payments.id, paymentId)).for("update");
    if (!p) continue;
    if (p.providerPaymentId) {
      await ctx.enqueue({ kind: "payments.cancel", payload: { paymentId }, key: `payment_cancel:${paymentId}` });
    } else {
      await setPaymentStatusLocally(tx, ctx, p, "cancelled", "staff", "order_cancelled");
    }
  }
}
