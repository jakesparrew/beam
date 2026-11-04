/**
 * `booking.booking_cancelled` (booking spec R28, R59): a row became `cancelled` (not for
 * `rescheduled`, `erased` or `session_cancelled`). `reason: 'payment_expired'` adds the line that
 * the unpaid seat was released.
 */
import { z } from "zod";
import { EmailButton, EmailHeading, EmailLayout, EmailText } from "../../layout";
import type { TemplateComponentProps } from "../define";

export const BookingCancelledProps = z.object({
  title: z.string().min(1),
  date: z.string().min(1),
  /** The portal booking page (book another session). */
  url: z.string().url(),
  reason: z.enum(["cancelled", "payment_expired"]).default("cancelled"),
});

export function BookingCancelled({ url, reason, copy, locale }: TemplateComponentProps<typeof BookingCancelledProps>) {
  return (
    <EmailLayout locale={locale} preheader={copy.intro}>
      <EmailHeading>{copy.heading}</EmailHeading>
      <EmailText>{copy.intro}</EmailText>
      {reason === "payment_expired" ? <EmailText>{copy.payment_expired}</EmailText> : null}
      <EmailButton href={url} locale={locale}>
        {copy.cta}
      </EmailButton>
    </EmailLayout>
  );
}
