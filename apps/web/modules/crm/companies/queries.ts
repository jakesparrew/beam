/** Company queries (crm spec 4.3), implemented by crm-P6. crm-P1 stubs. */
import type { DbOrTx } from "@beam/db";
import { NotImplementedError } from "@beam/core/errors";
import type { CompanySize, CompanyStatus, DecisionRole, PostalAddress } from "@beam/core/crm";

export type CompanyRow = {
  id: string;
  name: string;
  vatNumber: string | null;
  status: CompanyStatus;
  size: CompanySize | null;
  ownerUserId: string | null;
  contacts: number;
  isPartner: boolean;
};

export type CompanyDetail = CompanyRow & {
  address: PostalAddress | null;
  website: string | null;
  industry: string | null;
  notes: string | null;
  partnerCommissionPct: number | null;
  contactList: Array<{ id: string; personId: string; name: string; position: string | null; decisionRole: DecisionRole | null; isPrimary: boolean; endedOn: string | null }>;
  referredPersons: Array<{ id: string; name: string }>;
};

const notYet = <T>(fn: string): Promise<T> => Promise.reject(new NotImplementedError(`crm.${fn}`));

export function listCompanies(_tx: DbOrTx, _input: { q?: string; status?: CompanyStatus; isPartner?: boolean }): Promise<CompanyRow[]> {
  return notYet("listCompanies");
}

export function getCompany(_tx: DbOrTx, _id: string): Promise<CompanyDetail | null> {
  return notYet("getCompany");
}
