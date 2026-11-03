/** `platform.staff_invite` (PL-10): the invitation link to set a password, valid 72 hours, single use. */
import { z } from "zod";
import { EmailButton, EmailHeading, EmailLayout, EmailText } from "../../layout";
import type { TemplateComponentProps } from "../define";

export const StaffInviteProps = z.object({
  url: z.string().url(),
  expiresHours: z.number().int().positive(),
});

export function StaffInvite({ url, copy, locale }: TemplateComponentProps<typeof StaffInviteProps>) {
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
