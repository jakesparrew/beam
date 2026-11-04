/**
 * `booking.waitlist_joined` (booking spec R40, R59): the person joined or rejoined a session's
 * waiting list. Key `waitlist:<entry_id>:joined:<rejoin_count>`.
 */
import { z } from "zod";
import { EmailButton, EmailHeading, EmailLayout, EmailText } from "../../layout";
import type { TemplateComponentProps } from "../define";

export const WaitlistJoinedProps = z.object({
  /** Session title in the recipient's locale. */
  title: z.string().min(1),
  /** Start, formatted in the recipient's locale (Europe/Brussels). */
  date: z.string().min(1),
  /** The portal waiting-list page. */
  url: z.string().url(),
});

export function WaitlistJoined({ url, copy, locale }: TemplateComponentProps<typeof WaitlistJoinedProps>) {
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
