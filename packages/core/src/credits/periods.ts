/**
 * Membership periods and dunning dates (credits rules 45, 49, 50, 52 and edge case 13).
 * Calendar maths in Europe/Brussels: a period keeps the wall-clock time of its start, and the
 * 29th to 31st clamp to the last day of a shorter month. Pure.
 */
import { BRUSSELS, wallClock, zonedTimeToUtc } from "../platform/cron";
import { addCalendarDays, brusselsDateOf } from "./expiry";

export type MembershipInterval = "month" | "year";

const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/** The Brussels day of month of a membership's first start: the anchor of every later period. */
export function anchorDayOf(startedAt: Date): number {
  return brusselsDateOf(startedAt).day;
}

/** The same Brussels wall-clock time as `like` (to the millisecond) on another calendar date. */
function atWallTimeOf(like: Date, date: { year: number; month: number; day: number }): Date {
  const w = wallClock(like, BRUSSELS);
  const minute = zonedTimeToUtc({ ...date, hour: w.hour, minute: w.minute }, BRUSSELS);
  const subMinuteMs = ((like.getTime() % 60_000) + 60_000) % 60_000;
  return new Date(minute.getTime() + subMinuteMs);
}

/**
 * The period that begins at `start`: `end` is one calendar month or year later in Brussels, on
 * `anchorDay` clamped to the last day of that month, at the wall-clock time of `start`. Periods
 * follow the anchor, not the previous end: anchor 31 gives 31 Jan -> 28 (29) Feb -> 31 Mar.
 * `activateMembership` passes the start; a renewal passes the old `current_period_end_at`
 * (new start = old end) and `anchorDayOf(started_at)`.
 */
export function nextPeriod(start: Date, interval: MembershipInterval, anchorDay: number): { start: Date; end: Date } {
  if (!Number.isInteger(anchorDay) || anchorDay < 1 || anchorDay > 31) throw new RangeError(`invalid anchorDay ${anchorDay}`);
  if (Number.isNaN(start.getTime())) throw new RangeError("invalid start date");
  const s = brusselsDateOf(start);
  let year = s.year;
  let month = s.month;
  if (interval === "month") {
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  } else {
    year += 1;
  }
  const day = Math.min(anchorDay, daysInMonth(year, month));
  return { start, end: atWallTimeOf(start, { year, month, day }) };
}

/** `instant` plus `days` Brussels calendar days at the same wall-clock time (DST-safe). */
export function addBrusselsDays(instant: Date, days: number): Date {
  return atWallTimeOf(instant, addCalendarDays(brusselsDateOf(instant), days));
}

export type DunningSettings = { retryDays: number[]; expireDay: number };

/** `settings.credits.dunning_retry_days` [3, 7] and `dunning_expire_day` 10. */
export const DEFAULT_DUNNING: DunningSettings = { retryDays: [3, 7], expireDay: 10 };

/**
 * Dunning dates after the first failure (rule 50): retry 2 on day 3, retry 3 on day 7, expiry on
 * day 10, at the wall-clock time of `firstFailureAt`. The link path (rule 52) passes the period
 * end (`current_period_end_at`) as `firstFailureAt`.
 */
export function dunningSchedule(
  firstFailureAt: Date,
  s: DunningSettings = DEFAULT_DUNNING,
): { retry2At: Date; retry3At: Date; expireAt: Date } {
  const [r2, r3] = s.retryDays;
  if (r2 === undefined || r3 === undefined) throw new RangeError("dunning retryDays needs two values");
  if (!(r2 > 0 && r3 > r2 && s.expireDay > r3)) throw new RangeError("dunning days must increase");
  return {
    retry2At: addBrusselsDays(firstFailureAt, r2),
    retry3At: addBrusselsDays(firstFailureAt, r3),
    expireAt: addBrusselsDays(firstFailureAt, s.expireDay),
  };
}

/**
 * The lead dates before a period end (rules 48, 52, 56): the automatic charge
 * (`renewal_charge_lead_days`, 3), the link renewal order (`renewal_link_lead_days`, 7) and the
 * second link reminder (3 days before).
 */
export function renewalLeadDates(
  periodEndAt: Date,
  s: { chargeLeadDays: number; linkLeadDays: number } = { chargeLeadDays: 3, linkLeadDays: 7 },
): { chargeAt: Date; linkOrderAt: Date; linkReminderAt: Date } {
  return {
    chargeAt: addBrusselsDays(periodEndAt, -s.chargeLeadDays),
    linkOrderAt: addBrusselsDays(periodEndAt, -s.linkLeadDays),
    linkReminderAt: addBrusselsDays(periodEndAt, -s.chargeLeadDays),
  };
}

/**
 * The renewal reminder windows of a membership (rule 56): yearly plans get the
 * `yearly_reminder_days` (30, 7); monthly plans get `monthly_reminder_days` (7) only when they
 * have no valid mandate or are ending (`cancel_at` set).
 */
export function renewalReminderDays(i: {
  interval: MembershipInterval;
  hasValidMandate: boolean;
  isEnding: boolean;
  yearlyDays?: number[];
  monthlyDays?: number[];
}): number[] {
  if (i.interval === "year") return [...(i.yearlyDays ?? [30, 7])];
  return !i.hasValidMandate || i.isEnding ? [...(i.monthlyDays ?? [7])] : [];
}
