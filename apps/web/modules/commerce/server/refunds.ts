/**
 * Refunds (commerce spec rules 36 to 40, 37a, 38, 45a and edge cases 12 to 14, 35; commerce-P6).
 *
 * `issueRefund` is the one refund engine: it locks the order, plans the refund with the pure
 * `refundPlan` (grant usage from `credits.getGrantUsage`, voucher states, the membership period,
 * the payments), writes one `refunds` row per payment the plan touches (credit balance first,
 * then provider payments, largest first), restores euro credit (`releaseCredits` for the whole
 * credit-balance amount, else a `grantCredits` of the part, rule 38), applies the credit effects
 * per line (package grants revoked, bookings cancelled, the membership cancelled, vouchers voided
 * with a scheduled email withdrawn), issues one credit note per refund row, moves the payments
 * and the order to `partially_refunded` or `refunded`, writes `order.refunded` and hands every
 * refund row to credits' `onOrderRefundedForReferrals` (negative partner commissions). Local money
 * (credit balance, cash) is `refunded` at once; a bank transfer is `sent` until staff confirm;
 * provider payments are refunded by the job `payments.refund`.
 *
 * `refundOrderLine` (rule 37a) is the api booking calls for in-policy cancellations and commerce
 * for seats lost after a late payment: the full line, no permission, no booking call back,
 * idempotent per line and reason.
 */
import { jobs, memberships, orderLines, orders, payments, persons, refunds, vouchers } from "@beam/db/schema";
import {
  DATED_PRODUCT_KINDS,
  nextOrderStatus,
  nextRefundStatus,
  nextVoucherStatus,
  refundPlan,
  type GrantUsage,
  type RefundLineInput,
  type RefundPlan,
} from "@beam/core/commerce";
import { formatMoney, t, type Locale } from "@beam/core/i18n";
import { IntegrationError } from "@beam/integrations/_shared";
import type { PaymentProvider } from "@beam/integrations/payments";
import { and, asc, desc, eq, inArray, isNotNull, sql, ConflictError, NotFoundError, ValidationError, createCtx, type Ctx, type DbOrTx, type Tx } from "@/lib/ctx";
import { getIntegrations, type Integrations } from "@/lib/integrations";
import type { JobCtx } from "@/lib/job-runner";
import { cancelMembershipForRefund, getGrantUsage, grantCredits, onOrderRefundedForReferrals, releaseCredits, revokeGrantRemainder } from "@/modules/credits/api";
import { createTask } from "@/modules/crm/api";
import { cancelScheduledMessage, sendTransactional } from "@/modules/email/api";
import { getInvoiceForOrder, issueCreditNote, markCreditNoteSettled } from "@/modules/finance/api";
import { commerceSettings, lockOrder, orderPageUrl, orderSubject, PAID_PAYMENT_STATUSES, type OrderLineRow, type OrderRow, type PaymentRow } from "./paid";

/** booking's api is loaded on first use (booking imports commerce's api; see paid.ts). */
const bookingApi = () => import("@/modules/booking/api");

export type RefundRow = typeof refunds.$inferSelect;
export type RefundKind = "refund" | "withdrawal";
export type RefundRequestLine = { orderLineId: string; quantity: number; amountCents?: number };
export type RefundLineReason = "cancelled_in_policy" | "session_cancelled" | "seat_no_longer_available" | "staff_override";

/** Orders that hold refundable money. */
const REFUNDABLE_ORDER_STATUSES = ["paid", "partially_refunded"] as const;
/** Providers whose refund is paid out locally at once (rule 38). */
const IMMEDIATE_PROVIDERS = new Set(["credit_balance", "cash"]);

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Loading the plan inputs
// ---------------------------------------------------------------------------

export type RefundContext = {
  order: OrderRow;
  lines: OrderLineRow[];
  payments: PaymentRow[];
  refunds: RefundRow[];
  /** Quantity and cents already refunded per order line (every refund row counts: money is owed). */
  refunded: Map<string, { quantity: number; cents: number }>;
  /** The plan input of each line, without the chosen quantity and amount. */
  inputs: Map<string, Omit<RefundLineInput, "refundQuantity" | "amountCents">>;
  /** The membership a membership line paid for (first order or renewal order). */
  membershipId: string | null;
};

/** What `refundPlan` needs for every line of `order` (read through `db`, the caller's transaction). */
export async function loadRefundContext(db: DbOrTx, order: OrderRow): Promise<RefundContext> {
  const lines = await db.select().from(orderLines).where(eq(orderLines.orderId, order.id)).orderBy(asc(orderLines.lineNo));
  const pays = await db.select().from(payments).where(eq(payments.orderId, order.id)).orderBy(asc(payments.createdAt));
  const refundRows = await db.select().from(refunds).where(eq(refunds.orderId, order.id)).orderBy(asc(refunds.createdAt));
  const refunded = new Map<string, { quantity: number; cents: number }>();
  for (const r of refundRows) {
    for (const l of r.lines) {
      const cur = refunded.get(l.order_line_id) ?? { quantity: 0, cents: 0 };
      refunded.set(l.order_line_id, { quantity: cur.quantity + l.quantity, cents: cur.cents + l.amount_cents });
    }
  }

  let membershipId: string | null = null;
  let membershipPeriod: { startsAt: Date; endsAt: Date } | undefined;
  if (lines.some((l) => l.productKind === "membership")) {
    const [m] = await db
      .select({ id: memberships.id, startsAt: memberships.currentPeriodStartAt, endsAt: memberships.currentPeriodEndAt })
      .from(memberships)
      .where(order.renewalMembershipId ? eq(memberships.id, order.renewalMembershipId) : eq(memberships.firstOrderId, order.id))
      .orderBy(desc(memberships.createdAt))
      .limit(1);
    if (m) {
      membershipId = m.id;
      membershipPeriod = { startsAt: m.startsAt, endsAt: m.endsAt };
    }
  }

  const inputs = new Map<string, Omit<RefundLineInput, "refundQuantity" | "amountCents">>();
  for (const line of lines) {
    const done = refunded.get(line.id);
    const base: Omit<RefundLineInput, "refundQuantity" | "amountCents"> = {
      orderLineId: line.id,
      productKind: line.productKind,
      quantity: line.quantity,
      lineTotalCents: line.lineTotalCents,
      refundedQuantity: done?.quantity ?? 0,
      refundedCents: done?.cents ?? 0,
    };
    if (line.productKind === "package") {
      const usage = await getGrantUsage(db, line.id);
      base.grants = usage.grants
        .filter((g) => g.status !== "revoked")
        .map((g): GrantUsage => ({ grantId: g.grantId, unitsGranted: g.unitsGranted, usedUnits: g.usedUnits }));
    } else if (line.productKind === "membership" && membershipPeriod) {
      base.membershipPeriod = membershipPeriod;
    } else if (line.productKind === "voucher") {
      const rows = await db.select({ id: vouchers.id, status: vouchers.status }).from(vouchers).where(eq(vouchers.orderLineId, line.id)).orderBy(asc(vouchers.createdAt), asc(vouchers.id));
      base.vouchers = rows.map((v) => ({ voucherId: v.id, status: v.status }));
    }
    inputs.set(line.id, base);
  }
  return { order, lines, payments: pays, refunds: refundRows, refunded, inputs, membershipId };
}

/** The plan of rules 36 to 38 for the chosen lines (the refund screen and `issueRefund`). */
export function planFromContext(c: RefundContext, request: RefundRequestLine[], at: Date): RefundPlan {
  const lines: RefundLineInput[] = request.map((r) => {
    const input = c.inputs.get(r.orderLineId);
    if (!input) throw new ValidationError("validation", { [`lines.${r.orderLineId}`]: "unknown_line" });
    return { ...input, refundQuantity: r.quantity, ...(r.amountCents !== undefined ? { amountCents: r.amountCents } : {}) };
  });
  return refundPlan({
    lines,
    payments: c.payments.map((p) => ({ paymentId: p.id, provider: p.provider, status: p.status, amountCents: p.amountCents, refundedCents: p.refundedCents })),
    at,
  });
}

/** The default plan of the refund screen: every line with what is left of it. */
export async function getRefundPreview(db: DbOrTx, orderId: string, at: Date = new Date()) {
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
  if (!order) return null;
  const c = await loadRefundContext(db, order);
  const open = c.lines
    .map((l) => ({ line: l, left: l.quantity - (c.refunded.get(l.id)?.quantity ?? 0) }))
    .filter((x) => x.left > 0);
  const plans = open.map((x) => ({ line: x.line, left: x.left, plan: planFromContext(c, [{ orderLineId: x.line.id, quantity: x.left }], at) }));
  return { order, context: c, lines: plans, refundableCents: plans[0]?.plan.refundableCents ?? 0 };
}

/**
 * The refund dialog of the order screen (finance-P6): one amount in cents spread over the lines
 * of `getRefundPreview` in order, each line up to what is still refundable on it, with the whole
 * remaining quantity. Null when the amount is not a positive whole number of cents or above what
 * the order can refund; the per-line screen covers every other case.
 */
export function quickRefundLines(
  preview: { lines: Array<{ line: { id: string }; left: number; plan: RefundPlan }> },
  amountCents: number,
): RefundRequestLine[] | null {
  if (!Number.isInteger(amountCents) || amountCents <= 0) return null;
  let need = amountCents;
  const out: RefundRequestLine[] = [];
  for (const { line, left, plan } of preview.lines) {
    const max = plan.lines[0]?.maxAmountCents ?? 0;
    if (need <= 0) break;
    if (max <= 0 || left <= 0) continue;
    const take = Math.min(need, max);
    out.push({ orderLineId: line.id, quantity: left, amountCents: take });
    need -= take;
  }
  return need > 0 || out.length === 0 ? null : out;
}

// ---------------------------------------------------------------------------
// Who a refund row names
// ---------------------------------------------------------------------------

/**
 * `refunds.created_by_user_id`: the acting staff user or customer account; null for a system
 * refund (booking's session cancellation from a job, seats lost after a late payment, rule 37a).
 */
function refundCreator(ctx: Ctx): string | null {
  return ctx.actor.kind === "staff" || ctx.actor.kind === "customer" ? ctx.actor.userId : null;
}

/** Finance never lets a customer issue a credit note; a customer's withdrawal or cancellation runs it as the system. */
function financeCtx(ctx: Ctx): Ctx {
  if (ctx.actor.kind !== "customer" && ctx.actor.kind !== "public") return ctx;
  return createCtx({ tx: ctx.tx, actor: { kind: "system", jobId: "" }, requestId: ctx.requestId, now: ctx.now, locale: ctx.locale, ip: ctx.ip });
}

// ---------------------------------------------------------------------------
// issueRefund
// ---------------------------------------------------------------------------

export type IssueRefundInput = {
  orderId: string;
  lines: RefundRequestLine[];
  reason: string;
  kind: RefundKind;
  /** Rule 40 (staff refunds): above the threshold or on an old order also `invoices.issue`. */
  checkSecondPermission?: boolean;
  /** Rule 37a: booking started the refund, so booking is not called back. */
  skipBooking?: boolean;
};

export type IssueRefundResult = { refundIds: string[]; creditNoteId: string | null; amountCents: number; plan: RefundPlan };

/** Splits the line amounts over the allocations in order (each refund row gets its own lines). */
function splitLines(plan: RefundPlan): Array<{ quantity: number; amountCents: number; orderLineId: string }[]> {
  const queue = plan.lines.filter((l) => l.amountCents > 0).map((l) => ({ orderLineId: l.orderLineId, quantity: l.quantity, left: l.amountCents }));
  return plan.allocations.map((a) => {
    let need = a.amountCents;
    const out: { quantity: number; amountCents: number; orderLineId: string }[] = [];
    while (need > 0 && queue.length) {
      const head = queue[0]!;
      const take = Math.min(need, head.left);
      // The quantity goes with the first portion of the line, so it is counted once.
      out.push({ orderLineId: head.orderLineId, quantity: out.some((o) => o.orderLineId === head.orderLineId) ? 0 : head.quantity, amountCents: take });
      head.quantity = 0;
      head.left -= take;
      need -= take;
      if (head.left <= 0) queue.shift();
    }
    return out;
  });
}

const PROBLEM_ERRORS: Record<string, () => Error> = {
  refund_too_high: () => new ValidationError("refund_too_high", { amountCents: "refund_too_high" }),
  line_amount_too_high: () => new ValidationError("refund_too_high", { amountCents: "refund_too_high" }),
  quantity_too_high: () => new ValidationError("validation", { quantity: "quantity_too_high" }),
  voucher_not_refundable: () => new ConflictError("voucher_used"),
  nothing_to_refund: () => new ConflictError("nothing_to_refund"),
};

export async function issueRefund(tx: Tx, ctx: Ctx, input: IssueRefundInput): Promise<IssueRefundResult> {
  const order = await lockOrder(tx, input.orderId);
  if (!order) throw new NotFoundError("order_not_found");
  if (!(REFUNDABLE_ORDER_STATUSES as readonly string[]).includes(order.status)) throw new ConflictError("invalid_transition");
  const reason = input.reason.trim();
  if (reason.length < 3) throw new ValidationError("validation", { reason: "required" });

  const c = await loadRefundContext(tx, order);
  const plan = planFromContext(c, input.lines, ctx.now);
  if (!plan.ok) throw (PROBLEM_ERRORS[plan.problems[0]!.code] ?? PROBLEM_ERRORS.nothing_to_refund!)();

  // Rule 40: above € 500 or on an order older than 365 days also `invoices.issue`.
  if (input.checkSecondPermission && input.kind !== "withdrawal") {
    const settings = await commerceSettings(tx);
    const old = order.paidAt && ctx.now.getTime() - order.paidAt.getTime() > settings.refund_second_permission_after_days * DAY_MS;
    if (plan.totalCents > settings.refund_second_permission_above_cents || old) ctx.require("invoices.issue");
  }

  const createdByUserId = refundCreator(ctx);
  const portions = splitLines(plan);
  const paymentById = new Map(c.payments.map((p) => [p.id, p]));
  const refundRows: RefundRow[] = [];
  for (const [i, a] of plan.allocations.entries()) {
    const payment = paymentById.get(a.paymentId)!;
    const immediate = IMMEDIATE_PROVIDERS.has(payment.provider);
    const [row] = await tx
      .insert(refunds)
      .values({
        paymentId: payment.id,
        orderId: order.id,
        amountCents: a.amountCents,
        reason,
        lines: portions[i]!.map((p) => ({ order_line_id: p.orderLineId, quantity: p.quantity, amount_cents: p.amountCents })),
        creditAction: plan.creditAction,
        status: immediate ? "refunded" : payment.provider === "bank_transfer" ? "sent" : "pending",
        createdByUserId,
      })
      .returning();
    refundRows.push(row!);
    await tx
      .update(payments)
      .set({
        refundedCents: a.refundedCentsAfter,
        status: a.statusAfter,
        statusHistory: [...(payment.statusHistory ?? []), { status: a.statusAfter, at: ctx.now.toISOString(), source: "staff" }],
        updatedAt: ctx.now,
      })
      .where(eq(payments.id, payment.id));

    // Rule 38: euro credit comes back in this transaction.
    if (payment.provider === "credit_balance" && order.personId) {
      if (a.euroRestore === "release") {
        await releaseCredits(tx, ctx, { ref: { type: "order", id: order.id }, reason: "refund" });
        // Euro credit consumed again for a late paid after expiry is keyed by its payment (payments.ts).
        await releaseCredits(tx, ctx, { ref: { type: "order", id: payment.id }, reason: "refund" });
      } else {
        await grantCredits(tx, ctx, {
          personId: order.personId,
          kind: "euro",
          units: a.amountCents,
          source: "manual",
          refundId: row!.id,
          vatRatePct: null,
          expiresAt: null,
          key: `grant:refund:${row!.id}`,
          reason: "partial_refund",
        });
      }
    }
  }
  const firstRefundId = refundRows[0]!.id;

  // Rule 37: credit effects, once per line.
  const lineById = new Map(c.lines.map((l) => [l.id, l]));
  for (const pl of plan.lines) {
    const line = lineById.get(pl.orderLineId)!;
    if (line.productKind === "package" && pl.grantIds.length) {
      await revokeGrantRemainder(tx, ctx, { orderLineId: line.id, grantIds: pl.grantIds, refundId: firstRefundId, reason: "refund" });
    } else if (pl.cancelsBooking && !input.skipBooking) {
      await (await bookingApi()).cancelBookingsForOrderLine(tx, ctx, { orderLineId: line.id, reason: "refunded" });
    } else if (line.productKind === "membership" && c.membershipId) {
      await cancelMembershipForRefund(tx, ctx, { membershipId: c.membershipId, reason: input.kind === "withdrawal" ? "withdrawal" : "refund" });
    } else if (line.productKind === "voucher" && pl.voucherIds.length) {
      await voidVouchers(tx, ctx, pl.voucherIds, input.kind === "withdrawal" ? "withdrawal" : "refunded");
    }
  }

  // Rule 39: one credit note per refund row; none for an order without invoice (0 total).
  const fctx = financeCtx(ctx);
  const invoice = await getInvoiceForOrder(tx, order.id);
  let creditNoteId: string | null = null;
  if (invoice && invoice.totalCents > 0) {
    for (const [i, row] of refundRows.entries()) {
      const lines = portions[i]!.filter((p) => p.amountCents > 0).map((p) => ({ orderLineId: p.orderLineId, amountCents: p.amountCents }));
      const note = await issueCreditNote(tx, fctx, { orderId: order.id, refundId: row.id, reason, lines });
      await tx.update(refunds).set({ creditNoteId: note.creditNoteId, updatedAt: ctx.now }).where(eq(refunds.id, row.id));
      row.creditNoteId = note.creditNoteId;
      creditNoteId ??= note.creditNoteId;
    }
  }

  // The order: refunded when every paid cent went back, else partially refunded.
  const [money] = await tx
    .select({
      paid: sql<number>`coalesce(sum(${payments.amountCents}) filter (where ${inArray(payments.status, [...PAID_PAYMENT_STATUSES])}), 0)::int`,
      refunded: sql<number>`coalesce(sum(${payments.refundedCents}), 0)::int`,
    })
    .from(payments)
    .where(eq(payments.orderId, order.id));
  const target = Number(money?.refunded ?? 0) >= Number(money?.paid ?? 0) ? "refunded" : "partially_refunded";
  const next = nextOrderStatus(order.status, target);
  if (next) {
    await tx.update(orders).set({ status: next, version: sql`${orders.version} + 1`, updatedAt: ctx.now }).where(eq(orders.id, order.id));
  }

  const subject = orderSubject(order);
  if (subject) {
    await ctx.recordEvent({
      kind: "order.refunded",
      ...subject,
      ref: { type: "refund", id: firstRefundId },
      dedupeKey: `refund:${firstRefundId}:refunded`,
      data: { order_id: order.id, amount_cents: plan.totalCents, reason },
    });
  }

  // credits-P9: a refund of a referred customer's order writes the negative commission rows
  // (and sends a qualified attribution in its 14-day window back to pending).
  for (const row of refundRows) await onOrderRefundedForReferrals(tx, ctx, { orderId: order.id, refundId: row.id });

  // Refunds paid out locally are settled now; provider refunds go to `payments.refund`.
  for (const row of refundRows) {
    if (row.status === "refunded") await afterRefunded(tx, ctx, row, order);
    else if (row.status === "pending") {
      await ctx.enqueue({ kind: "payments.refund", payload: { refundId: row.id }, key: `refund:${row.id}` });
    }
  }
  return { refundIds: refundRows.map((r) => r.id), creditNoteId, amountCents: plan.totalCents, plan };
}

/** Vouchers of a refunded line become `void`; a scheduled, undelivered email is withdrawn (rule 45a). */
export async function voidVouchers(tx: Tx, ctx: Ctx, voucherIds: string[], reason: string): Promise<string[]> {
  if (!voucherIds.length) return [];
  const rows = await tx.select().from(vouchers).where(inArray(vouchers.id, voucherIds)).for("update");
  const voided: string[] = [];
  for (const v of rows) {
    if (nextVoucherStatus(v.status, "void") === null) continue;
    await tx.update(vouchers).set({ status: "void", voidedReason: reason, updatedAt: ctx.now }).where(eq(vouchers.id, v.id));
    if (v.emailMessageId) await cancelScheduledMessage(ctx, { messageId: v.emailMessageId });
    voided.push(v.id);
  }
  return voided;
}

/** A refund reached `refunded`: finance settles its credit note and the customer gets the confirmation (rule 39). */
async function afterRefunded(tx: Tx, ctx: Ctx, refund: RefundRow, order: OrderRow): Promise<void> {
  if (refund.creditNoteId) await markCreditNoteSettled(tx, financeCtx(ctx), { refundId: refund.id, settledAt: ctx.now });
  if (!order.personId) return;
  const [person] = await tx.select({ email: persons.email }).from(persons).where(eq(persons.id, order.personId));
  if (!person?.email) return;
  const locale = order.locale as Locale;
  await sendTransactional(ctx, {
    template: "commerce.refund_confirmation",
    personId: order.personId,
    locale,
    data: { reference: order.reference, amount: formatMoney(refund.amountCents, locale), orderUrl: orderPageUrl(order.id, locale) },
    key: `refund:${refund.id}:confirmation`,
  });
}

/** Moves a refund to `refunded` (provider answer or staff confirmation) and settles it once. */
export async function markRefunded(tx: Tx, ctx: Ctx, refundId: string, patch: { providerRefundId?: string } = {}): Promise<boolean> {
  const [refund] = await tx.select().from(refunds).where(eq(refunds.id, refundId)).for("update");
  if (!refund) throw new NotFoundError("refund_not_found");
  if (nextRefundStatus(refund.status, "refunded") === null) return false;
  await tx
    .update(refunds)
    .set({ status: "refunded", ...(patch.providerRefundId ? { providerRefundId: patch.providerRefundId } : {}), failedReason: null, updatedAt: ctx.now })
    .where(eq(refunds.id, refund.id));
  const [order] = await tx.select().from(orders).where(eq(orders.id, refund.orderId));
  if (order) await afterRefunded(tx, ctx, refund, order);
  return true;
}

// ---------------------------------------------------------------------------
// refundOrderLine (rule 37a)
// ---------------------------------------------------------------------------

/**
 * api `refundOrderLine`: refunds the whole line (what is left of it), needs no staff permission
 * and never calls booking back. Idempotent per line and reason (`refund_line:<line>:<reason>`):
 * a refund of the line with the same reason, or a line already fully refunded, returns the
 * existing refund. An order without money (unpaid, 0 total) returns `{ refundId: null }`.
 */
export async function refundOrderLine(tx: Tx, ctx: Ctx, input: { orderLineId: string; reason: RefundLineReason }): Promise<{ refundId: string | null; amountCents: number }> {
  const [line] = await tx.select().from(orderLines).where(eq(orderLines.id, input.orderLineId));
  if (!line) throw new NotFoundError("order_line_not_found");
  const order = await lockOrder(tx, line.orderId);
  if (!order) throw new NotFoundError("order_not_found");

  const forLine = await tx
    .select()
    .from(refunds)
    .where(and(eq(refunds.orderId, order.id), sql`${refunds.lines} @> ${JSON.stringify([{ order_line_id: line.id }])}::jsonb`))
    .orderBy(asc(refunds.createdAt));
  const sameReason = forLine.filter((r) => r.reason === input.reason);
  const lineCents = (rows: RefundRow[]) => rows.reduce((s, r) => s + r.lines.filter((l) => l.order_line_id === line.id).reduce((a, l) => a + l.amount_cents, 0), 0);
  if (sameReason.length) return { refundId: sameReason[0]!.id, amountCents: lineCents(sameReason) };
  const done = lineCents(forLine);
  if (forLine.length && done >= line.lineTotalCents) return { refundId: forLine[0]!.id, amountCents: done };
  if (!(REFUNDABLE_ORDER_STATUSES as readonly string[]).includes(order.status) || line.lineTotalCents <= 0) return { refundId: null, amountCents: 0 };

  const refundedQty = forLine.reduce((s, r) => s + r.lines.filter((l) => l.order_line_id === line.id).reduce((a, l) => a + l.quantity, 0), 0);
  const quantity = Math.max(1, line.quantity - refundedQty);
  const out = await issueRefund(tx, ctx, {
    orderId: order.id,
    lines: [{ orderLineId: line.id, quantity, amountCents: line.lineTotalCents - done }],
    reason: input.reason,
    kind: "refund",
    skipBooking: (DATED_PRODUCT_KINDS as readonly string[]).includes(line.productKind),
  });
  return { refundId: out.refundIds[0] ?? null, amountCents: out.amountCents };
}

// ---------------------------------------------------------------------------
// Staff follow-ups: retry and manual confirmation
// ---------------------------------------------------------------------------

/** `retryRefund`: `failed -> pending`, a new `payments.refund` with key `refund:<id>:retry:<n>`. */
export async function retryRefund(tx: Tx, ctx: Ctx, input: { refundId: string }): Promise<{ ok: true; attempt: number }> {
  const [refund] = await tx.select().from(refunds).where(eq(refunds.id, input.refundId)).for("update");
  if (!refund) throw new NotFoundError("refund_not_found");
  if (nextRefundStatus(refund.status, "pending") === null) throw new ConflictError("invalid_transition");
  await tx.update(refunds).set({ status: "pending", failedReason: null, updatedAt: ctx.now }).where(eq(refunds.id, refund.id));
  const [count] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(jobs)
    .where(sql`${jobs.idempotencyKey} like ${`refund:${refund.id}:retry:%`}`);
  const attempt = Number(count?.n ?? 0) + 1;
  await ctx.enqueue({ kind: "payments.refund", payload: { refundId: refund.id }, key: `refund:${refund.id}:retry:${attempt}` });
  await ctx.audit({ action: "refund.retried", entityType: "refund", entityId: refund.id, newValue: { attempt } });
  return { ok: true, attempt };
}

/** `confirmManualRefund`: staff confirm a bank-transfer (or other manual) refund was paid out. */
export async function confirmManualRefund(tx: Tx, ctx: Ctx, input: { refundId: string }): Promise<{ ok: true }> {
  const changed = await markRefunded(tx, ctx, input.refundId);
  if (!changed) throw new ConflictError("invalid_transition");
  await ctx.audit({ action: "refund.confirmed", entityType: "refund", entityId: input.refundId });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// payments.refund (job) and the provider refund status
// ---------------------------------------------------------------------------

function paymentsClient(ctx: Ctx & { integrations?: Integrations }): PaymentProvider {
  return (ctx.integrations ?? getIntegrations()).payments;
}

export type ProviderRefundResult = { skipped: true; status: RefundRow["status"] } | { status: "sent" | "refunded" | "failed"; providerRefundId: string | null };

/**
 * `payments.refund` (key `refund:<refund_id>`, retries `refund:<id>:retry:<n>`): asks the
 * provider to refund the payment with the job key as `Idempotency-Key`; the refund becomes
 * `sent` (or `refunded` when the provider says so at once). A provider 4xx fails the refund
 * (it shows on the attention feed with Retry, and finance gets a task); 5xx retries.
 */
export async function runProviderRefund(ctx: JobCtx, input: { refundId: string }): Promise<ProviderRefundResult> {
  const tx = ctx.tx;
  const [refund] = await tx.select().from(refunds).where(eq(refunds.id, input.refundId)).for("update");
  if (!refund) throw new NotFoundError("refund_not_found");
  if (refund.status !== "pending") return { skipped: true, status: refund.status };
  const [payment] = await tx.select().from(payments).where(eq(payments.id, refund.paymentId));
  const [order] = await tx.select().from(orders).where(eq(orders.id, refund.orderId));
  if (!payment?.providerPaymentId || !order) {
    await markRefundFailed(tx, ctx, refund, order ?? null, "no_provider_payment");
    return { status: "failed", providerRefundId: null };
  }
  let answer: { providerRefundId: string; status: "pending" | "refunded" | "failed" };
  try {
    answer = await paymentsClient(ctx).refund({
      providerPaymentId: payment.providerPaymentId,
      amountCents: refund.amountCents,
      description: `Refund ${order.reference}`,
      idempotencyKey: ctx.job.key,
    });
  } catch (error) {
    if (error instanceof IntegrationError && !error.retryable) {
      await markRefundFailed(tx, ctx, refund, order, "provider_rejected");
      return { status: "failed", providerRefundId: null };
    }
    throw error;
  }
  if (answer.status === "failed") {
    await tx.update(refunds).set({ providerRefundId: answer.providerRefundId, updatedAt: ctx.now }).where(eq(refunds.id, refund.id));
    await markRefundFailed(tx, ctx, refund, order, "provider_failed");
    return { status: "failed", providerRefundId: answer.providerRefundId };
  }
  if (answer.status === "refunded") {
    await tx.update(refunds).set({ status: "sent", providerRefundId: answer.providerRefundId, updatedAt: ctx.now }).where(eq(refunds.id, refund.id));
    await markRefunded(tx, ctx, refund.id);
    return { status: "refunded", providerRefundId: answer.providerRefundId };
  }
  await tx.update(refunds).set({ status: "sent", providerRefundId: answer.providerRefundId, updatedAt: ctx.now }).where(eq(refunds.id, refund.id));
  return { status: "sent", providerRefundId: answer.providerRefundId };
}

async function markRefundFailed(tx: Tx, ctx: Ctx, refund: RefundRow, order: OrderRow | null, reason: string): Promise<void> {
  if (nextRefundStatus(refund.status, "failed") === null) return;
  await tx.update(refunds).set({ status: "failed", failedReason: reason, updatedAt: ctx.now }).where(eq(refunds.id, refund.id));
  await createTask(tx, ctx, {
    title: t("nl-BE", "commerce.tasks.refund_failed", { reference: order?.reference ?? refund.orderId }),
    kind: "payment",
    ownerRole: "finance",
    ...(order?.personId ? { personId: order.personId } : {}),
    source: "system",
    ref: { type: "refund", id: refund.id },
    dedupeKey: `refund_failed:${refund.id}`,
  });
}

/**
 * After a payment sync: the provider's view of the payment's `sent` refunds moves them to
 * `refunded` or `failed` (the final refund status comes from `payments.sync`, section 4.5).
 */
export async function syncProviderRefunds(ctx: Ctx & { integrations?: Integrations }, paymentId: string): Promise<{ settled: number; failed: number }> {
  const tx = ctx.tx;
  const sent = await tx
    .select()
    .from(refunds)
    .where(and(eq(refunds.paymentId, paymentId), eq(refunds.status, "sent"), isNotNull(refunds.providerRefundId)))
    .for("update");
  if (!sent.length) return { settled: 0, failed: 0 };
  const [payment] = await tx.select().from(payments).where(eq(payments.id, paymentId));
  if (!payment?.providerPaymentId) return { settled: 0, failed: 0 };
  const reported = await paymentsClient(ctx).getPayment(payment.providerPaymentId);
  const byId = new Map(reported.refunds.map((r) => [r.providerRefundId, r.status]));
  let settled = 0;
  let failed = 0;
  for (const r of sent) {
    const status = byId.get(r.providerRefundId!);
    if (status === "refunded" && (await markRefunded(tx, ctx, r.id))) settled++;
    if (status === "failed") {
      const [order] = await tx.select().from(orders).where(eq(orders.id, r.orderId));
      await markRefundFailed(tx, ctx, r, order ?? null, "provider_failed");
      failed++;
    }
  }
  return { settled, failed };
}

/** The refunds of an order (admin order screen). */
export async function listOrderRefunds(db: DbOrTx, orderId: string): Promise<RefundRow[]> {
  return db.select().from(refunds).where(eq(refunds.orderId, orderId)).orderBy(asc(refunds.createdAt));
}

