/**
 * Company identification in the footer (rule 60, Belgian Code of Economic Law book XII): legal
 * name, registered address, enterprise number (`BE 0123.456.789`), support email and phone, from
 * `settings.company`. `enterpriseNumber(vatNumber)` is only the fallback when
 * `settings.company.enterprise_number` is empty (02-data-model DM-19).
 */

/** `BE0123456789` (or `BE 0123.456.789`, `0123456789`) -> `BE 0123.456.789`; anything else -> null. */
export function enterpriseNumber(vatNumber: string | null | undefined): string | null {
  if (!vatNumber) return null;
  const compact = vatNumber.toUpperCase().replace(/[\s.-]/g, "");
  const m = /^(?:BE)?([01]\d{9})$/.exec(compact);
  if (!m) return null;
  const d = m[1]!;
  return `BE ${d.slice(0, 4)}.${d.slice(4, 7)}.${d.slice(7)}`;
}

export type CompanySetting = {
  legal_name?: string | null;
  trade_name?: string | null;
  vat_number?: string | null;
  enterprise_number?: string | null;
  address?: { street?: string | null; postal_code?: string | null; city?: string | null; country?: string | null } | null;
  support_email?: string | null;
  phone?: string | null;
  website?: string | null;
};

export type CompanyFooter = {
  legalName: string | null;
  tradeName: string | null;
  addressLines: string[];
  enterpriseNumber: string | null;
  vatNumber: string | null;
  email: string | null;
  phone: string | null;
};

const clean = (s: string | null | undefined) => (s && s.trim() ? s.trim() : null);

/** The footer's company block from `settings.company`. */
export function companyFooter(company: CompanySetting | null | undefined): CompanyFooter {
  const c = company ?? {};
  const street = clean(c.address?.street);
  const city = [clean(c.address?.postal_code), clean(c.address?.city)].filter(Boolean).join(" ");
  return {
    legalName: clean(c.legal_name),
    tradeName: clean(c.trade_name),
    addressLines: [street, city || null].filter((x): x is string => !!x),
    enterpriseNumber: enterpriseNumber(clean(c.enterprise_number)) ?? clean(c.enterprise_number) ?? enterpriseNumber(c.vat_number),
    vatNumber: clean(c.vat_number),
    email: clean(c.support_email),
    phone: clean(c.phone),
  };
}

/** Missing identification fields that make `/admin/site` show `company_identification_missing`. */
export function missingCompanyIdentification(company: CompanySetting | null | undefined): ("legal_name" | "address" | "vat_number")[] {
  const c = company ?? {};
  const missing: ("legal_name" | "address" | "vat_number")[] = [];
  if (!clean(c.legal_name)) missing.push("legal_name");
  if (!clean(c.address?.street) || !clean(c.address?.city)) missing.push("address");
  if (!clean(c.vat_number)) missing.push("vat_number");
  return missing;
}
