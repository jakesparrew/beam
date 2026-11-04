import { describe, expect, it } from "vitest";
import {
  addCalendarDays,
  brusselsDateKey,
  calendarDaysBetween,
  computeExpiresAt,
  expiresAt,
  expireEntryKey,
  expiryWarningDedupeKey,
  expiryWarningsDue,
} from "./expiry";

describe("computeExpiresAt", () => {
  it("is the end of the Brussels day of start + validity (winter, UTC+1)", () => {
    // 10 January 2027 15:00 Brussels + 30 days = 9 February, ends 22:59:59.999 UTC
    expect(computeExpiresAt(new Date("2027-01-10T14:00:00Z"), 30)?.toISOString()).toBe("2027-02-09T22:59:59.999Z");
  });

  it("is the end of the Brussels day in summer (UTC+2)", () => {
    expect(computeExpiresAt(new Date("2027-06-01T08:00:00Z"), 10)?.toISOString()).toBe("2027-06-11T21:59:59.999Z");
  });

  it("uses the Brussels date, not the UTC date, of a late-evening purchase", () => {
    // 23:30 UTC on 31 May is 01:30 on 1 June in Brussels
    expect(computeExpiresAt(new Date("2026-05-31T23:30:00Z"), 1)?.toISOString()).toBe("2026-06-02T21:59:59.999Z");
  });

  it("crosses the October DST change (edge case 14)", () => {
    // 30 days from 10:00 on 20 October 2026 (UTC+2) ends 19 November 23:59:59.999 (UTC+1)
    expect(computeExpiresAt(new Date("2026-10-20T08:00:00Z"), 30)?.toISOString()).toBe("2026-11-19T22:59:59.999Z");
  });

  it("crosses the March DST change", () => {
    // 10:00 on 20 March 2027 (UTC+1) + 30 days ends 19 April 23:59:59.999 (UTC+2)
    expect(computeExpiresAt(new Date("2027-03-20T09:00:00Z"), 30)?.toISOString()).toBe("2027-04-19T21:59:59.999Z");
  });

  it("ends on the DST day itself at local midnight minus 1 ms", () => {
    expect(computeExpiresAt(new Date("2026-10-24T10:00:00Z"), 1)?.toISOString()).toBe("2026-10-25T22:59:59.999Z");
    expect(computeExpiresAt(new Date("2027-03-27T10:00:00Z"), 1)?.toISOString()).toBe("2027-03-28T21:59:59.999Z");
  });

  it("returns null for null validity (never expires)", () => {
    expect(computeExpiresAt(new Date("2026-10-20T08:00:00Z"), null)).toBeNull();
  });

  it("allows 0 days (end of the same day) and refuses invalid input", () => {
    expect(computeExpiresAt(new Date("2026-12-01T08:00:00Z"), 0)?.toISOString()).toBe("2026-12-01T22:59:59.999Z");
    expect(() => computeExpiresAt(new Date("2026-12-01T08:00:00Z"), -1)).toThrow(RangeError);
    expect(() => computeExpiresAt(new Date("2026-12-01T08:00:00Z"), 1.5)).toThrow(RangeError);
    expect(() => computeExpiresAt(new Date("nope"), 1)).toThrow(RangeError);
  });

  it("is always later than the start", () => {
    const from = new Date("2026-12-31T22:59:59.999Z");
    expect(computeExpiresAt(from, 1)!.getTime()).toBeGreaterThan(from.getTime());
  });

  it("exports expiresAt as the same function", () => {
    expect(expiresAt).toBe(computeExpiresAt);
  });
});

describe("calendar helpers", () => {
  it("adds days across month and year ends and counts days between", () => {
    expect(addCalendarDays({ year: 2026, month: 12, day: 30 }, 3)).toEqual({ year: 2027, month: 1, day: 2 });
    expect(addCalendarDays({ year: 2028, month: 3, day: 1 }, -1)).toEqual({ year: 2028, month: 2, day: 29 });
    expect(calendarDaysBetween({ year: 2026, month: 10, day: 20 }, { year: 2026, month: 11, day: 19 })).toBe(30);
  });

  it("keys dates in Brussels", () => {
    expect(brusselsDateKey(new Date("2026-11-19T22:59:59.999Z"))).toBe("2026-11-19");
    expect(brusselsDateKey(new Date("2026-11-19T23:00:00Z"))).toBe("2026-11-20");
    const exp = new Date("2026-11-19T22:59:59.999Z");
    expect(expiryWarningDedupeKey("g1", 30, exp)).toBe("grant:g1:expiry:30:2026-11-19");
    expect(expireEntryKey("g1", exp)).toBe("expire:g1:2026-11-19");
  });
});

describe("expiryWarningsDue", () => {
  const exp = new Date("2026-12-31T22:59:59.999Z"); // end of 31 December Brussels
  const at = (iso: string) => new Date(iso);

  it("is due within days ± 1 of the expiry date", () => {
    expect(expiryWarningsDue(exp, at("2026-11-30T23:05:00Z"), [30, 7])).toEqual([30]); // 1 Dec 00:05 Brussels: 30 days left
    expect(expiryWarningsDue(exp, at("2026-11-29T23:05:00Z"), [30, 7])).toEqual([30]); // 31 days left
    expect(expiryWarningsDue(exp, at("2026-12-01T23:05:00Z"), [30, 7])).toEqual([30]); // 29 days left
    expect(expiryWarningsDue(exp, at("2026-12-23T23:05:00Z"), [30, 7])).toEqual([7]);
    expect(expiryWarningsDue(exp, at("2026-12-24T23:05:00Z"), [30, 7])).toEqual([7]); // 6 days left
    expect(expiryWarningsDue(exp, at("2026-12-25T23:05:00Z"), [30, 7])).toEqual([]); // 5 days left
  });

  it("is not due outside the windows or once expired", () => {
    expect(expiryWarningsDue(exp, at("2026-11-28T23:05:00Z"), [30, 7])).toEqual([]);
    expect(expiryWarningsDue(exp, at("2026-12-15T12:00:00Z"), [30, 7])).toEqual([]);
    expect(expiryWarningsDue(exp, at("2026-12-31T23:00:00Z"), [30, 7])).toEqual([]);
  });

  it("follows custom windows and ignores duplicates and invalid days", () => {
    expect(expiryWarningsDue(exp, at("2026-12-28T12:00:00Z"), [3, 3, -1, 2.5])).toEqual([3]);
    expect(expiryWarningsDue(exp, at("2026-12-30T12:00:00Z"), [2, 1])).toEqual([2, 1]);
  });
});
