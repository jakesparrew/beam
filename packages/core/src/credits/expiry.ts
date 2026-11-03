/**
 * Expiry dates of grants (credits rules 1, 30 and edge cases 14, 23): end of day in
 * Europe/Brussels, computed with the zone so a DST change never moves the date. Pure.
 */
import { BRUSSELS, localDateKey, wallClock, zonedTimeToUtc } from "../platform/cron";

export type BrusselsDate = { year: number; month: number; day: number };

/** The calendar date of an instant in `tz` (default Europe/Brussels). */
export function brusselsDateOf(instant: Date, tz: string = BRUSSELS): BrusselsDate {
  const w = wallClock(instant, tz);
  return { year: w.year, month: w.month, day: w.day };
}

/** `YYYY-MM-DD` of an instant in Brussels: the date part of keys such as `expire:<grant_id>:<expires_at date>`. */
export function brusselsDateKey(instant: Date, tz: string = BRUSSELS): string {
  return localDateKey(brusselsDateOf(instant, tz));
}

/** A calendar date plus `days` (negative allowed), normalised across month and year ends. */
export function addCalendarDays(date: BrusselsDate, days: number): BrusselsDate {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** Whole calendar days from `a` to `b` (positive when `b` is later). */
export function calendarDaysBetween(a: BrusselsDate, b: BrusselsDate): number {
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000);
}

/** 00:00 of a calendar date in `tz` (midnight never falls in a Brussels DST gap). */
export function startOfDayIn(date: BrusselsDate, tz: string = BRUSSELS): Date {
  return zonedTimeToUtc({ ...date, hour: 0, minute: 0 }, tz);
}

/** 23:59:59.999 of a calendar date in `tz`: one millisecond before the next local midnight. */
export function endOfDayIn(date: BrusselsDate, tz: string = BRUSSELS): Date {
  return new Date(startOfDayIn(addCalendarDays(date, 1), tz).getTime() - 1);
}

/**
 * The expiry of a grant valid `validityDays` from `from`: 23:59:59.999 Europe/Brussels on the
 * Brussels date of `from` plus `validityDays` (a 30-day package bought 20 October expires at the
 * end of 19 November). `null` validity means the grant never expires. Commerce calls this for a
 * package line's `expiresAt` (cross-module D24).
 */
export function computeExpiresAt(from: Date, validityDays: number | null, tz: "Europe/Brussels" = BRUSSELS): Date | null {
  if (validityDays === null) return null;
  if (!Number.isInteger(validityDays) || validityDays < 0) throw new RangeError(`invalid validityDays ${validityDays}`);
  if (Number.isNaN(from.getTime())) throw new RangeError("invalid from date");
  return endOfDayIn(addCalendarDays(brusselsDateOf(from, tz), validityDays), tz);
}

/** Alias of `computeExpiresAt` (the name the package plan lists for commerce's call). */
export const expiresAt = computeExpiresAt;

/**
 * The expiry-warning windows (`settings.credits.expiry_warning_days`, default [30, 7]) that are due
 * for a grant at `now`: a window `d` is due when the grant expires in `d ± 1` Brussels calendar
 * days (edge case 23: a missed nightly run still emits each warning once; the dedupe key
 * `grant:<id>:expiry:<days>:<expires_at date>` keeps it to one). A grant already expired at `now`
 * gets none. Returned in the order of `days`, without duplicates.
 */
export function expiryWarningsDue(expiresAt: Date, now: Date, days: number[]): number[] {
  if (expiresAt.getTime() <= now.getTime()) return [];
  const left = calendarDaysBetween(brusselsDateOf(now), brusselsDateOf(expiresAt));
  const due: number[] = [];
  for (const d of days) {
    if (!Number.isInteger(d) || d < 0 || due.includes(d)) continue;
    if (Math.abs(left - d) <= 1) due.push(d);
  }
  return due;
}

/** `grant:<id>:expiry:<days>:<expires_at YYYY-MM-DD>`, the dedupe key of `credits.expiry_approaching` (rule 30). */
export function expiryWarningDedupeKey(grantId: string, days: number, expiresAt: Date): string {
  return `grant:${grantId}:expiry:${days}:${brusselsDateKey(expiresAt)}`;
}

/** `expire:<grant_id>:<expires_at YYYY-MM-DD>`, the idempotency key of an expiry (decision 8). */
export function expireEntryKey(grantId: string, expiresAt: Date): string {
  return `expire:${grantId}:${brusselsDateKey(expiresAt)}`;
}
