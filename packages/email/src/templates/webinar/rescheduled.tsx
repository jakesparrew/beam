/**
 * `webinar.rescheduled` (webinar spec rule 11, edge case 9): the webinar moved by more than five
 * minutes. Sent once per registrant per version by `webinar.notify_registrants`; names the new
 * and the previous time (Brussels, the registration's locale) and links the landing page. The
 * registration and the personal access link stay valid.
 */
import { z } from "zod";
import { EmailButton, EmailHeading, EmailLayout, EmailText } from "../../layout";
import type { TemplateComponentProps } from "../define";

export const RescheduledProps = z.object({
  /** Webinar title in the registration's locale. */
  title: z.string().min(1),
  /** New start, formatted in the recipient's locale (Europe/Brussels). */
  date: z.string().min(1),
  /** Previous start, same format. */
  oldDate: z.string().min(1),
  /** The webinar's landing page. */
  url: z.string().url(),
});

export function Rescheduled({ url, copy, locale }: TemplateComponentProps<typeof RescheduledProps>) {
  return (
    <EmailLayout locale={locale} preheader={copy.intro}>
      <EmailHeading>{copy.heading}</EmailHeading>
      <EmailText>{copy.intro}</EmailText>
      <EmailText>{copy.link_valid}</EmailText>
      <EmailButton href={url} locale={locale}>
        {copy.cta}
      </EmailButton>
    </EmailLayout>
  );
}
