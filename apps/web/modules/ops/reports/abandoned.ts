/**
 * The abandoned checkout report (ops rule 40, ops-P7, R2) over `v_abandoned_checkouts`, for
 * checkouts abandoned in the selected Brussels dates. Tester persons are left out (rule 41);
 * guest checkouts (no person) count.
 *
 * Figures: abandoned count, recovered count (a paid `recovered_order_id`, i.e. the view's
 * `recovered_revenue_cents` is set), recovery rate `recovered / abandoned`, recovery revenue
 * (sum of `recovered_revenue_cents`) and the failure share (`had_payment_failure / abandoned`).
 * The table lists the checkouts with item count, value, products, the recovery message status
 * and the outcome; never the checkout's email address.
 */
import type { DbOrTx } from "@beam/db";
import { sql } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
import { inRange, parseDateRange, type DateRange } from "./no-shows";
import type { OpsReadCtx, ReportFilters } from "./registry";

export type AbandonedOutcome = "recovered" | "open";

export type AbandonedCheckoutRow = {
  checkoutId: string;
  personId: string | null;
  name: string | null;
  abandonedAt: Date;
  abandonedReason: "left" | "payment_failed" | "payment_expired" | null;
  itemCount: number;
  valueCents: number | null;
  productIds: string[];
  hadPaymentFailure: boolean;
  /** `email_messages.status` of the recovery message, null when none was sent. */
  recoveryStatus: string | null;
  recoveredOrderId: string | null;
  recoveredRevenueCents: number | null;
  outcome: AbandonedOutcome;
};

export type AbandonedReport = {
  range: DateRange;
  abandoned: number;
  recovered: number;
  /** `recovered / abandoned`, null when nothing was abandoned. */
  recoveryRate: number | null;
  recoveryRevenueCents: number;
  /** Abandoned value (`checkouts.total_cents`). */
  abandonedValueCents: number;
  paymentFailures: number;
  failureShare: number | null;
  rows: AbandonedCheckoutRow[];
};

/** The checkouts shown on the page (and in its CSV), latest abandoned first. */
export const ABANDONED_ROWS = 200;

const ratio = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 1000 : null);
const num = (v: unknown) => Number(v ?? 0);
const uuids = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.replace(/^\{|\}$/g, "").split(",").filter(Boolean) : []);

/** Rule 40 over the checkouts abandoned in `range`. */
export async function computeAbandonedReport(db: DbOrTx, input: { range: DateRange }): Promise<AbandonedReport> {
  const { range } = input;
  const base = sql`v_abandoned_checkouts ac left join persons pe on pe.id = ac.person_id
    where coalesce(pe.is_tester, false) = false and ${inRange(sql`ac.abandoned_at`, range)}`;
  const [t] = rowsOf<Record<string, unknown>>(
    await db.execute(sql`select count(*)::int as abandoned,
        count(*) filter (where ac.recovered_revenue_cents is not null)::int as recovered,
        coalesce(sum(ac.recovered_revenue_cents), 0)::int as recovery_revenue,
        coalesce(sum(ac.value_cents), 0)::int as abandoned_value,
        count(*) filter (where ac.had_payment_failure)::int as failures
      from ${base}`),
  );
  const rows = rowsOf<Record<string, unknown>>(
    await db.execute(sql`select ac.checkout_id, ac.person_id, ac.abandoned_at, ac.abandoned_reason, ac.item_count, ac.value_cents, ac.product_ids,
        ac.had_payment_failure, em.status::text as recovery_status, ac.recovered_order_id, ac.recovered_revenue_cents,
        nullif(trim(concat_ws(' ', pe.first_name, pe.last_name)), '') as name
      from v_abandoned_checkouts ac left join persons pe on pe.id = ac.person_id
      left join email_messages em on em.id = ac.recovery_message_id
      where coalesce(pe.is_tester, false) = false and ${inRange(sql`ac.abandoned_at`, range)}
      order by ac.abandoned_at desc, ac.checkout_id limit ${ABANDONED_ROWS}`),
  );
  const abandoned = num(t?.abandoned);
  const recovered = num(t?.recovered);
  const failures = num(t?.failures);
  return {
    range,
    abandoned,
    recovered,
    recoveryRate: ratio(recovered, abandoned),
    recoveryRevenueCents: num(t?.recovery_revenue),
    abandonedValueCents: num(t?.abandoned_value),
    paymentFailures: failures,
    failureShare: ratio(failures, abandoned),
    rows: rows.map((r) => ({
      checkoutId: String(r.checkout_id),
      personId: (r.person_id as string | null) ?? null,
      name: (r.name as string | null) ?? null,
      abandonedAt: new Date(r.abandoned_at as string),
      abandonedReason: (r.abandoned_reason as AbandonedCheckoutRow["abandonedReason"]) ?? null,
      itemCount: num(r.item_count),
      valueCents: r.value_cents === null || r.value_cents === undefined ? null : num(r.value_cents),
      productIds: uuids(r.product_ids),
      hadPaymentFailure: r.had_payment_failure === true || r.had_payment_failure === "t",
      recoveryStatus: (r.recovery_status as string | null) ?? null,
      recoveredOrderId: (r.recovered_order_id as string | null) ?? null,
      recoveredRevenueCents: r.recovered_revenue_cents === null || r.recovered_revenue_cents === undefined ? null : num(r.recovered_revenue_cents),
      outcome: r.recovered_revenue_cents === null || r.recovered_revenue_cents === undefined ? "open" : "recovered",
    })),
  };
}

export const ABANDONED_CSV_COLUMNS = [
  "checkout_id",
  "person_id",
  "abandoned_at",
  "abandoned_reason",
  "item_count",
  "value_cents",
  "had_payment_failure",
  "recovery_status",
  "recovered_order_id",
  "recovered_revenue_cents",
  "outcome",
] as const;

/** The checkout table of the page, with the page's `from` and `to`. */
export async function* abandonedCsvRows(ctx: OpsReadCtx, filters: ReportFilters): AsyncIterable<unknown[]> {
  const report = await computeAbandonedReport(ctx.tx, { range: parseDateRange(filters, ctx.now) });
  for (const r of report.rows) {
    yield [
      r.checkoutId,
      r.personId ?? "",
      r.abandonedAt.toISOString(),
      r.abandonedReason ?? "",
      r.itemCount,
      r.valueCents ?? "",
      r.hadPaymentFailure,
      r.recoveryStatus ?? "",
      r.recoveredOrderId ?? "",
      r.recoveredRevenueCents ?? "",
      r.outcome,
    ];
  }
}
