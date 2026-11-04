/**
 * `finance.credit_note` (finance rule 38): sent with the credit-note PDF attached for every
 * credit note that has an email recipient; prints the reason and, for Belgian company buyers,
 * the Peppol courtesy-copy line.
 */
import { t } from "@beam/core/i18n";
import { EmailButton, EmailHeading, EmailLayout, EmailText } from "../../layout";
import type { TemplateComponentProps } from "../define";
import { FinanceEmailProps, type FinanceEmailData } from "./invoice";

export const CreditNoteProps = FinanceEmailProps;

export const creditNoteSample: FinanceEmailData = {
  number: "CN-2026-000045",
  totalFormatted: "€ -45,00",
  reason: "Customer request",
  portalUrl: "https://beam.example.com/nl/account/invoices",
};

export function CreditNote({ copy, locale, portalUrl, reason, isCourtesyCopy }: TemplateComponentProps<typeof CreditNoteProps>) {
  return (
    <EmailLayout locale={locale} preheader={copy.preheader}>
      <EmailHeading>{copy.heading}</EmailHeading>
      <EmailText>{copy.body}</EmailText>
      {reason ? <EmailText>{t(locale, "finance.email.credit_note.reason", { reason })}</EmailText> : null}
      {isCourtesyCopy ? <EmailText muted>{t(locale, "finance.email.credit_note.courtesy_copy")}</EmailText> : null}
      <EmailButton href={portalUrl} locale={locale}>
        {copy.cta}
      </EmailButton>
    </EmailLayout>
  );
}
