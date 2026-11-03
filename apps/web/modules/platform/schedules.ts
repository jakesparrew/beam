/** Platform schedules (platform spec 4.6, cron in Europe/Brussels). Facade read by `pnpm gen:indexes`. */
import { defineSchedule } from "@/lib/job-runner";

export const schedules = [
  defineSchedule({ kind: "platform.check_alerts", cron: "*/5 * * * *", catchUp: false }),
  defineSchedule({ kind: "platform.prune_ephemeral", cron: "17 * * * *", catchUp: true }),
  defineSchedule({ kind: "files.purge_expired", cron: "0 2 * * *", catchUp: true }),
  defineSchedule({ kind: "jobs.prune", cron: "30 3 * * *", catchUp: true }),
  defineSchedule({ kind: "platform.build_monthly_report", cron: "10 7 1 * *", catchUp: true }),
];
