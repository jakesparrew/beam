/**
 * finance read functions for the back office (finance spec 4.3, finance-P5) and the customer
 * portal (`listMyInvoices`, `getMyInvoice`, `getMyInvoicePdf`, finance-P6). Staff pages check the
 * permission (`invoices.read`) before calling them; portal pages pass the signed-in customer's
 * person id, and the queries filter on it. `listFinanceExports` (finance-P7), `getFinanceDashboard` (finance-P8), `getDeferredRevenue`, `getBreakage` and `getVoucherRedemptions` (finance-P9) need `reports.finance`. Every function takes the database first.
 * Explicit columns only; lists are keyset-paginated (50 rows, cursor `issued_at,id`).
 * Search is an exact document number or `ilike` on the customer name inside the period filter.
 */
import type { DbOrTx } from "@beam/db";
import {
  billitReconcileRuns,
  integrationCalls,
  invoiceRequests,
  invoices,
  jobs,
  orders,
  payments,
  refunds,
  vFinanceBillitBacklog,
  vFinanceOpenInvoices,
  vFinanceRecurringMonthly,
} from "@beam/db/schema";
import {
  buildSellerSnapshot,
  isAnonymisedSnapshot,
  missingIssuerFields,
  normaliseVatNumber,
  type BillingDetails,
  type FinanceSetting,
  type InvoiceRecord,
  type ReconcileIssue,
  type SellerSnapshot,
} from "@beam/core/finance";
import { LOCALES, type Locale } from "@beam/core/i18n";
import { and, asc, desc, eq, gte, lt, lte, or, sql, type SQL } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
import { getSetting } from "@/lib/settings";
// Relative until `@beam/core/finance` re-exports `./periods` (index.ts is not finance-P8's file).
import {
  addPeriodDays,
  resolvePeriod,
  trendGranularity,
  type DashboardPeriod,
  type DateRange,
  type ResolvedPeriod,
} from "../../../../packages/core/src/finance/periods";
import { brusselsDay } from "./service/billit-sync";
import * as deferred from "./service/deferred";
import type { BreakageRow, DeferredRevenue, VoucherRedemptionRow } from "./service/deferred";
import { listExports, type FinanceExportRow } from "./service/exports";
import { blockedPdfIds } from "./service/pdf-file";

export const INVOICE_PAGE_SIZE = 50;

type InvoiceKind = InvoiceRecord["kind"];
type InvoiceStatus = InvoiceRecord["status"];
type BillitStatus = InvoiceRecord["billitStatus"];

export type ListInvoicesInput = {
  from?: string;
  to?: string;
  kind?: InvoiceKind;
  status?: InvoiceStatus;
  billitStatus?: BillitStatus;
  isCompany?: boolean;
  q?: string;
  cursor?: string;
  limit?: number;
};

export type InvoiceRow = {
  id: string;
  number: string;
  kind: InvoiceKind;
  issuedOn: string;
  customerName: string | null;
  isCompany: boolean;
  totalCents: number;
  status: InvoiceStatus;
  billitStatus: BillitStatus;
  pdfStatus: InvoiceRecord["pdfStatus"];
  pdfReady: boolean;
};

const DOC_NUMBER = /^(BEAM|CN)-\d{4}-\d{1,6}$/i;

function encodeCursor(issuedAt: Date, id: string): string {
  return `${issuedAt.toISOString()},${id}`;
}

function decodeCursor(cursor: string | undefined): { at: Date; id: string } | null {
  if (!cursor) return null;
  const [at, id] = cursor.split(",");
  const date = at ? new Date(at) : null;
  if (!date || Number.isNaN(date.getTime()) || !id || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  return { at: date, id };
}

const customerName = sql<string | null>`${invoices.customerSnapshot} ->> 'name'`;

/** One page of documents, newest first, with the filters of `/admin/finance/invoices`. */
export async function listInvoices(db: DbOrTx, input: ListInvoicesInput = {}): Promise<{ rows: InvoiceRow[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(input.limit ?? INVOICE_PAGE_SIZE, 1), 200);
  const where: SQL[] = [];
  if (input.from) where.push(gte(invoices.issuedOn, input.from));
  if (input.to) where.push(lte(invoices.issuedOn, input.to));
  if (input.kind) where.push(eq(invoices.kind, input.kind));
  if (input.status) where.push(eq(invoices.status, input.status));
  if (input.billitStatus) where.push(eq(invoices.billitStatus, input.billitStatus));
  if (input.isCompany !== undefined) where.push(eq(invoices.isCompany, input.isCompany));
  const q = input.q?.trim();
  if (q) {
    const escaped = q.replace(/[\\%_]/g, (c) => `\\${c}`);
    const byName = sql`${customerName} ilike ${`%${escaped}%`}`;
    where.push(DOC_NUMBER.test(q) ? or(sql`upper(${invoices.number}) = ${q.toUpperCase()}`, byName)! : byName);
  }
  const cursor = decodeCursor(input.cursor);
  if (cursor) where.push(or(lt(invoices.issuedAt, cursor.at), and(eq(invoices.issuedAt, cursor.at), lt(invoices.id, cursor.id)))!);

  const rows = await db
    .select({
      id: invoices.id,
      number: invoices.number,
      kind: invoices.kind,
      issuedOn: invoices.issuedOn,
      issuedAt: invoices.issuedAt,
      customerName,
      isCompany: invoices.isCompany,
      totalCents: invoices.totalCents,
      status: invoices.status,
      billitStatus: invoices.billitStatus,
      pdfStatus: invoices.pdfStatus,
      pdfFileId: invoices.pdfFileId,
    })
    .from(invoices)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(invoices.issuedAt), desc(invoices.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    rows: page.map(({ issuedAt: _at, pdfFileId, ...r }) => ({ ...r, pdfReady: r.pdfStatus === "rendered" && pdfFileId !== null })),
    nextCursor: rows.length > limit && last ? encodeCursor(last.issuedAt, last.id) : null,
  };
}

export type DocumentRef = { id: string; number: string; kind: InvoiceKind; status: InvoiceStatus; issuedOn: string; totalCents: number };

const refColumns = {
  id: invoices.id,
  number: invoices.number,
  kind: invoices.kind,
  status: invoices.status,
  issuedOn: invoices.issuedOn,
  totalCents: invoices.totalCents,
};

export type InvoiceDetail = {
  invoice: InvoiceRecord;
  balance: { creditedCents: number; remainingCents: number } | null;
  creditNotes: DocumentRef[];
  original: DocumentRef | null;
  replaces: DocumentRef | null;
  replacedBy: DocumentRef | null;
  order: { id: string; status: string; channel: string; totalCents: number } | null;
  payments: { id: string; provider: string; method: string | null; status: string; amountCents: number; paidAt: Date | null; providerPaymentId: string | null }[];
  refunds: { id: string; amountCents: number; status: string; createdAt: Date }[];
  jobs: { id: string; kind: string; status: string; attempts: number; lastError: string | null; createdAt: Date; finishedAt: Date | null }[];
  requests: { id: string; status: string; createdAt: Date; decidedAt: Date | null; decisionNote: string | null; legalName: string }[];
  lastReminderAt: Date | null;
};

/** Everything the invoice detail screen shows; `null` for an unknown id. */
export async function getInvoice(db: DbOrTx, id: string): Promise<InvoiceDetail | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [invoice] = (await db.select().from(invoices).where(eq(invoices.id, id))) as InvoiceRecord[];
  if (!invoice) return null;
  const isInvoice = invoice.kind === "invoice";
  const creditNotes = isInvoice
    ? await db
        .select(refColumns)
        .from(invoices)
        .where(and(eq(invoices.kind, "credit_note"), eq(invoices.reversesInvoiceId, id)))
        .orderBy(asc(invoices.issuedAt))
    : [];
  const one = async (where: SQL | undefined) => (where ? ((await db.select(refColumns).from(invoices).where(where).limit(1))[0] ?? null) : null);
  const credited = -creditNotes.reduce((sum, n) => sum + n.totalCents, 0);
  const [order] = await db
    .select({ id: orders.id, status: orders.status, channel: orders.channel, totalCents: orders.totalCents })
    .from(orders)
    .where(eq(orders.id, invoice.orderId));
  const paymentRows = await db
    .select({
      id: payments.id,
      provider: payments.provider,
      method: payments.method,
      status: payments.status,
      amountCents: payments.amountCents,
      paidAt: payments.paidAt,
      providerPaymentId: payments.providerPaymentId,
    })
    .from(payments)
    .where(eq(payments.orderId, invoice.orderId))
    .orderBy(asc(payments.createdAt));
  const refundRows = await db
    .select({ id: refunds.id, amountCents: refunds.amountCents, status: refunds.status, createdAt: refunds.createdAt })
    .from(refunds)
    .where(eq(refunds.orderId, invoice.orderId))
    .orderBy(asc(refunds.createdAt));
  const jobRows = await db
    .select({ id: jobs.id, kind: jobs.kind, status: jobs.status, attempts: jobs.attempts, lastError: jobs.lastError, createdAt: jobs.createdAt, finishedAt: jobs.finishedAt })
    .from(jobs)
    .where(sql`${jobs.payload} ->> 'invoiceId' = ${id}`)
    .orderBy(desc(jobs.createdAt))
    .limit(50);
  const requestRows = isInvoice
    ? await db
        .select({
          id: invoiceRequests.id,
          status: invoiceRequests.status,
          createdAt: invoiceRequests.createdAt,
          decidedAt: invoiceRequests.decidedAt,
          decisionNote: invoiceRequests.decisionNote,
          billing: invoiceRequests.billing,
        })
        .from(invoiceRequests)
        .where(eq(invoiceRequests.invoiceId, id))
        .orderBy(desc(invoiceRequests.createdAt))
    : [];
  const [lastReminder] = await db
    .select({ createdAt: jobs.createdAt })
    .from(jobs)
    .where(and(eq(jobs.kind, "finance.send_invoice_email"), sql`${jobs.idempotencyKey} like ${`invoice_email:${id}:reminder:%`}`))
    .orderBy(desc(jobs.createdAt))
    .limit(1);

  return {
    invoice,
    balance: isInvoice ? { creditedCents: credited, remainingCents: invoice.totalCents - credited } : null,
    creditNotes,
    original: await one(invoice.reversesInvoiceId ? eq(invoices.id, invoice.reversesInvoiceId) : undefined),
    replaces: await one(invoice.replacesInvoiceId ? eq(invoices.id, invoice.replacesInvoiceId) : undefined),
    replacedBy: await one(isInvoice ? eq(invoices.replacesInvoiceId, id) : undefined),
    order: order ? { id: order.id, status: String(order.status), channel: String(order.channel), totalCents: order.totalCents } : null,
    payments: paymentRows.map((p) => ({ ...p, provider: String(p.provider), status: String(p.status) })),
    refunds: refundRows.map((r) => ({ ...r, status: String(r.status) })),
    jobs: jobRows.map((j) => ({ ...j, kind: String(j.kind), status: String(j.status) })),
    requests: requestRows.map(({ billing, ...r }) => ({ ...r, status: String(r.status), legalName: billing.legalName })),
    lastReminderAt: lastReminder?.createdAt ?? null,
  };
}

export type FinanceOverview = {
  documentCount: number;
  today: { count: number; netCents: number };
  month: { count: number; netCents: number };
  open: { count: number; amountCents: number };
  overdue: { count: number; amountCents: number };
  billit: { pending: number; failed: number; failing: number };
  pdfFailed: number;
  pdfBlocked: boolean;
  pendingRequests: number;
  lastReconcile: { id: string; runOn: string; status: "ok" | "issues" | "failed"; issuesCount: number } | null;
};

/** The tiles of `/admin/finance` (Brussels day and month of `now`). */
export async function getFinanceOverview(db: DbOrTx, input: { now?: Date } = {}): Promise<FinanceOverview> {
  const today = brusselsDay(input.now ?? new Date());
  const monthStart = `${today.slice(0, 7)}-01`;
  const settings = await getSetting(db, "finance");
  const [docs] = rowsOf<{ total: number; today_n: number; today_net: number; month_n: number; month_net: number; pdf_failed: number }>(
    await db.execute(sql`select count(*)::int as total,
        count(*) filter (where kind = 'invoice' and issued_on = ${today}::date)::int as today_n,
        coalesce(sum(subtotal_cents) filter (where issued_on = ${today}::date), 0)::int as today_net,
        count(*) filter (where kind = 'invoice' and issued_on >= ${monthStart}::date and issued_on <= ${today}::date)::int as month_n,
        coalesce(sum(subtotal_cents) filter (where issued_on >= ${monthStart}::date and issued_on <= ${today}::date), 0)::int as month_net,
        count(*) filter (where pdf_status = 'failed')::int as pdf_failed
      from invoices`),
  );
  const [open] = rowsOf<{ n: number; cents: number; overdue_n: number; overdue_cents: number }>(
    await db.execute(sql`select count(*)::int as n, coalesce(sum(amount_due_cents), 0)::int as cents,
        count(*) filter (where days_overdue > 0)::int as overdue_n,
        coalesce(sum(amount_due_cents) filter (where days_overdue > 0), 0)::int as overdue_cents
      from v_finance_open_invoices`),
  );
  const [billit] = rowsOf<{ pending: number; failed: number; failing: number }>(
    await db.execute(sql`select count(*) filter (where billit_status = 'pending')::int as pending,
        count(*) filter (where billit_status = 'failed')::int as failed,
        count(*) filter (where billit_status = 'failed' and failing_minutes >= ${settings.alert_after_minutes})::int as failing
      from v_finance_billit_backlog`),
  );
  const [requests] = rowsOf<{ n: number }>(await db.execute(sql`select count(*)::int as n from invoice_requests where status = 'requested'`));
  const [run] = await db
    .select({ id: billitReconcileRuns.id, runOn: billitReconcileRuns.runOn, status: billitReconcileRuns.status, issuesCount: billitReconcileRuns.issuesCount })
    .from(billitReconcileRuns)
    .orderBy(desc(billitReconcileRuns.runOn))
    .limit(1);
  const identity = await getInvoicingIdentity(db);
  const num = (v: unknown) => Number(v ?? 0);
  return {
    documentCount: num(docs?.total),
    today: { count: num(docs?.today_n), netCents: num(docs?.today_net) },
    month: { count: num(docs?.month_n), netCents: num(docs?.month_net) },
    open: { count: num(open?.n), amountCents: num(open?.cents) },
    overdue: { count: num(open?.overdue_n), amountCents: num(open?.overdue_cents) },
    billit: { pending: num(billit?.pending), failed: num(billit?.failed), failing: num(billit?.failing) },
    pdfFailed: num(docs?.pdf_failed),
    pdfBlocked: num(docs?.pdf_failed) > 0 && identity.missing.length > 0,
    pendingRequests: num(requests?.n),
    lastReconcile: run ? { id: run.id, runOn: String(run.runOn), status: run.status, issuesCount: run.issuesCount } : null,
  };
}

export type BillitBacklogRow = typeof vFinanceBillitBacklog.$inferSelect;

/** Rows of `v_finance_billit_backlog`, oldest first. */
export async function listBillitBacklog(db: DbOrTx, input: { status?: "pending" | "failed" } = {}): Promise<BillitBacklogRow[]> {
  return db
    .select()
    .from(vFinanceBillitBacklog)
    .where(input.status ? eq(vFinanceBillitBacklog.billitStatus, input.status) : undefined)
    .orderBy(asc(vFinanceBillitBacklog.createdAt))
    .limit(500);
}

export type ReconcileRunRow = {
  id: string;
  runOn: string;
  startedAt: Date;
  finishedAt: Date | null;
  status: "ok" | "issues" | "failed";
  checkedCount: number;
  issuesCount: number;
  issues: ReconcileIssue[];
};

const runColumns = {
  id: billitReconcileRuns.id,
  runOn: billitReconcileRuns.runOn,
  startedAt: billitReconcileRuns.startedAt,
  finishedAt: billitReconcileRuns.finishedAt,
  status: billitReconcileRuns.status,
  checkedCount: billitReconcileRuns.checkedCount,
  issuesCount: billitReconcileRuns.issuesCount,
  issues: billitReconcileRuns.issues,
};

/** The last `limit` (30) reconcile runs, newest first. */
export async function listReconcileRuns(db: DbOrTx, input: { limit?: number } = {}): Promise<ReconcileRunRow[]> {
  const rows = await db
    .select(runColumns)
    .from(billitReconcileRuns)
    .orderBy(desc(billitReconcileRuns.runOn))
    .limit(Math.min(Math.max(input.limit ?? 30, 1), 100));
  return rows.map((r) => ({ ...r, runOn: String(r.runOn) }));
}

export async function getReconcileRun(db: DbOrTx, id: string): Promise<ReconcileRunRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [row] = await db.select(runColumns).from(billitReconcileRuns).where(eq(billitReconcileRuns.id, id));
  return row ? { ...row, runOn: String(row.runOn) } : null;
}

/** The last successful Billit call (`integration_calls`), for the sync page's integration status. */
export async function getBillitIntegrationStatus(db: DbOrTx): Promise<{ lastSuccessAt: Date | null; lastFailureAt: Date | null }> {
  const last = async (ok: boolean) =>
    (
      await db
        .select({ at: integrationCalls.createdAt })
        .from(integrationCalls)
        .where(and(eq(integrationCalls.provider, "billit"), eq(integrationCalls.ok, ok)))
        .orderBy(desc(integrationCalls.createdAt))
        .limit(1)
    )[0]?.at ?? null;
  return { lastSuccessAt: await last(true), lastFailureAt: await last(false) };
}

export type CompanyRequestRow = {
  id: string;
  status: "requested" | "approved" | "rejected" | "cancelled";
  createdAt: Date;
  decidedAt: Date | null;
  decisionNote: string | null;
  invoiceId: string;
  invoiceNumber: string;
  customerName: string | null;
  billing: BillingDetails;
  vatCheck: "ok" | "format" | "checksum" | "missing";
  ageDays: number;
};

/** Company invoice requests with the invoice number, customer and the VAT check (rule 17). */
export async function listCompanyInvoiceRequests(
  db: DbOrTx,
  input: { status?: CompanyRequestRow["status"]; now?: Date } = {},
): Promise<CompanyRequestRow[]> {
  const rows = await db
    .select({
      id: invoiceRequests.id,
      status: invoiceRequests.status,
      createdAt: invoiceRequests.createdAt,
      decidedAt: invoiceRequests.decidedAt,
      decisionNote: invoiceRequests.decisionNote,
      billing: invoiceRequests.billing,
      invoiceId: invoices.id,
      invoiceNumber: invoices.number,
      snapshot: invoices.customerSnapshot,
    })
    .from(invoiceRequests)
    .innerJoin(invoices, eq(invoices.id, invoiceRequests.invoiceId))
    .where(input.status ? eq(invoiceRequests.status, input.status) : undefined)
    .orderBy(asc(invoiceRequests.createdAt))
    .limit(500);
  const now = (input.now ?? new Date()).getTime();
  return rows.map(({ snapshot, ...r }) => {
    const vat = r.billing.vatNumber ? normaliseVatNumber(r.billing.vatNumber) : null;
    return {
      ...r,
      customerName: isAnonymisedSnapshot(snapshot) ? null : snapshot.name,
      vatCheck: vat === null ? "missing" : vat.ok ? "ok" : vat.reason,
      ageDays: Math.max(0, Math.floor((now - r.createdAt.getTime()) / 86_400_000)),
    };
  });
}

export type InvoicingIdentity = {
  seller: SellerSnapshot;
  missing: string[];
  settings: FinanceSetting;
  footerComplete: boolean;
  vatNotes: { category: string; complete: boolean; missingLocales: Locale[] }[];
};

/** The seller block the next document would carry (`company` plus `finance.issuer`) and what is missing. */
export async function getInvoicingIdentity(db: DbOrTx, input: { locale?: Locale } = {}): Promise<InvoicingIdentity> {
  const [company, finance] = await Promise.all([getSetting(db, "company"), getSetting(db, "finance")]);
  const seller = buildSellerSnapshot(company, finance, input.locale ?? "nl-BE");
  const missingOf = (text: Partial<Record<Locale, string>> | undefined) => LOCALES.filter((l) => !text?.[l]?.trim());
  return {
    seller,
    missing: missingIssuerFields(seller),
    settings: finance,
    footerComplete: missingOf(finance.issuer.invoice_footer).length === 0,
    vatNotes: Object.entries(finance.vat_notes).map(([category, text]) => {
      const missingLocales = missingOf(text);
      return { category, complete: missingLocales.length === 0, missingLocales };
    }),
  };
}

export type { FinanceExportRow };

/** `/admin/finance/exports` (`reports.finance`, finance-P7): the last 50 exports with status, rows and file expiry. */
export async function listFinanceExports(db: DbOrTx, input: { now?: Date } = {}): Promise<FinanceExportRow[]> {
  return listExports(db, { limit: 50, ...(input.now ? { now: input.now } : {}) });
}

/**
 * Documents a staff "Re-render all blocked PDFs" would pick up (one batch, oldest first):
 * `pdf_status = 'failed'`, or `rendered` whose file is missing or expired. Never reads bytes.
 */
export async function listBlockedPdfIds(db: DbOrTx): Promise<string[]> {
  return blockedPdfIds(db);
}

// ---------------------------------------------------------------------------
// Customer portal (finance-P6, rule 40): only documents with `person_id` = the customer's person.
// Another person's id reads as `null` (`not_found`), never `forbidden`, so ids cannot be probed.
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type MyInvoiceRow = {
  id: string;
  kind: InvoiceKind;
  number: string;
  issuedOn: string;
  status: InvoiceStatus;
  totalCents: number;
  isCompany: boolean;
  pdfStatus: InvoiceRecord["pdfStatus"];
  pdfReady: boolean;
};

/** The customer's invoices and credit notes, newest first (`ix_invoices_person`). */
export async function listMyInvoices(db: DbOrTx, input: { personId: string }): Promise<MyInvoiceRow[]> {
  const rows = await db
    .select({
      id: invoices.id,
      kind: invoices.kind,
      number: invoices.number,
      issuedOn: invoices.issuedOn,
      status: invoices.status,
      totalCents: invoices.totalCents,
      isCompany: invoices.isCompany,
      pdfStatus: invoices.pdfStatus,
      pdfFileId: invoices.pdfFileId,
    })
    .from(invoices)
    .where(eq(invoices.personId, input.personId))
    .orderBy(desc(invoices.issuedAt), desc(invoices.number))
    .limit(500);
  return rows.map(({ pdfFileId, ...r }) => ({ ...r, pdfReady: r.pdfStatus === "rendered" && pdfFileId != null }));
}

export type MyInvoiceRequest = {
  id: string;
  status: CompanyRequestRow["status"];
  legalName: string;
  createdAt: Date;
  decidedAt: Date | null;
  decisionNote: string | null;
};

export type MyInvoiceLine = { description: string; quantity: number; unitAmountCents: number; vatRatePct: number; totalCents: number };

export type MyInvoiceDetail = {
  id: string;
  kind: InvoiceKind;
  number: string;
  status: InvoiceStatus;
  issuedOn: string;
  dueOn: string | null;
  paidAt: Date | null;
  isCompany: boolean;
  locale: Locale;
  customer: { name: string; vatNumber: string | null } | null;
  /** Bank details for an open invoice (rule 3): IBAN, BIC and the structured communication. */
  bank: { iban: string; bic: string; paymentReference: string | null } | null;
  lines: MyInvoiceLine[];
  vatBreakdown: InvoiceRecord["vatBreakdown"];
  subtotalCents: number;
  vatCents: number;
  totalCents: number;
  paymentMethod: string | null;
  reason: string | null;
  pdfStatus: InvoiceRecord["pdfStatus"];
  pdfReady: boolean;
  reverses: DocumentRef | null;
  creditNotes: DocumentRef[];
  replacedBy: DocumentRef | null;
  requests: MyInvoiceRequest[];
  pendingRequest: MyInvoiceRequest | null;
  /** Rule 20: a B2C invoice that is not cancelled, inside the window and without a pending request. */
  canRequestCompanyInvoice: boolean;
  /** Last day (`YYYY-MM-DD`) a company invoice can be requested; null for credit notes and company invoices. */
  requestWindowUntil: string | null;
};

/** One of the customer's documents for the portal detail; `null` when it is not theirs. */
export async function getMyInvoice(db: DbOrTx, input: { personId: string; id: string; now?: Date }): Promise<MyInvoiceDetail | null> {
  if (!UUID_RE.test(input.id)) return null;
  const [doc] = await db
    .select()
    .from(invoices)
    .where(and(eq(invoices.id, input.id), eq(invoices.personId, input.personId)));
  if (!doc) return null;
  const invoice: InvoiceRecord = doc;
  const related = await db
    .select(refColumns)
    .from(invoices)
    .where(
      and(
        eq(invoices.personId, input.personId),
        or(
          eq(invoices.reversesInvoiceId, invoice.id),
          eq(invoices.replacesInvoiceId, invoice.id),
          invoice.reversesInvoiceId ? eq(invoices.id, invoice.reversesInvoiceId) : sql`false`,
        ),
      ),
    )
    .orderBy(asc(invoices.issuedAt), asc(invoices.number));
  const requestRows =
    invoice.kind === "invoice"
      ? await db
          .select({
            id: invoiceRequests.id,
            status: invoiceRequests.status,
            billing: invoiceRequests.billing,
            createdAt: invoiceRequests.createdAt,
            decidedAt: invoiceRequests.decidedAt,
            decisionNote: invoiceRequests.decisionNote,
          })
          .from(invoiceRequests)
          .where(and(eq(invoiceRequests.invoiceId, invoice.id), eq(invoiceRequests.personId, input.personId)))
          .orderBy(desc(invoiceRequests.createdAt))
      : [];
  const requests: MyInvoiceRequest[] = requestRows.map(({ billing, ...r }) => ({ ...r, legalName: billing.legalName }));
  const pendingRequest = requests.find((r) => r.status === "requested") ?? null;

  const finance = await getSetting(db, "finance");
  const windowUntil = invoice.kind === "invoice" && !invoice.isCompany ? addDaysIso(invoice.issuedOn, finance.company_request_window_days) : null;
  const today = brusselsDay(input.now ?? new Date());
  const canRequest = windowUntil !== null && invoice.status !== "cancelled" && today <= windowUntil && pendingRequest === null;

  const snapshot = invoice.customerSnapshot;
  const seller = invoice.sellerSnapshot;
  return {
    id: invoice.id,
    kind: invoice.kind,
    number: invoice.number,
    status: invoice.status,
    issuedOn: invoice.issuedOn,
    dueOn: invoice.dueOn,
    paidAt: invoice.paidAt,
    isCompany: invoice.isCompany,
    locale: invoice.locale,
    customer: isAnonymisedSnapshot(snapshot) ? null : { name: snapshot.name, vatNumber: snapshot.vat_number },
    bank: invoice.status === "open" ? { iban: seller.iban, bic: seller.bic, paymentReference: invoice.paymentReference } : null,
    lines: invoice.lines.map((l) => ({
      description: l.description,
      quantity: l.quantity,
      unitAmountCents: l.unit_amount_cents,
      vatRatePct: Number(l.vat_rate_pct),
      totalCents: l.line_total_cents,
    })),
    vatBreakdown: invoice.vatBreakdown,
    subtotalCents: invoice.subtotalCents,
    vatCents: invoice.vatCents,
    totalCents: invoice.totalCents,
    paymentMethod: invoice.paymentMethod,
    reason: invoice.reason,
    pdfStatus: invoice.pdfStatus,
    pdfReady: invoice.pdfStatus === "rendered" && invoice.pdfFileId != null,
    reverses: related.find((r) => r.id === invoice.reversesInvoiceId) ?? null,
    creditNotes: related.filter((r) => r.kind === "credit_note" && r.id !== invoice.reversesInvoiceId),
    replacedBy: related.find((r) => r.kind === "invoice" && r.id !== invoice.reversesInvoiceId) ?? null,
    requests,
    pendingRequest,
    canRequestCompanyInvoice: canRequest,
    requestWindowUntil: windowUntil,
  };
}

/** The PDF of one of the customer's documents; `null` for anyone else's or while it is not rendered. */
export async function getMyInvoicePdf(db: DbOrTx, input: { personId: string; id: string }): Promise<{ number: string; fileId: string } | null> {
  if (!UUID_RE.test(input.id)) return null;
  const [doc] = await db
    .select({ number: invoices.number, pdfStatus: invoices.pdfStatus, pdfFileId: invoices.pdfFileId })
    .from(invoices)
    .where(and(eq(invoices.id, input.id), eq(invoices.personId, input.personId)));
  if (!doc || doc.pdfStatus !== "rendered" || !doc.pdfFileId) return null;
  return { number: doc.number, fileId: doc.pdfFileId };
}

function addDaysIso(day: string, days: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Finance dashboard (finance-P8, R3, blueprint 43; `reports.finance`). Revenue is invoice-based
// and excludes VAT; credit notes reduce it on their own issue day; vouchers are a liability and
// are reported apart (decision 30). Cash uses payments and settled credit notes. Every figure is
// compared with the previous period and the same period last year (rule 44, `resolvePeriod`).
// ---------------------------------------------------------------------------

export type DashboardInput = { period: DashboardPeriod; from?: string; to?: string; now?: Date };
/** A figure for the selected period, the previous period and the same period last year. */
export type DashboardFigure = { current: number; previous: number; lastYear: number };
export type DashboardTiles = {
  netRevenue: DashboardFigure;
  vatCollected: DashboardFigure;
  cashInflow: DashboardFigure;
  refunds: DashboardFigure;
  failedPayments: DashboardFigure;
  recurringRevenue: DashboardFigure;
  activeMemberships: DashboardFigure;
  voucherSales: DashboardFigure;
  openInvoices: { count: number; amountCents: number; overdueCount: number; overdueCents: number };
};
export type TrendPoint = { bucket: string; currentCents: number; previousCents: number; lastYearCents: number };
export type CategoryRow = { category: string; liability: boolean } & DashboardFigure;
export type MethodRow = { method: string } & DashboardFigure;
export type VatRateRow = { quarter: string; ratePct: number; netCents: number; vatCents: number; grossCents: number };
export type CashFlowPoint = { bucket: string; inflowCents: number; outflowCents: number };
export type DashboardOpenInvoice = {
  id: string;
  number: string;
  customerName: string | null;
  issuedOn: string;
  dueOn: string | null;
  amountDueCents: number;
  daysOverdue: number;
};
export type DashboardFailedPayment = {
  id: string;
  orderId: string;
  failedAt: Date;
  provider: string;
  method: string | null;
  status: "failed" | "expired";
  amountCents: number;
  reason: string | null;
};

export type FinanceDashboard = {
  period: ResolvedPeriod & { period: DashboardPeriod; granularity: "day" | "month" };
  /** False when the selected period has no document, cash movement or failed payment (tiles show 0). */
  hasData: boolean;
  tiles: DashboardTiles;
  revenueTrend: { granularity: "day" | "month"; points: TrendPoint[] };
  byCategory: CategoryRow[];
  byMethod: MethodRow[];
  vatByRate: VatRateRow[];
  cashFlow: { granularity: "day" | "month"; points: CashFlowPoint[]; totals: { inflowCents: number; outflowCents: number; netCents: number } };
  openInvoices: { count: number; amountCents: number; overdueCount: number; overdueCents: number; rows: DashboardOpenInvoice[] };
  failedPayments: { count: number; amountCents: number; pastDueMemberships: number; rows: DashboardFailedPayment[] };
  recurring: {
    invoiceCount: number;
    netCents: number;
    grossCents: number;
    activeMemberships: number;
    months: { month: string; invoiceCount: number; netCents: number; grossCents: number }[];
  };
};

const DASHBOARD_TABLE_ROWS = 10;
const NOT_VOUCHER = sql`category is distinct from 'voucher'`;
const inRange = (r: DateRange, column: SQL = sql`day`) => sql`${column} >= ${r.from}::date and ${column} <= ${r.to}::date`;
const toNum = (v: unknown) => Number(v ?? 0);

/** `sum(expr) filter (where <range> and cond)` for the three ranges, as columns `<name>_c`, `_p` and `_l`. */
function figureColumns(name: string, expr: SQL, ranges: readonly DateRange[], cond: SQL = sql`true`, column: SQL = sql`day`): SQL {
  const parts = ranges.map(
    (r, i) => sql`coalesce(sum(${expr}) filter (where ${inRange(r, column)} and ${cond}), 0)::int as ${sql.raw(`${name}_${"cpl"[i]}`)}`,
  );
  return sql.join(parts, sql`, `);
}

const figureOf = (row: Record<string, unknown> | undefined, name: string): DashboardFigure => ({
  current: toNum(row?.[`${name}_c`]),
  previous: toNum(row?.[`${name}_p`]),
  lastYear: toNum(row?.[`${name}_l`]),
});

/** The buckets of a range: every day, or the first day of every month. */
function bucketsOf(r: DateRange, granularity: "day" | "month"): string[] {
  const out: string[] = [];
  if (granularity === "day") {
    for (let d = r.from; d <= r.to; d = addPeriodDays(d, 1)) out.push(d);
    return out;
  }
  let [y, m] = r.from.split("-").map(Number) as [number, number];
  const end = r.to.slice(0, 7);
  for (;;) {
    const key = `${y}-${String(m).padStart(2, "0")}`;
    if (key > end) break;
    out.push(`${key}-01`);
    m += 1;
    if (m > 12) [y, m] = [y + 1, 1];
  }
  return out;
}

async function seriesOf(db: DbOrTx, from: SQL, value: SQL, r: DateRange, granularity: "day" | "month", cond: SQL = sql`true`): Promise<Map<string, number>> {
  const unit = granularity === "day" ? sql`day` : sql`date_trunc('month', day)::date`;
  const rows = rowsOf<{ bucket: string; v: number }>(
    await db.execute(sql`select to_char(${unit}, 'YYYY-MM-DD') as bucket, coalesce(sum(${value}), 0)::int as v
      from ${from} where ${inRange(r)} and ${cond} group by 1`),
  );
  return new Map(rows.map((row) => [row.bucket, toNum(row.v)]));
}

/** Index-aligned values of `series` over the buckets of `r` (day i of the period against day i of the other). */
const aligned = (series: Map<string, number>, r: DateRange, granularity: "day" | "month") => bucketsOf(r, granularity).map((b) => series.get(b) ?? 0);

const nonZero = (row: DashboardFigure) => row.current !== 0 || row.previous !== 0 || row.lastYear !== 0;

/**
 * `/admin/finance/dashboard` (`reports.finance`; the page checks the permission): tiles, series and
 * tables for the period of `input` in Europe/Brussels. A custom range that is not two valid dates,
 * ends before it starts or spans more than 731 days throws a `RangeError`. Open invoices and
 * past-due memberships are the state now; everything else belongs to the selected period.
 */
export async function getFinanceDashboard(db: DbOrTx, input: DashboardInput): Promise<FinanceDashboard> {
  const now = input.now ?? new Date();
  const resolved = resolvePeriod({ period: input.period, ...(input.from ? { from: input.from } : {}), ...(input.to ? { to: input.to } : {}) }, now);
  const cur: DateRange = { from: resolved.from, to: resolved.to };
  const prev = resolved.previous;
  const ly = resolved.lastYear;
  const ranges = [cur, prev, ly] as const;
  const granularity = trendGranularity(cur);
  const span = sql`day >= ${[cur.from, prev.from, ly.from].sort()[0]}::date and day <= ${[cur.to, prev.to, ly.to].sort()[2]}::date`;

  const [rev] = rowsOf<Record<string, unknown>>(
    await db.execute(sql`select ${figureColumns("rev", sql`net_cents`, ranges, NOT_VOUCHER)},
        ${figureColumns("vat", sql`vat_cents`, ranges)},
        ${figureColumns("ref", sql`-net_cents`, ranges, sql`kind = 'credit_note' and ${NOT_VOUCHER}`)},
        ${figureColumns("vou", sql`net_cents`, ranges, sql`category = 'voucher'`)},
        ${figureColumns("docs", sql`document_count`, ranges)}
      from v_finance_revenue_daily where ${span}`),
  );
  const [cash] = rowsOf<Record<string, unknown>>(
    await db.execute(sql`select ${figureColumns("cin", sql`inflow_cents`, ranges)}, ${figureColumns("cout", sql`outflow_cents`, ranges)},
        ${figureColumns("cmov", sql`movement_count`, ranges)}
      from v_finance_cash_inflow_daily where ${span}`),
  );
  const [failed] = rowsOf<Record<string, unknown>>(
    await db.execute(sql`select ${figureColumns("fail", sql`failed_count`, ranges)}, ${figureColumns("failamt", sql`amount_cents`, ranges)}
      from v_finance_failed_payments where ${span}`),
  );
  const issuedOn = sql`i.issued_on`;
  const [recurring] = rowsOf<Record<string, unknown>>(
    await db.execute(sql`select ${figureColumns("rec", sql`i.subtotal_cents`, ranges, sql`true`, issuedOn)},
        ${figureColumns("recgross", sql`i.total_cents`, ranges, sql`true`, issuedOn)},
        ${figureColumns("recn", sql`case when i.kind = 'invoice' then 1 else 0 end`, ranges, sql`true`, issuedOn)}
      from invoices i join orders o on o.id = i.order_id where o.channel = 'recurring'`),
  );
  // Memberships live at the end of each range (capped at now): started, not pending, not ended.
  const liveAt = (r: DateRange) => {
    const at = sql`least(${now.toISOString()}::timestamptz, ((${r.to}::date + 1)::timestamp at time zone 'Europe/Brussels'))`;
    return sql`(count(*) filter (where m.started_at < ${at} and (m.ended_at is null or m.ended_at >= ${at})))::int`;
  };
  const [members] = rowsOf<Record<string, unknown>>(
    await db.execute(sql`select ${liveAt(cur)} as mem_c, ${liveAt(prev)} as mem_p, ${liveAt(ly)} as mem_l,
        (count(*) filter (where m.status = 'past_due'))::int as past_due
      from memberships m where m.status <> 'pending'`),
  );
  const [open] = rowsOf<{ n: number; cents: number; overdue_n: number; overdue_cents: number }>(
    await db.execute(sql`select count(*)::int as n, coalesce(sum(amount_due_cents), 0)::int as cents,
        count(*) filter (where days_overdue > 0)::int as overdue_n,
        coalesce(sum(amount_due_cents) filter (where days_overdue > 0), 0)::int as overdue_cents
      from v_finance_open_invoices`),
  );
  const openTotals = { count: toNum(open?.n), amountCents: toNum(open?.cents), overdueCount: toNum(open?.overdue_n), overdueCents: toNum(open?.overdue_cents) };

  const tiles: DashboardTiles = {
    netRevenue: figureOf(rev, "rev"),
    vatCollected: figureOf(rev, "vat"),
    cashInflow: figureOf(cash, "cin"),
    refunds: figureOf(rev, "ref"),
    failedPayments: figureOf(failed, "fail"),
    recurringRevenue: figureOf(recurring, "rec"),
    activeMemberships: figureOf(members, "mem"),
    voucherSales: figureOf(rev, "vou"),
    openInvoices: openTotals,
  };

  // Revenue trend: the current buckets, with the previous period and last year aligned by index.
  const revenueView = sql`v_finance_revenue_daily`;
  const [sc, sp, sl] = await Promise.all(ranges.map((r) => seriesOf(db, revenueView, sql`net_cents`, r, granularity, NOT_VOUCHER)));
  const curBuckets = bucketsOf(cur, granularity);
  const prevValues = aligned(sp!, prev, granularity);
  const lyValues = aligned(sl!, ly, granularity);
  const points = curBuckets.map((bucket, i) => ({
    bucket,
    currentCents: sc!.get(bucket) ?? 0,
    previousCents: prevValues[i] ?? 0,
    lastYearCents: lyValues[i] ?? 0,
  }));

  const byCategory = rowsOf<Record<string, unknown> & { category: string | null }>(
    await db.execute(sql`select category, ${figureColumns("net", sql`net_cents`, ranges)}
      from v_finance_revenue_daily where ${span} group by category`),
  )
    .map((row) => ({ category: row.category ?? "other", liability: row.category === "voucher", ...figureOf(row, "net") }))
    .filter(nonZero)
    .sort((a, b) => Number(a.liability) - Number(b.liability) || b.current - a.current || a.category.localeCompare(b.category));
  const byMethod = rowsOf<Record<string, unknown> & { method: string }>(
    await db.execute(sql`select coalesce(payment_method, 'unknown') as method, ${figureColumns("net", sql`net_cents`, ranges, NOT_VOUCHER)}
      from v_finance_revenue_daily where ${span} group by 1`),
  )
    .map((row) => ({ method: row.method, ...figureOf(row, "net") }))
    .filter(nonZero)
    .sort((a, b) => b.current - a.current || a.method.localeCompare(b.method));
  const vatByRate = rowsOf<{ quarter: string; rate: string | number; net: number; vat: number; gross: number }>(
    await db.execute(sql`select to_char(day, 'YYYY') || '-Q' || extract(quarter from day)::int as quarter, coalesce(vat_rate_pct, 0) as rate,
        sum(net_cents)::int as net, sum(vat_cents)::int as vat, sum(gross_cents)::int as gross
      from v_finance_revenue_daily where ${inRange(cur)} group by 1, 2 order by 1, 2 desc`),
  ).map((row) => ({ quarter: row.quarter, ratePct: Number(row.rate), netCents: toNum(row.net), vatCents: toNum(row.vat), grossCents: toNum(row.gross) }));

  const cashView = sql`v_finance_cash_inflow_daily`;
  const [inflow, outflow] = await Promise.all([
    seriesOf(db, cashView, sql`inflow_cents`, cur, granularity),
    seriesOf(db, cashView, sql`outflow_cents`, cur, granularity),
  ]);
  const cashPoints = curBuckets.map((bucket) => ({ bucket, inflowCents: inflow.get(bucket) ?? 0, outflowCents: outflow.get(bucket) ?? 0 }));
  const cashIn = toNum(cash?.cin_c);
  const cashOut = toNum(cash?.cout_c);

  const openRows = await db
    .select({
      id: vFinanceOpenInvoices.id,
      number: vFinanceOpenInvoices.number,
      customerName: vFinanceOpenInvoices.customerName,
      issuedOn: vFinanceOpenInvoices.issuedOn,
      dueOn: vFinanceOpenInvoices.dueOn,
      amountDueCents: vFinanceOpenInvoices.amountDueCents,
      daysOverdue: vFinanceOpenInvoices.daysOverdue,
    })
    .from(vFinanceOpenInvoices)
    .orderBy(desc(vFinanceOpenInvoices.daysOverdue), desc(vFinanceOpenInvoices.amountDueCents), asc(vFinanceOpenInvoices.number))
    .limit(DASHBOARD_TABLE_ROWS);

  const failedAt = sql`coalesce((select max((e ->> 'at')::timestamptz) from jsonb_array_elements(p.status_history) e where e ->> 'status' = p.status::text), p.updated_at)`;
  type FailedSqlRow = {
    id: string;
    order_id: string;
    failed_at: string | Date;
    provider: string;
    method: string | null;
    status: "failed" | "expired";
    amount_cents: number;
    reason: string | null;
  };
  const failedRows = rowsOf<FailedSqlRow>(
    await db.execute(sql`select * from (select p.id, p.order_id, ${failedAt} as failed_at, p.provider::text as provider, p.method,
          p.status::text as status, p.amount_cents, p.failed_reason as reason
        from payments p where p.status in ('failed', 'expired')) f
      where (f.failed_at at time zone 'Europe/Brussels')::date >= ${cur.from}::date
        and (f.failed_at at time zone 'Europe/Brussels')::date <= ${cur.to}::date
      order by f.failed_at desc, f.id limit ${DASHBOARD_TABLE_ROWS}`),
  ).map((row) => ({
    id: row.id,
    orderId: row.order_id,
    failedAt: new Date(row.failed_at),
    provider: row.provider,
    method: row.method,
    status: row.status,
    amountCents: toNum(row.amount_cents),
    reason: row.reason,
  }));

  const months = (
    await db
      .select({
        month: vFinanceRecurringMonthly.month,
        invoiceCount: vFinanceRecurringMonthly.invoiceCount,
        netCents: vFinanceRecurringMonthly.netCents,
        grossCents: vFinanceRecurringMonthly.grossCents,
      })
      .from(vFinanceRecurringMonthly)
      .where(and(gte(vFinanceRecurringMonthly.month, `${cur.from.slice(0, 7)}-01`), lte(vFinanceRecurringMonthly.month, cur.to)))
      .orderBy(asc(vFinanceRecurringMonthly.month))
  ).map((m) => ({ month: String(m.month), invoiceCount: m.invoiceCount, netCents: m.netCents, grossCents: m.grossCents }));

  const hasData = toNum(rev?.docs_c) > 0 || toNum(cash?.cmov_c) > 0 || tiles.failedPayments.current > 0;
  return {
    period: { period: input.period, from: cur.from, to: cur.to, previous: prev, lastYear: ly, granularity },
    hasData,
    tiles,
    revenueTrend: { granularity, points },
    byCategory,
    byMethod,
    vatByRate,
    cashFlow: { granularity, points: cashPoints, totals: { inflowCents: cashIn, outflowCents: cashOut, netCents: cashIn - cashOut } },
    openInvoices: {
      ...openTotals,
      rows: openRows.map((r) => ({ ...r, issuedOn: String(r.issuedOn), dueOn: r.dueOn == null ? null : String(r.dueOn) })),
    },
    failedPayments: { count: tiles.failedPayments.current, amountCents: toNum(failed?.failamt_c), pastDueMemberships: toNum(members?.past_due), rows: failedRows },
    recurring: {
      invoiceCount: toNum(recurring?.recn_c),
      netCents: tiles.recurringRevenue.current,
      grossCents: toNum(recurring?.recgross_c),
      activeMemberships: tiles.activeMemberships.current,
      months,
    },
  };
}

// ---------------------------------------------------------------------------
// Deferred revenue, breakage and voucher redemptions (R3, finance-P9, rule 43; `reports.finance`)
// ---------------------------------------------------------------------------

export type { BreakageRow, DeferredCreditKind, DeferredRateRow, DeferredRevenue, Money3, VoucherRedemptionRow } from "./service/deferred";

/**
 * Unused paid credits at the end of Brussels day `asOf`: `v_credit_liability` for today (or a
 * later day), credits' `getCreditLiabilityAsOf(db, endOfDayBrussels(asOf))` for a past day; split
 * into net and VAT per row (`multi_purpose` at 0 %).
 */
export function getDeferredRevenue(db: DbOrTx, input: { asOf: string; now?: Date }): Promise<DeferredRevenue> {
  return deferred.getDeferredRevenue(db, input);
}

/** Per Brussels month, credit kind and rate: recognised `-(consume + release)`, breakage `-expire`, revoked `-revoke`. */
export function getBreakage(db: DbOrTx, input: { from: string; to: string }): Promise<BreakageRow[]> {
  return deferred.getBreakage(db, input);
}

/** Euro credit spends in the period with the invoice number of the order they paid (no person column). */
export function getVoucherRedemptions(db: DbOrTx, input: { from: string; to: string }): Promise<VoucherRedemptionRow[]> {
  return deferred.getVoucherRedemptions(db, input);
}
