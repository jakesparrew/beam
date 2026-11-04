import { describe, expect, it } from "vitest";
import { BillingDetailsInput } from "./billing";
import {
  addressFromCrm,
  ANONYMISED_SNAPSHOT,
  buildCustomerSnapshot,
  isAnonymisedSnapshot,
  isReducedSnapshot,
  reduceSnapshot,
  walkInSnapshot,
} from "./snapshot";
import { CustomerSnapshotSchema, type CompanyForBilling, type PersonForBilling } from "./types";

const person: PersonForBilling = {
  id: "11111111-1111-4111-8111-111111111111",
  firstName: "An",
  lastName: "Peeters",
  email: "an.peeters@example.com",
  phone: "+32470000000",
  address: { street: "Kerkstraat", number: "12", box: "3", postal_code: "9000", city: "Gent", country: "be" },
  locale: "nl-BE",
};

const company: CompanyForBilling = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Acme BV",
  vatNumber: "be0123.456.749",
  address: { street: "Industrieweg", number: "1", postal_code: "2000", city: "Antwerpen", country: "BE" },
};

describe("buildCustomerSnapshot", () => {
  it("person: full name, contact, address and the person link", () => {
    const s = buildCustomerSnapshot({ person });
    expect(s).toEqual({
      kind: "person",
      name: "An Peeters",
      email: "an.peeters@example.com",
      phone: "+32470000000",
      address: { line1: "Kerkstraat 12/3", postal_code: "9000", city: "Gent", country: "BE" },
      vat_number: null,
      peppol_id: null,
      purchase_order_ref: null,
      person_id: person.id,
      company_id: null,
      is_reduced: false,
    });
    expect(CustomerSnapshotSchema.parse(s)).toEqual(s);
  });

  it("company: legal name, normalised VAT number, derived Peppol id, both links", () => {
    expect(buildCustomerSnapshot({ person, company })).toEqual({
      kind: "company",
      name: "Acme BV",
      email: person.email,
      phone: person.phone,
      address: { line1: "Industrieweg 1", postal_code: "2000", city: "Antwerpen", country: "BE" },
      vat_number: "BE0123456749",
      peppol_id: "0208:0123456749",
      purchase_order_ref: null,
      person_id: person.id,
      company_id: company.id,
      is_reduced: false,
    });
  });

  it("billing details override the company and the person", () => {
    const billing = BillingDetailsInput.parse({
      isCompany: true,
      legalName: "Other BV",
      vatNumber: "NL123456789B01",
      address: { line1: "Dam 1", postal_code: "1012 JS", city: "Amsterdam", country: "NL" },
      billingEmail: "ap@example.com",
      purchaseOrderRef: "PO-77",
    });
    expect(buildCustomerSnapshot({ person, company, billing })).toMatchObject({
      kind: "company",
      name: "Other BV",
      email: "ap@example.com",
      address: { line1: "Dam 1", city: "Amsterdam", country: "NL" },
      vat_number: "NL123456789B01",
      peppol_id: null,
      purchase_order_ref: "PO-77",
      person_id: person.id,
      company_id: company.id,
    });
    const consumer = BillingDetailsInput.parse({ isCompany: false, legalName: "An P.", address: { line1: "Dam 1", postal_code: "1012", city: "Amsterdam", country: "NL" } });
    expect(buildCustomerSnapshot({ person, billing: consumer })).toMatchObject({ kind: "person", name: "An P.", email: person.email, vat_number: null });
  });

  it("walk-in sale, and nothing at all", () => {
    expect(buildCustomerSnapshot({ walkInName: "Walk-in customer" })).toEqual(walkInSnapshot("Walk-in customer"));
    expect(() => buildCustomerSnapshot({})).toThrow(/no_customer/);
  });

  it("an incomplete crm address and a person without a name", () => {
    expect(addressFromCrm({ street: "Kerkstraat", country: "BE" })).toBeNull();
    expect(addressFromCrm(null)).toBeNull();
    expect(addressFromCrm({ street: "Kerkstraat", postal_code: "9000", city: "Gent", country: "BE" })).toEqual({
      line1: "Kerkstraat",
      postal_code: "9000",
      city: "Gent",
      country: "BE",
    });
    expect(buildCustomerSnapshot({ person: { ...person, firstName: null, lastName: null } }).kind).toBe("person");
    expect(buildCustomerSnapshot({ person: { ...person, firstName: null, lastName: null } })).toMatchObject({ name: person.email });
    expect(buildCustomerSnapshot({ company: { ...company, vatNumber: null, address: null } })).toMatchObject({ vat_number: null, peppol_id: null, address: null, person_id: null });
  });
});

describe("reduceSnapshot", () => {
  it("removes email, phone and ids and keeps name, address and the VAT number of a company", () => {
    const reduced = reduceSnapshot(buildCustomerSnapshot({ person, company }));
    expect(reduced).toEqual({
      kind: "company",
      name: "Acme BV",
      email: null,
      phone: null,
      address: { line1: "Industrieweg 1", postal_code: "2000", city: "Antwerpen", country: "BE" },
      vat_number: "BE0123456749",
      peppol_id: "0208:0123456749",
      purchase_order_ref: null,
      person_id: null,
      company_id: null,
      is_reduced: true,
    });
    expect(isReducedSnapshot(reduced)).toBe(true);
  });

  it("drops the VAT number of a person and keeps an anonymised snapshot anonymised", () => {
    const reduced = reduceSnapshot({ ...buildCustomerSnapshot({ person }), vat_number: "BE0123456749" });
    expect(reduced).toMatchObject({ kind: "person", vat_number: null, email: null, phone: null, person_id: null, is_reduced: true });
    expect(reduceSnapshot(ANONYMISED_SNAPSHOT)).toEqual({ anonymised: true });
    expect(isAnonymisedSnapshot(ANONYMISED_SNAPSHOT)).toBe(true);
    expect(isAnonymisedSnapshot({ anonymised: true, name: "x" })).toBe(false);
    expect(isAnonymisedSnapshot(null)).toBe(false);
    expect(CustomerSnapshotSchema.parse({ anonymised: true })).toEqual({ anonymised: true });
  });
});
