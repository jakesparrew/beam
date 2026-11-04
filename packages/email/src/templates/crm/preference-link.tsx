/**
 * `crm.preference_link` (crm spec 4.4, edge case 26): a fresh link to the preference centre, for a
 * person whose old link expired or whose message was purged. At most three per person per day.
 * Copy: `crm.email.preference_link.<slot>`. The link is the message's own preference-centre URL
 * (email rule 53, `{{preferences_url}}`), so the fresh link works for another year.
 */
import { z } from "zod";
import { EmailButton, EmailHeading, EmailLayout, EmailText } from "../../layout";
import type { TemplateComponentProps } from "../define";

export const PreferenceLinkProps = z.object({
  firstName: z.string().max(100).nullable().optional(),
  /** Filled by the email renderer from the message's link token; the token placeholder otherwise. */
  preferencesUrl: z.string().url().optional(),
});

export const preferenceLinkSlots = {
  subject: "crm.email.preference_link.subject",
  preheader: "crm.email.preference_link.preheader",
  heading: "crm.email.preference_link.heading",
  body: "crm.email.preference_link.body",
  cta: "crm.email.preference_link.cta",
  footer: "crm.email.preference_link.footer",
} as const;

export function PreferenceLink({ preferencesUrl, copy, locale }: TemplateComponentProps<typeof PreferenceLinkProps>) {
  return (
    <EmailLayout locale={locale} preheader={copy.preheader} footer={copy.footer}>
      <EmailHeading>{copy.heading}</EmailHeading>
      <EmailText>{copy.body}</EmailText>
      <EmailButton href={preferencesUrl ?? "{{preferences_url}}"} locale={locale}>
        {copy.cta}
      </EmailButton>
    </EmailLayout>
  );
}
