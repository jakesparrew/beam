/** `platform.password_reset` (PL-10): the reset link, valid 1 hour. */
import { z } from "zod";
import { EmailButton, EmailHeading, EmailLayout, EmailText } from "../../layout";
import type { TemplateComponentProps } from "../define";

export const PasswordResetProps = z.object({
  url: z.string().url(),
  expiresMinutes: z.number().int().positive(),
});

export function PasswordReset({ url, copy, locale }: TemplateComponentProps<typeof PasswordResetProps>) {
  return (
    <EmailLayout locale={locale} preheader={copy.preheader}>
      <EmailHeading>{copy.heading}</EmailHeading>
      <EmailText>{copy.body}</EmailText>
      <EmailButton href={url} locale={locale}>
        {copy.cta}
      </EmailButton>
    </EmailLayout>
  );
}
