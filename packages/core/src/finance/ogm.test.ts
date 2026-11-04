import { describe, expect, it } from "vitest";
import { formatStructuredCommunication, isValidStructuredCommunication, ogmCheckDigits, structuredCommunication } from "./ogm";

describe("structuredCommunication", () => {
  it("builds the spec example: year 2026, invoice 123", () => {
    expect(structuredCommunication(2026, 123)).toBe("+++260/0000/12395+++");
  });

  it("checks with base mod 97", () => {
    // 2600000001 mod 97 = 70
    expect(ogmCheckDigits("2600000001")).toBe("70");
    expect(structuredCommunication(2026, 1)).toBe(formatStructuredCommunication(`2600000001${ogmCheckDigits("2600000001")}`));
    expect(ogmCheckDigits("0000000005")).toBe("05");
  });

  it("writes a remainder of 0 as 97", () => {
    // 0000000097 mod 97 = 0, so the check digits are 97.
    expect(ogmCheckDigits("0000000097")).toBe("97");
    // The first invoice number of 2026 whose base is a multiple of 97.
    let n = 1;
    while (BigInt(`26${String(n).padStart(8, "0")}`) % 97n !== 0n) n++;
    expect(structuredCommunication(2026, n).slice(-5, -3)).toBe("97");
    expect(isValidStructuredCommunication(structuredCommunication(2026, n))).toBe(true);
  });

  it("formats as +++DDD/DDDD/DDDDD+++ with twelve digits", () => {
    const s = structuredCommunication(2027, 98_765);
    expect(s).toMatch(/^\+\+\+\d{3}\/\d{4}\/\d{5}\+\+\+$/);
    expect(s.replace(/\D/g, "").slice(0, 10)).toBe("2700098765");
  });

  it("validates communications and refuses bad input", () => {
    expect(isValidStructuredCommunication("+++260/0000/12395+++")).toBe(true);
    expect(isValidStructuredCommunication("***260/0000/12395***")).toBe(true);
    expect(isValidStructuredCommunication("260000012395")).toBe(true);
    expect(isValidStructuredCommunication("+++260/0000/12396+++")).toBe(false);
    expect(isValidStructuredCommunication("+++260/0000/1239+++")).toBe(false);
    expect(() => structuredCommunication(2026, 0)).toThrow(RangeError);
    expect(() => structuredCommunication(1999, 1)).toThrow(RangeError);
    expect(() => ogmCheckDigits("123")).toThrow(RangeError);
    expect(() => formatStructuredCommunication("123")).toThrow(RangeError);
  });
});
