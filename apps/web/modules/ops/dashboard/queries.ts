/**
 * ops queries, area `dashboard` (ops spec 4.2, ops-P3): the action dashboard. Counts are live
 * (rule 33, no cache); the cards run one after another on the read context's connection. The
 * permission is checked on the context's actor (`reports.read` or `tasks.all`), and each card is
 * filtered by its own permission (ops spec 7). Reading the dashboard is not audited.
 */
import { DashboardViewInput, RETENTION_DEFAULTS, type ActionCardKey } from "@beam/core/ops";
import { getSetting } from "@/lib/settings";
import { requireAny, type OpsReadCtx } from "../reports/registry";
import { CARDS, canSeeCard, DASHBOARD_PERMISSIONS, loadCard, type ActionCard, type DashboardView } from "./cards";

export type { ActionCard, ActionCardRow, DashboardView } from "./cards";

/** The first rows shown per card, and the rows of an expanded card ("Open list", one page of 50). */
export const CARD_ROWS = 10;
export const CARD_LIST_ROWS = 50;

/**
 * The cards the actor may see, each with its count and first 10 rows (`expand` shows 50 rows of
 * one card). `view = 'week'` widens the date horizons by `dashboard_week_horizon_days` (rule 22b).
 */
export async function getActionDashboard(ctx: OpsReadCtx, opts: { view?: DashboardView; expand?: ActionCardKey } = {}): Promise<ActionCard[]> {
  requireAny(ctx, ...DASHBOARD_PERMISSIONS);
  const { view } = DashboardViewInput.parse({ view: opts.view });
  let cfg = RETENTION_DEFAULTS;
  try {
    cfg = await getSetting(ctx.tx, "retention_defaults");
  } catch {
    // the registry default applies when the setting cannot be read
  }
  const env = { now: ctx.now, cfg, add: view === "week" ? cfg.dashboard_week_horizon_days : 0, view, actor: ctx.actor };
  const out: ActionCard[] = [];
  for (const card of CARDS) {
    if (!canSeeCard(ctx.actor, card)) continue;
    out.push(await loadCard(ctx.tx, card, env, opts.expand === card.key ? CARD_LIST_ROWS : CARD_ROWS));
  }
  return out;
}
