"use server";
/** Merge action (crm rules 3.30 to 3.34), implemented by crm-P4. crm-P1 stub. */
import { z } from "zod";
import { NotImplementedError } from "@beam/core/errors";
import { MERGE_FIELDS } from "@beam/core/crm";
import { action } from "@/lib/action";

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
  },
  (): Promise<{ mergeId: string; repointed: Record<string, number> }> => Promise.reject(new NotImplementedError("crm.merge_persons")),
);
