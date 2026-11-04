/** Segment api (crm spec 4.6, 4.8), implemented by crm-P5. crm-P1 stub with the final signatures. */
import type { DbOrTx, Tx } from "@beam/db";
import { NotImplementedError } from "@beam/core/errors";
import type { SQL } from "@/lib/ctx";
import type { EventCtx } from "../api";

const notYet = <T>(fn: string): Promise<T> => Promise.reject(new NotImplementedError(`crm.${fn}`));

/** `select person_id …` of the segment's members minus the excluded segments' members (rule 3.39). */
export function segmentAudienceSql(_segmentId: string, _excludeSegmentIds?: string[]): SQL {
  throw new NotImplementedError("crm.segmentAudienceSql");
}

export function refreshSegment(
  _tx: Tx,
  _ctx: EventCtx,
  _segmentId: string,
  _reason: "campaign" | "manual" | "save",
): Promise<{ count: number; entered: number; left: number }> {
  return notYet("refreshSegment");
}

export function isInSegment(_tx: DbOrTx, _segmentId: string, _personId: string): Promise<boolean> {
  return notYet("isInSegment");
}

export function getSegmentRef(
  _tx: DbOrTx,
  _segmentId: string,
): Promise<{ id: string; name: string; kind: "dynamic" | "static"; isArchived: boolean } | null> {
  return notYet("getSegmentRef");
}

/** ops daily digest. */
export function countSegmentRefreshErrors(_tx: DbOrTx): Promise<number> {
  return notYet("countSegmentRefreshErrors");
}

/** R4 email AI drafts; non-archived segments only, no person data. */
export function getSegmentSummaries(
  _tx: DbOrTx,
): Promise<Array<{ id: string; name: string; description: string | null; kind: "dynamic" | "static"; lastCount: number | null; lastCountedAt: Date | null }>> {
  return notYet("getSegmentSummaries");
}
