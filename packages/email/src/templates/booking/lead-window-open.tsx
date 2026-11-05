/**
 * `booking.lead_window_open` (booking spec R24, R59; booking-P7, R2): the Lead Magnet window has
 * closed and a released seat is held for a person in the customer queue until `expiresAt`. Same
 * claim link and expiry as `booking.seat_offered`; `url` is the single-use claim link computed at
 * send time. Key `waitlist:<entry_id>:offer:<offers_count>`.
 */
import { z } from "zod";
import { EmailButton, EmailHeading, EmailLayout, EmailText } from "../../layout";
import type { TemplateComponentProps } from "../define";

export const LeadWindowOpenProps = z.object({
  title: z.string().min(1),
  date: z.string().min(1),
  /** Offer expiry, formatted in the recipient's locale (Europe/Brussels). */
  expiresAt: z.string().min(1),
  /** The claim link (`/api/public/claim/<token>`). */
  url: z.string().url(),
});

export function LeadWindowOpen({ url, copy, locale }: TemplateComponentProps<typeof LeadWindowOpenProps>) {
  return (
    <EmailLayout locale={locale} preheader={copy.intro}>
      <EmailHeading>{copy.heading}</EmailHeading>
      <EmailText>{copy.intro}</EmailText>
      <EmailButton href={url} locale={locale}>
        {copy.cta}
      </EmailButton>
    </EmailLayout>
  );
}
