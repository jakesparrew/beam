/**
 * `credits.membership_cancel_confirmed` (credits rules 53 and 54): the cancellation is recorded,
 * at period end (`immediate: false`, access until `endsOn`) or at once.
 */
import { z } from "zod";
import { formatDate, t } from "@beam/core/i18n";
import { EmailButton, EmailHeading, EmailLayout, EmailText } from "../../layout";
import type { TemplateComponentProps } from "../define";

export const MembershipCancelConfirmedProps = z.object({
  membershipId: z.string().uuid(),
  planName: z.string().min(1),
  immediate: z.boolean(),
  endsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  accountUrl: z.string().url(),
});

export const membershipCancelConfirmedSample: z.infer<typeof MembershipCancelConfirmedProps> = {
  membershipId: "6f1c1f9e-0b7a-4c39-9a51-0d2b6f6f3a11",
  planName: "Vitality Monthly",
  immediate: false,
  endsOn: "2026-12-04",
  accountUrl: "https://beam.example.com/nl-BE/account/membership",
};

export function MembershipCancelConfirmed({ immediate, endsOn, accountUrl, copy, locale }: TemplateComponentProps<typeof MembershipCancelConfirmedProps>) {
  const date = formatDate(endsOn, locale, "long");
  return (
    <EmailLayout locale={locale} preheader={copy.preheader}>
      <EmailHeading>{copy.heading}</EmailHeading>
      <EmailText>
        {immediate
          ? t(locale, "credits.email.membership_cancel_confirmed.ended_now", { date })
          : t(locale, "credits.email.membership_cancel_confirmed.ends_on", { date })}
      </EmailText>
      <EmailText>{copy.body}</EmailText>
      <EmailButton href={accountUrl} locale={locale}>
        {copy.cta}
      </EmailButton>
    </EmailLayout>
  );
}
