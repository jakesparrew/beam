/**
 * Customer opportunity identification (ops R4, `v_opportunity_candidates`): the counts per reason
 * for the `opportunities_by_reason` KPI and the candidate list, optionally within a crm segment
 * (`segment_members`). Rule based; the view is empty until the `behavioural_scoring` DPIA is
 * approved (rule 70). Names are never part of the view; the list joins `persons` for the
 * display name only (first and last name, no email or phone).
 */
import type { DbOrTx } from "@beam/db";
import { OPPORTUNITY_REASONS, type OpportunityReason } from "@beam/db/schema";
import { sql, type SQL } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";

export { OPPORTUNITY_REASONS, type OpportunityReason };

export const OPPORTUNITY_PAGE_SIZE = 50;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `and <col> in (members of the segment)`, or nothing without a (valid) segment. */
export function segmentFilter(column: SQL, segmentId: string | undefined): SQL {
  if (!segmentId) return sql``;
  if (!UUID.test(segmentId)) return sql`and false`;
  return sql`and ${column} in (select sm.person_id from segment_members sm where sm.segment_id = ${segmentId}::uuid)`;
}

export const isOpportunityReason = (v: unknown): v is OpportunityReason => typeof v === "string" && (OPPORTUNITY_REASONS as readonly string[]).includes(v);

/** People per reason (a person with two reasons counts in both). Every reason is present. */
export async function countOpportunitiesByReason(db: DbOrTx, opts: { segmentId?: string } = {}): Promise<Record<OpportunityReason, number>> {
  const rows = rowsOf<{ reason: string; n: string | number }>(
    await db.execute(sql`select oc.reason, count(distinct oc.person_id)::int as n from v_opportunity_candidates oc
      where true ${segmentFilter(sql`oc.person_id`, opts.segmentId)} group by oc.reason`),
  );
  const out = Object.fromEntries(OPPORTUNITY_REASONS.map((r) => [r, 0])) as Record<OpportunityReason, number>;
  for (const r of rows) if (isOpportunityReason(r.reason)) out[r.reason] = Number(r.n);
  return out;
}

export type OpportunityRow = { personId: string; name: string; reason: OpportunityReason; score: number; detail: Record<string, unknown> };

/** One page of candidates, highest score first (ties by person id), 50 per page. */
export async function listOpportunityCandidates(
  db: DbOrTx,
  opts: { reason?: OpportunityReason; segmentId?: string; page?: number } = {},
): Promise<{ rows: OpportunityRow[]; total: number; page: number; pageSize: number }> {
  const page = Math.max(1, Math.floor(opts.page ?? 1));
  const reason = opts.reason && isOpportunityReason(opts.reason) ? sql`and oc.reason = ${opts.reason}` : sql``;
  const where = sql`where true ${reason} ${segmentFilter(sql`oc.person_id`, opts.segmentId)}`;
  const rows = rowsOf<{ person_id: string; first_name: string | null; last_name: string | null; reason: string; score: number | string; detail: Record<string, unknown> }>(
    await db.execute(sql`select oc.person_id, p.first_name, p.last_name, oc.reason, oc.score, oc.detail
      from v_opportunity_candidates oc join persons p on p.id = oc.person_id ${where}
      order by oc.score desc, oc.person_id, oc.reason
      limit ${OPPORTUNITY_PAGE_SIZE} offset ${(page - 1) * OPPORTUNITY_PAGE_SIZE}`),
  );
  const [total] = rowsOf<{ n: string | number }>(await db.execute(sql`select count(*)::int as n from v_opportunity_candidates oc ${where}`));
  return {
    rows: rows.map((r) => ({
      personId: r.person_id,
      name: [r.first_name, r.last_name].filter(Boolean).join(" "),
      reason: r.reason as OpportunityReason,
      score: Number(r.score),
      detail: r.detail,
    })),
    total: Number(total?.n ?? 0),
    page,
    pageSize: OPPORTUNITY_PAGE_SIZE,
  };
}
