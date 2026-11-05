/**
 * site schedules (`defineSchedule`, cron in Europe/Brussels). Facade read by `pnpm gen:indexes`.
 * V1 has none (publishing uses `run_at`). R4 (site-P10): the weekly content audit every Monday at
 * 07:10 (site spec section 4, decision 8).
 */
import { defineSchedule } from "@/lib/job-runner";

export const schedules = [defineSchedule({ kind: "site.audit_content", cron: "10 7 * * 1" })];
