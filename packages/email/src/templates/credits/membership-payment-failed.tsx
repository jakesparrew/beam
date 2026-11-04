/**
 * `credits.membership_payment_failed` (credits rules 50 and 52): the renewal payment failed or the
 * period ended unpaid (day 0), and the reminders on day 3 and 7, each with the BEAM pay link of
 * the renewal order and the date the membership ends without payment.
 */
import { z } from "zod";
import { formatDate, t } from "@beam/core/i18n";
import { EmailButton, EmailHeading, EmailLayout, EmailText } from "../../layout";
import type { TemplateComponentProps } from "../define";

export const MembershipPaymentFailedProps = z.object({
  membershipId: z.string().uuid(),
  planName: z.string().min(1),
  /** 1 = first failure, 2 = day-3 reminder, 3 = day-7 reminder. */
  attempt: z.number().int().min(1).max(3),
  payUrl: z.string().url(),
  /** The day the membership expires when still unpaid (day 10). */
  expiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  accountUrl: z.string().url(),
});

export const membershipPaymentFailedSample: z.infer<typeof MembershipPaymentFailedProps> = {
  membershipId: "6f1c1f9e-0b7a-4c39-9a51-0d2b6f6f3a11",
  planName: "Vitality Monthly",
  attempt: 1,
  payUrl: "https://beam.example.com/nl-BE/pay/tok_renewal",
  expiresOn: "2026-12-11",
  accountUrl: "https://beam.example.com/nl-BE/account/membership",
};

export function MembershipPaymentFailed({ payUrl, expiresOn, copy, locale }: TemplateComponentProps<typeof MembershipPaymentFailedProps>) {
  return (
    <EmailLayout locale={locale} preheader={copy.preheader}>
      <EmailHeading>{copy.heading}</EmailHeading>
      <EmailText>{copy.body}</EmailText>
      <EmailText>{t(locale, "credits.email.membership_payment_failed.deadline", { date: formatDate(expiresOn, locale, "long") })}</EmailText>
      <EmailButton href={payUrl} locale={locale}>
        {copy.cta}
      </EmailButton>
      <EmailText muted>{t(locale, "credits.email.membership_payment_failed.keeps_access")}</EmailText>
    </EmailLayout>
  );
}
