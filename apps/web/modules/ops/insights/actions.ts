"use server";
/**
 * ops server actions, area `insights` (ops spec 4.1, R4, rule 79): `saveDashboard` and
 * `deleteDashboard` for custom dashboards, behind `ff_ops_ai`.
 *
 * - Creating needs `reports.read`; the creator owns the dashboard.
 * - Editing, sharing and deleting need the owner or `dashboards.manage`; a shared dashboard of
 *   someone else is read-only (`forbidden`), and one that is not visible is `not_found`.
 * - A definition may hold at most 24 widgets of `KPI_REGISTRY` keys, each with a period and
 *   visualisation the KPI supports and a segment only on a segmentable KPI (`validation`).
 * - Audited as `dashboard.saved` (with the old and new value on an edit) and `dashboard.deleted`.
 *
 * A "use server" file exports async functions only.
 */
import { DeleteDashboardInput, SaveDashboardInput } from "@beam/core/ops";
import { dashboards } from "@beam/db/schema";
import { action } from "@/lib/action";
import { ForbiddenError } from "@beam/core/errors";
import { eq, NotFoundError, ValidationError, type Ctx } from "@/lib/ctx";
import { flag } from "@/lib/flags";
import { checkDashboardDefinition } from "../../../../../packages/core/src/ops/kpis";
import { canEditDashboard, loadVisibleDashboard } from "./queries";

async function requireAiFlag(ctx: Ctx): Promise<void> {
  if (!(await flag("ff_ops_ai", ctx.actor))) throw new NotFoundError("ff_ops_ai");
}

export const saveDashboard = action(
  { name: "ops.dashboard_save", audience: "staff", permission: "reports.read", input: SaveDashboardInput, audit: false },
  async (ctx, input): Promise<{ id: string }> => {
    await requireAiFlag(ctx);
    const problems = checkDashboardDefinition(input.definition);
    if (problems.length > 0) {
      throw new ValidationError(
        "dashboard_definition",
        Object.fromEntries(problems.map((p) => [p.widgetId ? `definition.widgets.${p.widgetId}` : "definition.widgets", p.reason])),
      );
    }
    if (ctx.actor.kind !== "staff") throw new ForbiddenError();
    const values = { name: input.name, definition: input.definition, isShared: input.isShared };
    if (!input.id) {
      const [row] = await ctx.tx.insert(dashboards).values({ ...values, ownerUserId: ctx.actor.userId }).returning({ id: dashboards.id });
      await ctx.audit({ action: "dashboard.saved", entityType: "dashboard", entityId: row!.id, newValue: { ...values, widgets: input.definition.widgets.length } });
      return { id: row!.id };
    }
    const old = await loadVisibleDashboard(ctx.tx, ctx.actor, input.id);
    if (!canEditDashboard(ctx.actor, old)) throw new ForbiddenError("forbidden: dashboards.manage", "dashboards.manage");
    await ctx.tx.update(dashboards).set({ ...values, updatedAt: ctx.now }).where(eq(dashboards.id, old.id));
    await ctx.audit({
      action: "dashboard.saved",
      entityType: "dashboard",
      entityId: old.id,
      oldValue: { name: old.name, isShared: old.isShared, definition: old.definition },
      newValue: values,
    });
    return { id: old.id };
  },
);

export const deleteDashboard = action(
  { name: "ops.dashboard_delete", audience: "staff", permission: "reports.read", input: DeleteDashboardInput, audit: false },
  async (ctx, input): Promise<{ ok: true }> => {
    await requireAiFlag(ctx);
    const old = await loadVisibleDashboard(ctx.tx, ctx.actor, input.id);
    if (!canEditDashboard(ctx.actor, old)) throw new ForbiddenError("forbidden: dashboards.manage", "dashboards.manage");
    await ctx.tx.delete(dashboards).where(eq(dashboards.id, old.id));
    await ctx.audit({ action: "dashboard.deleted", entityType: "dashboard", entityId: old.id, oldValue: { name: old.name, isShared: old.isShared } });
    return { ok: true };
  },
);
