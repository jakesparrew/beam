/**
 * finance read functions for the back office (finance spec 4.3, finance-P5). Pages check the
 * permission (`invoices.read`) before calling them; every function takes the database first.
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
import { brusselsDay } from "./service/billit-sync";

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
    requests: requestRows.map(({ billing, ...r }) => ({ ...r, status: String(r.status), legalName: (billing as BillingDetails).legalName })),
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

/** Documents a staff "Re-render all blocked PDFs" would pick up: `pdf_status = 'failed'`. */
export async function listBlockedPdfIds(db: DbOrTx): Promise<string[]> {
  const rows = await db.select({ id: invoices.id }).from(invoices).where(eq(invoices.pdfStatus, "failed")).orderBy(asc(invoices.issuedAt));
  return rows.map((r) => r.id);
}
