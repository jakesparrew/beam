/**
 * `ops.privacy_export_ready` (ops rule 60): the subject's data export is ready in the portal.
 * Copy: `ops.email.privacy_export_ready.<slot>`; `{date}` in the body is the expiry date. The
 * link opens the portal privacy page (the download needs the customer's own session).
 */
import { z } from "zod";
import { formatDate } from "@beam/core/i18n";
import { EmailButton, EmailHeading, EmailLayout, EmailText } from "../../layout";
import type { TemplateComponentProps } from "../define";

export const PrivacyExportReadyProps = z.object({
  requestId: z.string().uuid(),
  /** Brussels date the download expires (`YYYY-MM-DD`). */
  expiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
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
  expiresOn: "2026-11-11",
  accountUrl: "https://beam.example.com/nl-BE/account/privacy",
};

export function PrivacyExportReady({ expiresOn, accountUrl, copy, locale }: TemplateComponentProps<typeof PrivacyExportReadyProps>) {
  const date = formatDate(expiresOn, locale, "long");
  return (
    <EmailLayout locale={locale} preheader={copy.preheader} footer={copy.footer}>
      <EmailHeading>{copy.heading}</EmailHeading>
      <EmailText>{(copy.body ?? "").replace("{date}", date)}</EmailText>
      <EmailButton href={accountUrl} locale={locale}>
        {copy.cta}
      </EmailButton>
    </EmailLayout>
  );
}
