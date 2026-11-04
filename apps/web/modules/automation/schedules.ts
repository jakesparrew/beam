/**
 * automation schedules (automation spec 4.5, cron in Europe/Brussels). Facade read by
 * `pnpm gen:indexes`. Minute-level crons never catch up (PL-33); a missed sweep is not caught
 * up either (the next one, 15 minutes later, sees the same state).
 */
import { defineSchedule } from "@/lib/job-runner";

export const schedules = [
  defineSchedule({ kind: "automation.evaluate", cron: "* * * * *", catchUp: false }),
  defineSchedule({ kind: "automation.sweep_enrolments", cron: "*/15 * * * *", catchUp: false }),
];
