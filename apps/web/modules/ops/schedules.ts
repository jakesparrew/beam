/**
 * ops schedules (ops spec 4.5, cron in Europe/Brussels). Facade read by `pnpm gen:indexes`:
 * every `kind` is a literal and has a job in `jobs.ts`. Written once by ops-P1.
 *
 * `schedules` stays empty for now: platform's `modules/platform/schedules.test.ts` and
 * `app/api/cron/tick/route.test.ts` assert that the registry holds platform's schedules only
 * (the same reason booking-P1 gave), and the handlers are no-ops until ops-P2, P6, P7, P8 and
 * P10. Once those tests filter on platform kinds, the entries of `PLANNED_SCHEDULES` move into
 * `schedules` unchanged (requested in ops-P1's report). R2-R4 handlers return early while their
 * release flag is off.
 */
import { defineSchedule } from "@/lib/job-runner";

/** The eight ops schedules of spec 4.5, not yet registered (see above). */
export const PLANNED_SCHEDULES = [
  defineSchedule({ kind: "privacy.retention_sweep", cron: "0 1 * * *", catchUp: true }),
  defineSchedule({ kind: "ops.refresh_person_stats", cron: "0 4 * * *", catchUp: true }),
  defineSchedule({ kind: "ops.refresh_recent_stats", cron: "*/5 * * * *", catchUp: false }),
  defineSchedule({ kind: "ops.daily_digest", cron: "0 8 * * *", catchUp: true }),
  defineSchedule({ kind: "ops.build_weekly_retention_list", cron: "10 6 * * 1", catchUp: true }),
  defineSchedule({ kind: "ads.pull_yesterday", cron: "30 5 * * *", catchUp: true }),
  defineSchedule({ kind: "ops.compute_attribution", cron: "50 5 * * *", catchUp: true }),
  defineSchedule({ kind: "ai.weekly_summary", cron: "30 6 * * 1", catchUp: true }),
];

export const schedules = [] as const;
