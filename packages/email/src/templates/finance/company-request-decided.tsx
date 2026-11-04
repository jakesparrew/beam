/**
 * `finance.company_request_decided` (finance rule 20): staff approved or rejected a customer's
 * request for a company invoice. No attachment: an approval issues a new invoice, which gets its
 * own `finance.invoice` email with the PDF.
 */
import { t } from "@beam/core/i18n";
import { EmailButton, EmailHeading, EmailLayout, EmailText } from "../../layout";
import type { TemplateComponentProps } from "../define";
import { FinanceEmailProps, type FinanceEmailData } from "./invoice";

export const CompanyRequestDecidedProps = FinanceEmailProps.refine((d) => d.decision !== undefined, { path: ["decision"], message: "decision is required" });

export const companyRequestDecidedSample: FinanceEmailData = {
  number: "BEAM-2026-000123",
  totalFormatted: "€ 121,00",
  decision: "rejected",
  note: "The VAT number does not belong to the company named.",
  portalUrl: "https://beam.example.com/nl/account/invoices",
};

export function CompanyRequestDecided({ copy, locale, portalUrl, decision, note }: TemplateComponentProps<typeof CompanyRequestDecidedProps>) {
  return (
    <EmailLayout locale={locale} preheader={copy.preheader}>
      <EmailHeading>{copy.heading}</EmailHeading>
      <EmailText>{copy.body}</EmailText>
      <EmailText>{t(locale, decision === "approved" ? "finance.email.company_request_decided.approved" : "finance.email.company_request_decided.rejected")}</EmailText>
      {note ? <EmailText>{t(locale, "finance.email.company_request_decided.note", { note })}</EmailText> : null}
      <EmailButton href={portalUrl} locale={locale}>
        {copy.cta}
      </EmailButton>
    </EmailLayout>
  );
}
