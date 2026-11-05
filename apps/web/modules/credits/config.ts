/**
 * credits settings (02-data-model 5.4, credits rule 6a). Facade read by `pnpm gen:indexes`.
 * The `credits` key uses the `CreditsSettings` Zod schema and the rule 6a defaults of
 * `@beam/core/credits` (Convention 3: snake_case fields); edited only through platform's
 * `updateSetting`. `referrals` (R3, credits-P9, rule 62): the default referrer and referee
 * rewards, the yearly cap of rewarded referrals, the qualification days and the commission window.
 */
import type { z } from "zod";
import { CREDITS_SETTINGS_DEFAULTS, CreditsSettings, REFERRALS_SETTINGS_DEFAULTS, ReferralsSettings } from "@beam/core/credits";
import { defineSetting } from "@/lib/settings";

export { CreditsSettings, ReferralsSettings };

export const settings = [
  defineSetting({
    key: "credits",
    schema: CreditsSettings,
    default: structuredClone(CREDITS_SETTINGS_DEFAULTS) as unknown as z.infer<typeof CreditsSettings>,
    description: "Usage thresholds, expiry warnings, sharing, extensions, renewals and dunning",
  }),
  defineSetting({
    key: "referrals",
    schema: ReferralsSettings,
    default: structuredClone(REFERRALS_SETTINGS_DEFAULTS),
    description: "Referral rewards, yearly cap, qualification days and commission window",
  }),
] as const;

export const flags = [] as const;
