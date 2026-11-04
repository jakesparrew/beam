/**
 * Accountant CSV format (finance spec rule 42, finance-P7): `;` separator, UTF-8 with a BOM,
 * RFC 4180 quoting, CRLF line ends, one header row, amounts in euros with a dot and two
 * decimals, ISO dates. `EXPORT_COLUMNS` fixes the header of every export kind; the three
 * Release 3 kinds are filled by finance-P9.
 *
 * Text cells that a spreadsheet would read as a formula (`=`, `+`, `@`, a tab or a carriage
 * return first, or `-` not followed by a number) get a leading apostrophe: customer names are
 * user input and the accountant opens the file in a spreadsheet.
 */
import type { FinanceExportKind } from "./types";

export type CsvCell = string | number | null;

/** The UTF-8 byte order mark that makes spreadsheets read the file as UTF-8. */
export const CSV_BOM = "﻿";
export const CSV_SEPARATOR = ";";
export const CSV_EOL = "\r\n";

const NEEDS_QUOTES = /[;"\r\n]/;
const FORMULA_START = /^[=+@\t\r]/;
const NUMERIC = /^-?\d+(\.\d+)?$/;

/** A text cell made safe against spreadsheet formula injection. */
function neutralise(value: string): string {
  if (FORMULA_START.test(value)) return `'${value}`;
  if (value.startsWith("-") && !NUMERIC.test(value)) return `'${value}`;
  return value;
}

/** One cell: `null` is empty, numbers are written plainly (dot decimals), text is quoted when needed. */
export function csvCell(value: CsvCell): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RangeError(`csv: not a finite number: ${value}`);
    return String(value);
  }
  const text = neutralise(value);
  return NEEDS_QUOTES.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** One record with its line end. */
export function csvLine(cells: readonly CsvCell[]): string {
  return cells.map(csvCell).join(CSV_SEPARATOR) + CSV_EOL;
}

/** A whole file: BOM, the header row, then one line per row. */
export function toCsv(header: string[], rows: Iterable<CsvCell[]>): string {
  let out = CSV_BOM + csvLine(header);
  for (const row of rows) {
    if (row.length !== header.length) throw new RangeError(`csv: row has ${row.length} cells, header has ${header.length}`);
    out += csvLine(row);
  }
  return out;
}

/** Integer cents as euros with a dot and two decimals (`-1234` -> `"-12.34"`). */
export function centsToEuros(cents: number): string {
  if (!Number.isInteger(cents)) throw new RangeError(`csv: cents must be an integer: ${cents}`);
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** A VAT rate as written in the files (`21`, `6`, `0`; `5.5` would stay `5.5`). */
export function vatRateCell(rate: number | string): string {
  const n = typeof rate === "number" ? rate : Number(rate);
  if (!Number.isFinite(n)) throw new RangeError(`csv: invalid VAT rate: ${rate}`);
  return String(Number(n.toFixed(2)));
}

/** A boolean as `true` / `false`. */
export const boolCell = (value: boolean): string => (value ? "true" : "false");

/** The header row of each export kind (finance-P7 interfaces). */
export const EXPORT_COLUMNS: Record<FinanceExportKind, string[]> = {
  invoices: [
    "number",
    "kind",
    "issued_on",
    "due_on",
    "status",
    "customer_name",
    "customer_vat",
    "is_company",
    "net",
    "vat",
    "total",
    "payment_method",
    "payment_reference",
    "reverses_number",
    "billit_id",
  ],
  invoice_lines: ["number", "line_no", "sku", "category", "description", "quantity", "unit_incl", "discount", "vat_rate", "net", "vat", "gross"],
  vat_summary: ["month", "vat_rate", "kind", "net", "vat", "gross"],
  payments: ["paid_on", "provider", "method", "provider_payment_id", "order_id", "invoice_number", "amount"],
  deferred_revenue: ["as_of", "credit_kind", "vat_treatment", "vat_rate", "units", "gross", "net", "vat"],
  breakage: ["month", "credit_kind", "vat_rate", "recognised_gross", "breakage_gross", "breakage_net", "breakage_vat", "revoked_gross"],
  voucher_redemptions: ["redeemed_on", "order_id", "invoice_number", "amount", "is_reversed"],
};

/** The export kinds of Release 1 (rule 42); the other three come with finance-P9. */
export const V1_EXPORT_KINDS = ["invoices", "invoice_lines", "vat_summary", "payments"] as const satisfies readonly FinanceExportKind[];

/** The file name of an export: `beam-<kind>-<from>-<to>.csv`. */
export const exportFileName = (kind: FinanceExportKind, from: string, to: string): string => `beam-${kind.replace(/_/g, "-")}-${from}-${to}.csv`;
