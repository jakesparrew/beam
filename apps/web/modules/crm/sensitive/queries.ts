/** Sensitive panel query (crm spec 5.1), implemented by crm-P4. crm-P1 stub: keys only, never values. */
import type { DbOrTx } from "@beam/db";
import { NotImplementedError } from "@beam/core/errors";
import type { SensitiveFieldKey } from "@beam/core/privacy";

export function listSensitiveKeys(_tx: DbOrTx, _personId: string): Promise<Array<{ key: SensitiveFieldKey; updatedAt: Date }>> {
  return Promise.reject(new NotImplementedError("crm.listSensitiveKeys"));
}
