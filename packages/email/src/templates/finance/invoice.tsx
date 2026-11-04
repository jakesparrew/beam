/**
 * `finance.invoice` (finance rule 38): the invoice email with the PDF attached, sent for company
 * invoices, open bank-transfer invoices and reissued invoices. Also home of the props schema
 * every finance template shares (finance spec section 8), passed as `data` by
 * `finance.send_invoice_email` and by the company request decision.
 */
import { z } from "zod";
import { t, type Locale } from "@beam/core/i18n";
import { EmailButton, EmailHeading, EmailLayout, EmailText } from "../../layout";
import type { TemplateComponentProps } from "../define";

/** The finance templates' `data` (finance spec section 8). `dueOn` is a formatted date in the message locale. */
export const FinanceEmailProps = z.object({
  number: z.string().regex(/^(BEAM|CN)-\d{4}-\d{6}$/),
  totalFormatted: z.string().min(1),
  dueOn: z.string().min(1).optional(),
  paymentReference: z.string().regex(/^\+\+\+\d{3}\/\d{4}\/\d{5}\+\+\+$/).optional(),
  iban: z.string().min(1).optional(),
  portalUrl: z.string().url(),
  reason: z.string().min(1).optional(),
  decision: z.enum(["approved", "rejected"]).optional(),
  note: z.string().max(500).optional(),
  isCourtesyCopy: z.boolean().optional(),
});
export type FinanceEmailData = z.infer<typeof FinanceEmailProps>;

/** The PDF a document template carries: the document's `pdf_file_id`, named `<number>.pdf` (passed by the sender as `attachments`). */
export type PdfAttachmentSpec = { kind: "invoice_pdf"; mime: "application/pdf"; filename: (data: Pick<FinanceEmailData, "number">) => string };
export const PDF_ATTACHMENT: PdfAttachmentSpec = { kind: "invoice_pdf", mime: "application/pdf", filename: (data) => `${data.number}.pdf` };

export const invoiceSample: FinanceEmailData = {
  number: "BEAM-2026-000123",
  totalFormatted: "€ 121,00",
  dueOn: "18 november 2026",
  paymentReference: "+++260/0000/12395+++",
  iban: "BE71 0961 2345 6769",
  portalUrl: "https://beam.example.com/nl/account/invoices",
};

/** Lines shared by the invoice and reminder emails: due date, structured communication, IBAN, Peppol note. */
export function PaymentLines({ name, data, locale }: { name: "invoice" | "invoice_reminder"; data: FinanceEmailData; locale: Locale }) {
  return (
    <>
      {data.dueOn ? <EmailText>{t(locale, `finance.email.${name}.due`, { dueOn: data.dueOn })}</EmailText> : null}
      {data.paymentReference ? <EmailText>{t(locale, `finance.email.${name}.payment_reference`, { paymentReference: data.paymentReference })}</EmailText> : null}
      {data.iban ? <EmailText>{t(locale, `finance.email.${name}.iban`, { iban: data.iban })}</EmailText> : null}
      {data.isCourtesyCopy ? <EmailText muted>{t(locale, `finance.email.${name}.courtesy_copy`)}</EmailText> : null}
    </>
  );
}

export function Invoice(props: TemplateComponentProps<typeof FinanceEmailProps>) {
  const { copy, locale, portalUrl } = props;
  return (
    <EmailLayout locale={locale} preheader={copy.preheader}>
      <EmailHeading>{copy.heading}</EmailHeading>
      <EmailText>{copy.body}</EmailText>
      <PaymentLines name="invoice" data={props} locale={locale} />
      <EmailButton href={portalUrl} locale={locale}>
        {copy.cta}
      </EmailButton>
    </EmailLayout>
  );
}
