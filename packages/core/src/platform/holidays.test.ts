import { describe, expect, it } from "vitest";
import { belgianPublicHolidays, easterSunday, isBelgianPublicHoliday } from "./holidays";

const on = (year: number, key: string) => belgianPublicHolidays(year).find((h) => h.key === key)?.on;

describe("belgianPublicHolidays", () => {
  it("2026: Easter Monday 6 April, Ascension 14 May, Whit Monday 25 May", () => {
    expect(on(2026, "easter_monday")).toBe("2026-04-06");
    expect(on(2026, "ascension")).toBe("2026-05-14");
    expect(on(2026, "whit_monday")).toBe("2026-05-25");
  });

  it("2027: Easter Monday 29 March", () => {
    expect(on(2027, "easter_monday")).toBe("2027-03-29");
  });

  it("ten dates per year, sorted, with the fixed days", () => {
    for (const year of [2025, 2026, 2027, 2028, 2030]) {
      const list = belgianPublicHolidays(year);
      expect(list).toHaveLength(10);
      expect(new Set(list.map((h) => h.on)).size).toBe(10);
      expect([...list].sort((a, b) => a.on.localeCompare(b.on))).toEqual(list);
    }
    expect(belgianPublicHolidays(2026).map((h) => h.on)).toEqual([
      "2026-01-01",
      "2026-04-06",
      "2026-05-01",
      "2026-05-14",
      "2026-05-25",
      "2026-07-21",
      "2026-08-15",
      "2026-11-01",
      "2026-11-11",
      "2026-12-25",
    ]);
  });

  it("computes Easter Sunday by the anonymous Gregorian algorithm", () => {
    expect(easterSunday(2024)).toEqual([3, 31]);
    expect(easterSunday(2026)).toEqual([4, 5]);
    expect(easterSunday(2038)).toEqual([4, 25]);
    expect(easterSunday(2285)).toEqual([3, 22]);
  });

  it("answers single dates and returns copies", () => {
    expect(isBelgianPublicHoliday("2026-07-21")).toBe(true);
    expect(isBelgianPublicHoliday("2026-07-22")).toBe(false);
    belgianPublicHolidays(2026)[0]!.on = "x";
    expect(on(2026, "new_year")).toBe("2026-01-01");
  });
});
