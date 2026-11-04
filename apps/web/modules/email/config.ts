/**
 * email settings (02-data-model 5.4, email spec section 3). Facade read by `pnpm gen:indexes`.
 * Wave 0 by platform-P7; email-P3 replaced the placeholder schemas without renaming the keys:
 *
 * - `email_footer`: the reason sentence per purpose (and `transactional`) and the RPR line, per
 *   locale (rules 4 and 5; defaults from `DEFAULT_FOOTER_SETTINGS` of `@beam/email`).
 * - `warmup_schedule`: the daily caps of `news.beam.be` during warm-up (rules 6 to 8).
 * - `email_config`: senders, Resend domain ids, bounce and complaint thresholds (rules 1, 37, 38).
 * - `email_brand`: tone of voice and guidelines for AI drafts (R4, section 6).
 */
import { z } from "zod";
import { WarmupScheduleSchema, DEFAULT_WARMUP_SCHEDULE } from "@beam/core/email";
import { LocalizedTextSchema } from "@beam/core/i18n";
import { DEFAULT_FOOTER_SETTINGS } from "@beam/email";
import { defineSetting } from "@/lib/settings";

export const EmailFooterSetting = z.object({
  reasons: z.object({
    transactional: LocalizedTextSchema,
    newsletter: LocalizedTextSchema,
    events: LocalizedTextSchema,
    member_comms: LocalizedTextSchema,
    b2b: LocalizedTextSchema,
  }),
  rpr: LocalizedTextSchema,
});
export type EmailFooterSetting = z.infer<typeof EmailFooterSetting>;

export const EmailConfig = z.object({
  senders: z.object({ transactional: z.string().min(3), marketing: z.string().min(3), reply_to: z.string().email() }),
  resend_domain_ids: z.record(z.string(), z.string()),
  bounce_pause_pct: z.number().min(0),
  bounce_min_sent: z.number().int().min(0),
  complaint_alert_pct: z.number().min(0),
  complaint_min_delivered: z.number().int().min(0),
});
export type EmailConfig = z.infer<typeof EmailConfig>;

export const EmailBrandSetting = z.object({
  tone_of_voice: z.string().max(4000),
  guidelines: z.string().max(8000),
  do_not_say: z.array(z.string().max(200)).max(200),
  sample_phrases: z.array(LocalizedTextSchema).max(50),
});
export type EmailBrandSetting = z.infer<typeof EmailBrandSetting>;

const footerDefault: EmailFooterSetting = {
  reasons: {
    transactional: DEFAULT_FOOTER_SETTINGS.reasons.transactional ?? {},
    newsletter: DEFAULT_FOOTER_SETTINGS.reasons.newsletter ?? {},
    events: DEFAULT_FOOTER_SETTINGS.reasons.events ?? {},
    member_comms: DEFAULT_FOOTER_SETTINGS.reasons.member_comms ?? {},
    b2b: DEFAULT_FOOTER_SETTINGS.reasons.b2b ?? {},
  },
  rpr: DEFAULT_FOOTER_SETTINGS.rpr,
};

export const settings = [
  defineSetting({
    key: "email_footer",
    schema: EmailFooterSetting,
    default: footerDefault,
    description: "Footer reason sentence per purpose and locale, and the RPR register line per locale",
  }),
  defineSetting({
    key: "warmup_schedule",
    schema: WarmupScheduleSchema,
    default: DEFAULT_WARMUP_SCHEDULE,
    description: "Daily sending caps of news.beam.be during the four warm-up weeks (start_on = go-live date)",
  }),
  defineSetting({
    key: "email_config",
    schema: EmailConfig,
    default: {
      senders: { transactional: "BEAM <hello@mail.beam.be>", marketing: "BEAM <news@news.beam.be>", reply_to: "info@beam.be" },
      resend_domain_ids: {},
      bounce_pause_pct: 2,
      bounce_min_sent: 100,
      complaint_alert_pct: 0.1,
      complaint_min_delivered: 500,
    },
    description: "Senders, Resend domain ids and the bounce and complaint thresholds",
  }),
  defineSetting({
    key: "email_brand",
    schema: EmailBrandSetting,
    default: { tone_of_voice: "", guidelines: "", do_not_say: [], sample_phrases: [] },
    description: "Tone of voice, guidelines, do-not-say list and sample phrases for AI campaign drafts (R4)",
  }),
] as const;

export const flags = [] as const;
