/**
 * `credits.membership_renewed` (credits rule 49, edge case 9): the renewal payment arrived and
 * the new period started; `late` when a late payment reactivated an expired membership.
 */
import { z } from "zod";
import { formatDate, t } from "@beam/core/i18n";
import { EmailButton, EmailHeading, EmailLayout, EmailText } from "../../layout";
import type { TemplateComponentProps } from "../define";

const dateOn = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const MembershipRenewedProps = z.object({
  membershipId: z.string().uuid(),
  planName: z.string().min(1),
  late: z.boolean(),
  periodStartOn: dateOn,
  periodEndOn: dateOn,
  accountUrl: z.string().url(),
});

export const membershipRenewedSample: z.infer<typeof MembershipRenewedProps> = {
  membershipId: "6f1c1f9e-0b7a-4c39-9a51-0d2b6f6f3a11",
  planName: "Vitality Monthly",
  late: false,
  periodStartOn: "2026-12-04",
  periodEndOn: "2027-01-04",
  accountUrl: "https://beam.example.com/nl-BE/account/membership",
};

export function MembershipRenewed({ late, periodStartOn, periodEndOn, accountUrl, copy, locale }: TemplateComponentProps<typeof MembershipRenewedProps>) {
  return (
    <EmailLayout locale={locale} preheader={copy.preheader}>
      <EmailHeading>{copy.heading}</EmailHeading>
      <EmailText>{copy.body}</EmailText>
      {late ? <EmailText>{t(locale, "credits.email.membership_renewed.late")}</EmailText> : null}
      <EmailText>
        {t(locale, "credits.email.membership_renewed.period", {
          start: formatDate(periodStartOn, locale, "long"),
          end: formatDate(periodEndOn, locale, "long"),
        })}
      </EmailText>
      <EmailButton href={accountUrl} locale={locale}>
        {copy.cta}
      </EmailButton>
    </EmailLayout>
  );
}
