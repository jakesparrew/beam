/**
 * Churn and repurchase indicators and predicted value (ops rule 76, R4): transparent formulas,
 * not machine learning and not Claude ("rules before AI", decision 45). Pure; the nightly stats
 * run (`apps/web/modules/ops/stats/compute.ts`) feeds it while the `behavioural_scoring` DPIA is
 * approved and writes the result into `person_stats`.
 *
 * - mean interval = (last visit - first visit) / (visits - 1) when visits >= 2, else the
 *   population median of that interval (default 30 days);
 * - `r = days_since_activity / max(14, mean interval)`;
 * - `churn = clamp(1 - exp(-0.35 * max(0, r - 1)), 0, 0.99)`, halved for active members, and
 *   0.05 with a future booking (the booking wins over the member halving);
 * - `repurchase = clamp((1 - churn) * min(1, purchases / 3) + 0.1 * (active grant with
 *   remaining <= 2), 0, 0.99)`;
 * - `predicted_value_cents = round(avg_order_cents * purchases / max(0.25, tenure_years) * (1 - churn))`.
 *
 * Probabilities are rounded to three decimals, the precision of `person_stats` (numeric(4,3)),
 * so what this returns is what the row stores; the value uses the rounded churn.
 */

/** The population median used when a person has fewer than two visits and no population exists. */
export const DEFAULT_MEDIAN_INTERVAL_DAYS = 30;
/** The floor of the mean interval in `r` (two weeks). */
export const MIN_INTERVAL_DAYS = 14;
export const CHURN_DECAY = 0.35;
export const CHURN_MAX = 0.99;
export const CHURN_WITH_FUTURE_BOOKING = 0.05;
export const LOW_GRANT_REMAINING = 2;
export const MIN_TENURE_YEARS = 0.25;

const DAY_MS = 86_400_000;
const YEAR_DAYS = 365.25;

export type PredictInput = {
  /** Attended visits (rule 3), imported history included. */
  visits: number;
  firstVisitAt: Date | null;
  lastVisitAt: Date | null;
  /** Whole days since `last_activity_at` (0 when active today). */
  daysSinceActivity: number;
  purchases: number;
  avgOrderCents: number;
  /** Years since the first purchase or visit (the earliest); the formula floors it at 0.25. */
  tenureYears: number;
  /** `v_person_status.status = 'member'`. */
  isActiveMember: boolean;
  hasFutureBooking: boolean;
  /** An active credit grant with 2 or fewer units remaining. */
  hasLowActiveGrant: boolean;
  /** The population median of the mean visit interval in days (default 30). */
  medianIntervalDays?: number | null;
};

export type Indicators = { churn: number; repurchase: number; predictedValueCents: number };

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const round3 = (v: number): number => Math.round(v * 1000) / 1000;

/** The mean days between visits, or null with fewer than two visits. */
export function meanVisitIntervalDays(input: Pick<PredictInput, "visits" | "firstVisitAt" | "lastVisitAt">): number | null {
  if (input.visits < 2 || !input.firstVisitAt || !input.lastVisitAt) return null;
  return Math.max(0, input.lastVisitAt.getTime() - input.firstVisitAt.getTime()) / DAY_MS / (input.visits - 1);
}

/** The median of a list (null when empty). */
export function median(values: readonly number[]): number | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 === 1 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
}

/** Years between two instants (365.25-day years). */
export function tenureYears(since: Date | null, now: Date): number {
  if (!since) return 0;
  return Math.max(0, now.getTime() - since.getTime()) / DAY_MS / YEAR_DAYS;
}

/** Rule 76 for one person. */
export function predictIndicators(input: PredictInput): Indicators {
  const fallback = input.medianIntervalDays && input.medianIntervalDays > 0 ? input.medianIntervalDays : DEFAULT_MEDIAN_INTERVAL_DAYS;
  const interval = meanVisitIntervalDays(input) ?? fallback;
  const r = Math.max(0, input.daysSinceActivity) / Math.max(MIN_INTERVAL_DAYS, interval);
  let churn = clamp(1 - Math.exp(-CHURN_DECAY * Math.max(0, r - 1)), 0, CHURN_MAX);
  if (input.isActiveMember) churn = churn / 2;
  if (input.hasFutureBooking) churn = CHURN_WITH_FUTURE_BOOKING;
  churn = round3(churn);

  const purchases = Math.max(0, input.purchases);
  const repurchase = round3(clamp((1 - churn) * Math.min(1, purchases / 3) + 0.1 * (input.hasLowActiveGrant ? 1 : 0), 0, CHURN_MAX));
  const value = (Math.max(0, input.avgOrderCents) * purchases) / Math.max(MIN_TENURE_YEARS, input.tenureYears) * (1 - churn);
  return { churn, repurchase, predictedValueCents: Math.round(value) };
}
