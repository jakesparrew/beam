/**
 * Retention candidate scores (ops spec 2.4, `v_retention_candidates`). The view computes the
 * same formula in SQL; this pure version is the reference the tests and the weekly list share:
 * `score = base + least(30, revenue_cents / 20000) + urgency` (integer division, as in SQL).
 */

/** The eight rule blocks of `v_retention_candidates`, in the spec's order. */
export const RETENTION_REASONS = [
  "visiting_less",
  "package_nearly_finished",
  "package_finished_no_repurchase",
  "package_expiring",
  "high_value_inactive",
  "membership_renewal_due",
  "purchased_never_booked",
  "unused_sessions",
] as const;
export type RetentionReasonKey = (typeof RETENTION_REASONS)[number];
/** The eight reason keys; narrows the open `RetentionReason` of `types.ts` (re-exported by `index.ts`). */
export type RetentionReason = RetentionReasonKey;

export const RETENTION_BASE_SCORES: Readonly<Record<RetentionReasonKey, number>> = {
  visiting_less: 30,
  package_nearly_finished: 35,
  package_finished_no_repurchase: 40,
  package_expiring: 45,
  high_value_inactive: 50,
  membership_renewal_due: 40,
  purchased_never_booked: 30,
  unused_sessions: 25,
};

/** What a candidate row is about (`ref_type`). */
export const RETENTION_REF_TYPES: Readonly<Record<RetentionReasonKey, "person" | "grant" | "membership">> = {
  visiting_less: "person",
  package_nearly_finished: "grant",
  package_finished_no_repurchase: "grant",
  package_expiring: "grant",
  high_value_inactive: "person",
  membership_renewal_due: "membership",
  purchased_never_booked: "grant",
  unused_sessions: "grant",
};

/** Dismiss reasons of a weekly list item (rule 22). */
export const RETENTION_DISMISS_REASONS = ["not_relevant", "already_contacted", "do_not_contact", "other"] as const;
export type RetentionDismissReason = (typeof RETENTION_DISMISS_REASONS)[number];

export type ScoreInput = {
  revenueCents: number;
  /** `package_expiring`: days until `expires_at`; `membership_renewal_due`: days until the period end. */
  daysUntil?: number | null;
  /** `membership_renewal_due`: `memberships.cancel_at` is set (+10). */
  cancelAtSet?: boolean;
  /** `visiting_less`, `high_value_inactive`, `unused_sessions`. */
  daysSinceActivity?: number | null;
};

/** SQL integer division truncates toward zero. */
const idiv = (a: number, b: number) => Math.trunc(a / b);

/** The urgency term per reason. */
export function retentionUrgency(reason: RetentionReasonKey, input: ScoreInput): number {
  switch (reason) {
    case "package_expiring":
      return Math.max(0, 20 - Math.trunc(input.daysUntil ?? 20));
    case "membership_renewal_due":
      return Math.max(0, 20 - Math.trunc(input.daysUntil ?? 20)) + (input.cancelAtSet ? 10 : 0);
    case "visiting_less":
    case "high_value_inactive":
    case "unused_sessions":
      return Math.min(20, idiv(Math.max(0, Math.trunc(input.daysSinceActivity ?? 0)), 10));
    default:
      return 0;
  }
}

/** `base + least(30, revenue_cents / 20000) + urgency`. */
export function retentionScore(reason: RetentionReason, input: ScoreInput): number {
  const value = Math.min(30, idiv(Math.max(0, Math.trunc(input.revenueCents)), 20000));
  return RETENTION_BASE_SCORES[reason] + value + retentionUrgency(reason, input);
}

/** Rule 21: a retention task is high priority at a score of 80 or more. */
export const HIGH_PRIORITY_SCORE = 80;
