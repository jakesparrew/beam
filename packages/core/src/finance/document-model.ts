/**
 * The invoice document model (finance rules 18, 36 and 37, finance-P3): everything the PDF
 * prints, resolved from the document's own snapshots into display strings in the document
 * locale. Pure: labels come from `t(locale, key)`, amounts and dates from `Intl` (Brussels), so
 * the same `InvoiceRecord` always gives the same model and the same PDF text.
 *
 * Company documents (B2B) show unit prices and line amounts excluding VAT; consumer documents
 * (B2C) including VAT; both print the VAT breakdown. The buyer block never carries an email
 * address or a phone number (rule 37); the seller's own contact details come from the seller
 * snapshot. Credit notes print "Credit note for invoice <number>" and the reason.
 */
import { PermanentError } from "../errors";
import { formatDate, formatDateTime, formatMoney, formatPercent } from "../i18n/format";
import type { Locale } from "../i18n/locales";
import { t } from "../i18n/t";
import { blockingIssuerFields } from "./seller";
import type { FullCustomerSnapshot, InvoiceKind, InvoiceLine, InvoiceRecord, InvoiceStatus, SellerSnapshot } from "./types";
import { computeLineVat } from "./vat";

export type DocumentColumn = { key: "description" | "quantity" | "unit" | "vat_rate" | "amount"; label: string; align: "left" | "right" };

export type DocumentRow = {
  description: string;
  /** Extra lines under the description: session date, discount, VAT note. */
  details: string[];
  quantity: string;
  unit: string;
  vatRate: string;
  amount: string;
};

export type DocumentField = { label: string; value: string };

export type InvoiceDocumentModel = {
  locale: Locale;
  kind: InvoiceKind;
  status: InvoiceStatus;
  isCompany: boolean;
  /** PDF document information (title, author, subject, language). */
  meta: { title: string; author: string; subject: string; language: Locale; creator: string; producer: string; createdAt: string };
  heading: string;
  number: string;
  /** "Credit note for invoice <number>" on credit notes. */
  reference: string | null;
  seller: { label: string; name: string; lines: string[] };
  customer: { label: string; name: string; lines: string[] };
  /** Number, issue date, due date and structured communication (open invoices). */
  facts: DocumentField[];
  reason: DocumentField | null;
  columns: DocumentColumn[];
  rows: DocumentRow[];
  breakdown: { title: string; columns: [string, string, string, string]; rows: [string, string, string, string][] };
  totals: (DocumentField & { strong: boolean })[];
  payment: { title: string; lines: string[] };
  footer: string;
  /** `finance.pdf.page_x_of_y` with the literal tokens `{x}` and `{y}`, filled in per page. */
  pageLabel: string;
};

/** Production refuses to render a document whose seller block lacks VAT number, enterprise number or IBAN (section 8). */
export class MissingCompanySettingsError extends PermanentError {
  override readonly name: string = "MissingCompanySettingsError";
  readonly missing: readonly string[];
  constructor(missing: readonly string[]) {
    super(`finance.errors.missing_company_settings: ${missing.join(", ")}`);
    this.missing = missing;
  }
}

/** Throws `MissingCompanySettingsError` in production when a blocking seller field is empty (edge case 16). */
export function assertRenderableSeller(seller: SellerSnapshot, appEnv: string | undefined): void {
  if (appEnv !== "production") return;
  const missing = blockingIssuerFields(seller);
  if (missing.length > 0) throw new MissingCompanySettingsError(missing);
}

const PAYMENT_METHOD_KEYS = ["bancontact", "creditcard", "terminal", "cash", "bank_transfer", "voucher", "mixed"] as const;

const money = (cents: number, locale: Locale) => formatMoney(cents, locale);
const nonEmpty = (parts: readonly (string | null | undefined)[]) => parts.map((p) => p?.trim() ?? "").filter((p) => p !== "");

function sellerBlock(s: SellerSnapshot, locale: Locale): InvoiceDocumentModel["seller"] {
  const name = s.trade_name || s.legal_name;
  const lines = nonEmpty([
    s.trade_name && s.legal_name && s.trade_name !== s.legal_name ? s.legal_name : null,
    s.address.line1,
    nonEmpty([s.address.postal_code, s.address.city]).join(" "),
    s.address.country && s.address.country !== "BE" ? s.address.country : null,
    s.vat_number ? `${t(locale, "finance.pdf.vat_number")}: ${s.vat_number}` : null,
    s.enterprise_number ? `${t(locale, "finance.pdf.enterprise_number")}: ${s.enterprise_number}` : null,
    s.register_court ? t(locale, "finance.pdf.register_court", { court: s.register_court }) : null,
    nonEmpty([s.support_email, s.phone, s.website]).join(" · "),
  ]);
  return { label: t(locale, "finance.pdf.seller"), name, lines };
}

function isFull(s: InvoiceRecord["customerSnapshot"]): s is FullCustomerSnapshot {
  return !("anonymised" in s);
}

/** The buyer block: name, address and, for companies, VAT number and PO reference. Never email or phone. */
function customerBlock(invoice: InvoiceRecord, locale: Locale): InvoiceDocumentModel["customer"] {
  const label = t(locale, "finance.pdf.customer");
  const s = invoice.customerSnapshot;
  if (!isFull(s)) return { label, name: "", lines: [] };
  const a = s.address;
  const lines = nonEmpty([
    a?.line1,
    a?.line2,
    a ? nonEmpty([a.postal_code, a.city]).join(" ") : null,
    a && a.country !== "BE" ? a.country : null,
    s.vat_number ? `${t(locale, "finance.pdf.vat_number")}: ${s.vat_number}` : null,
    s.purchase_order_ref ? `${t(locale, "finance.pdf.po_reference")}: ${s.purchase_order_ref}` : null,
  ]);
  return { label, name: s.name, lines };
}

function quantityText(q: number, locale: Locale): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(q);
}

function lineRow(line: InvoiceLine, locale: Locale, isCompany: boolean): DocumentRow {
  const details: string[] = [];
  if (line.session_starts_at) details.push(t(locale, "finance.pdf.session_date", { date: formatDateTime(line.session_starts_at, locale, "long") }));
  if (line.discount_cents !== 0) {
    // Positive on invoices (printed as a reduction), negative on credit notes (rule 21).
    const amount = money(-line.discount_cents, locale);
    details.push(line.discount_label ? t(locale, "finance.pdf.discount_labelled", { label: line.discount_label, amount }) : t(locale, "finance.pdf.discount", { amount }));
  }
  if (line.vat_note) details.push(line.vat_note);
  const unit = isCompany ? computeLineVat(line.unit_amount_cents, line.vat_rate_pct).netCents : line.unit_amount_cents;
  return {
    description: line.description,
    details,
    quantity: quantityText(line.quantity, locale),
    unit: money(unit, locale),
    vatRate: formatPercent(line.vat_rate_pct, locale, 0),
    amount: money(isCompany ? line.net_cents : line.line_total_cents, locale),
  };
}

function methodLabel(method: string | null, locale: Locale): string | null {
  if (!method) return null;
  return (PAYMENT_METHOD_KEYS as readonly string[]).includes(method) ? t(locale, `finance.pdf.method.${method}`) : method;
}

function paymentLines(invoice: InvoiceRecord, locale: Locale): string[] {
  const s = invoice.sellerSnapshot;
  const lines: string[] = [];
  if (invoice.kind === "invoice" && invoice.status === "open") {
    lines.push(t(locale, "finance.pdf.open_pay_by", { amount: money(invoice.totalCents, locale), date: formatDate(invoice.dueOn ?? invoice.issuedOn, locale, "long") }));
    if (s.iban) lines.push(t(locale, "finance.pdf.pay_to", { iban: formatIban(s.iban), bic: s.bic || "-" }));
    if (invoice.paymentReference) lines.push(`${t(locale, "finance.pdf.structured_communication")}: ${invoice.paymentReference}`);
    return lines;
  }
  if (invoice.kind === "invoice") {
    if (invoice.paidAt) lines.push(t(locale, "finance.pdf.paid_on", { date: formatDate(invoice.paidAt, locale, "long") }));
    const method = methodLabel(invoice.paymentMethod, locale);
    if (method) lines.push(t(locale, "finance.pdf.paid_with", { method }));
    if (invoice.paymentTransactionRef) lines.push(`${t(locale, "finance.pdf.transaction_reference")}: ${invoice.paymentTransactionRef}`);
    if (invoice.status === "cancelled") lines.push(t(locale, "finance.pdf.cancelled"));
    return lines;
  }
  if (invoice.status === "paid" && invoice.paidAt) lines.push(t(locale, "finance.pdf.refunded_on", { date: formatDate(invoice.paidAt, locale, "long") }));
  else lines.push(t(locale, "finance.pdf.credit_pending"));
  return lines;
}

/** `BE71096123456769` -> `BE71 0961 2345 6769`. */
export function formatIban(iban: string): string {
  return iban.replace(/\s+/g, "").replace(/(.{4})(?=.)/g, "$1 ");
}

/**
 * Builds the document model of an issued invoice or credit note from its snapshots only.
 * `original` is the reversed invoice of a credit note (its number is printed as the reference).
 */
export function buildInvoiceDocumentModel(invoice: InvoiceRecord, original?: { number: string }): InvoiceDocumentModel {
  const locale = invoice.locale;
  const isCredit = invoice.kind === "credit_note";
  const isCompany = invoice.isCompany;
  const heading = t(locale, isCredit ? "finance.pdf.credit_note_title" : "finance.pdf.invoice_title");
  const seller = sellerBlock(invoice.sellerSnapshot, locale);

  const facts: DocumentField[] = [
    { label: t(locale, "finance.pdf.number"), value: invoice.number },
    { label: t(locale, "finance.pdf.issue_date"), value: formatDate(invoice.issuedOn, locale, "long") },
  ];
  if (!isCredit && invoice.status === "open") {
    if (invoice.dueOn) facts.push({ label: t(locale, "finance.pdf.due_date"), value: formatDate(invoice.dueOn, locale, "long") });
    if (invoice.paymentReference) facts.push({ label: t(locale, "finance.pdf.structured_communication"), value: invoice.paymentReference });
  }

  const columns: DocumentColumn[] = [
    { key: "description", label: t(locale, "finance.pdf.description"), align: "left" },
    { key: "quantity", label: t(locale, "finance.pdf.quantity"), align: "right" },
    { key: "unit", label: t(locale, isCompany ? "finance.pdf.unit_price_excl" : "finance.pdf.unit_price_incl"), align: "right" },
    { key: "vat_rate", label: t(locale, "finance.pdf.vat_rate"), align: "right" },
    { key: "amount", label: t(locale, isCompany ? "finance.pdf.net_amount" : "finance.pdf.amount"), align: "right" },
  ];

  const author = invoice.sellerSnapshot.legal_name || invoice.sellerSnapshot.trade_name;
  return {
    locale,
    kind: invoice.kind,
    status: invoice.status,
    isCompany,
    meta: {
      title: `${heading} ${invoice.number}`,
      author,
      subject: `${heading} ${invoice.number}`,
      language: locale,
      creator: invoice.sellerSnapshot.trade_name || author,
      producer: "BEAM",
      createdAt: new Date(invoice.issuedAt).toISOString(),
    },
    heading,
    number: invoice.number,
    reference: isCredit && original ? t(locale, "finance.pdf.credit_note_for", { number: original.number }) : null,
    seller,
    customer: customerBlock(invoice, locale),
    facts,
    reason: isCredit && invoice.reason ? { label: t(locale, "finance.pdf.reason"), value: invoice.reason } : null,
    columns,
    rows: invoice.lines.map((l) => lineRow(l, locale, isCompany)),
    breakdown: {
      title: t(locale, "finance.pdf.breakdown_title"),
      columns: [t(locale, "finance.pdf.vat_rate"), t(locale, "finance.pdf.taxable_amount"), t(locale, "finance.pdf.vat_amount"), t(locale, "finance.pdf.gross_amount")],
      rows: invoice.vatBreakdown.map((r) => [formatPercent(r.vat_rate_pct, locale, 0), money(r.net_cents, locale), money(r.vat_cents, locale), money(r.gross_cents, locale)]),
    },
    totals: [
      { label: t(locale, "finance.pdf.subtotal_excl"), value: money(invoice.subtotalCents, locale), strong: false },
      { label: t(locale, "finance.pdf.vat_total"), value: money(invoice.vatCents, locale), strong: false },
      { label: t(locale, "finance.pdf.total_incl"), value: money(invoice.totalCents, locale), strong: true },
    ],
    payment: { title: t(locale, "finance.pdf.payment"), lines: paymentLines(invoice, locale) },
    footer: invoice.sellerSnapshot.footer,
    pageLabel: t(locale, "finance.pdf.page_x_of_y", { x: "{x}", y: "{y}" }),
  };
}
