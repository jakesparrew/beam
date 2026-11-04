/**
 * ops cross-module api, area `privacy` (ops spec 4.7; ops-P5). Every function takes the caller's
 * transaction (through `db` or `ctx.tx`, OD-15), so the caller stays one transaction.
 */
import type { DbOrTx } from "@beam/db";
import type { PrivacyKind, PrivacyStatus } from "@beam/core/ops";
import { sql, type Ctx } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
import { createRequest } from "./orchestrator";

export { runEraseStep } from "./orchestrator";
export { buildSubjectExport } from "./export-zip";

/** Reads only `persons.processing_restricted_at` (decision 66). */
export async function isProcessingRestricted(db: DbOrTx, personId: string): Promise<boolean> {
  const rows = rowsOf<{ restricted: boolean }>(
    await db.execute(sql`select (processing_restricted_at is not null) as restricted from persons where id = ${personId}::uuid`),
  );
  return rows[0]?.restricted === true;
}

/**
 * Creates a privacy request (rule 59) in `ctx.tx`. Customer and system requests are verified at
 * once (an erasure is then scheduled 24 hours later; restrict and object are applied at once);
 * system requests (the retention sweep, rule 69) send no email. A second open request of the
 * same kind for the person is a `ConflictError`.
 */
export async function createPrivacyRequest(
  ctx: Ctx,
  input: { personId: string; kind: PrivacyKind; requestedBy: "customer" | "staff" | "system"; verificationNote?: string },
): Promise<{ requestId: string }> {
  const row = await createRequest(ctx, input);
  return { requestId: row.id };
}

/** The person's requests in `received`, `verified` or `running`. */
export async function getOpenPrivacyRequests(db: DbOrTx, personId: string): Promise<{ id: string; kind: PrivacyKind; status: PrivacyStatus; dueOn: string }[]> {
  const rows = rowsOf<{ id: string; kind: PrivacyKind; status: PrivacyStatus; due_on: string | Date }>(
    await db.execute(sql`select id::text as id, kind::text as kind, status::text as status, due_on from privacy_requests
      where person_id = ${personId}::uuid and status in ('received', 'verified', 'running') order by created_at`),
  );
  return rows.map((r) => ({ id: r.id, kind: r.kind, status: r.status, dueOn: typeof r.due_on === "string" ? r.due_on.slice(0, 10) : r.due_on.toISOString().slice(0, 10) }));
}
