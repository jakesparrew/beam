/**
 * `booking.seat_offered` (booking spec R42, R43, R59): a seat is held for the person until
 * `expiresAt`. `url` is the single-use claim link, computed at send time; the plain token exists
 * only in this message and its job payload. Key `waitlist:<entry_id>:offer:<offers_count>`.
 */
import { z } from "zod";
import { EmailButton, EmailHeading, EmailLayout, EmailText } from "../../layout";
import type { TemplateComponentProps } from "../define";

export const SeatOfferedProps = z.object({
  title: z.string().min(1),
  date: z.string().min(1),
  /** Offer expiry, formatted in the recipient's locale (Europe/Brussels). */
  expiresAt: z.string().min(1),
  /** The claim link (`/api/public/claim/<token>`). */
  url: z.string().url(),
});

export function SeatOffered({ url, copy, locale }: TemplateComponentProps<typeof SeatOfferedProps>) {
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
