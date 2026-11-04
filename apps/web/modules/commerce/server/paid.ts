/**
 * The paid transaction (commerce spec rules 19, 28, 31, 32, 45, 50, 54; commerce-P4a).
 * `finalizePaidOrder` runs once per order inside the caller's database transaction (the
 * `payments.sync` or webhook job, or `createOrder` for a zero total or full euro credit). It
 * locks the order, moves it `pending_payment -> paid` (or `expired -> paid` for a late provider
 * `paid`), confirms the promotion redemptions, calls one credits function per line, confirms the
 * bookings once, activates vouchers, issues the invoice, records `order.paid` and
 * `promotion.redeemed`, completes the checkout and queues the receipt and the emails. Any
 * failure throws and rolls the whole transaction back: nothing is half delivered.
 *
 * Also holds the small order helpers the other order files share (settings, the order lock and
 * the paid amount).
 */
import { checkouts, orderLines, orders, payments, products, promotionRedemptions, promotions, vouchers } from "@beam/db/schema";
import {
  COMMERCE_SETTINGS_DEFAULTS,
  DATED_PRODUCT_KINDS,
  deriveVoucherCode,
  hashVoucherCode,
  nextCheckoutStatus,
  nextOrderStatus,
  voucherCodeLast4,
  type CommerceSettingsValue,
  type ProductKind,
} from "@beam/core/commerce";
import { computeExpiresAt } from "@beam/core/credits";
import { PermanentError } from "@beam/core/errors";
import { URL_SEGMENT, type Locale } from "@beam/core/i18n";
import { appUrl } from "@/lib/auth";
import { and, eq, inArray, ne, sql, type Ctx, type DbOrTx, type JobKind, type Tx } from "@/lib/ctx";
import { loadJobs } from "@/lib/job-runner";
import { getSetting } from "@/lib/settings";
import { activateMembership, applyRenewalPayment, grantCredits, onOrderPaidForReferrals } from "@/modules/credits/api";
import { sendTransactional } from "@/modules/email/api";
import { issueInvoice } from "@/modules/finance/api";
import { getCustomerAccount } from "@/modules/platform/api";

/**
 * booking's api is loaded on first use: booking's own order flow imports commerce's api, so a
 * static import would close the cycle booking -> commerce -> booking while either module is
 * still evaluating (and would defeat the module mocks of either side's tests).
 */
const bookingApi = () => import("@/modules/booking/api");

export type OrderRow = typeof orders.$inferSelect;
export type OrderLineRow = typeof orderLines.$inferSelect;
export type PaymentRow = typeof payments.$inferSelect;

/** Statuses whose payments count towards the paid amount (`v_order_balances`). */
export const PAID_PAYMENT_STATUSES = ["paid", "partially_refunded", "refunded"] as const;
/** Channels that are online sales (terms acceptance, withdrawal right, rule 54). */
export const ONLINE_CHANNELS = ["portal", "site", "link"] as const;
/** Product kinds that carry the 14-day withdrawal right when sold online (rule 54). */
const WITHDRAWABLE_KINDS: readonly ProductKind[] = ["package", "membership", "voucher"];

// ---------------------------------------------------------------------------
// Shared order helpers
// ---------------------------------------------------------------------------

/** The `commerce` setting (its declared default when the registry is not loaded). */
export async function commerceSettings(db: DbOrTx): Promise<CommerceSettingsValue> {
  try {
    return await getSetting(db, "commerce");
  } catch {
    return structuredClone(COMMERCE_SETTINGS_DEFAULTS);
  }
}

/** `SELECT ... FROM orders WHERE id = $1 FOR UPDATE` (rule 31). */
export async function lockOrder(tx: DbOrTx, orderId: string): Promise<OrderRow | null> {
  const [row] = await tx.select().from(orders).where(eq(orders.id, orderId)).for("update");
  return row ?? null;
}

/** The sum of the order's paid payments (`v_order_balances.paid_cents`). */
export async function paidCentsOf(db: DbOrTx, orderId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`coalesce(sum(${payments.amountCents}), 0)::int` })
    .from(payments)
    .where(and(eq(payments.orderId, orderId), inArray(payments.status, [...PAID_PAYMENT_STATUSES])));
  return Number(row?.n ?? 0);
}

/** The customer-facing order page of an order (portal), absolute. */
export function orderPageUrl(orderId: string, locale: Locale): string {
  return appUrl(`/${URL_SEGMENT[locale]}/account/orders/${orderId}`);
}

/** The event subject of an order: its person, else its company, else none (anonymous POS). */
export function orderSubject(order: Pick<OrderRow, "personId" | "companyId">): { personId: string } | { companyId: string } | null {
  if (order.personId) return { personId: order.personId };
  if (order.companyId) return { companyId: order.companyId };
  return null;
}

/** Midnight Europe/Brussels at the start of a `YYYY-MM-DD` day. */
export function brusselsMidnight(day: string): Date {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const guess = new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Brussels", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(guess)
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
  return new Date(guess.getTime() - (asUtc - guess.getTime()));
}

// ---------------------------------------------------------------------------
// finalizePaidOrder
// ---------------------------------------------------------------------------

export type DeliveredLine = {
  orderLineId: string;
  productKind: ProductKind;
  result: "credits_granted" | "membership_activated" | "renewal_applied" | "voucher_activated" | "booking_confirmed" | "booking_unavailable" | "none";
  grantIds?: string[];
  membershipId?: string;
  voucherIds?: string[];
};

export type FinalizeResult = { delivered: DeliveredLine[]; unavailableOrderLineIds: string[] };

const NOTHING: FinalizeResult = { delivered: [], unavailableOrderLineIds: [] };

/**
 * Runs the paid transaction of `orderId` (rule 32) inside `tx`. Guarded by the order row lock:
 * only a `pending_payment` order (or an `expired` one paid late, rule 28) is finalised; any other
 * status returns nothing delivered, so a second webhook, poll or job run is a no-op (edge case
 * 28). `paymentId` names the payment that completed the order (invoice settlement).
 */
export async function finalizePaidOrder(tx: Tx, ctx: Ctx, orderId: string, opts: { paymentId?: string } = {}): Promise<FinalizeResult> {
  const order = await lockOrder(tx, orderId);
  if (!order) return NOTHING;
  if (nextOrderStatus(order.status, "paid") === null) return NOTHING;
  const paidAt = ctx.now;
  const settings = await commerceSettings(tx);

  const lines = await tx.select().from(orderLines).where(eq(orderLines.orderId, orderId)).orderBy(orderLines.lineNo);
  const productIds = [...new Set(lines.map((l) => l.productId))];
  const productRows = productIds.length ? await tx.select().from(products).where(inArray(products.id, productIds)) : [];
  const productById = new Map(productRows.map((p) => [p.id, p]));

  const isOnline = (ONLINE_CHANNELS as readonly string[]).includes(order.channel);
  const withdrawalUntilAt =
    isOnline && lines.some((l) => WITHDRAWABLE_KINDS.includes(l.productKind)) ? new Date(paidAt.getTime() + settings.withdrawal_days * 86_400_000) : null;

  // 1. The order (state machine, version + 1).
  await tx
    .update(orders)
    .set({ status: "paid", paidAt, withdrawalUntilAt, version: sql`${orders.version} + 1`, updatedAt: paidAt })
    .where(eq(orders.id, orderId));

  // 2. The mandate of the paying payment (upserted by applyProviderStatus) feeds activateMembership.
  const paidPayments = await tx
    .select()
    .from(payments)
    .where(and(eq(payments.orderId, orderId), inArray(payments.status, [...PAID_PAYMENT_STATUSES])));
  const mandateId = paidPayments.find((p) => p.mandateId)?.mandateId ?? null;
  const settlingPaymentId =
    opts.paymentId ?? [...paidPayments].filter((p) => p.provider !== "credit_balance").sort((a, b) => (b.paidAt?.getTime() ?? 0) - (a.paidAt?.getTime() ?? 0))[0]?.id;

  // 3. Promotion redemptions: reserved -> confirmed; a released one (late paid) is re-confirmed
  // and counted again, even above max_uses (rule 19).
  const redemptions = await tx.select().from(promotionRedemptions).where(and(eq(promotionRedemptions.orderId, orderId), ne(promotionRedemptions.status, "confirmed")));
  for (const r of redemptions) {
    await tx.update(promotionRedemptions).set({ status: "confirmed", updatedAt: paidAt }).where(eq(promotionRedemptions.id, r.id));
    if (r.status === "released") {
      await tx.update(promotions).set({ usesCount: sql`${promotions.usesCount} + 1`, updatedAt: paidAt }).where(eq(promotions.id, r.promotionId));
    }
  }

  // 4. One credits call per line (credits rules 1, 45, 49).
  const delivered: DeliveredLine[] = [];
  const personId = order.personId;
  let renewalApplied = false;
  for (const line of lines) {
    const product = productById.get(line.productId);
    if (!product) throw new PermanentError(`product_missing: ${line.productId}`);
    if (line.productKind === "package") {
      if (!personId) throw new PermanentError(`package_without_person: ${orderId}`);
      const startsAt = line.data.start_on ? brusselsMidnight(line.data.start_on) : paidAt;
      const expiresAt = computeExpiresAt(startsAt, product.validityDays);
      const grantIds: string[] = [];
      const unitValueCents = Math.round(line.lineTotalCents / line.quantity / Math.max(1, product.creditUnits ?? 1));
      for (let n = 1; n <= line.quantity; n++) {
        const g = await grantCredits(tx, ctx, {
          personId,
          kind: product.creditKind!,
          units: product.creditUnits!,
          source: "purchase",
          productId: product.id,
          orderLineId: line.id,
          lineUnitIndex: n,
          unitValueCents,
          vatRatePct: Number(line.vatRatePct),
          startsAt,
          expiresAt,
          key: `grant:order_line:${line.id}:${n}`,
        });
        grantIds.push(g.grantId);
      }
      delivered.push({ orderLineId: line.id, productKind: line.productKind, result: "credits_granted", grantIds });
    } else if (line.productKind === "membership") {
      if (order.renewalMembershipId) {
        if (!renewalApplied) await applyRenewalPayment(tx, ctx, { membershipId: order.renewalMembershipId, orderId });
        renewalApplied = true;
        delivered.push({ orderLineId: line.id, productKind: line.productKind, result: "renewal_applied", membershipId: order.renewalMembershipId });
      } else {
        if (!personId) throw new PermanentError(`membership_without_person: ${orderId}`);
        const m = await activateMembership(tx, ctx, {
          personId,
          productId: product.id,
          orderId,
          priceVersionId: line.priceVersionId!,
          mandateId,
          startsAt: line.data.start_on ? brusselsMidnight(line.data.start_on) : paidAt,
        });
        delivered.push({ orderLineId: line.id, productKind: line.productKind, result: "membership_activated", membershipId: m.membershipId });
      }
    } else if (line.productKind === "voucher") {
      const voucherIds = await activateVouchers(tx, line, product.validityDays ?? 730, paidAt, order.status === "expired");
      delivered.push({ orderLineId: line.id, productKind: line.productKind, result: "voucher_activated", voucherIds });
    } else if (!(DATED_PRODUCT_KINDS as readonly string[]).includes(line.productKind)) {
      delivered.push({ orderLineId: line.id, productKind: line.productKind, result: "none" });
    }
  }
  if (order.renewalMembershipId && !renewalApplied) await applyRenewalPayment(tx, ctx, { membershipId: order.renewalMembershipId, orderId });

  // 5. Bookings, once for the whole order (online, payment link and POS alike).
  let unavailableOrderLineIds: string[] = [];
  const datedLines = lines.filter((l) => (DATED_PRODUCT_KINDS as readonly string[]).includes(l.productKind));
  if (datedLines.length) {
    const r = await (await bookingApi()).confirmBookingsForOrder(tx, ctx, { orderId });
    unavailableOrderLineIds = r.unavailableOrderLineIds;
    for (const l of datedLines) {
      delivered.push({ orderLineId: l.id, productKind: l.productKind, result: unavailableOrderLineIds.includes(l.id) ? "booking_unavailable" : "booking_confirmed" });
    }
  }

  // 6. R3 referral hook (no effect until credits-P9), the invoice (always; finance skips a 0 total).
  await onOrderPaidForReferrals(tx, ctx, { orderId });
  await issueInvoice(tx, ctx, { orderId, status: "paid", ...(settlingPaymentId ? { paymentId: settlingPaymentId } : {}), paidAt });

  // 7. Timeline events.
  const subject = orderSubject(order);
  if (subject) {
    const kinds = [...new Set(lines.map((l) => l.productKind))];
    await ctx.recordEvent({
      kind: "order.paid",
      ...subject,
      ref: { type: "order", id: orderId },
      dedupeKey: `order:${orderId}:paid`,
      data: {
        order_id: orderId,
        reference: order.reference,
        total_cents: order.totalCents,
        channel: order.channel,
        product_kinds: kinds,
        lines: lines.map((l) => ({ product_id: l.productId, kind: l.productKind, quantity: l.quantity })),
      },
    });
    const promoIds = [...new Set(lines.map((l) => l.promotionId).filter((x): x is string => !!x))];
    if (promoIds.length) {
      const promoRows = await tx.select().from(promotions).where(inArray(promotions.id, promoIds));
      for (const p of promoRows) {
        await ctx.recordEvent({
          kind: "promotion.redeemed",
          ...subject,
          ref: { type: "order", id: orderId },
          dedupeKey: `order:${orderId}:promotion_redeemed:${p.id}`,
          data: { promotion_id: p.id, code: p.code, discount_cents: lines.filter((l) => l.promotionId === p.id).reduce((s, l) => s + l.discountCents, 0) },
        });
      }
    }
  }

  // 8. The checkout this order came from is completed (rule 50).
  if (order.checkoutId) await completeCheckout(tx, ctx, order.checkoutId, orderId, paidAt);

  // 9. Receipt and emails: the receipt job renders the PDF and sends the confirmation with it.
  await ctx.enqueue({ kind: "commerce.render_receipt", payload: { orderId }, key: `receipt:${orderId}` });
  if (order.channel === "site" && personId && !(await getCustomerAccount(tx, personId))) {
    await sendTransactional(ctx, {
      template: "commerce.portal_invitation",
      personId,
      locale: order.locale as Locale,
      data: { reference: order.reference, url: appUrl(`/${URL_SEGMENT[order.locale as Locale]}/account/login`) },
      key: `order:${orderId}:portal_invitation`,
    });
  }
  const voucherJob = (await loadJobs())["commerce.issue_voucher_email"];
  if (voucherJob) {
    for (const d of delivered) {
      for (const voucherId of d.voucherIds ?? []) {
        await ctx.enqueue({ kind: "commerce.issue_voucher_email" as JobKind, payload: { voucherId, n: 0 }, key: `voucher_email:${voucherId}:0` });
      }
    }
  }

  // 10. Seats lost after a late payment are refunded without staff work (edge case 4).
  if (unavailableOrderLineIds.length) {
    await ctx.enqueue({
      kind: "commerce.refund_unavailable_lines",
      payload: { orderId, orderLineIds: unavailableOrderLineIds },
      key: `refund_unavailable:${orderId}`,
    });
  }
  return { delivered, unavailableOrderLineIds };
}

/** Voucher lines: every `pending` voucher of the line becomes `active` with its code hash (rule 45). */
/**
 * Activates the line's `pending` vouchers and returns the ids of its vouchers that work (activated
 * now or already `active`), the ones the voucher emails go to. On a late paid after local expiry
 * (rule 28, edge case 4) the vouchers the expiry voided (`void`, `order_expired`) are activated
 * too: the one exception to `void` being final (commerce spec 3.1).
 */
async function activateVouchers(tx: Tx, line: OrderLineRow, validityDays: number, paidAt: Date, latePaidAfterExpiry: boolean): Promise<string[]> {
  const rows = await tx
    .select()
    .from(vouchers)
    .where(eq(vouchers.orderLineId, line.id))
    .for("update");
  const secret = process.env.VOUCHER_CODE_SECRET;
  const ids: string[] = [];
  for (const v of rows) {
    if (v.status === "active") ids.push(v.id);
    const revived = latePaidAfterExpiry && v.status === "void" && v.voidedReason === "order_expired";
    if (v.status !== "pending" && !revived) continue;
    if (!secret) throw new PermanentError("voucher_code_secret_missing");
    const code = await deriveVoucherCode(secret, v.id);
    await tx
      .update(vouchers)
      .set({
        status: "active",
        activatedAt: paidAt,
        expiresAt: new Date(paidAt.getTime() + validityDays * 86_400_000),
        codeHash: await hashVoucherCode(code),
        codeLast4: voucherCodeLast4(code),
        ...(revived ? { voidedReason: null } : {}),
        updatedAt: paidAt,
      })
      .where(eq(vouchers.id, v.id));
    ids.push(v.id);
  }
  return ids;
}

/** `started` or `abandoned` -> `completed`, writing `checkout.completed` once (rule 50). */
async function completeCheckout(tx: Tx, ctx: Ctx, checkoutId: string, orderId: string, at: Date): Promise<void> {
  const [c] = await tx.select().from(checkouts).where(eq(checkouts.id, checkoutId)).for("update");
  if (!c || nextCheckoutStatus(c.status, "completed") === null) return;
  await tx.update(checkouts).set({ status: "completed", completedAt: at, orderId, updatedAt: at }).where(eq(checkouts.id, checkoutId));
  if (c.personId) {
    await ctx.recordEvent({
      kind: "checkout.completed",
      personId: c.personId,
      ref: { type: "checkout", id: checkoutId },
      dedupeKey: `checkout:${checkoutId}:completed`,
      data: { checkout_id: checkoutId, order_id: orderId },
    });
  }
}
