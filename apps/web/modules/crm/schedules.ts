/**
 * crm schedules (crm spec 4.5, cron in Europe/Brussels). Facade read by `pnpm gen:indexes`.
 * `segments.refresh` runs at minute 7 to stay clear of other hourly work (decision 27).
 * R3: crm-P8 adds the pipeline schedules, crm-P9 the inbox schedules.
 */
import { defineSchedule } from "@/lib/job-runner";

export const schedules = [
  defineSchedule({ kind: "segments.refresh", cron: "7 * * * *" }),
  defineSchedule({ kind: "crm.detect_duplicates", cron: "50 3 * * *" }),
  defineSchedule({ kind: "crm.escalate_opportunities", cron: "20 * * * *" }),
  defineSchedule({ kind: "crm.apply_btoc_playbook", cron: "*/5 * * * *" }),
  defineSchedule({ kind: "crm.escalate_threads", cron: "25 * * * *" }),
  defineSchedule({ kind: "crm.close_stale_threads", cron: "10 5 * * *" }),
];
