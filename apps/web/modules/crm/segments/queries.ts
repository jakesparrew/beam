/** Segment queries (crm spec 4.3), implemented by crm-P5. crm-P1 stubs. */
import type { DbOrTx } from "@beam/db";
import { NotImplementedError } from "@beam/core/errors";
import type { SegmentRule } from "@beam/core/crm";

export type SegmentRow = {
  id: string;
  name: string;
  description: string | null;
  kind: "dynamic" | "static";
  definition: SegmentRule;
  excludeSegmentIds: string[];
  isArchived: boolean;
  refreshError: string | null;
  lastCount: number | null;
  lastCountedAt: Date | null;
};

const notYet = <T>(fn: string): Promise<T> => Promise.reject(new NotImplementedError(`crm.${fn}`));

export function listSegments(_tx: DbOrTx, _input: { includeArchived: boolean }): Promise<SegmentRow[]> {
  return notYet("listSegments");
}

export function getSegment(_tx: DbOrTx, _id: string): Promise<SegmentRow | null> {
  return notYet("getSegment");
}

/** Live count and a 20-person sample; `sql` only for technical admins. */
export function previewSegment(
  _tx: DbOrTx,
  _input: { definition: SegmentRule; excludeIds: string[]; showSql?: boolean },
): Promise<{ count: number; sample: Array<{ id: string; customerNumber: string; name: string }>; sql?: string }> {
  return notYet("previewSegment");
}
