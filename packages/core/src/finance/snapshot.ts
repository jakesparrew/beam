/**
 * Customer snapshots (finance rules 14 and 14a, section 9). At issue an invoice freezes its
 * buyer: the order's billing details when present, else the CRM company, else the person.
 * Erasure reduces the snapshot (email, phone and ids removed, `is_reduced: true`); the
 * `finance.invoices` retention sweep replaces it with `{ "anonymised": true }`.
 */
import type { BillingDetails } from "./billing";
import { billingPeppolId } from "./billing";
import {
  FinanceValidationError,
  type Address,
  type AnonymisedSnapshot,
  type CompanyForBilling,
  type CrmPostalAddress,
  type CustomerSnapshot,
  type FullCustomerSnapshot,
  type PersonForBilling,
} from "./types";
import { normaliseVatNumber, peppolIdFromVatNumber } from "./vat-number";

/** The snapshot left by the `finance.invoices` retention sweep. */
export const ANONYMISED_SNAPSHOT: AnonymisedSnapshot = Object.freeze({ anonymised: true as const });

export function isAnonymisedSnapshot(s: unknown): s is AnonymisedSnapshot {
  return typeof s === "object" && s !== null && (s as { anonymised?: unknown }).anonymised === true && Object.keys(s).length === 1;
}

export function isReducedSnapshot(s: unknown): s is FullCustomerSnapshot & { is_reduced: true } {
  return typeof s === "object" && s !== null && (s as { is_reduced?: unknown }).is_reduced === true;
}

/** crm's `{ street, number, box, postal_code, city, country }` as an invoice address; `null` when incomplete. */
export function addressFromCrm(a: CrmPostalAddress | null | undefined): Address | null {
  if (!a?.street?.trim() || !a.postal_code?.trim() || !a.city?.trim() || !a.country?.trim()) return null;
  const house = [a.number?.trim(), a.box?.trim()].filter(Boolean).join("/");
  return {
    line1: [a.street.trim(), house].filter(Boolean).join(" "),
    postal_code: a.postal_code.trim(),
    city: a.city.trim(),
    country: a.country.trim().toUpperCase(),
  };
}

const fullName = (p: PersonForBilling) => [p.firstName?.trim(), p.lastName?.trim()].filter(Boolean).join(" ");

const vatOrNull = (v: string | null | undefined) => {
  if (!v) return null;
  const n = normaliseVatNumber(v);
  return n.ok ? n.value : v;
};

/** An anonymous POS sale (rule 14a); `name` is `finance.pdf.walk_in` in the document locale. */
export function walkInSnapshot(name: string): FullCustomerSnapshot {
  return {
    kind: "walk_in",
    name,
    email: null,
    phone: null,
    address: null,
    vat_number: null,
    peppol_id: null,
    purchase_order_ref: null,
    person_id: null,
    company_id: null,
    is_reduced: false,
  };
}

/**
 * The buyer of a new document. Billing details win over the company, which wins over the
 * person; the ids of the person and company are kept as links. Without any of the three, a
 * walk-in snapshot is returned when `walkInName` is given, else it throws `validation`.
 */
export function buildCustomerSnapshot(src: {
  person?: PersonForBilling;
  company?: CompanyForBilling;
  billing?: BillingDetails;
  walkInName?: string;
}): FullCustomerSnapshot {
  const { person, company, billing } = src;
  const ids = { person_id: person?.id ?? null, company_id: company?.id ?? null };
  if (billing) {
    return {
      kind: billing.isCompany ? "company" : "person",
      name: billing.legalName.trim(),
      email: billing.billingEmail ?? person?.email ?? null,
      phone: person?.phone ?? null,
      address: { ...billing.address },
      vat_number: vatOrNull(billing.vatNumber),
      peppol_id: billingPeppolId(billing),
      purchase_order_ref: billing.purchaseOrderRef ?? null,
      ...ids,
      is_reduced: false,
    };
  }
  if (company) {
    const vat = vatOrNull(company.vatNumber);
    return {
      kind: "company",
      name: company.name.trim(),
      email: person?.email ?? null,
      phone: person?.phone ?? null,
      address: addressFromCrm(company.address),
      vat_number: vat,
      peppol_id: peppolIdFromVatNumber(vat),
      purchase_order_ref: null,
      ...ids,
      is_reduced: false,
    };
  }
  if (person) {
    return {
      kind: "person",
      name: fullName(person) || person.email || "",
      email: person.email,
      phone: person.phone,
      address: addressFromCrm(person.address),
      vat_number: null,
      peppol_id: null,
      purchase_order_ref: null,
      ...ids,
      is_reduced: false,
    };
  }
  if (src.walkInName !== undefined) return walkInSnapshot(src.walkInName);
  throw new FinanceValidationError("finance.errors.no_customer");
}

/**
 * The erasure form (section 9): `{ kind, name, address, vat_number (companies only), peppol_id,
 * purchase_order_ref, is_reduced: true }` with email, phone and ids removed. An anonymised
 * snapshot stays anonymised.
 */
export function reduceSnapshot(s: CustomerSnapshot): CustomerSnapshot {
  if (isAnonymisedSnapshot(s)) return ANONYMISED_SNAPSHOT;
  return {
    kind: s.kind,
    name: s.name,
    email: null,
    phone: null,
    address: s.address ? { ...s.address } : null,
    vat_number: s.kind === "company" ? s.vat_number : null,
    peppol_id: s.peppol_id,
    purchase_order_ref: s.purchase_order_ref,
    person_id: null,
    company_id: null,
    is_reduced: true,
  };
}
