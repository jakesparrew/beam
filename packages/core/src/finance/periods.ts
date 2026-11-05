/**
 * Dashboard periods (finance spec rule 44, finance-P8): the selected Brussels date range with the
 * previous period and the same period last year. Every bound is an inclusive `YYYY-MM-DD` date in
 * Europe/Brussels, so a DST change never moves a day boundary. Weeks are ISO weeks (Monday to
 * Sunday, week 1 holds the first Thursday of the year).
 *
 * - `day`: today; previous = yesterday; last year = the same calendar date (29 Feb maps to 28 Feb).
 * - `week`: the ISO week of today; previous = the week before; last year = the same ISO week number
 *   of the previous ISO year (week 53 maps to week 52 when that year has no week 53).
 * - `month`: the calendar month of today; previous = the calendar month before; last year = the same
 *   month a year earlier.
 * - `ytd`: 1 January up to today; previous and last year are both 1 January up to the same date of
 *   the previous year (a year-to-date span has no other meaningful predecessor).
 * - `custom`: `from` to `to`; previous = the span of equal length that ends the day before `from`;
 *   last year = both bounds shifted back one year.
 */
import { brusselsDateOf } from "./numbering";

export const DASHBOARD_PERIODS = ["day", "week", "month", "ytd", "custom"] as const;
export type DashboardPeriod = (typeof DASHBOARD_PERIODS)[number];

export type DateRange = { from: string; to: string };
export type ResolvedPeriod = DateRange & { previous: DateRange; lastYear: DateRange };

/** The longest custom span the dashboard accepts (two years and a leap day). */
export const MAX_CUSTOM_DAYS = 731;

const DAY_MS = 86_400_000;
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Days since 1970-01-01 of a calendar date (UTC arithmetic: calendar dates have no time zone). */
function toDays(day: string): number {
  const m = ISO_DAY.exec(day);
  if (!m) throw new RangeError(`invalid date ${day}`);
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const back = new Date(ms);
  if (back.getUTCFullYear() !== Number(m[1]) || back.getUTCMonth() !== Number(m[2]) - 1 || back.getUTCDate() !== Number(m[3])) {
    throw new RangeError(`invalid date ${day}`);
  }
  return Math.round(ms / DAY_MS);
}

function fromDays(days: number): string {
  return new Date(days * DAY_MS).toISOString().slice(0, 10);
}

/** `day` plus `n` calendar days. */
export function addPeriodDays(day: string, n: number): string {
  return fromDays(toDays(day) + n);
}

/** Inclusive number of days from `from` to `to`. */
export function periodDays(from: string, to: string): number {
  return toDays(to) - toDays(from) + 1;
}

/** True for a real calendar date written `YYYY-MM-DD`. */
export function isPeriodDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    toDays(value);
    return true;
  } catch {
    return false;
  }
}

const pad = (n: number) => String(n).padStart(2, "0");
const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const daysInMonth = (y: number, m: number) => [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]!;

function ymd(day: string): [number, number, number] {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return [y, m, d];
}

/** The same calendar date `years` earlier; 29 February becomes 28 February. */
export function shiftPeriodYears(day: string, years: number): string {
  const [y, m, d] = ymd(day);
  const ty = y - years;
  return `${ty}-${pad(m)}-${pad(Math.min(d, daysInMonth(ty, m)))}`;
}

function monthRange(y: number, m: number): DateRange {
  return { from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(daysInMonth(y, m))}` };
}

/** ISO weekday, Monday = 1 ... Sunday = 7. */
function isoWeekday(day: string): number {
  // 1970-01-01 was a Thursday (ISO 4).
  return ((((toDays(day) + 3) % 7) + 7) % 7) + 1;
}

/** Monday of ISO week 1 of `isoYear`. */
function isoWeekOneMonday(isoYear: number): string {
  const jan4 = `${isoYear}-01-04`;
  return addPeriodDays(jan4, 1 - isoWeekday(jan4));
}

/** The ISO year and week number of a date. */
export function isoWeekOf(day: string): { isoYear: number; week: number } {
  const thursday = addPeriodDays(day, 4 - isoWeekday(day));
  const isoYear = ymd(thursday)[0];
  const week = Math.floor((toDays(day) - toDays(isoWeekOneMonday(isoYear))) / 7) + 1;
  return { isoYear, week };
}

function isoWeeksIn(isoYear: number): number {
  return isoWeekOf(`${isoYear}-12-28`).week;
}

function isoWeekRange(isoYear: number, week: number): DateRange {
  const monday = addPeriodDays(isoWeekOneMonday(isoYear), (week - 1) * 7);
  return { from: monday, to: addPeriodDays(monday, 6) };
}

/** Resolves a dashboard period for the Brussels date of `now` (finance spec rule 44). */
export function resolvePeriod(
  input: { period: DashboardPeriod; from?: string; to?: string },
  now: Date,
): ResolvedPeriod {
  const today = brusselsDateOf(now);
  const [y, m] = ymd(today);
  switch (input.period) {
    case "day": {
      const yesterday = addPeriodDays(today, -1);
      return { from: today, to: today, previous: { from: yesterday, to: yesterday }, lastYear: { from: shiftPeriodYears(today, 1), to: shiftPeriodYears(today, 1) } };
    }
    case "week": {
      const { isoYear, week } = isoWeekOf(today);
      const current = isoWeekRange(isoYear, week);
      const previous = { from: addPeriodDays(current.from, -7), to: addPeriodDays(current.to, -7) };
      const lastYear = isoWeekRange(isoYear - 1, Math.min(week, isoWeeksIn(isoYear - 1)));
      return { ...current, previous, lastYear };
    }
    case "month": {
      const current = monthRange(y, m);
      const previous = m === 1 ? monthRange(y - 1, 12) : monthRange(y, m - 1);
      return { ...current, previous, lastYear: monthRange(y - 1, m) };
    }
    case "ytd": {
      const lastYear = { from: `${y - 1}-01-01`, to: shiftPeriodYears(today, 1) };
      return { from: `${y}-01-01`, to: today, previous: lastYear, lastYear: { ...lastYear } };
    }
    case "custom": {
      if (!isPeriodDate(input.from) || !isPeriodDate(input.to)) throw new RangeError("custom period needs from and to as YYYY-MM-DD");
      const length = periodDays(input.from, input.to);
      if (length < 1) throw new RangeError("custom period ends before it starts");
      if (length > MAX_CUSTOM_DAYS) throw new RangeError(`custom period longer than ${MAX_CUSTOM_DAYS} days`);
      const prevTo = addPeriodDays(input.from, -1);
      return {
        from: input.from,
        to: input.to,
        previous: { from: addPeriodDays(prevTo, 1 - length), to: prevTo },
        lastYear: { from: shiftPeriodYears(input.from, 1), to: shiftPeriodYears(input.to, 1) },
      };
    }
  }
}

/** Daily bars up to 62 days, monthly bars beyond (the revenue trend's granularity). */
export function trendGranularity(range: DateRange): "day" | "month" {
  return periodDays(range.from, range.to) <= 62 ? "day" : "month";
}
