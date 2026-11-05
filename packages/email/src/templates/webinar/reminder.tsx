/**
 * `webinar.reminder` (webinar spec 4.8, cross-module D3): the reminders of the seeded journey
 * `webinar-registration`, one template for the steps `d7` (7 days), `d3` (3 days) and `h3`
 * (3 hours before the start). Automation sends it without `data`: `loadProps` (in `index.ts`)
 * reads the registration from `context.registration_id` and takes the variant from the step key.
 * The copy slots select on `variant` (ICU `select`), so one set of slots covers the three steps.
 */
import { z } from "zod";
import { EmailButton, EmailHeading, EmailLayout, EmailText } from "../../layout";
import type { TemplateComponentProps } from "../define";

export const REMINDER_VARIANTS = ["d7", "d3", "h3"] as const;
export type ReminderVariant = (typeof REMINDER_VARIANTS)[number];

export const ReminderProps = z.object({
  variant: z.enum(REMINDER_VARIANTS),
  /** Webinar title in the registration's locale. */
  title: z.string().min(1),
  /** Start formatted in the recipient's locale (Europe/Brussels). */
  date: z.string().min(1),
  /** The spoken language, named in the recipient's locale. */
  language: z.string().min(1),
  /** The personal access link `/<l>/w/<token>`. */
  accessUrl: z.string().url(),
  webinarId: z.uuid(),
  registrationId: z.uuid(),
});
export type ReminderProps = z.infer<typeof ReminderProps>;

export function Reminder({ accessUrl, copy, locale }: TemplateComponentProps<typeof ReminderProps>) {
  return (
    <EmailLayout locale={locale} preheader={copy.intro}>
      <EmailHeading>{copy.heading}</EmailHeading>
      <EmailText>{copy.intro}</EmailText>
      <EmailText>{copy.language}</EmailText>
      <EmailButton href={accessUrl} locale={locale}>
        {copy.cta}
      </EmailButton>
      <EmailText muted>{copy.personal}</EmailText>
    </EmailLayout>
  );
}
