/**
 * The grant and membership status machines of credits spec section 2, as data, plus the
 * guards every write path calls before it changes a status. Pure: no I/O.
 */

export type GrantStatus = "active" | "exhausted" | "expired" | "revoked";
export type MembershipStatus = "pending" | "active" | "past_due" | "cancelled" | "expired";
export type MembershipEndReason =
  | "cancelled_by_customer"
  | "cancelled_by_staff"
  | "refunded"
  | "payment_failed"
  | "not_renewed"
  | "merged"
  | "erased";

export const GRANT_STATUSES = ["active", "exhausted", "expired", "revoked"] as const satisfies readonly GrantStatus[];
export const MEMBERSHIP_STATUSES = ["pending", "active", "past_due", "cancelled", "expired"] as const satisfies readonly MembershipStatus[];

/**
 * A forbidden state transition (`conflict`). `action()` maps errors by `code`, so this core
 * error becomes the action error code `conflict` like the web layer's own `ConflictError`.
 */
export class ConflictError extends Error {
  override readonly name: string = "ConflictError";
  readonly code = "conflict" as const;
  constructor(message = "conflict") {
    super(message);
  }
}

/** `new` is a row being inserted. */
export type GrantTransitionFrom = GrantStatus | "new";

export type GrantTransition = { from: GrantTransitionFrom; to: GrantStatus; trigger: string; entry: string };

/** Credits spec section 2, "Grant status machine", one row per (from, to) pair. */
export const GRANT_TRANSITIONS: readonly GrantTransition[] = [
  { from: "new", to: "active", trigger: "grantCredits, transferCredits, activateMembership/renewal, import", entry: "grant or transfer_in" },
  { from: "active", to: "exhausted", trigger: "consume, negative adjust or transfer_out brings remaining_units to 0", entry: "that entry" },
  { from: "exhausted", to: "active", trigger: "release or positive adjust makes the balance positive before expires_at", entry: "that entry" },
  { from: "active", to: "expired", trigger: "credits.expire_grant at expires_at", entry: "expire or none" },
  { from: "exhausted", to: "expired", trigger: "release after expires_at (rule 26)", entry: "release + expire" },
  { from: "expired", to: "active", trigger: "extendGrant within 365 days of the expiry entry (rule 32)", entry: "extend + adjust" },
  { from: "active", to: "revoked", trigger: "revokeGrant, revokeGrantRemainder (refund), erasure", entry: "revoke" },
  { from: "exhausted", to: "revoked", trigger: "erasure only", entry: "none" },
  { from: "expired", to: "revoked", trigger: "erasure only", entry: "none" },
] as const;

/** `new` is a row being inserted by `activateMembership`; `imported` one inserted by `importMembership`. */
export type MembershipTransitionFrom = MembershipStatus | "new" | "imported";

export type MembershipTransition = {
  from: MembershipTransitionFrom;
  to: MembershipStatus;
  trigger: string;
  endReasons: readonly MembershipEndReason[];
};

/** Credits spec section 2, "Membership status machine", one row per (from, to) pair. */
export const MEMBERSHIP_TRANSITIONS: readonly MembershipTransition[] = [
  { from: "new", to: "active", trigger: "activateMembership with startsAt <= now", endReasons: [] },
  { from: "new", to: "pending", trigger: "activateMembership with a future startsAt", endReasons: [] },
  { from: "pending", to: "active", trigger: "memberships.scan_renewals on the start date", endReasons: [] },
  {
    from: "pending",
    to: "cancelled",
    trigger: "cancel before the start, cancelMembershipForRefund, merge loser of two pending memberships",
    endReasons: ["cancelled_by_customer", "cancelled_by_staff", "refunded", "merged"],
  },
  { from: "active", to: "past_due", trigger: "applyRenewalFailure or link renewal unpaid at period end", endReasons: [] },
  { from: "past_due", to: "active", trigger: "applyRenewalPayment", endReasons: [] },
  {
    from: "active",
    to: "cancelled",
    trigger: "scan at cancel_at, cancelMembership mode now, cancelMembershipForRefund",
    endReasons: ["cancelled_by_customer", "cancelled_by_staff", "refunded"],
  },
  {
    from: "past_due",
    to: "cancelled",
    trigger: "scan at cancel_at, cancelMembership mode now, customer cancel while past_due, cancelMembershipForRefund",
    endReasons: ["cancelled_by_customer", "cancelled_by_staff", "refunded"],
  },
  { from: "past_due", to: "expired", trigger: "scan on day 10 after the first failure", endReasons: ["payment_failed", "not_renewed", "erased"] },
  { from: "active", to: "expired", trigger: "erasure", endReasons: ["erased"] },
  { from: "pending", to: "expired", trigger: "erasure", endReasons: ["erased"] },
  { from: "expired", to: "active", trigger: "late payment of the cancelled renewal order (edge case 9)", endReasons: [] },
  { from: "imported", to: "active", trigger: "importMembership", endReasons: [] },
  { from: "imported", to: "cancelled", trigger: "importMembership", endReasons: ["not_renewed"] },
  { from: "imported", to: "expired", trigger: "importMembership", endReasons: ["not_renewed"] },
] as const;

/** `end_reason` values of an `expired` membership that a late payment may reactivate (edge case 9). */
export const REACTIVATABLE_END_REASONS = ["payment_failed", "not_renewed"] as const satisfies readonly MembershipEndReason[];

export function isGrantTransitionAllowed(from: GrantTransitionFrom, to: GrantStatus): boolean {
  return GRANT_TRANSITIONS.some((t) => t.from === from && t.to === to);
}

export function isMembershipTransitionAllowed(from: MembershipTransitionFrom, to: MembershipStatus): boolean {
  return MEMBERSHIP_TRANSITIONS.some((t) => t.from === from && t.to === to);
}

/** Throws `ConflictError('invalid_transition: grant <from> -> <to>')` unless the pair is in `GRANT_TRANSITIONS`. */
export function assertGrantTransition(from: GrantTransitionFrom, to: GrantStatus): void {
  if (!isGrantTransitionAllowed(from, to)) throw new ConflictError(`invalid_transition: grant ${from} -> ${to}`);
}

/**
 * Throws `ConflictError('invalid_transition: membership <from> -> <to>')` unless the pair is in
 * `MEMBERSHIP_TRANSITIONS`. With `opts.endReason`, also checks it: an ending transition needs one
 * of the row's `end_reason` values, a non-ending one takes none, and `expired -> active` (late
 * payment) is only allowed from `payment_failed` or `not_renewed`.
 */
export function assertMembershipTransition(
  from: MembershipTransitionFrom,
  to: MembershipStatus,
  opts: { endReason?: MembershipEndReason | null } = {},
): void {
  const row = MEMBERSHIP_TRANSITIONS.find((t) => t.from === from && t.to === to);
  if (!row) throw new ConflictError(`invalid_transition: membership ${from} -> ${to}`);
  const reason = opts.endReason;
  if (reason === undefined || reason === null) return;
  if (from === "expired" && to === "active") {
    if (!(REACTIVATABLE_END_REASONS as readonly string[]).includes(reason)) {
      throw new ConflictError(`invalid_transition: membership expired (${reason}) -> active`);
    }
    return;
  }
  if (!row.endReasons.includes(reason)) {
    throw new ConflictError(`invalid_end_reason: membership ${from} -> ${to} with ${reason}`);
  }
}
