import { describe, expect, it } from "vitest";
import { unitValueFor, vatAtRedemption, vatTreatmentFor } from "./vat";

describe("vatTreatmentFor", () => {
  it("purchased day and night packages are single-purpose", () => {
    expect(vatTreatmentFor({ source: "purchase", kind: "day" })).toBe("single_purpose");
    expect(vatTreatmentFor({ source: "purchase", kind: "night" })).toBe("single_purpose");
  });

  it("imports are single-purpose for day/night and multi-purpose for legacy euro vouchers", () => {
    expect(vatTreatmentFor({ source: "import", kind: "day" })).toBe("single_purpose");
    expect(vatTreatmentFor({ source: "import", kind: "night" })).toBe("single_purpose");
    expect(vatTreatmentFor({ source: "import", kind: "euro" })).toBe("multi_purpose");
  });

  it("redeemed euro vouchers are multi-purpose", () => {
    expect(vatTreatmentFor({ source: "voucher", kind: "euro" })).toBe("multi_purpose");
  });

  it("a manual euro grant restoring a partial refund is multi-purpose; other manual grants are not applicable", () => {
    expect(vatTreatmentFor({ source: "manual", kind: "euro", refundId: "r1" })).toBe("multi_purpose");
    expect(vatTreatmentFor({ source: "manual", kind: "euro" })).toBe("not_applicable");
    expect(vatTreatmentFor({ source: "manual", kind: "euro", refundId: null })).toBe("not_applicable");
    expect(vatTreatmentFor({ source: "manual", kind: "day", refundId: "r1" })).toBe("not_applicable");
  });

  it("bonus, referral and membership grants are not applicable", () => {
    for (const source of ["bonus", "referral", "membership"] as const) {
      expect(vatTreatmentFor({ source, kind: "day" })).toBe("not_applicable");
      expect(vatTreatmentFor({ source, kind: "night" })).toBe("not_applicable");
    }
    expect(vatTreatmentFor({ source: "bonus", kind: "euro" })).toBe("not_applicable");
  });

  it("a transfer keeps the source grant's treatment", () => {
    expect(vatTreatmentFor({ source: "transfer", kind: "day", transferFromTreatment: "single_purpose" })).toBe("single_purpose");
    expect(vatTreatmentFor({ source: "transfer", kind: "euro", transferFromTreatment: "multi_purpose" })).toBe("multi_purpose");
    expect(() => vatTreatmentFor({ source: "transfer", kind: "day" })).toThrow(RangeError);
  });

  it("refuses combinations the schema forbids", () => {
    expect(() => vatTreatmentFor({ source: "purchase", kind: "euro" })).toThrow(RangeError);
    expect(() => vatTreatmentFor({ source: "voucher", kind: "day" })).toThrow(RangeError);
  });
});

describe("unit value and redemption VAT", () => {
  it("a euro unit is one cent; staff and inclusion day units are worth 0; purchases keep their value", () => {
    expect(unitValueFor({ source: "voucher", kind: "euro", unitValueCents: 500 })).toBe(1);
    expect(unitValueFor({ source: "manual", kind: "euro" })).toBe(1);
    expect(unitValueFor({ source: "bonus", kind: "day", unitValueCents: 900 })).toBe(0);
    expect(unitValueFor({ source: "membership", kind: "night" })).toBe(0);
    expect(unitValueFor({ source: "purchase", kind: "day", unitValueCents: 1850 })).toBe(1850);
    expect(unitValueFor({ source: "import", kind: "day" })).toBe(0);
    expect(unitValueFor({ source: "transfer", kind: "day", unitValueCents: 1200 })).toBe(1200);
  });

  it("only euro spends carry VAT at redemption", () => {
    expect(vatAtRedemption("euro")).toBe(true);
    expect(vatAtRedemption("day")).toBe(false);
    expect(vatAtRedemption("night")).toBe(false);
  });
});
