/**
 * automation schedules (automation spec 4.5, cron in Europe/Brussels). Facade read by
 * `pnpm gen:indexes`. Minute-level crons never catch up (PL-33). automation-P3 adds
 * `automation.sweep_enrolments` (every 15 minutes) with its job.
 */
import { defineSchedule } from "@/lib/job-runner";

export const schedules = [defineSchedule({ kind: "automation.evaluate", cron: "* * * * *", catchUp: false })];
