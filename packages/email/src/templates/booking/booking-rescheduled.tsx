/**
 * `booking.booking_rescheduled` (booking spec R31, R59): the new row of a reschedule. Names the old
 * and the new time; the new check-in QR travels as the inline attachment `checkin-qr.png`. The
 * reschedule sends no cancellation email (one email per reschedule).
 */
import { z } from "zod";
import { EmailButton, EmailHeading, EmailLayout, EmailText } from "../../layout";
import type { TemplateComponentProps } from "../define";
import { CheckinQr } from "./booking-confirmed";

export const BookingRescheduledProps = z.object({
  /** Session title in the recipient's locale. */
  title: z.string().min(1),
  /** New start, formatted in the recipient's locale (Europe/Brussels). */
  date: z.string().min(1),
  /** Previous start, same format. */
  oldDate: z.string().min(1),
  /** The portal page of the new booking. */
  url: z.string().url(),
});

export function BookingRescheduled({ url, copy, locale }: TemplateComponentProps<typeof BookingRescheduledProps>) {
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
