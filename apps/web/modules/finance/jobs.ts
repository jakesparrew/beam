/**
 * finance jobs (`defineJob`, finance spec section 4.5). Facade read by `pnpm gen:indexes`.
 * finance-P3: `finance.render_pdf` and `finance.send_invoice_email`. The Billit jobs
 * (`billit.*`), `finance.scan_overdue` and `finance.build_export` come with finance-P4 and
 * finance-P7; until `billit.push_invoice` / `billit.push_credit_note` are registered the render
 * job's push enqueue is skipped (documents stay `billit_status = 'pending'`, rule 34).
 */
import { z } from "zod";
import type { DbOrTx, Tx } from "@beam/db";
import { orders, persons } from "@beam/db/schema";
import { buildSellerSnapshot, missingIssuerFields, type InvoiceRecord } from "@beam/core/finance";
import { formatDate, formatMoney, isLocale, URL_SEGMENT, type Locale } from "@beam/core/i18n";
import { eq, writeDurably } from "@/lib/ctx";
import { defineJob, PermanentError, RetryableError, type JobCtx } from "@/lib/job-runner";
import { sendTransactional } from "@/modules/email/api";
import { readFile, storeFile } from "@/modules/platform/api";
import { assertRenderableSeller, buildInvoiceDocumentModel, formatIban, MissingCompanySettingsError, renderInvoicePdf } from "./pdf/render";
import { getOrderBillingDetails } from "./service/billing-details";
import { enqueueFinanceJob, eventSubject, findInvoice, loadInvoice, updateInvoiceState } from "./service/invoice-state";
import { issuerSettings } from "./service/issue-invoice";

// ---------------------------------------------------------------------------
// Keys and inputs
// ---------------------------------------------------------------------------

export const RenderPdfInput = z.object({ invoiceId: z.uuid() });
/** `issued`, `resend:<n>`, `reminder:<yyyy-mm-dd>` or `peppol_fallback` (section 4.5). */
export const InvoiceEmailReason = z.string().regex(/^(issued|resend:\d{1,6}|reminder:\d{4}-\d{2}-\d{2}|peppol_fallback)$/);
export const SendInvoiceEmailInput = z.object({ invoiceId: z.uuid(), reason: InvoiceEmailReason, to: z.email().optional() });

export const renderPdfKey = (invoiceId: string): string => `invoice_pdf:${invoiceId}`;
/** The idempotency key of `finance.send_invoice_email`, also the email key passed to `sendTransactional`. */
export const invoiceEmailKey = (invoiceId: string, reason: string): string => `invoice_email:${invoiceId}:${reason}`;
export const billitPushKey = (doc: Pick<InvoiceRecord, "id" | "kind">): string => `billit:${doc.kind}:${doc.id}`;

const isAnonymised = (doc: InvoiceRecord) => "anonymised" in doc.customerSnapshot;

// ---------------------------------------------------------------------------
// finance.render_pdf
// ---------------------------------------------------------------------------

/** Rule 38: which documents get the invoice email automatically once their PDF exists. */
export function emailsOnIssue(doc: Pick<InvoiceRecord, "kind" | "isCompany" | "status" | "replacesInvoiceId">): boolean {
  if (doc.kind === "credit_note") return true;
  return doc.isCompany || doc.status === "open" || doc.replacesInvoiceId !== null;
}

async function hasRenderedFile(tx: DbOrTx, doc: InvoiceRecord): Promise<boolean> {
  return doc.pdfStatus === "rendered" && !!doc.pdfFileId && (await readFile(tx, doc.pdfFileId)) !== null;
}

/** Marks the document's PDF `failed` in a write that survives the job's rollback. */
async function markPdfFailed(ctx: JobCtx, invoiceId: string): Promise<void> {
  await writeDurably(ctx, async (db) => {
    const doc = await findInvoice(db, invoiceId);
    if (doc && doc.pdfStatus !== "rendered") await updateInvoiceState(db as Tx, invoiceId, { pdfStatus: "failed" });
  });
}

/**
 * Renders the document's PDF from its snapshots (rule 36): never replaces a rendered PDF whose
 * file exists, never renders a document anonymised by the retention sweep. Before the first
 * render an incomplete seller block is refreshed from the current settings (edge case 16).
 * In production a seller block without VAT number, enterprise number or IBAN is a permanent
 * failure (`pdf_status = 'failed'`). Then enqueues the Billit push and, per rule 38, the email.
 */
export async function runRenderPdf(ctx: JobCtx, input: z.infer<typeof RenderPdfInput>) {
  const tx = ctx.tx;
  let doc = await loadInvoice(tx, input.invoiceId, { forUpdate: true });
  if (isAnonymised(doc)) return { status: "skipped_anonymised" as const };
  if (await hasRenderedFile(tx, doc)) return { status: "already_rendered" as const, fileId: doc.pdfFileId };

  if (doc.billitId === null && missingIssuerFields(doc.sellerSnapshot).length > 0) {
    const { company, finance } = await issuerSettings(tx);
    const fresh = buildSellerSnapshot(company, finance, doc.locale);
    if (JSON.stringify(fresh) !== JSON.stringify(doc.sellerSnapshot)) {
      await updateInvoiceState(tx, doc.id, { sellerSnapshot: fresh });
      doc = { ...doc, sellerSnapshot: fresh };
    }
  }

  let bytes: Uint8Array;
  try {
    assertRenderableSeller(doc.sellerSnapshot, process.env.APP_ENV);
    const original = doc.reversesInvoiceId ? await findInvoice(tx, doc.reversesInvoiceId) : null;
    bytes = await renderInvoicePdf(buildInvoiceDocumentModel(doc, original ? { number: original.number } : undefined));
  } catch (error) {
    await markPdfFailed(ctx, doc.id);
    if (error instanceof MissingCompanySettingsError) throw error;
    throw new PermanentError(`finance.render_pdf: template error: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }

  const { fileId } = await storeFile(ctx, { kind: "invoice_pdf", name: `${doc.number}.pdf`, mime: "application/pdf", bytes });
  await updateInvoiceState(tx, doc.id, { pdfFileId: fileId, pdfStatus: "rendered" });

  await enqueueFinanceJob(ctx, {
    kind: doc.kind === "invoice" ? "billit.push_invoice" : "billit.push_credit_note",
    payload: { invoiceId: doc.id },
    key: billitPushKey(doc),
  });
  if (emailsOnIssue(doc)) {
    await ctx.enqueue({ kind: "finance.send_invoice_email", payload: { invoiceId: doc.id, reason: "issued" }, key: invoiceEmailKey(doc.id, "issued") });
  }
  return { status: "rendered" as const, fileId };
}

// ---------------------------------------------------------------------------
// finance.send_invoice_email
// ---------------------------------------------------------------------------

/** Rule 39: the order's billing email, else the person's email; null when there is none. */
export async function invoiceRecipient(tx: DbOrTx, doc: InvoiceRecord): Promise<string | null> {
  if (isAnonymised(doc)) return null;
  const billing = await getOrderBillingDetails(tx, doc.orderId);
  if (billing?.billingEmail) return billing.billingEmail;
  if (!doc.personId) return null;
  const [person] = await tx.select({ email: persons.email }).from(persons).where(eq(persons.id, doc.personId));
  return person?.email?.trim() || null;
}

/** The message language: `persons.locale`, else `orders.locale`, else the document locale (section 8). */
export async function invoiceEmailLocale(tx: DbOrTx, doc: InvoiceRecord): Promise<Locale> {
  if (doc.personId) {
    const [person] = await tx.select({ locale: persons.locale }).from(persons).where(eq(persons.id, doc.personId));
    if (person && isLocale(person.locale)) return person.locale;
  }
  const [order] = await tx.select({ locale: orders.locale }).from(orders).where(eq(orders.id, doc.orderId));
  return order && isLocale(order.locale) ? order.locale : doc.locale;
}

const appUrl = (path: string) => `${(process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "")}${path}`;

/** `finance.invoice_reminder` for reminders, `finance.credit_note` for credit notes, else `finance.invoice`. */
export function invoiceEmailTemplate(doc: Pick<InvoiceRecord, "kind">, reason: string) {
  if (reason.startsWith("reminder:")) return "finance.invoice_reminder" as const;
  return doc.kind === "credit_note" ? ("finance.credit_note" as const) : ("finance.invoice" as const);
}

/** A company document for a Belgian VAT-registered buyer goes over Peppol; the email is a courtesy copy (rule 19a). */
export function isPeppolBuyer(doc: InvoiceRecord): boolean {
  const s = doc.customerSnapshot;
  return doc.isCompany && !("anonymised" in s) && !!s.vat_number?.toUpperCase().startsWith("BE");
}

/** The template `data` (finance spec section 8): formatted in the message locale, no personal data. */
export function invoiceEmailData(doc: InvoiceRecord, locale: Locale, reason: string) {
  const open = doc.kind === "invoice" && doc.status === "open";
  return {
    number: doc.number,
    totalFormatted: formatMoney(doc.totalCents, locale),
    portalUrl: appUrl(`/${URL_SEGMENT[locale]}/account/invoices`),
    ...(open && doc.dueOn ? { dueOn: formatDate(doc.dueOn, locale, "long") } : {}),
    ...(open && doc.paymentReference ? { paymentReference: doc.paymentReference } : {}),
    ...(open && doc.sellerSnapshot.iban ? { iban: formatIban(doc.sellerSnapshot.iban) } : {}),
    ...(doc.kind === "credit_note" && doc.reason ? { reason: doc.reason } : {}),
    ...(isPeppolBuyer(doc) && reason !== "peppol_fallback" ? { isCourtesyCopy: true } : {}),
  };
}

/**
 * Queues the invoice, credit-note or reminder email with the PDF attached (rules 38 and 39).
 * No recipient is a success (`skipped_no_recipient`); the email key is the job key, so a second
 * run queues no second message. Sets `emailed_at` and records `invoice.emailed` once per reason.
 */
export async function runSendInvoiceEmail(ctx: JobCtx, input: z.infer<typeof SendInvoiceEmailInput>) {
  const tx = ctx.tx;
  const doc = await loadInvoice(tx, input.invoiceId);
  const to = input.to ?? (await invoiceRecipient(tx, doc));
  if (!to || isAnonymised(doc)) return { status: "skipped_no_recipient" as const };
  if (doc.pdfStatus !== "rendered" || !doc.pdfFileId) throw new RetryableError("finance.send_invoice_email: pdf_not_rendered");

  const locale = await invoiceEmailLocale(tx, doc);
  const key = invoiceEmailKey(doc.id, input.reason);
  const { emailMessageId } = await sendTransactional(ctx, {
    template: invoiceEmailTemplate(doc, input.reason),
    ...(doc.personId ? { personId: doc.personId } : {}),
    to,
    locale,
    data: invoiceEmailData(doc, locale, input.reason),
    key,
    attachments: [{ fileId: doc.pdfFileId, filename: `${doc.number}.pdf` }],
  });

  const subject = eventSubject(doc);
  const first = subject
    ? (
        await ctx.recordEvent({
          kind: "invoice.emailed",
          ...subject,
          data: { invoice_id: doc.id, number: doc.number, reason: input.reason },
          ref: { type: "invoice", id: doc.id },
          dedupeKey: key,
        })
      ).id !== null
    : doc.emailedAt === null;
  if (first) await updateInvoiceState(tx, doc.id, { emailedAt: ctx.now });
  return { status: "queued" as const, emailMessageId };
}

export const jobs = [
  defineJob({
    kind: "finance.render_pdf",
    lane: "fast",
    priority: 5,
    maxAttempts: 6,
    timeoutMs: 60_000,
    input: RenderPdfInput,
    run: runRenderPdf,
    onDead: async (ctx, input) => {
      const doc = await findInvoice(ctx.tx, input.invoiceId);
      if (doc && doc.pdfStatus !== "rendered") await updateInvoiceState(ctx.tx, input.invoiceId, { pdfStatus: "failed" });
    },
  }),
  defineJob({ kind: "finance.send_invoice_email", lane: "fast", priority: 1, maxAttempts: 6, input: SendInvoiceEmailInput, run: runSendInvoiceEmail }),
];
