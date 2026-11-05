/**
 * The management dashboard (ops rules 34-38, R3, `/admin/dashboard/management`). Every figure is
 * deterministic SQL over the facts of the other modules, for the selected period and the one
 * before it (rule 34, Brussels periods from `periodRange`), tester persons excluded (rule 41).
 *
 * - Revenue and sales mix (rules 34, 35): the revenue report of ops-P3, unchanged.
 * - Customers (rule 36). An *activity* is a visit (an `attended` booking of a day or night
 *   session, or an imported `visit`) or a purchase (a paid order, or an imported `purchase`).
 *   `new` = first purchase in the period; `active` = an activity in the 90 days before the period
 *   end; `returning` = an activity in the period and one before it; `dormant` = last activity
 *   90 to 365 days before the period end; `reactivated` = an activity in the period more than 90
 *   days after the person's previous one.
 * - Retention (rule 37): repeat purchase rate = people with 2+ purchases before the period end /
 *   people with 1+; package completion = grants that became `exhausted` / grants that became
 *   `exhausted` or `expired` in the period (`status_changed_at`); reactivation rate =
 *   reactivated / dormant at the period start; membership renewal rate = membership periods
 *   ending in the period that were followed by a `renewal` or `late_payment` period / periods
 *   ending in the period.
 * - B2B (rule 38): pipeline and weighted value of open opportunities (not `won`, `lost`), the
 *   qualified (`qualified` to `negotiation`) and proposal counts as of now; conversion = won /
 *   (won + lost) closed in the period; B2B revenue = paid orders with `company_id`.
 */
import type { DbOrTx } from "@beam/db";
import { comparePeriods, periodRange, type Period } from "@beam/core/ops";
import { sql, type SQL } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
import type { OpsReadCtx, ReportFilters } from "../reports/registry";
import { brusselsDate, computeRevenueReport, parsePeriod, parseReportAt, parseVat, type Comparison, type RevenueReport, type VatMode } from "../reports/revenue";

export type Rate = { numerator: number; denominator: number; rate: number | null };
export type RateComparison = { current: Rate; previous: Rate };

export const CUSTOMER_TILES = ["new", "active", "returning", "dormant", "reactivated"] as const;
export type CustomerTile = (typeof CUSTOMER_TILES)[number];
export const RETENTION_TILES = ["repeat_purchase_rate", "package_completion", "reactivation_rate", "membership_renewal_rate"] as const;
export type RetentionTile = (typeof RETENTION_TILES)[number];

export type ManagementDashboard = {
  period: Period;
  vat: VatMode;
  /** Brussels dates, `to` exclusive. */
  range: { from: string; to: string; prevFrom: string; prevTo: string };
  revenue: RevenueReport;
  customers: Record<CustomerTile, Comparison>;
  retention: Record<RetentionTile, RateComparison>;
  b2b: {
    pipelineValueCents: number;
    weightedValueCents: number;
    openCount: number;
    qualifiedCount: number;
    proposalCount: number;
    conversion: RateComparison;
    revenueCents: Comparison;
  };
};

const DAY = 86_400_000;
const ts = (d: Date): SQL => sql`${d.toISOString()}::timestamptz`;
export const rate = (numerator: number, denominator: number): Rate => ({ numerator, denominator, rate: denominator > 0 ? numerator / denominator : null });

/** Every activity (visit or purchase) of a real person: `(person_id, at, is_purchase)`. */
const ACTIVITIES = sql`(
  select b.person_id, s.starts_at as at, false as is_purchase
    from bookings b join sessions s on s.id = b.session_id
    where b.status = 'attended' and s.kind in ('day', 'night') and b.person_id is not null
  union all
  select o.person_id, o.paid_at, true from orders o
    where o.status in ('paid', 'partially_refunded', 'refunded') and o.paid_at is not null and o.person_id is not null
  union all
  select ih.person_id, ih.occurred_at, ih.kind = 'purchase' from imported_history ih where ih.kind in ('visit', 'purchase')
)`;

const REAL = sql`exists (select 1 from persons pe where pe.id = a.person_id and pe.is_tester = false and pe.merged_into_person_id is null)`;

async function one<T extends Record<string, unknown>>(db: DbOrTx, q: SQL): Promise<T> {
  return rowsOf<T>(await db.execute(q))[0]!;
}

type CustomerCounts = Record<CustomerTile, number>;

/** Rule 36 for the half-open period `[from, to)`. */
export async function customerCounts(db: DbOrTx, from: Date, to: Date): Promise<CustomerCounts> {
  const r = await one<Record<string, string | number>>(
    db,
    sql`with a as (select a.person_id, a.at, a.is_purchase from ${ACTIVITIES} a where ${REAL} and a.at < ${ts(to)}),
      g as (select a.person_id, a.at, a.at - lag(a.at) over (partition by a.person_id order by a.at) as gap from a)
    select
      (select count(*) from (select person_id from a where is_purchase group by person_id
          having min(at) >= ${ts(from)}) x)::int as new,
      (select count(distinct person_id) from a where at >= ${ts(new Date(to.getTime() - 90 * DAY))})::int as active,
      (select count(*) from (select person_id from a group by person_id
          having bool_or(at >= ${ts(from)}) and bool_or(at < ${ts(from)})) x)::int as returning,
      (select count(*) from (select person_id from a group by person_id
          having max(at) >= ${ts(new Date(to.getTime() - 365 * DAY))} and max(at) <= ${ts(new Date(to.getTime() - 90 * DAY))}) x)::int as dormant,
      (select count(distinct person_id) from g where at >= ${ts(from)} and gap > interval '90 days')::int as reactivated`,
  );
  return { new: Number(r.new), active: Number(r.active), returning: Number(r.returning), dormant: Number(r.dormant), reactivated: Number(r.reactivated) };
}

/** Rule 37 for the half-open period `[from, to)`. */
export async function retentionRates(db: DbOrTx, from: Date, to: Date): Promise<Record<RetentionTile, Rate>> {
  const r = await one<Record<string, string | number>>(
    db,
    sql`with p as (select a.person_id, count(*) as n from ${ACTIVITIES} a where ${REAL} and a.is_purchase and a.at < ${ts(to)} group by a.person_id)
    select
      (select count(*) from p where n >= 2)::int as repeaters,
      (select count(*) from p)::int as customers,
      (select count(*) from credit_grants g join persons pe on pe.id = g.person_id
         where pe.is_tester = false and g.status = 'exhausted' and g.status_changed_at >= ${ts(from)} and g.status_changed_at < ${ts(to)})::int as exhausted,
      (select count(*) from credit_grants g join persons pe on pe.id = g.person_id
         where pe.is_tester = false and g.status in ('exhausted', 'expired') and g.status_changed_at >= ${ts(from)} and g.status_changed_at < ${ts(to)})::int as finished,
      (select count(*) from membership_periods mp join persons pe on pe.id = mp.person_id
         where pe.is_tester = false and mp.period_end_at >= ${ts(from)} and mp.period_end_at < ${ts(to)})::int as renewals_due,
      (select count(*) from membership_periods mp join persons pe on pe.id = mp.person_id
         where pe.is_tester = false and mp.period_end_at >= ${ts(from)} and mp.period_end_at < ${ts(to)}
           and exists (select 1 from membership_periods nx where nx.membership_id = mp.membership_id and nx.id <> mp.id
                         and nx.source in ('renewal', 'late_payment') and nx.period_start_at >= mp.period_end_at - interval '1 day'
                         and nx.period_start_at <= mp.period_end_at + interval '35 days'))::int as renewals_paid`,
  );
  const [reactivated, dormantAtStart] = await Promise.all([customerCounts(db, from, to), customerCounts(db, new Date(from.getTime() - DAY), from)]);
  return {
    repeat_purchase_rate: rate(Number(r.repeaters), Number(r.customers)),
    package_completion: rate(Number(r.exhausted), Number(r.finished)),
    reactivation_rate: rate(reactivated.reactivated, dormantAtStart.dormant),
    membership_renewal_rate: rate(Number(r.renewals_paid), Number(r.renewals_due)),
  };
}

/** Rule 38: the pipeline as of now, and conversion and B2B revenue of `[from, to)`. */
export async function b2bFigures(db: DbOrTx, from: Date, to: Date): Promise<{ pipelineValueCents: number; weightedValueCents: number; openCount: number; qualifiedCount: number; proposalCount: number; won: number; lost: number; revenueCents: number }> {
  const r = await one<Record<string, string | number>>(
    db,
    sql`select
      coalesce(sum(value_cents) filter (where stage not in ('won', 'lost')), 0)::bigint as pipeline,
      coalesce(round(sum(value_cents * probability_pct / 100.0) filter (where stage not in ('won', 'lost'))), 0)::bigint as weighted,
      count(*) filter (where stage not in ('won', 'lost'))::int as open,
      count(*) filter (where stage in ('qualified', 'discovery', 'proposal', 'negotiation'))::int as qualified,
      count(*) filter (where stage = 'proposal')::int as proposals,
      count(*) filter (where stage = 'won' and won_at >= ${ts(from)} and won_at < ${ts(to)})::int as won,
      count(*) filter (where stage = 'lost' and lost_at >= ${ts(from)} and lost_at < ${ts(to)})::int as lost,
      (select coalesce(sum(o.total_cents), 0) from orders o
         where o.company_id is not null and o.status in ('paid', 'partially_refunded', 'refunded')
           and o.paid_at >= ${ts(from)} and o.paid_at < ${ts(to)})::bigint as revenue
    from opportunities`,
  );
  return {
    pipelineValueCents: Number(r.pipeline),
    weightedValueCents: Number(r.weighted),
    openCount: Number(r.open),
    qualifiedCount: Number(r.qualified),
    proposalCount: Number(r.proposals),
    won: Number(r.won),
    lost: Number(r.lost),
    revenueCents: Number(r.revenue),
  };
}

/** Rules 34-38 for `period` around `at`. */
export async function computeManagementDashboard(db: DbOrTx, input: { period: Period; at: Date; vat?: VatMode }): Promise<ManagementDashboard> {
  const vat = input.vat ?? "incl";
  const r = periodRange(input.period, input.at);
  const revenue = await computeRevenueReport(db, { period: input.period, at: input.at, vat });
  const [cur, prev] = [await customerCounts(db, r.from, r.to), await customerCounts(db, r.prevFrom, r.prevTo)];
  const [retCur, retPrev] = [await retentionRates(db, r.from, r.to), await retentionRates(db, r.prevFrom, r.prevTo)];
  const [b2b, b2bPrev] = [await b2bFigures(db, r.from, r.to), await b2bFigures(db, r.prevFrom, r.prevTo)];
  const customers = Object.fromEntries(CUSTOMER_TILES.map((k) => [k, comparePeriods(cur[k], prev[k])])) as Record<CustomerTile, Comparison>;
  const retention = Object.fromEntries(RETENTION_TILES.map((k) => [k, { current: retCur[k], previous: retPrev[k] }])) as Record<RetentionTile, RateComparison>;
  return {
    period: input.period,
    vat,
    range: { from: brusselsDate(r.from), to: brusselsDate(r.to), prevFrom: brusselsDate(r.prevFrom), prevTo: brusselsDate(r.prevTo) },
    revenue,
    customers,
    retention,
    b2b: {
      pipelineValueCents: b2b.pipelineValueCents,
      weightedValueCents: b2b.weightedValueCents,
      openCount: b2b.openCount,
      qualifiedCount: b2b.qualifiedCount,
      proposalCount: b2b.proposalCount,
      conversion: { current: rate(b2b.won, b2b.won + b2b.lost), previous: rate(b2bPrev.won, b2bPrev.won + b2bPrev.lost) },
      revenueCents: comparePeriods(b2b.revenueCents, b2bPrev.revenueCents),
    },
  };
}

/** CSV columns of the management dashboard: one row per tile. */
export const MANAGEMENT_CSV_COLUMNS = ["group", "tile", "current", "previous", "change", "change_pct"] as const;

export function managementCsvRowsOf(d: ManagementDashboard): unknown[][] {
  const out: unknown[][] = [];
  const cmp = (group: string, tile: string, c: Comparison) => out.push([group, tile, c.current, c.previous, c.change, c.changePct]);
  const rt = (group: string, tile: string, c: RateComparison) =>
    out.push([group, tile, c.current.rate === null ? "" : c.current.rate.toFixed(4), c.previous.rate === null ? "" : c.previous.rate.toFixed(4), "", ""]);
  cmp("revenue", "net_cents", d.revenue.net);
  cmp("revenue", "orders", d.revenue.orders);
  for (const k of d.revenue.byKind) out.push(["sales_mix_kind", k.kind, k.amountCents, "", "", ""]);
  for (const c of d.revenue.byChannel) out.push(["sales_mix_channel", c.channel, c.amountCents, "", "", ""]);
  for (const k of CUSTOMER_TILES) cmp("customers", k, d.customers[k]);
  for (const k of RETENTION_TILES) rt("retention", k, d.retention[k]);
  out.push(["b2b", "pipeline_value_cents", d.b2b.pipelineValueCents, "", "", ""]);
  out.push(["b2b", "weighted_value_cents", d.b2b.weightedValueCents, "", "", ""]);
  out.push(["b2b", "qualified", d.b2b.qualifiedCount, "", "", ""]);
  out.push(["b2b", "proposals", d.b2b.proposalCount, "", "", ""]);
  rt("b2b", "conversion", d.b2b.conversion);
  cmp("b2b", "revenue_cents", d.b2b.revenueCents);
  return out;
}

/** `/admin/reports/management/csv?period=&at=&vat=`: every tile of the dashboard. */
export async function* managementCsvRows(ctx: OpsReadCtx, filters: ReportFilters): AsyncIterable<unknown[]> {
  const d = await computeManagementDashboard(ctx.tx, { period: parsePeriod(filters.period, "month"), at: parseReportAt(filters.at, ctx.now), vat: parseVat(filters.vat) });
  for (const row of managementCsvRowsOf(d)) yield row;
}
