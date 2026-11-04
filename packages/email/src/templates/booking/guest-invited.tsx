/**
 * `booking.guest_invited` (booking spec R56): a guest row with an email became `confirmed`. Names
 * the owner by first name only, the session and the guest's own check-in QR (inline attachment
 * `checkin-qr.png`). No marketing consent is implied.
 */
import { z } from "zod";
import { EmailButton, EmailHeading, EmailLayout, EmailText } from "../../layout";
import type { TemplateComponentProps } from "../define";
import { CheckinQr } from "./booking-confirmed";

export const GuestInvitedProps = z.object({
  title: z.string().min(1),
  date: z.string().min(1),
  url: z.string().url(),
  /** The owner's first name only. */
  ownerFirstName: z.string().min(1),
});

export function GuestInvited({ url, copy, locale }: TemplateComponentProps<typeof GuestInvitedProps>) {
  return (
    <EmailLayout locale={locale} preheader={copy.intro}>
      <EmailHeading>{copy.heading}</EmailHeading>
      <EmailText>{copy.intro}</EmailText>
      <CheckinQr caption={copy.qr ?? ""} />
      <EmailButton href={url} locale={locale}>
        {copy.cta}
      </EmailButton>
    </EmailLayout>
  );
}
