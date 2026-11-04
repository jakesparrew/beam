/**
 * The state machines of commerce spec section 3.1 as pure transition maps. Server code changes
 * a status only through these functions, inside a transaction holding `SELECT ... FOR UPDATE`
 * on the row. Every pair that is not listed returns null (`conflict: invalid_transition`, or for
 * payments "ignore the report", rule 28). A same-state pair is never a transition.
 */
import type { OrderStatus } from "./types";
import type {
  CheckoutStatus,
  MandateStatus,
  PaymentStatus,
  PosDayStatus,
  RedemptionStatus,
  RefundStatus,
  StatusSource,
  VoucherStatus,
} from "./schemas";

export type TransitionMap<S extends string> = Readonly<Record<S, readonly S[]>>;

export const ORDER_TRANSITIONS: TransitionMap<OrderStatus> = {
  draft: ["pending_payment", "cancelled"],
  pending_payment: ["paid", "expired", "cancelled"],
  expired: ["paid"],
  paid: ["partially_refunded", "refunded"],
  partially_refunded: ["refunded"],
  cancelled: [],
  refunded: [],
};

/**
 * Payment transitions as reported by any source. `expired` -> `paid` is not in the map: it is
 * the one exception of rule 28 and allowed only when the payment was expired by a
 * `local_timeout` and the provider now reports `paid`.
 */
export const PAYMENT_TRANSITIONS: TransitionMap<PaymentStatus> = {
  open: ["pending", "authorized", "paid", "failed", "expired", "cancelled"],
  pending: ["authorized", "paid", "failed", "expired", "cancelled"],
  authorized: ["paid", "failed", "expired", "cancelled"],
  paid: ["partially_refunded", "refunded"],
  partially_refunded: ["refunded"],
  expired: [],
  failed: [],
  cancelled: [],
  refunded: [],
};

/** What a local (non-provider) source may set: a timeout only expires or cancels. */
const LOCAL_TIMEOUT_TARGETS: readonly PaymentStatus[] = ["expired", "cancelled"];

export const REFUND_TRANSITIONS: TransitionMap<RefundStatus> = {
  pending: ["sent", "refunded", "failed"],
  sent: ["refunded", "failed"],
  failed: ["pending"],
  refunded: [],
};

export const VOUCHER_TRANSITIONS: TransitionMap<VoucherStatus> = {
  pending: ["active", "void"],
  active: ["redeemed", "expired", "void"],
  redeemed: [],
  expired: [],
  void: [],
};

export const CHECKOUT_TRANSITIONS: TransitionMap<CheckoutStatus> = {
  started: ["abandoned", "completed", "expired"],
  abandoned: ["completed", "expired"],
  completed: [],
  expired: [],
};

export const REDEMPTION_TRANSITIONS: TransitionMap<RedemptionStatus> = {
  reserved: ["confirmed", "released"],
  released: ["confirmed"],
  confirmed: [],
};

export const MANDATE_TRANSITIONS: TransitionMap<MandateStatus> = {
  pending: ["valid", "invalid"],
  valid: ["invalid", "revoked"],
  invalid: [],
  revoked: [],
};

export const POS_DAY_TRANSITIONS: TransitionMap<PosDayStatus> = {
  open: ["closed"],
  closed: ["open"],
};

/** The state each machine's rows start in. */
export const INITIAL_STATES = {
  orders: ["draft", "pending_payment"] as readonly OrderStatus[],
  payments: ["open"] as readonly PaymentStatus[],
  refunds: ["pending"] as readonly RefundStatus[],
  vouchers: ["pending"] as readonly VoucherStatus[],
  checkouts: ["started"] as readonly CheckoutStatus[],
  promotion_redemptions: ["reserved"] as readonly RedemptionStatus[],
  mandates: ["pending"] as readonly MandateStatus[],
  pos_day_closes: ["open"] as readonly PosDayStatus[],
} as const;

function step<S extends string>(map: TransitionMap<S>, current: S, to: S): S | null {
  return map[current]?.includes(to) ? to : null;
}

export function nextOrderStatus(current: OrderStatus, to: OrderStatus): OrderStatus | null {
  return step(ORDER_TRANSITIONS, current, to);
}

/**
 * Forward-only payment status (rule 28). `source` is where the report comes from;
 * `currentSource` is the source that set the current status (the last `status_history` entry),
 * needed only for the `local_timeout` exception: an `expired` set by a local timeout may still
 * become `paid` when the provider reports it. Returns null when the report is to be ignored.
 */
export function nextPaymentStatus(
  current: PaymentStatus,
  reported: PaymentStatus,
  source: StatusSource,
  currentSource: StatusSource = "provider",
): PaymentStatus | null {
  if (current === "expired" && reported === "paid") {
    return currentSource === "local_timeout" && source === "provider" ? "paid" : null;
  }
  if (source === "local_timeout" && !LOCAL_TIMEOUT_TARGETS.includes(reported)) return null;
  return step(PAYMENT_TRANSITIONS, current, reported);
}

export function nextRefundStatus(current: RefundStatus, to: RefundStatus): RefundStatus | null {
  return step(REFUND_TRANSITIONS, current, to);
}

export function nextVoucherStatus(current: VoucherStatus, to: VoucherStatus): VoucherStatus | null {
  return step(VOUCHER_TRANSITIONS, current, to);
}

export function nextCheckoutStatus(current: CheckoutStatus, to: CheckoutStatus): CheckoutStatus | null {
  return step(CHECKOUT_TRANSITIONS, current, to);
}

export function nextRedemptionStatus(current: RedemptionStatus, to: RedemptionStatus): RedemptionStatus | null {
  return step(REDEMPTION_TRANSITIONS, current, to);
}

export function nextMandateStatus(current: MandateStatus, to: MandateStatus): MandateStatus | null {
  return step(MANDATE_TRANSITIONS, current, to);
}

export function nextPosDayStatus(current: PosDayStatus, to: PosDayStatus): PosDayStatus | null {
  return step(POS_DAY_TRANSITIONS, current, to);
}

/** States with no outgoing transition. */
export function finalStates<S extends string>(map: TransitionMap<S>): S[] {
  return (Object.keys(map) as S[]).filter((s) => map[s].length === 0);
}
