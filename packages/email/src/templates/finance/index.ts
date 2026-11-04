/**
 * finance's transactional templates (finance spec section 8, email rule 15a). Registry keys and
 * `email_templates.slug` values: `finance.invoice`, `finance.credit_note`,
 * `finance.invoice_reminder` (these three carry the document PDF) and
 * `finance.company_request_decided`. Copy lives in the `finance` catalogue under
 * `finance.email.<snake_name>.*`.
 *
 * The PDF is a stored file (`files.kind = 'invoice_pdf'`), not built by the template, so it is
 * not an `attachments()` hook: `PDF_ATTACHMENT_TEMPLATES` declares which templates carry it and
 * `finance.send_invoice_email` passes it as `attachments: [{ fileId: pdf_file_id, filename:
 * '<number>.pdf' }]` to `sendTransactional`.
 */
import { defineTemplate } from "../define";
import { CompanyRequestDecided, companyRequestDecidedSample, CompanyRequestDecidedProps } from "./company-request-decided";
import { CreditNote, creditNoteSample, CreditNoteProps } from "./credit-note";
import { Invoice, invoiceSample, FinanceEmailProps } from "./invoice";
import { InvoiceReminder, invoiceReminderSample, InvoiceReminderProps } from "./invoice-reminder";

export { FinanceEmailProps, PDF_ATTACHMENT, type FinanceEmailData, type PdfAttachmentSpec } from "./invoice";

const slots = (name: string) => ({
  subject: `finance.email.${name}.subject`,
  preheader: `finance.email.${name}.preheader`,
  heading: `finance.email.${name}.heading`,
  body: `finance.email.${name}.body`,
  cta: `finance.email.${name}.cta`,
});

/** The finance templates that are sent with the document PDF attached (finance spec section 8). */
export const PDF_ATTACHMENT_TEMPLATES = ["invoice", "credit_note", "invoice_reminder"] as const;
export type FinanceDocumentTemplate = (typeof PDF_ATTACHMENT_TEMPLATES)[number];

export const templates = [
  defineTemplate({ name: "invoice", component: Invoice, props: FinanceEmailProps, sample: invoiceSample, slots: slots("invoice") }),
  defineTemplate({ name: "credit_note", component: CreditNote, props: CreditNoteProps, sample: creditNoteSample, slots: slots("credit_note") }),
  defineTemplate({ name: "invoice_reminder", component: InvoiceReminder, props: InvoiceReminderProps, sample: invoiceReminderSample, slots: slots("invoice_reminder") }),
  defineTemplate({
    name: "company_request_decided",
    component: CompanyRequestDecided,
    props: CompanyRequestDecidedProps,
    sample: companyRequestDecidedSample,
    slots: slots("company_request_decided"),
  }),
];
