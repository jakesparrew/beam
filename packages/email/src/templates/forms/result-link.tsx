/**
 * `forms.result_link` (forms spec rule ID8): a fresh link to a completed result, sent by the job
 * `forms.send_result_link` when the visitor asks for one on an expired result page. Props
 * `FormResultLinkProps` from `@beam/core/forms`. Copy: `forms.email.result_link.<slot>`.
 */
import { FormResultLinkProps } from "@beam/core/forms";
import { EmailButton, EmailHeading, EmailLayout, EmailText } from "../../layout";
import type { TemplateComponentProps } from "../define";

export { FormResultLinkProps };

export const formResultLinkSlots = {
  subject: "forms.email.result_link.subject",
  preheader: "forms.email.result_link.preheader",
  heading: "forms.email.result_link.heading",
  greeting: "forms.email.result_link.greeting",
  body: "forms.email.result_link.body",
  cta: "forms.email.result_link.cta",
  footer: "forms.email.result_link.footer",
} as const;

export function ResultLink(props: TemplateComponentProps<typeof FormResultLinkProps>) {
  const { copy, locale } = props;
  return (
    <EmailLayout locale={locale} preheader={copy.preheader} footer={copy.footer}>
      <EmailHeading>{copy.heading}</EmailHeading>
      <EmailText>{props.firstName ? `${copy.greeting} ${props.firstName},` : `${copy.greeting},`}</EmailText>
      <EmailText>{copy.body}</EmailText>
      <EmailButton href={props.resultUrl} locale={locale}>
        {copy.cta}
      </EmailButton>
    </EmailLayout>
  );
}
