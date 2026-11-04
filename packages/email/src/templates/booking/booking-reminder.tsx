/**
 * `booking.booking_reminder` (booking spec R60): sent by `bookings.send_reminders` per offset of
 * `reminder_hours_before[kind]`; `kind: 'day' | 'night'` picks the intro. The check-in QR travels
 * as the inline attachment `checkin-qr.png`.
 */
import { z } from "zod";
import { EmailButton, EmailHeading, EmailLayout, EmailText } from "../../layout";
import type { TemplateComponentProps } from "../define";
import { CheckinQr } from "./booking-confirmed";

export const BookingReminderProps = z.object({
  title: z.string().min(1),
  date: z.string().min(1),
  url: z.string().url(),
  kind: z.enum(["day", "night"]),
});

export function BookingReminder({ url, kind, copy, locale }: TemplateComponentProps<typeof BookingReminderProps>) {
  const intro = kind === "night" ? copy.intro_night : copy.intro_day;
  return (
    <EmailLayout locale={locale} preheader={intro}>
      <EmailHeading>{copy.heading}</EmailHeading>
      <EmailText>{intro}</EmailText>
      <CheckinQr caption={copy.qr ?? ""} />
      <EmailButton href={url} locale={locale}>
        {copy.cta}
      </EmailButton>
    </EmailLayout>
  );
}
