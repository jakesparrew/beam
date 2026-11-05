/**
 * Frequency caps and quiet hours of marketing steps (A-32, automation-P7, R2). Pure: the step
 * job passes the time, the person's recent automation marketing sends and the rules from
 * `settings.automation_rules`; the answer is send, defer to the end of the quiet hours, or skip.
 *
 * Decisions:
 * - Quiet hours are judged first: a step due inside the window (Brussels wall clock, a window
 *   whose end is before its start crosses midnight) is deferred to the next `quiet_end`
 *   (08:00 by default, DST-safe), and the caps are judged again when it runs then, so the cap
 *   counts what was really sent by the time of the send.
 * - The windows are trailing: "per day" is the 24 hours before `now`, "per week" the 7 days
 *   before `now` (both exclusive of sends after `now`). A send exactly 24 hours (or 7 days) ago
 *   falls outside.
 * - A cap of 0 skips every marketing step; `quiet_start = quiet_end` means no quiet hours.
 * - Transactional templates never reach this function (the caller exempts them).
 */
import { DAY_MS, isWithinBrusselsWindow, nextBrusselsTime } from "./time";

/** The shape of `settings.automation_rules` (declared with its Zod schema in the app's `config.ts`). */
export type AutomationRules = {
  max_marketing_per_day: number;
  max_marketing_per_week: number;
  /** `HH:mm`, Europe/Brussels. */
  quiet_start: string;
  /** `HH:mm`, Europe/Brussels. */
  quiet_end: string;
  webhook_hosts?: readonly string[];
};

export type FrequencyDecision = { action: "send" } | { action: "defer"; until: Date } | { action: "skip" };

export type FrequencyInput = { now: Date; recentMarketingSends: Date[]; rules: AutomationRules };

/** The trailing windows (milliseconds). */
export const FREQUENCY_DAY_MS = DAY_MS;
export const FREQUENCY_WEEK_MS = 7 * DAY_MS;

/** Sends in the trailing window `(now - windowMs, now]`. */
export function countSendsWithin(sends: readonly Date[], now: Date, windowMs: number): number {
  const t = now.getTime();
  return sends.filter((s) => {
    const x = s.getTime();
    return x > t - windowMs && x <= t;
  }).length;
}

/** True when `now` lies inside the quiet hours of the rules. */
export function isQuietTime(now: Date, rules: Pick<AutomationRules, "quiet_start" | "quiet_end">): boolean {
  return isWithinBrusselsWindow(now, rules.quiet_start, rules.quiet_end);
}

/**
 * A-32: `defer` until the end of the quiet hours when `now` is inside them; else `skip` when the
 * person already had `max_marketing_per_day` automation marketing emails in the last 24 hours or
 * `max_marketing_per_week` in the last 7 days; else `send`.
 */
export function applyFrequencyRules(input: FrequencyInput): FrequencyDecision {
  const { now, recentMarketingSends, rules } = input;
  if (isQuietTime(now, rules)) return { action: "defer", until: nextBrusselsTime(now, rules.quiet_end) };
  if (countSendsWithin(recentMarketingSends, now, FREQUENCY_DAY_MS) >= rules.max_marketing_per_day) return { action: "skip" };
  if (countSendsWithin(recentMarketingSends, now, FREQUENCY_WEEK_MS) >= rules.max_marketing_per_week) return { action: "skip" };
  return { action: "send" };
}

/** The machine reason of a cap skip: which cap was hit (`cap_day:1` or `cap_week:3`). */
export function frequencyCapReason(input: FrequencyInput): string | null {
  const { now, recentMarketingSends, rules } = input;
  if (countSendsWithin(recentMarketingSends, now, FREQUENCY_DAY_MS) >= rules.max_marketing_per_day) return `cap_day:${rules.max_marketing_per_day}`;
  if (countSendsWithin(recentMarketingSends, now, FREQUENCY_WEEK_MS) >= rules.max_marketing_per_week) return `cap_week:${rules.max_marketing_per_week}`;
  return null;
}
