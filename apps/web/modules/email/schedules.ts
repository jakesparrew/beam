/**
 * email schedules (`defineSchedule`, cron in Europe/Brussels; email spec section 4 "Schedules").
 * Facade read by `pnpm gen:indexes`. email-P3 adds the props purge and the domain check; the
 * campaign dispatch, the complaint and delivery watches and the stats freeze come with the
 * packages that add their jobs.
 */
import { defineSchedule } from "@/lib/job-runner";

export const schedules = [
  defineSchedule({ kind: "email.purge_props", cron: "20 2 * * *" }),
  defineSchedule({ kind: "email.check_domains", cron: "10 5 * * *" }),
] as const;
