/**
 * Guardian-consent api (crm rule 3.54, cross-module D15), crm-P3. `person_declarations` holds only
 * `guardian_consent`; house rules and the health declaration belong to site and forms.
 */
import type { DbOrTx, Tx } from "@beam/db";
import { personDeclarations, persons } from "@beam/db/schema";
import { declarationIsValid, guardian_consent, type DeclarationMethod } from "@beam/core/crm";
import { actorJson, and, ConflictError, desc, eq, inArray, NotFoundError, ValidationError } from "@/lib/ctx";
import { getCurrentLegalVersion } from "@/modules/site/api";
import type { EventCtx } from "../api";
import { resolvePersonIds } from "../persons/api";

export { guardian_consent };

/**
 * The latest guardian-consent row across the person and everyone merged into it (rule 3.32:
 * `person_declarations` is append-only and stays on a merged loser). Read from the table, not
 * `v_declaration_current`, which has no `id` to break ties across persons.
 */
async function latestGuardianConsent(db: DbOrTx, personId: string): Promise<typeof personDeclarations.$inferSelect | undefined> {
  const ids = await resolvePersonIds(db, personId);
  const [latest] = await db
    .select()
    .from(personDeclarations)
    .where(and(inArray(personDeclarations.personId, ids), eq(personDeclarations.kind, guardian_consent)))
    .orderBy(desc(personDeclarations.acceptedAt), desc(personDeclarations.id))
    .limit(1);
  return latest;
}

/**
 * True when the latest guardian consent (across merged persons) is accepted, unexpired and for
 * the current version (or one the site marked as not requiring re-acceptance).
 */
export async function hasValidDeclaration(db: DbOrTx, input: { personId: string; kind: "guardian_consent" }): Promise<boolean> {
  if (input.kind !== guardian_consent) return false;
  const personId = await canonical(db, input.personId);
  if (!personId) return false;
  const latest = await latestGuardianConsent(db, personId);
  const now = new Date();
  if (!latest || latest.status !== "accepted" || (latest.expiresAt && latest.expiresAt.getTime() <= now.getTime())) return false;
  const current = await getCurrentLegalVersion(db, guardian_consent);
  return declarationIsValid({
    latest: { status: latest.status, documentVersionId: latest.documentVersionId, expiresAt: latest.expiresAt },
    currentVersionId: current?.versionId ?? null,
    requiresReacceptance: current?.requiresReacceptance ?? true,
    now,
  });
}

/** Appends an `accepted` row for the current published guardian-consent version (rule 3.54). */
export async function acceptDeclaration(
  tx: Tx,
  ctx: EventCtx,
  input: { personId: string; guardianPersonId: string; method: DeclarationMethod; ip?: string | null },
): Promise<{ declarationId: string; documentVersion: number }> {
  const personId = await activeId(tx, input.personId);
  const guardianId = await activeId(tx, input.guardianPersonId);
  if (guardianId === personId) throw new ValidationError("guardian_is_person", { guardianPersonId: "guardian_is_person" });
  const current = await getCurrentLegalVersion(tx, guardian_consent);
  if (!current) throw new ValidationError("no_published_version", { kind: "no_published_version" });
  const [row] = await tx
    .insert(personDeclarations)
    .values({
      personId,
      kind: guardian_consent,
      documentVersionId: current.versionId,
      documentVersion: current.version,
      status: "accepted",
      method: input.method,
      acceptedAt: ctx.now,
      guardianPersonId: guardianId,
      ip: input.ip ?? null,
      actor: actorJson(ctx.actor),
    })
    .returning({ id: personDeclarations.id });
  await ctx.recordEvent({
    kind: "declaration.accepted",
    personId,
    data: { kind: guardian_consent, document_version: current.version, method: input.method },
    ref: { type: "person_declaration", id: row!.id },
  });
  return { declarationId: row!.id, documentVersion: current.version };
}

/**
 * Appends a `revoked` row (to the canonical person) on top of the latest accepted one across
 * merged persons; `conflict` when nothing is accepted.
 */
export async function revokeLatestDeclaration(tx: Tx, ctx: EventCtx, input: { personId: string; method: DeclarationMethod }): Promise<{ declarationId: string }> {
  const personId = await activeId(tx, input.personId);
  const latest = await latestGuardianConsent(tx, personId);
  if (!latest || latest.status !== "accepted") throw new ConflictError("no_accepted_declaration");
  // The revocation must sort after the acceptance it revokes (reads order by accepted_at, across merged persons).
  const acceptedAt = ctx.now.getTime() > latest.acceptedAt.getTime() ? ctx.now : new Date(latest.acceptedAt.getTime() + 1);
  const [row] = await tx
    .insert(personDeclarations)
    .values({
      personId,
      kind: guardian_consent,
      documentVersionId: latest.documentVersionId,
      documentVersion: latest.documentVersion,
      status: "revoked",
      method: input.method,
      acceptedAt,
      guardianPersonId: latest.guardianPersonId,
      actor: actorJson(ctx.actor),
    })
    .returning({ id: personDeclarations.id });
  await ctx.recordEvent({ kind: "declaration.revoked", personId, data: { kind: guardian_consent }, ref: { type: "person_declaration", id: row!.id } });
  return { declarationId: row!.id };
}

/** Follows merges; null for an unknown or erased person. */
async function canonical(db: DbOrTx, personId: string): Promise<string | null> {
  let id = personId;
  for (let i = 0; i < 5; i++) {
    const [row] = await db.select({ id: persons.id, into: persons.mergedIntoPersonId, erasedAt: persons.erasedAt }).from(persons).where(eq(persons.id, id));
    if (!row || row.erasedAt) return null;
    if (!row.into) return row.id;
    id = row.into;
  }
  return null;
}

async function activeId(db: DbOrTx, personId: string): Promise<string> {
  const id = await canonical(db, personId);
  if (!id) throw new NotFoundError("person_not_found");
  return id;
}
