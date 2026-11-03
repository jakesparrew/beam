import { describe, expect, it } from "vitest";
import {
  CronSyntaxError,
  dueSlots,
  isHourlyOrLonger,
  localHourKey,
  matchesCron,
  parseCron,
  slotsBetween,
  wallClock,
  zonedTimeToUtc,
} from "./cron";

const at = (iso: string) => new Date(iso);
const local = (year: number, month: number, day: number, hour: number, minute: number) => ({ year, month, day, hour, minute });

describe("matchesCron", () => {
  it("every 5 minutes", () => {
    expect(matchesCron("*/5 * * * *", local(2026, 11, 3, 14, 0))).toBe(true);
    expect(matchesCron("*/5 * * * *", local(2026, 11, 3, 14, 35))).toBe(true);
    expect(matchesCron("*/5 * * * *", local(2026, 11, 3, 14, 36))).toBe(false);
  });

  it("daily 02:00", () => {
    expect(matchesCron("0 2 * * *", local(2026, 11, 3, 2, 0))).toBe(true);
    expect(matchesCron("0 2 * * *", local(2026, 11, 3, 3, 0))).toBe(false);
    // A Date is read in Brussels: 01:00Z in November is 02:00 local.
    expect(matchesCron("0 2 * * *", at("2026-11-03T01:00:00Z"))).toBe(true);
    expect(matchesCron("0 2 * * *", at("2026-11-03T02:00:00Z"))).toBe(false);
  });

  it("Monday 06:30", () => {
    expect(matchesCron("30 6 * * 1", local(2026, 11, 2, 6, 30))).toBe(true); // Monday
    expect(matchesCron("30 6 * * 1", local(2026, 11, 3, 6, 30))).toBe(false); // Tuesday
    expect(matchesCron("30 6 * * mon", local(2026, 11, 2, 6, 30))).toBe(true);
    expect(matchesCron("0 0 * * 7", local(2026, 11, 1, 0, 0))).toBe(true); // 7 is Sunday
  });

  it("first of the month, ranges and lists; day of month OR day of week when both are set", () => {
    expect(matchesCron("10 7 1 * *", local(2026, 12, 1, 7, 10))).toBe(true);
    expect(matchesCron("0 9-17/4 * * 1-5", local(2026, 11, 3, 13, 0))).toBe(true);
    expect(matchesCron("0 9-17/4 * * 1-5", local(2026, 11, 3, 15, 0))).toBe(false);
    expect(matchesCron("0 0 1 * 1", local(2026, 11, 2, 0, 0))).toBe(true);
    expect(matchesCron("0 0 1,15 * *", local(2026, 11, 15, 0, 0))).toBe(true);
  });

  it("rejects invalid expressions", () => {
    expect(() => parseCron("* * * *")).toThrow(CronSyntaxError);
    expect(() => parseCron("60 * * * *")).toThrow(CronSyntaxError);
    expect(() => parseCron("*/0 * * * *")).toThrow(CronSyntaxError);
    expect(() => parseCron("5-1 * * * *")).toThrow(CronSyntaxError);
  });
});

describe("slotsBetween", () => {
  it("every 5 minutes over 20 minutes gives 4 slots with local keys", () => {
    const slots = slotsBetween("*/5 * * * *", at("2026-11-03T13:00:00Z"), at("2026-11-03T13:20:00Z"));
    expect(slots.map((s) => s.key)).toEqual(["2026-11-03T14:05", "2026-11-03T14:10", "2026-11-03T14:15", "2026-11-03T14:20"]);
  });

  it("daily 02:00 over three days", () => {
    const slots = slotsBetween("0 2 * * *", at("2026-11-01T00:00:00Z"), at("2026-11-04T00:00:00Z"));
    expect(slots.map((s) => s.at.toISOString())).toEqual([
      "2026-11-01T01:00:00.000Z",
      "2026-11-02T01:00:00.000Z",
      "2026-11-03T01:00:00.000Z",
    ]);
  });

  it("spring DST 2027-03-28: 02:30 does not exist and fires at 03:00 local", () => {
    const slots = slotsBetween("30 2 * * *", at("2027-03-27T23:00:00Z"), at("2027-03-28T05:00:00Z"));
    expect(slots).toHaveLength(1);
    expect(slots[0]!.key).toBe("2027-03-28T02:30");
    expect(slots[0]!.at.toISOString()).toBe("2027-03-28T01:00:00.000Z");
    expect(wallClock(slots[0]!.at)).toMatchObject({ hour: 3, minute: 0 });
  });

  it("autumn DST 2026-10-25: 02:30 happens twice but yields one slot", () => {
    const slots = slotsBetween("30 2 * * *", at("2026-10-24T22:00:00Z"), at("2026-10-25T05:00:00Z"));
    expect(slots).toHaveLength(1);
    expect(slots[0]).toEqual({ key: "2026-10-25T02:30", at: at("2026-10-25T00:30:00.000Z") });
    // A window covering only the second 02:30 (01:30Z) yields nothing: the key was used already.
    expect(slotsBetween("30 2 * * *", at("2026-10-25T01:00:00Z"), at("2026-10-25T02:00:00Z"))).toEqual([]);
  });

  it("an hourly cron across the autumn change keeps one slot per local minute", () => {
    const slots = slotsBetween("0 * * * *", at("2026-10-24T23:30:00Z"), at("2026-10-25T02:30:00Z"));
    expect(slots.map((s) => s.key)).toEqual(["2026-10-25T02:00", "2026-10-25T03:00"]);
  });

  it("zonedTimeToUtc maps local times both sides of DST", () => {
    expect(zonedTimeToUtc(local(2026, 7, 1, 9, 0)).toISOString()).toBe("2026-07-01T07:00:00.000Z");
    expect(zonedTimeToUtc(local(2026, 12, 1, 9, 0)).toISOString()).toBe("2026-12-01T08:00:00.000Z");
    expect(zonedTimeToUtc(local(2027, 3, 28, 2, 15)).toISOString()).toBe("2027-03-28T01:00:00.000Z");
  });
});

describe("dueSlots (PL-33)", () => {
  it("an hourly or longer schedule catches up at most 60 minutes", () => {
    expect(isHourlyOrLonger("0 2 * * *")).toBe(true);
    const now = at("2026-11-03T01:20:30Z");
    expect(dueSlots("0 2 * * *", at("2026-11-03T00:50:00Z"), now).map((s) => s.key)).toEqual(["2026-11-03T02:00"]);
    expect(dueSlots("0 2 * * *", at("2026-11-02T20:00:00Z"), at("2026-11-03T02:20:00Z"))).toEqual([]);
  });

  it("minute-level and 15-minute schedules only enqueue the current slot", () => {
    expect(isHourlyOrLonger("*/15 * * * *")).toBe(false);
    const slots = dueSlots("*/15 * * * *", at("2026-11-03T12:00:00Z"), at("2026-11-03T13:00:10Z"));
    expect(slots.map((s) => s.key)).toEqual(["2026-11-03T14:00"]);
    expect(dueSlots("* * * * *", null, at("2026-11-03T13:07:59Z")).map((s) => s.key)).toEqual(["2026-11-03T14:07"]);
  });

  it("localHourKey is the Brussels hour bucket", () => {
    expect(localHourKey(at("2026-11-03T23:30:00Z"))).toBe("2026-11-04T00");
  });
});
