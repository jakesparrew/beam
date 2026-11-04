/**
 * Person matching for imports (ops spec rule 45, ops-P4). Order: an `import_external_ids` row
 * of the same source (persons files, rule 50), then `lower(trim(email))`, then the E.164 phone
 * plus `lower(last_name)` for a row without email. Only active persons match: a merged match
 * resolves to its winner, an erased one never matches. Reads only; `ops` never writes persons.
 */
import type { Tx } from "@beam/db";
import { importExternalIds, persons } from "@beam/db/schema";
import { emailHash, normaliseEmail, normalisePhone } from "@beam/core/crm";
import { and, eq, isNull, sql } from "@/lib/ctx";
import { resolveCanonicalPersonId } from "@/modules/crm/api";
import type { ImportRow } from "./apply";

export type MatchHow = "external_id" | "email" | "phone_name" | "none";

const text = (v: string | null | undefined) => (typeof v === "string" && v.trim() ? v.trim() : null);

async function activeCanonical(tx: Tx, personId: string): Promise<string | null> {
  const id = await resolveCanonicalPersonId(tx, personId);
  const [row] = await tx.select({ id: persons.id }).from(persons).where(and(eq(persons.id, id), isNull(persons.erasedAt), isNull(persons.mergedIntoPersonId)));
  return row?.id ?? null;
}

/** Rule 45. `row` needs `source`, `kind` and the mapped `data` (`external_id`, `email`, `phone`, `last_name`). */
export async function matchPerson(
  tx: Tx,
  row: Pick<ImportRow, "source" | "kind" | "data">,
): Promise<{ personId: string | null; how: MatchHow }> {
  const externalId = row.kind === "persons" ? text(row.data.external_id) : null;
  if (externalId) {
    const [ext] = await tx
      .select({ entityId: importExternalIds.entityId })
      .from(importExternalIds)
      .where(and(eq(importExternalIds.source, row.source), eq(importExternalIds.entityType, "person"), eq(importExternalIds.externalId, externalId.slice(0, 200))))
      .limit(1);
    const id = ext ? await activeCanonical(tx, ext.entityId) : null;
    if (id) return { personId: id, how: "external_id" };
  }

  const rawEmail = text(row.data.email);
  if (rawEmail) {
    const email = normaliseEmail(rawEmail);
    if (!email) return { personId: null, how: "none" };
    const [hit] = await tx
      .select({ id: persons.id })
      .from(persons)
      .where(and(sql`(${persons.emailHash} = ${emailHash(email)} or lower(trim(${persons.email})) = ${email})`, isNull(persons.erasedAt), isNull(persons.mergedIntoPersonId)))
      .orderBy(persons.createdAt, persons.id)
      .limit(1);
    return hit ? { personId: hit.id, how: "email" } : { personId: null, how: "none" };
  }

  const phone = normalisePhone(text(row.data.phone));
  const lastName = text(row.data.last_name)?.toLowerCase() ?? null;
  if (phone && lastName) {
    const [hit] = await tx
      .select({ id: persons.id })
      .from(persons)
      .where(and(eq(persons.phoneE164, phone), sql`lower(trim(${persons.lastName})) = ${lastName}`, isNull(persons.erasedAt), isNull(persons.mergedIntoPersonId)))
      .orderBy(persons.createdAt, persons.id)
      .limit(1);
    if (hit) return { personId: hit.id, how: "phone_name" };
  }
  return { personId: null, how: "none" };
}
