/**
 * ops cross-module api, area `stats` (ops spec 4.7, rules 5-7 and 19). Other modules import
 * these through `@/modules/ops/api`; tests of those modules mock them with `vi.mock`.
 */
import type { DbOrTx, Tx } from "@beam/db";
import { personStats, vRetentionCandidates } from "@beam/db/schema";
import type { RetentionReason } from "@beam/core/ops";
import { NotFoundError, desc, enqueueJob, eq } from "@/lib/ctx";
import { computeStatsSql, emitStatsEvents } from "./compute";

/** A row of `person_stats` (served request platform-P7: the open row type is narrowed). */
export type PersonStats = typeof personStats.$inferSelect;

/** The cached stats of a person, or null before the first refresh. */
export async function getPersonStats(db: DbOrTx, personId: string): Promise<PersonStats | null> {
  const rows = await db.select().from(personStats).where(eq(personStats.personId, personId)).limit(1);
  return rows[0] ?? null;
}

/**
 * Rule 7: recomputes one person synchronously and returns the new row. A stage change writes
 * its `ops.stage_changed` event (deduped per day); inactivity events stay with the nightly run.
 */
export async function refreshPersonStats(tx: Tx, personId: string): Promise<PersonStats> {
  const result = await computeStatsSql(tx, { personIds: [personId], limit: 1 });
  if (result.upserted === 0) throw new NotFoundError(`person_not_found: ${personId}`);
  await emitStatsEvents(tx, result, { inactivity: false });
  return (await getPersonStats(tx, personId))!;
}

/** The minute key of `stats:<personId>:<YYYY-MM-DDTHH:mm>` (UTC). */
export function statsRefreshKey(personId: string, at: Date = new Date()): string {
  return `stats:${personId}:${at.toISOString().slice(0, 16)}`;
}

/** Enqueues `ops.refresh_person` (key `stats:<personId>:<YYYY-MM-DDTHH:mm>`): one refresh per minute. */
export async function requestStatsRefresh(tx: Tx, personId: string): Promise<void> {
  await enqueueJob(tx, { kind: "ops.refresh_person", payload: { personId }, key: statsRefreshKey(personId) });
}

/** The person's rows of `v_retention_candidates`, highest score first. */
export async function listRetentionReasons(
  db: DbOrTx,
  personId: string,
): Promise<{ reason: RetentionReason; score: number; detail: Record<string, unknown> }[]> {
  return db
    .select({ reason: vRetentionCandidates.reason, score: vRetentionCandidates.score, detail: vRetentionCandidates.detail })
    .from(vRetentionCandidates)
    .where(eq(vRetentionCandidates.personId, personId))
    .orderBy(desc(vRetentionCandidates.score), vRetentionCandidates.reason);
}
