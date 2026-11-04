/**
 * VAT and rounding (commerce rules 10 and 11). Prices are VAT included; the VAT of a line is
 * `round_half_up(line_total * rate / (100 + rate))` and order totals are sums of lines.
 * Everything is integer arithmetic, so no float drift reaches a cent.
 */

/** `round_half_up(numerator / denominator)` for integers; halves round away from zero. */
export function divRoundHalfUp(numerator: number, denominator: number): number {
  if (!Number.isInteger(numerator) || !Number.isInteger(denominator) || denominator === 0) {
    throw new RangeError(`divRoundHalfUp: integers expected, got ${numerator}/${denominator}`);
  }
  const negative = numerator < 0 !== denominator < 0;
  const n = Math.abs(numerator);
  const d = Math.abs(denominator);
  const q = Math.floor((2 * n + d) / (2 * d));
  return negative ? -q : q;
}

/** A percentage or rate with at most two decimals (`numeric(4,2)`, `numeric(5,2)`) in hundredths. */
export function toHundredths(pct: number | string): number {
  const value = typeof pct === "string" ? Number(pct) : pct;
  if (!Number.isFinite(value)) throw new RangeError(`not a number: ${String(pct)}`);
  return Math.round(value * 100);
}

/** `round_half_up(cents * pct / 100)`, the per-unit amount of a percentage (rule 10). */
export function percentOf(cents: number, pct: number | string): number {
  return divRoundHalfUp(cents * toHundredths(pct), 10_000);
}

/** VAT contained in a VAT-inclusive line total (rule 11). */
export function vatOf(lineTotalCents: number, ratePct: number | string): number {
  const rate = toHundredths(ratePct);
  if (rate === 0) return 0;
  return divRoundHalfUp(lineTotalCents * rate, 10_000 + rate);
}

/** Order VAT: the sum of the line VAT, never VAT of the sum. */
export function sumVat(lines: ReadonlyArray<{ lineTotalCents: number; vatRatePct: number | string }>): number {
  return lines.reduce((sum, l) => sum + vatOf(l.lineTotalCents, l.vatRatePct), 0);
}
