/**
 * Support response deadlines (PL-88, edge case 30). Minutes count only inside support hours:
 * Monday to Friday 09:00-18:00 Brussels, without Belgian public holidays. `critical` also
 * counts weekends and holidays 10:00-18:00; its target is 120 minutes when counting starts on
 * a business day and 240 when it starts on a weekend day or holiday. A request received
 * outside support hours starts counting at the next opening. Values come from `settings.support`.
 */
import { BRUSSELS, localDateKey, wallClock, weekdayOf, zonedTimeToUtc, type LocalDateTime } from "./cron";
import { isBelgianPublicHoliday } from "./holidays";

export const SUPPORT_SEVERITIES = ["critical", "high", "normal", "improvement"] as const;
export type SupportSeverity = (typeof SUPPORT_SEVERITIES)[number];

/** The `settings.support` fields this calculation reads. */
export type SupportCalendar = {
  business_hours: { weekday: readonly [string, string]; weekend_critical: readonly [string, string] };
  response_minutes: { critical_business: number; critical_weekend: number; high: number; normal: number; improvement: number };
  /** Extra closed days (`YYYY-MM-DD`) on top of the Belgian public holidays. */
  closed_days?: readonly string[];
};

export const DEFAULT_SUPPORT_CALENDAR: SupportCalendar = {
  business_hours: { weekday: ["09:00", "18:00"], weekend_critical: ["10:00", "18:00"] },
  response_minutes: { critical_business: 120, critical_weekend: 240, high: 240, normal: 540, improvement: 1080 },
};

const MINUTE = 60_000;

type Day = { year: number; month: number; day: number };

function parseHm(hm: string): { hour: number; minute: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm);
  if (!m) throw new RangeError(`invalid time "${hm}"`);
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

function nextDay(d: Day): Day {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day + 1));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

/** A Monday-to-Friday day that is not a public holiday or an extra closed day. */
export function isBusinessDay(d: Day, calendar: Pick<SupportCalendar, "closed_days"> = {}): boolean {
  const wd = weekdayOf(d);
  if (wd === 0 || wd === 6) return false;
  const key = localDateKey(d);
  return !isBelgianPublicHoliday(key) && !(calendar.closed_days ?? []).includes(key);
}

/** The support window of one local day for a severity, as instants, or `null` when closed. */
function windowOf(d: Day, severity: SupportSeverity, calendar: SupportCalendar): { open: Date; close: Date; business: boolean } | null {
  const business = isBusinessDay(d, calendar);
  const hours = business ? calendar.business_hours.weekday : severity === "critical" ? calendar.business_hours.weekend_critical : null;
  if (!hours) return null;
  const at = (hm: string): Date => {
    const { hour, minute } = parseHm(hm);
    const local: LocalDateTime = { ...d, hour, minute };
    return zonedTimeToUtc(local, BRUSSELS);
  };
  return { open: at(hours[0]), close: at(hours[1]), business };
}

/** When the response to a request of `severity` received at `receivedAt` is due. */
export function slaDueAt(severity: SupportSeverity, receivedAt: Date, calendar: SupportCalendar = DEFAULT_SUPPORT_CALENDAR): Date {
  const start = wallClock(receivedAt, BRUSSELS);
  let day: Day = { year: start.year, month: start.month, day: start.day };
  let remaining: number | null = severity === "critical" ? null : calendar.response_minutes[severity];
  let cursor = receivedAt.getTime();

  for (let guard = 0; guard < 400; guard++, day = nextDay(day)) {
    const w = windowOf(day, severity, calendar);
    if (!w || w.close.getTime() <= cursor) continue;
    const from = Math.max(cursor, w.open.getTime());
    // The first open moment decides the critical target (business day 120, weekend or holiday 240).
    remaining ??= w.business ? calendar.response_minutes.critical_business : calendar.response_minutes.critical_weekend;
    const available = (w.close.getTime() - from) / MINUTE;
    if (available >= remaining) return new Date(from + remaining * MINUTE);
    remaining -= available;
    cursor = w.close.getTime();
  }
  throw new RangeError("no support window found within 400 days");
}

/** Support minutes between two instants (for reporting median first response). */
export function supportMinutesBetween(
  severity: SupportSeverity,
  from: Date,
  to: Date,
  calendar: SupportCalendar = DEFAULT_SUPPORT_CALENDAR,
): number {
  if (to.getTime() <= from.getTime()) return 0;
  const start = wallClock(from, BRUSSELS);
  let day: Day = { year: start.year, month: start.month, day: start.day };
  let total = 0;
  for (let guard = 0; guard < 4000; guard++, day = nextDay(day)) {
    const w = windowOf(day, severity, calendar);
    if (w) {
      const a = Math.max(from.getTime(), w.open.getTime());
      const b = Math.min(to.getTime(), w.close.getTime());
      if (b > a) total += (b - a) / MINUTE;
    }
    const dayEnd = zonedTimeToUtc({ ...nextDay(day), hour: 0, minute: 0 }, BRUSSELS);
    if (dayEnd.getTime() >= to.getTime()) break;
  }
  return Math.round(total);
}
