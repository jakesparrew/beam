/**
 * ops queries, area `insights` (ops spec 4.2, R4): custom dashboards (rule 79) and the
 * opportunity list. Each takes an `OpsReadCtx` (a page builds it with `staffReadCtx()`), checks
 * `reports.read`, selects named columns and pages at 50 rows. Reading is not audited (ops spec 7).
 *
 * A dashboard is visible to its owner and, when `is_shared`, to every user with `reports.read`;
 * only the owner or a holder of `dashboards.manage` can edit it (`canEdit`).
 */
import type { DbOrTx } from "@beam/db";
import type { DashboardDefinition } from "@beam/core/ops";
import { dashboards } from "@beam/db/schema";
import { asc, desc, eq, NotFoundError, or, sql, type Actor } from "@/lib/ctx";
import { PERIODS } from "@beam/core/ops";
import { translator } from "@/lib/i18n";
import { getSegmentSummaries } from "@/modules/crm/api";
import { holdsAny, requireAny, type OpsReadCtx } from "../reports/registry";
import type { PickerKpi, WidgetPickerLabels } from "../ui/WidgetPicker";
import { evaluateKpi, type EvaluateKpiOptions } from "./evaluate-kpi";
import { listOpportunityCandidates, type OpportunityReason } from "./opportunities";
import { KPI_KEYS, KPI_REGISTRY, type KpiDefinition, type KpiKey, type KpiValue } from "../../../../../packages/core/src/ops/kpis";

export { evaluateKpi };
export type { EvaluateKpiOptions, KpiValue };

export const DASHBOARD_PAGE_SIZE = 50;

export type DashboardSummary = { id: string; name: string; isShared: boolean; isOwn: boolean; widgetCount: number; updatedAt: Date };
export type DashboardDetail = { id: string; name: string; isShared: boolean; ownerUserId: string; definition: DashboardDefinition; canEdit: boolean; updatedAt: Date };
export type WidgetResult = { widgetId: string; value: KpiValue | null; error: string | null };

const userIdOf = (actor: Actor): string | null => (actor.kind === "staff" ? actor.userId : null);

/** True when the actor may change `row` (owner, or `dashboards.manage`). */
export function canEditDashboard(actor: Actor, row: { ownerUserId: string }): boolean {
  return holdsAny(actor, "dashboards.manage") || (userIdOf(actor) !== null && userIdOf(actor) === row.ownerUserId);
}

/** The visible dashboard `id` (own or shared), else `not_found`. */
export async function loadVisibleDashboard(db: DbOrTx, actor: Actor, id: string) {
  const [row] = await db
    .select({ id: dashboards.id, name: dashboards.name, isShared: dashboards.isShared, ownerUserId: dashboards.ownerUserId, definition: dashboards.definition, updatedAt: dashboards.updatedAt })
    .from(dashboards)
    .where(eq(dashboards.id, id));
  if (!row) throw new NotFoundError("dashboard");
  const own = userIdOf(actor) === row.ownerUserId;
  if (!own && !row.isShared && !holdsAny(actor, "dashboards.manage")) throw new NotFoundError("dashboard");
  return row;
}

/** Own dashboards first, then the shared ones of others, by name (50 per page). */
export async function listDashboards(ctx: OpsReadCtx, input: { page?: number } = {}): Promise<DashboardSummary[]> {
  requireAny(ctx, "reports.read");
  const me = userIdOf(ctx.actor);
  const page = Math.max(1, Math.floor(input.page ?? 1));
  const visible = me ? or(eq(dashboards.ownerUserId, me), eq(dashboards.isShared, true)) : eq(dashboards.isShared, true);
  const rows = await ctx.tx
    .select({ id: dashboards.id, name: dashboards.name, isShared: dashboards.isShared, ownerUserId: dashboards.ownerUserId, definition: dashboards.definition, updatedAt: dashboards.updatedAt })
    .from(dashboards)
    .where(visible)
    .orderBy(me ? sql`case when ${dashboards.ownerUserId} = ${me}::uuid then 0 else 1 end` : sql`1`, asc(dashboards.name), desc(dashboards.updatedAt), asc(dashboards.id))
    .limit(DASHBOARD_PAGE_SIZE)
    .offset((page - 1) * DASHBOARD_PAGE_SIZE);
  return rows.map((r) => ({ id: r.id, name: r.name, isShared: r.isShared, isOwn: r.ownerUserId === me, widgetCount: r.definition.widgets.length, updatedAt: r.updatedAt }));
}

/** One visible dashboard with `canEdit` (`reports.read`). */
export async function getDashboard(ctx: OpsReadCtx, id: string): Promise<DashboardDetail> {
  requireAny(ctx, "reports.read");
  const row = await loadVisibleDashboard(ctx.tx, ctx.actor, id);
  return { ...row, canEdit: canEditDashboard(ctx.actor, row) };
}

/**
 * Every widget's value for `at` (`reports.read`). A widget that fails (a KPI the actor may not
 * see, a removed key, a source error) gets `error` and the rest still render.
 */
export async function evaluateDashboard(ctx: OpsReadCtx, definition: DashboardDefinition, at: Date): Promise<WidgetResult[]> {
  requireAny(ctx, "reports.read");
  const out: WidgetResult[] = [];
  for (const w of definition.widgets) {
    const opts: EvaluateKpiOptions = { period: w.period, at, compare: w.compare, ...(w.segmentId ? { segmentId: w.segmentId } : {}) };
    try {
      out.push({ widgetId: w.id, value: await evaluateKpi(ctx, w.kpi as KpiKey, opts), error: null });
    } catch (e) {
      const code = (e as { code?: unknown; name?: string } | null)?.code;
      out.push({ widgetId: w.id, value: null, error: typeof code === "string" ? code : (e as Error)?.name === "ForbiddenError" ? "forbidden" : "unavailable" });
    }
  }
  return out;
}

/** The KPIs the actor may put on a dashboard, in registry order (finance ones need `reports.finance`). */
export function kpiCatalogue(actor: Actor): (KpiDefinition & { key: KpiKey })[] {
  return KPI_KEYS.filter((key) => {
    const p = KPI_REGISTRY[key].permission;
    return !p || holdsAny(actor, p);
  }).map((key) => ({ key, ...KPI_REGISTRY[key] }));
}

/** The opportunity candidates (`reports.read`), highest score first. */
export async function listOpportunities(ctx: OpsReadCtx, input: { reason?: OpportunityReason; segmentId?: string; page?: number } = {}) {
  requireAny(ctx, "reports.read");
  return listOpportunityCandidates(ctx.tx, input);
}

export type DashboardEditor = {
  catalogue: PickerKpi[];
  periods: { value: (typeof PERIODS)[number]; label: string }[];
  vizLabels: Record<"number" | "line" | "bar" | "table", string>;
  segments: { id: string; name: string }[];
  labels: WidgetPickerLabels;
};

/** Everything the widget picker needs, translated for the actor (`reports.read`); segments from crm. */
export async function getDashboardEditor(ctx: OpsReadCtx): Promise<DashboardEditor> {
  requireAny(ctx, "reports.read");
  const tr = translator(ctx.locale);
  const segments = (await getSegmentSummaries(ctx.tx)).map((s) => ({ id: s.id, name: s.name })).slice(0, 200);
  return {
    catalogue: kpiCatalogue(ctx.actor).map((k) => ({
      key: k.key,
      label: tr(k.label),
      group: k.group,
      groupLabel: tr(`ops.kpi.group.${k.group}`),
      periods: k.periods,
      views: k.views,
      segmentable: k.segmentable,
    })),
    periods: PERIODS.map((p) => ({ value: p, label: tr(`ops.period.${p}`) })),
    vizLabels: { number: tr("ops.custom.viz.number"), line: tr("ops.custom.viz.line"), bar: tr("ops.custom.viz.bar"), table: tr("ops.custom.viz.table") },
    segments,
    labels: {
      create: tr("ops.custom.create"),
      edit: tr("ops.custom.edit"),
      done: tr("ops.custom.done"),
      name: tr("ops.custom.name"),
      shared: tr("ops.custom.shared"),
      addWidget: tr("ops.custom.add_widget"),
      removeWidget: tr("ops.custom.remove_widget"),
      maxWidgets: tr("ops.custom.max_widgets", { max: 24 }),
      save: tr("ops.custom.save"),
      saving: tr("ops.custom.saving"),
      saved: tr("ops.custom.saved"),
      delete: tr("ops.custom.delete"),
      deleteConfirm: tr("ops.custom.delete_confirm"),
      deleted: tr("ops.custom.deleted"),
      kpi: tr("ops.custom.widget.kpi"),
      period: tr("ops.custom.widget.period"),
      compare: tr("ops.custom.widget.compare"),
      segment: tr("ops.custom.widget.segment"),
      segmentNone: tr("ops.custom.widget.segment_none"),
      viz: tr("ops.custom.widget.viz"),
      errors: {
        validation: tr("ops.custom.error.validation"),
        forbidden: tr("ops.custom.error.forbidden"),
        not_found: tr("ops.custom.error.not_found"),
        generic: tr("ops.custom.error.generic"),
      },
    },
  };
}
