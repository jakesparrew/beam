/**
 * `ops.privacy_erasure_scheduled` (ops rules 61, 64): sent at verification of an erasure, because
 * no address exists afterwards. States the date, what is retained and how to cancel within the
 * 24-hour window. Never sent for system requests of the retention sweep.
 * Copy: `ops.email.privacy_erasure_scheduled.<slot>`; `{date}` in the body is the start date.
 */
import { z } from "zod";
import { formatDate } from "@beam/core/i18n";
import { EmailButton, EmailHeading, EmailLayout, EmailText } from "../../layout";
import type { TemplateComponentProps } from "../define";

export const PrivacyErasureScheduledProps = z.object({
  requestId: z.string().uuid(),
  /** When the erasure starts (ISO instant, `scheduled_for_at`). */
  scheduledForAt: z.string().min(10),
  accountUrl: z.string().url(),
});

export const privacyErasureScheduledSlots = {
  subject: "ops.email.privacy_erasure_scheduled.subject",
  heading: "ops.email.privacy_erasure_scheduled.heading",
  body: "ops.email.privacy_erasure_scheduled.body",
  retained: "ops.email.privacy_erasure_scheduled.retained",
  cta: "ops.email.privacy_erasure_scheduled.button",
} as const;

export const privacyErasureScheduledSample: z.infer<typeof PrivacyErasureScheduledProps> = {
  requestId: "4b1f6c1e-7f0a-4d2e-9a51-0d2b6f6f3a11",
  scheduledForAt: "2026-11-05T10:00:00.000Z",
  accountUrl: "https://beam.example.com/nl-BE/account/privacy",
};

export function PrivacyErasureScheduled({ scheduledForAt, accountUrl, copy, locale }: TemplateComponentProps<typeof PrivacyErasureScheduledProps>) {
  const date = formatDate(new Date(scheduledForAt), locale, "long");
  return (
    <EmailLayout locale={locale} preheader={copy.preheader}>
      <EmailHeading>{copy.heading}</EmailHeading>
      <EmailText>{(copy.body ?? "").replace("{date}", date)}</EmailText>
      <EmailText>{copy.retained}</EmailText>
      <EmailButton href={accountUrl} locale={locale}>
        {copy.cta}
      </EmailButton>
    </EmailLayout>
  );
}
