/**
 * `ops.privacy_export_ready` (ops rule 60): the subject's data export is ready in the portal.
 * Copy: `ops.email.privacy_export_ready.<slot>`; `{date}` in the body is the expiry date (the
 * `date` prop, formatted by the sender in the recipient's locale, becomes the ICU param). The
 * link opens the portal privacy page (the download needs the customer's own session).
 */
import { z } from "zod";
import { EmailButton, EmailHeading, EmailLayout, EmailText } from "../../layout";
import type { TemplateComponentProps } from "../define";

export const PrivacyExportReadyProps = z.object({
  requestId: z.string().uuid(),
  /** The expiry date, formatted in the recipient's locale (`{date}` of the body). */
  date: z.string().min(1).max(60),
  accountUrl: z.string().url(),
});

export const privacyExportReadySlots = {
  subject: "ops.email.privacy_export_ready.subject",
  heading: "ops.email.privacy_export_ready.heading",
  body: "ops.email.privacy_export_ready.body",
  cta: "ops.email.privacy_export_ready.button",
  footer: "ops.email.privacy_export_ready.footer",
} as const;

export const privacyExportReadySample: z.infer<typeof PrivacyExportReadyProps> = {
  requestId: "4b1f6c1e-7f0a-4d2e-9a51-0d2b6f6f3a11",
  date: "11 November 2026",
  accountUrl: "https://beam.example.com/nl-BE/account/privacy",
};

export function PrivacyExportReady({ accountUrl, copy, locale }: TemplateComponentProps<typeof PrivacyExportReadyProps>) {
  return (
    <EmailLayout locale={locale} preheader={copy.preheader} footer={copy.footer}>
      <EmailHeading>{copy.heading}</EmailHeading>
      <EmailText>{copy.body}</EmailText>
      <EmailButton href={accountUrl} locale={locale}>
        {copy.cta}
      </EmailButton>
    </EmailLayout>
  );
}
