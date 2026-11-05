/**
 * `credits.share_invitation` (credits rule 41, R2): a package owner (or BEAM staff on their
 * behalf) shared a package of sessions or nights with the recipient by name; they book on their
 * own account and the units come from the owner's package, up to `maxUnits` when set. The owner
 * appears as first name and last initial (rule 38).
 */
import { z } from "zod";
import { t } from "@beam/core/i18n";
import { EmailButton, EmailHeading, EmailLayout, EmailText } from "../../layout";
import type { TemplateComponentProps } from "../define";

export const ShareInvitationProps = z.object({
  shareId: z.string().uuid(),
  /** The owner as first name and last initial ("Anna D."). */
  ownerName: z.string().min(1),
  creditKind: z.enum(["day", "night"]),
  /** At most this many units for the recipient; null = up to what is left on the package. */
  maxUnits: z.number().int().positive().nullable(),
  /** The portal packages page, where shared packages are listed. */
  accountUrl: z.string().url(),
});

export const shareInvitationSample: z.infer<typeof ShareInvitationProps> = {
  shareId: "0b5f8f0e-61a4-4f4c-9d8a-2f8b8c1f2a77",
  ownerName: "Anna D.",
  creditKind: "day",
  maxUnits: 3,
  accountUrl: "https://beam.example.com/nl-BE/account/packages",
};

export function ShareInvitation({ ownerName, creditKind, maxUnits, accountUrl, copy, locale }: TemplateComponentProps<typeof ShareInvitationProps>) {
  return (
    <EmailLayout locale={locale} preheader={copy.preheader}>
      <EmailHeading>{copy.heading}</EmailHeading>
      <EmailText>
        {t(locale, creditKind === "night" ? "credits.email.share_invitation.what_night" : "credits.email.share_invitation.what_day", { name: ownerName })}
      </EmailText>
      <EmailText>{copy.body}</EmailText>
      {maxUnits != null ? <EmailText>{t(locale, "credits.email.share_invitation.limit", { count: maxUnits })}</EmailText> : null}
      <EmailButton href={accountUrl} locale={locale}>
        {copy.cta}
      </EmailButton>
    </EmailLayout>
  );
}
