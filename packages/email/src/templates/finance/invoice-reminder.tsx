/**
 * `finance.invoice_reminder` (finance rule 29): the staff payment reminder for an open, overdue
 * bank-transfer invoice, with the invoice PDF attached again and the payment details.
 */
import { EmailButton, EmailHeading, EmailLayout, EmailText } from "../../layout";
import type { TemplateComponentProps } from "../define";
import { FinanceEmailProps, PaymentLines, type FinanceEmailData } from "./invoice";

export const InvoiceReminderProps = FinanceEmailProps;

export const invoiceReminderSample: FinanceEmailData = {
  number: "BEAM-2026-000123",
  totalFormatted: "€ 121,00",
  dueOn: "18 november 2026",
  paymentReference: "+++260/0000/12395+++",
  iban: "BE71 0961 2345 6769",
  portalUrl: "https://beam.example.com/nl/account/invoices",
};

export function InvoiceReminder(props: TemplateComponentProps<typeof InvoiceReminderProps>) {
  const { copy, locale, portalUrl } = props;
  return (
    <EmailLayout locale={locale} preheader={copy.preheader}>
      <EmailHeading>{copy.heading}</EmailHeading>
      <EmailText>{copy.body}</EmailText>
      <PaymentLines name="invoice_reminder" data={props} locale={locale} />
      <EmailButton href={portalUrl} locale={locale}>
        {copy.cta}
      </EmailButton>
    </EmailLayout>
  );
}
