/**
 * The usual send window of campaigns (email spec rule 26) and the Brussels calendar helpers the
 * module's logic uses. Pure.
 *
 * A `scheduled_at` before 08:00 or from 21:00 Brussels, on a Sunday or on a Belgian public
 * holiday needs `confirmOutsideWindow: true`: a warning, not a block.
 */
import { belgianPublicHolidays as platformHolidays } from "../platform/holidays";
import { TIME_ZONE } from "../i18n/locales";

export type SendWindowWarning = "before_8" | "after_21" | "sunday" | "public_holiday";

export type BrusselsParts = { year: number; month: number; day: number; hour: number; minute: number; weekday: number; date: string };

const FORMAT = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  weekday: "short",
});

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Wall-clock parts of an instant in Europe/Brussels (`weekday` 0 = Sunday, `date` = `YYYY-MM-DD`). */
export function brusselsParts(at: Date): BrusselsParts {
  const parts: Record<string, string> = {};
  for (const p of FORMAT.formatToParts(at)) parts[p.type] = p.value;
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  return {
    year,
    month,
    day,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: WEEKDAYS[parts.weekday ?? ""] ?? 0,
    date: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

/** The Brussels calendar date (`YYYY-MM-DD`) of an instant. */
export function brusselsDate(at: Date): string {
  return brusselsParts(at).date;
}

/** Offset of Brussels from UTC at `at`, in minutes (60 in winter, 120 in summer). */
function offsetMinutes(at: Date): number {
  const p = brusselsParts(at);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return Math.round((asUtc - Math.floor(at.getTime() / 60_000) * 60_000) / 60_000);
}

/** The instant of a Brussels wall-clock time (`date` = `YYYY-MM-DD`). Times in the spring DST gap move forward. */
export function brusselsInstant(date: string, hour = 0, minute = 0): Date {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d, hour, minute);
  let instant = new Date(guess - offsetMinutes(new Date(guess)) * 60_000);
  // A second pass settles instants close to a DST change.
  instant = new Date(guess - offsetMinutes(instant) * 60_000);
  return instant;
}

/** `[start, end)` of the Brussels calendar day containing `at` (23, 24 or 25 hours long). */
export function brusselsDayBounds(at: Date): { start: Date; end: Date } {
  const date = brusselsDate(at);
  return { start: brusselsInstant(date), end: brusselsInstant(addDays(date, 1)) };
}

/** `YYYY-MM-DD` plus `days` calendar days. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Whole calendar days from `from` to `to` (both `YYYY-MM-DD`). */
export function daysBetween(from: string, to: string): number {
  const ms = (s: string) => {
    const [y, m, d] = s.split("-").map(Number) as [number, number, number];
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((ms(to) - ms(from)) / 86_400_000);
}

/** The ten Belgian legal public holidays of `year` as ISO dates (`YYYY-MM-DD`), sorted. */
export function belgianPublicHolidays(year: number): string[] {
  return platformHolidays(year).map((h) => h.on);
}

/** The send-window warnings of a scheduled moment, in a fixed order. Empty inside the window. */
export function sendWindowWarnings(at: Date): SendWindowWarning[] {
  const p = brusselsParts(at);
  const warnings: SendWindowWarning[] = [];
  if (p.hour < 8) warnings.push("before_8");
  if (p.hour >= 21) warnings.push("after_21");
  if (p.weekday === 0) warnings.push("sunday");
  if (belgianPublicHolidays(p.year).includes(p.date)) warnings.push("public_holiday");
  return warnings;
}
