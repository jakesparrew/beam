import { describe, expect, it } from "vitest";
import {
  effectiveRetentionDays,
  isBelowLegalFloor,
  LEGAL_MIN_RETENTION_DAYS,
  LEGAL_MIN_RETENTION_YEARS,
  retentionCutoffYear,
  retentionHorizon,
  sweepableFiscalYear,
} from "./retention";

describe("retention of accounting documents", () => {
  it("the legal floor is ten years, 3653 days", () => {
    expect(LEGAL_MIN_RETENTION_YEARS).toBe(10);
    expect(LEGAL_MIN_RETENTION_DAYS).toBe(3653);
  });

  it("counts the seeded 3653 days from 1 January after the fiscal year", () => {
    // Fiscal year 2026: counted from 2027-01-01, ten years later is 2037-01-01.
    expect(retentionHorizon(2026, 3653)).toBe("2037-01-01");
    expect(retentionCutoffYear("2036-12-31", 3653, "anonymise")).toBe(2025);
    expect(retentionCutoffYear("2037-01-01", 3653, "anonymise")).toBe(2026);
    expect(retentionCutoffYear("2037-06-30", 3653, "delete")).toBe(2026);
    expect(retentionCutoffYear("2038-01-01", 3653, "anonymise")).toBe(2027);
  });

  it("a longer policy moves the horizon later", () => {
    expect(retentionHorizon(2026, 4000)).toBe("2037-12-14");
    expect(retentionCutoffYear("2037-06-30", 4000, "anonymise")).toBe(2025);
  });

  it("neither anonymise nor delete reaches a fiscal year whose horizon has not passed, even below 3653 days", () => {
    for (const action of ["anonymise", "delete"] as const) {
      for (const days of [0, 30, 365, 3000, 3652]) {
        expect(retentionCutoffYear("2036-12-31", days, action), `${action} ${days}`).toBe(2025);
        expect(retentionCutoffYear("2030-05-01", days, action), `${action} ${days}`).toBe(2019);
      }
      // Every fiscal year up to the result is past its legal horizon on that day.
      for (const today of ["2036-12-31", "2037-01-01", "2040-03-15"]) {
        const y = retentionCutoffYear(today, 1, action);
        expect(retentionHorizon(y, LEGAL_MIN_RETENTION_DAYS) <= today).toBe(true);
        expect(retentionHorizon(y + 1, LEGAL_MIN_RETENTION_DAYS) > today).toBe(true);
      }
    }
    expect(effectiveRetentionDays(30)).toBe(3653);
    expect(effectiveRetentionDays(5000)).toBe(5000);
    expect(isBelowLegalFloor(3652)).toBe(true);
    expect(isBelowLegalFloor(3653)).toBe(false);
  });

  it("a sweep handler given ops' cutoff never goes below the floor", () => {
    const now = new Date("2037-03-01T10:00:00Z");
    // Policy edited to 30 days: the cutoff is a month ago, but the floor keeps 2027 onwards.
    expect(sweepableFiscalYear(new Date("2037-01-30T10:00:00Z"), now)).toBe(2026);
    // Policy of 3653 days: cutoff 2027-02-28, fiscal year 2026 is past.
    expect(sweepableFiscalYear(new Date(now.getTime() - 3653 * 86_400_000), now)).toBe(2026);
    // A longer policy wins.
    expect(sweepableFiscalYear(new Date("2025-06-01T10:00:00Z"), now)).toBe(2024);
  });

  it("refuses bad input", () => {
    expect(() => retentionCutoffYear("2037-02-30", 3653, "anonymise")).toThrow(RangeError);
    expect(() => retentionCutoffYear("20370101", 3653, "anonymise")).toThrow(RangeError);
    expect(() => retentionCutoffYear("2037-01-01", -1, "delete")).toThrow(RangeError);
    expect(() => retentionCutoffYear("2037-01-01", 3653, "keep" as never)).toThrow(RangeError);
  });
});
