/**
 * ops' cross-module door (02-data-model section 6.10). Wave 0 stubs by platform-P7 with the
 * owner's final signatures: each throws `NotImplementedError('ops.<fn>')` until ops implements
 * it. `isDpiaApproved` is platform-P5's forward stub, kept unchanged (DR-10): platform's
 * sensitive-AI switch (PL-55) calls it.
 */
import type { DbOrTx, Tx } from "@beam/db";
import { NotImplementedError } from "@beam/core/errors";
import type { DpiaKey, PrivacyKind, PrivacyStatus, RetentionReason } from "@beam/core/ops";
import type { Ctx } from "@/lib/ctx";

export type { DpiaKey, ModuleId, PrivacyKind, PrivacyStatus, RetentionReason } from "@beam/core/ops";
export { ERASE_ORDER } from "@beam/core/ops";

const notYet = <T>(fn: string): Promise<T> => Promise.reject(new NotImplementedError(`ops.${fn}`));

/**
 * A row of ops' `person_stats` (`typeof personStats.$inferSelect` once ops-P1 adds the table;
 * the Wave 0 schema has no `person_stats`, so the shape is open until then).
 */
export type PersonStats = { personId: string } & Record<string, unknown>;

export function getPersonStats(_db: DbOrTx, _personId: string): Promise<PersonStats | null> {
  return notYet("getPersonStats");
}

export function refreshPersonStats(_tx: Tx, _personId: string): Promise<PersonStats> {
  return notYet("refreshPersonStats");
}

/** Enqueues ops.refresh_person. */
export function requestStatsRefresh(_tx: Tx, _personId: string): Promise<void> {
  return notYet("requestStatsRefresh");
}

/** Reads only `persons.processing_restricted_at` (D12). */
export function isProcessingRestricted(_db: DbOrTx, _personId: string): Promise<boolean> {
  return notYet("isProcessingRestricted");
}

export function listRetentionReasons(
  _db: DbOrTx,
  _personId: string,
): Promise<{ reason: RetentionReason; score: number; detail: Record<string, unknown> }[]> {
  return notYet("listRetentionReasons");
}

export function createPrivacyRequest(
  _ctx: Ctx,
  _input: { personId: string; kind: PrivacyKind; requestedBy: "customer" | "staff" | "system"; verificationNote?: string },
): Promise<{ requestId: string }> {
  return notYet("createPrivacyRequest");
}

export function getOpenPrivacyRequests(_db: DbOrTx, _personId: string): Promise<{ id: string; kind: PrivacyKind; status: PrivacyStatus; dueOn: string }[]> {
  return notYet("getOpenPrivacyRequests");
}

export function isDpiaApproved(db: DbOrTx, key: DpiaKey): Promise<boolean> {
  void db;
  void key;
  return Promise.reject(new NotImplementedError("ops.isDpiaApproved"));
}
