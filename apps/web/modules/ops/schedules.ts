/**
 * ops schedules (ops spec 4.5, cron in Europe/Brussels). Facade read by `pnpm gen:indexes`:
 * every `kind` is a literal and has a job in `jobs.ts`. Written once by ops-P1.
 *
 * Registered by fix-w05-schema-1 once platform's schedule tests filtered on platform kinds
 * (fix-w04-platform-3). The handlers stay no-ops until ops-P2, P6, P7, P8 and P10 implement them;
 * R2-R4 handlers return early while their release flag is off.
 */
import { defineSchedule } from "@/lib/job-runner";

/** The eight ops schedules of spec 4.5. */
export const schedules = [
  defineSchedule({ kind: "privacy.retention_sweep", cron: "0 1 * * *", catchUp: true }),
  defineSchedule({ kind: "ops.refresh_person_stats", cron: "0 4 * * *", catchUp: true }),
  defineSchedule({ kind: "ops.refresh_recent_stats", cron: "*/5 * * * *", catchUp: false }),
  defineSchedule({ kind: "ops.daily_digest", cron: "0 8 * * *", catchUp: true }),
  defineSchedule({ kind: "ops.build_weekly_retention_list", cron: "10 6 * * 1", catchUp: true }),
  defineSchedule({ kind: "ads.pull_yesterday", cron: "30 5 * * *", catchUp: true }),
  defineSchedule({ kind: "ops.compute_attribution", cron: "50 5 * * *", catchUp: true }),
  defineSchedule({ kind: "ai.weekly_summary", cron: "30 6 * * 1", catchUp: true }),
];

/** @deprecated Kept for earlier imports (`ops-p1.facades.test.ts`); the same entries as `schedules`. */
export const PLANNED_SCHEDULES = schedules;
