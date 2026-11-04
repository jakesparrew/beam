/**
 * finance tables (finance spec section 2, 02-data-model 1.2.6). Wave 0 (platform-P2) created
 * `invoices` and `invoice_sequences` with their architecture columns; finance-P1 adds the
 * "(addition)" columns, checks and indexes and leaves every Wave 0 column's type, nullability
 * and default as it was (frozen contract columns), and creates `order_billing_details`,
 * `invoice_requests`, `billit_parties`, `billit_reconcile_runs` and `finance_exports`.
 *
 * `invoices` is IMMUTABLE after issue at column level (section 2.2): the trigger
 * `invoices_guard_immutable()` is `INVOICES_GUARD_TRIGGER_SQL` of `@beam/core/finance`, added
 * by the orchestrator as the custom migration `finance_invoices_guard.sql`. Credit notes store
 * negative amounts and quantities.
 */
import {
  BILLIT_RECONCILE_RUN_STATUSES,
  FINANCE_EXPORT_KINDS,
  FINANCE_EXPORT_STATUSES,
  INVOICE_BILLIT_PAYMENT_STATUSES,
  INVOICE_PDF_STATUSES,
  INVOICE_PEPPOL_STATUSES,
  INVOICE_REQUEST_STATUSES,
  INVOICE_SETTLED_VIA,
  type Address,
  type BillingDetails,
  type CustomerSnapshot,
  type InvoiceLine,
  type IssuedBy,
  type ReconcileIssue,
  type SellerSnapshot,
  type VatBreakdownRow,
} from "@beam/core/finance";
import { sql } from "drizzle-orm";
import {
  boolean,
  char,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { orders, payments, refunds } from "./commerce";
import { companies, persons } from "./crm";
import { id, localeEnum, money, timestamps, tstz } from "./_shared";
import { files, users } from "./platform";

// ---------------------------------------------------------------------------
// 2.1 Enums
// ---------------------------------------------------------------------------

export const invoicesKind = pgEnum("invoices_kind", ["invoice", "credit_note"]);
export const invoicesStatus = pgEnum("invoices_status", [
  "issued",
  "paid",
  "open",
  "cancelled",
]);
export const invoicesBillitStatus = pgEnum("invoices_billit_status", [
  "pending",
  "synced",
  "failed",
]);
export const invoicesSettledVia = pgEnum("invoices_settled_via", INVOICE_SETTLED_VIA);
export const invoicesPdfStatus = pgEnum("invoices_pdf_status", INVOICE_PDF_STATUSES);
export const invoicesBillitPaymentStatus = pgEnum("invoices_billit_payment_status", INVOICE_BILLIT_PAYMENT_STATUSES);
export const invoicesPeppolStatus = pgEnum("invoices_peppol_status", INVOICE_PEPPOL_STATUSES);
export const invoiceRequestsStatus = pgEnum("invoice_requests_status", INVOICE_REQUEST_STATUSES);
export const billitReconcileRunsStatus = pgEnum("billit_reconcile_runs_status", BILLIT_RECONCILE_RUN_STATUSES);
export const financeExportsKind = pgEnum("finance_exports_kind", FINANCE_EXPORT_KINDS);
export const financeExportsStatus = pgEnum("finance_exports_status", FINANCE_EXPORT_STATUSES);

// ---------------------------------------------------------------------------
// 2.2 invoices (IMMUTABLE after issue, column level)
// ---------------------------------------------------------------------------

export const invoices = pgTable(
  "invoices",
  {
    // Wave 0 architecture columns (frozen: type, nullability and default unchanged).
    id: id(),
    kind: invoicesKind().notNull(),
    number: text().notNull().unique(),
    reversesInvoiceId: uuid().references((): AnyPgColumn => invoices.id),
    orderId: uuid()
      .notNull()
      .references(() => orders.id),
    personId: uuid().references(() => persons.id, { onDelete: "restrict" }),
    companyId: uuid().references(() => companies.id),
    /** PII. */
    customerSnapshot: jsonb().$type<CustomerSnapshot>().notNull(),
    lines: jsonb().$type<InvoiceLine[]>().notNull(),
    subtotalCents: money().notNull(),
    vatCents: money().notNull(),
    totalCents: money().notNull(),
    vatBreakdown: jsonb().$type<VatBreakdownRow[]>().notNull(),
    issuedOn: date().notNull(),
    dueOn: date(),
    status: invoicesStatus().notNull(),
    pdfFileId: uuid().references(() => files.id),
    billitId: text().unique("invoices_billit_id_unique"),
    billitStatus: invoicesBillitStatus().notNull().default("pending"),
    billitSyncedAt: tstz(),
    // finance-P1 additions.
    fiscalYear: smallint().notNull(),
    sequenceNumber: integer().notNull(),
    replacesInvoiceId: uuid().references((): AnyPgColumn => invoices.id),
    paymentId: uuid().references((): AnyPgColumn => payments.id),
    refundId: uuid().references((): AnyPgColumn => refunds.id),
    isCompany: boolean().notNull().default(false),
    locale: localeEnum().notNull(),
    currency: char({ length: 3 }).notNull().default("EUR"),
    sellerSnapshot: jsonb().$type<SellerSnapshot>().notNull(),
    issuedAt: tstz().notNull().defaultNow(),
    paidAt: tstz(),
    settledVia: invoicesSettledVia(),
    paymentProvider: text(),
    paymentMethod: text(),
    paymentTransactionRef: text(),
    paymentReference: text(),
    reason: text(),
    pdfStatus: invoicesPdfStatus().notNull().default("pending"),
    emailedAt: tstz(),
    billitAttempts: integer().notNull().default(0),
    /** Never personal data. */
    billitLastError: text(),
    billitFailedSince: tstz(),
    billitPaymentStatus: invoicesBillitPaymentStatus().notNull().default("not_applicable"),
    peppolStatus: invoicesPeppolStatus().notNull().default("not_applicable"),
    issuedBy: jsonb().$type<IssuedBy>().notNull(),
    ...timestamps(),
  },
  (t) => [
    index("ix_invoices_issued_on").on(t.issuedOn, t.kind),
    index("ix_invoices_order").on(t.orderId),
    index("ix_invoices_reverses").on(t.reversesInvoiceId),
    index("ix_invoices_person").on(t.personId, t.issuedAt.desc()),
    index("ix_invoices_company")
      .on(t.companyId)
      .where(sql`${t.companyId} is not null`),
    index("ix_invoices_open")
      .on(t.dueOn)
      .where(sql`${t.status} = 'open'`),
    index("ix_invoices_billit_backlog")
      .on(t.billitStatus, t.createdAt)
      .where(sql`${t.billitStatus} <> 'synced'`),
    index("ix_invoices_pdf_pending")
      .on(t.createdAt)
      .where(sql`${t.pdfStatus} <> 'rendered'`),
    uniqueIndex("uq_invoices_kind_year_sequence").on(t.kind, t.fiscalYear, t.sequenceNumber),
    uniqueIndex("uq_invoices_order_live")
      .on(t.orderId)
      .where(sql`${t.kind} = 'invoice' and ${t.status} <> 'cancelled'`),
    uniqueIndex("uq_invoices_refund")
      .on(t.refundId)
      .where(sql`${t.refundId} is not null`),
    uniqueIndex("uq_invoices_payment_reference")
      .on(t.paymentReference)
      .where(sql`${t.paymentReference} is not null`),
    check(
      "chk_invoices_total",
      sql`${t.totalCents} = ${t.subtotalCents} + ${t.vatCents}`,
    ),
    check(
      "chk_invoices_kind_amounts",
      sql`(${t.kind} = 'invoice' and ${t.totalCents} >= 0 and ${t.subtotalCents} >= 0) or (${t.kind} = 'credit_note' and ${t.totalCents} <= 0 and ${t.subtotalCents} <= 0)`,
    ),
    check(
      "chk_invoices_vat_sign",
      sql`(${t.kind} = 'invoice' and ${t.vatCents} >= 0) or (${t.kind} = 'credit_note' and ${t.vatCents} <= 0)`,
    ),
    check(
      "chk_invoices_reverses",
      sql`(${t.kind} = 'credit_note') = (${t.reversesInvoiceId} is not null)`,
    ),
    check(
      "chk_invoices_replaces",
      sql`${t.replacesInvoiceId} is null or ${t.kind} = 'invoice'`,
    ),
    check(
      "chk_invoices_refund",
      sql`${t.refundId} is null or ${t.kind} = 'credit_note'`,
    ),
    check(
      "chk_invoices_reason",
      sql`${t.kind} = 'invoice' or coalesce(length(trim(${t.reason})), 0) >= 3`,
    ),
    check(
      "chk_invoices_open_due",
      sql`${t.status} <> 'open' or (${t.kind} = 'invoice' and ${t.dueOn} is not null)`,
    ),
    check(
      "chk_invoices_paid_at",
      sql`${t.status} <> 'paid' or ${t.paidAt} is not null`,
    ),
    check(
      "chk_invoices_number_prefix",
      sql`${t.number} like case ${t.kind} when 'invoice' then 'BEAM-%' else 'CN-%' end`,
    ),
    check(
      "chk_invoices_number_format",
      sql`${t.number} = (case ${t.kind} when 'invoice' then 'BEAM-' else 'CN-' end) || ${t.fiscalYear}::text || '-' || lpad(${t.sequenceNumber}::text, 6, '0')`,
    ),
    check(
      "chk_invoices_status_kind",
      sql`(${t.kind} = 'invoice' and ${t.status} in ('paid', 'open', 'cancelled')) or (${t.kind} = 'credit_note' and ${t.status} in ('issued', 'paid'))`,
    ),
    check(
      "chk_invoices_party",
      sql`${t.personId} is not null or ${t.companyId} is not null
        or coalesce((${t.customerSnapshot}->>'is_reduced')::boolean, false)
        or coalesce((${t.customerSnapshot}->>'anonymised')::boolean, false)
        or coalesce(${t.customerSnapshot}->>'kind' = 'walk_in', false)`,
    ),
    check("chk_invoices_sequence_number", sql`${t.sequenceNumber} > 0`),
    check(
      "chk_invoices_fiscal_year",
      sql`${t.fiscalYear} = extract(year from ${t.issuedOn})::int`,
    ),
    check("chk_invoices_currency", sql`${t.currency} = 'EUR'`),
    check(
      "chk_invoices_lines",
      sql`case when jsonb_typeof(${t.lines}) = 'array' then jsonb_array_length(${t.lines}) >= 1 else false end`,
    ),
    check("chk_invoices_billit_attempts", sql`${t.billitAttempts} >= 0`),
  ],
);

// ---------------------------------------------------------------------------
// 2.3 invoice_sequences
// ---------------------------------------------------------------------------

export const invoiceSequences = pgTable(
  "invoice_sequences",
  {
    id: id(),
    kind: invoicesKind().notNull(),
    year: smallint().notNull(),
    lastNumber: integer().notNull().default(0),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("invoice_sequences_year_kind_uq").on(t.year, t.kind),
    check("chk_invoice_sequences_year", sql`${t.year} between 2026 and 2100`),
    check("chk_invoice_sequences_last_number", sql`${t.lastNumber} >= 0`),
  ],
);

// ---------------------------------------------------------------------------
// 2.4 order_billing_details
// ---------------------------------------------------------------------------

/** Billing identity chosen at checkout or by staff, read when the invoice is issued. PII. */
export const orderBillingDetails = pgTable(
  "order_billing_details",
  {
    id: id(),
    orderId: uuid()
      .notNull()
      .unique("order_billing_details_order_id_unique")
      .references(() => orders.id),
    isCompany: boolean().notNull().default(false),
    /** PII when it is a person's name. */
    legalName: text().notNull(),
    vatNumber: text(),
    /** PII. */
    address: jsonb().$type<Address>().notNull(),
    /** PII: invoice email recipient. */
    billingEmail: text(),
    purchaseOrderRef: text(),
    peppolId: text(),
    ...timestamps(),
  },
  (t) => [
    check("chk_obd_company_vat", sql`not ${t.isCompany} or ${t.vatNumber} is not null`),
    check("chk_obd_legal_name", sql`length(trim(${t.legalName})) >= 2`),
    check(
      "chk_obd_vat_format",
      sql`${t.vatNumber} is null or ${t.vatNumber} ~ '^[A-Z]{2}[0-9A-Z+*]{2,13}$'`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// 2.5 invoice_requests
// ---------------------------------------------------------------------------

/** B2C "company invoice on request" (rule 20). */
export const invoiceRequests = pgTable(
  "invoice_requests",
  {
    id: id(),
    invoiceId: uuid()
      .notNull()
      .references((): AnyPgColumn => invoices.id),
    /** PII link: the requester. */
    personId: uuid().references(() => persons.id, { onDelete: "restrict" }),
    /** PII. */
    billing: jsonb().$type<BillingDetails>().notNull(),
    status: invoiceRequestsStatus().notNull().default("requested"),
    decidedByUserId: uuid().references(() => users.id),
    decidedAt: tstz(),
    /** Shown to the customer on rejection. */
    decisionNote: text(),
    creditNoteId: uuid().references((): AnyPgColumn => invoices.id),
    newInvoiceId: uuid().references((): AnyPgColumn => invoices.id),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("uq_invoice_requests_pending")
      .on(t.invoiceId)
      .where(sql`${t.status} = 'requested'`),
    index("ix_invoice_requests_status").on(t.status, t.createdAt),
    index("ix_invoice_requests_person")
      .on(t.personId)
      .where(sql`${t.personId} is not null`),
    check(
      "chk_invoice_requests_decided",
      sql`${t.status} not in ('approved', 'rejected') or ${t.decidedAt} is not null`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// 2.6 billit_parties
// ---------------------------------------------------------------------------

/** Our customers as Billit parties; `walk_in` is the one shared party of anonymous POS sales. */
export const billitParties = pgTable(
  "billit_parties",
  {
    id: id(),
    partyKey: text().notNull().unique("billit_parties_party_key_unique"),
    /** PII link; nulled on erasure. */
    personId: uuid().references(() => persons.id, { onDelete: "restrict" }),
    companyId: uuid().references(() => companies.id),
    billitPartyId: text().unique("billit_parties_billit_party_id_unique"),
    /** sha256 of the last pushed party payload. */
    snapshotHash: text(),
    syncedAt: tstz(),
    lastError: text(),
    isAnonymised: boolean().notNull().default(false),
    ...timestamps(),
  },
  (t) => [
    index("ix_billit_parties_person")
      .on(t.personId)
      .where(sql`${t.personId} is not null`),
    check(
      "chk_billit_parties_key",
      sql`${t.partyKey} = 'walk_in' or ${t.partyKey} ~ '^(person|company):[0-9a-f-]{36}$' or ${t.partyKey} ~ '^vat:[A-Z]{2}[0-9A-Z+*]{2,13}$'`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// 2.7 billit_reconcile_runs and finance_exports
// ---------------------------------------------------------------------------

/** One run per day (a re-run upserts on `run_on`); issues hold no personal data. */
export const billitReconcileRuns = pgTable(
  "billit_reconcile_runs",
  {
    id: id(),
    runOn: date().notNull().unique("billit_reconcile_runs_run_on_unique"),
    startedAt: tstz().notNull(),
    finishedAt: tstz(),
    status: billitReconcileRunsStatus().notNull(),
    checkedCount: integer().notNull().default(0),
    issuesCount: integer().notNull().default(0),
    issues: jsonb().$type<ReconcileIssue[]>().notNull().default([]),
    ...timestamps(),
  },
  (t) => [
    check(
      "chk_billit_reconcile_runs_counts",
      sql`${t.checkedCount} >= 0 and ${t.issuesCount} >= 0`,
    ),
  ],
);

/** Accountant CSV exports; the files are `kind = 'export'`, expire after 7 days, `person_id = null`. */
export const financeExports = pgTable(
  "finance_exports",
  {
    id: id(),
    kind: financeExportsKind().notNull(),
    periodFrom: date().notNull(),
    periodTo: date().notNull(),
    status: financeExportsStatus().notNull().default("queued"),
    fileId: uuid().references(() => files.id),
    rowCount: integer(),
    error: text(),
    requestedByUserId: uuid()
      .notNull()
      .references(() => users.id),
    ...timestamps(),
  },
  (t) => [
    index("ix_finance_exports_created").on(t.createdAt.desc()),
    check(
      "chk_finance_exports_period",
      sql`${t.periodTo} >= ${t.periodFrom} and ${t.periodTo} - ${t.periodFrom} <= 365`,
    ),
    check(
      "chk_finance_exports_row_count",
      sql`${t.rowCount} is null or ${t.rowCount} >= 0`,
    ),
  ],
);
