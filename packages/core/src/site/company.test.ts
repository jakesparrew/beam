import { describe, expect, it } from "vitest";
import { companyFooter, enterpriseNumber, missingCompanyIdentification } from "./company";

describe("enterpriseNumber (rule 60)", () => {
  it("formats a Belgian VAT number", () => {
    expect(enterpriseNumber("BE0123456789")).toBe("BE 0123.456.789");
    expect(enterpriseNumber("be 0123.456.789")).toBe("BE 0123.456.789");
    expect(enterpriseNumber("0123456789")).toBe("BE 0123.456.789");
    expect(enterpriseNumber("BE1123456789")).toBe("BE 1123.456.789");
  });

  it("returns null for malformed input", () => {
    for (const bad of [null, undefined, "", "BE012345678", "BE01234567890", "NL0123456789", "BE2123456789", "BEABCDEFGHIJ"]) {
      expect(enterpriseNumber(bad), String(bad)).toBeNull();
    }
  });
});

describe("companyFooter", () => {
  const company = {
    legal_name: "Vibrant Lifestyle Collective BV",
    trade_name: "BEAM Vitality Center",
    vat_number: "BE0123456789",
    enterprise_number: "",
    address: { street: "Voorbeeldstraat 1", postal_code: "9000", city: "Gent", country: "BE" },
    support_email: "info@example.com",
    phone: "+32 9 000 00 00",
  };

  it("uses enterprise_number and falls back to the VAT number", () => {
    expect(companyFooter(company)).toMatchObject({ legalName: "Vibrant Lifestyle Collective BV", enterpriseNumber: "BE 0123.456.789", addressLines: ["Voorbeeldstraat 1", "9000 Gent"] });
    expect(companyFooter({ ...company, enterprise_number: "BE0987654321" }).enterpriseNumber).toBe("BE 0987.654.321");
  });

  it("lists missing identification fields", () => {
    expect(missingCompanyIdentification(company)).toEqual([]);
    expect(missingCompanyIdentification({})).toEqual(["legal_name", "address", "vat_number"]);
  });
});
