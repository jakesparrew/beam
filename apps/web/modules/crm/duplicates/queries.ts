/** Duplicate queue queries (crm spec 4.3), implemented by crm-P4. crm-P1 stub. */
import type { DbOrTx } from "@beam/db";
import { NotImplementedError } from "@beam/core/errors";
import type { DuplicateReason } from "@beam/core/crm";

export type DuplicateCandidateRow = {
  id: string;
  score: number;
  reasons: DuplicateReason[];
  status: "open" | "merged" | "dismissed";
  personA: { id: string; customerNumber: string; name: string; email: string | null; createdAt: Date };
  personB: { id: string; customerNumber: string; name: string; email: string | null; createdAt: Date };
};

export function listDuplicateCandidates(_tx: DbOrTx, _input: { status?: "open" | "merged" | "dismissed"; minScore?: number }): Promise<DuplicateCandidateRow[]> {
  return Promise.reject(new NotImplementedError("crm.listDuplicateCandidates"));
}
