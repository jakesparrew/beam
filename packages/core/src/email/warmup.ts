/**
 * Warm-up caps of `news.beam.be` (email spec rules 6 to 8). Pure.
 *
 * `settings.warmup_schedule = { domain: 'news.beam.be', start_on, daily_caps: [1000, 2000, 4000,
 * 8000] }`. For a Brussels calendar day `today`, week `w = floor((today - start_on) / 7)` and the
 * cap is `daily_caps[w]`; from week 4 on (past the list) there is no cap. Before `start_on` the
 * first week's cap applies; without `start_on` (go-live not set) the first week's cap applies
 * too, so nothing floods a cold domain. `mail.beam.be` has no cap.
 */
import { z } from "zod";
import { addDays, brusselsDate, brusselsInstant, daysBetween } from "./send-window";

export const DEFAULT_WARMUP_CAPS = [1000, 2000, 4000, 8000] as const;

export const WarmupScheduleSchema = z.object({
  domain: z.literal("news.beam.be"),
  start_on: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  daily_caps: z.array(z.number().int().positive()),
});

export type WarmupSchedule = z.infer<typeof WarmupScheduleSchema>;

export const DEFAULT_WARMUP_SCHEDULE: WarmupSchedule = { domain: "news.beam.be", start_on: null, daily_caps: [...DEFAULT_WARMUP_CAPS] };

/** The 0-based warm-up week of the Brussels day of `day`. */
export function warmupWeek(schedule: Pick<WarmupSchedule, "start_on">, day: Date): number {
  if (!schedule.start_on) return 0;
  const days = daysBetween(schedule.start_on, brusselsDate(day));
  return days < 0 ? 0 : Math.floor(days / 7);
}

/** The cap of sends from `news.beam.be` on the Brussels day of `day`, or `null` when uncapped. */
export function warmupCap(schedule: WarmupSchedule, day: Date): number | null {
  const caps = schedule.daily_caps;
  if (!caps.length) return null;
  return caps[warmupWeek(schedule, day)] ?? null;
}

/** True while a cap applies on that day (rule 8: order recipients by engagement). */
export function isWarmingUp(schedule: WarmupSchedule, day: Date): boolean {
  return warmupCap(schedule, day) !== null;
}

/** How many more messages may leave today: `null` = uncapped. */
export function warmupRemaining(schedule: WarmupSchedule, day: Date, sentToday: number): number | null {
  const cap = warmupCap(schedule, day);
  return cap === null ? null : Math.max(0, cap - sentToday);
}

/**
 * When a capped chunk continues (rule 7): 09:00 Brussels on the next calendar day, and the key
 * qualifier `:d<YYYY-MM-DD>` of that continuation day.
 */
export function warmupContinuation(now: Date): { runAt: Date; day: string; keyQualifier: string } {
  const day = addDays(brusselsDate(now), 1);
  return { runAt: brusselsInstant(day, 9, 0), day, keyQualifier: `:d${day}` };
}
