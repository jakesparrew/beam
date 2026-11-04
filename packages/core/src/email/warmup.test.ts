import { describe, expect, it } from "vitest";
import { DEFAULT_WARMUP_SCHEDULE, isWarmingUp, warmupCap, warmupContinuation, warmupRemaining, warmupWeek, WarmupScheduleSchema, type WarmupSchedule } from "./warmup";

const schedule: WarmupSchedule = { domain: "news.beam.be", start_on: "2026-11-02", daily_caps: [1000, 2000, 4000, 8000] };
/** Noon Brussels on a date (CET, UTC+1, in November and December). */
const noon = (date: string) => new Date(`${date}T11:00:00Z`);

describe("warm-up caps (rules 6 and 7)", () => {
  it.each([
    ["2026-11-02", 0, 1000],
    ["2026-11-08", 0, 1000],
    ["2026-11-09", 1, 2000],
    ["2026-11-16", 2, 4000],
    ["2026-11-29", 3, 8000],
  ])("%s is week %i with cap %i", (date, week, cap) => {
    expect(warmupWeek(schedule, noon(date))).toBe(week);
    expect(warmupCap(schedule, noon(date))).toBe(cap);
    expect(isWarmingUp(schedule, noon(date))).toBe(true);
  });

  it("has no cap from week 4 on", () => {
    expect(warmupCap(schedule, noon("2026-11-30"))).toBeNull();
    expect(warmupCap(schedule, noon("2027-06-01"))).toBeNull();
    expect(isWarmingUp(schedule, noon("2026-11-30"))).toBe(false);
    expect(warmupRemaining(schedule, noon("2026-11-30"), 50_000)).toBeNull();
  });

  it("counts Brussels calendar days, not UTC days", () => {
    // 2026-11-08 23:30 UTC is 2026-11-09 00:30 in Brussels: week 1.
    expect(warmupCap(schedule, new Date("2026-11-08T23:30:00Z"))).toBe(2000);
    // 2026-11-08 22:59 UTC is 23:59 in Brussels: still week 0.
    expect(warmupCap(schedule, new Date("2026-11-08T22:59:00Z"))).toBe(1000);
    // Summer time (UTC+2): 2027-03-28 22:30 UTC is 2027-03-29 00:30 Brussels.
    const summer: WarmupSchedule = { ...schedule, start_on: "2027-03-22" };
    expect(warmupCap(summer, new Date("2027-03-28T21:30:00Z"))).toBe(1000);
    expect(warmupCap(summer, new Date("2027-03-28T22:30:00Z"))).toBe(2000);
  });

  it("uses the first week's cap before start_on and without a go-live date", () => {
    expect(warmupCap(schedule, noon("2026-10-20"))).toBe(1000);
    expect(warmupCap(DEFAULT_WARMUP_SCHEDULE, noon("2026-10-20"))).toBe(1000);
    expect(warmupCap({ ...schedule, daily_caps: [] }, noon("2026-11-02"))).toBeNull();
  });

  it("computes what is left today", () => {
    expect(warmupRemaining(schedule, noon("2026-11-02"), 400)).toBe(600);
    expect(warmupRemaining(schedule, noon("2026-11-02"), 1500)).toBe(0);
  });

  it("continues at 09:00 Brussels the next day with a :d<YYYY-MM-DD> key qualifier", () => {
    expect(warmupContinuation(new Date("2026-11-02T21:00:00Z"))).toEqual({
      runAt: new Date("2026-11-03T08:00:00Z"),
      day: "2026-11-03",
      keyQualifier: ":d2026-11-03",
    });
    // 23:30 UTC on 28 March 2027 is already the 29th in Brussels (summer time): continue on the 30th at 07:00 UTC.
    expect(warmupContinuation(new Date("2027-03-28T23:30:00Z")).runAt).toEqual(new Date("2027-03-30T07:00:00Z"));
  });

  it("validates the setting shape", () => {
    expect(WarmupScheduleSchema.safeParse(schedule).success).toBe(true);
    expect(WarmupScheduleSchema.safeParse({ ...schedule, domain: "mail.beam.be" }).success).toBe(false);
    expect(WarmupScheduleSchema.safeParse({ ...schedule, start_on: "2 Nov" }).success).toBe(false);
  });
});
