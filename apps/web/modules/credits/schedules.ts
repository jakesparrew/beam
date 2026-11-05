/**
 * credits schedules (`defineSchedule`, cron in Europe/Brussels; credits spec section 4
 * "Schedules"). Facade read by `pnpm gen:indexes`. A schedule is added together with its job:
 * `credits.expire_grants` (credits-P3), `memberships.scan_renewals` (credits-P4) and
 * `ledger.reconcile` (credits-P5); R3 `credits.attribute_referrals` and
 * `credits.qualify_referral_rewards` (credits-P9).
 * `credits.bulk_extend` has no schedule (enqueued by the bulk extension action).
 */
import { defineSchedule } from "@/lib/job-runner";

export const schedules = [
  defineSchedule({ kind: "credits.expire_grants", cron: "5 0 * * *" }),
  defineSchedule({ kind: "memberships.scan_renewals", cron: "10 6 * * *" }),
  defineSchedule({ kind: "ledger.reconcile", cron: "30 4 * * *" }),
  defineSchedule({ kind: "credits.attribute_referrals", cron: "*/10 * * * *" }),
  defineSchedule({ kind: "credits.qualify_referral_rewards", cron: "10 5 * * *" }),
];
