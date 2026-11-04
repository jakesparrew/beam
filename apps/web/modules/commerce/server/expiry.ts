/**
 * `payments.scan_expired` (commerce spec rules 22, 22a, 34; section 4.5; edge cases 3, 9, 11;
 * commerce-P4b). Runs every minute in one job transaction, in four steps of at most 200 rows
 * each, every row locked `FOR UPDATE SKIP LOCKED` so a concurrent webhook or checkout is never
 * overwritten:
 *
 * 1. Provider payments `open`, `pending` or `authorized` older than 30 minutes: `payments.sync`
 *    is enqueued (key `payment_sync:<provider_payment_id>:<YYYY-MM-DDTHH:mm>`), so a lost webhook
 *    is caught up.
 * 2. Those still in flight after 35 minutes become `expired` with source `local_timeout`
 *    (`applyProviderStatus`, so a later provider `paid` is still accepted, rule 28).
 * 3. `pending_payment` orders without a live payment whose `expires_at` passed become `expired`
 *    and release their bookings, euro credit, promotion redemptions and pending vouchers, with
 *    `order.expired` on the timeline.
 * 4. Drafts untouched for `draft_expiry_days` (30) are cancelled (rule 22a).
 *
 * Finally the 15-minute check (rule 34): payments in flight for more than 15 minutes raise the
 * High alert `commerce:payment_pending_15m` through `notifySlack` (counts and ids only; platform
 * sends one per fingerprint per hour).
 *
 * Bank transfers are local and wait 14 days (their overdue state is the attention feed), and
 * recurring (SEPA) payments stay pending for days at the provider: neither is synced early,
 * timed out or alerted on here; recurring ones are synced like any other after 30 minutes.
 */
import { orders, payments } from "@beam/db/schema";
import { localMinuteKey, wallClock } from "@beam/core/platform";
import { nextOrderStatus } from "@beam/core/commerce";
import { and, asc, eq, inArray, lt, ne, notInArray, sql, type Ctx, type Tx } from "@/lib/ctx";
import { notifySlack } from "@/lib/alerts";
import { applyProviderStatus } from "./payments";
import { cancelOrderDetailed, LIVE_STATUSES, LOCAL_PROVIDERS, releaseOrderHolds } from "./cancel";
import { commerceSettings, lockOrder, orderSubject } from "./paid";

const BATCH = 200;
const MINUTE = 60_000;
/** Rule 34 / section 4.5 thresholds. */
export const SYNC_AFTER_MINUTES = 30;
export const LOCAL_TIMEOUT_MINUTES = 35;
export const PENDING_ALERT_MINUTES = 15;
export const PENDING_ALERT_FINGERPRINT = "commerce:payment_pending_15m";

export type ScanResult = {
  synced: number;
  timedOut: number;
  expiredOrderIds: string[];
  cancelledDraftIds: string[];
  pendingAlert: { count: number; paymentIds: string[] } | null;
};

const ago = (ctx: Ctx, minutes: number) => new Date(ctx.now.getTime() - minutes * MINUTE);

/** In-flight provider payments created before `before`, optionally without recurring ones. */
function liveProviderWhere(before: Date, opts: { withRecurring: boolean }) {
  return and(
    inArray(payments.status, [...LIVE_STATUSES]),
    notInArray(payments.provider, [...LOCAL_PROVIDERS]),
    lt(payments.createdAt, before),
    ...(opts.withRecurring ? [] : [ne(payments.sequenceType, "recurring")]),
  );
}

/** Step 1: one `payments.sync` per in-flight payment and minute. */
async function enqueueSyncs(tx: Tx, ctx: Ctx): Promise<number> {
  const rows = await tx
    .select({ id: payments.id, providerPaymentId: payments.providerPaymentId })
    .from(payments)
    .where(and(liveProviderWhere(ago(ctx, SYNC_AFTER_MINUTES), { withRecurring: true }), sql`${payments.providerPaymentId} is not null`))
    .orderBy(asc(payments.createdAt))
    .limit(BATCH)
    .for("update", { skipLocked: true });
  const minute = localMinuteKey(wallClock(ctx.now));
  for (const r of rows) {
    await ctx.enqueue({ kind: "payments.sync", payload: { providerPaymentId: r.providerPaymentId! }, key: `payment_sync:${r.providerPaymentId}:${minute}` });
  }
  return rows.length;
}

/** Step 2: still in flight after 35 minutes -> `expired` (`local_timeout`). */
async function timeOutPayments(tx: Tx, ctx: Ctx): Promise<number> {
  const rows = await tx
    .select()
    .from(payments)
    .where(liveProviderWhere(ago(ctx, LOCAL_TIMEOUT_MINUTES), { withRecurring: false }))
    .orderBy(asc(payments.createdAt))
    .limit(BATCH)
    .for("update", { skipLocked: true });
  let n = 0;
  for (const p of rows) {
    const r = await applyProviderStatus(tx, ctx, p, { status: "expired", source: "local_timeout", reason: "payment_expired" });
    if (r.changed) n++;
  }
  return n;
}

/** Expires one locked `pending_payment` order with its releases (rule 22). */
export async function expireOrder(tx: Tx, ctx: Ctx, orderId: string): Promise<boolean> {
  const order = await lockOrder(tx, orderId);
  if (!order || order.status !== "pending_payment" || nextOrderStatus(order.status, "expired") === null) return false;
  if (!order.expiresAt || order.expiresAt.getTime() > ctx.now.getTime()) return false;
  const [live] = await tx
    .select({ id: payments.id })
    .from(payments)
    .where(and(eq(payments.orderId, order.id), inArray(payments.status, [...LIVE_STATUSES]), ne(payments.provider, "credit_balance")))
    .limit(1);
  if (live) return false;
  await releaseOrderHolds(tx, ctx, order, { bookingReason: "payment_expired", source: "local_timeout" });
  await tx
    .update(orders)
    .set({ status: "expired", version: sql`${orders.version} + 1`, updatedAt: ctx.now })
    .where(eq(orders.id, order.id));
  const subject = orderSubject(order);
  if (subject) {
    await ctx.recordEvent({
      kind: "order.expired",
      ...subject,
      ref: { type: "order", id: order.id },
      dedupeKey: `order:${order.id}:expired`,
      data: { order_id: order.id },
    });
  }
  return true;
}

/** Step 3: orders past `expires_at` without a live payment. */
async function expireOrders(tx: Tx, ctx: Ctx): Promise<string[]> {
  const rows = await tx
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(
        eq(orders.status, "pending_payment"),
        lt(orders.expiresAt, ctx.now),
        sql`not exists (select 1 from payments p where p.order_id = ${orders.id}
              and p.status in ('open', 'pending', 'authorized') and p.provider <> 'credit_balance')`,
      ),
    )
    .orderBy(asc(orders.expiresAt))
    .limit(BATCH)
    .for("update", { skipLocked: true });
  const out: string[] = [];
  for (const r of rows) if (await expireOrder(tx, ctx, r.id)) out.push(r.id);
  return out;
}

/** Step 4: drafts untouched for `draft_expiry_days` are cancelled (rule 22a). */
async function cancelStaleDrafts(tx: Tx, ctx: Ctx, days: number): Promise<string[]> {
  const rows = await tx
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.status, "draft"), lt(orders.updatedAt, new Date(ctx.now.getTime() - days * 86_400_000))))
    .orderBy(asc(orders.updatedAt))
    .limit(BATCH)
    .for("update", { skipLocked: true });
  const out: string[] = [];
  for (const r of rows) {
    const outcome = await cancelOrderDetailed(tx, ctx, { orderId: r.id, reason: "draft_expired" });
    if (outcome.cancelled) out.push(r.id);
  }
  return out;
}

/** Rule 34: payments in flight for more than 15 minutes raise the High alert (once per hour by platform). */
async function pendingAlert(tx: Tx, ctx: Ctx): Promise<ScanResult["pendingAlert"]> {
  const rows = await tx
    .select({ id: payments.id })
    .from(payments)
    .where(liveProviderWhere(ago(ctx, PENDING_ALERT_MINUTES), { withRecurring: false }))
    .orderBy(asc(payments.createdAt));
  if (!rows.length) return null;
  const ids = rows.map((r) => r.id);
  const shown = ids.slice(0, 20);
  await notifySlack(ctx, {
    fingerprint: PENDING_ALERT_FINGERPRINT,
    severity: "high",
    text: `${ids.length} payment(s) open for more than ${PENDING_ALERT_MINUTES} minutes: ${shown.join(", ")}${ids.length > shown.length ? ", ..." : ""}`,
  });
  return { count: ids.length, paymentIds: ids };
}

/** The `payments.scan_expired` handler. */
export async function scanExpired(ctx: Ctx): Promise<ScanResult> {
  const tx = ctx.tx;
  const settings = await commerceSettings(tx);
  const synced = await enqueueSyncs(tx, ctx);
  const timedOut = await timeOutPayments(tx, ctx);
  const expiredOrderIds = await expireOrders(tx, ctx);
  const cancelledDraftIds = await cancelStaleDrafts(tx, ctx, settings.draft_expiry_days);
  const alert = await pendingAlert(tx, ctx);
  return { synced, timedOut, expiredOrderIds, cancelledDraftIds, pendingAlert: alert };
}
