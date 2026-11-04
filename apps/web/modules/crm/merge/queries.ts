/** Merge preview query (crm spec 4.3, screen `/admin/persons/[id]/merge`), crm-P4. */
import type { DbOrTx } from "@beam/db";
import { persons } from "@beam/db/schema";
import { MERGE_FIELDS, type MergeField } from "@beam/core/crm";
import { AppError, inArray, NotFoundError } from "@/lib/ctx";
import { countLoserReferences, findMergeConflicts, type MergeConflict } from "./execute";

export type MergePreview = {
  fields: Array<{ field: MergeField; winner: unknown; loser: unknown }>;
  counts: Record<string, number>;
  conflicts: MergeConflict[];
  versions: { winner: number; loser: number };
};

/**
 * The field-by-field compare of two active persons, the loser's row count per table the merge
 * moves, and the blocking conflicts of rule 3.31. `not_found` for an unknown person, `conflict`
 * when either is erased or already merged.
 */
export async function getMergePreview(tx: DbOrTx, winnerId: string, loserId: string): Promise<MergePreview> {
  if (winnerId === loserId) throw new AppError("validation", "same_person", { loserId: "same_person" });
  const rows = await tx.select().from(persons).where(inArray(persons.id, [winnerId, loserId]));
  const winner = rows.find((r) => r.id === winnerId);
  const loser = rows.find((r) => r.id === loserId);
  if (!winner || !loser) throw new NotFoundError("person_not_found");
  if (winner.erasedAt || loser.erasedAt) throw new AppError("conflict", "person_erased");
  if (winner.mergedIntoPersonId || loser.mergedIntoPersonId) throw new AppError("conflict", "person_already_merged");
  return {
    fields: MERGE_FIELDS.map((field) => ({ field, winner: winner[field] ?? null, loser: loser[field] ?? null })),
    counts: await countLoserReferences(tx, loserId),
    conflicts: await findMergeConflicts(tx, winnerId, loserId),
    versions: { winner: winner.version, loser: loser.version },
  };
}
