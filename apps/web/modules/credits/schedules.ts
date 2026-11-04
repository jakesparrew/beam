/**
 * credits schedules (`defineSchedule`, cron in Europe/Brussels; credits spec section 4
 * "Schedules"). Facade read by `pnpm gen:indexes`. A schedule is added together with its job:
 * `credits.expire_grants` (credits-P3) and `memberships.scan_renewals` (credits-P4) here;
 * `ledger.reconcile` (credits-P5) and the R3 referral schedules (credits-P9) with theirs.
 * `credits.bulk_extend` has no schedule (enqueued by the bulk extension action).
 */
import { defineSchedule } from "@/lib/job-runner";

export const schedules = [
  defineSchedule({ kind: "credits.expire_grants", cron: "5 0 * * *" }),
  defineSchedule({ kind: "memberships.scan_renewals", cron: "10 6 * * *" }),
];
