"use server";
/**
 * finance server actions (finance spec 4.2, finance-P5). Every staff action needs
 * `invoices.issue` (exports: `reports.finance`) and writes its own `audit_log` row with the
 * action name of spec section 7 (`entity_type` `invoice`, `invoice_request` or
 * `finance_export`, `person_id` of the document). The two customer actions (`audience:
 * 'customer'`) reach only the customer's own documents and answer `not_found` otherwise.
 * Side effects are jobs enqueued in the action's transaction: a retry always takes a new key
 * (`...:r<n>`), a resend `resend:<n>`, a reminder `reminder:<yyyy-mm-dd>`.
 */
import { z } from "zod";
import type { Tx } from "@beam/db";
import { financeExports, invoiceRequests, invoices, jobs } from "@beam/db/schema";
import {
  BillingDetailsInput,
  buildSellerSnapshot,
  creditLines,
  documentTotals,
  FinanceConflictError,
  isAnonymisedSnapshot,
  type InvoiceLine,
  type InvoiceRecord,
} from "@beam/core/finance";
import { action } from "@/lib/action";
import { and, desc, eq, gte, NotFoundError, or, sql, ValidationError, type Ctx, type JobKind } from "@/lib/ctx";
import { cancelOrder, recordBankTransferPaid } from "@/modules/commerce/api";
import { sendTransactional } from "@/modules/email/api";
import { invoiceEmailData, invoiceEmailKey, invoiceEmailLocale } from "./jobs";
import { brusselsDay, brusselsNoon } from "./service/billit-sync";
import { enqueueFinanceJob, findInvoice, loadInvoice, updateInvoiceState } from "./service/invoice-state";
import { issueCreditNote } from "./service/issue-credit-note";
import { addDays, financeLabel, issuerSettings } from "./service/issue-invoice";
import { reissueToCompany } from "./service/reissue";
import { blockedPdfIds, pdfFileExists } from "./service/pdf-file";
import { markInvoicePaidInternal } from "./service/settle";

const uuid = z.uuid();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "finance.errors.date_invalid");
const reason = z.string().trim().min(3, "finance.errors.reason_required").max(500);
const CreditLine = z
  .object({ orderLineId: uuid, quantity: z.number().int().positive().optional(), amountCents: z.number().int().positive().optional() })
  .refine((l) => (l.quantity === undefined) !== (l.amountCents === undefined), { message: "finance.errors.credit_line_quantity_or_amount" });

/** Staff actions write their own audit row (spec section 7 names); the wrapper adds none. */
const staff = <N extends `${string}.${string}`>(name: N) => ({ name, audience: "staff" as const, permission: "invoices.issue" as const, audit: false as const });

const docPerson = (doc: Pick<InvoiceRecord, "personId">) => doc.personId ?? null;

function staffUserId(ctx: Ctx): string | null {
  return ctx.actor.kind === "staff" ? ctx.actor.userId : null;
}

/**
 * Enqueues `kind` for document `invoiceId` unless one is live; the first job takes `base`, later
 * ones `base:r<n>` (a retry never reuses a key, so a dead job never blocks it).
 */
async function enqueueWithRetryKey(ctx: Ctx, kind: JobKind, invoiceId: string, base: string, payload: Record<string, unknown> = { invoiceId }): Promise<string> {
  const rows = await ctx.tx
    .select({ id: jobs.id, status: jobs.status })
    .from(jobs)
    .where(and(eq(jobs.kind, kind), sql`${jobs.payload} ->> 'invoiceId' = ${invoiceId}`))
    .orderBy(desc(jobs.createdAt));
  const live = rows.find((r) => r.status === "pending" || r.status === "running");
  if (live) return live.id;
  for (let n = rows.length; n < rows.length + 20; n++) {
    const key = n === 0 ? base : `${base}:r${n}`;
    const { id, inserted } = await ctx.enqueue({ kind, payload, key });
    if (inserted) return id;
  }
  throw new FinanceConflictError("finance.errors.retry_failed");
}

/** Brussels today of the context. */
const todayOf = (ctx: Ctx) => brusselsDay(ctx.now);

// ---------------------------------------------------------------------------
// Credit notes, reissue, settlement
// ---------------------------------------------------------------------------

const IssueManualCreditNoteInput = z.object({ invoiceId: uuid, reason, lines: z.array(CreditLine).max(200).optional(), noRefund: z.boolean() });

/**
 * Rule 25: a manual credit note needs a reason and either an `open` invoice or `noRefund`. A credit
 * that would cover what is left of an `open` invoice cancels the order through commerce's
 * `cancelOrder` (which issues the credit note in this transaction) and returns that credit note.
 */
export const issueManualCreditNote = action({ ...staff("finance.credit_note.issue"), input: IssueManualCreditNoteInput }, async (ctx, input) => {
  const tx = ctx.tx;
  const invoice = await loadInvoice(tx, input.invoiceId, { forUpdate: true });
  if (invoice.kind !== "invoice") throw new FinanceConflictError("finance.errors.not_an_invoice");
  let result: { creditNoteId: string; number: string };
  if (invoice.status === "open" && (await coversRemaining(tx, invoice, input.lines))) {
    const { cancelled } = await cancelOrder(tx, ctx, { orderId: invoice.orderId, reason: input.reason });
    if (!cancelled) throw new FinanceConflictError("finance.errors.order_not_cancellable");
    const [note] = await tx
      .select({ id: invoices.id, number: invoices.number })
      .from(invoices)
      .where(and(eq(invoices.kind, "credit_note"), eq(invoices.reversesInvoiceId, invoice.id)))
      .orderBy(desc(invoices.issuedAt), desc(invoices.sequenceNumber))
      .limit(1);
    if (!note) throw new FinanceConflictError("finance.errors.order_not_cancellable");
    result = { creditNoteId: note.id, number: note.number };
  } else {
    const issued = await issueCreditNote(tx, ctx, { invoiceId: invoice.id, reason: input.reason, noRefund: input.noRefund, ...(input.lines?.length ? { lines: input.lines } : {}) });
    result = { creditNoteId: issued.creditNoteId, number: issued.number };
  }
  await ctx.audit({
    action: "invoice.credit_note_issued",
    entityType: "invoice",
    entityId: invoice.id,
    personId: docPerson(invoice),
    newValue: { credit_note_id: result.creditNoteId, number: result.number, reason: input.reason, no_refund: input.noRefund, lines: input.lines ?? "full" },
  });
  return result;
});

/** Whether crediting `lines` (all when omitted) takes what is left of the invoice to zero. */
async function coversRemaining(tx: Tx, invoice: InvoiceRecord, lines: z.infer<typeof CreditLine>[] | undefined): Promise<boolean> {
  if (!lines?.length) return true;
  const earlier = await tx
    .select({ lines: invoices.lines, totalCents: invoices.totalCents })
    .from(invoices)
    .where(and(eq(invoices.kind, "credit_note"), eq(invoices.reversesInvoiceId, invoice.id)));
  const already: InvoiceLine[][] = earlier.map((n) => n.lines);
  const remaining = invoice.totalCents + earlier.reduce((sum, n) => sum + n.totalCents, 0);
  const credit = creditLines(invoice.lines, already, lines, { partialCreditLabel: financeLabel(invoice.locale, "finance.pdf.partial_credit") });
  return -documentTotals(credit).totalCents >= remaining;
}

const ReissueInvoiceInput = z.object({ invoiceId: uuid, billing: BillingDetailsInput, reason });

/** Rule 20: full credit note plus a new invoice with the corrected billing details. */
export const reissueInvoice = action({ ...staff("finance.invoice.reissue"), input: ReissueInvoiceInput }, async (ctx, input) => {
  const original = await loadInvoice(ctx.tx, input.invoiceId);
  const out = await reissueToCompany(ctx.tx, ctx, { invoiceId: input.invoiceId, billing: input.billing, reason: input.reason });
  await ctx.audit({
    action: "invoice.reissued",
    entityType: "invoice",
    entityId: input.invoiceId,
    personId: docPerson(original),
    oldValue: { status: original.status, number: original.number },
    newValue: { credit_note_id: out.creditNoteId, invoice_id: out.invoiceId, number: out.number, reason: input.reason },
  });
  return out;
});

const MarkInvoicePaidInput = z.object({
  invoiceId: uuid,
  paidOn: day,
  bankReference: z.string().trim().max(100).optional(),
  note: z.string().trim().min(3, "finance.errors.note_required").max(500),
});

/**
 * Rule 27: staff settle an `open` invoice (`settled_via = 'manual'`) and commerce's paid
 * transaction runs through `recordBankTransferPaid`. A second call for a paid invoice is a no-op.
 */
export const markInvoicePaid = action({ ...staff("finance.invoice.mark_paid"), input: MarkInvoicePaidInput }, async (ctx, input) => {
  const tx = ctx.tx;
  const invoice = await loadInvoice(tx, input.invoiceId, { forUpdate: true });
  if (invoice.kind !== "invoice") throw new FinanceConflictError("finance.errors.not_an_invoice");
  if (invoice.status === "paid") return { ok: true as const, changed: false };
  if (invoice.status !== "open") throw new FinanceConflictError("finance.errors.not_open");
  if (input.paidOn > todayOf(ctx)) throw new ValidationError("finance.errors.paid_on_future", { paidOn: "finance.errors.paid_on_future" });
  if (input.paidOn < invoice.issuedOn) throw new ValidationError("finance.errors.paid_on_before_issue", { paidOn: "finance.errors.paid_on_before_issue" });

  const { changed } = await markInvoicePaidInternal(tx, ctx, {
    invoiceId: invoice.id,
    paidAt: brusselsNoon(input.paidOn),
    settledVia: "manual",
    ...(input.bankReference ? { bankReference: input.bankReference } : {}),
  });
  if (changed) await recordBankTransferPaid(tx, ctx, { orderId: invoice.orderId, paidOn: input.paidOn, reference: invoice.number });
  await ctx.audit({
    action: "invoice.marked_paid",
    entityType: "invoice",
    entityId: invoice.id,
    personId: docPerson(invoice),
    oldValue: { status: invoice.status },
    newValue: { status: "paid", paid_on: input.paidOn, bank_reference: input.bankReference ?? null, note: input.note },
  });
  return { ok: true as const, changed };
});

// ---------------------------------------------------------------------------
// Billit
// ---------------------------------------------------------------------------

const PUSH_KIND = { invoice: "billit.push_invoice", credit_note: "billit.push_credit_note" } as const;

/** The push a document needs: the document itself until it is synced, then its payment. */
async function retryPush(ctx: Ctx, doc: InvoiceRecord): Promise<string | null> {
  if (doc.billitStatus !== "synced") return enqueueWithRetryKey(ctx, PUSH_KIND[doc.kind], doc.id, `billit:${doc.kind}:${doc.id}`);
  if (doc.billitPaymentStatus === "failed" || doc.billitPaymentStatus === "pending") {
    return enqueueWithRetryKey(ctx, "billit.push_payment", doc.id, `billit:payment:${doc.id}`);
  }
  return null;
}

const RetryBillitSyncInput = z.object({ invoiceId: uuid });

export const retryBillitSync = action({ ...staff("finance.billit.retry"), input: RetryBillitSyncInput }, async (ctx, input) => {
  const doc = await loadInvoice(ctx.tx, input.invoiceId);
  const jobId = await retryPush(ctx, doc);
  if (!jobId) throw new FinanceConflictError("finance.errors.already_synced");
  await ctx.audit({ action: "billit.retry", entityType: "invoice", entityId: doc.id, personId: docPerson(doc), newValue: { job_id: jobId, billit_status: doc.billitStatus } });
  return { jobId };
});

export const retryAllBillitFailed = action({ ...staff("finance.billit.retry_all"), input: z.object({}) }, async (ctx) => {
  const failed = (await ctx.tx
    .select()
    .from(invoices)
    .where(or(eq(invoices.billitStatus, "failed"), eq(invoices.billitPaymentStatus, "failed")))
    .orderBy(invoices.createdAt)
    .limit(500)) as InvoiceRecord[];
  let count = 0;
  for (const doc of failed) if (await retryPush(ctx, doc)) count += 1;
  await ctx.audit({ action: "billit.retry_all", entityType: "invoice", entityId: null, newValue: { count } });
  return { count };
});

export const runBillitReconcileNow = action({ ...staff("finance.billit.reconcile"), input: z.object({}) }, async (ctx) => {
  const today = todayOf(ctx);
  const prefix = `billit:reconcile:${today}:manual:`;
  const [row] = await ctx.tx
    .select({ n: sql<number>`count(*)::int` })
    .from(jobs)
    .where(and(eq(jobs.kind, "billit.reconcile"), sql`${jobs.idempotencyKey} like ${`${prefix}%`}`));
  const manual = Number(row?.n ?? 0) + 1;
  const { id } = await ctx.enqueue({ kind: "billit.reconcile", payload: { manual }, key: `${prefix}${manual}` });
  await ctx.audit({ action: "billit.reconcile_requested", entityType: "invoice", entityId: null, newValue: { job_id: id, run_on: today } });
  return { jobId: id };
});

// ---------------------------------------------------------------------------
// PDF and emails
// ---------------------------------------------------------------------------

const RerenderInvoicePdfInput = z.union([z.object({ invoiceId: uuid }), z.object({ allBlocked: z.literal(true) })]);

/**
 * A document may be re-rendered when its PDF failed or its file is missing, never after the
 * retention sweep. Checks the file's existence only, never its bytes.
 */
async function isBlocked(tx: Tx, doc: InvoiceRecord): Promise<boolean> {
  if (isAnonymisedSnapshot(doc.customerSnapshot)) return false;
  if (doc.pdfStatus === "failed") return true;
  if (doc.pdfStatus === "rendered") return !(await pdfFileExists(tx, doc.pdfFileId));
  return false;
}

/**
 * Edge case 16: refreshes `seller_snapshot` from the current settings when 2.2 allows it (no PDF
 * rendered, not in Billit), then queues `finance.render_pdf` with `invoice_pdf:<id>:r<n>`.
 * `allBlocked` picks one batch of blocked documents with a single query (no bytes, no locks)
 * and locks only those rows, each re-checked under its lock.
 */
export const rerenderInvoicePdf = action({ ...staff("finance.pdf.rerender"), input: RerenderInvoicePdfInput }, async (ctx, input) => {
  const tx = ctx.tx;
  const ids =
    "invoiceId" in input
      ? [input.invoiceId]
      : await blockedPdfIds(tx);
  const { company, finance } = await issuerSettings(tx);
  const jobIds: string[] = [];
  for (const id of ids) {
    const doc = await loadInvoice(tx, id, { forUpdate: true });
    if (!(await isBlocked(tx, doc))) {
      if ("invoiceId" in input) throw new FinanceConflictError("finance.errors.pdf_not_blocked");
      continue;
    }
    if (doc.pdfStatus !== "rendered" && doc.billitId === null) {
      const fresh = buildSellerSnapshot(company, finance, doc.locale);
      if (JSON.stringify(fresh) !== JSON.stringify(doc.sellerSnapshot)) await updateInvoiceState(tx, doc.id, { sellerSnapshot: fresh });
    }
    jobIds.push(await enqueueWithRetryKey(ctx, "finance.render_pdf", doc.id, `invoice_pdf:${doc.id}`));
    await ctx.audit({ action: "invoice.pdf_rerendered", entityType: "invoice", entityId: doc.id, personId: docPerson(doc), oldValue: { pdf_status: doc.pdfStatus } });
  }
  return { jobIds };
});

const ResendInvoiceEmailInput = z.object({ invoiceId: uuid, to: z.email().optional() });

/** Rule 39: staff resend the document email, to the default recipient or any address. */
export const resendInvoiceEmail = action({ ...staff("finance.invoice.resend"), input: ResendInvoiceEmailInput }, async (ctx, input) => {
  const doc = await loadInvoice(ctx.tx, input.invoiceId);
  if (isAnonymisedSnapshot(doc.customerSnapshot)) throw new FinanceConflictError("finance.errors.invoice_immutable");
  const [row] = await ctx.tx
    .select({ n: sql<number>`count(*)::int` })
    .from(jobs)
    .where(and(eq(jobs.kind, "finance.send_invoice_email"), sql`${jobs.idempotencyKey} like ${`invoice_email:${doc.id}:resend:%`}`));
  const reasonKey = `resend:${Number(row?.n ?? 0) + 1}`;
  const { id } = await ctx.enqueue({
    kind: "finance.send_invoice_email",
    payload: { invoiceId: doc.id, reason: reasonKey, ...(input.to ? { to: input.to } : {}) },
    key: invoiceEmailKey(doc.id, reasonKey),
  });
  await ctx.audit({ action: "invoice.email_resent", entityType: "invoice", entityId: doc.id, personId: docPerson(doc), newValue: { reason: reasonKey, to: input.to ?? null } });
  return { jobId: id };
});

const REMINDER_INTERVAL_DAYS = 7;

/** Rule 29: one staff payment reminder per 7 days for an open, overdue invoice. */
export const sendPaymentReminder = action({ ...staff("finance.invoice.remind"), input: z.object({ invoiceId: uuid }) }, async (ctx, input) => {
  const tx = ctx.tx;
  const doc = await loadInvoice(tx, input.invoiceId, { forUpdate: true });
  const today = todayOf(ctx);
  if (doc.kind !== "invoice" || doc.status !== "open") throw new FinanceConflictError("finance.errors.not_open");
  if (!doc.dueOn || doc.dueOn >= today) throw new FinanceConflictError("finance.errors.not_overdue");
  const since = new Date(ctx.now.getTime() - REMINDER_INTERVAL_DAYS * 86_400_000);
  const [recent] = await tx
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.kind, "finance.send_invoice_email"), sql`${jobs.idempotencyKey} like ${`invoice_email:${doc.id}:reminder:%`}`, gte(jobs.createdAt, since)))
    .limit(1);
  if (recent) throw new FinanceConflictError("finance.errors.reminder_too_soon");
  const reasonKey = `reminder:${today}`;
  const { id, inserted } = await ctx.enqueue({ kind: "finance.send_invoice_email", payload: { invoiceId: doc.id, reason: reasonKey }, key: invoiceEmailKey(doc.id, reasonKey) });
  if (!inserted) throw new FinanceConflictError("finance.errors.reminder_too_soon");
  const subject = doc.personId ? { personId: doc.personId } : doc.companyId ? { companyId: doc.companyId } : null;
  if (subject) {
    await ctx.recordEvent({
      kind: "invoice.reminder_sent",
      ...subject,
      data: { invoice_id: doc.id, number: doc.number },
      ref: { type: "invoice", id: doc.id },
      dedupeKey: `invoice:${doc.id}:reminder:${today}`,
    });
  }
  await ctx.audit({ action: "invoice.reminder_sent", entityType: "invoice", entityId: doc.id, personId: docPerson(doc), newValue: { reason: reasonKey } });
  return { jobId: id };
});

// ---------------------------------------------------------------------------
// Company invoice requests (rule 20)
// ---------------------------------------------------------------------------

const REISSUE_REASON = "Reissued to company";

const DecideCompanyInvoiceRequestInput = z.object({ requestId: uuid, decision: z.enum(["approve", "reject"]), note: z.string().trim().max(500).optional() });

/** Approve (credit note plus reissue to the requested company) or reject a pending request. */
export const decideCompanyInvoiceRequest = action(
  { name: "finance.request.decide", audience: "staff", permission: "invoices.issue", input: DecideCompanyInvoiceRequestInput, audit: false },
  async (ctx, input) => {
    const tx = ctx.tx;
    const [request] = await tx.select().from(invoiceRequests).where(eq(invoiceRequests.id, input.requestId)).for("update");
    if (!request) throw new NotFoundError("finance.errors.request_not_found");
    if (request.status !== "requested") throw new FinanceConflictError("finance.errors.invalid_transition");
    const invoice = await loadInvoice(tx, request.invoiceId);
    const approved = input.decision === "approve";
    const reissued = approved ? await reissueToCompany(tx, ctx, { invoiceId: invoice.id, billing: request.billing, reason: REISSUE_REASON }) : null;
    await tx
      .update(invoiceRequests)
      .set({
        status: approved ? "approved" : "rejected",
        decidedByUserId: staffUserId(ctx),
        decidedAt: ctx.now,
        decisionNote: input.note?.trim() || null,
        ...(reissued ? { creditNoteId: reissued.creditNoteId, newInvoiceId: reissued.invoiceId } : {}),
        updatedAt: sql`now()`,
      })
      .where(eq(invoiceRequests.id, request.id));

    const decision = approved ? ("approved" as const) : ("rejected" as const);
    if (request.personId) {
      await ctx.recordEvent({
        kind: "invoice.company_request_decided",
        personId: request.personId,
        data: { request_id: request.id, invoice_number: invoice.number, decision },
        ref: { type: "invoice_request", id: request.id },
        dedupeKey: `invoice_request:${request.id}:${decision}`,
      });
      const locale = await invoiceEmailLocale(tx, invoice);
      await sendTransactional(ctx, {
        template: "finance.company_request_decided",
        personId: request.personId,
        locale,
        data: { ...invoiceEmailData(invoice, locale, "issued"), decision, ...(input.note?.trim() ? { note: input.note.trim() } : {}) },
        key: `invoice_request:${request.id}:decided`,
      });
    }
    await ctx.audit({
      action: approved ? "invoice_request.approved" : "invoice_request.rejected",
      entityType: "invoice_request",
      entityId: request.id,
      personId: request.personId,
      oldValue: { status: request.status },
      newValue: { status: decision, note: input.note ?? null, ...(reissued ? { credit_note_id: reissued.creditNoteId, new_invoice_id: reissued.invoiceId } : {}) },
    });
    return { status: decision, ...(reissued ? { newInvoiceId: reissued.invoiceId } : {}) };
  },
);

const RequestCompanyInvoiceInput = z.object({ invoiceId: uuid, billing: BillingDetailsInput });

/** Rule 20 (customer): ask for a company invoice for one of the customer's own B2C invoices. */
export const requestCompanyInvoice = action({ name: "finance.request.create", audience: "customer", input: RequestCompanyInvoiceInput }, async (ctx, input) => {
  if (ctx.actor.kind !== "customer") throw new NotFoundError("finance.errors.not_found");
  const tx = ctx.tx;
  const invoice = await findInvoice(tx, input.invoiceId);
  if (!invoice || invoice.personId !== ctx.actor.personId) throw new NotFoundError("finance.errors.invoice_not_found");
  if (invoice.kind !== "invoice" || invoice.status === "cancelled" || invoice.isCompany) throw new FinanceConflictError("finance.errors.invalid_transition");
  const { finance } = await issuerSettings(tx);
  if (todayOf(ctx) > addDays(invoice.issuedOn, finance.company_request_window_days)) throw new FinanceConflictError("finance.errors.request_window_closed");
  const [pending] = await tx
    .select({ id: invoiceRequests.id })
    .from(invoiceRequests)
    .where(and(eq(invoiceRequests.invoiceId, invoice.id), eq(invoiceRequests.status, "requested")));
  if (pending) throw new FinanceConflictError("finance.errors.request_pending");
  const [row] = await tx
    .insert(invoiceRequests)
    .values({ invoiceId: invoice.id, personId: ctx.actor.personId, billing: input.billing })
    .returning({ id: invoiceRequests.id });
  const requestId = row!.id;
  await ctx.recordEvent({
    kind: "invoice.company_requested",
    personId: ctx.actor.personId,
    data: { request_id: requestId, invoice_number: invoice.number },
    ref: { type: "invoice_request", id: requestId },
    dedupeKey: `invoice_request:${requestId}:requested`,
  });
  return { requestId };
});

/** The customer withdraws their own pending request. */
export const cancelCompanyInvoiceRequest = action({ name: "finance.request.cancel", audience: "customer", input: z.object({ requestId: uuid }) }, async (ctx, input) => {
  if (ctx.actor.kind !== "customer") throw new NotFoundError("finance.errors.not_found");
  const tx = ctx.tx;
  const [request] = await tx.select().from(invoiceRequests).where(eq(invoiceRequests.id, input.requestId)).for("update");
  if (!request || request.personId !== ctx.actor.personId) throw new NotFoundError("finance.errors.request_not_found");
  if (request.status !== "requested") throw new FinanceConflictError("finance.errors.invalid_transition");
  await tx.update(invoiceRequests).set({ status: "cancelled", updatedAt: sql`now()` }).where(eq(invoiceRequests.id, request.id));
  const invoice = await loadInvoice(tx, request.invoiceId);
  await ctx.recordEvent({
    kind: "invoice.company_request_cancelled",
    personId: ctx.actor.personId,
    data: { request_id: request.id, invoice_number: invoice.number },
    ref: { type: "invoice_request", id: request.id },
    dedupeKey: `invoice_request:${request.id}:cancelled`,
  });
  return { ok: true as const };
});

// ---------------------------------------------------------------------------
// Accountant exports (rule 42; the CSV job lands with finance-P7)
// ---------------------------------------------------------------------------

const V1_EXPORT_KINDS = ["invoices", "invoice_lines", "vat_summary", "payments"] as const;
const RequestFinanceExportInput = z
  .object({ kind: z.enum(V1_EXPORT_KINDS), from: day, to: day })
  .refine((v) => v.to >= v.from, { path: ["to"], message: "finance.errors.period_invalid" })
  .refine((v) => v.to <= addDays(v.from, 365), { path: ["to"], message: "finance.errors.period_too_long" });

export const requestFinanceExport = action(
  { name: "finance.export.request", audience: "staff", permission: "reports.finance", input: RequestFinanceExportInput, audit: false },
  async (ctx, input) => {
    const userId = staffUserId(ctx);
    if (!userId) throw new NotFoundError("finance.errors.not_found");
    const [row] = await ctx.tx
      .insert(financeExports)
      .values({ kind: input.kind, periodFrom: input.from, periodTo: input.to, requestedByUserId: userId })
      .returning({ id: financeExports.id });
    const exportId = row!.id;
    await enqueueFinanceJob(ctx, { kind: "finance.build_export", payload: { exportId }, key: `finance_export:${exportId}` });
    await ctx.audit({ action: "finance.export_requested", entityType: "finance_export", entityId: exportId, newValue: input });
    return { exportId };
  },
);
