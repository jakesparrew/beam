/**
 * Prepaid credits outstanding (ops rule 35a, ops-P3): what BEAM still owes in day sessions,
 * nights and euro credit, per credit kind, VAT treatment and rate. Today's figures are credits'
 * `v_credit_liability`; a past date is credits' `getCreditLiabilityAsOf(db, at)`. ops computes
 * nothing itself: both sources are credits' one definition.
 */
import type { DbOrTx } from "@beam/db";
import { vCreditLiability } from "@beam/db/schema";
import { asc } from "@/lib/ctx";
import { getCreditLiabilityAsOf } from "@/modules/credits/api";
import type { OpsReadCtx, ReportFilters } from "./registry";
import { brusselsDate, parseReportAt } from "./revenue";

export type CreditKind = "day" | "night" | "euro";

export type LiabilityRow = { kind: CreditKind; vatTreatment: string; vatRatePct: number | null; remainingUnits: number; remainingValueCents: number };

export type CreditLiability = {
  /** `today` reads the view; `as_of` reads credits' ledger at `asOf`. */
  source: "today" | "as_of";
  asOf: Date;
  rows: LiabilityRow[];
  totalValueCents: number;
};

/**
 * Today's view when `at` is missing or falls on or after today's Brussels date (a period that
 * has not ended yet); otherwise the ledger as of `at`.
 */
export async function computeCreditLiability(db: DbOrTx, input: { at?: Date; now: Date }): Promise<CreditLiability> {
  const past = input.at !== undefined && brusselsDate(input.at) < brusselsDate(input.now) && input.at < input.now;
  let rows: LiabilityRow[];
  if (past) {
    rows = await getCreditLiabilityAsOf(db, input.at!);
  } else {
    const view = await db
      .select({
        kind: vCreditLiability.creditKind,
        vatTreatment: vCreditLiability.vatTreatment,
        vatRatePct: vCreditLiability.vatRatePct,
        remainingUnits: vCreditLiability.remainingUnits,
        remainingValueCents: vCreditLiability.remainingValueCents,
      })
      .from(vCreditLiability)
      .orderBy(asc(vCreditLiability.creditKind), asc(vCreditLiability.vatTreatment), asc(vCreditLiability.vatRatePct));
    rows = view.map((r) => ({
      kind: r.kind,
      vatTreatment: String(r.vatTreatment),
      vatRatePct: r.vatRatePct === null ? null : Number(r.vatRatePct),
      remainingUnits: Number(r.remainingUnits),
      remainingValueCents: Number(r.remainingValueCents),
    }));
  }
  return {
    source: past ? "as_of" : "today",
    asOf: past ? input.at! : input.now,
    rows,
    totalValueCents: rows.reduce((a, r) => a + r.remainingValueCents, 0),
  };
}

/**
 * The end of a report period as the liability date: the instant just before `to` when the
 * period is over, else undefined (today's view).
 */
export function liabilityDateFor(periodTo: Date, now: Date): Date | undefined {
  return periodTo <= now ? new Date(periodTo.getTime() - 1) : undefined;
}

export const LIABILITY_CSV_COLUMNS = ["as_of", "credit_kind", "vat_treatment", "vat_rate_pct", "remaining_units", "remaining_value_cents"] as const;

/** `?at=YYYY-MM-DD` (end of that Brussels day) or today. */
export async function* liabilityCsvRows(ctx: OpsReadCtx, filters: ReportFilters): AsyncIterable<unknown[]> {
  const at = filters.at ? parseReportAt(filters.at, ctx.now) : undefined;
  const result = await computeCreditLiability(ctx.tx, { at, now: ctx.now });
  const asOf = brusselsDate(result.asOf);
  for (const r of result.rows) yield [asOf, r.kind, r.vatTreatment, r.vatRatePct, r.remainingUnits, r.remainingValueCents];
}
