import { describe, expect, it } from "vitest";
import { belgianPublicHolidays, brusselsDate, brusselsDayBounds, brusselsInstant, sendWindowWarnings } from "./send-window";

describe("belgianPublicHolidays", () => {
  it("lists the ten legal holidays of 2027 with the Easter-based ones computed", () => {
    expect(belgianPublicHolidays(2027)).toEqual([
      "2027-01-01",
      "2027-03-29", // Easter Monday
      "2027-05-01",
      "2027-05-06", // Ascension
      "2027-05-17", // Whit Monday
      "2027-07-21",
      "2027-08-15",
      "2027-11-01",
      "2027-11-11",
      "2027-12-25",
    ]);
  });

  it("computes Easter Monday, Ascension and Whit Monday for 2026", () => {
    const days = belgianPublicHolidays(2026);
    expect(days).toContain("2026-04-06");
    expect(days).toContain("2026-05-14");
    expect(days).toContain("2026-05-25");
    expect(days).toHaveLength(10);
  });
});

describe("sendWindowWarnings (rule 26)", () => {
  it("is empty on a weekday inside 08:00-21:00 Brussels", () => {
    expect(sendWindowWarnings(new Date("2027-03-24T09:00:00Z"))).toEqual([]); // Wed 10:00 CET
    expect(sendWindowWarnings(new Date("2027-03-24T07:00:00Z"))).toEqual([]); // Wed 08:00 CET
    expect(sendWindowWarnings(new Date("2027-03-24T19:59:00Z"))).toEqual([]); // Wed 20:59 CET
  });

  it("warns for Easter Monday 2027-03-29 at 07:00 (edge case 29)", () => {
    expect(sendWindowWarnings(new Date("2027-03-29T05:00:00Z"))).toEqual(["before_8", "public_holiday"]); // 07:00 CEST
  });

  it("warns for Ascension, Whit Monday and 11 November", () => {
    expect(sendWindowWarnings(new Date("2027-05-06T08:00:00Z"))).toEqual(["public_holiday"]);
    expect(sendWindowWarnings(new Date("2027-05-17T08:00:00Z"))).toEqual(["public_holiday"]);
    expect(sendWindowWarnings(new Date("2026-11-11T09:00:00Z"))).toEqual(["public_holiday"]);
  });

  it("warns on Sundays", () => {
    expect(sendWindowWarnings(new Date("2027-03-21T10:00:00Z"))).toEqual(["sunday"]);
  });

  it("uses Brussels wall-clock time across the DST change (28 March 2027)", () => {
    // Winter time, Friday 26 March: UTC+1.
    expect(sendWindowWarnings(new Date("2027-03-26T06:59:00Z"))).toEqual(["before_8"]); // 07:59
    expect(sendWindowWarnings(new Date("2027-03-26T07:00:00Z"))).toEqual([]); // 08:00
    expect(sendWindowWarnings(new Date("2027-03-26T20:00:00Z"))).toEqual(["after_21"]); // 21:00
    expect(sendWindowWarnings(new Date("2027-03-26T19:59:00Z"))).toEqual([]); // 20:59
    // Summer time, Tuesday 30 March: UTC+2. The same UTC times are an hour later locally.
    expect(sendWindowWarnings(new Date("2027-03-30T05:59:00Z"))).toEqual(["before_8"]); // 07:59
    expect(sendWindowWarnings(new Date("2027-03-30T06:59:00Z"))).toEqual([]); // 08:59
    expect(sendWindowWarnings(new Date("2027-03-30T19:00:00Z"))).toEqual(["after_21"]); // 21:00
    expect(sendWindowWarnings(new Date("2027-03-30T18:59:00Z"))).toEqual([]); // 20:59
    // Autumn change, Monday 1 November 2027 is All Saints; Tuesday 2 November is UTC+1 again.
    expect(sendWindowWarnings(new Date("2027-11-02T06:59:00Z"))).toEqual(["before_8"]);
  });

  it("reads the Brussels date of late-evening UTC instants", () => {
    expect(brusselsDate(new Date("2027-03-28T22:30:00Z"))).toBe("2027-03-29");
    expect(sendWindowWarnings(new Date("2027-03-28T22:30:00Z"))).toEqual(["before_8", "public_holiday"]); // Mon 00:30 CEST
  });
});

describe("Brussels calendar helpers", () => {
  it("builds instants from wall-clock times in both seasons", () => {
    expect(brusselsInstant("2027-01-15", 9)).toEqual(new Date("2027-01-15T08:00:00Z"));
    expect(brusselsInstant("2027-07-15", 9)).toEqual(new Date("2027-07-15T07:00:00Z"));
  });

  it("gives 23- and 25-hour days at the DST changes", () => {
    const spring = brusselsDayBounds(new Date("2027-03-28T12:00:00Z"));
    expect(spring.end.getTime() - spring.start.getTime()).toBe(23 * 3_600_000);
    expect(spring.start).toEqual(new Date("2027-03-27T23:00:00Z"));
    const autumn = brusselsDayBounds(new Date("2027-10-31T12:00:00Z"));
    expect(autumn.end.getTime() - autumn.start.getTime()).toBe(25 * 3_600_000);
  });
});
