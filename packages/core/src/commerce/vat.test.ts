import { describe, expect, it } from "vitest";
import { divRoundHalfUp, percentOf, sumVat, vatOf } from "./vat";

describe("vatOf", () => {
  it("extracts 6, 12 and 21 % VAT from VAT-inclusive totals", () => {
    expect(vatOf(10_600, 6)).toBe(600);
    expect(vatOf(11_200, 12)).toBe(1_200);
    expect(vatOf(12_100, 21)).toBe(2_100);
    expect(vatOf(4_500, 21)).toBe(781); // 4500 * 21 / 121 = 780.99
    expect(vatOf(9_500, 6)).toBe(538); // 537.74
  });

  it("is 0 for the 0 % rate and for a 0 total", () => {
    expect(vatOf(2_500, 0)).toBe(0);
    expect(vatOf(0, 21)).toBe(0);
  });

  it("accepts the numeric string Postgres returns for numeric(4,2)", () => {
    expect(vatOf(12_100, "21.00")).toBe(2_100);
  });

  it("rounds half up at exactly .5 cent", () => {
    expect(divRoundHalfUp(1, 2)).toBe(1);
    expect(divRoundHalfUp(3, 2)).toBe(2);
    expect(divRoundHalfUp(5, 4)).toBe(1); // 1.25
    expect(divRoundHalfUp(-1, 2)).toBe(-1); // away from zero
    expect(vatOf(42, 12)).toBe(5); // 42 * 12 / 112 = 4.5
    expect(vatOf(126, 12)).toBe(14); // 13.5
  });

  it("percentOf rounds the per-unit discount half up (rule 10)", () => {
    expect(percentOf(4_500, 10)).toBe(450);
    expect(percentOf(4_505, 10)).toBe(451); // 450.5
    expect(percentOf(999, 12.5)).toBe(125); // 124.875
  });
});

describe("sumVat", () => {
  it("sums the VAT of each line, never VAT of the sum", () => {
    const lines = [
      { lineTotalCents: 4_550, vatRatePct: 21 },
      { lineTotalCents: 4_550, vatRatePct: 21 },
      { lineTotalCents: 9_500, vatRatePct: 6 },
    ];
    expect(sumVat(lines)).toBe(790 + 790 + 538); // 789.67 rounds up twice
    expect(vatOf(9_100, 21)).toBe(1_579); // VAT of the sum would lose a cent
  });
});
