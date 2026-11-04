/**
 * Inactivity threshold events (ops rules 15-18). Pure: the nightly stats run calls
 * `inactivityEventsFor` per person with the anchor (the later of `last_visit_at` and
 * `last_purchase_at`) and today's Brussels date; it emits `person.inactive_days` when a
 * threshold date falls inside the last 3 days, so a missed night is caught up and the cut-over
 * import never causes a burst of old thresholds.
 */
import { localDateKey, wallClock } from "../platform/cron";

export const INACTIVITY_THRESHOLDS = [30, 60, 90, 180] as const;
export type InactivityThreshold = (typeof INACTIVITY_THRESHOLDS)[number];

/** Days of the catch-up window: today and the two days before (rule 16). */
export const INACTIVITY_WINDOW_DAYS = 3;

const DAY_MS = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Day number of a `YYYY-MM-DD` date (days since 1970-01-01, calendar arithmetic). */
function dayNumber(isoDate: string): number {
  if (!ISO_DATE.test(isoDate)) throw new RangeError(`not a YYYY-MM-DD date: ${isoDate}`);
  const [y, m, d] = isoDate.split("-").map(Number) as [number, number, number];
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

/** The Brussels calendar date of an instant. */
export function brusselsDate(at: Date): string {
  return localDateKey(wallClock(at));
}

/**
 * The single threshold to emit today for this anchor, or null. `today` is the Brussels date
 * `YYYY-MM-DD`. `lastEmitted` is the highest threshold already emitted for the same anchor
 * (a new anchor re-arms every threshold, rule 16); a threshold at or below it is not emitted
 * again. When two thresholds fall in the window only the highest is returned (rule 17).
 * A person without a visit or a purchase (a lead) has no anchor and never gets an event.
 */
export function inactivityEventsFor(input: { anchorAt: Date | null; today: string; lastEmitted?: number }): { days: InactivityThreshold } | null {
  if (!input.anchorAt) return null;
  const hit = highestThresholdInWindow(brusselsDate(input.anchorAt), input.today, INACTIVITY_THRESHOLDS);
  if (hit === null) return null;
  if (input.lastEmitted !== undefined && hit <= input.lastEmitted) return null;
  return { days: hit };
}

/**
 * The highest threshold whose date (`anchorDate + days`) falls inside the window that ends on
 * `today` (rules 16 and 17), or null. Dates are `YYYY-MM-DD`.
 */
export function highestThresholdInWindow<T extends number>(anchorDate: string, today: string, thresholds: readonly T[]): T | null {
  const anchorDay = dayNumber(anchorDate);
  const todayDay = dayNumber(today);
  let hit: T | null = null;
  for (const days of thresholds) {
    const due = anchorDay + days;
    if (due <= todayDay && due > todayDay - INACTIVITY_WINDOW_DAYS && (hit === null || days > hit)) hit = days;
  }
  return hit;
}

/** Rule 16: `person:<id>:inactive:<days>:<anchor date>`. */
export function inactivityDedupeKey(personId: string, days: InactivityThreshold, anchorAt: Date): string {
  return `person:${personId}:inactive:${days}:${brusselsDate(anchorAt)}`;
}
