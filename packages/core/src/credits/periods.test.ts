import { describe, expect, it } from "vitest";
import { brusselsDateKey } from "./expiry";
import { addBrusselsDays, anchorDayOf, atWallTimeOf, DEFAULT_DUNNING, dunningSchedule, nextPeriod, renewalLeadDates, renewalReminderDays } from "./periods";

const key = (d: Date) => brusselsDateKey(d);

describe("nextPeriod", () => {
  it("31 Jan -> 28 Feb -> 31 Mar (anchor day, not previous end)", () => {
    const start = new Date("2027-01-31T09:00:00Z"); // 10:00 Brussels
    const anchor = anchorDayOf(start);
    expect(anchor).toBe(31);
    const p1 = nextPeriod(start, "month", anchor);
    expect(p1.start).toBe(start);
    expect(p1.end.toISOString()).toBe("2027-02-28T09:00:00.000Z");
    const p2 = nextPeriod(p1.end, "month", anchor);
    expect(p2.end.toISOString()).toBe("2027-03-31T08:00:00.000Z"); // 10:00 Brussels after the March DST change
    const p3 = nextPeriod(p2.end, "month", anchor);
    expect(key(p3.end)).toBe("2027-04-30");
  });

  it("31 Jan -> 29 Feb in a leap year", () => {
    const start = new Date("2028-01-31T09:00:00Z");
    const p1 = nextPeriod(start, "month", 31);
    expect(key(p1.end)).toBe("2028-02-29");
    expect(key(nextPeriod(p1.end, "month", 31).end)).toBe("2028-03-31");
  });

  it("crosses the year end", () => {
    const p = nextPeriod(new Date("2026-12-15T11:00:00Z"), "month", 15);
    expect(p.end.toISOString()).toBe("2027-01-15T11:00:00.000Z");
  });

  it("yearly on 29 Feb renews 28 Feb, then 29 Feb again in the next leap year", () => {
    const start = new Date("2028-02-29T11:00:00Z");
    const anchor = anchorDayOf(start);
    const ends: string[] = [];
    let s = start;
    for (let i = 0; i < 4; i++) {
      const p = nextPeriod(s, "year", anchor);
      ends.push(key(p.end));
      s = p.end;
    }
    expect(ends).toEqual(["2029-02-28", "2030-02-28", "2031-02-28", "2032-02-29"]);
  });

  it("keeps the Brussels wall time and milliseconds across DST", () => {
    const start = new Date("2026-10-10T08:30:15.250Z"); // 10:30:15.250 Brussels, summer time
    expect(nextPeriod(start, "month", 10).end.toISOString()).toBe("2026-11-10T09:30:15.250Z");
  });

  it("uses the Brussels date of a start just after local midnight", () => {
    const start = new Date("2026-04-30T22:30:00Z"); // 1 May 00:30 Brussels
    expect(anchorDayOf(start)).toBe(1);
    expect(nextPeriod(start, "month", 1).end.toISOString()).toBe("2026-05-31T22:30:00.000Z");
  });

  it("refuses an invalid anchor or start", () => {
    expect(() => nextPeriod(new Date("2026-01-01T00:00:00Z"), "month", 0)).toThrow(RangeError);
    expect(() => nextPeriod(new Date("2026-01-01T00:00:00Z"), "month", 32)).toThrow(RangeError);
    expect(() => nextPeriod(new Date("x"), "month", 1)).toThrow(RangeError);
  });
});

describe("dunningSchedule", () => {
  it("retries on day 3 and 7 and expires on day 10 after the first failure", () => {
    const first = new Date("2026-11-05T05:10:00Z"); // 06:10 Brussels
    const s = dunningSchedule(first);
    expect(s.retry2At.toISOString()).toBe("2026-11-08T05:10:00.000Z");
    expect(s.retry3At.toISOString()).toBe("2026-11-12T05:10:00.000Z");
    expect(s.expireAt.toISOString()).toBe("2026-11-15T05:10:00.000Z");
  });

  it("keeps the wall time across the October DST change", () => {
    const s = dunningSchedule(new Date("2026-10-20T04:10:00Z")); // 06:10 summer time
    expect(s.expireAt.toISOString()).toBe("2026-10-30T05:10:00.000Z"); // 06:10 winter time
  });

  it("link path: dates count from the period end", () => {
    const periodEnd = new Date("2027-01-31T09:00:00Z");
    const s = dunningSchedule(periodEnd, DEFAULT_DUNNING);
    expect(key(s.retry2At)).toBe("2027-02-03");
    expect(key(s.retry3At)).toBe("2027-02-07");
    expect(key(s.expireAt)).toBe("2027-02-10");
  });

  it("follows custom settings and refuses inconsistent ones", () => {
    const s = dunningSchedule(new Date("2026-11-01T10:00:00Z"), { retryDays: [2, 5], expireDay: 14 });
    expect(key(s.retry2At)).toBe("2026-11-03");
    expect(key(s.expireAt)).toBe("2026-11-15");
    expect(() => dunningSchedule(new Date(), { retryDays: [3], expireDay: 10 })).toThrow(RangeError);
    expect(() => dunningSchedule(new Date(), { retryDays: [7, 3], expireDay: 10 })).toThrow(RangeError);
    expect(() => dunningSchedule(new Date(), { retryDays: [3, 7], expireDay: 7 })).toThrow(RangeError);
  });
});

describe("renewal dates", () => {
  it("charges 3 days and creates the link order 7 days before period end", () => {
    const end = new Date("2026-12-01T09:00:00Z");
    const d = renewalLeadDates(end);
    expect(d.chargeAt.toISOString()).toBe("2026-11-28T09:00:00.000Z");
    expect(d.linkOrderAt.toISOString()).toBe("2026-11-24T09:00:00.000Z");
    expect(d.linkReminderAt.toISOString()).toBe("2026-11-28T09:00:00.000Z");
    expect(addBrusselsDays(end, 0).toISOString()).toBe(end.toISOString());
  });

  it("reminds yearly plans at 30 and 7 days, monthly plans only without mandate or when ending", () => {
    expect(renewalReminderDays({ interval: "year", hasValidMandate: true, isEnding: false })).toEqual([30, 7]);
    expect(renewalReminderDays({ interval: "month", hasValidMandate: true, isEnding: false })).toEqual([]);
    expect(renewalReminderDays({ interval: "month", hasValidMandate: false, isEnding: false })).toEqual([7]);
    expect(renewalReminderDays({ interval: "month", hasValidMandate: true, isEnding: true })).toEqual([7]);
    expect(renewalReminderDays({ interval: "year", hasValidMandate: true, isEnding: false, yearlyDays: [14] })).toEqual([14]);
    expect(renewalReminderDays({ interval: "month", hasValidMandate: false, isEnding: false, monthlyDays: [5] })).toEqual([5]);
  });
});

describe("addBrusselsDays and atWallTimeOf across DST (fix-w09-credits-review 5)", () => {
  // End of day 23:59:59.999 Brussels from or into a 23- or 25-hour day stays end of day on the target date.
  it.each([
    ["end of 25 Oct (25-hour day) + 7", "2026-10-25T22:59:59.999Z", 7, "2026-11-01T22:59:59.999Z"],
    ["end of 22 Mar + 7 (into the 23-hour day)", "2026-03-22T22:59:59.999Z", 7, "2026-03-29T21:59:59.999Z"],
    ["end of 18 Oct + 7 (into the 25-hour day)", "2026-10-18T21:59:59.999Z", 7, "2026-10-25T22:59:59.999Z"],
    ["end of 29 Mar (23-hour day) - 7", "2026-03-29T21:59:59.999Z", -7, "2026-03-22T22:59:59.999Z"],
  ])("%s", (_label, from, days, expected) => {
    expect(addBrusselsDays(new Date(from), days).toISOString()).toBe(expected);
  });

  it("atWallTimeOf keeps the hour, minute and milliseconds on another date", () => {
    expect(atWallTimeOf(new Date("2026-11-25T09:00:00.000Z"), { year: 2026, month: 10, day: 25 }).toISOString()).toBe("2026-10-25T09:00:00.000Z");
    expect(atWallTimeOf(new Date("2026-03-22T22:59:59.999Z"), { year: 2026, month: 3, day: 29 }).toISOString()).toBe("2026-03-29T21:59:59.999Z");
  });
});
