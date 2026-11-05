/**
 * ops queries, area `retention` (ops spec 4.2, ops-P7, R2): the weekly retention list and its
 * candidates, the B2C pipeline board and the three R2 reports (no-shows, abandoned checkouts,
 * capacity). Each takes an `OpsReadCtx` (a page builds it with `staffReadCtx()`), checks
 * `reports.read` on the actor, pages at 50 rows and selects named columns only. Reading is not
 * audited (ops spec 7); the report CSVs audit `data.exported`.
 */
import { B2C_STAGES, RETENTION_REASONS, type B2cStage, type RetentionReason } from "@beam/core/ops";
import { sql } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
import { computeAbandonedReport, type AbandonedReport } from "../reports/abandoned";
import { CAPACITY_DEFAULT_SPAN, computeCapacityReport, parseGroupBy, type CapacityGroupBy, type CapacityReport } from "../reports/capacity";
import { computeNoShowReport, parseDateRange, type NoShowReport } from "../reports/no-shows";
import { computePipelineBoard, type PipelineBoard, type PipelineFilters } from "../reports/pipeline";
import { requireAny, type OpsReadCtx } from "../reports/registry";
import { readRetentionDefaults, weekStartOf } from "./build-list";

export type { AbandonedReport, CapacityReport, NoShowReport, PipelineBoard };

export const RETENTION_PAGE_SIZE = 50;

export type RetentionListItem = {
  id: string;
  rank: number;
  personId: string;
  name: string | null;
  score: number;
  primaryReason: RetentionReason;
  reasons: RetentionReason[];
  detail: Record<string, unknown>;
  revenueCents: number;
  lastVisitAt: Date | null;
  taskId: string | null;
  taskStatus: "open" | "done" | "cancelled" | null;
  dismissedAt: Date | null;
  dismissReason: string | null;
};

export type WeeklyRetentionList = {
  weekStartOn: string;
  list: { id: string; size: number; generatedAt: Date } | null;
  items: RetentionListItem[];
};

const toDate = (v: unknown): Date | null => (v === null || v === undefined ? null : v instanceof Date ? v : new Date(String(v)));
const json = (v: unknown): Record<string, unknown> => (typeof v === "string" ? (JSON.parse(v) as Record<string, unknown>) : ((v as Record<string, unknown> | null) ?? {}));
const textArray = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.replace(/^\{|\}$/g, "").split(",").filter(Boolean) : []);

/** Rule 20 (`reports.read`): the list of the week of `weekStartOn` (default this week) in rank order. */
export async function getWeeklyRetentionList(ctx: OpsReadCtx, input: { weekStartOn?: string } = {}): Promise<WeeklyRetentionList> {
  requireAny(ctx, "reports.read");
  const weekStartOn = input.weekStartOn && /^\d{4}-\d{2}-\d{2}$/.test(input.weekStartOn) ? weekStartOf(new Date(`${input.weekStartOn}T12:00:00Z`)) : weekStartOf(ctx.now);
  const [list] = rowsOf<{ id: string; size: number; generated_at: string | Date }>(
    await ctx.tx.execute(sql`select id, size, generated_at from retention_lists where week_start_on = ${weekStartOn}::date`),
  );
  if (!list) return { weekStartOn, list: null, items: [] };
  const rows = rowsOf<Record<string, unknown>>(
    await ctx.tx.execute(sql`select i.id, i.rank, i.person_id, i.score, i.primary_reason, i.reasons, i.detail, i.task_id, i.dismissed_at, i.dismiss_reason,
        tk.status::text as task_status, coalesce(ps.revenue_cents, 0)::int as revenue_cents, ps.last_visit_at,
        nullif(trim(concat_ws(' ', pe.first_name, pe.last_name)), '') as name
      from retention_list_items i join persons pe on pe.id = i.person_id
      left join person_stats ps on ps.person_id = i.person_id left join tasks tk on tk.id = i.task_id
      where i.list_id = ${list.id}::uuid order by i.rank`),
  );
  return {
    weekStartOn,
    list: { id: list.id, size: Number(list.size), generatedAt: toDate(list.generated_at)! },
    items: rows.map((r) => ({
      id: String(r.id),
      rank: Number(r.rank),
      personId: String(r.person_id),
      name: (r.name as string | null) ?? null,
      score: Number(r.score),
      primaryReason: r.primary_reason as RetentionReason,
      reasons: textArray(r.reasons) as RetentionReason[],
      detail: json(r.detail),
      revenueCents: Number(r.revenue_cents ?? 0),
      lastVisitAt: toDate(r.last_visit_at),
      taskId: (r.task_id as string | null) ?? null,
      taskStatus: (r.task_status as RetentionListItem["taskStatus"]) ?? null,
      dismissedAt: toDate(r.dismissed_at),
      dismissReason: (r.dismiss_reason as string | null) ?? null,
    })),
  };
}

export type RetentionCandidateRow = { personId: string; name: string | null; reason: RetentionReason; score: number; refType: string; refId: string; detail: Record<string, unknown> };

/** Rule 19 (`reports.read`): the "All candidates" tab, one row per reason and reference, highest score first, 50 per page. */
export async function listRetentionCandidates(ctx: OpsReadCtx, input: { reason?: RetentionReason; page?: number } = {}): Promise<{ rows: RetentionCandidateRow[]; total: number; page: number; pageSize: number }> {
  requireAny(ctx, "reports.read");
  const page = Math.max(1, Math.trunc(input.page ?? 1));
  const reason = input.reason && (RETENTION_REASONS as readonly string[]).includes(input.reason) ? input.reason : undefined;
  const rows = rowsOf<Record<string, unknown>>(
    await ctx.tx.execute(sql`select rc.person_id, rc.reason, rc.score, rc.ref_type, rc.ref_id, rc.detail, count(*) over () as total,
        nullif(trim(concat_ws(' ', pe.first_name, pe.last_name)), '') as name
      from v_retention_candidates rc join persons pe on pe.id = rc.person_id
      ${reason ? sql`where rc.reason = ${reason}` : sql``}
      order by rc.score desc, rc.person_id, rc.reason, rc.ref_id
      limit ${RETENTION_PAGE_SIZE} offset ${(page - 1) * RETENTION_PAGE_SIZE}`),
  );
  return {
    page,
    pageSize: RETENTION_PAGE_SIZE,
    total: rows.length ? Number(rows[0]!.total) : 0,
    rows: rows.map((r) => ({
      personId: String(r.person_id),
      name: (r.name as string | null) ?? null,
      reason: r.reason as RetentionReason,
      score: Number(r.score),
      refType: String(r.ref_type),
      refId: String(r.ref_id),
      detail: json(r.detail),
    })),
  };
}

/** Rule 14a (`reports.read`): the B2C board, counts per stage and the 50 most recent changes per stage. */
export async function getPipelineBoard(ctx: OpsReadCtx, input: { stage?: string; page?: number } & PipelineFilters = {}): Promise<PipelineBoard> {
  requireAny(ctx, "reports.read");
  const stage = (B2C_STAGES as readonly string[]).includes(input.stage ?? "") ? (input.stage as B2cStage) : undefined;
  const filters: PipelineFilters = {
    ...(input.source ? { source: input.source.slice(0, 80) } : {}),
    ...(input.campaign ? { campaign: input.campaign.slice(0, 120) } : {}),
    ...(input.highValue ? { highValue: true } : {}),
  };
  return computePipelineBoard(ctx.tx, { ...(stage ? { stage } : {}), page: input.page, filters });
}

type RangeInput = { from?: string; to?: string };

/** Rule 39 (`reports.read`): the no-show and cancellation report of `from`-`to` (default the last 30 days). */
export async function getNoShowReport(ctx: OpsReadCtx, input: RangeInput = {}): Promise<NoShowReport> {
  requireAny(ctx, "reports.read");
  return computeNoShowReport(ctx.tx, { range: parseDateRange(input, ctx.now), now: ctx.now, cfg: await readRetentionDefaults(ctx.tx) });
}

/** Rule 40 (`reports.read`): the abandoned checkout report of `from`-`to` (default the last 30 days). */
export async function getAbandonedCheckoutReport(ctx: OpsReadCtx, input: RangeInput = {}): Promise<AbandonedReport> {
  requireAny(ctx, "reports.read");
  return computeAbandonedReport(ctx.tx, { range: parseDateRange(input, ctx.now) });
}

/** Capacity utilisation (`reports.read`) of `from`-`to` (default the past 90 and next 90 days), grouped by template, weekday, hour or month. */
export async function getCapacityReport(ctx: OpsReadCtx, input: RangeInput & { groupBy?: CapacityGroupBy | string } = {}): Promise<CapacityReport> {
  requireAny(ctx, "reports.read");
  return computeCapacityReport(ctx.tx, { range: parseDateRange(input, ctx.now, CAPACITY_DEFAULT_SPAN), groupBy: parseGroupBy(input.groupBy) });
}
