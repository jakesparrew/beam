/**
 * `booking.booking_confirmed` (booking spec R59): a booking became `confirmed` (credit, guest or
 * free booking, a paid order, an import with `sendEmail`), or a pay-at-desk seat was reserved
 * (`payAtDesk: true`, line "Payment at reception"). The check-in QR travels as the inline
 * attachment `checkin-qr.png`.
 */
import { Img, Section, Text } from "react-email";
import { z } from "zod";
import { BRAND, detailLabel, EmailButton, EmailDetails, EmailHeading, EmailLayout, EmailNote, EmailText } from "../../layout";
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
  /** Owner requirement 5: the WebinarGeek link of a webinar (registration or watch page). */
  joinUrl: z.string().url().optional(),
});

/** The QR block shared by the booking templates. */
export function CheckinQr({ caption }: { caption: string }) {
  return (
    <Section style={{ margin: "0 0 28px", textAlign: "center" }}>
      <Section style={{ width: "236px", margin: "0 auto", border: `1px solid ${BRAND.border}`, borderRadius: "16px", padding: "18px 18px 6px", backgroundColor: BRAND.surface, textAlign: "center" }}>
        <Img src={CHECKIN_QR_CID} alt={caption} width="180" height="180" style={{ display: "block", margin: "0 auto 10px" }} />
        <Text style={{ color: BRAND.muted, fontFamily: BRAND.font, fontSize: "13px", lineHeight: "18px", margin: "0 0 10px", textAlign: "center" }}>{caption}</Text>
      </Section>
    </Section>
  );
}

export function BookingConfirmed({ title, date, url, payAtDesk, joinUrl, copy, locale }: TemplateComponentProps<typeof BookingConfirmedProps>) {
  return (
    <EmailLayout locale={locale} preheader={copy.intro} hero={"space"}>
      <EmailHeading>{copy.heading}</EmailHeading>
      <EmailText>{copy.intro}</EmailText>
      <EmailDetails rows={[{ label: detailLabel(locale, "session"), value: title }, { label: detailLabel(locale, "when"), value: date, strong: true }]} />
      {payAtDesk ? <EmailNote>{copy.pay_at_desk}</EmailNote> : null}
      {joinUrl ? (
        <>
          <EmailText>{copy.join}</EmailText>
          <EmailButton href={joinUrl} locale={locale}>
            {copy.join_cta}
          </EmailButton>
        </>
      ) : (
        <CheckinQr caption={copy.qr ?? ""} />
      )}
      <EmailButton href={url} locale={locale}>
        {copy.cta}
      </EmailButton>
    </EmailLayout>
  );
}
