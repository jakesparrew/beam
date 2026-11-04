/**
 * Brussels wall-clock helpers for the engine (A-17 `snap_to`, A-32 quiet hours). DST-safe and
 * built on `Intl` only: the offset of `Europe/Brussels` is read for the instant in question.
 */
export const BRUSSELS_TZ = "Europe/Brussels";
export const MINUTE_MS = 60_000;
export const DAY_MS = 86_400_000;

const partsFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: BRUSSELS_TZ,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

export type WallClock = { year: number; month: number; day: number; hour: number; minute: number; second: number };

/** The Brussels wall clock of an instant. */
export function brusselsWallClock(at: Date): WallClock {
  const parts: Record<string, number> = {};
  for (const p of partsFormatter.formatToParts(at)) if (p.type !== "literal") parts[p.type] = Number(p.value);
  return {
    year: parts.year!,
    month: parts.month!,
    day: parts.day!,
    hour: parts.hour! % 24,
    minute: parts.minute!,
    second: parts.second!,
  };
}

/** Minutes Brussels is ahead of UTC at that instant (60 in winter, 120 in summer). */
export function brusselsOffsetMinutes(at: Date): number {
  const w = brusselsWallClock(at);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / MINUTE_MS);
}

/** The Brussels calendar date of an instant, `YYYY-MM-DD`. */
export function brusselsDate(at: Date): string {
  const w = brusselsWallClock(at);
  return `${w.year}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")}`;
}

/** The Brussels local time of an instant, `HH:mm`. */
export function brusselsTimeOfDay(at: Date): string {
  const w = brusselsWallClock(at);
  return `${String(w.hour).padStart(2, "0")}:${String(w.minute).padStart(2, "0")}`;
}

function parseHhmm(hhmm: string): { hour: number; minute: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) throw new Error(`brusselsAt: expected HH:mm, got ${hhmm}`);
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) throw new Error(`brusselsAt: expected HH:mm, got ${hhmm}`);
  return { hour, minute };
}

/** The instant of a Brussels wall-clock time; a time skipped by the spring change moves forward. */
export function brusselsLocal(year: number, month: number, day: number, hour: number, minute: number): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  // Two passes settle the offset, also on the day the offset changes.
  let guess = naive - brusselsOffsetMinutes(new Date(naive)) * MINUTE_MS;
  guess = naive - brusselsOffsetMinutes(new Date(guess)) * MINUTE_MS;
  return new Date(guess);
}

/**
 * The instant at `hhmm` Brussels time on the Brussels calendar date of `day` (A-17 `snap_to`).
 * DST-safe: 10:00 is 09:00Z in winter and 08:00Z in summer, also on the days of the change.
 */
export function brusselsAt(day: Date, hhmm: string): Date {
  const { hour, minute } = parseHhmm(hhmm);
  const w = brusselsWallClock(day);
  return brusselsLocal(w.year, w.month, w.day, hour, minute);
}

/** The same Brussels wall-clock time `days` calendar days later (23, 24 or 25 hours a day). */
export function addBrusselsDays(at: Date, days: number): Date {
  const w = brusselsWallClock(at);
  const next = new Date(Date.UTC(w.year, w.month - 1, w.day + days));
  return brusselsLocal(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), w.hour, w.minute);
}

export const addMinutes = (at: Date, minutes: number): Date => new Date(at.getTime() + minutes * MINUTE_MS);

/** UTC minute bucket `YYYY-MM-DDTHH:mm` used in idempotency keys (DM-5). */
export function utcMinuteBucket(at: Date): string {
  return at.toISOString().slice(0, 16);
}

/**
 * True when the Brussels time of `at` lies in the window `[start, end)`; a window whose end is
 * before its start crosses midnight (quiet hours 21:00-08:00, A-32).
 */
export function isWithinBrusselsWindow(at: Date, start: string, end: string): boolean {
  const toMin = (s: string) => {
    const { hour, minute } = parseHhmm(s);
    return hour * 60 + minute;
  };
  const w = brusselsWallClock(at);
  const t = w.hour * 60 + w.minute;
  const s = toMin(start);
  const e = toMin(end);
  if (s === e) return false;
  return s < e ? t >= s && t < e : t >= s || t < e;
}

/** The next instant at or after `at` whose Brussels time is `hhmm` (quiet hours end, A-32). */
export function nextBrusselsTime(at: Date, hhmm: string): Date {
  const same = brusselsAt(at, hhmm);
  return same.getTime() >= at.getTime() ? same : brusselsAt(addBrusselsDays(same, 1), hhmm);
}
