import { describe, expect, it } from "vitest";
import { BillingDetailsInput, billingPeppolId } from "./billing";
import { isBelgianChecksumValid, normaliseVatNumber, peppolIdFromVatNumber } from "./vat-number";

describe("normaliseVatNumber: Belgium", () => {
  it("accepts a valid BE number (97 - first 8 digits mod 97 = last 2)", () => {
    // 01234567 mod 97 = 48, 97 - 48 = 49
    expect(normaliseVatNumber("BE0123456749")).toEqual({ ok: true, value: "BE0123456749" });
    expect(isBelgianChecksumValid("0123456749")).toBe(true);
  });

  it("refuses a bad checksum", () => {
    expect(normaliseVatNumber("BE0123456748")).toEqual({ ok: false, reason: "checksum" });
    expect(normaliseVatNumber("0123456750")).toEqual({ ok: false, reason: "checksum" });
  });

  it("removes spaces, dots and dashes and upper-cases", () => {
    expect(normaliseVatNumber(" be 0123.456.749 ")).toEqual({ ok: true, value: "BE0123456749" });
    expect(normaliseVatNumber("BE-0123-456-749")).toEqual({ ok: true, value: "BE0123456749" });
    expect(normaliseVatNumber("0123.456.749")).toEqual({ ok: true, value: "BE0123456749" });
  });

  it("adds the leading 0 of a nine-digit legacy number", () => {
    expect(normaliseVatNumber("123456749")).toEqual({ ok: true, value: "BE0123456749" });
    expect(normaliseVatNumber("BE123456749")).toEqual({ ok: true, value: "BE0123456749" });
  });

  it("refuses wrong lengths and a first digit other than 0 or 1", () => {
    expect(normaliseVatNumber("BE01234567490")).toEqual({ ok: false, reason: "format" });
    expect(normaliseVatNumber("BE2123456749")).toEqual({ ok: false, reason: "format" });
    expect(normaliseVatNumber("")).toEqual({ ok: false, reason: "format" });
    expect(normaliseVatNumber("hello")).toEqual({ ok: false, reason: "format" });
    expect(isBelgianChecksumValid("12345")).toBe(false);
  });
});

describe("normaliseVatNumber: other EU countries (format only)", () => {
  it("NL: 9 digits, B, 2 digits", () => {
    expect(normaliseVatNumber("NL 123456789 B01")).toEqual({ ok: true, value: "NL123456789B01" });
    expect(normaliseVatNumber("NL123456789")).toEqual({ ok: false, reason: "format" });
  });

  it("FR: 2 key characters and 9 digits", () => {
    expect(normaliseVatNumber("FR40303265045")).toEqual({ ok: true, value: "FR40303265045" });
    expect(normaliseVatNumber("fr ab 123456789")).toEqual({ ok: true, value: "FRAB123456789" });
    expect(normaliseVatNumber("FRIO123456789")).toEqual({ ok: false, reason: "format" });
    expect(normaliseVatNumber("FR4030326504")).toEqual({ ok: false, reason: "format" });
  });

  it("DE: 9 digits", () => {
    expect(normaliseVatNumber("DE 123 456 789")).toEqual({ ok: true, value: "DE123456789" });
    expect(normaliseVatNumber("DE12345678")).toEqual({ ok: false, reason: "format" });
  });

  it("other formats and unknown countries", () => {
    expect(normaliseVatNumber("LU12345678")).toEqual({ ok: true, value: "LU12345678" });
    expect(normaliseVatNumber("ATU12345678")).toEqual({ ok: true, value: "ATU12345678" });
    expect(normaliseVatNumber("GR123456789")).toEqual({ ok: true, value: "EL123456789" });
    expect(normaliseVatNumber("US123456789")).toEqual({ ok: false, reason: "format" });
  });
});

describe("Peppol ids", () => {
  it("derives 0208:<enterprise number> from a Belgian VAT number only", () => {
    expect(peppolIdFromVatNumber("BE0123456749")).toBe("0208:0123456749");
    expect(peppolIdFromVatNumber("NL123456789B01")).toBeNull();
    expect(peppolIdFromVatNumber(null)).toBeNull();
    expect(peppolIdFromVatNumber("BE0123456748")).toBeNull();
  });
});

describe("BillingDetailsInput (rule 17)", () => {
  const address = { line1: "Kerkstraat 1", postal_code: "9000", city: "Gent", country: "be" };

  it("normalises the VAT number and the country of a company", () => {
    const parsed = BillingDetailsInput.parse({ isCompany: true, legalName: "  Acme BV ", vatNumber: "be 0123.456.749", address });
    expect(parsed).toMatchObject({ isCompany: true, legalName: "Acme BV", vatNumber: "BE0123456749", address: { country: "BE" } });
    expect(billingPeppolId(parsed)).toBe("0208:0123456749");
  });

  it("requires a VAT number for a company and refuses bad ones with their message key", () => {
    const issue = (input: unknown) => BillingDetailsInput.safeParse(input).error?.issues[0]?.message;
    expect(issue({ isCompany: true, legalName: "Acme BV", address })).toBe("finance.billing.vat_number_required");
    expect(issue({ isCompany: true, legalName: "Acme BV", vatNumber: "BE0123456748", address })).toBe("finance.billing.vat_number_checksum");
    expect(issue({ isCompany: true, legalName: "Acme BV", vatNumber: "XX1", address })).toBe("finance.billing.vat_number_format");
  });

  it("accepts a consumer without VAT number and checks lengths, email and Peppol id", () => {
    const consumer = BillingDetailsInput.parse({ isCompany: false, legalName: "An Peeters", address, billingEmail: " An@Example.com ", purchaseOrderRef: "" });
    expect(consumer.vatNumber).toBeUndefined();
    expect(consumer.purchaseOrderRef).toBeUndefined();
    expect(consumer.billingEmail).toBe("an@example.com");
    expect(billingPeppolId(consumer)).toBeNull();
    expect(BillingDetailsInput.safeParse({ isCompany: false, legalName: "A", address }).success).toBe(false);
    expect(BillingDetailsInput.safeParse({ isCompany: false, legalName: "An", address, billingEmail: "nope" }).success).toBe(false);
    expect(BillingDetailsInput.safeParse({ isCompany: false, legalName: "An", address: { ...address, country: "Belgium" } }).success).toBe(false);
    expect(BillingDetailsInput.safeParse({ isCompany: false, legalName: "An", address, purchaseOrderRef: "x".repeat(51) }).success).toBe(false);
    const withPeppol = BillingDetailsInput.parse({ isCompany: true, legalName: "Acme BV", vatNumber: "NL123456789B01", address, peppolId: "9944:NL123456789B01" });
    expect(billingPeppolId(withPeppol)).toBe("9944:NL123456789B01");
    expect(BillingDetailsInput.safeParse({ isCompany: true, legalName: "Acme BV", vatNumber: "NL123456789B01", address, peppolId: "bad id" }).success).toBe(false);
  });
});
