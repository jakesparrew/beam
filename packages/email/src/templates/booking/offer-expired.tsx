/**
 * `booking.offer_expired` (booking spec R45, R59): the seat offer was not claimed in time and went
 * to the next person. Key `waitlist:<entry_id>:expired:<offers_count>`.
 */
import { z } from "zod";
import { detailLabel, EmailButton, EmailDetails, EmailHeading, EmailLayout, EmailText } from "../../layout";
import type { TemplateComponentProps } from "../define";

export const OfferExpiredProps = z.object({
  title: z.string().min(1),
  date: z.string().min(1),
  /** The portal session page (book or join again). */
  url: z.string().url(),
});

export function OfferExpired({ title, date, url, copy, locale }: TemplateComponentProps<typeof OfferExpiredProps>) {
  return (
    <EmailLayout locale={locale} preheader={copy.intro}>
      <EmailHeading>{copy.heading}</EmailHeading>
      <EmailText>{copy.intro}</EmailText>
      <EmailDetails rows={[{ label: detailLabel(locale, "session"), value: title }, { label: detailLabel(locale, "when"), value: date, strong: true }]} />
      <EmailButton href={url} locale={locale}>
        {copy.cta}
      </EmailButton>
    </EmailLayout>
  );
}
