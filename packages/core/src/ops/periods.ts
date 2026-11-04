/**
 * Report periods in Brussels time (ops rule 34). Every range is half open, `[from, to)`, with
 * both ends at a Brussels midnight, so DST weekends have 23 or 25 hours and never shift a day.
 *
 * - `day`: the Brussels day of `at`, against the previous day.
 * - `week`: the ISO week (Monday to Sunday) of `at`, against the previous week.
 * - `month`: month to date (the 1st up to and including the day of `at`), against the same
 *   number of days of the previous month, cut at that month's end (31 March compares with the
 *   whole of February).
 * - `ytd`: 1 January up to and including the day of `at`, against the same span of the
 *   previous year (29 February maps to 28 February).
 * - `last_30d`, `last_90d` (custom dashboards, R4): the last N days including today, against
 *   the N days before.
 */
import { wallClock, zonedTimeToUtc } from "../platform/cron";

export const PERIODS = ["day", "week", "month", "ytd", "last_30d", "last_90d"] as const;
export type Period = (typeof PERIODS)[number];

export type PeriodRange = { from: Date; to: Date; prevFrom: Date; prevTo: Date };

type YMD = { year: number; month: number; day: number };

/** Calendar arithmetic on a date without a zone. */
function addDays(d: YMD, days: number): YMD {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day + days));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** The instant of Brussels midnight at the start of `d`. */
export function brusselsMidnight(d: YMD): Date {
  return zonedTimeToUtc({ year: d.year, month: d.month, day: d.day, hour: 0, minute: 0 });
}

/** Number of calendar days from `a` to `b`. */
function diffDays(a: YMD, b: YMD): number {
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000);
}

export function periodRange(period: Period, at: Date): PeriodRange {
  const w = wallClock(at);
  const today: YMD = { year: w.year, month: w.month, day: w.day };
  const tomorrow = addDays(today, 1);
  let from: YMD;
  let to: YMD;
  let prevFrom: YMD;
  let prevTo: YMD;
  switch (period) {
    case "day":
      from = today;
      to = tomorrow;
      prevFrom = addDays(today, -1);
      prevTo = today;
      break;
    case "week": {
      // wallClock weekday: 0 = Sunday ... 6 = Saturday; ISO Monday start.
      const sinceMonday = (w.weekday + 6) % 7;
      from = addDays(today, -sinceMonday);
      to = addDays(from, 7);
      prevFrom = addDays(from, -7);
      prevTo = from;
      break;
    }
    case "month": {
      from = { year: today.year, month: today.month, day: 1 };
      to = tomorrow;
      const pm = today.month === 1 ? { year: today.year - 1, month: 12 } : { year: today.year, month: today.month - 1 };
      prevFrom = { ...pm, day: 1 };
      const span = diffDays(from, to);
      const cap = daysInMonth(pm.year, pm.month);
      prevTo = span >= cap ? addDays({ ...pm, day: cap }, 1) : addDays(prevFrom, span);
      break;
    }
    case "ytd": {
      from = { year: today.year, month: 1, day: 1 };
      to = tomorrow;
      prevFrom = { year: today.year - 1, month: 1, day: 1 };
      const lastDay = Math.min(today.day, daysInMonth(today.year - 1, today.month));
      prevTo = addDays({ year: today.year - 1, month: today.month, day: lastDay }, 1);
      break;
    }
    case "last_30d":
    case "last_90d": {
      const n = period === "last_30d" ? 30 : 90;
      from = addDays(tomorrow, -n);
      to = tomorrow;
      prevFrom = addDays(from, -n);
      prevTo = from;
      break;
    }
  }
  return { from: brusselsMidnight(from), to: brusselsMidnight(to), prevFrom: brusselsMidnight(prevFrom), prevTo: brusselsMidnight(prevTo) };
}

/** Rule 34: absolute and percentage change; the percentage is null when the previous value is 0. */
export function comparePeriods(current: number, previous: number): { current: number; previous: number; change: number; changePct: number | null } {
  const change = current - previous;
  return { current, previous, change, changePct: previous === 0 ? null : Math.round((change / Math.abs(previous)) * 1000) / 10 };
}
