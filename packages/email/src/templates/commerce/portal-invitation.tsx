/**
 * `commerce.portal_invitation` (commerce spec rule 26): after a paid site (guest) order, the
 * buyer without a portal account is invited to sign in with a magic link (key
 * `order:<order_id>:portal_invitation`). The link opens the portal sign-in page, which sends the
 * magic link to the same address.
 */
import { z } from "zod";
import { EmailButton, EmailHeading, EmailLayout, EmailText } from "../../layout";
import type { TemplateComponentProps } from "../define";

export const PortalInvitationProps = z.object({
  reference: z.string().min(1),
  /** The portal sign-in page. */
  url: z.string().url(),
});

export const portalInvitationSample: z.infer<typeof PortalInvitationProps> = {
  reference: "BO-7K3M9Q2X",
  url: "https://beam.example.com/nl/account/login",
};

export function PortalInvitation({ url, copy, locale }: TemplateComponentProps<typeof PortalInvitationProps>) {
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
