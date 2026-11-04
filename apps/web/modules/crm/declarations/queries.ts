/** Declaration queries (crm spec 4.3), implemented by crm-P3. crm-P1 stub. */
import type { DbOrTx } from "@beam/db";
import { NotImplementedError } from "@beam/core/errors";
import type { DeclarationMethod, DeclarationStatus } from "@beam/core/crm";

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

export function listPersonDeclarations(_tx: DbOrTx, _personId: string): Promise<DeclarationRow[]> {
  return Promise.reject(new NotImplementedError("crm.listPersonDeclarations"));
}
