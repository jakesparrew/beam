/**
 * The legal retention horizon of accounting documents (finance rule 45, section 9,
 * cross-module D34). The `finance.invoices` policy (ops' seed: 3653 days, `anonymise`) is
 * counted from 1 January after the fiscal year of the document: a document of fiscal year Y
 * may be swept once `1 January (Y + 1) + days <= today`. No sweep, for either action, ever
 * touches a document younger than `LEGAL_MIN_RETENTION_DAYS` (ten years, the Belgian law of
 * 20 November 2022): a policy edited below that is applied at the legal floor instead, and the
 * sweep logs `skipped_legal_floor`.
 */
import { brusselsDateOf } from "./numbering";

export const LEGAL_MIN_RETENTION_YEARS = 10;
/** Ten years in days, counted from a 1 January: 3653 (two or three leap days, never fewer than two). */
export const LEGAL_MIN_RETENTION_DAYS = 3653;

const DAY_MS = 86_400_000;
const isoDay = /^\d{4}-\d{2}-\d{2}$/;

function utcDay(iso: string): number {
  if (!isoDay.test(iso)) throw new RangeError(`retention: YYYY-MM-DD expected, got ${iso}`);
  const t = Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== iso) throw new RangeError(`retention: invalid date ${iso}`);
  return t;
}

/** The days actually applied: the policy's, never below the legal floor. */
export function effectiveRetentionDays(days: number): number {
  if (!Number.isInteger(days) || days < 0) throw new RangeError(`retention: days must be a non-negative integer, got ${days}`);
  return Math.max(days, LEGAL_MIN_RETENTION_DAYS);
}

/** True when the policy is below the legal floor (the sweep logs `skipped_legal_floor`). */
export function isBelowLegalFloor(days: number): boolean {
  return days < LEGAL_MIN_RETENTION_DAYS;
}

/** The first day (`YYYY-MM-DD`) on which documents of `fiscalYear` may be swept under `days`. */
export function retentionHorizon(fiscalYear: number, days: number): string {
  const start = Date.UTC(fiscalYear + 1, 0, 1);
  return new Date(start + effectiveRetentionDays(days) * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The latest fiscal year whose documents the sweep may touch on `today` (Brussels `YYYY-MM-DD`)
 * under a policy of `days` with `action`: every fiscal year up to and including the result is
 * past its horizon. The legal floor applies to `anonymise` and `delete` alike.
 */
export function retentionCutoffYear(today: string, days: number, action: "anonymise" | "delete"): number {
  if (action !== "anonymise" && action !== "delete") throw new RangeError(`retention: unknown action ${String(action)}`);
  const cutoff = new Date(utcDay(today) - effectiveRetentionDays(days) * DAY_MS);
  return cutoff.getUTCFullYear() - 1;
}

/**
 * For a sweep handler called with ops' `cutoff = now - days`: the latest fiscal year to touch,
 * which is never younger than the legal floor allows at `now`.
 */
export function sweepableFiscalYear(cutoff: Date, now: Date): number {
  const fromPolicy = Number(brusselsDateOf(cutoff).slice(0, 4)) - 1;
  return Math.min(fromPolicy, retentionCutoffYear(brusselsDateOf(now), LEGAL_MIN_RETENTION_DAYS, "anonymise"));
}
