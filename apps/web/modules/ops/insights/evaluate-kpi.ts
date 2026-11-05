/**
 * `evaluateKpi` (ops spec 4.2, rule 79, R4): one value of a `KPI_REGISTRY` key for a custom
 * dashboard widget, for a rule 34 period around `at` and, with `compare`, the previous period.
 * Never free SQL: each key maps to one of the figures below.
 *
 * - Revenue (rules 34, 35): ops-P3's revenue report (net, sales, refunds, orders; VAT included),
 *   the sales mix by product kind and by channel, and a daily series for `line` widgets.
 * - Customers (rule 36): the management dashboard's definitions, computed here so a widget can
 *   be restricted to a crm segment (`segment_members`); without a segment the figures equal
 *   ops-P8's `customerCounts`.
 * - Retention (rule 37) and B2B (rule 38): ops-P8's `retentionRates` and `b2bFigures`; the
 *   pipeline figures are "as of now" (snapshots without comparison).
 * - Marketing (rule 75): ops-P8's `computeMarketingKpiSet` for the period's Brussels dates.
 * - Lists: `v_retention_candidates` and `v_opportunity_candidates` per reason, now.
 * - Finance: finance-P10's `getFinanceKpis` (`reports.finance`).
 * - Forms (forms-P10): `loadFormsDashboardSource` of forms' api for the period's Brussels days
 *   (aggregates of the non-sensitive `ai` views only). `forms.funnel` is the completed
 *   submissions with the funnel stages as rows and a daily series; `forms.outcomes` the completed
 *   submissions per outcome; `forms.conversion` the bookings within 30 days with the linked,
 *   booked and purchased counts as rows and a daily series.
 *
 * The heavy report functions are evaluated once per context and range: a dashboard evaluates
 * all its widgets with one context, so ten marketing widgets cost one marketing computation.
 */
import {
  FINANCE_KPI_BY_DASHBOARD_KEY,
  type FinanceDashboardKpiKey,
  FORMS_KPI_KEYS,
  type FormsDashboardKpiKey,
  isKpiKey,
  KPI_REGISTRY,
  kpiChange,
  type KpiKey,
  type KpiValue,
  type Period,
  periodRange,
  RETENTION_REASONS,
} from "@beam/core/ops";
import { sql, ValidationError, type SQL } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
import { getFinanceKpis } from "@/modules/finance/api";
import { loadFormsDashboardSource } from "@/modules/forms/api";
import { computeMarketingKpiSet, REGISTRANT_SEGMENTS, type MarketingKpiSet } from "../marketing/kpis-marketing";
import { b2bFigures, rate, retentionRates, type Rate } from "../marketing/management";
import { requireAny, type OpsReadCtx } from "../reports/registry";
import { brusselsDate, computeRevenueReport, SALES_CHANNELS, SALES_KINDS, type RevenueReport } from "../reports/revenue";
import { countOpportunitiesByReason, OPPORTUNITY_REASONS, segmentFilter } from "./opportunities";

export type EvaluateKpiOptions = { period: Period; at: Date; segmentId?: string | undefined; compare: boolean };

type Range = { from: Date; to: Date };
type Breakdown = NonNullable<KpiValue["breakdown"]>;
/** What one side (current or previous period) of a KPI yields. */
type Side = { value: number | null; ratio?: Rate; breakdown?: Map<string, { label: string; value: number }>; series?: { day: string; value: number }[] };

const HALF_DAY = 43_200_000;
const isFormsKpi = (key: KpiKey): key is FormsDashboardKpiKey => (FORMS_KPI_KEYS as readonly string[]).includes(key);
const ts = (d: Date): SQL => sql`${d.toISOString()}::timestamptz`;
/** Brussels dates of a half-open range, `to` inclusive (the report date ranges). */
const dateRange = (r: Range) => ({ from: brusselsDate(r.from), to: brusselsDate(new Date(r.to.getTime() - HALF_DAY)) });

// --- per-context memo -------------------------------------------------------------------------

const memos = new WeakMap<object, Map<string, Promise<unknown>>>();
function memo<T>(ctx: OpsReadCtx, key: string, fn: () => Promise<T>): Promise<T> {
  let m = memos.get(ctx);
  if (!m) memos.set(ctx, (m = new Map<string, Promise<unknown>>()));
  if (!m.has(key)) m.set(key, fn());
  return m.get(key) as Promise<T>;
}
const rk = (r: Range) => `${r.from.toISOString()}/${r.to.toISOString()}`;

// --- figures ----------------------------------------------------------------------------------

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

/** Rule 36 for `[from, to)`, as ops-P8's `customerCounts`, optionally within a segment. */
async function customers(ctx: OpsReadCtx, r: Range, segmentId: string | undefined): Promise<Record<string, number>> {
  return memo(ctx, `customers:${rk(r)}:${segmentId ?? ""}`, async () => {
    const day = 86_400_000;
    const [row] = rowsOf<Record<string, string | number>>(
      await ctx.tx.execute(sql`with a as (select a.person_id, a.at, a.is_purchase from ${ACTIVITIES} a
          where exists (select 1 from persons pe where pe.id = a.person_id and pe.is_tester = false and pe.merged_into_person_id is null)
            and a.at < ${ts(r.to)} ${segmentFilter(sql`a.person_id`, segmentId)}),
        g as (select a.person_id, a.at, a.at - lag(a.at) over (partition by a.person_id order by a.at) as gap from a)
      select
        (select count(*) from (select person_id from a where is_purchase group by person_id having min(at) >= ${ts(r.from)}) x)::int as new,
        (select count(distinct person_id) from a where at >= ${ts(new Date(r.to.getTime() - 90 * day))})::int as active,
        (select count(*) from (select person_id from a group by person_id
            having bool_or(at >= ${ts(r.from)}) and bool_or(at < ${ts(r.from)})) x)::int as returning,
        (select count(*) from (select person_id from a group by person_id
            having max(at) >= ${ts(new Date(r.to.getTime() - 365 * day))} and max(at) <= ${ts(new Date(r.to.getTime() - 90 * day))}) x)::int as dormant,
        (select count(distinct person_id) from g where at >= ${ts(r.from)} and gap > interval '90 days')::int as reactivated`),
    );
    return Object.fromEntries(Object.entries(row ?? {}).map(([k, v]) => [k, Number(v)]));
  });
}

/** The sales mix of `[from, to)` by product kind and channel (VAT included, refunds left out). */
async function salesMix(ctx: OpsReadCtx, r: Range): Promise<{ kind: Map<string, number>; channel: Map<string, number> }> {
  return memo(ctx, `mix:${rk(r)}`, async () => {
    const d = { from: brusselsDate(r.from), to: brusselsDate(r.to) };
    const rows = rowsOf<{ channel: string; product_kind: string; amount: string | number }>(
      await ctx.tx.execute(sql`select channel::text as channel, product_kind, sum(gross_cents)::bigint as amount from v_revenue_daily
        where day_on >= ${d.from}::date and day_on < ${d.to}::date and product_kind <> 'refund' group by 1, 2`),
    );
    const kind = new Map<string, number>();
    const channel = new Map<string, number>();
    for (const row of rows) {
      kind.set(row.product_kind, (kind.get(row.product_kind) ?? 0) + Number(row.amount));
      channel.set(row.channel, (channel.get(row.channel) ?? 0) + Number(row.amount));
    }
    return { kind, channel };
  });
}

/** One point per Brussels day of `[from, to)`: net revenue (VAT included) or orders. */
async function dailySeries(ctx: OpsReadCtx, r: Range, measure: "net" | "orders"): Promise<{ day: string; value: number }[]> {
  const d = { from: brusselsDate(r.from), to: brusselsDate(r.to) };
  const expr = measure === "net" ? sql`(gross_cents - refunds_cents)` : sql`orders`;
  const rows = rowsOf<{ day: string | Date; v: string | number }>(
    await ctx.tx.execute(sql`select day_on as day, sum(${expr})::bigint as v from v_revenue_daily
      where day_on >= ${d.from}::date and day_on < ${d.to}::date group by 1`),
  );
  const byDay = new Map(rows.map((x) => [typeof x.day === "string" ? x.day.slice(0, 10) : brusselsDate(new Date(x.day.getTime() + HALF_DAY)), Number(x.v)]));
  const out: { day: string; value: number }[] = [];
  for (let t = Date.parse(`${d.from}T12:00:00Z`); ; t += 86_400_000) {
    const day = new Date(t).toISOString().slice(0, 10);
    if (day >= d.to) break;
    out.push({ day, value: byDay.get(day) ?? 0 });
  }
  return out;
}

const revenue = (ctx: OpsReadCtx, period: Period, at: Date): Promise<RevenueReport> =>
  memo(ctx, `revenue:${period}:${at.toISOString()}`, () => computeRevenueReport(ctx.tx, { period, at, vat: "incl" }));
const retention = (ctx: OpsReadCtx, r: Range) => memo(ctx, `retention:${rk(r)}`, () => retentionRates(ctx.tx, r.from, r.to));
const b2b = (ctx: OpsReadCtx, r: Range) => memo(ctx, `b2b:${rk(r)}`, () => b2bFigures(ctx.tx, r.from, r.to));
const marketing = (ctx: OpsReadCtx, r: Range): Promise<MarketingKpiSet> => memo(ctx, `marketing:${rk(r)}`, () => computeMarketingKpiSet(ctx.tx, dateRange(r)));
const finance = (ctx: OpsReadCtx, r: Range) => memo(ctx, `finance:${rk(r)}`, () => getFinanceKpis(ctx.tx, dateRange(r)));

const FUNNEL_STAGES = ["views", "started", "engaged", "completed", "abandoned"] as const;
const CONVERSION_PARTS = ["linked", "booked", "purchased"] as const;
const parts = (entries: readonly (readonly [string, string, number])[]) => new Map(entries.map(([key, label, value]) => [key, { label, value }]));

/** Forms' widget sources (forms-P10) for the Brussels days of `r`. */
async function formsSide(ctx: OpsReadCtx, key: FormsDashboardKpiKey, r: Range): Promise<Side> {
  const days = dateRange(r);
  switch (key) {
    case "forms.funnel": {
      const v = await memo(ctx, `forms.funnel:${rk(r)}`, () => loadFormsDashboardSource(ctx.tx, "forms.funnel", days));
      return {
        value: v.totals.completed,
        breakdown: parts(FUNNEL_STAGES.map((s) => [s, `forms.report.${s}`, v.totals[s]] as const)),
        series: v.series.map((p) => ({ day: p.day, value: p.completed })),
      };
    }
    case "forms.outcomes": {
      const v = await memo(ctx, `forms.outcomes:${rk(r)}`, () => loadFormsDashboardSource(ctx.tx, "forms.outcomes", days));
      return { value: v.completed, breakdown: parts(v.rows.map((o) => [o.key ?? "none", o.label, o.count] as const)) };
    }
    case "forms.conversion": {
      const v = await memo(ctx, `forms.conversion:${rk(r)}`, () => loadFormsDashboardSource(ctx.tx, "forms.conversion", days));
      return {
        value: v.totals.booked,
        breakdown: parts(CONVERSION_PARTS.map((c) => [c, `forms.report.${c}`, v.totals[c]] as const)),
        series: v.series.map((p) => ({ day: p.day, value: p.booked })),
      };
    }
  }
}

async function retentionByReason(ctx: OpsReadCtx, segmentId: string | undefined): Promise<Map<string, { label: string; value: number }>> {
  const rows = rowsOf<{ reason: string; n: string | number }>(
    await ctx.tx.execute(sql`select rc.reason, count(distinct rc.person_id)::int as n from v_retention_candidates rc
      where true ${segmentFilter(sql`rc.person_id`, segmentId)} group by rc.reason`),
  );
  const counts = new Map(rows.map((r) => [r.reason, Number(r.n)]));
  return new Map(RETENTION_REASONS.map((reason) => [reason, { label: `ops.retention.reason.${reason}`, value: counts.get(reason) ?? 0 }]));
}

const fromRate = (r: Rate): Side => ({ value: r.rate, ratio: r });
const count = (v: number): Side => ({ value: v });
const split = (entries: [string, string, number][]): Side => ({
  value: entries.reduce((a, [, , v]) => a + v, 0),
  breakdown: new Map(entries.map(([key, label, value]) => [key, { label, value }])),
});

const CUSTOMER_KEYS: Record<string, string> = {
  customers_new: "new",
  customers_active: "active",
  customers_returning: "returning",
  customers_dormant: "dormant",
  customers_reactivated: "reactivated",
};
const RETENTION_KEYS = {
  repeat_purchase_rate: "repeat_purchase_rate",
  package_completion_rate: "package_completion",
  reactivation_rate: "reactivation_rate",
  membership_renewal_rate: "membership_renewal_rate",
} as const;

const sumRates = (rates: Rate[]): Rate => rate(rates.reduce((a, r) => a + r.numerator, 0), rates.reduce((a, r) => a + r.denominator, 0));

/** One side of `key` for the range `r` (`which` picks the matching side of the period reports). */
async function side(ctx: OpsReadCtx, key: KpiKey, r: Range, which: "current" | "previous", opts: EvaluateKpiOptions): Promise<Side> {
  if (key in CUSTOMER_KEYS) return count((await customers(ctx, r, opts.segmentId))[CUSTOMER_KEYS[key]!] ?? 0);
  if (key in RETENTION_KEYS) return fromRate((await retention(ctx, r))[RETENTION_KEYS[key as keyof typeof RETENTION_KEYS]]);
  if (isFormsKpi(key)) return formsSide(ctx, key, r);
  if (key.startsWith("finance_")) {
    const f = await finance(ctx, r);
    return count(f[FINANCE_KPI_BY_DASHBOARD_KEY[key as FinanceDashboardKpiKey]]);
  }
  switch (key) {
    case "revenue_net":
    case "revenue_sales":
    case "revenue_refunds":
    case "revenue_orders": {
      const rep = await revenue(ctx, opts.period, opts.at);
      const c = rep[key === "revenue_net" ? "net" : key === "revenue_sales" ? "sales" : key === "revenue_refunds" ? "refunds" : "orders"];
      return count(c[which]);
    }
    case "sales_by_kind": {
      const m = (await salesMix(ctx, r)).kind;
      return split(SALES_KINDS.map((k) => [k, `ops.reports.product_kind.${k}`, m.get(k) ?? 0]));
    }
    case "sales_by_channel": {
      const m = (await salesMix(ctx, r)).channel;
      return split(SALES_CHANNELS.map((c) => [c, `ops.reports.channel.${c}`, m.get(c) ?? 0]));
    }
    case "b2b_pipeline_value":
      return count((await b2b(ctx, r)).pipelineValueCents);
    case "b2b_weighted_value":
      return count((await b2b(ctx, r)).weightedValueCents);
    case "b2b_qualified":
      return count((await b2b(ctx, r)).qualifiedCount);
    case "b2b_proposals":
      return count((await b2b(ctx, r)).proposalCount);
    case "b2b_conversion": {
      const f = await b2b(ctx, r);
      return fromRate(rate(f.won, f.won + f.lost));
    }
    case "b2b_revenue":
      return count((await b2b(ctx, r)).revenueCents);
    case "leads":
      return count((await marketing(ctx, r)).leads);
    case "leads_by_source": {
      const rows = (await marketing(ctx, r)).leadsBySource;
      return split(rows.map((l) => [`${l.source}|${l.campaign ?? ""}`, l.campaign ? `${l.source} / ${l.campaign}` : l.source, l.leads]));
    }
    case "registration_rate":
      return fromRate((await marketing(ctx, r)).registrationRate);
    case "attendance_rate":
      return fromRate((await marketing(ctx, r)).attendance.combined);
    case "event_attendance_rate":
      return fromRate((await marketing(ctx, r)).attendance.events);
    case "lead_to_visit":
      return fromRate((await marketing(ctx, r)).leadToVisit);
    case "visit_to_purchase":
      return fromRate((await marketing(ctx, r)).visitToPurchase);
    case "assessment_completion":
      return fromRate((await marketing(ctx, r)).assessmentCompletion);
    case "assessment_conversion":
      return fromRate((await marketing(ctx, r)).assessmentConversion);
    case "webinar_conversion_30d": {
      const m = await marketing(ctx, r);
      return fromRate(sumRates(REGISTRANT_SEGMENTS.map((s) => m.webinarConversion[s].d30)));
    }
    case "reactivation_revenue":
      return count((await marketing(ctx, r)).reactivationRevenueCents);
    case "abandoned_recovery_rate": {
      const a = (await marketing(ctx, r)).abandoned;
      return fromRate(rate(a.recovered, a.abandoned));
    }
    case "abandoned_recovery_revenue":
      return count((await marketing(ctx, r)).abandoned.recoveryRevenueCents);
    case "retention_candidates_by_reason": {
      const m = await retentionByReason(ctx, opts.segmentId);
      return split([...m].map(([k, v]) => [k, v.label, v.value]));
    }
    case "opportunities_by_reason": {
      const c = await countOpportunitiesByReason(ctx.tx, opts.segmentId ? { segmentId: opts.segmentId } : {});
      return split(OPPORTUNITY_REASONS.map((reason) => [reason, `ops.opportunity.reason.${reason}`, c[reason]]));
    }
  }
  throw new ValidationError("unknown_kpi", { kpi: key });
}

/** Rule 79: refuses an unknown key, a period or segment the KPI does not support, and missing permissions. */
export function assertKpiAllowed(ctx: Pick<OpsReadCtx, "actor">, key: string, opts: Pick<EvaluateKpiOptions, "period" | "segmentId">): asserts key is KpiKey {
  requireAny(ctx, "reports.read");
  if (!isKpiKey(key)) throw new ValidationError("unknown_kpi", { kpi: "unknown" });
  const def = KPI_REGISTRY[key];
  if (def.permission) requireAny(ctx, def.permission);
  if (!def.periods.includes(opts.period)) throw new ValidationError("period", { period: "unsupported" });
  if (opts.segmentId && !def.segmentable) throw new ValidationError("segment", { segmentId: "unsupported" });
}

/** The value of one KPI (`reports.read`; finance KPIs also `reports.finance`). */
export async function evaluateKpi(ctx: OpsReadCtx, key: KpiKey, opts: EvaluateKpiOptions): Promise<KpiValue> {
  assertKpiAllowed(ctx, key, opts);
  const def = KPI_REGISTRY[key];
  const pr = periodRange(opts.period, opts.at);
  const cur: Range = { from: pr.from, to: pr.to };
  const prev: Range = { from: pr.prevFrom, to: pr.prevTo };
  const withPrevious = opts.compare && !def.snapshot;

  const c = await side(ctx, key, cur, "current", opts);
  const p = withPrevious ? await side(ctx, key, prev, "previous", opts) : null;
  const previous = p ? p.value : null;
  const value: KpiValue = {
    key,
    unit: def.unit,
    period: opts.period,
    range: { from: brusselsDate(pr.from), to: brusselsDate(pr.to), prevFrom: brusselsDate(pr.prevFrom), prevTo: brusselsDate(pr.prevTo) },
    current: c.value,
    previous,
    ...kpiChange(c.value, previous),
  };
  if (c.ratio) value.ratio = { numerator: c.ratio.numerator, denominator: c.ratio.denominator };
  if (c.breakdown) {
    const rows: Breakdown = [...c.breakdown].map(([k, v]) => ({ key: k, label: v.label, current: v.value, previous: p?.breakdown ? (p.breakdown.get(k)?.value ?? 0) : null }));
    for (const [k, v] of p?.breakdown ?? []) if (!c.breakdown.has(k)) rows.push({ key: k, label: v.label, current: 0, previous: v.value });
    value.breakdown = rows;
  }
  if (c.series) value.series = c.series;
  if (key === "revenue_net" || key === "revenue_orders") value.series = await dailySeries(ctx, cur, key === "revenue_net" ? "net" : "orders");
  return value;
}
