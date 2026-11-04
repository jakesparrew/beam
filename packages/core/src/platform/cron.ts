/**
 * Five-field cron expressions evaluated in `Europe/Brussels` (PL-33) and the wall-clock
 * helpers the schedule, SLA and holiday code share. Pure: no I/O, `Intl` only.
 *
 * DST rules: on the spring day a slot inside the skipped hour fires at the first valid
 * instant after the gap (03:00 local); on the autumn day the repeated hour yields each local
 * slot once, at its first occurrence. A slot keeps its nominal local key `YYYY-MM-DDTHH:mm`.
 */

export const BRUSSELS = "Europe/Brussels";

/** A wall-clock time in some zone. `month` is 1-12, `weekday` 0 (Sunday) to 6. */
export type LocalDateTime = { year: number; month: number; day: number; hour: number; minute: number };
export type LocalParts = LocalDateTime & { weekday: number };

const MINUTE = 60_000;
const formatters = new Map<string, Intl.DateTimeFormat>();
const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
    });
    formatters.set(tz, f);
  }
  return f;
}

/** The wall clock of an instant in `tz`. */
export function wallClock(instant: Date, tz: string = BRUSSELS): LocalParts {
  const parts: Record<string, string> = {};
  for (const p of formatter(tz).formatToParts(instant)) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: WEEKDAYS[parts.weekday ?? "Sun"] ?? 0,
  };
}

/** Milliseconds of a wall clock read as if it were UTC (a naive timestamp). */
function naive(local: LocalDateTime): number {
  return Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
}

function sameWall(a: LocalDateTime, b: LocalDateTime): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day && a.hour === b.hour && a.minute === b.minute;
}

/** Offset of `tz` at an instant, in minutes east of UTC. */
export function offsetMinutes(instant: Date, tz: string = BRUSSELS): number {
  const w = wallClock(instant, tz);
  return Math.round((naive(w) - Math.floor(instant.getTime() / MINUTE) * MINUTE) / MINUTE);
}

/**
 * The instant of a wall-clock time in `tz`. An ambiguous time (autumn) gives its first
 * occurrence; a time inside a gap (spring) gives the first valid instant after the gap.
 */
export function zonedTimeToUtc(local: LocalDateTime, tz: string = BRUSSELS): Date {
  const n = naive(local);
  const offsets = new Set([offsetMinutes(new Date(n - 12 * 60 * MINUTE), tz), offsetMinutes(new Date(n + 12 * 60 * MINUTE), tz)]);
  const candidates = [...offsets]
    .map((o) => n - o * MINUTE)
    .filter((t) => sameWall(wallClock(new Date(t), tz), local))
    .sort((a, b) => a - b);
  if (candidates.length) return new Date(candidates[0] as number);
  // Gap: find the first minute after the transition between the two readings.
  const [lo0, hi0] = [...offsets].map((o) => n - o * MINUTE).sort((a, b) => a - b) as [number, number];
  let lo = lo0;
  let hi = hi0;
  const before = offsetMinutes(new Date(lo), tz);
  while (hi - lo > MINUTE) {
    const mid = lo + Math.floor((hi - lo) / MINUTE / 2) * MINUTE;
    if (offsetMinutes(new Date(mid), tz) === before) lo = mid;
    else hi = mid;
  }
  return new Date(hi);
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** `YYYY-MM-DD` of a wall clock. */
export function localDateKey(local: Pick<LocalDateTime, "year" | "month" | "day">): string {
  return `${pad(local.year, 4)}-${pad(local.month)}-${pad(local.day)}`;
}

/** `YYYY-MM-DDTHH:mm` of a wall clock: the minute part of a schedule key (`schedule:<kind>:<minute>`). */
export function localMinuteKey(local: LocalDateTime): string {
  return `${localDateKey(local)}T${pad(local.hour)}:${pad(local.minute)}`;
}

/** `YYYY-MM-DDTHH` in Brussels: the hour bucket of throttle keys such as `slack:<fingerprint>:<hour>`. */
export function localHourKey(instant: Date, tz: string = BRUSSELS): string {
  const w = wallClock(instant, tz);
  return `${localDateKey(w)}T${pad(w.hour)}`;
}

export function weekdayOf(local: Pick<LocalDateTime, "year" | "month" | "day">): number {
  return new Date(Date.UTC(local.year, local.month - 1, local.day)).getUTCDay();
}

// ---------------------------------------------------------------------------
// Cron parsing
// ---------------------------------------------------------------------------

export type CronSpec = {
  minute: ReadonlySet<number>;
  hour: ReadonlySet<number>;
  dayOfMonth: ReadonlySet<number>;
  month: ReadonlySet<number>;
  dayOfWeek: ReadonlySet<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
};

const FIELDS = [
  { name: "minute", min: 0, max: 59, names: {} as Record<string, number> },
  { name: "hour", min: 0, max: 23, names: {} as Record<string, number> },
  { name: "day of month", min: 1, max: 31, names: {} as Record<string, number> },
  {
    name: "month",
    min: 1,
    max: 12,
    names: { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 } as Record<string, number>,
  },
  { name: "day of week", min: 0, max: 7, names: { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 } as Record<string, number> },
] as const;

export class CronSyntaxError extends Error {
  override readonly name = "CronSyntaxError";
}

function parseValue(raw: string, field: (typeof FIELDS)[number], expr: string): number {
  const lower = raw.toLowerCase();
  const named = field.names[lower];
  const value = named ?? (/^\d+$/.test(raw) ? Number(raw) : Number.NaN);
  if (!Number.isInteger(value) || value < field.min || value > field.max) {
    throw new CronSyntaxError(`invalid ${field.name} "${raw}" in cron "${expr}"`);
  }
  return value;
}

function parseField(text: string, index: number, expr: string): Set<number> {
  const field = FIELDS[index] as (typeof FIELDS)[number];
  const out = new Set<number>();
  for (const part of text.split(",")) {
    const [range = "", stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new CronSyntaxError(`invalid step "${part}" in cron "${expr}"`);
    let from: number;
    let to: number;
    if (range === "*") {
      from = field.min;
      to = index === 4 ? 6 : field.max;
    } else if (range.includes("-")) {
      const [a = "", b = ""] = range.split("-");
      from = parseValue(a, field, expr);
      to = parseValue(b, field, expr);
      if (from > to) throw new CronSyntaxError(`invalid range "${range}" in cron "${expr}"`);
    } else {
      from = parseValue(range, field, expr);
      to = stepText === undefined ? from : field.max;
    }
    for (let v = from; v <= to; v += step) out.add(index === 4 && v === 7 ? 0 : v);
  }
  return out;
}

const parsed = new Map<string, CronSpec>();

/** Parses `m h dom mon dow` (numbers, names, `*`, ranges, lists and steps). Throws `CronSyntaxError`. */
export function parseCron(expr: string): CronSpec {
  const cached = parsed.get(expr);
  if (cached) return cached;
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new CronSyntaxError(`cron "${expr}" must have 5 fields`);
  const [minute, hour, dom, month, dow] = fields.map((f, i) => parseField(f, i, expr)) as [
    Set<number>,
    Set<number>,
    Set<number>,
    Set<number>,
    Set<number>,
  ];
  const spec: CronSpec = {
    minute,
    hour,
    dayOfMonth: dom,
    month,
    dayOfWeek: dow,
    domRestricted: fields[2] !== "*",
    dowRestricted: fields[4] !== "*",
  };
  parsed.set(expr, spec);
  return spec;
}

export function isValidCron(expr: string): boolean {
  try {
    parseCron(expr);
    return true;
  } catch {
    return false;
  }
}

/**
 * Does the cron fire at this wall-clock minute? A `Date` is read in Brussels. Day of month and
 * day of week combine with OR when both are restricted (classic cron).
 */
export function matchesCron(expr: string, localDate: LocalDateTime | Date, tz: string = BRUSSELS): boolean {
  const spec = parseCron(expr);
  const local = localDate instanceof Date ? wallClock(localDate, tz) : localDate;
  if (!spec.minute.has(local.minute) || !spec.hour.has(local.hour) || !spec.month.has(local.month)) return false;
  const domOk = spec.dayOfMonth.has(local.day);
  const dowOk = spec.dayOfWeek.has(weekdayOf(local));
  if (spec.domRestricted && spec.dowRestricted) return domOk || dowOk;
  return domOk && dowOk;
}

/** True when the schedule fires at most once per hour (one minute value): such schedules catch up (PL-33). */
export function isHourlyOrLonger(expr: string): boolean {
  return parseCron(expr).minute.size === 1;
}

export type CronSlot = {
  /** The instant the slot fires (a skipped-hour slot fires at the end of the gap). */
  at: Date;
  /** The nominal local wall-clock minute, `YYYY-MM-DDTHH:mm`. */
  key: string;
};

/**
 * Every slot of `expr` with `from < at <= to`, each local minute at most once, in order.
 * Walks wall-clock minutes, so the spring gap and the autumn repeat are handled by construction.
 */
export function slotsBetween(expr: string, from: Date, to: Date, tz: string = BRUSSELS): CronSlot[] {
  parseCron(expr);
  if (to.getTime() <= from.getTime()) return [];
  const startWall = naive(wallClock(new Date(from.getTime() - 120 * MINUTE), tz));
  const endWall = naive(wallClock(new Date(to.getTime() + 120 * MINUTE), tz));
  const out: CronSlot[] = [];
  for (let t = startWall; t <= endWall; t += MINUTE) {
    const d = new Date(t);
    const local: LocalDateTime = {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      hour: d.getUTCHours(),
      minute: d.getUTCMinutes(),
    };
    if (!matchesCron(expr, local, tz)) continue;
    const at = zonedTimeToUtc(local, tz);
    if (at.getTime() > from.getTime() && at.getTime() <= to.getTime()) out.push({ at, key: localMinuteKey(local) });
  }
  return out.sort((a, b) => a.at.getTime() - b.at.getTime() || a.key.localeCompare(b.key));
}

/**
 * The slots a tick at `now` enqueues (PL-33): hourly or longer schedules catch up every slot
 * since `lastTickAt`, at most 60 minutes back; minute-level and 10/15-minute schedules only
 * the current minute.
 */
export function dueSlots(expr: string, lastTickAt: Date | null, now: Date, tz: string = BRUSSELS): CronSlot[] {
  const minuteStart = new Date(Math.floor(now.getTime() / MINUTE) * MINUTE);
  if (!isHourlyOrLonger(expr) || !lastTickAt) {
    // Only the current slot: on the spring DST day every skipped wall minute 02:00-02:59 maps to
    // the same instant, and a minute-level schedule must not burst the whole hour (PL-33).
    return slotsBetween(expr, new Date(minuteStart.getTime() - MINUTE), minuteStart, tz).slice(-1);
  }
  const floor = Math.max(lastTickAt.getTime(), minuteStart.getTime() - 60 * MINUTE);
  return slotsBetween(expr, new Date(Math.min(floor, minuteStart.getTime() - MINUTE)), minuteStart, tz);
}
