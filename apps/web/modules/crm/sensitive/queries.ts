/** Sensitive panel query (crm spec 5.1), crm-P4: which keys a person has and when they changed, never values. */
import type { DbOrTx } from "@beam/db";
import { personSensitiveFields } from "@beam/db/schema";
import type { SensitiveFieldKey } from "@beam/core/privacy";
import { asc, eq } from "@/lib/ctx";

export function listSensitiveKeys(tx: DbOrTx, personId: string): Promise<Array<{ key: SensitiveFieldKey; updatedAt: Date }>> {
  return tx
    .select({ key: personSensitiveFields.key, updatedAt: personSensitiveFields.updatedAt })
    .from(personSensitiveFields)
    .where(eq(personSensitiveFields.personId, personId))
    .orderBy(asc(personSensitiveFields.key));
}
