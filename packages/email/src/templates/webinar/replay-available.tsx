/**
 * `webinar.replay_available` (webinar spec 4.8, rule 29): the no-show journey's message one hour
 * after a missed live webinar whose replay exists (`webinar.no_show` with
 * `replay_available = true`). Automation sends it without `data`: `loadProps` (in `index.ts`)
 * builds the personal access link from `context.registration_id` and reads `replay_until_at`.
 */
import { z } from "zod";
import { EmailButton, EmailHeading, EmailLayout, EmailText } from "../../layout";
import type { TemplateComponentProps } from "../define";

export const ReplayAvailableProps = z.object({
  /** Webinar title in the registration's locale. */
  title: z.string().min(1),
  /** The personal access link `/<l>/w/<token>`; it opens the replay. */
  accessUrl: z.string().url(),
  /** `replay_until_at` formatted in the recipient's locale (Europe/Brussels); empty = no expiry. */
  until: z.string(),
  webinarId: z.uuid(),
  registrationId: z.uuid(),
});
export type ReplayAvailableProps = z.infer<typeof ReplayAvailableProps>;

export function ReplayAvailable({ accessUrl, until, copy, locale }: TemplateComponentProps<typeof ReplayAvailableProps>) {
  return (
    <EmailLayout locale={locale} preheader={copy.intro}>
      <EmailHeading>{copy.heading}</EmailHeading>
      <EmailText>{copy.intro}</EmailText>
      {until ? <EmailText>{copy.until}</EmailText> : null}
      <EmailButton href={accessUrl} locale={locale}>
        {copy.cta}
      </EmailButton>
      <EmailText muted>{copy.personal}</EmailText>
    </EmailLayout>
  );
}
