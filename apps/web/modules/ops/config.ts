/**
 * ops settings and flags (ops spec 4 and 2.4, 02-data-model 5.4 and 5.5). Facade read by
 * `pnpm gen:indexes`. ops has no settings action of its own: `retention_defaults` is edited in
 * platform's generic editor `/admin/settings/[key]` and `ads` through platform's `updateSetting`
 * from the ads screen (cross-module decision 17); ops never calls `setSetting`. The default of
 * `retention_defaults` is also the row `packages/db/src/seed/ops.ts` seeds.
 */
import { ADS_SETTINGS_DEFAULT, AdsSettings, RETENTION_DEFAULTS, RetentionDefaults } from "@beam/core/ops";
import { defineSetting } from "@/lib/settings";

export const settings = [
  defineSetting({
    key: "retention_defaults",
    schema: RetentionDefaults,
    default: RETENTION_DEFAULTS,
    description: "Thresholds of the retention lists, the action dashboard windows and the B2C stage boundaries",
  }),
  defineSetting({
    key: "ads",
    schema: AdsSettings,
    default: ADS_SETTINGS_DEFAULT,
    description: "Ad accounts pulled by ads.pull_yesterday (R3)",
  }),
] as const;

export const flags = [
  { key: "ff_ops_retention", description: "Retention lists, B2C pipeline and the R2 reports (R2)" },
  { key: "ff_ops_marketing", description: "Management and marketing dashboards, attribution and ads (R3)" },
  { key: "ff_ops_ai", description: "NL questions, custom dashboards and the weekly summary (R4)" },
] as const;
