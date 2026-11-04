/**
 * `crm.confirm_resubscribe` (crm rule 3.21): a person who unsubscribed from a purpose ticked it
 * again on a form; nothing is recorded until they confirm in the preference centre, where the
 * grant is recorded with method `preference_centre`. Copy: `crm.email.confirm_resubscribe.<slot>`.
 * The link is the message's own preference-centre URL (email rule 53, `{{preferences_url}}`),
 * opened on its resubscribe confirmation for the purpose.
 */
import { z } from "zod";
import { MARKETING_PURPOSES } from "@beam/core/crm";
import { EmailButton, EmailHeading, EmailLayout, EmailText } from "../../layout";
import type { TemplateComponentProps } from "../define";

export const ConfirmResubscribeProps = z.object({
  purpose: z.enum(MARKETING_PURPOSES),
  firstName: z.string().max(100).nullable().optional(),
  /** Filled by the email renderer from the message's link token; the token placeholder otherwise. */
  preferencesUrl: z.string().url().optional(),
});

export const confirmResubscribeSlots = {
  subject: "crm.email.confirm_resubscribe.subject",
  preheader: "crm.email.confirm_resubscribe.preheader",
  heading: "crm.email.confirm_resubscribe.heading",
  body: "crm.email.confirm_resubscribe.body",
  cta: "crm.email.confirm_resubscribe.cta",
  footer: "crm.email.confirm_resubscribe.footer",
} as const;

/** The confirmation link: the preference centre with the resubscribe confirmation for `purpose`. */
export function confirmResubscribeHref(preferencesUrl: string | undefined, purpose: string): string {
  const base = preferencesUrl ?? "{{preferences_url}}";
  return `${base}${base.includes("?") ? "&" : "?"}confirm=resubscribe&purpose=${encodeURIComponent(purpose)}`;
}

export function ConfirmResubscribe({ purpose, preferencesUrl, copy, locale }: TemplateComponentProps<typeof ConfirmResubscribeProps>) {
  return (
    <EmailLayout locale={locale} preheader={copy.preheader} footer={copy.footer}>
      <EmailHeading>{copy.heading}</EmailHeading>
      <EmailText>{copy.body}</EmailText>
      <EmailButton href={confirmResubscribeHref(preferencesUrl, purpose)} locale={locale}>
        {copy.cta}
      </EmailButton>
    </EmailLayout>
  );
}
