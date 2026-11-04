/**
 * credits settings (02-data-model 5.4, credits rule 6a). Facade read by `pnpm gen:indexes`.
 * The `credits` key uses the `CreditsSettings` Zod schema and the rule 6a defaults of
 * `@beam/core/credits` (Convention 3: snake_case fields); edited only through platform's
 * `updateSetting`. `referrals` (R3) keeps its placeholder schema until credits-P9.
 */
import { z } from "zod";
import { CREDITS_SETTINGS_DEFAULTS, CreditsSettings } from "@beam/core/credits";
import { defineSetting } from "@/lib/settings";

export { CreditsSettings };

export const settings = [
  defineSetting({
    key: "credits",
    schema: CreditsSettings,
    default: structuredClone(CREDITS_SETTINGS_DEFAULTS) as unknown as z.infer<typeof CreditsSettings>,
    description: "Usage thresholds, expiry warnings, sharing, extensions, renewals and dunning",
  }),
  defineSetting({
    key: "referrals",
    schema: z.record(z.string(), z.unknown()),
    default: {},
    description: "Referral rewards, yearly cap, qualification days and commission window (R3; placeholder schema)",
  }),
] as const;

export const flags = [] as const;
