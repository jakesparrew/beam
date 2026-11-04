/**
 * `booking.booking_confirmed` (booking spec R59): a booking became `confirmed` (credit, guest or
 * free booking, a paid order, an import with `sendEmail`), or a pay-at-desk seat was reserved
 * (`payAtDesk: true`, line "Payment at reception"). The check-in QR travels as the inline
 * attachment `checkin-qr.png`.
 */
import { Img, Section } from "react-email";
import { z } from "zod";
import { EmailButton, EmailHeading, EmailLayout, EmailText } from "../../layout";
import type { TemplateComponentProps } from "../define";

/** The inline QR image reference (`attachments: [{ filename: 'checkin-qr.png', inline: true }]`). */
export const CHECKIN_QR_CID = "cid:checkin-qr.png";

export const BookingConfirmedProps = z.object({
  /** Session title in the recipient's locale. */
  title: z.string().min(1),
  /** Start, formatted in the recipient's locale (Europe/Brussels). */
  date: z.string().min(1),
  /** The portal booking page. */
  url: z.string().url(),
  payAtDesk: z.boolean().default(false),
});

/** The QR block shared by the booking templates. */
export function CheckinQr({ caption }: { caption: string }) {
  return (
    <Section style={{ margin: "8px 0 24px", textAlign: "center" }}>
      <Img src={CHECKIN_QR_CID} alt={caption} width="200" height="200" style={{ margin: "0 auto" }} />
      <EmailText muted>{caption}</EmailText>
    </Section>
  );
}

export function BookingConfirmed({ url, payAtDesk, copy, locale }: TemplateComponentProps<typeof BookingConfirmedProps>) {
  return (
    <EmailLayout locale={locale} preheader={copy.intro}>
      <EmailHeading>{copy.heading}</EmailHeading>
      <EmailText>{copy.intro}</EmailText>
      {payAtDesk ? <EmailText>{copy.pay_at_desk}</EmailText> : null}
      <CheckinQr caption={copy.qr ?? ""} />
      <EmailButton href={url} locale={locale}>
        {copy.cta}
      </EmailButton>
    </EmailLayout>
  );
}
