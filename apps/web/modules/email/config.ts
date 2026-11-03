/**
 * email settings (02-data-model 5.4, email spec section 3). Facade read by `pnpm gen:indexes`.
 * Wave 0 by platform-P7; email owns it from email-P1 on and replaces the placeholder schemas
 * without renaming the keys.
 */
import { z } from "zod";
import { defineSetting } from "@/lib/settings";

const placeholder = z.record(z.string(), z.unknown());

export const EmailConfig = z.object({
  senders: z.object({ transactional: z.string().min(3), marketing: z.string().min(3), reply_to: z.string().email() }),
  resend_domain_ids: z.record(z.string(), z.string()),
  bounce_pause_pct: z.number().min(0),
  bounce_min_sent: z.number().int().min(0),
  complaint_alert_pct: z.number().min(0),
  complaint_min_delivered: z.number().int().min(0),
});

export const settings = [
  defineSetting({
    key: "email_footer",
    schema: placeholder,
    default: {},
    description: "Footer reasons per purpose and locale, transactional footer and RPR line (placeholder schema)",
  }),
  defineSetting({
    key: "warmup_schedule",
    schema: placeholder,
    default: {},
    description: "Daily sending caps of news.beam.be during warm-up (placeholder schema)",
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
    schema: placeholder,
    default: {},
    description: "Tone of voice, guidelines, do-not-say list and sample phrases for AI drafts (placeholder schema)",
  }),
] as const;

export const flags = [] as const;
