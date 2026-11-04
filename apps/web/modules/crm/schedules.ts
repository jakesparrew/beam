/**
 * crm schedules (crm spec 4.5, cron in Europe/Brussels). Facade read by `pnpm gen:indexes`.
 * `segments.refresh` runs at minute 7 to stay clear of other hourly work (decision 27).
 * R3 schedules are added by crm-P8 and crm-P9.
 */
import { defineSchedule } from "@/lib/job-runner";

export const schedules = [
  defineSchedule({ kind: "segments.refresh", cron: "7 * * * *" }),
  defineSchedule({ kind: "crm.detect_duplicates", cron: "50 3 * * *" }),
];
