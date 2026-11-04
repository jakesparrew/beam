/**
 * `booking.seat_claimed` (booking spec R44, R59): the claimed seat is confirmed (credit or free
 * claim). The check-in QR travels as the inline attachment `checkin-qr.png`. Key
 * `booking:<id>:confirmed`.
 */
import { z } from "zod";
import { EmailButton, EmailHeading, EmailLayout, EmailText } from "../../layout";
import type { TemplateComponentProps } from "../define";
import { CheckinQr } from "./booking-confirmed";

export const SeatClaimedProps = z.object({
  title: z.string().min(1),
  date: z.string().min(1),
  /** The portal booking page. */
  url: z.string().url(),
});

export function SeatClaimed({ url, copy, locale }: TemplateComponentProps<typeof SeatClaimedProps>) {
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
