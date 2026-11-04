/** Guardian-consent api (crm rule 3.54, cross-module D15), implemented by crm-P3. crm-P1 stub. */
import type { DbOrTx } from "@beam/db";
import { NotImplementedError } from "@beam/core/errors";

export function hasValidDeclaration(_db: DbOrTx, _input: { personId: string; kind: "guardian_consent" }): Promise<boolean> {
  return Promise.reject(new NotImplementedError("crm.hasValidDeclaration"));
}
