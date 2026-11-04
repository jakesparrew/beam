/**
 * VAT per line and the VAT breakdown (finance rule 6). The arithmetic is commerce's own
 * (`vatOf` in `../commerce/vat`), so an invoice line carries exactly the VAT of its order line:
 * `vat_cents = round_half_up(line_total_cents * rate / (100 + rate))`, halves away from zero, and
 * `net_cents = line_total_cents - vat_cents`. Credit-note lines are negative and round
 * symmetrically.
 */
import { vatOf } from "../commerce/vat";
import { FinanceValidationError, VAT_RATES, type InvoiceLine, type VatBreakdownRow, type VatRatePct } from "./types";

/** True for 0, 6, 12 and 21 (also `"21.00"` from a `numeric(4,2)` column). */
export function isVatRate(value: unknown): value is VatRatePct {
  return (VAT_RATES as readonly number[]).includes(Number(value)) && value !== "" && value !== null;
}

/** `"21.00"` -> `21`; anything that is not one of the four rates throws `validation`. */
export function toVatRate(value: number | string): VatRatePct {
  const n = typeof value === "string" ? Number(value) : value;
  if (!isVatRate(n)) throw new FinanceValidationError("finance.errors.invalid_vat_rate", { rate: String(value) });
  return n;
}

/** VAT and net amount contained in a VAT-inclusive (gross) line total. */
export function computeLineVat(lineTotalCents: number, ratePct: 0 | 6 | 12 | 21): { vatCents: number; netCents: number } {
  if (!Number.isInteger(lineTotalCents)) throw new RangeError(`computeLineVat: integer cents expected, got ${lineTotalCents}`);
  const rate = toVatRate(ratePct);
  const vatCents = vatOf(lineTotalCents, rate);
  return { vatCents, netCents: lineTotalCents - vatCents };
}

/** Lines grouped by rate, rates ascending, sums of the line values (never recomputed from totals). */
export function buildVatBreakdown(lines: InvoiceLine[]): VatBreakdownRow[] {
  const byRate = new Map<VatRatePct, VatBreakdownRow>();
  for (const line of lines) {
    const rate = toVatRate(line.vat_rate_pct);
    const row = byRate.get(rate) ?? { vat_rate_pct: rate, net_cents: 0, vat_cents: 0, gross_cents: 0 };
    row.net_cents += line.net_cents;
    row.vat_cents += line.vat_cents;
    row.gross_cents += line.line_total_cents;
    byRate.set(rate, row);
  }
  return [...byRate.values()].sort((a, b) => a.vat_rate_pct - b.vat_rate_pct);
}

/** Document totals from its lines: `subtotal` (net), `vat` and `total` (gross). */
export function documentTotals(lines: InvoiceLine[]): { subtotalCents: number; vatCents: number; totalCents: number } {
  let subtotalCents = 0;
  let vatCents = 0;
  let totalCents = 0;
  for (const l of lines) {
    subtotalCents += l.net_cents;
    vatCents += l.vat_cents;
    totalCents += l.line_total_cents;
  }
  return { subtotalCents, vatCents, totalCents };
}
