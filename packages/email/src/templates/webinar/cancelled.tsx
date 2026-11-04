/**
 * `webinar.cancelled` (webinar spec rule 11): BEAM cancelled the webinar. Sent once per
 * registrant when staff cancel with "notify registrants"; links the public webinar list so the
 * person can pick another date. The staff reason is internal and is not included.
 */
import { z } from "zod";
import { EmailButton, EmailHeading, EmailLayout, EmailText } from "../../layout";
import type { TemplateComponentProps } from "../define";

export const CancelledProps = z.object({
  /** Webinar title in the registration's locale. */
  title: z.string().min(1),
  /** The cancelled start, formatted in the recipient's locale (Europe/Brussels); empty on demand. */
  date: z.string(),
  /** The webinar's landing page (it shows the cancellation and the other webinars). */
  url: z.string().url(),
});

export function Cancelled({ url, copy, locale }: TemplateComponentProps<typeof CancelledProps>) {
  return (
    <EmailLayout locale={locale} preheader={copy.intro}>
      <EmailHeading>{copy.heading}</EmailHeading>
      <EmailText>{copy.intro}</EmailText>
      <EmailText>{copy.apology}</EmailText>
      <EmailButton href={url} locale={locale}>
        {copy.cta}
      </EmailButton>
    </EmailLayout>
  );
}
