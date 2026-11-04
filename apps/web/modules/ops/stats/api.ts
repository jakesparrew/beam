/**
 * ops cross-module api, area `stats` (ops spec 4.7). Typed stubs by ops-P1 with the final
 * signatures; each throws `NotImplementedError('ops.<fn>')` until ops-P2 implements it here.
 * Callers in other modules mock them with `vi.mock('@/modules/ops/api')`.
 */
import type { DbOrTx, Tx } from "@beam/db";
import type { personStats } from "@beam/db/schema";
import { NotImplementedError } from "@beam/core/errors";
import type { RetentionReason } from "@beam/core/ops";

/** A row of `person_stats` (served request platform-P7: the open row type is narrowed). */
export type PersonStats = typeof personStats.$inferSelect;

const notYet = <T>(fn: string): Promise<T> => Promise.reject(new NotImplementedError(`ops.${fn}`));

/** The cached stats of a person, or null before the first refresh. */
export function getPersonStats(_db: DbOrTx, _personId: string): Promise<PersonStats | null> {
  return notYet("getPersonStats");
}

/** Rule 7: recomputes one person synchronously and returns the new row. */
export function refreshPersonStats(_tx: Tx, _personId: string): Promise<PersonStats> {
  return notYet("refreshPersonStats");
}

/** Enqueues `ops.refresh_person` (key `stats:<personId>:<YYYY-MM-DDTHH:mm>`). */
export function requestStatsRefresh(_tx: Tx, _personId: string): Promise<void> {
  return notYet("requestStatsRefresh");
}

/** The person's rows of `v_retention_candidates`. */
export function listRetentionReasons(
  _db: DbOrTx,
  _personId: string,
): Promise<{ reason: RetentionReason; score: number; detail: Record<string, unknown> }[]> {
  return notYet("listRetentionReasons");
}
