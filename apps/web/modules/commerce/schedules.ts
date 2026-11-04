/**
 * commerce schedules (`defineSchedule`, cron in Europe/Brussels, commerce spec section 4.6).
 * Facade read by `pnpm gen:indexes`: every `kind` is a literal and has a job in `jobs.ts`. A
 * schedule is added together with its job (commerce-P4b: `payments.scan_expired`; commerce-P5: `checkouts.mark_abandoned`).
 */
import { defineSchedule } from "@/lib/job-runner";

export const schedules = [
  defineSchedule({ kind: "payments.scan_expired", cron: "* * * * *", catchUp: false }),
  defineSchedule({ kind: "checkouts.mark_abandoned", cron: "*/10 * * * *", catchUp: false }),
];
