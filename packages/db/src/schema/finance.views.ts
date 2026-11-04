/**
 * finance V1 views (finance spec section 2.9). Each view is `pgView(name, columns).existing()`
 * with its SQL exported beside it as `<name>Sql`; `pnpm db:views` writes the migration and
 * `createTestDb()` applies the same SQL. Sums and counts are cast to `int` so Drizzle reads
 * numbers. Credit notes carry negative amounts, so sums over both kinds are net figures.
 * R3 views (`v_finance_revenue_daily` and the others) are added by finance-P8.
 */
import { boolean, date, integer, numeric, pgView, smallint, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { invoicesBillitStatus, invoicesKind, invoicesStatus } from "./finance";

/** Per invoice of kind `invoice`: what credit notes took and what is left. */
export const vInvoiceBalancesSql = `select i.id as invoice_id, i.total_cents,
  (-coalesce(sum(cn.total_cents), 0))::int as credited_cents,
  (i.total_cents + coalesce(sum(cn.total_cents), 0))::int as remaining_cents,
  (i.total_cents + coalesce(sum(cn.total_cents), 0)) = 0 as is_fully_credited
from invoices i
left join invoices cn on cn.reverses_invoice_id = i.id and cn.kind = 'credit_note'
where i.kind = 'invoice'
group by i.id, i.total_cents`;

export const vInvoiceBalances = pgView("v_invoice_balances", {
  invoiceId: uuid("invoice_id").notNull(),
  totalCents: integer("total_cents").notNull(),
  creditedCents: integer("credited_cents").notNull(),
  remainingCents: integer("remaining_cents").notNull(),
  isFullyCredited: boolean("is_fully_credited").notNull(),
}).existing();

/** One row per document line (lines are a jsonb snapshot, decision 14). */
export const vFinanceInvoiceLinesSql = `select i.id as invoice_id, i.number, i.kind, i.issued_on, i.fiscal_year, i.status, i.payment_method, i.is_company,
  l.order_line_id, l.product_id, l.sku, l.category, l.description, l.quantity, l.unit_amount_cents, l.discount_cents,
  l.line_total_cents, l.vat_rate_pct, l.vat_cents, l.net_cents, l.credit_kind, l.credit_units
from invoices i
cross join lateral jsonb_to_recordset(i.lines) as l(order_line_id uuid, product_id uuid, sku text, category text, description text,
  quantity numeric, unit_amount_cents int, discount_cents int, line_total_cents int, vat_rate_pct numeric, vat_cents int, net_cents int,
  credit_kind text, credit_units int)`;

export const vFinanceInvoiceLines = pgView("v_finance_invoice_lines", {
  invoiceId: uuid("invoice_id").notNull(),
  number: text("number").notNull(),
  kind: invoicesKind("kind").notNull(),
  issuedOn: date("issued_on").notNull(),
  fiscalYear: smallint("fiscal_year").notNull(),
  status: invoicesStatus("status").notNull(),
  paymentMethod: text("payment_method"),
  isCompany: boolean("is_company").notNull(),
  orderLineId: uuid("order_line_id"),
  productId: uuid("product_id"),
  sku: text("sku"),
  category: text("category"),
  description: text("description"),
  quantity: numeric("quantity"),
  unitAmountCents: integer("unit_amount_cents"),
  discountCents: integer("discount_cents"),
  lineTotalCents: integer("line_total_cents"),
  vatRatePct: numeric("vat_rate_pct"),
  vatCents: integer("vat_cents"),
  netCents: integer("net_cents"),
  creditKind: text("credit_kind"),
  creditUnits: integer("credit_units"),
}).existing();

/** VAT per Brussels month, quarter, fiscal year, kind and rate (accountant and dashboard). */
export const vFinanceVatSummarySql = `select date_trunc('month', l.issued_on)::date as month,
  extract(quarter from l.issued_on)::int as quarter,
  l.fiscal_year, l.kind, l.vat_rate_pct,
  sum(l.net_cents)::int as net_cents,
  sum(l.vat_cents)::int as vat_cents,
  sum(l.line_total_cents)::int as gross_cents
from v_finance_invoice_lines l
group by 1, 2, l.fiscal_year, l.kind, l.vat_rate_pct`;

export const vFinanceVatSummary = pgView("v_finance_vat_summary", {
  month: date("month").notNull(),
  quarter: integer("quarter").notNull(),
  fiscalYear: smallint("fiscal_year").notNull(),
  kind: invoicesKind("kind").notNull(),
  vatRatePct: numeric("vat_rate_pct").notNull(),
  netCents: integer("net_cents").notNull(),
  vatCents: integer("vat_cents").notNull(),
  grossCents: integer("gross_cents").notNull(),
}).existing();

/** Open bank-transfer invoices; a partial credit lowers what is owed (rule 23). */
export const vFinanceOpenInvoicesSql = `select i.id, i.number, i.person_id, i.company_id, i.customer_snapshot ->> 'name' as customer_name,
  i.issued_on, i.total_cents, b.remaining_cents as amount_due_cents, i.due_on,
  greatest(0, (now() at time zone 'Europe/Brussels')::date - i.due_on)::int as days_overdue,
  i.payment_reference, i.billit_status
from invoices i
join v_invoice_balances b on b.invoice_id = i.id
where i.status = 'open'`;

export const vFinanceOpenInvoices = pgView("v_finance_open_invoices", {
  id: uuid("id").notNull(),
  number: text("number").notNull(),
  personId: uuid("person_id"),
  companyId: uuid("company_id"),
  customerName: text("customer_name"),
  issuedOn: date("issued_on").notNull(),
  totalCents: integer("total_cents").notNull(),
  amountDueCents: integer("amount_due_cents").notNull(),
  dueOn: date("due_on"),
  daysOverdue: integer("days_overdue").notNull(),
  paymentReference: text("payment_reference"),
  billitStatus: invoicesBillitStatus("billit_status").notNull(),
}).existing();

/** Documents not yet in Billit, with their failure streak (rule 35). */
export const vFinanceBillitBacklogSql = `select i.id, i.number, i.kind, i.billit_status, i.billit_attempts, i.billit_last_error,
  i.billit_failed_since, i.created_at,
  (extract(epoch from now() - i.created_at) / 60)::int as age_minutes,
  (extract(epoch from now() - i.billit_failed_since) / 60)::int as failing_minutes
from invoices i
where i.billit_status <> 'synced'`;

export const vFinanceBillitBacklog = pgView("v_finance_billit_backlog", {
  id: uuid("id").notNull(),
  number: text("number").notNull(),
  kind: invoicesKind("kind").notNull(),
  billitStatus: invoicesBillitStatus("billit_status").notNull(),
  billitAttempts: integer("billit_attempts").notNull(),
  billitLastError: text("billit_last_error"),
  billitFailedSince: timestamp("billit_failed_since", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  ageMinutes: integer("age_minutes").notNull(),
  failingMinutes: integer("failing_minutes"),
}).existing();
