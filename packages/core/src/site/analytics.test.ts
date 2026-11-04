import { describe, expect, it } from "vitest";
import { analyticsAllowedOnPath, gaIdFor, isGaMeasurementId } from "./analytics";

describe("analyticsAllowedOnPath (fix-w09-site-review)", () => {
  it("refuses the token pages, with or without a query", () => {
    for (const p of ["/nl/claim/x", "/fr/claim/abc?seat=1", "/nl/preferences/x", "/en/preferences/tok#top", "/nl/pay/tok", "/nl/f/intake/r/tok", "/NL/Claim/x"]) {
      expect(analyticsAllowedOnPath(p), p).toBe(false);
    }
  });

  it("allows public pages, and fails closed on a missing path", () => {
    for (const p of ["/nl", "/nl/dagsessies", "/fr/blog/claim-uw-plek", "/nl/f/intake", "/nl/preferences-uitleg", "/nl/checkout/return/1"]) {
      expect(analyticsAllowedOnPath(p), p).toBe(true);
    }
    expect(analyticsAllowedOnPath(null)).toBe(false);
    expect(analyticsAllowedOnPath("")).toBe(false);
  });
});

describe("gaIdFor", () => {
  it("returns the id only in production, switched on and valid", () => {
    expect(gaIdFor({ isProduction: true, analyticsEnabled: true, gaMeasurementId: " G-ABCD1234 " })).toBe("G-ABCD1234");
    expect(gaIdFor({ isProduction: false, analyticsEnabled: true, gaMeasurementId: "G-ABCD1234" })).toBeNull();
    expect(gaIdFor({ isProduction: true, analyticsEnabled: false, gaMeasurementId: "G-ABCD1234" })).toBeNull();
    expect(gaIdFor({ isProduction: true, analyticsEnabled: true, gaMeasurementId: "UA-1234" })).toBeNull();
    expect(isGaMeasurementId("G-ABCD")).toBe(true);
    expect(isGaMeasurementId(null)).toBe(false);
  });
});
