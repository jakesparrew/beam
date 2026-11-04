import { describe, expect, it } from "vitest";
import { canReEnter } from "./re-entry";

const NOW = new Date("2026-11-04T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
const none = { lastEnteredAt: null, hasActive: false, everEntered: false };

describe("canReEnter (A-13)", () => {
  it("A-13 after_days:30 is judged per person across subjects: a second booking's review request is blocked", () => {
    // review-request entered for booking:1 ten days ago (completed), now booking:2 is attended.
    const h = { lastEnteredAt: daysAgo(10), hasActive: false, everEntered: true };
    expect(canReEnter("after_days:30", h, NOW)).toBe(false);
    expect(canReEnter("after_days:30", { ...h, lastEnteredAt: daysAgo(30) }, NOW)).toBe(true);
    expect(canReEnter("after_days:30", { ...h, lastEnteredAt: daysAgo(45) }, NOW)).toBe(true);
    expect(canReEnter("after_days:30", none, NOW)).toBe(true);
  });

  it("A-13 never refuses once the person was ever enrolled", () => {
    expect(canReEnter("never", none, NOW)).toBe(true);
    expect(canReEnter("never", { lastEnteredAt: daysAgo(900), hasActive: false, everEntered: true }, NOW)).toBe(false);
  });

  it("A-13 after_days:0 and always allow", () => {
    const h = { lastEnteredAt: daysAgo(0), hasActive: false, everEntered: true };
    expect(canReEnter("after_days:0", h, NOW)).toBe(true);
    expect(canReEnter("always", h, NOW)).toBe(true);
  });

  it("A-13 an active enrolment for the same subject always refuses", () => {
    const h = { lastEnteredAt: daysAgo(100), hasActive: true, everEntered: true };
    for (const p of ["always", "never", "after_days:0", "after_days:30"] as const) expect(canReEnter(p, h, NOW)).toBe(false);
  });

  it("throws on an unknown policy", () => {
    expect(() => canReEnter("sometimes" as never, none, NOW)).toThrow(/unknown policy/);
  });
});
