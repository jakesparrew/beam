/**
 * `credits.membership_started` (credits rule 45): sent once when a paid membership is created,
 * `active` from today or `pending` until a later start date (plan change, gift start).
 */
import { z } from "zod";
import { formatDate, t } from "@beam/core/i18n";
import { EmailButton, EmailHeading, EmailLayout, EmailText } from "../../layout";
import type { TemplateComponentProps } from "../define";

const dateOn = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const MembershipStartedProps = z.object({
  membershipId: z.string().uuid(),
  /** The plan name in the recipient's locale. */
  planName: z.string().min(1),
  status: z.enum(["active", "pending"]),
  startsOn: dateOn,
  periodEndOn: dateOn,
  /** The portal membership page. */
  accountUrl: z.string().url(),
});

export const membershipStartedSample: z.infer<typeof MembershipStartedProps> = {
  membershipId: "6f1c1f9e-0b7a-4c39-9a51-0d2b6f6f3a11",
  planName: "Vitality Monthly",
  status: "active",
  startsOn: "2026-11-04",
  periodEndOn: "2026-12-04",
  accountUrl: "https://beam.example.com/nl-BE/account/membership",
};

export function MembershipStarted({ status, startsOn, periodEndOn, accountUrl, copy, locale }: TemplateComponentProps<typeof MembershipStartedProps>) {
  return (
    <EmailLayout locale={locale} preheader={copy.preheader}>
      <EmailHeading>{copy.heading}</EmailHeading>
      <EmailText>{copy.body}</EmailText>
      <EmailText>
        {status === "pending"
          ? t(locale, "credits.email.membership_started.starts_on", { date: formatDate(startsOn, locale, "long") })
          : t(locale, "credits.email.membership_started.period", { date: formatDate(periodEndOn, locale, "long") })}
      </EmailText>
      <EmailButton href={accountUrl} locale={locale}>
        {copy.cta}
      </EmailButton>
    </EmailLayout>
  );
}
