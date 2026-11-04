/**
 * The seller block (finance section 8): platform's `company` key (legal name, trade name, VAT
 * and enterprise number, address, support email, phone, website) merged with finance's
 * `finance.issuer` (register court, IBAN, BIC, footer in the document locale).
 * `company.address.street` becomes the seller's `line1`. Issuing works with empty fields;
 * production PDF rendering refuses the `BLOCKING_ISSUER_FIELDS` (`MissingCompanySettingsError`,
 * finance-P3).
 */
import type { Locale } from "../i18n/locales";
import type { CompanySetting, FinanceSetting } from "./settings";
import type { SellerSnapshot } from "./types";

export function buildSellerSnapshot(company: CompanySetting, finance: FinanceSetting, locale: Locale): SellerSnapshot {
  return {
    legal_name: company.legal_name.trim(),
    trade_name: company.trade_name.trim(),
    vat_number: company.vat_number.trim(),
    enterprise_number: company.enterprise_number.trim(),
    address: {
      line1: company.address.street.trim(),
      postal_code: company.address.postal_code.trim(),
      city: company.address.city.trim(),
      country: company.address.country.trim(),
    },
    support_email: company.support_email.trim(),
    phone: company.phone.trim(),
    website: company.website.trim(),
    register_court: finance.issuer.register_court.trim(),
    iban: finance.issuer.iban.replace(/\s+/g, "").toUpperCase(),
    bic: finance.issuer.bic.trim().toUpperCase(),
    footer: finance.issuer.invoice_footer[locale]?.trim() ?? "",
    locale,
  };
}

/** Fields every document prints (rule 18), as `<setting key>.<field>` paths for the settings summary. */
export const REQUIRED_ISSUER_FIELDS = [
  "company.legal_name",
  "company.vat_number",
  "company.enterprise_number",
  "company.address.street",
  "company.address.postal_code",
  "company.address.city",
  "finance.issuer.register_court",
  "finance.issuer.iban",
  "finance.issuer.bic",
  "finance.issuer.invoice_footer",
] as const;
export type IssuerField = (typeof REQUIRED_ISSUER_FIELDS)[number];

/** The fields without which production refuses to render a PDF (section 8, edge case 16). */
export const BLOCKING_ISSUER_FIELDS: readonly IssuerField[] = ["company.vat_number", "company.enterprise_number", "finance.issuer.iban"];

const PLACEHOLDER_CHECKED: readonly IssuerField[] = ["company.vat_number", "company.enterprise_number"];
/** Empty, or (for the two numbers) Wave 0's all-zero placeholder `BE0000000000` / `0000.000.000`. */
const blank = (field: IssuerField, v: string) =>
  v.trim() === "" || (PLACEHOLDER_CHECKED.includes(field) && /^(BE)?[0.\s]+$/i.test(v.trim()));

const VALUE: Record<IssuerField, (s: SellerSnapshot) => string> = {
  "company.legal_name": (s) => s.legal_name,
  "company.vat_number": (s) => s.vat_number,
  "company.enterprise_number": (s) => s.enterprise_number,
  "company.address.street": (s) => s.address.line1,
  "company.address.postal_code": (s) => s.address.postal_code,
  "company.address.city": (s) => s.address.city,
  "finance.issuer.register_court": (s) => s.register_court,
  "finance.issuer.iban": (s) => s.iban,
  "finance.issuer.bic": (s) => s.bic,
  "finance.issuer.invoice_footer": (s) => s.footer,
};

/** The required fields that are empty (or still a placeholder) in `s`, in `REQUIRED_ISSUER_FIELDS` order. */
export function missingIssuerFields(s: SellerSnapshot): string[] {
  return REQUIRED_ISSUER_FIELDS.filter((f) => blank(f, VALUE[f](s)));
}

/** The blocking fields that are missing: a non-empty result makes production PDF rendering fail. */
export function blockingIssuerFields(s: SellerSnapshot): string[] {
  const missing = missingIssuerFields(s);
  return BLOCKING_ISSUER_FIELDS.filter((f) => missing.includes(f));
}
