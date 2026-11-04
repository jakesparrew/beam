/**
 * ops jobs, area `stats` (ops spec 4.4, rules 1-18 and 71): `ops.refresh_person_stats`,
 * `ops.refresh_recent_stats`, `ops.refresh_person`, `ops.daily_digest`. Registered in
 * `../jobs.ts` by ops-P1 with these names, inputs and signatures. Every handler is idempotent:
 * a second run with the same payload leaves the same rows (events dedupe on their keys,
 * continuations on their job keys).
 */
import { z } from "zod";
import { brusselsDate } from "@beam/core/ops";
import { sql } from "@/lib/ctx";
import type { JobCtx } from "@/lib/job-runner";
import { rowsOf } from "@/lib/sensitive";
import { refreshPersonStats } from "./api";
import { STATS_KINDS, STATS_KIND_PREFIXES, computeStatsSql, deleteStaleStats, emitStatsEvents, loadRetentionDefaults } from "./compute";
import { runDigest } from "./digest";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** `{ runOn?, afterId? }`; continuations carry both (key `stats:nightly:<runOn>:<afterId>`). */
export const RefreshPersonStatsInput = z.object({ runOn: isoDate.optional(), afterId: z.uuid().optional() });
export const RefreshRecentStatsInput = z.object({});
export const RefreshPersonInput = z.object({ personId: z.uuid() });
export const DailyDigestInput = z.object({});

/** Rule 5: persons per nightly job. */
export const NIGHTLY_CHUNK = 2_000;
/** Rule 6: persons per recent refresh. */
export const RECENT_LIMIT = 1_000;

/** The continuation key of the nightly run. */
export const nightlyKey = (runOn: string, afterId: string) => `stats:nightly:${runOn}:${afterId}`;

/**
 * Rule 5: 2,000 people per job ordered by `person_id`, then enqueues the next chunk. Emits the
 * stage-change and inactivity events of the chunk. The first chunk also removes the stats rows
 * of erased and merged persons (edge case 2).
 */
export async function runRefreshPersonStats(ctx: JobCtx, input: z.infer<typeof RefreshPersonStatsInput>): Promise<unknown> {
  const runOn = input.runOn ?? brusselsDate(ctx.now);
  const deleted = input.afterId ? 0 : await deleteStaleStats(ctx.tx);
  const cfg = await loadRetentionDefaults(ctx.tx);
  const result = await computeStatsSql(ctx.tx, { afterId: input.afterId, limit: NIGHTLY_CHUNK, now: ctx.now, cfg });
  const events = await emitStatsEvents(ctx.tx, result, { inactivity: true });
  let next: string | null = null;
  if (result.upserted === NIGHTLY_CHUNK && result.lastId) {
    await ctx.enqueue({ kind: "ops.refresh_person_stats", payload: { runOn, afterId: result.lastId }, key: nightlyKey(runOn, result.lastId) });
    next = result.lastId;
  }
  return { runOn, upserted: result.upserted, deleted, next, ...events };
}

type Cursor = { event_id: string };
const STATS_CURSOR = "stats_cursor";

/** The matching-kind filter of rule 6 over `activity_events a`. */
function statsKindFilter() {
  const kinds = `{${STATS_KINDS.join(",")}}`;
  const prefixes = STATS_KIND_PREFIXES.map((p) => sql`a.kind like ${`${p}%`}`);
  return sql`(a.kind = any(${kinds}::text[]) or ${sql.join(prefixes, sql` or `)})`;
}

/**
 * Rule 6: recomputes the people with a `STATS_KINDS` event after `ops_state.stats_cursor`, at
 * most 1,000 per run, then advances the cursor (never backwards). The run locks the cursor row
 * with `for update skip locked` and exits at once when a slower run still holds it.
 */
export async function runRefreshRecentStats(ctx: JobCtx, _input: z.infer<typeof RefreshRecentStatsInput>): Promise<unknown> {
  await ctx.tx.execute(sql`insert into ops_state (key, value) values (${STATS_CURSOR}, ${JSON.stringify({ event_id: "0" })}::jsonb)
    on conflict (key) do nothing`);
  const locked = rowsOf<{ value: Cursor }>(
    await ctx.tx.execute(sql`select value from ops_state where key = ${STATS_CURSOR} for update skip locked`),
  );
  if (locked.length === 0) return { skipped: "locked" };
  const from = BigInt(String(locked[0]!.value?.event_id ?? "0").replace(/\D/g, "") || "0");

  const persons = rowsOf<{ person_id: string; first_id: string | number | bigint }>(
    await ctx.tx.execute(sql`select a.person_id, min(a.id) as first_id from activity_events a
      where a.id > ${from.toString()}::bigint and a.person_id is not null and ${statsKindFilter()}
      group by a.person_id order by min(a.id) limit ${RECENT_LIMIT + 1}`),
  );
  let to: bigint;
  if (persons.length > RECENT_LIMIT) {
    // Every event before the first event of person 1,001 belongs to a person refreshed now.
    to = BigInt(String(persons[RECENT_LIMIT]!.first_id)) - 1n;
  } else {
    const max = rowsOf<{ max_id: string | number | bigint | null }>(
      await ctx.tx.execute(sql`select max(a.id) as max_id from activity_events a
        where a.id > ${from.toString()}::bigint and a.person_id is not null and ${statsKindFilter()}`),
    )[0]?.max_id;
    to = max === null || max === undefined ? from : BigInt(String(max));
  }
  const ids = persons.slice(0, RECENT_LIMIT).map((p) => String(p.person_id));
  const result = await computeStatsSql(ctx.tx, { personIds: ids, limit: RECENT_LIMIT, now: ctx.now });
  const events = await emitStatsEvents(ctx.tx, result, { inactivity: false });
  const next = to > from ? to : from;
  await ctx.tx.execute(sql`update ops_state set value = ${JSON.stringify({ event_id: next.toString() })}::jsonb, updated_at = now()
    where key = ${STATS_CURSOR} and (value->>'event_id')::bigint <= ${next.toString()}::bigint`);
  return { persons: ids.length, upserted: result.upserted, cursor: next.toString(), ...events };
}

/** Rule 7: one person (`requestStatsRefresh`); a person erased or merged meanwhile is skipped. */
export async function runRefreshPerson(ctx: JobCtx, input: z.infer<typeof RefreshPersonInput>): Promise<unknown> {
  try {
    const row = await refreshPersonStats(ctx.tx, input.personId);
    return { personId: row.personId, b2cStage: row.b2cStage };
  } catch (error) {
    if ((error as { code?: string } | null)?.code === "not_found") return { skipped: "not_found" };
    throw error;
  }
}

/** Rule 71: one Slack message per day through `notifySlack` with fingerprint `digest`. */
export async function runDailyDigest(ctx: JobCtx, _input: z.infer<typeof DailyDigestInput>): Promise<unknown> {
  return runDigest(ctx);
}
