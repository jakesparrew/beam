/** Merge preview query (crm spec 4.3), implemented by crm-P4. crm-P1 stub. */
import type { DbOrTx } from "@beam/db";
import { NotImplementedError } from "@beam/core/errors";
import type { MergeField } from "@beam/core/crm";

export type MergePreview = {
  fields: Array<{ field: MergeField; winner: unknown; loser: unknown }>;
  counts: Record<string, number>;
  conflicts: string[];
  versions: { winner: number; loser: number };
};

export function getMergePreview(_tx: DbOrTx, _winnerId: string, _loserId: string): Promise<MergePreview> {
  return Promise.reject(new NotImplementedError("crm.getMergePreview"));
}
