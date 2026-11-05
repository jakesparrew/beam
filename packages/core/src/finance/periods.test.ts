/**
 * finance-P8: dashboard periods (finance spec rule 44). Brussels dates, ISO weeks starting
 * Monday; a week across a year boundary, year to date, leap years and DST changes.
 */
import { describe, expect, it } from "vitest";
import { isoWeekOf, isPeriodDate, periodDays, resolvePeriod, shiftPeriodYears, trendGranularity } from "./periods";

describe("resolvePeriod: day", () => {
  it("is the Brussels day with yesterday and the same date last year", () => {
    expect(resolvePeriod({ period: "day" }, new Date("2026-11-04T10:00:00Z"))).toEqual({
      from: "2026-11-04",
      to: "2026-11-04",
      previous: { from: "2026-11-03", to: "2026-11-03" },
      lastYear: { from: "2025-11-04", to: "2025-11-04" },
    });
  });

  it("uses the Brussels date around midnight on both DST changes", () => {
    // 29 March 2026: clocks go to CEST (UTC+2); 22:30 UTC is already 00:30 on 30 March.
    expect(resolvePeriod({ period: "day" }, new Date("2026-03-29T22:30:00Z")).from).toBe("2026-03-30");
    expect(resolvePeriod({ period: "day" }, new Date("2026-03-29T21:59:00Z")).from).toBe("2026-03-29");
    // 25 October 2026: back to CET (UTC+1); 22:30 UTC is 23:30 the same day, 23:00 UTC the next.
    expect(resolvePeriod({ period: "day" }, new Date("2026-10-25T22:30:00Z")).from).toBe("2026-10-25");
    expect(resolvePeriod({ period: "day" }, new Date("2026-10-25T23:00:00Z")).from).toBe("2026-10-26");
  });

  it("maps 29 February to 28 February last year", () => {
    const r = resolvePeriod({ period: "day" }, new Date("2028-02-29T12:00:00Z"));
    expect(r.previous).toEqual({ from: "2028-02-28", to: "2028-02-28" });
    expect(r.lastYear).toEqual({ from: "2027-02-28", to: "2027-02-28" });
  });
});

describe("resolvePeriod: week", () => {
  it("spans a year boundary as one ISO week, Monday to Sunday", () => {
    // Thursday 1 January 2026 is in ISO week 2026-W01 (Mon 29 Dec 2025 - Sun 4 Jan 2026).
    expect(resolvePeriod({ period: "week" }, new Date("2026-01-01T09:00:00Z"))).toEqual({
      from: "2025-12-29",
      to: "2026-01-04",
      previous: { from: "2025-12-22", to: "2025-12-28" },
      lastYear: { from: "2024-12-30", to: "2025-01-05" },
    });
  });

  it("starts on Monday when today is Sunday", () => {
    expect(resolvePeriod({ period: "week" }, new Date("2026-11-08T20:00:00Z"))).toMatchObject({ from: "2026-11-02", to: "2026-11-08" });
  });

  it("maps week 53 to week 52 of a year without a week 53", () => {
    // 2026 has 53 ISO weeks (it starts on a Thursday); 2025 has 52.
    expect(isoWeekOf("2026-12-31")).toEqual({ isoYear: 2026, week: 53 });
    expect(isoWeekOf("2027-01-02")).toEqual({ isoYear: 2026, week: 53 });
    const r = resolvePeriod({ period: "week" }, new Date("2026-12-31T12:00:00Z"));
    expect(r).toMatchObject({ from: "2026-12-28", to: "2027-01-03" });
    expect(r.lastYear).toEqual({ from: "2025-12-22", to: "2025-12-28" });
  });

  it("keeps seven calendar days over both DST changes", () => {
    const spring = resolvePeriod({ period: "week" }, new Date("2026-03-29T10:00:00Z"));
    expect(spring).toMatchObject({ from: "2026-03-23", to: "2026-03-29" });
    expect(periodDays(spring.from, spring.to)).toBe(7);
    // Sunday 25 October 23:30 UTC is already Monday 26 October 00:30 in Brussels.
    expect(resolvePeriod({ period: "week" }, new Date("2026-10-25T23:30:00Z"))).toMatchObject({ from: "2026-10-26", to: "2026-11-01" });
  });
});

describe("resolvePeriod: month", () => {
  it("is the calendar month with the previous month and the same month last year", () => {
    expect(resolvePeriod({ period: "month" }, new Date("2026-11-04T10:00:00Z"))).toEqual({
      from: "2026-11-01",
      to: "2026-11-30",
      previous: { from: "2026-10-01", to: "2026-10-31" },
      lastYear: { from: "2025-11-01", to: "2025-11-30" },
    });
  });

  it("handles January and leap-year February", () => {
    expect(resolvePeriod({ period: "month" }, new Date("2026-01-15T10:00:00Z")).previous).toEqual({ from: "2025-12-01", to: "2025-12-31" });
    const feb = resolvePeriod({ period: "month" }, new Date("2028-02-10T10:00:00Z"));
    expect(feb).toMatchObject({ from: "2028-02-01", to: "2028-02-29" });
    expect(feb.lastYear).toEqual({ from: "2027-02-01", to: "2027-02-28" });
    expect(resolvePeriod({ period: "month" }, new Date("2028-03-10T10:00:00Z")).previous).toEqual({ from: "2028-02-01", to: "2028-02-29" });
  });

  it("takes the Brussels month on the last night of a month", () => {
    // 31 October 2026 23:30 UTC is 1 November 00:30 in Brussels.
    expect(resolvePeriod({ period: "month" }, new Date("2026-10-31T23:30:00Z")).from).toBe("2026-11-01");
  });
});

describe("resolvePeriod: ytd", () => {
  it("runs from 1 January to today; previous and last year are the same span a year earlier", () => {
    expect(resolvePeriod({ period: "ytd" }, new Date("2026-11-04T10:00:00Z"))).toEqual({
      from: "2026-01-01",
      to: "2026-11-04",
      previous: { from: "2025-01-01", to: "2025-11-04" },
      lastYear: { from: "2025-01-01", to: "2025-11-04" },
    });
  });

  it("ends on 28 February last year when today is 29 February", () => {
    const r = resolvePeriod({ period: "ytd" }, new Date("2028-02-29T10:00:00Z"));
    expect(r).toMatchObject({ from: "2028-01-01", to: "2028-02-29" });
    expect(r.lastYear).toEqual({ from: "2027-01-01", to: "2027-02-28" });
  });

  it("is the Brussels new year at 23:30 UTC on 31 December", () => {
    expect(resolvePeriod({ period: "ytd" }, new Date("2026-12-31T23:30:00Z"))).toMatchObject({ from: "2027-01-01", to: "2027-01-01" });
  });
});

describe("resolvePeriod: custom", () => {
  it("compares with the span of equal length just before and with last year", () => {
    expect(resolvePeriod({ period: "custom", from: "2026-10-10", to: "2026-10-19" }, new Date())).toEqual({
      from: "2026-10-10",
      to: "2026-10-19",
      previous: { from: "2026-09-30", to: "2026-10-09" },
      lastYear: { from: "2025-10-10", to: "2025-10-19" },
    });
  });

  it("counts the leap day in the previous span", () => {
    expect(resolvePeriod({ period: "custom", from: "2028-03-01", to: "2028-03-02" }, new Date()).previous).toEqual({ from: "2028-02-28", to: "2028-02-29" });
  });

  it("refuses missing, impossible, reversed and too long ranges", () => {
    const now = new Date();
    expect(() => resolvePeriod({ period: "custom" }, now)).toThrow(RangeError);
    expect(() => resolvePeriod({ period: "custom", from: "2026-02-30", to: "2026-03-02" }, now)).toThrow(RangeError);
    expect(() => resolvePeriod({ period: "custom", from: "2026-03-02", to: "2026-03-01" }, now)).toThrow(RangeError);
    expect(() => resolvePeriod({ period: "custom", from: "2020-01-01", to: "2026-03-01" }, now)).toThrow(RangeError);
  });
});

describe("helpers", () => {
  it("validates dates, shifts years and picks the trend granularity", () => {
    expect(isPeriodDate("2028-02-29")).toBe(true);
    expect(isPeriodDate("2027-02-29")).toBe(false);
    expect(isPeriodDate(undefined)).toBe(false);
    expect(shiftPeriodYears("2028-02-29", 1)).toBe("2027-02-28");
    expect(trendGranularity({ from: "2026-11-01", to: "2026-11-30" })).toBe("day");
    expect(trendGranularity({ from: "2026-01-01", to: "2026-11-04" })).toBe("month");
  });
});
