/**
 * Document numbers (finance rules 9 to 12): `BEAM-<yyyy>-<NNNNNN>` for invoices and
 * `CN-<yyyy>-<NNNNNN>` for credit notes, per kind and fiscal year, six digits from 000001.
 * The fiscal year is the calendar year of the issue date in Europe/Brussels, so an invoice
 * issued at 2026-12-31T23:30Z is `BEAM-2027-000001`.
 */
import { TIME_ZONE } from "../i18n/locales";
import type { InvoiceKind } from "./types";

export const NUMBER_PREFIX: Readonly<Record<InvoiceKind, string>> = { invoice: "BEAM", credit_note: "CN" };

/** The sequence table accepts these years (`chk_invoice_sequences_year`). */
export const FIRST_FISCAL_YEAR = 2026;
export const LAST_FISCAL_YEAR = 2100;
export const MAX_SEQUENCE_NUMBER = 999_999;

/** The only number formatter. */
export function formatNumber(kind: InvoiceKind, year: number, n: number): string {
  if (!Number.isInteger(year) || year < 1000 || year > 9999) throw new RangeError(`formatNumber: bad year ${year}`);
  if (!Number.isInteger(n) || n < 1 || n > MAX_SEQUENCE_NUMBER) throw new RangeError(`formatNumber: bad sequence number ${n}`);
  return `${NUMBER_PREFIX[kind]}-${year}-${String(n).padStart(6, "0")}`;
}

/** `BEAM-2026-000123` -> `{ kind: 'invoice', year: 2026, n: 123 }`; anything else -> `null`. */
export function parseNumber(number: string): { kind: InvoiceKind; year: number; n: number } | null {
  const m = /^(BEAM|CN)-(\d{4})-(\d{6})$/.exec(number);
  if (!m) return null;
  const n = Number(m[3]);
  if (n < 1) return null;
  return { kind: m[1] === "BEAM" ? "invoice" : "credit_note", year: Number(m[2]), n };
}

const brusselsDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** The Brussels calendar date of an instant, `YYYY-MM-DD` (`issued_on`). */
export function brusselsDateOf(at: Date): string {
  if (Number.isNaN(at.getTime())) throw new RangeError("brusselsDateOf: invalid date");
  const parts = Object.fromEntries(brusselsDate.formatToParts(at).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** The fiscal year of a document issued at `at`: its Brussels calendar year. */
export function fiscalYearOf(at: Date): number {
  return Number(brusselsDateOf(at).slice(0, 4));
}
