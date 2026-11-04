/**
 * "Next business day" for task due dates (ops rules 21 and 22a): the first following day that
 * is open in booking's `settings.business_hours`, is not a booking closed-day exception and is
 * not a Belgian public holiday. Tasks are due at 10:00 Brussels on that day.
 */
import type { BusinessHours } from "../booking/rules";
import { localDateKey, wallClock, zonedTimeToUtc } from "../platform/cron";
import { easterSunday } from "../platform/holidays";

export type { BusinessHours };

/** The hour (Brussels) a task created from a list is due on the next business day. */
export const TASK_DUE_HOUR = 10;

/** How far ahead `nextBusinessDay` looks before giving up (a year of closures is a config error). */
const MAX_LOOKAHEAD_DAYS = 366;

const iso = (year: number, month: number, day: number) => new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);

const holidayCache = new Map<number, string[]>();

/**
 * The ten Belgian public holidays of `year` as sorted `YYYY-MM-DD` strings: 1 January, Easter
 * Monday, 1 May, Ascension Day, Whit Monday, 21 July, 15 August, 1 November, 11 November and
 * 25 December (Easter by the anonymous Gregorian algorithm).
 */
export function BE_PUBLIC_HOLIDAYS(year: number): string[] {
  if (!Number.isInteger(year) || year < 1583 || year > 9999) throw new RangeError(`unsupported year ${year}`);
  const cached = holidayCache.get(year);
  if (cached) return [...cached];
  const [em, ed] = easterSunday(year);
  const fromEaster = (days: number) => iso(year, em, ed + days);
  const list = [
    iso(year, 1, 1),
    fromEaster(1),
    iso(year, 5, 1),
    fromEaster(39),
    fromEaster(50),
    iso(year, 7, 21),
    iso(year, 8, 15),
    iso(year, 11, 1),
    iso(year, 11, 11),
    iso(year, 12, 25),
  ].sort();
  holidayCache.set(year, list);
  return [...list];
}

/** ISO weekday 1 (Monday) to 7 (Sunday) of a calendar date. */
function isoWeekday(year: number, month: number, day: number): 1 | 2 | 3 | 4 | 5 | 6 | 7 {
  const js = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return (js === 0 ? 7 : js) as 1 | 2 | 3 | 4 | 5 | 6 | 7;
}

/** Whether `YYYY-MM-DD` is a business day under `hours` and the closed-day exceptions. */
export function isBusinessDay(isoDate: string, hours: BusinessHours, closedDays: readonly string[]): boolean {
  const [y, m, d] = isoDate.split("-").map(Number) as [number, number, number];
  if (hours.week[isoWeekday(y, m, d)] === null) return false;
  if (closedDays.includes(isoDate)) return false;
  return !BE_PUBLIC_HOLIDAYS(y).includes(isoDate);
}

/**
 * 10:00 Brussels on the first business day after the Brussels date of `at`. `closedDays` are
 * booking's closed-day exceptions as `YYYY-MM-DD`. Throws when no business day exists within
 * a year (every weekday closed).
 */
export function nextBusinessDay(at: Date, hours: BusinessHours, closedDays: string[]): Date {
  const w = wallClock(at);
  for (let i = 1; i <= MAX_LOOKAHEAD_DAYS; i++) {
    const t = new Date(Date.UTC(w.year, w.month - 1, w.day + i));
    const day = { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
    if (isBusinessDay(localDateKey(day), hours, closedDays)) return zonedTimeToUtc({ ...day, hour: TASK_DUE_HOUR, minute: 0 });
  }
  throw new RangeError("no business day within a year: check settings.business_hours");
}
