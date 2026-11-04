/**
 * `credits.membership_renewal_reminder` (credits rules 52 and 56): 30 and 7 days before a yearly
 * renewal, 7 days before a monthly one without a valid mandate, and the second link reminder 3
 * days before. `variant` is `ends` when the member cancelled at period end (`cancel_at` set).
 */
import { z } from "zod";
import { formatDate, formatMoney, t } from "@beam/core/i18n";
import { EmailButton, EmailHeading, EmailLayout, EmailText } from "../../layout";
import type { TemplateComponentProps } from "../define";

export const MembershipRenewalReminderProps = z.object({
  membershipId: z.string().uuid(),
  planName: z.string().min(1),
  variant: z.enum(["renews", "ends"]),
  days: z.number().int().positive(),
  periodEndOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** The renewal amount (VAT included), when known; absent for `ends`. */
  amountCents: z.number().int().min(0).optional(),
  /** The BEAM pay link of the renewal order (payment by link, no mandate). */
  payUrl: z.string().url().optional(),
  accountUrl: z.string().url(),
});

export const membershipRenewalReminderSample: z.infer<typeof MembershipRenewalReminderProps> = {
  membershipId: "6f1c1f9e-0b7a-4c39-9a51-0d2b6f6f3a11",
  planName: "Vitality Yearly",
  variant: "renews",
  days: 7,
  periodEndOn: "2026-12-04",
  amountCents: 89_000,
  payUrl: "https://beam.example.com/nl-BE/pay/tok_renewal",
  accountUrl: "https://beam.example.com/nl-BE/account/membership",
};

export function MembershipRenewalReminder({ variant, periodEndOn, amountCents, payUrl, accountUrl, copy, locale }: TemplateComponentProps<typeof MembershipRenewalReminderProps>) {
  const date = formatDate(periodEndOn, locale, "long");
  return (
    <EmailLayout locale={locale} preheader={copy.preheader}>
      <EmailHeading>{copy.heading}</EmailHeading>
      <EmailText>{copy.body}</EmailText>
      <EmailText>
        {variant === "ends"
          ? t(locale, "credits.email.membership_renewal_reminder.ends_on", { date })
          : t(locale, "credits.email.membership_renewal_reminder.renews_on", { date })}
      </EmailText>
      {variant === "renews" && amountCents !== undefined ? (
        <EmailText>{t(locale, "credits.email.membership_renewal_reminder.amount", { amount: formatMoney(amountCents, locale) })}</EmailText>
      ) : null}
      {variant === "renews" && payUrl ? (
        <EmailButton href={payUrl} locale={locale}>
          {t(locale, "credits.email.membership_renewal_reminder.pay_cta")}
        </EmailButton>
      ) : (
        <EmailButton href={accountUrl} locale={locale}>
          {copy.cta}
        </EmailButton>
      )}
    </EmailLayout>
  );
}
