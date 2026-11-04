import { describe, expect, it } from "vitest";
import { AcquisitionSchema, captureAcquisition, hasAcquisitionSource, reduceAcquisitionForErasure } from "./acquisition";
import { formatCustomerNumber } from "./types";

const at = new Date("2026-11-03T10:00:00Z");

describe("acquisition (rule 3.4)", () => {
  it("3.4 stamps captured_at and keeps the known fields", () => {
    expect(captureAcquisition({ source: "paid_meta", campaign: "spring", utm: { source: "fb" } }, at)).toEqual({
      source: "paid_meta",
      campaign: "spring",
      utm: { source: "fb" },
      captured_at: "2026-11-03T10:00:00.000Z",
    });
  });

  it("a guest needs the booking owner as referrer", () => {
    expect(() => captureAcquisition({ source: "guest" }, at)).toThrow();
    expect(captureAcquisition({ source: "guest", referrer_person_id: "8d2f4e0a-1b2c-4d3e-8f40-5a6b7c8d9e0f" }, at).source).toBe("guest");
  });

  it("refuses unknown sources and unknown keys", () => {
    expect(AcquisitionSchema.safeParse({ source: "tv", captured_at: at.toISOString() }).success).toBe(false);
    expect(AcquisitionSchema.safeParse({ source: "website", captured_at: at.toISOString(), national_number: "x" }).success).toBe(false);
    expect(AcquisitionSchema.safeParse({ source: "website", captured_at: at.toISOString() }).success).toBe(true);
  });

  it("3.4 knows when a source is already set; erasure keeps source, campaign and medium", () => {
    expect(hasAcquisitionSource({})).toBe(false);
    expect(hasAcquisitionSource({ source: "website" })).toBe(true);
    expect(reduceAcquisitionForErasure({ source: "referral", campaign: "c", medium: "m", referrer_person_id: "x", captured_at: "t" })).toEqual({ source: "referral", campaign: "c", medium: "m" });
  });

  it("formats customer numbers as C-000123", () => {
    expect(formatCustomerNumber(123)).toBe("C-000123");
    expect(formatCustomerNumber(1234567)).toBe("C-1234567");
  });
});
