/**
 * `forms.result` (forms spec sections 4 and 8, rules C1, C4 and SE4): the transactional result
 * email sent at submit. Props `FormResultProps` from `@beam/core/forms`; every dynamic text is
 * already resolved to the submission locale by forms. It shows the outcome, the non-sensitive
 * score line, explanation, recommendation and up to four CTAs, and never a sensitive dimension
 * value or a raw answer. `pendingConfirmation` adds "Check your inbox to confirm your
 * subscription". Copy: `forms.email.result.<slot>`.
 */
import { FormResultProps } from "@beam/core/forms";
import { EmailButton, EmailHeading, EmailLayout, EmailText } from "../../layout";
import type { TemplateComponentProps } from "../define";

export { FormResultProps };

export const formResultSlots = {
  subject: "forms.email.result.subject",
  preheader: "forms.email.result.preheader",
  heading: "forms.email.result.heading",
  greeting: "forms.email.result.greeting",
  intro: "forms.email.result.intro",
  outcome: "forms.email.result.outcome",
  recommendation: "forms.email.result.recommendation",
  cta: "forms.email.result.cta",
  pending_confirmation: "forms.email.result.pending_confirmation",
  footer: "forms.email.result.footer",
} as const;

export function Result(props: TemplateComponentProps<typeof FormResultProps>) {
  const { copy, locale } = props;
  return (
    <EmailLayout locale={locale} preheader={copy.preheader} footer={copy.footer}>
      <EmailHeading>{copy.heading}</EmailHeading>
      <EmailText>{props.firstName ? `${copy.greeting} ${props.firstName},` : `${copy.greeting},`}</EmailText>
      <EmailText>{props.intro ?? copy.intro}</EmailText>
      {props.outcomeLabel ? (
        <EmailText>
          <strong>{copy.outcome}:</strong> {props.outcomeLabel}
        </EmailText>
      ) : null}
      {props.scoreLine ? <EmailText>{props.scoreLine}</EmailText> : null}
      {props.explanation ? <EmailText>{props.explanation}</EmailText> : null}
      {props.recommendation ? (
        <EmailText>
          <strong>{copy.recommendation}:</strong> {props.recommendation}
        </EmailText>
      ) : null}
      <EmailButton href={props.resultUrl} locale={locale}>
        {copy.cta}
      </EmailButton>
      {props.ctas.map((c) => (
        <EmailText key={c.url}>
          <a href={c.url}>{c.label}</a>
        </EmailText>
      ))}
      {props.pendingConfirmation ? <EmailText muted>{copy.pending_confirmation}</EmailText> : null}
    </EmailLayout>
  );
}
