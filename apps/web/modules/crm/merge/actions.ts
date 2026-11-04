"use server";
/** Merge action (crm rules 3.30 to 3.34), crm-P4: the staff screen's "Merge persons" button. */
import { z } from "zod";
import { MERGE_FIELDS } from "@beam/core/crm";
import { action } from "@/lib/action";
import { ConflictError } from "@/lib/ctx";
import { executeMerge, lockPair } from "./execute";

/**
 * Locks both persons, checks the versions the compare screen showed (`conflict` `stale_version`),
 * then runs `executeMerge` in the action's transaction. Audit `person.merge` (old = both
 * versions, new = the winner) is written by `executeMerge`.
 */
export const mergePersons = action(
  {
    name: "crm.merge_persons",
    audience: "staff",
    permission: "persons.merge",
    input: z.object({
      winnerId: z.uuid(),
      loserId: z.uuid(),
      winnerVersion: z.number().int().positive(),
      loserVersion: z.number().int().positive(),
      fieldChoices: z.partialRecord(z.enum(MERGE_FIELDS), z.enum(["winner", "loser"])),
    }),
    audit: false,
  },
  async (ctx, input): Promise<{ mergeId: string; repointed: Record<string, number> }> => {
    const { winner, loser } = await lockPair(ctx.tx, input.winnerId, input.loserId);
    if (winner.version !== input.winnerVersion || loser.version !== input.loserVersion) throw new ConflictError("stale_version");
    return executeMerge(ctx.tx, ctx, { winnerId: input.winnerId, loserId: input.loserId, fieldChoices: input.fieldChoices });
  },
);
