import { describe, expect, it } from "vitest";
import { zonedTimeToUtc } from "./cron";
import { DEFAULT_SUPPORT_CALENDAR, slaDueAt, supportMinutesBetween } from "./sla";

/** Brussels wall clock -> instant. */
const bx = (y: number, mo: number, d: number, h: number, mi = 0) => zonedTimeToUtc({ year: y, month: mo, day: d, hour: h, minute: mi });

describe("slaDueAt (PL-88)", () => {
  it("normal received Friday 17:30 is due Monday 17:30 (30 + 510 minutes)", () => {
    // 2026-10-30 is a Friday; Monday 2 November is a normal business day.
    expect(slaDueAt("normal", bx(2026, 10, 30, 17, 30))).toEqual(bx(2026, 11, 2, 17, 30));
  });

  it("skips Easter Monday: normal received Friday 17:30 before Easter is due Tuesday 17:30", () => {
    // Good Friday 2026-04-03 is a working day in Belgium; Easter Monday is 2026-04-06.
    expect(slaDueAt("normal", bx(2026, 4, 3, 17, 30))).toEqual(bx(2026, 4, 7, 17, 30));
  });

  it("critical received Saturday 11:00 is due Saturday 15:00 (240 weekend minutes)", () => {
    expect(slaDueAt("critical", bx(2026, 10, 31, 11, 0))).toEqual(bx(2026, 10, 31, 15, 0));
  });

  it("critical received Friday 17:00 is due Saturday 11:00, because weekend hours start at 10:00", () => {
    expect(slaDueAt("critical", bx(2026, 10, 30, 17, 0))).toEqual(bx(2026, 10, 31, 11, 0));
  });

  it("high received on Sunday counts from Monday 09:00", () => {
    expect(slaDueAt("high", bx(2026, 11, 1, 14, 0))).toEqual(bx(2026, 11, 2, 13, 0));
  });

  it("critical received on a business-day evening starts at the next opening with the business target", () => {
    expect(slaDueAt("critical", bx(2026, 11, 3, 20, 0))).toEqual(bx(2026, 11, 4, 11, 0));
    // Friday evening: the next opening is Saturday 10:00, a weekend day, so 240 minutes.
    expect(slaDueAt("critical", bx(2026, 10, 30, 20, 0))).toEqual(bx(2026, 10, 31, 14, 0));
  });

  it("critical on a public holiday uses weekend hours (Armistice, Wednesday 11 November 2026)", () => {
    expect(slaDueAt("critical", bx(2026, 11, 11, 9, 0))).toEqual(bx(2026, 11, 11, 14, 0));
  });

  it("improvement takes two business days; a request before opening starts at 09:00", () => {
    expect(slaDueAt("improvement", bx(2026, 11, 2, 7, 0))).toEqual(bx(2026, 11, 3, 18, 0));
  });

  it("honours calendar values and extra closed days", () => {
    const calendar = { ...DEFAULT_SUPPORT_CALENDAR, closed_days: ["2026-11-02"] };
    expect(slaDueAt("high", bx(2026, 11, 1, 14, 0), calendar)).toEqual(bx(2026, 11, 3, 13, 0));
    const short = { ...DEFAULT_SUPPORT_CALENDAR, response_minutes: { ...DEFAULT_SUPPORT_CALENDAR.response_minutes, high: 60 } };
    expect(slaDueAt("high", bx(2026, 11, 2, 9, 30), short)).toEqual(bx(2026, 11, 2, 10, 30));
  });

  it("works across the autumn DST change", () => {
    // Friday 23 October 2026 17:00 normal -> 60 minutes Friday, 480 on Monday 26 October (CET).
    expect(slaDueAt("normal", bx(2026, 10, 23, 17, 0))).toEqual(bx(2026, 10, 26, 17, 0));
  });

  it("supportMinutesBetween counts only support minutes", () => {
    expect(supportMinutesBetween("normal", bx(2026, 10, 30, 17, 30), bx(2026, 11, 2, 17, 30))).toBe(540);
    expect(supportMinutesBetween("critical", bx(2026, 10, 30, 17, 0), bx(2026, 10, 31, 11, 0))).toBe(120);
    expect(supportMinutesBetween("high", bx(2026, 11, 2, 12, 0), bx(2026, 11, 2, 11, 0))).toBe(0);
  });
});
