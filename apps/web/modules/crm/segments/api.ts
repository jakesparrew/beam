/**
 * Segment api (crm spec 4.6, 4.8; rules 3.38 to 3.41), crm-P5.
 *
 * A refresh takes `pg_advisory_xact_lock(hashtext('segment:' || id))`, so a scheduled, a manual
 * and a campaign refresh of one segment run one after the other; it then computes the rule
 * result in one statement (data-modifying CTEs): new members are inserted `on conflict do
 * nothing`, departed ones deleted, and one `segment.entered` / `segment.left` event per change
 * is written with the dedupe key `segment:<id>:<enter|leave>:<person_id>:<YYYY-MM-DDTHH>` (UTC).
 * A second refresh with no data change writes nothing. A failing refresh keeps the previous
 * members (the work runs in a savepoint) and stores `refresh_error`.
 */
import type { DbOrTx, Tx } from "@beam/db";
import { segments } from "@beam/db/schema";
import { actorJson, and, asc, eq, isNotNull, NotFoundError, sql, type SQL } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
import type { EventCtx } from "../api";
import { ruleAudienceSql, storedAudienceSql } from "./sql";

export type RefreshReason = "schedule" | "save" | "campaign" | "manual";
export type RefreshResult = { count: number; entered: number; left: number };

/** `select person_id …` of the segment's members minus the excluded segments' members (rule 3.39). */
export function segmentAudienceSql(segmentId: string, excludeSegmentIds?: string[]): SQL {
  return storedAudienceSql(segmentId, excludeSegmentIds ?? []);
}

/** The UTC hour bucket of the event dedupe keys (02-data-model DM-5). */
export const hourBucket = (at: Date): string => at.toISOString().slice(0, 13);

/** `segment:<id>:<enter|leave>:<person_id>:<YYYY-MM-DDTHH>` as SQL over a `person_id` column. */
const dedupeSql = (segmentId: string, dir: "enter" | "leave", now: Date, column: SQL) =>
  sql`'segment:' || ${segmentId}::text || ${`:${dir}:`}::text || ${column}::text || ${`:${hourBucket(now)}`}::text`;

/** Takes the segment's transaction-scoped advisory lock (rule 3.40). */
export async function lockSegment(tx: DbOrTx, segmentId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('segment:' || ${segmentId}::text))`);
}

/** The audience size after exclusions (`segments.last_count`). */
export async function countAudience(tx: DbOrTx, segmentId: string): Promise<number> {
  const [row] = rowsOf<{ n: number | string }>(await tx.execute(sql`select count(*)::int as n from (${storedAudienceSql(segmentId)}) a`));
  return Number(row?.n ?? 0);
}

/**
 * Inserts one enter or leave event per person (set-based; same shape `recordEvent` writes for
 * `segment.entered` / `segment.left`, data `{ segment_id }`); duplicates are skipped by dedupe key.
 */
export async function writeMembershipEvents(tx: DbOrTx, ctx: Pick<EventCtx, "actor" | "now">, segmentId: string, dir: "enter" | "leave", personIds: readonly string[]): Promise<void> {
  if (!personIds.length) return;
  const kind = dir === "enter" ? "segment.entered" : "segment.left";
  const actor = JSON.stringify(actorJson(ctx.actor));
  const data = JSON.stringify({ segment_id: segmentId });
  await tx.execute(sql`
    insert into activity_events (person_id, kind, occurred_at, is_sensitive, actor, ref_type, ref_id, data, dedupe_key)
    select x.id, ${kind}, ${ctx.now.toISOString()}::timestamptz, false, ${actor}::jsonb, 'segment', ${segmentId}, ${data}::jsonb,
           ${dedupeSql(segmentId, dir, ctx.now, sql`x.id`)}
    from unnest(${`{${personIds.join(",")}}`}::uuid[]) as x(id)
    on conflict (dedupe_key) do nothing`);
}

/** Recomputes a dynamic segment's members in one statement; returns the persons that entered and left. */
async function applyRule(tx: DbOrTx, ctx: Pick<EventCtx, "actor" | "now">, segmentId: string, definition: unknown): Promise<{ entered: number; left: number }> {
  const audience = ruleAudienceSql(definition, ctx.now);
  const now = ctx.now.toISOString();
  const actor = JSON.stringify(actorJson(ctx.actor));
  const data = JSON.stringify({ segment_id: segmentId });
  const event = (kind: string, dir: "enter" | "leave", from: string) => sql`
    insert into activity_events (person_id, kind, occurred_at, is_sensitive, actor, ref_type, ref_id, data, dedupe_key)
    select c.person_id, ${kind}, ${now}::timestamptz, false, ${actor}::jsonb, 'segment', ${segmentId}, ${data}::jsonb,
           ${dedupeSql(segmentId, dir, ctx.now, sql`c.person_id`)}
    from ${sql.raw(from)} c
    on conflict (dedupe_key) do nothing
    returning 1`;
  const [row] = rowsOf<{ entered: number | string; left: number | string }>(
    await tx.execute(sql`
      with target as (${audience}),
      ins as (
        insert into segment_members (segment_id, person_id, source, computed_at)
        select ${segmentId}::uuid, t.person_id, 'rule', ${now}::timestamptz from (select distinct person_id from target) t
        on conflict (segment_id, person_id) do nothing
        returning person_id
      ),
      del as (
        delete from segment_members sm
        where sm.segment_id = ${segmentId}::uuid and not exists (select 1 from target t where t.person_id = sm.person_id)
        returning sm.person_id
      ),
      ev_in as (${event("segment.entered", "enter", "ins")}),
      ev_out as (${event("segment.left", "leave", "del")})
      select (select count(*) from ins)::int as entered, (select count(*) from del)::int as left,
             (select count(*) from ev_in) + (select count(*) from ev_out) as events`),
  );
  return { entered: Number(row?.entered ?? 0), left: Number(row?.left ?? 0) };
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 500);

/** Thrown by a failing refresh after `refresh_error` was stored; `cause` is the original error. */
export class SegmentRefreshError extends Error {
  override readonly name = "SegmentRefreshError";
  constructor(
    readonly segmentId: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(`segment_refresh_failed: ${message}`, options);
  }
}

/**
 * The refresh of rule 3.40 for any reason. Static segments are not recomputed (their member
 * list is manual); archived segments are left as they are. Both still get their count.
 */
export async function refreshSegmentInTx(tx: Tx, ctx: Pick<EventCtx, "actor" | "now">, segmentId: string, _reason: RefreshReason): Promise<RefreshResult> {
  await lockSegment(tx, segmentId);
  const [seg] = await tx.select().from(segments).where(eq(segments.id, segmentId)).for("update");
  if (!seg) throw new NotFoundError("segment_not_found");
  let changes = { entered: 0, left: 0 };
  if (seg.kind === "dynamic" && !seg.isArchived) {
    try {
      changes = await tx.transaction((sp) => applyRule(sp, ctx, segmentId, seg.definition));
    } catch (error) {
      const message = errorText(error);
      await tx.update(segments).set({ refreshError: message }).where(eq(segments.id, segmentId));
      throw new SegmentRefreshError(segmentId, message, { cause: error });
    }
  }
  const count = await countAudience(tx, segmentId);
  await tx.update(segments).set({ lastCount: count, lastCountedAt: ctx.now, refreshError: null }).where(eq(segments.id, segmentId));
  return { count, ...changes };
}

export function refreshSegment(tx: Tx, ctx: EventCtx, segmentId: string, reason: "campaign" | "manual" | "save"): Promise<{ count: number; entered: number; left: number }> {
  return refreshSegmentInTx(tx, ctx, segmentId, reason);
}

/** Whether the person (or the person a merged id now points to) is in the segment's audience. */
export async function isInSegment(tx: DbOrTx, segmentId: string, personId: string): Promise<boolean> {
  const rows = rowsOf<{ hit: boolean }>(
    await tx.execute(sql`
      select exists (
        select 1 from (${storedAudienceSql(segmentId)}) a
        where a.person_id = coalesce((select p.merged_into_person_id from persons p where p.id = ${personId}::uuid), ${personId}::uuid)
      ) as hit`),
  );
  return rows[0]?.hit === true;
}

/** Counts over a segment's audience: never a member, never a person field (email-P10 AI drafts). */
export type SegmentAggregates = {
  id: string;
  name: string;
  total: number;
  byStatus: Record<"lead" | "customer" | "member", number>;
  byLocale: Record<"nl-BE" | "fr-BE" | "en", number>;
  /** The median of whole days since the last visit over the members who visited; null when none did. */
  medianDaysSinceLastVisit: number | null;
};

/**
 * The stored audience of a segment (members minus exclusions, `segmentAudienceSql`) counted per
 * commercial status and language, with the median days since the last visit at `now`, read from
 * `v_person_profile` (the read model segment rules use). `null` for an unknown segment.
 */
export async function getSegmentAggregates(tx: DbOrTx, segmentId: string, now: Date = new Date()): Promise<SegmentAggregates | null> {
  const ref = await getSegmentRef(tx, segmentId);
  if (!ref) return null;
  const [row] = rowsOf<{ total: number; lead: number; customer: number; member: number; nl: number; fr: number; en: number; median_days: number | string | null }>(
    await tx.execute(sql`
      with a as (select distinct person_id from (${storedAudienceSql(segmentId)}) s)
      select
        count(*)::int as total,
        count(*) filter (where coalesce(v.status, 'lead') = 'lead')::int as lead,
        count(*) filter (where v.status = 'customer')::int as customer,
        count(*) filter (where v.status = 'member')::int as member,
        count(*) filter (where p.locale = 'nl-BE')::int as nl,
        count(*) filter (where p.locale = 'fr-BE')::int as fr,
        count(*) filter (where p.locale = 'en')::int as en,
        percentile_cont(0.5) within group (order by extract(epoch from (${now.toISOString()}::timestamptz - v.last_visit_at)) / 86400.0)
          filter (where v.last_visit_at is not null) as median_days
      from a
      join persons p on p.id = a.person_id
      left join v_person_profile v on v.person_id = a.person_id`),
  );
  const n = (v: unknown) => Number(v ?? 0);
  return {
    id: ref.id,
    name: ref.name,
    total: n(row?.total),
    byStatus: { lead: n(row?.lead), customer: n(row?.customer), member: n(row?.member) },
    byLocale: { "nl-BE": n(row?.nl), "fr-BE": n(row?.fr), en: n(row?.en) },
    medianDaysSinceLastVisit: row?.median_days === null || row?.median_days === undefined ? null : Math.round(Number(row.median_days)),
  };
}

export async function getSegmentRef(tx: DbOrTx, segmentId: string): Promise<{ id: string; name: string; kind: "dynamic" | "static"; isArchived: boolean } | null> {
  const [row] = await tx
    .select({ id: segments.id, name: segments.name, kind: segments.kind, isArchived: segments.isArchived })
    .from(segments)
    .where(eq(segments.id, segmentId));
  return row ?? null;
}

/** ops daily digest: non-archived segments whose last refresh failed. */
export async function countSegmentRefreshErrors(tx: DbOrTx): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(segments)
    .where(and(eq(segments.isArchived, false), isNotNull(segments.refreshError)));
  return Number(row?.n ?? 0);
}

/** R4 email AI drafts; non-archived segments only, no person data. */
export async function getSegmentSummaries(
  tx: DbOrTx,
): Promise<Array<{ id: string; name: string; description: string | null; kind: "dynamic" | "static"; lastCount: number | null; lastCountedAt: Date | null }>> {
  return tx
    .select({
      id: segments.id,
      name: segments.name,
      description: segments.description,
      kind: segments.kind,
      lastCount: segments.lastCount,
      lastCountedAt: segments.lastCountedAt,
    })
    .from(segments)
    .where(eq(segments.isArchived, false))
    .orderBy(asc(segments.name), asc(segments.id));
}
