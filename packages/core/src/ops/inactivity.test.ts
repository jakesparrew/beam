import { describe, expect, it } from "vitest";
import { brusselsDate, highestThresholdInWindow, inactivityDedupeKey, inactivityEventsFor } from "./inactivity";

/** 10:00 Brussels (summer or winter offset does not matter for the date). */
const at = (isoDate: string) => new Date(`${isoDate}T08:00:00Z`);

describe("inactivityEventsFor (rules 15-17)", () => {
  const anchor = at("2026-01-01");

  it("R16 emits a threshold on its day and for the two days after (3-day window)", () => {
    expect(inactivityEventsFor({ anchorAt: anchor, today: "2026-01-31" })).toEqual({ days: 30 });
    expect(inactivityEventsFor({ anchorAt: anchor, today: "2026-02-01" })).toEqual({ days: 30 });
    expect(inactivityEventsFor({ anchorAt: anchor, today: "2026-02-02" })).toEqual({ days: 30 });
    expect(inactivityEventsFor({ anchorAt: anchor, today: "2026-02-03" })).toBeNull();
    expect(inactivityEventsFor({ anchorAt: anchor, today: "2026-01-30" })).toBeNull();
  });

  it("R16 covers 60, 90 and 180 days", () => {
    expect(inactivityEventsFor({ anchorAt: anchor, today: "2026-03-02" })).toEqual({ days: 60 });
    expect(inactivityEventsFor({ anchorAt: anchor, today: "2026-04-01" })).toEqual({ days: 90 });
    expect(inactivityEventsFor({ anchorAt: anchor, today: "2026-06-30" })).toEqual({ days: 180 });
    expect(inactivityEventsFor({ anchorAt: anchor, today: "2026-12-31" })).toBeNull();
  });

  it("R16 after the cut-over an old anchor never bursts old thresholds", () => {
    expect(inactivityEventsFor({ anchorAt: at("2024-05-10"), today: "2026-11-04" })).toBeNull();
  });

  it("R17 only the highest threshold when two fall inside the window", () => {
    expect(highestThresholdInWindow("2026-01-01", "2026-02-02", [30, 31, 32])).toBe(32);
    expect(highestThresholdInWindow("2026-01-01", "2026-02-02", [32, 31, 30])).toBe(32);
    expect(highestThresholdInWindow("2026-01-01", "2026-02-02", [30, 60])).toBe(30);
  });

  it("R17 does not emit again a threshold at or below the last one emitted", () => {
    expect(inactivityEventsFor({ anchorAt: anchor, today: "2026-02-01", lastEmitted: 30 })).toBeNull();
    expect(inactivityEventsFor({ anchorAt: anchor, today: "2026-03-02", lastEmitted: 30 })).toEqual({ days: 60 });
    expect(inactivityEventsFor({ anchorAt: anchor, today: "2026-03-02", lastEmitted: 90 })).toBeNull();
  });

  it("R16 a new visit moves the anchor and re-arms every threshold", () => {
    const newAnchor = at("2026-01-20");
    expect(inactivityEventsFor({ anchorAt: anchor, today: "2026-01-31" })).toEqual({ days: 30 });
    expect(inactivityEventsFor({ anchorAt: newAnchor, today: "2026-01-31" })).toBeNull();
    expect(inactivityEventsFor({ anchorAt: newAnchor, today: "2026-02-19" })).toEqual({ days: 30 });
    expect(inactivityDedupeKey("p1", 30, anchor)).not.toBe(inactivityDedupeKey("p1", 30, newAnchor));
  });

  it("R15 no event for leads (no visit and no purchase)", () => {
    expect(inactivityEventsFor({ anchorAt: null, today: "2026-01-31" })).toBeNull();
  });

  it("uses the Brussels date of the anchor", () => {
    // 23:30 UTC on 31 December is already 1 January in Brussels.
    expect(brusselsDate(new Date("2025-12-31T23:30:00Z"))).toBe("2026-01-01");
    expect(inactivityEventsFor({ anchorAt: new Date("2025-12-31T23:30:00Z"), today: "2026-01-31" })).toEqual({ days: 30 });
  });

  it("R16 dedupe key", () => {
    expect(inactivityDedupeKey("p1", 60, anchor)).toBe("person:p1:inactive:60:2026-01-01");
  });

  it("rejects a malformed date", () => {
    expect(() => inactivityEventsFor({ anchorAt: anchor, today: "31/01/2026" })).toThrow(RangeError);
  });
});
