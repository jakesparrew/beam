/**
 * The B2C pipeline board (ops rules 9-14a, ops-P7, R2): one column per `person_stats.b2c_stage`
 * with its count and the 50 people whose stage changed most recently. The stage is derived only
 * (rule 14). The `member` column is labelled "Member / high value" (rule 14a): a high-value
 * person of another stage keeps that stage and carries a badge (`is_high_value`), and the
 * `highValue` filter shows only them.
 *
 * People are the rows of `person_stats` whose person is in `v_person_profile` (not erased,
 * merged or restricted) and is not a tester (rule 41). Filters: acquisition source and campaign
 * (exact, case-insensitive) and high value.
 */
import type { DbOrTx } from "@beam/db";
import { B2C_STAGES, type B2cStage } from "@beam/core/ops";
import { sql, type SQL } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";

export type PipelineFilters = { source?: string; campaign?: string; highValue?: boolean };

export type PipelinePerson = {
  personId: string;
  name: string | null;
  stage: B2cStage;
  stageChangedAt: Date | null;
  isHighValue: boolean;
  revenueCents: number;
  acquisitionSource: string | null;
  acquisitionCampaign: string | null;
};

export type PipelineColumn = { stage: B2cStage; count: number; highValueCount: number; people: PipelinePerson[] };

export type PipelineBoard = { columns: PipelineColumn[]; filters: PipelineFilters; page: number; pageSize: number };

/** The people shown per column (and per page of one stage). */
export const PIPELINE_PAGE_SIZE = 50;

function filterSql(f: PipelineFilters): SQL {
  const parts: SQL[] = [sql`pp.is_tester = false`];
  if (f.source) parts.push(sql`lower(pp.acquisition_source) = lower(${f.source})`);
  if (f.campaign) parts.push(sql`lower(pp.acquisition_campaign) = lower(${f.campaign})`);
  if (f.highValue) parts.push(sql`pp.is_high_value`);
  return sql.join(parts, sql` and `);
}

const asBool = (v: unknown) => v === true || v === "t" || v === "true";

/**
 * Counts per stage and the most recent changes per stage (`page` pages through one `stage`;
 * every other column then holds its count only).
 */
export async function computePipelineBoard(db: DbOrTx, input: { stage?: B2cStage; page?: number; filters?: PipelineFilters } = {}): Promise<PipelineBoard> {
  const filters = input.filters ?? {};
  const page = Math.max(1, Math.trunc(input.page ?? 1));
  const where = filterSql(filters);
  const from = sql`person_stats ps join v_person_profile pp on pp.person_id = ps.person_id`;

  const counts = rowsOf<{ stage: B2cStage; n: unknown; hv: unknown }>(
    await db.execute(sql`select ps.b2c_stage::text as stage, count(*)::int as n, count(*) filter (where pp.is_high_value)::int as hv
      from ${from} where ${where} group by ps.b2c_stage`),
  );
  const offset = input.stage ? (page - 1) * PIPELINE_PAGE_SIZE : 0;
  const people = rowsOf<Record<string, unknown>>(
    await db.execute(sql`select * from (
        select ps.person_id, ps.b2c_stage::text as stage, ps.b2c_stage_changed_at, pp.is_high_value, ps.revenue_cents,
               pp.acquisition_source, pp.acquisition_campaign, nullif(trim(concat_ws(' ', pe.first_name, pe.last_name)), '') as name,
               row_number() over (partition by ps.b2c_stage order by ps.b2c_stage_changed_at desc nulls last, ps.person_id) as rn
        from ${from} join persons pe on pe.id = ps.person_id
        where ${where} ${input.stage ? sql`and ps.b2c_stage = ${input.stage}` : sql``}) x
      where x.rn > ${offset} and x.rn <= ${offset + PIPELINE_PAGE_SIZE} order by x.stage, x.rn`),
  );

  const byStage = new Map(counts.map((c) => [c.stage, c]));
  return {
    filters,
    page,
    pageSize: PIPELINE_PAGE_SIZE,
    columns: B2C_STAGES.map((stage) => ({
      stage,
      count: Number(byStage.get(stage)?.n ?? 0),
      highValueCount: Number(byStage.get(stage)?.hv ?? 0),
      people: people
        .filter((p) => p.stage === stage)
        .map((p) => ({
          personId: String(p.person_id),
          name: (p.name as string | null) ?? null,
          stage,
          stageChangedAt: p.b2c_stage_changed_at ? new Date(p.b2c_stage_changed_at as string) : null,
          isHighValue: asBool(p.is_high_value),
          revenueCents: Number(p.revenue_cents ?? 0),
          acquisitionSource: (p.acquisition_source as string | null) ?? null,
          acquisitionCampaign: (p.acquisition_campaign as string | null) ?? null,
        })),
    })),
  };
}
