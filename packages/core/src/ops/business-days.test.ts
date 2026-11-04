import { describe, expect, it } from "vitest";
import { DEFAULT_BUSINESS_HOURS, type BusinessHours } from "../booking/rules";
import { BE_PUBLIC_HOLIDAYS, isBusinessDay, nextBusinessDay } from "./business-days";

const open = { opens_at: "09:00", closes_at: "18:00" };
/** Monday to Friday open, weekend closed. */
const weekdays: BusinessHours = { ...DEFAULT_BUSINESS_HOURS, week: { 1: open, 2: open, 3: open, 4: open, 5: open, 6: null, 7: null } };

describe("BE_PUBLIC_HOLIDAYS", () => {
  it("2026: the ten legal days with Easter Monday 6 April, Ascension 14 May and Whit Monday 25 May", () => {
    expect(BE_PUBLIC_HOLIDAYS(2026)).toEqual([
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

  it("2027 and 2028", () => {
    expect(BE_PUBLIC_HOLIDAYS(2027)).toEqual([
      "2027-01-01",
      "2027-03-29",
      "2027-05-01",
      "2027-05-06",
      "2027-05-17",
      "2027-07-21",
      "2027-08-15",
      "2027-11-01",
      "2027-11-11",
      "2027-12-25",
    ]);
    expect(BE_PUBLIC_HOLIDAYS(2028)).toEqual([
      "2028-01-01",
      "2028-04-17",
      "2028-05-01",
      "2028-05-25",
      "2028-06-05",
      "2028-07-21",
      "2028-08-15",
      "2028-11-01",
      "2028-11-11",
      "2028-12-25",
    ]);
  });

  it("returns a copy", () => {
    BE_PUBLIC_HOLIDAYS(2026).pop();
    expect(BE_PUBLIC_HOLIDAYS(2026)).toHaveLength(10);
  });
});

describe("nextBusinessDay", () => {
  it("Friday to Monday 10:00 Brussels", () => {
    // Friday 6 November 2026, 15:00 Brussels.
    expect(nextBusinessDay(new Date("2026-11-06T14:00:00Z"), weekdays, []).toISOString()).toBe("2026-11-09T09:00:00.000Z");
  });

  it("is the following day on a normal weekday, in summer time too", () => {
    expect(nextBusinessDay(new Date("2026-06-16T08:00:00Z"), weekdays, []).toISOString()).toBe("2026-06-17T08:00:00.000Z");
  });

  it("skips a booking closed day", () => {
    expect(nextBusinessDay(new Date("2026-11-06T14:00:00Z"), weekdays, ["2026-11-09"]).toISOString()).toBe("2026-11-10T09:00:00.000Z");
  });

  it("skips 21 July", () => {
    // Monday 20 July 2026 -> Tuesday 21 July is the national holiday -> Wednesday 22 July.
    expect(nextBusinessDay(new Date("2026-07-20T10:00:00Z"), weekdays, []).toISOString()).toBe("2026-07-22T08:00:00.000Z");
  });

  it("skips Easter Monday and a closed weekday of the business hours", () => {
    // Default hours: Monday closed. Saturday 4 April 2026 -> Sunday 5 April open.
    expect(nextBusinessDay(new Date("2026-04-04T10:00:00Z"), DEFAULT_BUSINESS_HOURS, []).toISOString()).toBe("2026-04-05T08:00:00.000Z");
    // Sunday 5 April -> Monday 6 April is closed and Easter Monday -> Tuesday 7 April.
    expect(nextBusinessDay(new Date("2026-04-05T10:00:00Z"), weekdays, []).toISOString()).toBe("2026-04-07T08:00:00.000Z");
  });

  it("uses the Brussels date of `at` (late evening UTC is already tomorrow)", () => {
    // 23:30 UTC Thursday 5 November = 00:30 Friday 6 November in Brussels -> Monday 9.
    expect(nextBusinessDay(new Date("2026-11-05T23:30:00Z"), weekdays, []).toISOString()).toBe("2026-11-09T09:00:00.000Z");
  });

  it("throws when every weekday is closed", () => {
    const closed: BusinessHours = { ...DEFAULT_BUSINESS_HOURS, week: { 1: null, 2: null, 3: null, 4: null, 5: null, 6: null, 7: null } };
    expect(() => nextBusinessDay(new Date("2026-11-06T14:00:00Z"), closed, [])).toThrow(RangeError);
  });

  it("isBusinessDay combines the three rules", () => {
    expect(isBusinessDay("2026-11-11", weekdays, [])).toBe(false);
    expect(isBusinessDay("2026-11-12", weekdays, [])).toBe(true);
    expect(isBusinessDay("2026-11-12", weekdays, ["2026-11-12"])).toBe(false);
    expect(isBusinessDay("2026-11-14", weekdays, [])).toBe(false);
  });
});
