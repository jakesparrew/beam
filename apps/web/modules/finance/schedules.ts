/**
 * finance schedules (`defineSchedule`, cron in Europe/Brussels, finance spec 4.6). Facade read by
 * `pnpm gen:indexes`; every kind has its job in `jobs.ts` (finance-P4).
 */
import { defineSchedule } from "@/lib/job-runner";

export const schedules = [
  /** Paid status of bank-transfer invoices, re-queue of stuck pushes, the 60-minute alert (rules 26, 34, 35). */
  defineSchedule({ kind: "billit.sync_pending", cron: "*/15 * * * *", catchUp: false }),
  /** Daily 05:15, after `ledger.reconcile` (04:30). */
  defineSchedule({ kind: "billit.reconcile", cron: "15 5 * * *", catchUp: true }),
  /** Daily 07:40, before `ops.daily_digest` (08:00). */
  defineSchedule({ kind: "finance.scan_overdue", cron: "40 7 * * *", catchUp: true }),
];
