/**
 * The KPI catalogue of custom dashboards (ops rule 79, R4): a dashboard widget picks one key of
 * `KPI_REGISTRY`, never free SQL. Every KPI of rules 34-38 (revenue, sales mix, customers,
 * retention, B2B) and rule 75 (marketing), the two list counts `retention_candidates_by_reason`
 * and `opportunities_by_reason`, and finance's dashboard figures (`getFinanceKpis`,
 * finance-P10, `finance_*` keys, `reports.finance`) and forms' widget sources (forms-P10,
 * `forms.*` keys). `apps/web/modules/ops/insights/evaluate-kpi.ts` computes them.
 *
 * - `label` is the catalogue key of the KPI's name (`ops.kpi.<key>`).
 * - `unit`: `cents` (EUR), `count`, or `pct` (a ratio from 0 to 1; null when the denominator is 0).
 * - `periods`: the rule 34 periods it can be shown for. A snapshot ("as of now": the B2B pipeline,
 *   the retention and opportunity lists, finance's end-of-period figures are not snapshots) has
 *   only `day` and no comparison.
 * - `segmentable`: the KPI counts people, so a widget may restrict it to a crm segment.
 * - `views`: the visualisations the widget may use; `breakdown` KPIs show a table or bars.
 */
import { FINANCE_KPI_DEFINITIONS, FINANCE_KPI_KEYS, type FinanceKpiKey } from "../finance/kpis";
import { PERIODS, type Period } from "./periods";
import type { DashboardDefinition } from "./schemas";

export type KpiUnit = "cents" | "count" | "pct";
export type KpiViz = DashboardDefinition["widgets"][number]["viz"];
export type KpiGroup = "revenue" | "customers" | "retention" | "b2b" | "marketing" | "forms" | "lists" | "finance";

export const KPI_GROUPS: readonly KpiGroup[] = ["revenue", "customers", "retention", "b2b", "marketing", "forms", "lists", "finance"];

export type KpiDefinition = {
  label: string;
  unit: KpiUnit;
  periods: Period[];
  segmentable: boolean;
  group: KpiGroup;
  views: KpiViz[];
  /** True for a figure "as of now" (no period, no comparison). */
  snapshot: boolean;
  /** True when the value is split by a dimension (`breakdown` rows). */
  breakdown: boolean;
  /** The permission needed on top of `reports.read`. */
  permission?: "reports.finance";
};

const ALL: Period[] = [...PERIODS];
const NOW: Period[] = ["day"];
const SCALAR: KpiViz[] = ["number", "bar"];
const SERIES: KpiViz[] = ["number", "line", "bar"];
const SPLIT: KpiViz[] = ["table", "bar"];

const k = (group: KpiGroup, unit: KpiUnit, opts: { segmentable?: boolean; snapshot?: boolean; breakdown?: boolean; views?: KpiViz[] } = {}) => ({
  group,
  unit,
  segmentable: opts.segmentable ?? false,
  snapshot: opts.snapshot ?? false,
  breakdown: opts.breakdown ?? false,
  views: opts.views ?? (opts.breakdown ? SPLIT : SCALAR),
  periods: opts.snapshot ? NOW : ALL,
});

/** The ops KPIs, in picker order. */
const OPS_KPIS = {
  // Rules 34, 35: revenue and sales mix (`v_revenue_daily`, VAT included).
  revenue_net: k("revenue", "cents", { views: SERIES }),
  revenue_sales: k("revenue", "cents"),
  revenue_refunds: k("revenue", "cents"),
  revenue_orders: k("revenue", "count", { views: SERIES }),
  sales_by_kind: k("revenue", "cents", { breakdown: true }),
  sales_by_channel: k("revenue", "cents", { breakdown: true }),
  // Rule 36: customers.
  customers_new: k("customers", "count", { segmentable: true }),
  customers_active: k("customers", "count", { segmentable: true }),
  customers_returning: k("customers", "count", { segmentable: true }),
  customers_dormant: k("customers", "count", { segmentable: true }),
  customers_reactivated: k("customers", "count", { segmentable: true }),
  // Rule 37: retention.
  repeat_purchase_rate: k("retention", "pct"),
  package_completion_rate: k("retention", "pct"),
  reactivation_rate: k("retention", "pct"),
  membership_renewal_rate: k("retention", "pct"),
  // Rule 38: B2B.
  b2b_pipeline_value: k("b2b", "cents", { snapshot: true }),
  b2b_weighted_value: k("b2b", "cents", { snapshot: true }),
  b2b_qualified: k("b2b", "count", { snapshot: true }),
  b2b_proposals: k("b2b", "count", { snapshot: true }),
  b2b_conversion: k("b2b", "pct"),
  b2b_revenue: k("b2b", "cents"),
  // Rule 75: marketing.
  leads: k("marketing", "count"),
  leads_by_source: k("marketing", "count", { breakdown: true }),
  registration_rate: k("marketing", "pct"),
  attendance_rate: k("marketing", "pct"),
  event_attendance_rate: k("marketing", "pct"),
  lead_to_visit: k("marketing", "pct"),
  visit_to_purchase: k("marketing", "pct"),
  assessment_completion: k("marketing", "pct"),
  assessment_conversion: k("marketing", "pct"),
  webinar_conversion_30d: k("marketing", "pct"),
  reactivation_revenue: k("marketing", "cents"),
  abandoned_recovery_rate: k("marketing", "pct"),
  abandoned_recovery_revenue: k("marketing", "cents"),
  // Lists (rules 19-21 and the R4 opportunities).
  retention_candidates_by_reason: k("lists", "count", { segmentable: true, snapshot: true, breakdown: true }),
  opportunities_by_reason: k("lists", "count", { segmentable: true, snapshot: true, breakdown: true }),
} as const;

type OpsKpiKey = keyof typeof OPS_KPIS;

/**
 * Forms' widget sources (forms-P10, `FORMS_DASHBOARD_SOURCES` in `apps/web/modules/forms/api`):
 * the keys and visualisations are forms'; `evaluate-kpi.ts` loads them through
 * `loadFormsDashboardSource`. Each shows a headline count, its parts as breakdown rows and a
 * daily series (the outcomes have no series).
 */
const FORMS_KPIS = {
  "forms.funnel": k("forms", "count", { breakdown: true, views: ["number", "line", "bar", "table"] }),
  "forms.outcomes": k("forms", "count", { breakdown: true, views: ["table", "bar"] }),
  "forms.conversion": k("forms", "count", { breakdown: true, views: ["number", "line", "bar", "table"] }),
} as const;

export type FormsDashboardKpiKey = keyof typeof FORMS_KPIS;

export const FORMS_KPI_KEYS = Object.keys(FORMS_KPIS) as FormsDashboardKpiKey[];

/** `netRevenueCents` -> `finance_net_revenue_cents`. */
export const financeKpiKeyOf = (key: FinanceKpiKey) => `finance_${key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}` as FinanceDashboardKpiKey;

type Snake<S extends string> = S extends `${infer H}${infer T}` ? `${H extends Uppercase<H> ? (H extends Lowercase<H> ? H : `_${Lowercase<H>}`) : H}${Snake<T>}` : S;
export type FinanceDashboardKpiKey = `finance_${Snake<FinanceKpiKey>}`;

export type KpiKey = OpsKpiKey | FormsDashboardKpiKey | FinanceDashboardKpiKey;

const FINANCE_KPIS = Object.fromEntries(
  FINANCE_KPI_DEFINITIONS.map((d) => [
    financeKpiKeyOf(d.key),
    { ...k("finance", d.unit), permission: "reports.finance" as const },
  ]),
) as Record<FinanceDashboardKpiKey, Omit<KpiDefinition, "label">>;

/** Finance's key behind a `finance_*` dashboard KPI. */
export const FINANCE_KPI_BY_DASHBOARD_KEY: Readonly<Record<FinanceDashboardKpiKey, FinanceKpiKey>> = Object.fromEntries(
  FINANCE_KPI_KEYS.map((key) => [financeKpiKeyOf(key), key]),
) as Record<FinanceDashboardKpiKey, FinanceKpiKey>;

const withLabels = <T extends Record<string, Omit<KpiDefinition, "label">>>(defs: T) =>
  Object.fromEntries(Object.entries(defs).map(([key, d]) => [key, { label: `ops.kpi.${key}`, ...d }])) as { [K in keyof T]: KpiDefinition };

/** Every dashboard KPI (rule 79). */
export const KPI_REGISTRY: Readonly<Record<KpiKey, KpiDefinition>> = { ...withLabels(OPS_KPIS), ...withLabels(FORMS_KPIS), ...withLabels(FINANCE_KPIS) };

export const KPI_KEYS = Object.keys(KPI_REGISTRY) as KpiKey[];

export function isKpiKey(value: unknown): value is KpiKey {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(KPI_REGISTRY, value);
}

/** One evaluated widget value. Ranges are Brussels dates with `to` exclusive. */
export type KpiValue = {
  key: KpiKey;
  unit: KpiUnit;
  period: Period;
  range: { from: string; to: string; prevFrom: string; prevTo: string };
  /** Null for a `pct` KPI whose denominator is 0. */
  current: number | null;
  /** Null without a comparison (snapshots, `compare: false`) or a 0 denominator. */
  previous: number | null;
  change: number | null;
  /** Percent with one decimal; null when the previous value is 0 or missing (rule 34). */
  changePct: number | null;
  /** The numerator and denominator of a `pct` value. */
  ratio?: { numerator: number; denominator: number };
  /** Breakdown KPIs: one row per dimension value, `label` a catalogue key or a raw value. */
  breakdown?: { key: string; label: string; current: number; previous: number | null }[];
  /** `line` widgets: one point per Brussels day of the period. */
  series?: { day: string; value: number }[];
};

/** Rule 34's comparison of two values (null when either side is missing). */
export function kpiChange(current: number | null, previous: number | null): { change: number | null; changePct: number | null } {
  if (current === null || previous === null) return { change: null, changePct: null };
  const change = current - previous;
  return { change, changePct: previous === 0 ? null : Math.round((change / Math.abs(previous)) * 1000) / 10 };
}

export const MAX_DASHBOARD_WIDGETS = 24;

export type DefinitionProblem = { widgetId: string | null; reason: "too_many_widgets" | "unknown_kpi" | "period" | "segment" | "viz" | "duplicate_id" };

/**
 * Rule 79's checks of a definition beyond its Zod shape: at most 24 widgets, known KPIs only,
 * a period and a visualisation the KPI supports, a segment only on a segmentable KPI, unique ids.
 */
export function checkDashboardDefinition(def: { widgets: readonly { id: string; kpi: string; period: string; viz: string; segmentId?: string | undefined }[] }): DefinitionProblem[] {
  const problems: DefinitionProblem[] = [];
  if (def.widgets.length > MAX_DASHBOARD_WIDGETS) problems.push({ widgetId: null, reason: "too_many_widgets" });
  const seen = new Set<string>();
  for (const w of def.widgets) {
    if (seen.has(w.id)) problems.push({ widgetId: w.id, reason: "duplicate_id" });
    seen.add(w.id);
    if (!isKpiKey(w.kpi)) {
      problems.push({ widgetId: w.id, reason: "unknown_kpi" });
      continue;
    }
    const d = KPI_REGISTRY[w.kpi];
    if (!(d.periods as string[]).includes(w.period)) problems.push({ widgetId: w.id, reason: "period" });
    if (!(d.views as string[]).includes(w.viz)) problems.push({ widgetId: w.id, reason: "viz" });
    if (w.segmentId && !d.segmentable) problems.push({ widgetId: w.id, reason: "segment" });
  }
  return problems;
}
