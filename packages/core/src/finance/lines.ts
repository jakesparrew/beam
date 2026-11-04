/**
 * Invoice and credit-note lines (finance rules 5, 7, 16, 21 and 22).
 *
 * `linesFromOrderLines` copies order lines 1:1 (finance never re-prices) and picks the document
 * locale: the customer's locale when every line has a description in it, else `nl-BE` for the
 * whole document (rule 16, never mixed). A 0 % line must carry a VAT note from
 * `settings.finance.vat_notes` in the document locale.
 *
 * `creditLines` computes credit-note lines against what earlier credit notes already took:
 * - by quantity `q` of a line with quantity `Q` and gross `G`: gross `round_half_up(G * q / Q)`,
 *   except that the credit which brings the credited quantity to `Q` takes exactly the remainder;
 *   quantity `-q`, the original unit amount, the discount follows from the identity
 *   `line_total = unit * quantity - discount`;
 * - by amount `a`: quantity `-1`, unit amount `a`, no discount, description prefixed with the
 *   `finance.pdf.partial_credit` label;
 * - `'full'`: everything that is left of every line.
 * VAT is recomputed per credit line with the line's rate. Crediting more than is left of a
 * line throws `conflict` (`finance.errors.credit_exceeds_invoice`).
 */
import { divRoundHalfUp } from "../commerce/vat";
import { DEFAULT_LOCALE, type Locale } from "../i18n/locales";
import type { LocalizedText } from "../i18n/localized-text";
import {
  FinanceConflictError,
  FinanceValidationError,
  type CreditNoteLineInput,
  type InvoiceLine,
  type InvoiceLineCategory,
  type OrderLineForInvoice,
} from "./types";
import { computeLineVat, toVatRate } from "./vat";

export type VatNotes = Partial<Record<InvoiceLineCategory, LocalizedText>>;

const present = (v: string | undefined | null): v is string => typeof v === "string" && v.trim().length > 0;

/** The text of `t` in `locale`; if even `nl-BE` is missing (legacy rows), the first present locale. */
function textIn(t: LocalizedText, locale: Locale): string {
  if (present(t[locale])) return t[locale].trim();
  const any = [t["nl-BE"], t.en, t["fr-BE"]].find(present);
  return any?.trim() ?? "";
}

/** The document locale of a set of lines (rule 16). */
export function documentLocale(rows: readonly { description: LocalizedText }[], locale: Locale): Locale {
  return rows.every((r) => present(r.description[locale])) ? locale : DEFAULT_LOCALE;
}

const toIso = (v: string | Date | null | undefined): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : v);

export function linesFromOrderLines(
  rows: OrderLineForInvoice[],
  locale: Locale,
  vatNotes: VatNotes,
): { lines: InvoiceLine[]; locale: Locale } {
  if (rows.length === 0) throw new FinanceValidationError("finance.errors.no_lines");
  const docLocale = documentLocale(rows, locale);
  const sorted = [...rows].sort((a, b) => (a.lineNo ?? 0) - (b.lineNo ?? 0));
  const lines = sorted.map((r): InvoiceLine => {
    const rate = toVatRate(r.vatRatePct);
    let vatNote: string | null = null;
    if (rate === 0) {
      const note = vatNotes[r.productKind]?.[docLocale];
      if (!present(note)) {
        throw new FinanceValidationError("finance.errors.vat_note_missing", { category: r.productKind, locale: docLocale });
      }
      vatNote = note.trim();
    }
    return {
      order_line_id: r.id,
      product_id: r.productId,
      sku: r.sku,
      category: r.productKind,
      description: textIn(r.description, docLocale),
      description_i18n: { ...r.description },
      quantity: r.quantity,
      unit_amount_cents: r.unitAmountCents,
      discount_cents: r.discountCents,
      discount_label: r.discountLabel ?? null,
      line_total_cents: r.lineTotalCents,
      vat_rate_pct: rate,
      vat_cents: r.vatCents,
      net_cents: r.lineTotalCents - r.vatCents,
      vat_note: vatNote,
      credit_kind: r.creditKind ?? null,
      credit_units: r.creditUnits ?? null,
      session_starts_at: toIso(r.sessionStartsAt),
    };
  });
  return { lines, locale: docLocale };
}

type LineState = { line: InvoiceLine; creditedQty: number; creditedGross: number; creditedByAmount: number; creditedUnits: number };

/** How a credit line credited its original line (lines without `credit_by` are inferred). */
function creditMode(credit: InvoiceLine, original: InvoiceLine): "quantity" | "amount" {
  if (credit.credit_by) return credit.credit_by;
  return credit.unit_amount_cents === original.unit_amount_cents && credit.discount_cents <= 0 && credit.description === original.description
    ? "quantity"
    : "amount";
}

function creditLine(state: LineState, mode: "quantity" | "amount", qty: number, gross: number, label: string): InvoiceLine {
  const { line } = state;
  const rate = toVatRate(line.vat_rate_pct);
  const { vatCents, netCents } = computeLineVat(0 - gross, rate);
  const byQuantity = mode === "quantity";
  const discount = byQuantity ? line.unit_amount_cents * qty - gross : 0;
  let units: number | null = null;
  if (byQuantity && line.credit_units !== null && line.quantity > 0) {
    units = state.creditedQty + qty === line.quantity ? line.credit_units - state.creditedUnits : divRoundHalfUp(line.credit_units * qty, line.quantity);
  }
  return {
    ...line,
    description: byQuantity || !label ? line.description : `${label} ${line.description}`,
    quantity: byQuantity ? 0 - qty : -1,
    unit_amount_cents: byQuantity ? line.unit_amount_cents : gross,
    discount_cents: 0 - discount,
    discount_label: byQuantity && discount !== 0 ? line.discount_label : null,
    line_total_cents: 0 - gross,
    vat_cents: vatCents,
    net_cents: netCents,
    credit_units: units === null ? null : 0 - units,
    credit_by: mode,
  };
}

/**
 * Credit-note lines for `request` against `invoice`, given the lines of the credit notes the
 * invoice already has (`already`). Lines come out in invoice order; amounts are negative.
 */
export function creditLines(
  invoice: InvoiceLine[],
  already: InvoiceLine[][],
  request: CreditNoteLineInput[] | "full",
  opts: { partialCreditLabel?: string } = {},
): InvoiceLine[] {
  const states = new Map<string, LineState>();
  for (const line of invoice) {
    if (line.quantity < 0 || line.line_total_cents < 0) throw new FinanceValidationError("finance.errors.not_an_invoice_line");
    states.set(line.order_line_id, { line, creditedQty: 0, creditedGross: 0, creditedByAmount: 0, creditedUnits: 0 });
  }
  const credit = (s: LineState, c: InvoiceLine) => {
    s.creditedGross += -c.line_total_cents;
    if (creditMode(c, s.line) === "quantity") {
      s.creditedQty += -c.quantity;
      s.creditedUnits += -(c.credit_units ?? 0);
    } else {
      s.creditedByAmount += -c.line_total_cents;
    }
  };
  for (const note of already) {
    for (const c of note) {
      const s = states.get(c.order_line_id);
      if (!s) throw new FinanceValidationError("finance.errors.unknown_line", { orderLineId: c.order_line_id });
      credit(s, c);
    }
  }
  const exceeds = (orderLineId: string) => new FinanceConflictError("finance.errors.credit_exceeds_invoice", { orderLineId });
  for (const s of states.values()) {
    if (s.creditedGross > s.line.line_total_cents || s.creditedQty > s.line.quantity) throw exceeds(s.line.order_line_id);
  }

  const out: { index: number; line: InvoiceLine }[] = [];
  const index = new Map(invoice.map((l, i) => [l.order_line_id, i]));
  const push = (s: LineState, mode: "quantity" | "amount", qty: number, gross: number) => {
    const line = creditLine(s, mode, qty, gross, opts.partialCreditLabel ?? "");
    credit(s, line);
    out.push({ index: index.get(s.line.order_line_id)!, line });
  };

  if (request === "full") {
    for (const s of states.values()) {
      const remainingGross = s.line.line_total_cents - s.creditedGross;
      const remainingQty = s.line.quantity - s.creditedQty;
      if (remainingGross <= 0) continue;
      // Only quantities taken so far: credit the remaining quantity (it takes the exact remainder).
      // Once an amount was credited, the rest of the line goes as one amount line.
      if (remainingQty > 0 && s.creditedByAmount === 0) push(s, "quantity", remainingQty, remainingGross);
      else push(s, "amount", 1, remainingGross);
    }
  } else {
    if (request.length === 0) throw new FinanceValidationError("finance.errors.no_lines");
    for (const r of request) {
      const s = states.get(r.orderLineId);
      if (!s) throw new FinanceValidationError("finance.errors.unknown_line", { orderLineId: r.orderLineId });
      const remainingGross = s.line.line_total_cents - s.creditedGross;
      const byQty = r.quantity !== undefined;
      const byAmount = r.amountCents !== undefined;
      if (byQty === byAmount) throw new FinanceValidationError("finance.errors.credit_line_quantity_or_amount", { orderLineId: r.orderLineId });
      if (byQty) {
        const q = r.quantity!;
        if (!Number.isInteger(q) || q <= 0) throw new FinanceValidationError("finance.errors.credit_quantity_invalid", { orderLineId: r.orderLineId });
        if (s.creditedQty + q > s.line.quantity) throw exceeds(r.orderLineId);
        const gross = s.creditedQty + q === s.line.quantity ? remainingGross : divRoundHalfUp(s.line.line_total_cents * q, s.line.quantity);
        if (gross > remainingGross || gross < 0) throw exceeds(r.orderLineId);
        push(s, "quantity", q, gross);
      } else {
        const a = r.amountCents!;
        if (!Number.isInteger(a) || a <= 0) throw new FinanceValidationError("finance.errors.credit_amount_invalid", { orderLineId: r.orderLineId });
        if (a > remainingGross) throw exceeds(r.orderLineId);
        push(s, "amount", 1, a);
      }
    }
  }
  if (out.length === 0) throw new FinanceConflictError("finance.errors.credit_exceeds_invoice");
  return out.sort((a, b) => a.index - b.index).map((o) => o.line);
}

/** What is left to credit per order line (gross), for the credit dialog and rule 22 checks. */
export function remainingToCredit(invoice: InvoiceLine[], already: InvoiceLine[][]): Map<string, { quantity: number; grossCents: number }> {
  const out = new Map(invoice.map((l) => [l.order_line_id, { quantity: l.quantity, grossCents: l.line_total_cents }]));
  for (const note of already) {
    for (const c of note) {
      const r = out.get(c.order_line_id);
      const original = invoice.find((l) => l.order_line_id === c.order_line_id);
      if (!r || !original) continue;
      r.grossCents += c.line_total_cents;
      if (creditMode(c, original) === "quantity") r.quantity += c.quantity;
    }
  }
  return out;
}
