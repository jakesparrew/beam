/**
 * Reception card api (crm spec 4.8, cross-module D15), implemented by crm-P7. crm-P1 stub with
 * the final signature. booking's check-in desk renders it.
 */
import type { DbOrTx } from "@beam/db";
import { NotImplementedError } from "@beam/core/errors";
import type { PersonStatus } from "@beam/core/crm";

export type ReceptionCardData = {
  name: string;
  customerNumber: string;
  status: PersonStatus;
  isMember: boolean;
  tags: string[];
  emergencyContact: { name: string; phone: string } | null;
  declarations: { termsAccepted: boolean; healthDeclarationValid: boolean; guardianConsentValid: boolean };
  isMinor: boolean;
};

export function getReceptionCard(_tx: DbOrTx, _personId: string): Promise<ReceptionCardData> {
  return Promise.reject(new NotImplementedError("crm.getReceptionCard"));
}
