/**
 * `credits.referral_reward` (credits rule 62, R3): a referral qualified 14 days after the friend's
 * first purchase, and the recipient received a thank-you package (`role = referrer`) or a welcome
 * package (`role = referee`). No name of the other person appears (ids-only data).
 */
import { z } from "zod";
import { formatDate, t } from "@beam/core/i18n";
import { EmailButton, EmailHeading, EmailLayout, EmailText } from "../../layout";
import type { TemplateComponentProps } from "../define";

export const ReferralRewardProps = z.object({
  attributionId: z.string().uuid(),
  role: z.enum(["referrer", "referee"]),
  creditKind: z.enum(["day", "night"]),
  units: z.number().int().positive(),
  /** ISO instant; null = no expiry. */
  expiresAt: z.string().datetime({ offset: true }).nullable(),
  /** The portal packages page, where the reward appears. */
  accountUrl: z.string().url(),
});

export const referralRewardSample: z.infer<typeof ReferralRewardProps> = {
  attributionId: "5d3c2b1a-0f9e-4d8c-8b7a-6e5f4d3c2b1a",
  role: "referrer",
  creditKind: "day",
  units: 1,
  expiresAt: "2027-05-04T21:59:59.999Z",
  accountUrl: "https://beam.example.com/nl-BE/account/packages",
};

export function ReferralReward({ role, creditKind, units, expiresAt, accountUrl, copy, locale }: TemplateComponentProps<typeof ReferralRewardProps>) {
  const what = creditKind === "night" ? "credits.email.referral_reward.what_night" : "credits.email.referral_reward.what_day";
  return (
    <EmailLayout locale={locale} preheader={copy.preheader}>
      <EmailHeading>{copy.heading}</EmailHeading>
      <EmailText>{t(locale, role === "referee" ? "credits.email.referral_reward.why_referee" : "credits.email.referral_reward.why_referrer")}</EmailText>
      <EmailText>{t(locale, what, { count: units })}</EmailText>
      {expiresAt ? <EmailText>{t(locale, "credits.email.referral_reward.valid_until", { date: formatDate(new Date(expiresAt), locale) })}</EmailText> : null}
      <EmailText>{copy.body}</EmailText>
      <EmailButton href={accountUrl} locale={locale}>
        {copy.cta}
      </EmailButton>
    </EmailLayout>
  );
}
