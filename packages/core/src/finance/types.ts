/**
 * finance's pure types and JSON shapes (finance spec section 2.8, 02-data-model 1.2.6).
 * Wave 0 skeleton by platform-P7; finance owns this file from finance-P1 on.
 *
 * JSON stored in `invoices` (`customer_snapshot`, `seller_snapshot`, `lines`, `vat_breakdown`)
 * keeps snake_case keys, because the views of `finance.views.ts` read them with
 * `jsonb_to_recordset`. TypeScript records of a table row (`InvoiceRecord`) use the Drizzle
 * property names (camelCase).
 */
import { z } from "zod";
import { LocalizedTextSchema, type LocalizedText } from "../i18n/localized-text";
import type { Locale } from "../i18n/locales";

// ---------------------------------------------------------------------------
// Enums (section 2.1)
// ---------------------------------------------------------------------------

export const INVOICE_KINDS = ["invoice", "credit_note"] as const;
export type InvoiceKind = (typeof INVOICE_KINDS)[number];

export const INVOICE_STATUSES = ["issued", "paid", "open", "cancelled"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const INVOICE_SETTLED_VIA = ["provider", "billit", "manual", "credit_note"] as const;
export type InvoiceSettledVia = (typeof INVOICE_SETTLED_VIA)[number];

export const INVOICE_PDF_STATUSES = ["pending", "rendered", "failed"] as const;
export type InvoicePdfStatus = (typeof INVOICE_PDF_STATUSES)[number];

export const INVOICE_BILLIT_STATUSES = ["pending", "synced", "failed"] as const;
export type InvoiceBillitStatus = (typeof INVOICE_BILLIT_STATUSES)[number];

export const INVOICE_BILLIT_PAYMENT_STATUSES = ["not_applicable", "pending", "synced", "failed"] as const;
export type InvoiceBillitPaymentStatus = (typeof INVOICE_BILLIT_PAYMENT_STATUSES)[number];

export const INVOICE_PEPPOL_STATUSES = ["not_applicable", "pending", "sent", "failed"] as const;
export type InvoicePeppolStatus = (typeof INVOICE_PEPPOL_STATUSES)[number];

export const INVOICE_REQUEST_STATUSES = ["requested", "approved", "rejected", "cancelled"] as const;
export type InvoiceRequestStatus = (typeof INVOICE_REQUEST_STATUSES)[number];

export const BILLIT_RECONCILE_RUN_STATUSES = ["ok", "issues", "failed"] as const;
export type BillitReconcileRunStatus = (typeof BILLIT_RECONCILE_RUN_STATUSES)[number];

/** Accountant export kinds; the last three are Release 3. */
export const FINANCE_EXPORT_KINDS = [
  "invoices",
  "invoice_lines",
  "vat_summary",
  "payments",
  "deferred_revenue",
  "breakage",
  "voucher_redemptions",
] as const;
export type FinanceExportKind = (typeof FINANCE_EXPORT_KINDS)[number];

export const FINANCE_EXPORT_STATUSES = ["queued", "running", "done", "failed"] as const;
export type FinanceExportStatus = (typeof FINANCE_EXPORT_STATUSES)[number];

/** The four Belgian VAT rates (rule 6). */
export const VAT_RATES = [0, 6, 12, 21] as const;
export type VatRatePct = (typeof VAT_RATES)[number];

/** Invoice line categories (`products.kind`). */
export const INVOICE_LINE_CATEGORIES = ["session", "night", "package", "membership", "ticket", "item", "voucher"] as const;
export type InvoiceLineCategory = (typeof INVOICE_LINE_CATEGORIES)[number];

export const CREDIT_KINDS = ["day", "night", "euro"] as const;
export type InvoiceCreditKind = (typeof CREDIT_KINDS)[number];

export const PAYMENT_METHODS = ["bancontact", "creditcard", "terminal", "cash", "bank_transfer", "voucher", "mixed"] as const;
export type InvoicePaymentMethod = (typeof PAYMENT_METHODS)[number];

export const RECONCILE_ISSUE_TYPES = [
  "missing_in_billit",
  "unknown_in_billit",
  "amount_mismatch",
  "paid_mismatch",
  "sequence_gap",
  "stale_pending",
  "pdf_missing",
] as const;
export type ReconcileIssueType = (typeof RECONCILE_ISSUE_TYPES)[number];

// ---------------------------------------------------------------------------
// JSON shapes (section 2.8)
// ---------------------------------------------------------------------------

const VatRateSchema = z.union([z.literal(0), z.literal(6), z.literal(12), z.literal(21)]);

/** Billing and buyer address: ISO 3166-1 alpha-2 country. */
export const AddressSchema = z.object({
  line1: z.string().trim().min(1).max(200),
  line2: z.string().trim().max(200).optional(),
  postal_code: z.string().trim().min(1).max(20),
  city: z.string().trim().min(1).max(100),
  country: z
    .string()
    .trim()
    .transform((c) => c.toUpperCase())
    .pipe(z.string().regex(/^[A-Z]{2}$/)),
});
export type Address = z.output<typeof AddressSchema>;

const FullCustomerSnapshotSchema = z.object({
  kind: z.enum(["person", "company", "walk_in"]),
  name: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  address: AddressSchema.nullable(),
  vat_number: z.string().nullable(),
  peppol_id: z.string().nullable(),
  purchase_order_ref: z.string().nullable(),
  person_id: z.string().nullable(),
  company_id: z.string().nullable(),
  is_reduced: z.boolean(),
});
export type FullCustomerSnapshot = z.output<typeof FullCustomerSnapshotSchema>;

/** The form the `finance.invoices` retention sweep leaves (rule 45, cross-module D34). */
export const AnonymisedSnapshotSchema = z.object({ anonymised: z.literal(true) }).strict();
export type AnonymisedSnapshot = z.output<typeof AnonymisedSnapshotSchema>;

export const CustomerSnapshotSchema = z.union([FullCustomerSnapshotSchema, AnonymisedSnapshotSchema]);
export type CustomerSnapshot = FullCustomerSnapshot | AnonymisedSnapshot;

export const InvoiceLineSchema = z.object({
  order_line_id: z.string(),
  product_id: z.string(),
  sku: z.string(),
  category: z.enum(INVOICE_LINE_CATEGORIES),
  description: z.string(),
  description_i18n: LocalizedTextSchema,
  quantity: z.number().int(),
  unit_amount_cents: z.number().int(),
  discount_cents: z.number().int(),
  discount_label: z.string().nullable(),
  line_total_cents: z.number().int(),
  vat_rate_pct: VatRateSchema,
  vat_cents: z.number().int(),
  net_cents: z.number().int(),
  vat_note: z.string().nullable(),
  credit_kind: z.enum(CREDIT_KINDS).nullable(),
  credit_units: z.number().int().nullable(),
  session_starts_at: z.string().nullable(),
  /**
   * Credit-note lines only (finance-P1 addition): whether the line credits a quantity or an
   * amount of the original line, so later partial credits know what is left (rule 21).
   */
  credit_by: z.enum(["quantity", "amount"]).optional(),
});
export type InvoiceLine = z.output<typeof InvoiceLineSchema>;

export const VatBreakdownRowSchema = z.object({
  vat_rate_pct: VatRateSchema,
  net_cents: z.number().int(),
  vat_cents: z.number().int(),
  gross_cents: z.number().int(),
});
export type VatBreakdownRow = z.output<typeof VatBreakdownRowSchema>;

/** The seller block of a document (section 8): platform `company` plus `finance.issuer`. */
export const SellerSnapshotSchema = z.object({
  legal_name: z.string(),
  trade_name: z.string(),
  vat_number: z.string(),
  enterprise_number: z.string(),
  address: z.object({ line1: z.string(), postal_code: z.string(), city: z.string(), country: z.string() }),
  support_email: z.string(),
  phone: z.string(),
  website: z.string(),
  register_court: z.string(),
  iban: z.string(),
  bic: z.string(),
  /** `finance.issuer.invoice_footer` in the document locale ("" when that locale is missing). */
  footer: z.string(),
  locale: z.enum(["nl-BE", "fr-BE", "en"]),
});
export type SellerSnapshot = z.output<typeof SellerSnapshotSchema>;

/** `billit_reconcile_runs.issues[]`; no personal data. */
export type ReconcileIssue = {
  invoice_id?: string;
  number?: string;
  billit_id?: string;
  type: ReconcileIssueType;
  detail: string;
};

/** `invoices.issued_by`: who issued the document. */
export type IssuedBy = { kind: "staff" | "customer" | "system" | "job" | "webhook"; id: string | null };

// ---------------------------------------------------------------------------
// Inputs of the pure core
// ---------------------------------------------------------------------------

/** crm's postal address shape (`persons.address`, `companies.address`). */
export type CrmPostalAddress = {
  street?: string;
  number?: string;
  box?: string;
  postal_code?: string;
  city?: string;
  country: string;
};

/** The person columns an invoice snapshot needs (crm `persons`). */
export type PersonForBilling = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  address: CrmPostalAddress | null;
  locale?: Locale;
};

/** The company columns an invoice snapshot needs (crm `companies`). */
export type CompanyForBilling = {
  id: string;
  name: string;
  vatNumber: string | null;
  address: CrmPostalAddress | null;
};

/** One `order_lines` row as `linesFromOrderLines` reads it (commerce, IMMUTABLE). */
export type OrderLineForInvoice = {
  id: string;
  lineNo?: number;
  productId: string;
  productKind: InvoiceLineCategory;
  sku: string;
  description: LocalizedText;
  quantity: number;
  unitAmountCents: number;
  discountCents: number;
  discountLabel?: string | null;
  lineTotalCents: number;
  /** `numeric(4,2)` arrives as a string (`"21.00"`). */
  vatRatePct: number | string;
  vatCents: number;
  creditKind?: InvoiceCreditKind | null;
  creditUnits?: number | null;
  sessionStartsAt?: string | Date | null;
};

/** A request to credit part of an invoice (finance api `CreditNoteLineInput`). */
export type CreditNoteLineInput = { orderLineId: string; quantity?: number; amountCents?: number };

/** One `invoices` row (Drizzle property names). */
export type InvoiceRecord = {
  id: string;
  kind: InvoiceKind;
  number: string;
  fiscalYear: number;
  sequenceNumber: number;
  reversesInvoiceId: string | null;
  replacesInvoiceId: string | null;
  orderId: string;
  paymentId: string | null;
  refundId: string | null;
  personId: string | null;
  companyId: string | null;
  isCompany: boolean;
  locale: Locale;
  currency: string;
  customerSnapshot: CustomerSnapshot;
  sellerSnapshot: SellerSnapshot;
  lines: InvoiceLine[];
  subtotalCents: number;
  vatCents: number;
  totalCents: number;
  vatBreakdown: VatBreakdownRow[];
  issuedOn: string;
  issuedAt: Date;
  dueOn: string | null;
  status: InvoiceStatus;
  paidAt: Date | null;
  settledVia: InvoiceSettledVia | null;
  paymentProvider: string | null;
  paymentMethod: string | null;
  paymentTransactionRef: string | null;
  paymentReference: string | null;
  reason: string | null;
  pdfFileId: string | null;
  pdfStatus: InvoicePdfStatus;
  emailedAt: Date | null;
  billitId: string | null;
  billitStatus: InvoiceBillitStatus;
  billitSyncedAt: Date | null;
  billitAttempts: number;
  billitLastError: string | null;
  billitFailedSince: Date | null;
  billitPaymentStatus: InvoiceBillitPaymentStatus;
  peppolStatus: InvoicePeppolStatus;
  issuedBy: IssuedBy;
  createdAt: Date;
  updatedAt: Date;
};

// ---------------------------------------------------------------------------
// Cross-module contract types (02-data-model 6.6)
// ---------------------------------------------------------------------------

export type InvoiceSummary = {
  id: string;
  kind: "invoice" | "credit_note";
  number: string;
  issuedOn: string;
  status: "issued" | "paid" | "open" | "cancelled";
  totalCents: number;
  isCompany: boolean;
  pdfReady: boolean;
};

/** R4 KPIs for ops dashboards, weekly summary and NL questions (shape finalised by finance-P10). */
export type FinanceKpis = {
  from: string;
  to: string;
  invoicedCents: number;
  creditedCents: number;
  netRevenueCents: number;
  vatCents: number;
  openCents: number;
  overdueCents: number;
  invoices: number;
  creditNotes: number;
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * A finance rule refused the request. `code` lets `action()` map it (`conflict`); `message`
 * is the catalogue key (`finance.errors.*`) shown to the user.
 */
export class FinanceConflictError extends Error {
  override readonly name: string = "FinanceConflictError";
  readonly code = "conflict" as const;
  readonly data: Record<string, unknown> | undefined;
  constructor(messageKey: string, data?: Record<string, unknown>) {
    super(messageKey);
    this.data = data;
  }
}

/** Input that can never be issued as given (`validation`), e.g. a 0 % line without a VAT note. */
export class FinanceValidationError extends Error {
  override readonly name: string = "FinanceValidationError";
  readonly code = "validation" as const;
  readonly data: Record<string, unknown> | undefined;
  constructor(messageKey: string, data?: Record<string, unknown>) {
    super(messageKey);
    this.data = data;
  }
}
