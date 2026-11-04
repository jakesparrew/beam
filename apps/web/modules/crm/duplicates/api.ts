/** Duplicate api (crm rule 3.28), implemented by crm-P4. crm-P1 stub with the final signature. */
import type { DbOrTx } from "@beam/db";
import { NotImplementedError } from "@beam/core/errors";
import type { DuplicateReason } from "@beam/core/crm";

/** booking waitlist duplicate flags; `minScore` defaults to 50. */
export function findLikelyDuplicates(
  _tx: DbOrTx,
  _personId: string,
  _minScore?: number,
): Promise<Array<{ personId: string; score: number; reasons: DuplicateReason[] }>> {
  return Promise.reject(new NotImplementedError("crm.findLikelyDuplicates"));
}
