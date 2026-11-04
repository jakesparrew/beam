/**
 * Schedule maths (booking spec 3.0b, 3.1, R1-R4b). Pure: dates are Brussels calendar dates
 * (`YYYY-MM-DD`), wall-clock times are `HH:mm` (or `HH:mm:ss`, as Postgres returns `time`),
 * instants are UTC `Date`s. Starts are built from the local date plus the wall-clock time,
 * so 10:00 stays 10:00 local across DST changes; ends add real elapsed minutes (edge case 5).
 */
import { TZDate } from "@date-fns/tz";
import { TIME_ZONE } from "../i18n/locales";
import type { BusinessHours } from "./rules";
import type { ExceptionKind } from "./types";

/** Days materialised ahead of today (R1: `[today, today + 90]`). */
export const MATERIALISE_DAYS = 90;
/** `nextOpening` searches this many days ahead (3.0b). */
export const NEXT_OPENING_HORIZON_DAYS = 30;

export type TemplateLike = {
  id?: string;
  /** ISO weekdays, 1 = Monday ... 7 = Sunday. */
  weekdays: readonly number[];
  /** Wall-clock `HH:mm` or `HH:mm:ss`. */
  startTime: string;
  durationMinutes: number;
  activeFromOn: string;
  activeToOn: string | null;
};

export type ExceptionLike = {
  id?: string;
  onDate: string;
  kind: ExceptionKind;
  /** `null` (or empty) applies to every template. */
  templateIds: readonly string[] | null;
  opensAt: string | null;
  closesAt: string | null;
};

export type ExistingSession = {
  id: string;
  startsAt: Date;
  hasBookings: boolean;
  hasWaitlistEntries?: boolean;
  hasHolds?: boolean;
  hasManualChanges: boolean;
};

// ---------------------------------------------------------------------------
// Date helpers (Europe/Brussels)
// ---------------------------------------------------------------------------

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{2}):(\d{2})(?::(\d{2}))?$/;

function parseDate(onDate: string): [number, number, number] {
  const m = DATE_RE.exec(onDate);
  if (!m) throw new RangeError(`invalid date: ${onDate}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function parseTime(time: string): [number, number, number] {
  const m = TIME_RE.exec(time);
  if (!m) throw new RangeError(`invalid time: ${time}`);
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
}

/** Minutes since midnight of a wall-clock time. */
export function timeToMinutes(time: string): number {
  const [h, m] = parseTime(time);
  return h * 60 + m;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The instant of a Brussels wall-clock time on a Brussels date (`zonedTimeToUtc(d + time)`). */
export function zonedTimeToUtc(onDate: string, time: string): Date {
  const [y, mo, d] = parseDate(onDate);
  const [h, mi, s] = parseTime(time);
  return new Date(new TZDate(y, mo - 1, d, h, mi, s, TIME_ZONE).getTime());
}

/** A Brussels wall-clock `YYYY-MM-DDTHH:mm` (admin inputs, lead windows) as an instant. */
export function localDateTimeToUtc(local: string): Date {
  const [onDate, time] = local.split("T");
  if (!onDate || !time) throw new RangeError(`invalid local date-time: ${local}`);
  return zonedTimeToUtc(onDate, time.slice(0, 8));
}

/** The Brussels calendar date of an instant. */
export function brusselsDate(instant: Date): string {
  const z = new TZDate(instant.getTime(), TIME_ZONE);
  return `${z.getFullYear()}-${pad(z.getMonth() + 1)}-${pad(z.getDate())}`;
}

/** The Brussels wall-clock time `HH:mm` of an instant. */
export function brusselsTime(instant: Date): string {
  const z = new TZDate(instant.getTime(), TIME_ZONE);
  return `${pad(z.getHours())}:${pad(z.getMinutes())}`;
}

/** ISO weekday (1 = Monday ... 7 = Sunday) of a calendar date. */
export function isoWeekday(onDate: string): number {
  const [y, m, d] = parseDate(onDate);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return day === 0 ? 7 : day;
}

/** Calendar date arithmetic. */
export function addDays(onDate: string, days: number): string {
  const [y, m, d] = parseDate(onDate);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Every date from `fromOn` to `toOn`, both included. */
export function eachDate(fromOn: string, toOn: string): string[] {
  const out: string[] = [];
  for (let d = fromOn; d <= toOn; d = addDays(d, 1)) out.push(d);
  return out;
}

// ---------------------------------------------------------------------------
// Exceptions and materialisation (R1-R4)
// ---------------------------------------------------------------------------

const appliesToAll = (e: ExceptionLike) => !e.templateIds || e.templateIds.length === 0;

/** R4: whether an exception suppresses a template (by id and start time) on its date. */
export function suppresses(e: ExceptionLike, templateId: string | undefined, startTime: string): boolean {
  if (!appliesToAll(e) && (templateId === undefined || !e.templateIds!.includes(templateId))) return false;
  if (e.kind === "closed" || e.kind === "holiday") return true;
  if (!e.opensAt || !e.closesAt) return false;
  const start = timeToMinutes(startTime);
  return start < timeToMinutes(e.opensAt) || start >= timeToMinutes(e.closesAt);
}

/** R1: the occurrences of a template between two dates (both included), exceptions applied. */
export function planOccurrences(
  t: TemplateLike,
  exceptions: ExceptionLike[],
  fromOn: string,
  toOn: string,
): Array<{ startsAt: Date; endsAt: Date }> {
  const from = fromOn > t.activeFromOn ? fromOn : t.activeFromOn;
  const to = t.activeToOn !== null && t.activeToOn < toOn ? t.activeToOn : toOn;
  const out: Array<{ startsAt: Date; endsAt: Date }> = [];
  for (const d of from <= to ? eachDate(from, to) : []) {
    if (!t.weekdays.includes(isoWeekday(d))) continue;
    if (exceptions.some((e) => e.onDate === d && suppresses(e, t.id, t.startTime))) continue;
    const startsAt = zonedTimeToUtc(d, t.startTime);
    out.push({ startsAt, endsAt: new Date(startsAt.getTime() + t.durationMinutes * 60_000) });
  }
  return out;
}

const isTouched = (s: ExistingSession) => s.hasBookings || !!s.hasWaitlistEntries || !!s.hasHolds || s.hasManualChanges;

/**
 * R2 and R3: compare planned starts with a template's existing future sessions. Touched sessions
 * (any booking, waitlist entry, hold or manual change) are `untouched`; free sessions whose
 * start is still planned are `update`d, the other free ones `remove`d; planned starts without
 * any session are `insert`ed.
 */
export function diffTemplateSessions(
  planned: Array<{ startsAt: Date }>,
  existing: ExistingSession[],
): { insert: Date[]; update: string[]; remove: string[]; untouched: string[] } {
  const plannedMs = new Set(planned.map((p) => p.startsAt.getTime()));
  const existingMs = new Set(existing.map((s) => s.startsAt.getTime()));
  const result = { insert: [] as Date[], update: [] as string[], remove: [] as string[], untouched: [] as string[] };
  for (const s of existing) {
    if (isTouched(s)) result.untouched.push(s.id);
    else if (plannedMs.has(s.startsAt.getTime())) result.update.push(s.id);
    else result.remove.push(s.id);
  }
  for (const p of planned) if (!existingMs.has(p.startsAt.getTime())) result.insert.push(p.startsAt);
  return result;
}

// ---------------------------------------------------------------------------
// Holidays and opening hours (R4b, 3.0b)
// ---------------------------------------------------------------------------

/** R4b: the public holidays in `[fromOn, toOn]` that have no exception on their date yet. */
export function holidaySuggestions(
  holidays: Array<{ on: string; key: string }>,
  exceptions: ExceptionLike[],
  fromOn: string,
  toOn: string,
): Array<{ onDate: string; key: string }> {
  const taken = new Set(exceptions.map((e) => e.onDate));
  return holidays
    .filter((h) => h.on >= fromOn && h.on <= toOn && !taken.has(h.on))
    .sort((a, b) => a.on.localeCompare(b.on))
    .map((h) => ({ onDate: h.on, key: h.key }));
}

/**
 * 3.0b: the public opening hours of a date. A `closed` or `holiday` exception for every
 * template closes the day; a `special_hours` exception for every template replaces the hours.
 */
export function openingHoursFor(
  onDate: string,
  hours: BusinessHours,
  exceptions: ExceptionLike[],
): { opensAt: string; closesAt: string } | null {
  const forDay = exceptions.filter((e) => e.onDate === onDate && appliesToAll(e));
  if (forDay.some((e) => e.kind === "closed" || e.kind === "holiday")) return null;
  const special = forDay.find((e) => e.kind === "special_hours" && e.opensAt && e.closesAt);
  if (special) return { opensAt: special.opensAt!.slice(0, 5), closesAt: special.closesAt!.slice(0, 5) };
  const day = hours.week[isoWeekday(onDate) as 1 | 2 | 3 | 4 | 5 | 6 | 7];
  return day ? { opensAt: day.opens_at, closesAt: day.closes_at } : null;
}

/**
 * 3.0b `nextOpeningAt`: the first instant `>= from` at which the centre is open, skipping the
 * given public holidays; `from` inside opening hours returns `from`; `null` when nothing opens
 * within 30 days.
 */
export function nextOpening(
  from: Date,
  hours: BusinessHours,
  exceptions: ExceptionLike[],
  holidays: Array<{ on: string }>,
): Date | null {
  const skip = new Set(holidays.map((h) => h.on));
  const first = brusselsDate(from);
  for (let i = 0; i < NEXT_OPENING_HORIZON_DAYS; i++) {
    const d = addDays(first, i);
    if (skip.has(d)) continue;
    const open = openingHoursFor(d, hours, exceptions);
    if (!open) continue;
    const opens = zonedTimeToUtc(d, open.opensAt);
    const closes = zonedTimeToUtc(d, open.closesAt);
    if (from.getTime() >= closes.getTime()) continue;
    return from.getTime() >= opens.getTime() ? from : opens;
  }
  return null;
}
