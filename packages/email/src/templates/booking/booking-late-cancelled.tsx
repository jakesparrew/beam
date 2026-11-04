/**
 * `booking.booking_late_cancelled` (booking spec R29, R59): a row became `late_cancelled` after
 * the free cancellation window; the session stays used (no refund, the credit kept unless the
 * rules release it).
 */
import { z } from "zod";
import { EmailButton, EmailHeading, EmailLayout, EmailText } from "../../layout";
import type { TemplateComponentProps } from "../define";

export const BookingLateCancelledProps = z.object({
  title: z.string().min(1),
  date: z.string().min(1),
  url: z.string().url(),
});

export function BookingLateCancelled({ url, copy, locale }: TemplateComponentProps<typeof BookingLateCancelledProps>) {
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
