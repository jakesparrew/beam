import { describe, expect, it } from "vitest";
import { comparePeriods, periodRange } from "./periods";

const iso = (d: Date) => d.toISOString();

describe("periodRange (rule 34, Brussels time)", () => {
  it("day: the Brussels day and the day before", () => {
    // 23:30 UTC on 3 November is 00:30 on 4 November in Brussels (CET, UTC+1).
    const r = periodRange("day", new Date("2026-11-03T23:30:00Z"));
    expect(iso(r.from)).toBe("2026-11-03T23:00:00.000Z");
    expect(iso(r.to)).toBe("2026-11-04T23:00:00.000Z");
    expect(iso(r.prevFrom)).toBe("2026-11-02T23:00:00.000Z");
    expect(iso(r.prevTo)).toBe(iso(r.from));
  });

  it("week: ISO week Monday to Sunday", () => {
    // Wednesday 4 November 2026 -> Monday 2 November to Monday 9 November.
    const r = periodRange("week", new Date("2026-11-04T12:00:00Z"));
    expect(iso(r.from)).toBe("2026-11-01T23:00:00.000Z");
    expect(iso(r.to)).toBe("2026-11-08T23:00:00.000Z");
    expect(iso(r.prevFrom)).toBe("2026-10-25T23:00:00.000Z");
    expect(iso(r.prevTo)).toBe(iso(r.from));
    // A Sunday belongs to the week that started six days before.
    const sunday = periodRange("week", new Date("2026-11-08T20:00:00Z"));
    expect(iso(sunday.from)).toBe(iso(r.from));
    // A Monday starts its own week.
    const monday = periodRange("week", new Date("2026-11-09T06:00:00Z"));
    expect(iso(monday.from)).toBe(iso(r.to));
  });

  it("week across the autumn DST change has 169 hours and ends at local midnight", () => {
    // 25 October 2026: clocks go back. The week of 19-25 October starts in CEST.
    const r = periodRange("week", new Date("2026-10-22T10:00:00Z"));
    expect(iso(r.from)).toBe("2026-10-18T22:00:00.000Z");
    expect(iso(r.to)).toBe("2026-10-25T23:00:00.000Z");
    expect((r.to.getTime() - r.from.getTime()) / 3_600_000).toBe(7 * 24 + 1);
  });

  it("day on the spring DST Sunday has 23 hours", () => {
    const r = periodRange("day", new Date("2026-03-29T12:00:00Z"));
    expect(iso(r.from)).toBe("2026-03-28T23:00:00.000Z");
    expect(iso(r.to)).toBe("2026-03-29T22:00:00.000Z");
  });

  it("month-to-date on 31 March compares with the whole of February", () => {
    const r = periodRange("month", new Date("2026-03-31T10:00:00Z"));
    expect(iso(r.from)).toBe("2026-02-28T23:00:00.000Z"); // 1 March 00:00 CET
    expect(iso(r.to)).toBe("2026-03-31T22:00:00.000Z"); // 1 April 00:00 CEST
    expect(iso(r.prevFrom)).toBe("2026-01-31T23:00:00.000Z"); // 1 February
    expect(iso(r.prevTo)).toBe("2026-02-28T23:00:00.000Z"); // 1 March: all 28 days of February
  });

  it("month-to-date on 10 March compares with 1-10 February", () => {
    const r = periodRange("month", new Date("2026-03-10T10:00:00Z"));
    expect(iso(r.prevFrom)).toBe("2026-01-31T23:00:00.000Z");
    expect(iso(r.prevTo)).toBe("2026-02-10T23:00:00.000Z");
  });

  it("month-to-date in January compares with December of the year before", () => {
    const r = periodRange("month", new Date("2026-01-15T10:00:00Z"));
    expect(iso(r.prevFrom)).toBe("2025-11-30T23:00:00.000Z");
    expect(iso(r.prevTo)).toBe("2025-12-15T23:00:00.000Z");
  });

  it("YTD against the same span of the previous year", () => {
    const r = periodRange("ytd", new Date("2026-11-04T10:00:00Z"));
    expect(iso(r.from)).toBe("2025-12-31T23:00:00.000Z");
    expect(iso(r.to)).toBe("2026-11-04T23:00:00.000Z");
    expect(iso(r.prevFrom)).toBe("2024-12-31T23:00:00.000Z");
    expect(iso(r.prevTo)).toBe("2025-11-04T23:00:00.000Z");
  });

  it("YTD on 29 February compares up to 28 February", () => {
    const r = periodRange("ytd", new Date("2028-02-29T10:00:00Z"));
    expect(iso(r.prevTo)).toBe("2027-02-28T23:00:00.000Z");
  });

  it("last_30d: thirty days including today", () => {
    const r = periodRange("last_30d", new Date("2026-11-04T10:00:00Z"));
    expect(iso(r.to)).toBe("2026-11-04T23:00:00.000Z");
    expect(iso(r.from)).toBe("2026-10-05T22:00:00.000Z"); // 6 October 00:00 CEST
    expect(iso(r.prevTo)).toBe(iso(r.from));
  });
});

describe("comparePeriods", () => {
  it("gives absolute and percentage change, blank percentage when the previous value is 0", () => {
    expect(comparePeriods(150, 100)).toEqual({ current: 150, previous: 100, change: 50, changePct: 50 });
    expect(comparePeriods(50, 100).changePct).toBe(-50);
    expect(comparePeriods(10, 0).changePct).toBeNull();
  });
});
