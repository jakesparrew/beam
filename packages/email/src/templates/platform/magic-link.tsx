/** `platform.magic_link` (PL-11): the customer sign-in link, valid 15 minutes, single use. */
import { z } from "zod";
import { EmailButton, EmailHeading, EmailLayout, EmailText } from "../../layout";
import type { TemplateComponentProps } from "../define";

export const MagicLinkProps = z.object({
  url: z.string().url(),
  expiresMinutes: z.number().int().positive(),
});

export function MagicLink({ url, copy, locale }: TemplateComponentProps<typeof MagicLinkProps>) {
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
