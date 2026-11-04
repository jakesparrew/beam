/**
 * forms schedules (forms spec section 4 "Schedules", cron in Europe/Brussels). Facade read by
 * `pnpm gen:indexes`. `forms.check_cta_targets` runs at 02:50, after `files.purge_expired` (02:00)
 * and before `sessions.materialise` (03:10).
 */
import { defineSchedule } from "@/lib/job-runner";

export const schedules = [
  defineSchedule({ kind: "forms.mark_abandoned", cron: "*/10 * * * *" }),
  defineSchedule({ kind: "forms.check_cta_targets", cron: "50 2 * * *" }),
];
