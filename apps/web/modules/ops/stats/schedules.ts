/**
 * ops schedules, area `stats` (ops spec 4.5, Europe/Brussels). The crons are declared in
 * `../schedules.ts` (`ops.refresh_person_stats` 04:00, `ops.refresh_recent_stats` every 5
 * minutes, `ops.daily_digest` 08:00); this file keeps the area's constants so its tests read
 * one definition. No daily schedule runs between 02:00 and 03:00 (edge case 28).
 */
export const STATS_SCHEDULES = {
  "ops.refresh_person_stats": "0 4 * * *",
  "ops.refresh_recent_stats": "*/5 * * * *",
  "ops.daily_digest": "0 8 * * *",
} as const;

export type StatsScheduleKind = keyof typeof STATS_SCHEDULES;
