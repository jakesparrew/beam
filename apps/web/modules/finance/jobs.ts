/**
 * finance jobs (`defineJob`, finance spec section 4.5). Facade read by `pnpm gen:indexes`.
 * finance-P3: `finance.render_pdf` and `finance.send_invoice_email`. finance-P4: the Billit jobs
 * (`billit.push_customer`, `billit.push_invoice`, `billit.push_credit_note`, `billit.send_peppol`,
 * `billit.push_payment`, `billit.sync_pending`, `billit.reconcile`) and `finance.scan_overdue`;
 * their handlers live in `service/billit-sync.ts` and `service/reconcile.ts`.
 * `finance.build_export` comes with finance-P7.
 */
import { z } from "zod";
import type { DbOrTx, Tx } from "@beam/db";
import { invoices, orders, persons } from "@beam/db/schema";
import { buildSellerSnapshot, missingIssuerFields, type InvoiceRecord } from "@beam/core/finance";
import { formatDate, formatMoney, isLocale, URL_SEGMENT, type Locale } from "@beam/core/i18n";
import { IntegrationError } from "@beam/integrations/_shared";
import { isBillitAuthError } from "@beam/integrations/billit";
import { and, eq, lte, writeDurably } from "@/lib/ctx";
import { defineJob, PermanentError, RetryableError, type JobCtx } from "@/lib/job-runner";
import { createTask } from "@/modules/crm/api";
import { sendTransactional } from "@/modules/email/api";
import { notifySlack, readFile, storeFile } from "@/modules/platform/api";
import { assertRenderableSeller, buildInvoiceDocumentModel, formatIban, MissingCompanySettingsError, renderInvoicePdf } from "./pdf/render";
import { raiseAuthAlert } from "./service/billit-failure";
import {
  brusselsDay,
  financeSettings,
  nextBusinessDayAt10,
  runPushCustomer,
  runPushDocument,
  runPushPayment,
  runSendPeppol,
  runSyncPending,
} from "./service/billit-sync";
import { getOrderBillingDetails } from "./service/billing-details";
import { enqueueFinanceJob, eventSubject, findInvoice, loadInvoice, updateInvoiceState } from "./service/invoice-state";
import { addDays, issuerSettings } from "./service/issue-invoice";
import { countDocuments, reconcile, upsertReconcileRun } from "./service/reconcile";

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

// ---------------------------------------------------------------------------
// billit.reconcile
// ---------------------------------------------------------------------------

export const ReconcileInput = z.object({ manual: z.number().int().positive().optional() });

const issueCounts = (issues: readonly { type: string }[]) =>
  Object.entries(issues.reduce<Record<string, number>>((acc, i) => ({ ...acc, [i.type]: (acc[i.type] ?? 0) + 1 }), {}))
    .map(([type, n]) => `${type} ${n}`)
    .join(", ");

/**
 * `billit.reconcile` (section 4.5): checks the last `reconcile_lookback_days` (35) of documents
 * against Billit, sequence gaps, stale pushes and missing PDFs; upserts the day's
 * `billit_reconcile_runs` row. A `sequence_gap` raises `sequence-gap:<year>:<kind>` (High); any
 * issue sends the summary `billit-reconcile:<run_on>` (High with an amount mismatch or a gap,
 * else Normal). Billit unreachable: the run is stored as `failed` and the job retries.
 */
export async function runReconcile(ctx: JobCtx, _input: z.infer<typeof ReconcileInput>) {
  const tx = ctx.tx;
  const settings = await financeSettings(tx);
  if (!settings.billit_enabled) return { status: "disabled" as const };
  const runOn = brusselsDay(ctx.now);
  const window = { from: addDays(runOn, -settings.reconcile_lookback_days), to: runOn, now: ctx.now };
  const startedAt = new Date();
  let issues;
  try {
    issues = await reconcile(tx, ctx.integrations.billit, window);
  } catch (error) {
    if (error instanceof IntegrationError) {
      await writeDurably(ctx, async (db) => void (await upsertReconcileRun(db, { runOn, startedAt, finishedAt: new Date(), status: "failed", checkedCount: 0, issues: [] })));
      if (isBillitAuthError(error)) await raiseAuthAlert(ctx);
    }
    throw error;
  }
  const checkedCount = await countDocuments(tx, window);
  const runId = await upsertReconcileRun(tx, { runOn, startedAt, finishedAt: new Date(), status: issues.length ? "issues" : "ok", checkedCount, issues });

  for (const gap of issues.filter((i) => i.type === "sequence_gap")) {
    const m = /^(invoice|credit_note) (\d{4}):/.exec(gap.detail);
    if (m) await notifySlack(ctx, { fingerprint: `sequence-gap:${m[2]}:${m[1]}`, severity: "high", text: `Invoice numbering gap: ${gap.detail}` });
  }
  if (issues.length) {
    const high = issues.some((i) => i.type === "amount_mismatch" || i.type === "sequence_gap");
    await notifySlack(ctx, { fingerprint: `billit-reconcile:${runOn}`, severity: high ? "high" : "normal", text: `Billit reconcile ${runOn}: ${issues.length} issue(s) (${issueCounts(issues)})` });
  }
  return { status: issues.length ? ("issues" as const) : ("ok" as const), runId, checkedCount, issues: issues.length };
}

// ---------------------------------------------------------------------------
// finance.scan_overdue
// ---------------------------------------------------------------------------

export const OVERDUE_AFTER_DAYS = 7;

const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);

/**
 * `finance.scan_overdue` (rule 29): every `open` invoice at least 7 days past its due date gets
 * `invoice.overdue` once (no event without a person or company: erased or anonymous) and one
 * `payment` task for the finance role, due the next business day at 10:00 Brussels.
 */
export async function runScanOverdue(ctx: JobCtx) {
  const tx = ctx.tx;
  const today = brusselsDay(ctx.now);
  const rows = (await tx
    .select()
    .from(invoices)
    .where(and(eq(invoices.kind, "invoice"), eq(invoices.status, "open"), lte(invoices.dueOn, addDays(today, -OVERDUE_AFTER_DAYS))))) as InvoiceRecord[];
  let events = 0;
  let tasks = 0;
  for (const inv of rows) {
    const subject = eventSubject(inv);
    if (subject) {
      const { id } = await ctx.recordEvent({
        kind: "invoice.overdue",
        ...subject,
        data: { invoice_id: inv.id, number: inv.number, days_overdue: daysBetween(inv.dueOn!, today), total_cents: inv.totalCents },
        ref: { type: "invoice", id: inv.id },
        dedupeKey: `invoice:${inv.id}:overdue`,
      });
      if (id !== null) events += 1;
    }
    const { created } = await createTask(tx, ctx, {
      title: `Follow up overdue invoice ${inv.number}`,
      kind: "payment",
      priority: "high",
      dueAt: nextBusinessDayAt10(ctx.now),
      ownerRole: "finance",
      source: "system",
      ref: { type: "invoice", id: inv.id },
      ...(subject ?? {}),
      dedupeKey: `invoice:${inv.id}:overdue_task`,
    });
    if (created) tasks += 1;
  }
  return { scanned: rows.length, events, tasks };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const InvoiceIdInput = z.object({ invoiceId: z.uuid() });
export const PushCustomerInput = z.object({ partyKey: z.string().regex(/^(walk_in|(person|company):[0-9a-f-]{36}|vat:[A-Z]{2}[0-9A-Z+*]{2,13})$/) });
export const SyncPendingInput = z.object({ offset: z.number().int().nonnegative().optional() });

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
  defineJob({ kind: "billit.push_customer", lane: "fast", priority: 5, maxAttempts: 6, input: PushCustomerInput, run: runPushCustomer }),
  defineJob({ kind: "billit.push_invoice", lane: "fast", priority: 5, maxAttempts: 6, input: InvoiceIdInput, run: runPushDocument }),
  defineJob({ kind: "billit.push_credit_note", lane: "fast", priority: 5, maxAttempts: 6, input: InvoiceIdInput, run: runPushDocument }),
  defineJob({ kind: "billit.send_peppol", lane: "fast", priority: 5, maxAttempts: 6, input: InvoiceIdInput, run: runSendPeppol }),
  defineJob({ kind: "billit.push_payment", lane: "fast", priority: 5, maxAttempts: 6, input: InvoiceIdInput, run: runPushPayment }),
  defineJob({ kind: "billit.sync_pending", lane: "bulk", priority: 5, maxAttempts: 6, timeoutMs: 120_000, input: SyncPendingInput, run: runSyncPending }),
  defineJob({ kind: "billit.reconcile", lane: "bulk", priority: 9, maxAttempts: 6, timeoutMs: 240_000, input: ReconcileInput, run: runReconcile }),
  defineJob({ kind: "finance.scan_overdue", lane: "bulk", priority: 9, maxAttempts: 6, input: z.object({}).passthrough(), run: (ctx) => runScanOverdue(ctx) }),
];
