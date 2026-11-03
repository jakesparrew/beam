/**
 * credits settings (02-data-model 5.4, credits rule 6a). Facade read by `pnpm gen:indexes`.
 * Wave 0 by platform-P7; credits owns it from credits-P1 on.
 */
import { z } from "zod";
import { defineSetting } from "@/lib/settings";

const ints = z.array(z.number().int().positive());

export const CreditsSettings = z.object({
  threshold_pcts: z.array(z.number().int().min(1).max(100)),
  expiry_warning_days: ints,
  max_named_shares_per_grant: z.number().int().min(0),
  max_extension_years: z.number().int().min(1),
  reinstate_window_days: z.number().int().positive(),
  renewal_charge_lead_days: z.number().int().min(0),
  renewal_link_lead_days: z.number().int().min(0),
  dunning_retry_days: ints,
  dunning_expire_day: z.number().int().positive(),
  yearly_reminder_days: ints,
  monthly_reminder_days: ints,
  failed_renewals_alert_per_day: z.number().int().positive(),
});

export const settings = [
  defineSetting({
    key: "credits",
    schema: CreditsSettings,
    default: {
      threshold_pcts: [50, 75, 80, 90],
      expiry_warning_days: [30, 7],
      max_named_shares_per_grant: 5,
      max_extension_years: 5,
      reinstate_window_days: 365,
      renewal_charge_lead_days: 3,
      renewal_link_lead_days: 7,
      dunning_retry_days: [3, 7],
      dunning_expire_day: 10,
      yearly_reminder_days: [30, 7],
      monthly_reminder_days: [7],
      failed_renewals_alert_per_day: 3,
    },
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
