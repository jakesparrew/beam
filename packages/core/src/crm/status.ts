/**
 * Commercial status (crm rules 3.8 to 3.12, cross-module D28). The derived status comes from
 * credits' `v_person_status`; these functions are the pure statement of the same rule, used by
 * crm's api and pinned by tests (and by the fixture view of crm's database tests).
 */
import type { PersonStatus } from "./types";

/** Product kinds whose paid order makes a customer (rule 3.8); `item` and `voucher` never do. */
export const QUALIFYING_PRODUCT_KINDS = ["session", "night", "package", "membership", "ticket"] as const;
/** Order statuses that count as paid (a later refund does not undo the customer status). */
export const PAID_ORDER_STATUSES = ["paid", "partially_refunded", "refunded"] as const;
/** Membership statuses that make a member, once the membership has started. */
export const MEMBER_STATUSES = ["active", "past_due"] as const;

/** True for a paid order above 0 cents with at least one qualifying line (rule 3.8). */
export function isQualifyingOrder(order: { totalCents: number; status: string; lineKinds: readonly string[] }): boolean {
  return (
    order.totalCents > 0 &&
    (PAID_ORDER_STATUSES as readonly string[]).includes(order.status) &&
    order.lineKinds.some((k) => (QUALIFYING_PRODUCT_KINDS as readonly string[]).includes(k))
  );
}

/** True for a credit grant that makes a customer: source `purchase` or `import`, kind `day` or `night`. */
export function isQualifyingGrant(grant: { source: string; creditKind: string }): boolean {
  return (grant.source === "purchase" || grant.source === "import") && (grant.creditKind === "day" || grant.creditKind === "night");
}

/** True for a membership that makes a member now: `active` or `past_due` and started. */
export function isMemberMembership(m: { status: string; startsAt: Date | null }, now: Date): boolean {
  return (MEMBER_STATUSES as readonly string[]).includes(m.status) && !!m.startsAt && m.startsAt.getTime() <= now.getTime();
}

/**
 * `status = coalesce(override, derived)` (rule 3.9). `hasPaidQualifyingOrder` covers both the
 * qualifying order and the qualifying grant of rule 3.8. The override never changes the
 * derived status, and member pricing reads `hasActiveMembership`, never the override (3.12).
 */
export function resolveStatus(input: {
  override: PersonStatus | null | undefined;
  hasActiveMembership: boolean;
  hasPaidQualifyingOrder: boolean;
}): { status: PersonStatus; derivedStatus: PersonStatus } {
  const derivedStatus: PersonStatus = input.hasActiveMembership ? "member" : input.hasPaidQualifyingOrder ? "customer" : "lead";
  return { status: input.override ?? derivedStatus, derivedStatus };
}

/** Rule 3.9: an override reason has 3 to 500 characters after trimming. */
export function isValidOverrideReason(reason: string | null | undefined): boolean {
  const n = (reason ?? "").trim().length;
  return n >= 3 && n <= 500;
}

/** Rule 3.10: an automation step (`onlyIfUnset`) applies an override only when none exists. */
export function mayApplyOverride(existing: PersonStatus | null | undefined, onlyIfUnset: boolean): boolean {
  return !onlyIfUnset || existing === null || existing === undefined;
}

/** Rule 3.11: the person belongs in `v_status_override_conflicts`. */
export function overrideConflicts(override: PersonStatus | null | undefined, derivedStatus: PersonStatus): boolean {
  return !!override && override !== derivedStatus;
}

/** Rule 3.12: member pricing and member-only booking use the membership, never the override. */
export function isMemberForPricing(input: { hasActiveMembership: boolean; override?: PersonStatus | null }): boolean {
  return input.hasActiveMembership;
}
