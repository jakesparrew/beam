/**
 * `booking.waitlist_joined` (booking spec R40, R59): the person joined or rejoined a session's
 * waiting list. Key `waitlist:<entry_id>:joined:<rejoin_count>`.
 */
import { z } from "zod";
import { detailLabel, EmailButton, EmailDetails, EmailHeading, EmailLayout, EmailText } from "../../layout";
import type { TemplateComponentProps } from "../define";

export const WaitlistJoinedProps = z.object({
  /** Session title in the recipient's locale. */
  title: z.string().min(1),
  /** Start, formatted in the recipient's locale (Europe/Brussels). */
  date: z.string().min(1),
  /** The portal waiting-list page. */
  url: z.string().url(),
});

export function WaitlistJoined({ title, date, url, copy, locale }: TemplateComponentProps<typeof WaitlistJoinedProps>) {
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
