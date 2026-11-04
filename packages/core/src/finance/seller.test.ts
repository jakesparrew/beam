import { describe, expect, it } from "vitest";
import { blockingIssuerFields, buildSellerSnapshot, missingIssuerFields, REQUIRED_ISSUER_FIELDS } from "./seller";
import {
  CompanySettingSchema,
  FINANCE_SETTING_DEFAULT,
  financeSettingSchemaFor,
  FinanceSettingSchema,
  isValidIban,
  type CompanySetting,
  type FinanceSetting,
} from "./settings";
import { SellerSnapshotSchema } from "./types";

const company: CompanySetting = {
  legal_name: "Vibrant Lifestyle Collective BV",
  trade_name: "BEAM Vitality Center",
  vat_number: "BE0123456749",
  enterprise_number: "0123.456.749",
  address: { street: "Teststraat 1", postal_code: "9000", city: "Gent", country: "BE" },
  support_email: "support@demo.beam.be",
  phone: "+3290000000",
  website: "https://beam.example.com",
};

const finance: FinanceSetting = {
  ...FINANCE_SETTING_DEFAULT,
  issuer: { ...FINANCE_SETTING_DEFAULT.issuer, register_court: "Ondernemingsrechtbank Gent", iban: "BE68 5390 0754 7034", bic: "gkccbebb" },
};

describe("buildSellerSnapshot", () => {
  it("merges platform company and finance.issuer, street as line1, footer in the document locale", () => {
    const s = buildSellerSnapshot(company, finance, "fr-BE");
    expect(s).toEqual({
      legal_name: "Vibrant Lifestyle Collective BV",
      trade_name: "BEAM Vitality Center",
      vat_number: "BE0123456749",
      enterprise_number: "0123.456.749",
      address: { line1: "Teststraat 1", postal_code: "9000", city: "Gent", country: "BE" },
      support_email: "support@demo.beam.be",
      phone: "+3290000000",
      website: "https://beam.example.com",
      register_court: "Ondernemingsrechtbank Gent",
      iban: "BE68539007547034",
      bic: "GKCCBEBB",
      footer: "Nos conditions générales sont d'application.",
      locale: "fr-BE",
    });
    expect(SellerSnapshotSchema.parse(s)).toEqual(s);
    expect(buildSellerSnapshot(company, finance, "en").footer).toBe("Our general terms and conditions apply.");
    expect(missingIssuerFields(s)).toEqual([]);
    expect(blockingIssuerFields(s)).toEqual([]);
  });

  it("lists the missing fields: the seeded issuer and Wave 0's placeholder company", () => {
    const placeholder = CompanySettingSchema.parse({
      legal_name: "Vibrant Lifestyle Collective BV",
      trade_name: "BEAM Vitality Center",
      vat_number: "BE0000000000",
      enterprise_number: "0000.000.000",
      address: { street: "", postal_code: "", city: "", country: "BE" },
      support_email: "support@demo.beam.be",
      phone: "",
      website: "",
    });
    const s = buildSellerSnapshot(placeholder, FINANCE_SETTING_DEFAULT, "nl-BE");
    expect(missingIssuerFields(s)).toEqual([
      "company.vat_number",
      "company.enterprise_number",
      "company.address.street",
      "company.address.postal_code",
      "company.address.city",
      "finance.issuer.register_court",
      "finance.issuer.iban",
      "finance.issuer.bic",
    ]);
    expect(blockingIssuerFields(s)).toEqual(["company.vat_number", "company.enterprise_number", "finance.issuer.iban"]);
  });

  it("a footer missing in the document locale is empty and listed", () => {
    const partial = { ...finance, issuer: { ...finance.issuer, invoice_footer: { en: "Terms apply." } } };
    const s = buildSellerSnapshot(company, partial, "nl-BE");
    expect(s.footer).toBe("");
    expect(missingIssuerFields(s)).toEqual(["finance.issuer.invoice_footer"]);
    expect(REQUIRED_ISSUER_FIELDS).toContain("company.legal_name");
  });
});

describe("FinanceSettingSchema", () => {
  it("accepts the seeded default and a completed issuer", () => {
    expect(FinanceSettingSchema.parse(FINANCE_SETTING_DEFAULT)).toEqual(FINANCE_SETTING_DEFAULT);
    expect(FinanceSettingSchema.parse(finance).issuer).toMatchObject({ iban: "BE68539007547034", bic: "GKCCBEBB" });
  });

  it("refuses an incomplete footer or VAT note, a bad IBAN or BIC", () => {
    const bad = (patch: Record<string, unknown>) => FinanceSettingSchema.safeParse({ ...FINANCE_SETTING_DEFAULT, ...patch }).success;
    expect(bad({ issuer: { ...FINANCE_SETTING_DEFAULT.issuer, invoice_footer: { en: "x", "nl-BE": "y" } } })).toBe(false);
    expect(bad({ vat_notes: { voucher: { en: "x", "nl-BE": " ", "fr-BE": "z" } } })).toBe(false);
    expect(bad({ issuer: { ...FINANCE_SETTING_DEFAULT.issuer, iban: "BE68 5390 0754 7035" } })).toBe(false);
    expect(bad({ issuer: { ...FINANCE_SETTING_DEFAULT.issuer, bic: "GKCC" } })).toBe(false);
    expect(bad({ payment_terms_days: 0 })).toBe(false);
  });

  it("production refuses peppol_enabled = false", () => {
    const off = { ...FINANCE_SETTING_DEFAULT, peppol_enabled: false };
    expect(financeSettingSchemaFor("production").safeParse(off).error?.issues[0]?.message).toBe("finance.settings.peppol_required_in_production");
    expect(financeSettingSchemaFor("production").safeParse(FINANCE_SETTING_DEFAULT).success).toBe(true);
    expect(financeSettingSchemaFor("local").safeParse(off).success).toBe(true);
  });

  it("validates IBANs with ISO 13616 mod 97", () => {
    expect(isValidIban("BE68539007547034")).toBe(true);
    expect(isValidIban("be68 5390 0754 7034")).toBe(true);
    expect(isValidIban("NL91ABNA0417164300")).toBe(true);
    expect(isValidIban("BE68539007547035")).toBe(false);
    expect(isValidIban("BE68")).toBe(false);
  });
});
