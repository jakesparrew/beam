/** A-32 frequency caps and quiet hours (automation-P7): day and week caps, quiet hours across midnight and DST. */
import { describe, expect, it } from "vitest";
import { applyFrequencyRules, countSendsWithin, frequencyCapReason, isQuietTime, type AutomationRules } from "./frequency";

const RULES: AutomationRules = { max_marketing_per_day: 1, max_marketing_per_week: 3, quiet_start: "21:00", quiet_end: "08:00", webhook_hosts: [] };
const H = 3_600_000;
const D = 24 * H;
const at = (iso: string) => new Date(iso);
const ago = (now: Date, ms: number) => new Date(now.getTime() - ms);

describe("A-32 day and week caps", () => {
  const now = at("2026-11-05T13:00:00Z"); // 14:00 Brussels, outside quiet hours

  it("sends when nothing was sent recently", () => {
    expect(applyFrequencyRules({ now, recentMarketingSends: [], rules: RULES })).toEqual({ action: "send" });
  });

  it("skips a second marketing email within 24 hours (default 1 per day)", () => {
    expect(applyFrequencyRules({ now, recentMarketingSends: [ago(now, 23 * H)], rules: RULES })).toEqual({ action: "skip" });
    expect(frequencyCapReason({ now, recentMarketingSends: [ago(now, 23 * H)], rules: RULES })).toBe("cap_day:1");
  });

  it("a send exactly 24 hours ago is outside the day window", () => {
    expect(applyFrequencyRules({ now, recentMarketingSends: [ago(now, D)], rules: RULES })).toEqual({ action: "send" });
  });

  it("skips a fourth marketing email within 7 days (default 3 per week)", () => {
    const sends = [ago(now, 2 * D), ago(now, 4 * D), ago(now, 6 * D)];
    expect(applyFrequencyRules({ now, recentMarketingSends: sends, rules: RULES })).toEqual({ action: "skip" });
    expect(frequencyCapReason({ now, recentMarketingSends: sends, rules: RULES })).toBe("cap_week:3");
    // One of them older than 7 days: two in the week, none today.
    expect(applyFrequencyRules({ now, recentMarketingSends: [ago(now, 2 * D), ago(now, 4 * D), ago(now, 7 * D + 1)], rules: RULES })).toEqual({ action: "send" });
  });

  it("higher caps allow more; a cap of 0 skips every marketing step", () => {
    const rules = { ...RULES, max_marketing_per_day: 2, max_marketing_per_week: 5 };
    expect(applyFrequencyRules({ now, recentMarketingSends: [ago(now, H)], rules })).toEqual({ action: "send" });
    expect(applyFrequencyRules({ now, recentMarketingSends: [ago(now, H), ago(now, 2 * H)], rules })).toEqual({ action: "skip" });
    expect(applyFrequencyRules({ now, recentMarketingSends: [], rules: { ...RULES, max_marketing_per_day: 0 } })).toEqual({ action: "skip" });
    expect(applyFrequencyRules({ now, recentMarketingSends: [], rules: { ...RULES, max_marketing_per_week: 0 } })).toEqual({ action: "skip" });
  });

  it("sends later than now are not counted", () => {
    expect(countSendsWithin([new Date(now.getTime() + H)], now, D)).toBe(0);
    expect(applyFrequencyRules({ now, recentMarketingSends: [new Date(now.getTime() + H)], rules: RULES })).toEqual({ action: "send" });
  });
});

describe("A-32 quiet hours (Europe/Brussels)", () => {
  it("the window 21:00-08:00 crosses midnight", () => {
    expect(isQuietTime(at("2026-11-05T19:59:00Z"), RULES)).toBe(false); // 20:59 CET
    expect(isQuietTime(at("2026-11-05T20:00:00Z"), RULES)).toBe(true); // 21:00
    expect(isQuietTime(at("2026-11-05T23:30:00Z"), RULES)).toBe(true); // 00:30
    expect(isQuietTime(at("2026-11-06T06:59:00Z"), RULES)).toBe(true); // 07:59
    expect(isQuietTime(at("2026-11-06T07:00:00Z"), RULES)).toBe(false); // 08:00
  });

  it("an evening step is deferred to 08:00 the next morning; an early one to 08:00 the same morning", () => {
    expect(applyFrequencyRules({ now: at("2026-11-05T20:30:00Z"), recentMarketingSends: [], rules: RULES })).toEqual({ action: "defer", until: at("2026-11-06T07:00:00Z") });
    expect(applyFrequencyRules({ now: at("2026-11-06T05:00:00Z"), recentMarketingSends: [], rules: RULES })).toEqual({ action: "defer", until: at("2026-11-06T07:00:00Z") });
  });

  it("quiet hours defer even when a cap would skip (the cap is judged when the step runs again)", () => {
    const now = at("2026-11-05T21:00:00Z");
    expect(applyFrequencyRules({ now, recentMarketingSends: [ago(now, H)], rules: RULES })).toMatchObject({ action: "defer" });
  });

  it("DST end: 23:30 CEST on 24 October defers to 08:00 CET on 25 October (07:00Z)", () => {
    expect(applyFrequencyRules({ now: at("2026-10-24T21:30:00Z"), recentMarketingSends: [], rules: RULES })).toEqual({ action: "defer", until: at("2026-10-25T07:00:00Z") });
  });

  it("DST start: 23:00 CET on 28 March defers to 08:00 CEST on 29 March (06:00Z)", () => {
    expect(applyFrequencyRules({ now: at("2026-03-28T22:00:00Z"), recentMarketingSends: [], rules: RULES })).toEqual({ action: "defer", until: at("2026-03-29T06:00:00Z") });
    // In summer 21:00 Brussels is 19:00Z.
    expect(isQuietTime(at("2026-06-10T18:59:00Z"), RULES)).toBe(false);
    expect(isQuietTime(at("2026-06-10T19:00:00Z"), RULES)).toBe(true);
  });

  it("a window inside one day and an empty window", () => {
    const day = { ...RULES, quiet_start: "12:00", quiet_end: "14:00" };
    expect(applyFrequencyRules({ now: at("2026-11-05T11:30:00Z"), recentMarketingSends: [], rules: day })).toEqual({ action: "defer", until: at("2026-11-05T13:00:00Z") });
    expect(applyFrequencyRules({ now: at("2026-11-05T13:00:00Z"), recentMarketingSends: [], rules: day })).toEqual({ action: "send" });
    const none = { ...RULES, quiet_start: "08:00", quiet_end: "08:00" };
    expect(applyFrequencyRules({ now: at("2026-11-05T23:00:00Z"), recentMarketingSends: [], rules: none })).toEqual({ action: "send" });
  });
});
