/**
 * Accountant CSV exports (finance spec rule 42, sections 4.2 to 4.5, edge case 26; finance-P7).
 *
 * `requestFinanceExport` inserts a `finance_exports` row and enqueues `finance.build_export`
 * (`finance_export:<id>`). The job reads the period in keyset pages of 1,000 rows, writes the CSV
 * (`toCsv` format: `;`, BOM, euros with a dot, ISO dates), stores it as a `files` row of kind
 * `export` that expires after 7 days with no person (accounting files survive erasure), and sets
 * `done` with `row_count`. A second run of a done export does nothing, so one export has one file.
 * A file above the 10 MB `files` limit fails with `finance.errors.export_too_large` ("Choose a
 * shorter period"). The download (`/admin/finance/exports/[id]`) needs `reports.finance` and is
 * audited as `finance.export_downloaded`.
 *
 * Sources (all documents of both kinds, credit notes with their stored negative amounts):
 * - `invoices`: one row per document issued in the period.
 * - `invoice_lines`: one row per document line, `line_no` from 1 in document order.
 * - `vat_summary`: `v_finance_invoice_lines` of the period grouped like `v_finance_vat_summary`
 *   (Brussels month of `issued_on`, rate, kind), so a month-aligned period equals the view.
 * - `payments`: what the R3 cash-inflow view counts: `payments` in `paid`, `refunded` or
 *   `partially_refunded` by Brussels day of `paid_at` (inflow), plus paid credit notes by Brussels
 *   day of `paid_at` with their negative total (money returned) and the refund's provider id.
 * Release 3 kinds (finance-P9, rule 43; the figures of `service/deferred.ts`, so the rows equal the
 * `/admin/finance/deferred` screen):
 * - `deferred_revenue`: the unused paid credits at the end of the period's last day (`to`; a day of
 *   today or later reads today's `v_credit_liability`), one row per credit kind, VAT treatment and
 *   rate, `as_of` the day the figures are for.
 * - `breakage`: per Brussels month overlapping the period, credit kind and rate: recognised,
 *   breakage (net and VAT) and revoked value.
 * - `voucher_redemptions`: every euro credit spend on an order in the period with the invoice
 *   number of that order (no person column).
 * A kind without a source fails with `finance.errors.export_kind_unavailable`.
 */
import type { DbOrTx } from "@beam/db";
import { financeExports } from "@beam/db/schema";
import type { FinanceExportKind, FinanceExportStatus } from "@beam/core/finance";
import { actorHasPermission, createCtx, eq, sql, type Actor, type Ctx, type SQL } from "@/lib/ctx";
import { MAX_FILE_BYTES } from "@/lib/files";
import type { JobCtx } from "@/lib/job-runner";
import { rowsOf } from "@/lib/sensitive";
import { readFile, storeFile } from "@/modules/platform/api";
import { getBreakage, getDeferredRevenue, voucherRedemptionPage } from "./deferred";
// Imported by path until `@beam/core/finance` re-exports `./csv` (request to the owner of its index.ts).
import { boolCell, centsToEuros, csvLine, CSV_BOM, EXPORT_COLUMNS, exportFileName, vatRateCell, type CsvCell } from "../../../../../packages/core/src/finance/csv";

export { EXPORT_COLUMNS, exportFileName };

/** Rows per page read from the database (section 4.5). */
export const EXPORT_PAGE_SIZE = 1_000;
/** An export covers at most 366 days (`period_to - period_from <= 365`, rule 42). */
export const MAX_EXPORT_SPAN_DAYS = 365;
/** Export files expire after 7 days (rule 42, section 2.7). */
export const EXPORT_TTL_MS = 7 * 86_400_000;

export const EXPORT_TOO_LARGE = "finance.errors.export_too_large";
export const EXPORT_KIND_UNAVAILABLE = "finance.errors.export_kind_unavailable";

export type ExportPeriod = { from: string; to: string };
/** The period of a source, with the page size (default `EXPORT_PAGE_SIZE`; tests use smaller pages). */
export type ExportQuery = ExportPeriod & { pageSize?: number };
/** Yields the export's rows page by page, in the order of `EXPORT_COLUMNS[kind]`. */
export type ExportRowSource = (db: DbOrTx, query: ExportQuery) => AsyncIterable<CsvCell[][]>;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Days from `from` to `to` (both ISO dates). */
export function spanDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** Why a period is refused (`period_invalid`, `period_too_long`), or null when it is fine. */
export function periodError(from: string, to: string): "finance.errors.period_invalid" | "finance.errors.period_too_long" | null {
  if (!DAY.test(from) || !DAY.test(to) || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) return "finance.errors.period_invalid";
  const span = spanDays(from, to);
  if (span < 0) return "finance.errors.period_invalid";
  if (span > MAX_EXPORT_SPAN_DAYS) return "finance.errors.period_too_long";
  return null;
}

const cents = (v: unknown): string => centsToEuros(Number(v ?? 0));

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

type InvoiceExportRow = {
  number: string;
  kind: string;
  issued_on: string;
  due_on: string | null;
  status: string;
  customer_name: string | null;
  customer_vat: string | null;
  is_company: boolean;
  subtotal_cents: number;
  vat_cents: number;
  total_cents: number;
  payment_method: string | null;
  payment_reference: string | null;
  reverses_number: string | null;
  billit_id: string | null;
};

async function* invoiceRows(db: DbOrTx, p: ExportQuery): AsyncIterable<CsvCell[][]> {
  const size = p.pageSize ?? EXPORT_PAGE_SIZE;
  let after: { on: string; number: string } | null = null;
  for (;;) {
    const cursor: SQL = after ? sql`and (i.issued_on, i.number) > (${after.on}::date, ${after.number})` : sql``;
    const rows: InvoiceExportRow[] = rowsOf<InvoiceExportRow>(
      await db.execute(sql`
        select i.number, i.kind::text as kind, i.issued_on::text as issued_on, i.due_on::text as due_on, i.status::text as status,
          i.customer_snapshot ->> 'name' as customer_name, i.customer_snapshot ->> 'vat_number' as customer_vat, i.is_company,
          i.subtotal_cents, i.vat_cents, i.total_cents, i.payment_method, i.payment_reference, r.number as reverses_number, i.billit_id
        from invoices i
        left join invoices r on r.id = i.reverses_invoice_id
        where i.issued_on between ${p.from}::date and ${p.to}::date ${cursor}
        order by i.issued_on, i.number
        limit ${size}`),
    );
    if (!rows.length) return;
    yield rows.map((r) => [
      r.number,
      r.kind,
      r.issued_on,
      r.due_on,
      r.status,
      r.customer_name,
      r.customer_vat,
      boolCell(r.is_company),
      cents(r.subtotal_cents),
      cents(r.vat_cents),
      cents(r.total_cents),
      r.payment_method,
      r.payment_reference,
      r.reverses_number,
      r.billit_id,
    ]);
    if (rows.length < size) return;
    const last: InvoiceExportRow = rows[rows.length - 1]!;
    after = { on: last.issued_on, number: last.number };
  }
}

type LineExportRow = {
  number: string;
  issued_on: string;
  line_no: number;
  sku: string | null;
  category: string | null;
  description: string | null;
  quantity: string | null;
  unit_amount_cents: number | null;
  discount_cents: number | null;
  vat_rate_pct: string | null;
  net_cents: number | null;
  vat_cents: number | null;
  line_total_cents: number | null;
};

async function* invoiceLineRows(db: DbOrTx, p: ExportQuery): AsyncIterable<CsvCell[][]> {
  const size = p.pageSize ?? EXPORT_PAGE_SIZE;
  let after: { on: string; number: string; lineNo: number } | null = null;
  for (;;) {
    const cursor: SQL = after ? sql`and (i.issued_on, i.number, l.ord) > (${after.on}::date, ${after.number}, ${after.lineNo}::bigint)` : sql``;
    const rows: LineExportRow[] = rowsOf<LineExportRow>(
      await db.execute(sql`
        select i.number, i.issued_on::text as issued_on, l.ord::int as line_no,
          l.e ->> 'sku' as sku, l.e ->> 'category' as category, l.e ->> 'description' as description,
          (l.e ->> 'quantity')::numeric::text as quantity, (l.e ->> 'unit_amount_cents')::int as unit_amount_cents,
          coalesce((l.e ->> 'discount_cents')::int, 0) as discount_cents, (l.e ->> 'vat_rate_pct')::numeric::text as vat_rate_pct,
          (l.e ->> 'net_cents')::int as net_cents, (l.e ->> 'vat_cents')::int as vat_cents, (l.e ->> 'line_total_cents')::int as line_total_cents
        from invoices i
        cross join lateral jsonb_array_elements(i.lines) with ordinality as l(e, ord)
        where i.issued_on between ${p.from}::date and ${p.to}::date ${cursor}
        order by i.issued_on, i.number, l.ord
        limit ${size}`),
    );
    if (!rows.length) return;
    yield rows.map((r) => [
      r.number,
      r.line_no,
      r.sku,
      r.category,
      r.description,
      r.quantity === null ? null : Number(r.quantity),
      cents(r.unit_amount_cents),
      cents(r.discount_cents),
      r.vat_rate_pct === null ? null : vatRateCell(r.vat_rate_pct),
      cents(r.net_cents),
      cents(r.vat_cents),
      cents(r.line_total_cents),
    ]);
    if (rows.length < size) return;
    const last: LineExportRow = rows[rows.length - 1]!;
    after = { on: last.issued_on, number: last.number, lineNo: last.line_no };
  }
}

type VatSummaryRow = { month: string; vat_rate_pct: string; kind: string; net_cents: string; vat_cents: string; gross_cents: string };

/** One row per Brussels month, rate and kind; at most a few dozen rows, read in one page. */
async function* vatSummaryRows(db: DbOrTx, p: ExportQuery): AsyncIterable<CsvCell[][]> {
  const rows = rowsOf<VatSummaryRow>(
    await db.execute(sql`
      select date_trunc('month', l.issued_on)::date::text as month, l.vat_rate_pct::text as vat_rate_pct, l.kind::text as kind,
        sum(l.net_cents)::bigint::text as net_cents, sum(l.vat_cents)::bigint::text as vat_cents, sum(l.line_total_cents)::bigint::text as gross_cents
      from v_finance_invoice_lines l
      where l.issued_on between ${p.from}::date and ${p.to}::date
      group by 1, l.vat_rate_pct, l.kind
      order by 1, l.vat_rate_pct, l.kind`),
  );
  if (rows.length) yield rows.map((r) => [r.month, vatRateCell(r.vat_rate_pct), r.kind, cents(r.net_cents), cents(r.vat_cents), cents(r.gross_cents)]);
}

type PaymentExportRow = {
  paid_at: string;
  paid_on: string;
  src: number;
  id: string;
  provider: string | null;
  method: string | null;
  provider_payment_id: string | null;
  order_id: string;
  invoice_number: string | null;
  amount_cents: number;
};

async function* paymentRows(db: DbOrTx, p: ExportQuery): AsyncIterable<CsvCell[][]> {
  const size = p.pageSize ?? EXPORT_PAGE_SIZE;
  let after: { at: string; src: number; id: string } | null = null;
  for (;;) {
    const cursor: SQL = after ? sql`where (u.paid_at, u.src, u.id) > (${after.at}::timestamptz, ${after.src}::int, ${after.id}::uuid)` : sql``;
    const rows: PaymentExportRow[] = rowsOf<PaymentExportRow>(
      await db.execute(sql`
        select u.paid_at::text as paid_at, u.paid_on::text as paid_on, u.src, u.id, u.provider, u.method, u.provider_payment_id, u.order_id, u.invoice_number, u.amount_cents
        from (
          select p.paid_at, (p.paid_at at time zone 'Europe/Brussels')::date as paid_on, 0 as src, p.id, p.provider::text as provider, p.method,
            p.provider_payment_id, p.order_id,
            (select i.number from invoices i where i.order_id = p.order_id and i.kind = 'invoice'
              order by (i.payment_id is not distinct from p.id) desc, (i.status <> 'cancelled') desc, i.issued_at desc limit 1) as invoice_number,
            p.amount_cents
          from payments p
          where p.status in ('paid', 'refunded', 'partially_refunded') and p.paid_at is not null
            and (p.paid_at at time zone 'Europe/Brussels')::date between ${p.from}::date and ${p.to}::date
          union all
          select cn.paid_at, (cn.paid_at at time zone 'Europe/Brussels')::date, 1, cn.id, cn.payment_provider, cn.payment_method,
            r.provider_refund_id, cn.order_id, cn.number, cn.total_cents
          from invoices cn
          left join refunds r on r.id = cn.refund_id
          where cn.kind = 'credit_note' and cn.status = 'paid' and cn.paid_at is not null
            and (cn.paid_at at time zone 'Europe/Brussels')::date between ${p.from}::date and ${p.to}::date
        ) u
        ${cursor}
        order by u.paid_at, u.src, u.id
        limit ${size}`),
    );
    if (!rows.length) return;
    yield rows.map((r) => [r.paid_on, r.provider, r.method, r.provider_payment_id, r.order_id, r.invoice_number, cents(r.amount_cents)]);
    if (rows.length < size) return;
    const last: PaymentExportRow = rows[rows.length - 1]!;
    after = { at: last.paid_at, src: Number(last.src), id: last.id };
  }
}

/** Deferred revenue at the end of `to`: one row per credit kind, VAT treatment and rate. */
async function* deferredRevenueRows(db: DbOrTx, p: ExportQuery): AsyncIterable<CsvCell[][]> {
  const d = await getDeferredRevenue(db, { asOf: p.to });
  if (d.byRate.length) {
    yield d.byRate.map((r) => [d.asOf, r.creditKind, r.vatTreatment, r.vatRatePct === null ? null : vatRateCell(r.vatRatePct), r.units, cents(r.grossCents), cents(r.netCents), cents(r.vatCents)]);
  }
}

/** Recognised, breakage and revoked value per month, credit kind and rate; a few dozen rows, one page. */
async function* breakageRows(db: DbOrTx, p: ExportQuery): AsyncIterable<CsvCell[][]> {
  const rows = await getBreakage(db, { from: p.from, to: p.to });
  if (rows.length) {
    yield rows.map((r) => [
      r.month,
      r.creditKind,
      r.vatRatePct === null ? null : vatRateCell(r.vatRatePct),
      cents(r.recognised.grossCents),
      cents(r.breakage.grossCents),
      cents(r.breakage.netCents),
      cents(r.breakage.vatCents),
      cents(r.revoked.grossCents),
    ]);
  }
}

async function* voucherRedemptionRows(db: DbOrTx, p: ExportQuery): AsyncIterable<CsvCell[][]> {
  const size = p.pageSize ?? EXPORT_PAGE_SIZE;
  let after: { at: string; entryId: string } | null = null;
  for (;;) {
    const page = await voucherRedemptionPage(db, { from: p.from, to: p.to, after, limit: size });
    if (!page.rows.length) return;
    yield page.rows.map((r) => [r.redeemedOn, r.orderId, r.invoiceNumber, cents(r.amountCents), boolCell(r.isReversed)]);
    if (page.rows.length < size) return;
    after = page.last;
  }
}

/** The row source of each kind. */
export const EXPORT_SOURCES: Partial<Record<FinanceExportKind, ExportRowSource>> = {
  invoices: invoiceRows,
  invoice_lines: invoiceLineRows,
  vat_summary: vatSummaryRows,
  payments: paymentRows,
  deferred_revenue: deferredRevenueRows,
  breakage: breakageRows,
  voucher_redemptions: voucherRedemptionRows,
};

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

export type BuiltCsv = { ok: true; bytes: Uint8Array; rowCount: number } | { ok: false; error: typeof EXPORT_TOO_LARGE | typeof EXPORT_KIND_UNAVAILABLE };

/** The CSV of `kind` for the period, or why it cannot be built; stops reading once past `maxBytes`. */
export async function buildExportCsv(db: DbOrTx, kind: FinanceExportKind, period: ExportPeriod, opts: { maxBytes?: number; pageSize?: number } = {}): Promise<BuiltCsv> {
  const source = EXPORT_SOURCES[kind];
  if (!source) return { ok: false, error: EXPORT_KIND_UNAVAILABLE };
  const maxBytes = opts.maxBytes ?? MAX_FILE_BYTES;
  const parts: string[] = [CSV_BOM, csvLine(EXPORT_COLUMNS[kind])];
  let size = parts.reduce((n, s) => n + Buffer.byteLength(s, "utf8"), 0);
  let rowCount = 0;
  for await (const page of source(db, { ...period, ...(opts.pageSize ? { pageSize: opts.pageSize } : {}) })) {
    for (const row of page) {
      const line = csvLine(row);
      size += Buffer.byteLength(line, "utf8");
      if (size > maxBytes) return { ok: false, error: EXPORT_TOO_LARGE };
      parts.push(line);
      rowCount += 1;
    }
  }
  return { ok: true, bytes: new TextEncoder().encode(parts.join("")), rowCount };
}

type ExportRecord = typeof financeExports.$inferSelect;

async function setExport(db: DbOrTx, id: string, patch: Partial<Pick<ExportRecord, "status" | "fileId" | "rowCount" | "error">>): Promise<void> {
  await db.update(financeExports).set({ ...patch, updatedAt: sql`now()` }).where(eq(financeExports.id, id));
}

export type BuildExportResult =
  | { status: "done"; fileId: string; rowCount: number }
  | { status: "already_done"; fileId: string | null; rowCount: number | null }
  | { status: "failed"; error: string }
  | { status: "missing" };

/**
 * `finance.build_export` (section 4.5): builds and stores the CSV of export `exportId` in the
 * job's transaction. Idempotent: a `done` export returns its file, a `failed` one stays failed.
 */
export async function runBuildExport(ctx: JobCtx, input: { exportId: string }): Promise<BuildExportResult> {
  const tx = ctx.tx;
  const [exp] = await tx.select().from(financeExports).where(eq(financeExports.id, input.exportId)).for("update");
  if (!exp) return { status: "missing" };
  if (exp.status === "done") return { status: "already_done", fileId: exp.fileId, rowCount: exp.rowCount };
  if (exp.status === "failed") return { status: "failed", error: exp.error ?? "failed" };
  await setExport(tx, exp.id, { status: "running" });

  const built = await buildExportCsv(tx, exp.kind, { from: exp.periodFrom, to: exp.periodTo });
  if (!built.ok) {
    await setExport(tx, exp.id, { status: "failed", error: built.error });
    return { status: "failed", error: built.error };
  }
  const { fileId } = await storeFile(ctx, {
    kind: "export",
    name: exportFileName(exp.kind, exp.periodFrom, exp.periodTo),
    mime: "text/csv",
    bytes: built.bytes,
    expiresAt: new Date(ctx.now.getTime() + EXPORT_TTL_MS),
  });
  await setExport(tx, exp.id, { status: "done", fileId, rowCount: built.rowCount, error: null });
  return { status: "done", fileId, rowCount: built.rowCount };
}

/** `onDead` of `finance.build_export`: after the last attempt the export is `failed` with the error. */
export async function failExport(db: DbOrTx, exportId: string, message: string): Promise<void> {
  const [exp] = await db.select({ status: financeExports.status }).from(financeExports).where(eq(financeExports.id, exportId));
  if (exp && exp.status !== "done") await setExport(db, exportId, { status: "failed", error: message.slice(0, 500) });
}

// ---------------------------------------------------------------------------
// Request and download
// ---------------------------------------------------------------------------

/** Inserts the export row and enqueues its job (`finance_export:<id>`); the caller audits. */
export async function createFinanceExport(ctx: Ctx, input: { kind: FinanceExportKind; from: string; to: string; userId: string }): Promise<{ exportId: string }> {
  const [row] = await ctx.tx
    .insert(financeExports)
    .values({ kind: input.kind, periodFrom: input.from, periodTo: input.to, requestedByUserId: input.userId })
    .returning({ id: financeExports.id });
  const exportId = row!.id;
  await ctx.enqueue({ kind: "finance.build_export", payload: { exportId }, key: `finance_export:${exportId}` });
  return { exportId };
}

export type ExportDownload =
  | { status: 200; name: string; mime: string; bytes: Uint8Array }
  | { status: 401 | 403 | 404 | 410 };

/**
 * The CSV of a `done` export for a staff user with `reports.finance` (section 4.4), audited as
 * `finance.export_downloaded`. 401 without a staff actor, 403 without the permission, 404 for an
 * unknown id, 410 while the export is not done or after its file expired.
 */
export async function downloadFinanceExport(db: DbOrTx, actor: Actor | null, id: string, opts: { requestId?: string; ip?: string | null } = {}): Promise<ExportDownload> {
  if (!actor || actor.kind !== "staff") return { status: 401 };
  if (!actorHasPermission(actor, "reports.finance")) return { status: 403 };
  if (!/^[0-9a-f-]{36}$/i.test(id)) return { status: 404 };
  const [exp] = await db.select().from(financeExports).where(eq(financeExports.id, id));
  if (!exp) return { status: 404 };
  if (exp.status !== "done" || !exp.fileId) return { status: 410 };
  const file = await readFile(db, exp.fileId);
  if (!file) return { status: 410 };
  await db.transaction(async (tx) => {
    const ctx = createCtx({ tx, actor, ...(opts.requestId ? { requestId: opts.requestId } : {}), ...(opts.ip !== undefined ? { ip: opts.ip } : {}) });
    await ctx.audit({
      action: "finance.export_downloaded",
      entityType: "finance_export",
      entityId: exp.id,
      newValue: { kind: exp.kind, from: exp.periodFrom, to: exp.periodTo, rows: exp.rowCount },
    });
  });
  return { status: 200, name: file.name, mime: file.mime, bytes: file.bytes };
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export type FinanceExportRow = {
  id: string;
  kind: FinanceExportKind;
  periodFrom: string;
  periodTo: string;
  status: FinanceExportStatus;
  rowCount: number | null;
  error: string | null;
  requestedBy: string | null;
  createdAt: Date;
  expiresAt: Date | null;
  /** Done and its file not yet expired. */
  downloadable: boolean;
};

/** The last `limit` (50) exports, newest first, with their requester and file expiry. */
export async function listExports(db: DbOrTx, input: { limit?: number; now?: Date } = {}): Promise<FinanceExportRow[]> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const now = input.now ?? new Date();
  const rows = rowsOf<{
    id: string;
    kind: FinanceExportKind;
    period_from: string;
    period_to: string;
    status: FinanceExportStatus;
    row_count: number | null;
    error: string | null;
    requested_by: string | null;
    created_at: string;
    expires_at: string | null;
    has_file: boolean;
  }>(
    await db.execute(sql`
      select e.id, e.kind::text as kind, e.period_from::text as period_from, e.period_to::text as period_to, e.status::text as status,
        e.row_count, e.error, coalesce(u.name, u.email) as requested_by, e.created_at::text as created_at, f.expires_at::text as expires_at,
        (f.id is not null) as has_file
      from finance_exports e
      left join users u on u.id = e.requested_by_user_id
      left join files f on f.id = e.file_id
      order by e.created_at desc, e.id desc
      limit ${limit}`),
  );
  return rows.map((r) => {
    const expiresAt = r.expires_at ? new Date(r.expires_at) : null;
    return {
      id: r.id,
      kind: r.kind,
      periodFrom: r.period_from,
      periodTo: r.period_to,
      status: r.status,
      rowCount: r.row_count === null ? null : Number(r.row_count),
      error: r.error,
      requestedBy: r.requested_by ?? null,
      createdAt: new Date(r.created_at),
      expiresAt,
      downloadable: r.status === "done" && r.has_file && (!expiresAt || expiresAt.getTime() > now.getTime()),
    };
  });
}

// ---------------------------------------------------------------------------
// Period presets of the exports screen
// ---------------------------------------------------------------------------

export type ExportPreset = "last_month" | "last_quarter" | "last_year";
export const EXPORT_PRESETS: readonly ExportPreset[] = ["last_month", "last_quarter", "last_year"];

const iso = (y: number, m: number, d: number) => `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const lastDayOf = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** The calendar periods before Brussels day `today` (`YYYY-MM-DD`): last month, last quarter, last year. */
export function exportPresets(today: string): Record<ExportPreset, ExportPeriod> {
  const [y, m] = today.split("-").map(Number) as [number, number];
  const pm = m === 1 ? 12 : m - 1;
  const py = m === 1 ? y - 1 : y;
  const q = Math.floor((m - 1) / 3); // current quarter, 0-based
  const qy = q === 0 ? y - 1 : y;
  const qStart = q === 0 ? 10 : (q - 1) * 3 + 1;
  return {
    last_month: { from: iso(py, pm, 1), to: iso(py, pm, lastDayOf(py, pm)) },
    last_quarter: { from: iso(qy, qStart, 1), to: iso(qy, qStart + 2, lastDayOf(qy, qStart + 2)) },
    last_year: { from: iso(y - 1, 1, 1), to: iso(y - 1, 12, 31) },
  };
}
