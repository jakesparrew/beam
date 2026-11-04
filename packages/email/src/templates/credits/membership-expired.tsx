/**
 * `credits.membership_expired` (credits rules 50 and 52): the renewal stayed unpaid until day 10
 * and the membership ended. A returning member buys a new membership in the shop.
 */
import { z } from "zod";
import { formatDate, t } from "@beam/core/i18n";
import { EmailButton, EmailHeading, EmailLayout, EmailText } from "../../layout";
import type { TemplateComponentProps } from "../define";

export const MembershipExpiredProps = z.object({
  membershipId: z.string().uuid(),
  planName: z.string().min(1),
  endedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  accountUrl: z.string().url(),
});

export const membershipExpiredSample: z.infer<typeof MembershipExpiredProps> = {
  membershipId: "6f1c1f9e-0b7a-4c39-9a51-0d2b6f6f3a11",
  planName: "Vitality Monthly",
  endedOn: "2026-12-14",
  accountUrl: "https://beam.example.com/nl-BE/account/membership",
};

export function MembershipExpired({ endedOn, accountUrl, copy, locale }: TemplateComponentProps<typeof MembershipExpiredProps>) {
  return (
    <EmailLayout locale={locale} preheader={copy.preheader}>
      <EmailHeading>{copy.heading}</EmailHeading>
      <EmailText>{copy.body}</EmailText>
      <EmailText>{t(locale, "credits.email.membership_expired.ended_on", { date: formatDate(endedOn, locale, "long") })}</EmailText>
      <EmailButton href={accountUrl} locale={locale}>
        {copy.cta}
      </EmailButton>
    </EmailLayout>
  );
}
