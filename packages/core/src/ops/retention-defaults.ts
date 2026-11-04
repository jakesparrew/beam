/**
 * `settings.retention_defaults` (ops spec 2.4): the thresholds of the retention lists, the
 * action dashboard windows and the B2C stage boundaries. The Zod schema lives here so the views'
 * SQL, the stats engine and the platform settings editor read one definition; the default is
 * declared in `apps/web/modules/ops/config.ts` and seeded by `packages/db/src/seed/ops.ts`.
 */
import { z } from "zod";

const days = z.number().int().min(1).max(3650);
const pct = z.number().int().min(1).max(100);

export const RetentionDefaults = z.object({
  visit_drop_ratio: z.number().gt(0).max(1),
  baseline_min_visits: z.number().int().min(1).max(100),
  nearly_finished_pct: pct,
  expiry_days: days,
  finished_no_repurchase_min_days: days,
  finished_no_repurchase_max_days: days,
  high_value_revenue_cents: z.number().int().min(0),
  vip_tag_key: z.string().regex(/^[a-z0-9_-]{1,64}$/),
  high_value_inactive_days: days,
  renewal_days: days,
  never_booked_days: days,
  unused_days: days,
  weekly_list_size: z.number().int().min(1).max(100),
  task_cooldown_days: days,
  new_lead_followup_hours: z.number().int().min(1).max(24 * 60),
  new_lead_window_days: days,
  webinar_lead_window_days: days,
  membership_expiring_days: days,
  guest_abuse_distinct_guests: z.number().int().min(1).max(100),
  guest_abuse_window_days: days,
  stage_retention_days: days,
  stage_lost_days: days,
  stage_engaged_window_days: days,
  no_show_pattern_count: z.number().int().min(1).max(100),
  no_show_pattern_days: days,
  dashboard_week_horizon_days: z.number().int().min(0).max(31),
});
export type RetentionDefaults = z.infer<typeof RetentionDefaults>;

/** The seeded value (ops spec 2.4); the default of `retention_defaults` in `modules/ops/config.ts`. */
export const RETENTION_DEFAULTS: RetentionDefaults = {
  visit_drop_ratio: 0.5,
  baseline_min_visits: 3,
  nearly_finished_pct: 80,
  expiry_days: 30,
  finished_no_repurchase_min_days: 14,
  finished_no_repurchase_max_days: 120,
  high_value_revenue_cents: 100000,
  vip_tag_key: "vip",
  high_value_inactive_days: 60,
  renewal_days: 30,
  never_booked_days: 14,
  unused_days: 45,
  weekly_list_size: 25,
  task_cooldown_days: 14,
  new_lead_followup_hours: 48,
  new_lead_window_days: 14,
  webinar_lead_window_days: 14,
  membership_expiring_days: 14,
  guest_abuse_distinct_guests: 3,
  guest_abuse_window_days: 30,
  stage_retention_days: 90,
  stage_lost_days: 365,
  stage_engaged_window_days: 90,
  no_show_pattern_count: 3,
  no_show_pattern_days: 90,
  dashboard_week_horizon_days: 7,
};

/** The three stage thresholds `computeB2cStage` reads (rules 9, 10, 13). */
export type StageThresholds = Pick<RetentionDefaults, "stage_retention_days" | "stage_lost_days" | "stage_engaged_window_days">;
