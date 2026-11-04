/**
 * Pure refund and withdrawal planning (commerce rules 36 to 38 and 54).
 *
 * `refundPlan` turns the lines and quantities staff (or `refundOrderLine`) chose into amounts per
 * line, the credit effects per line and the split over the order's payments: credit balance
 * first, then provider payments, largest first. `withdrawalPlan` decides what a customer's
 * 14-day withdrawal refunds. Neither touches the database; the server code loads the inputs
 * (grant usage from `credits.getGrantUsage`, voucher states, payments) and applies the plan.
 */
import type { ProductKind } from "./types";
import type { PaymentProvider, PaymentStatus, RefundCreditAction, VoucherStatus } from "./schemas";
import { DATED_PRODUCT_KINDS } from "./schemas";
import { divRoundHalfUp } from "./vat";

const DAY_MS = 86_400_000;

/** Usage of one unit's grant of a package line (`credits.getGrantUsage`). */
export type GrantUsage = { grantId: string; unitsGranted: number; usedUnits: number };

export type RefundLineInput = {
  orderLineId: string;
  productKind: ProductKind;
  /** Ordered quantity of the line. */
  quantity: number;
  lineTotalCents: number;
  /** Quantity and cents already refunded on this line by earlier refunds. */
  refundedQuantity?: number;
  refundedCents?: number;
  /** Quantity chosen for this refund. */
  refundQuantity: number;
  /** Staff may lower the default; never above what is left of the paid line total. */
  amountCents?: number;
  /**
   * Package lines: one grant per unit; already revoked grants are left out by the caller. The
   * pro rata share is still taken against the whole line (`quantity` x units per grant).
   */
  grants?: GrantUsage[];
  /** Membership lines: the current period, for the pro rata amount of unused days. */
  membershipPeriod?: { startsAt: Date; endsAt: Date };
  /** Voucher lines: the state of each unit's voucher. */
  vouchers?: Array<{ voucherId: string; status: VoucherStatus }>;
};

export type RefundPaymentInput = {
  paymentId: string;
  provider: PaymentProvider;
  status: PaymentStatus;
  amountCents: number;
  refundedCents: number;
};

export type RefundPlanInput = {
  lines: RefundLineInput[];
  payments: RefundPaymentInput[];
  at: Date;
};

export type RefundProblemCode =
  | "nothing_to_refund"
  | "quantity_too_high"
  | "refund_too_high"
  | "voucher_not_refundable"
  | "line_amount_too_high";

export type RefundPlanLine = {
  orderLineId: string;
  quantity: number;
  /** The default (pro rata) amount and the maximum staff may enter. */
  defaultAmountCents: number;
  maxAmountCents: number;
  amountCents: number;
  /** `revoke` for package and membership lines, else `none`. */
  creditAction: RefundCreditAction;
  /** Package lines: the grants to revoke (least used first). */
  grantIds: string[];
  /** Voucher lines: the vouchers that become `void`. */
  voucherIds: string[];
  /** Session, night and ticket lines: booking cancels the line's booking. */
  cancelsBooking: boolean;
};

export type RefundAllocation = {
  paymentId: string;
  provider: PaymentProvider;
  amountCents: number;
  /** Credit balance allocations only: restore euro credit by `release` (whole) or `grant` (part, rule 38). */
  euroRestore: "release" | "grant" | null;
  /** `payments.refunded_cents` and status after this refund. */
  refundedCentsAfter: number;
  statusAfter: PaymentStatus;
};

export type RefundPlan = {
  ok: boolean;
  problems: Array<{ code: RefundProblemCode; orderLineId?: string }>;
  lines: RefundPlanLine[];
  allocations: RefundAllocation[];
  totalCents: number;
  refundableCents: number;
  creditAction: RefundCreditAction;
};

const REFUNDABLE_PAYMENT_STATUSES: readonly PaymentStatus[] = ["paid", "partially_refunded"];

/** Pro rata share of `lineTotalCents` for `units` out of `ofUnits`, rounded half up. */
function share(lineTotalCents: number, units: number, ofUnits: number): number {
  return ofUnits <= 0 ? 0 : divRoundHalfUp(lineTotalCents * units, ofUnits);
}

/** Whole days between two instants (floor, never negative). */
export function daysBetween(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / DAY_MS));
}

/** Package grants to revoke for `count` units: the least used first, never a fully used one. */
function pickGrants(grants: GrantUsage[], count: number): GrantUsage[] {
  return [...grants]
    .filter((g) => g.unitsGranted - g.usedUnits > 0)
    .sort((a, b) => a.usedUnits - b.usedUnits || a.grantId.localeCompare(b.grantId))
    .slice(0, count);
}

/**
 * The units the whole package line granted: one grant per unit, all with the same units. Taken
 * from the line's quantity, not from the grants passed in, which leave out the grants already
 * revoked by an earlier refund (a second partial refund must not pay for used units, rule 37).
 */
function lineUnits(line: { quantity: number; grants?: GrantUsage[] | undefined }): number {
  const unitsPerGrant = (line.grants ?? []).reduce((m, g) => Math.max(m, g.unitsGranted), 0);
  return line.quantity * unitsPerGrant;
}

function planLine(line: RefundLineInput, at: Date): { plan: RefundPlanLine; problem?: RefundProblemCode } {
  const refundedCents = line.refundedCents ?? 0;
  const leftCents = Math.max(0, line.lineTotalCents - refundedCents);
  const leftQuantity = line.quantity - (line.refundedQuantity ?? 0);
  const quantity = line.refundQuantity;
  const base: RefundPlanLine = {
    orderLineId: line.orderLineId,
    quantity,
    defaultAmountCents: 0,
    maxAmountCents: 0,
    amountCents: 0,
    creditAction: "none",
    grantIds: [],
    voucherIds: [],
    cancelsBooking: false,
  };
  if (quantity < 1 || quantity > leftQuantity) return { plan: base, problem: "quantity_too_high" };

  let defaultCents: number;
  if (line.productKind === "package") {
    const grants = pickGrants(line.grants ?? [], quantity);
    const totalUnits = lineUnits(line) || line.quantity;
    const unusedUnits = grants.reduce((s, g) => s + (g.unitsGranted - g.usedUnits), 0);
    defaultCents = share(line.lineTotalCents, unusedUnits, totalUnits);
    base.grantIds = grants.map((g) => g.grantId);
    base.creditAction = "revoke";
  } else if (line.productKind === "membership") {
    const full = share(line.lineTotalCents, quantity, line.quantity);
    if (line.membershipPeriod) {
      const periodDays = daysBetween(line.membershipPeriod.startsAt, line.membershipPeriod.endsAt);
      const usedDays = Math.min(periodDays, daysBetween(line.membershipPeriod.startsAt, at));
      defaultCents = share(full, periodDays - usedDays, periodDays);
    } else defaultCents = full;
    base.creditAction = "revoke";
  } else if (line.productKind === "voucher") {
    const active = (line.vouchers ?? []).filter((v) => v.status === "active");
    if (active.length < quantity) return { plan: { ...base, quantity }, problem: "voucher_not_refundable" };
    base.voucherIds = active.slice(0, quantity).map((v) => v.voucherId);
    defaultCents = share(line.lineTotalCents, quantity, line.quantity);
  } else {
    defaultCents = share(line.lineTotalCents, quantity, line.quantity);
    base.cancelsBooking = (DATED_PRODUCT_KINDS as readonly ProductKind[]).includes(line.productKind);
  }

  defaultCents = Math.min(defaultCents, leftCents);
  base.defaultAmountCents = defaultCents;
  base.maxAmountCents = leftCents;
  if (line.amountCents !== undefined) {
    if (line.amountCents > leftCents) return { plan: { ...base, amountCents: line.amountCents }, problem: "line_amount_too_high" };
    base.amountCents = Math.max(0, line.amountCents);
  } else base.amountCents = defaultCents;
  return { plan: base };
}

/** Splits a refund over the payments: credit balance first, then provider payments, largest first (rule 38). */
export function allocateRefund(payments: RefundPaymentInput[], totalCents: number): RefundAllocation[] {
  const usable = payments
    .filter((p) => REFUNDABLE_PAYMENT_STATUSES.includes(p.status) && p.amountCents - p.refundedCents > 0)
    .sort((a, b) => {
      const ca = a.provider === "credit_balance" ? 0 : 1;
      const cb = b.provider === "credit_balance" ? 0 : 1;
      return ca - cb || b.amountCents - b.refundedCents - (a.amountCents - a.refundedCents) || a.paymentId.localeCompare(b.paymentId);
    });
  const out: RefundAllocation[] = [];
  let left = totalCents;
  for (const p of usable) {
    if (left <= 0) break;
    const amount = Math.min(left, p.amountCents - p.refundedCents);
    left -= amount;
    const after = p.refundedCents + amount;
    out.push({
      paymentId: p.paymentId,
      provider: p.provider,
      amountCents: amount,
      euroRestore: p.provider === "credit_balance" ? (p.refundedCents === 0 && after === p.amountCents ? "release" : "grant") : null,
      refundedCentsAfter: after,
      statusAfter: after === p.amountCents ? "refunded" : "partially_refunded",
    });
  }
  return out;
}

/** The refund plan of rules 36 to 38. */
export function refundPlan(input: RefundPlanInput): RefundPlan {
  const problems: RefundPlan["problems"] = [];
  const lines: RefundPlanLine[] = [];
  for (const line of input.lines) {
    const { plan, problem } = planLine(line, input.at);
    if (problem) problems.push({ code: problem, orderLineId: line.orderLineId });
    lines.push(plan);
  }
  const refundableCents = input.payments
    .filter((p) => REFUNDABLE_PAYMENT_STATUSES.includes(p.status))
    .reduce((s, p) => s + Math.max(0, p.amountCents - p.refundedCents), 0);
  const totalCents = lines.reduce((s, l) => s + l.amountCents, 0);
  if (problems.length === 0 && totalCents > refundableCents) problems.push({ code: "refund_too_high" });
  if (problems.length === 0 && totalCents <= 0) problems.push({ code: "nothing_to_refund" });
  const ok = problems.length === 0;
  return {
    ok,
    problems,
    lines,
    allocations: ok ? allocateRefund(input.payments, totalCents) : [],
    totalCents,
    refundableCents,
    creditAction: lines.some((l) => l.creditAction === "revoke") ? "revoke" : "none",
  };
}

// ---------------------------------------------------------------------------
// Withdrawal (rule 54)
// ---------------------------------------------------------------------------

export type WithdrawalLineInput = {
  orderLineId: string;
  productKind: ProductKind;
  quantity: number;
  lineTotalCents: number;
  refundedCents?: number;
  grants?: GrantUsage[];
  vouchers?: Array<{ voucherId: string; status: VoucherStatus }>;
  /** Membership lines: the period the line paid for. */
  membershipPeriod?: { startsAt: Date; endsAt: Date };
};

export type WithdrawalLinePlan = {
  orderLineId: string;
  /** `refund`: refunded at once; `task`: a membership, refunded by customer service; `refused`: not withdrawable. */
  outcome: "refund" | "task" | "refused";
  reason: "dated_service" | "not_covered" | "voucher_used" | "already_refunded" | "membership_needs_staff" | null;
  amountCents: number;
  grantIds: string[];
  voucherIds: string[];
};

export type WithdrawalPlan = {
  allowed: boolean;
  reason: "withdrawal_expired" | "nothing_to_withdraw" | null;
  deadlineAt: Date;
  lines: WithdrawalLinePlan[];
  /** Sum of the `refund` lines (the `task` lines are refunded by staff). */
  totalCents: number;
};

/** The 14-day withdrawal of an online order (rule 54). */
export function withdrawalPlan(input: { lines: WithdrawalLineInput[]; paidAt: Date; at: Date; withdrawalDays?: number }): WithdrawalPlan {
  const deadlineAt = new Date(input.paidAt.getTime() + (input.withdrawalDays ?? 14) * DAY_MS);
  if (input.at.getTime() > deadlineAt.getTime()) {
    return { allowed: false, reason: "withdrawal_expired", deadlineAt, lines: [], totalCents: 0 };
  }
  const lines = input.lines.map((line): WithdrawalLinePlan => {
    const out: WithdrawalLinePlan = { orderLineId: line.orderLineId, outcome: "refused", reason: null, amountCents: 0, grantIds: [], voucherIds: [] };
    const leftCents = Math.max(0, line.lineTotalCents - (line.refundedCents ?? 0));
    if ((DATED_PRODUCT_KINDS as readonly ProductKind[]).includes(line.productKind)) return { ...out, reason: "dated_service" };
    if (line.productKind === "package") {
      const grants = (line.grants ?? []).filter((g) => g.unitsGranted - g.usedUnits > 0);
      const totalUnits = lineUnits(line);
      const unused = grants.reduce((s, g) => s + g.unitsGranted - g.usedUnits, 0);
      const amount = Math.min(leftCents, share(line.lineTotalCents, unused, totalUnits));
      if (amount <= 0) return { ...out, reason: "already_refunded" };
      return { ...out, outcome: "refund", amountCents: amount, grantIds: grants.map((g) => g.grantId) };
    }
    if (line.productKind === "voucher") {
      const vouchers = line.vouchers ?? [];
      if (vouchers.length === 0 || vouchers.some((v) => v.status !== "active")) return { ...out, reason: "voucher_used" };
      if (leftCents <= 0) return { ...out, reason: "already_refunded" };
      return { ...out, outcome: "refund", amountCents: leftCents, voucherIds: vouchers.map((v) => v.voucherId) };
    }
    if (line.productKind === "membership") {
      let amount = leftCents;
      if (line.membershipPeriod) {
        const periodDays = daysBetween(line.membershipPeriod.startsAt, line.membershipPeriod.endsAt);
        const elapsed = Math.min(periodDays, daysBetween(line.membershipPeriod.startsAt, input.at));
        amount = Math.min(leftCents, share(line.lineTotalCents, periodDays - elapsed, periodDays));
      }
      return { ...out, outcome: "task", reason: "membership_needs_staff", amountCents: amount };
    }
    return { ...out, reason: "not_covered" };
  });
  const totalCents = lines.filter((l) => l.outcome === "refund").reduce((s, l) => s + l.amountCents, 0);
  const anything = lines.some((l) => l.outcome !== "refused");
  return { allowed: anything, reason: anything ? null : "nothing_to_withdraw", deadlineAt, lines, totalCents };
}
