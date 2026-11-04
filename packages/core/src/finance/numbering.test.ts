import { describe, expect, it } from "vitest";
import { brusselsDateOf, fiscalYearOf, formatNumber, parseNumber } from "./numbering";

describe("formatNumber", () => {
  it("formats invoices and credit notes per kind and year", () => {
    expect(formatNumber("invoice", 2026, 1)).toBe("BEAM-2026-000001");
    expect(formatNumber("invoice", 2026, 123)).toBe("BEAM-2026-000123");
    expect(formatNumber("credit_note", 2026, 45)).toBe("CN-2026-000045");
  });

  it("pads to six digits and refuses numbers outside 1..999999", () => {
    expect(formatNumber("invoice", 2027, 999_999)).toBe("BEAM-2027-999999");
    expect(formatNumber("credit_note", 2030, 100_000)).toBe("CN-2030-100000");
    expect(() => formatNumber("invoice", 2026, 0)).toThrow(RangeError);
    expect(() => formatNumber("invoice", 2026, 1_000_000)).toThrow(RangeError);
    expect(() => formatNumber("invoice", 2026, 1.5)).toThrow(RangeError);
    expect(() => formatNumber("invoice", 26, 1)).toThrow(RangeError);
  });

  it("parses its own output back", () => {
    expect(parseNumber("BEAM-2026-000123")).toEqual({ kind: "invoice", year: 2026, n: 123 });
    expect(parseNumber("CN-2027-000001")).toEqual({ kind: "credit_note", year: 2027, n: 1 });
    expect(parseNumber("CN-2027-000000")).toBeNull();
    expect(parseNumber("BEAM-2026-123")).toBeNull();
    expect(parseNumber("BO-ABCDEFGH")).toBeNull();
  });
});

describe("fiscalYearOf (Europe/Brussels)", () => {
  it("takes the year from Brussels: 2026-12-31T23:30Z is already 2027", () => {
    const at = new Date("2026-12-31T23:30:00Z");
    expect(fiscalYearOf(at)).toBe(2027);
    expect(brusselsDateOf(at)).toBe("2027-01-01");
    expect(formatNumber("invoice", fiscalYearOf(at), 1)).toBe("BEAM-2027-000001");
  });

  it("stays in the old year until 23:00Z on 31 December (CET, UTC+1)", () => {
    expect(fiscalYearOf(new Date("2026-12-31T22:59:59Z"))).toBe(2026);
    expect(fiscalYearOf(new Date("2026-12-31T23:00:00Z"))).toBe(2027);
  });

  it("uses summer time (UTC+2) for the date", () => {
    expect(brusselsDateOf(new Date("2026-06-30T22:30:00Z"))).toBe("2026-07-01");
    expect(brusselsDateOf(new Date("2026-06-30T21:30:00Z"))).toBe("2026-06-30");
    expect(() => brusselsDateOf(new Date("nope"))).toThrow(RangeError);
  });
});
