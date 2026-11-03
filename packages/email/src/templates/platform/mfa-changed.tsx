/**
 * `platform.mfa_changed` (PL-9): the security notice after a password change, a password
 * reset, an MFA reset or new recovery codes, so a takeover attempt is noticed.
 */
import { z } from "zod";
import { formatDateTime, t } from "@beam/core/i18n";
import { EmailButton, EmailHeading, EmailLayout, EmailText } from "../../layout";
import type { TemplateComponentProps } from "../define";

export const MFA_CHANGES = ["password_changed", "password_reset", "mfa_reset", "recovery_codes_regenerated"] as const;

export const MfaChangedProps = z.object({
  change: z.enum(MFA_CHANGES),
  /** ISO timestamp of the change (shown in Brussels time). */
  occurredAt: z.string().datetime({ offset: true }),
  /** The staff account page. */
  url: z.string().url(),
});

export function MfaChanged({ change: _change, occurredAt, url, copy, locale }: TemplateComponentProps<typeof MfaChangedProps>) {
  return (
    <EmailLayout locale={locale} preheader={copy.preheader}>
      <EmailHeading>{copy.heading}</EmailHeading>
      <EmailText>{copy.body}</EmailText>
      <EmailText muted>
        {t(locale, "platform.email.mfa_changed.when_label")}: {formatDateTime(occurredAt, locale, "long")}
      </EmailText>
      <EmailButton href={url} locale={locale}>
        {copy.cta}
      </EmailButton>
    </EmailLayout>
  );
}
