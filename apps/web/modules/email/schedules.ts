/**
 * email schedules (`defineSchedule`, cron in Europe/Brussels; email spec section 4 "Schedules").
 * Facade read by `pnpm gen:indexes`. email-P3 adds the props purge and the domain check, email-P6
 * the minute campaign dispatch (rule 31); email-P7 the complaint watch (rule 38, every 15
 * minutes), the delivery watch (rule 38a, every 5 minutes) and the nightly stats freeze (rule 62).
 */
import { defineSchedule } from "@/lib/job-runner";

export const schedules = [
  defineSchedule({ kind: "email.purge_props", cron: "20 2 * * *" }),
  defineSchedule({ kind: "email.check_domains", cron: "10 5 * * *" }),
  defineSchedule({ kind: "email.dispatch_due_campaigns", cron: "* * * * *", catchUp: false }),
  defineSchedule({ kind: "email.watch_complaints", cron: "*/15 * * * *", catchUp: false }),
  defineSchedule({ kind: "email.watch_delivery", cron: "*/5 * * * *", catchUp: false }),
  defineSchedule({ kind: "email.freeze_due_stats", cron: "40 4 * * *" }),
] as const;
