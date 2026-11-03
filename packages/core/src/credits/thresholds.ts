/**
 * Package usage thresholds (credits rules 21 to 23, decision 19, edge cases 15 and 16). Pure:
 * the ledger computes the inputs under the grant lock and records one event per result with
 * the dedupe key below, so a threshold fires once per grant whatever happens later.
 */

export type ThresholdHit = number | "last_unit" | "exhausted";

/** `settings.credits.threshold_pcts` default. */
export const DEFAULT_THRESHOLD_PCTS: readonly number[] = [50, 75, 80, 90];

/** Grant sources that trigger package thresholds (rule 23); inclusions, bonuses and rewards do not. */
export const THRESHOLD_SOURCES = ["purchase", "import", "transfer"] as const;

export function firesThresholds(source: string): boolean {
  return (THRESHOLD_SOURCES as readonly string[]).includes(source);
}

const pctUsed = (used: number, base: number) => Math.floor((used * 100) / base);

/**
 * The thresholds crossed by one consume: each `pct` with `floor(usedBefore*100/base) < pct <=
 * floor(usedAfter*100/base)` (several at once each appear once, ascending), then `last_unit` when
 * `remainingAfter` is exactly 1 and `exhausted` when it is 0. A write that does not increase
 * `used` (a release, a positive adjustment) returns nothing: a release never un-fires or re-fires.
 * `base` is `base_units` (`data.original_units` for imports, else `units_granted`).
 */
export function crossedThresholds(i: {
  base: number;
  usedBefore: number;
  usedAfter: number;
  remainingAfter: number;
  pcts: number[];
}): ThresholdHit[] {
  if (!(i.usedAfter > i.usedBefore)) return [];
  const hits: ThresholdHit[] = [];
  if (i.base > 0) {
    const before = pctUsed(i.usedBefore, i.base);
    const after = pctUsed(i.usedAfter, i.base);
    const pcts = [...new Set(i.pcts)].filter((p) => Number.isInteger(p) && p > 0 && p <= 100).sort((a, b) => a - b);
    for (const p of pcts) if (before < p && p <= after) hits.push(p);
  }
  if (i.remainingAfter === 1) hits.push("last_unit");
  if (i.remainingAfter === 0) hits.push("exhausted");
  return hits;
}

/**
 * The threshold base of a grant and the units used before the ledger began: an imported grant
 * of 4 remaining out of an original 10 has base 10 and 6 units already used, so the ledger's
 * `used_units` is offset by 6. Positive adjustments never change the base (decision 19).
 */
export function thresholdBase(i: { unitsGranted: number; originalUnits?: number | null }): { base: number; usedOffset: number } {
  const original = i.originalUnits ?? null;
  if (original === null || original < i.unitsGranted) return { base: i.unitsGranted, usedOffset: 0 };
  return { base: original, usedOffset: original - i.unitsGranted };
}

/** `grant:<id>:threshold:<pct|last_unit>` or `grant:<id>:exhausted` (rules 21, 22). */
export function thresholdDedupeKey(grantId: string, hit: ThresholdHit): string {
  return hit === "exhausted" ? `grant:${grantId}:exhausted` : `grant:${grantId}:threshold:${hit}`;
}
