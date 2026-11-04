"use server";
/** Duplicate review actions (crm spec 4.1), crm-P4: "not a duplicate" closes an open pair for good. */
import { z } from "zod";
import { action } from "@/lib/action";
import { AppError, NotFoundError, sql } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";

/**
 * Marks an `open` candidate `dismissed` (rule 3.28: never proposed again). `not_found` for an
 * unknown id, `conflict` when the pair was already merged or dismissed. Audit `person.duplicate_dismiss`.
 */
export const dismissDuplicate = action(
  { name: "crm.dismiss_duplicate", audience: "staff", permission: "persons.merge", input: z.object({ candidateId: z.uuid() }), audit: false },
  async (ctx, input): Promise<Record<string, never>> => {
    const userId = ctx.actor.kind === "staff" ? ctx.actor.userId : null;
    const rows = rowsOf<{ id: string; status: string; person_a_id: string; person_b_id: string; score: number }>(
      await ctx.tx.execute(sql`select id, status, person_a_id, person_b_id, score from person_duplicate_candidates where id = ${input.candidateId} for update`),
    );
    const row = rows[0];
    if (!row) throw new NotFoundError("candidate_not_found");
    if (row.status !== "open") throw new AppError("conflict", `candidate_${row.status}`);
    await ctx.tx.execute(sql`
      update person_duplicate_candidates
      set status = 'dismissed', reviewed_by_user_id = ${userId}, reviewed_at = ${ctx.now}, updated_at = now()
      where id = ${row.id}
    `);
    await ctx.audit({
      action: "person.duplicate_dismiss",
      entityType: "person_duplicate_candidate",
      entityId: row.id,
      personId: row.person_a_id,
      oldValue: { status: "open" },
      newValue: { status: "dismissed", person_a_id: row.person_a_id, person_b_id: row.person_b_id, score: Number(row.score) },
    });
    return {};
  },
);
