/** Company api (crm spec 2.7, rule 3.45), implemented by crm-P6. crm-P1 stub with the final signatures. */
import type { DbOrTx, Tx } from "@beam/db";
import { NotImplementedError } from "@beam/core/errors";
import type { CompanySize, CompanyStatus, CompanySummary, DecisionRole, PostalAddress } from "@beam/core/crm";
import type { EventCtx } from "../api";

const notYet = <T>(fn: string): Promise<T> => Promise.reject(new NotImplementedError(`crm.${fn}`));

export function getCompany(_tx: DbOrTx, _companyId: string): Promise<CompanySummary | null> {
  return notYet("getCompany");
}

export function listPersonCompanies(
  _tx: DbOrTx,
  _personId: string,
): Promise<Array<{ companyId: string; name: string; position: string | null; decisionRole: DecisionRole | null }>> {
  return notYet("listPersonCompanies");
}

export function listPartnerCompanies(_tx: DbOrTx): Promise<Array<{ id: string; name: string; commissionPct: number | null }>> {
  return notYet("listPartnerCompanies");
}

/** ops imports; matches on the normalised VAT number, else `lower(name)`. */
export function upsertCompany(
  _tx: Tx,
  _ctx: EventCtx,
  _input: {
    name: string;
    vatNumber?: string;
    address?: PostalAddress;
    website?: string;
    industry?: string;
    size?: CompanySize;
    status?: CompanyStatus;
    isPartner?: boolean;
  },
): Promise<{ companyId: string; outcome: "created" | "updated" | "unchanged" }> {
  return notYet("upsertCompany");
}

/** ops imports. */
export function addCompanyContact(
  _tx: Tx,
  _ctx: EventCtx,
  _input: { companyId: string; personId: string; position?: string; decisionRole?: DecisionRole; relationship?: string },
): Promise<{ contactId: string; created: boolean }> {
  return notYet("addCompanyContact");
}
