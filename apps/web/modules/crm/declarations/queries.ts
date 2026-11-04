/** Declaration queries (crm spec 4.3), crm-P3. */
import type { DbOrTx } from "@beam/db";
import { personDeclarations, persons } from "@beam/db/schema";
import type { DeclarationMethod, DeclarationStatus } from "@beam/core/crm";
import { desc, eq, inArray } from "@/lib/ctx";
import { resolvePersonIds } from "../persons/api";

export type DeclarationRow = {
  id: string;
  kind: "guardian_consent";
  status: DeclarationStatus;
  method: DeclarationMethod;
  documentVersion: number;
  acceptedAt: Date;
  guardianPersonId: string | null;
  guardianName: string | null;
};

/** Every guardian-consent row of the person (and of persons merged into them), newest first. */
export async function listPersonDeclarations(tx: DbOrTx, personId: string): Promise<DeclarationRow[]> {
  const ids = await resolvePersonIds(tx, personId);
  const rows = await tx
    .select({ d: personDeclarations, firstName: persons.firstName, lastName: persons.lastName })
    .from(personDeclarations)
    .leftJoin(persons, eq(persons.id, personDeclarations.guardianPersonId))
    .where(inArray(personDeclarations.personId, ids))
    .orderBy(desc(personDeclarations.acceptedAt), desc(personDeclarations.id));
  return rows.map(({ d, firstName, lastName }) => ({
    id: d.id,
    kind: d.kind,
    status: d.status,
    method: d.method,
    documentVersion: d.documentVersion,
    acceptedAt: d.acceptedAt,
    guardianPersonId: d.guardianPersonId,
    guardianName: [firstName, lastName].filter(Boolean).join(" ") || null,
  }));
}
