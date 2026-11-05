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
import { holdsAny, requireAny, type OpsReadCtx } from "../reports/registry";
import { evaluateKpi, type EvaluateKpiOptions } from "./evaluate-kpi";
import { listOpportunityCandidates, type OpportunityReason } from "./opportunities";
import type { KpiKey, KpiValue } from "../../../../../packages/core/src/ops/kpis";

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

/** The opportunity candidates (`reports.read`), highest score first. */
export async function listOpportunities(ctx: OpsReadCtx, input: { reason?: OpportunityReason; segmentId?: string; page?: number } = {}) {
  requireAny(ctx, "reports.read");
  return listOpportunityCandidates(ctx.tx, input);
}
