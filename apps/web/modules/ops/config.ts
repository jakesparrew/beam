/**
 * ops settings and flags (02-data-model 5.4 and 5.5). Facade read by `pnpm gen:indexes`.
 * Wave 0 by platform-P7; ops owns it from ops-P1 on and replaces the placeholder schema of
 * `retention_defaults` without renaming the key.
 */
import { z } from "zod";
import { defineSetting } from "@/lib/settings";

export const settings = [
  defineSetting({
    key: "retention_defaults",
    schema: z.record(z.string(), z.unknown()),
    default: {},
    description: "Thresholds of the eight retention lists and the webinar lead window (placeholder schema)",
  }),
  defineSetting({
    key: "ads",
    schema: z.object({ meta_account_ids: z.array(z.string()), google_customer_ids: z.array(z.string()) }),
    default: { meta_account_ids: [], google_customer_ids: [] },
    description: "Ad accounts pulled by ads.pull_yesterday (R3)",
  }),
] as const;

export const flags = [
  { key: "ff_ops_retention", description: "Retention lists and B2C pipeline screens (R2)" },
  { key: "ff_ops_marketing", description: "Ads and marketing dashboards (R3)" },
  { key: "ff_ops_ai", description: "NL questions, custom dashboards and the weekly summary (R4)" },
] as const;
