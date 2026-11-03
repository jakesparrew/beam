import { describe, expect, it } from "vitest";
import { crossedThresholds, DEFAULT_THRESHOLD_PCTS, firesThresholds, thresholdBase, thresholdDedupeKey } from "./thresholds";

const pcts = [...DEFAULT_THRESHOLD_PCTS];

describe("crossedThresholds", () => {
  it("fires a single crossing", () => {
    expect(crossedThresholds({ base: 10, usedBefore: 4, usedAfter: 5, remainingAfter: 5, pcts })).toEqual([50]);
  });

  it("fires nothing between thresholds", () => {
    expect(crossedThresholds({ base: 10, usedBefore: 5, usedAfter: 6, remainingAfter: 4, pcts })).toEqual([]);
  });

  it("fires several thresholds at once, each once (edge case 15: a 2-unit night)", () => {
    expect(crossedThresholds({ base: 4, usedBefore: 1, usedAfter: 3, remainingAfter: 1, pcts })).toEqual([50, 75, "last_unit"]);
    expect(crossedThresholds({ base: 10, usedBefore: 7, usedAfter: 9, remainingAfter: 1, pcts })).toEqual([75, 80, 90, "last_unit"]);
  });

  it("fires last_unit when exactly one unit is left", () => {
    expect(crossedThresholds({ base: 20, usedBefore: 18, usedAfter: 19, remainingAfter: 1, pcts })).toEqual(["last_unit"]);
  });

  it("fires exhausted at zero", () => {
    expect(crossedThresholds({ base: 10, usedBefore: 9, usedAfter: 10, remainingAfter: 0, pcts })).toEqual(["exhausted"]);
    expect(crossedThresholds({ base: 1, usedBefore: 0, usedAfter: 1, remainingAfter: 0, pcts })).toEqual([50, 75, 80, 90, "exhausted"]);
  });

  it("uses floor of used x 100 / base", () => {
    // 2 of 3 used = 66.6 %: 50 crossed, 75 not
    expect(crossedThresholds({ base: 3, usedBefore: 1, usedAfter: 2, remainingAfter: 1, pcts })).toEqual([50, "last_unit"]);
    // 1 of 3 = 33 %
    expect(crossedThresholds({ base: 3, usedBefore: 0, usedAfter: 1, remainingAfter: 2, pcts })).toEqual([]);
  });

  it("uses the original_units base of an imported grant", () => {
    const { base, usedOffset } = thresholdBase({ unitsGranted: 4, originalUnits: 10 });
    expect({ base, usedOffset }).toEqual({ base: 10, usedOffset: 6 });
    // first consume on the import: 7 of 10 used -> nothing new beyond 50 (already passed before import)
    expect(crossedThresholds({ base, usedBefore: usedOffset, usedAfter: usedOffset + 1, remainingAfter: 3, pcts })).toEqual([]);
    expect(crossedThresholds({ base, usedBefore: usedOffset + 1, usedAfter: usedOffset + 2, remainingAfter: 2, pcts })).toEqual([75, 80]);
    expect(thresholdBase({ unitsGranted: 10 })).toEqual({ base: 10, usedOffset: 0 });
    expect(thresholdBase({ unitsGranted: 10, originalUnits: null })).toEqual({ base: 10, usedOffset: 0 });
    expect(thresholdBase({ unitsGranted: 10, originalUnits: 8 })).toEqual({ base: 10, usedOffset: 0 });
  });

  it("does not fire on a release or when used does not grow", () => {
    expect(crossedThresholds({ base: 10, usedBefore: 5, usedAfter: 4, remainingAfter: 6, pcts })).toEqual([]);
    expect(crossedThresholds({ base: 10, usedBefore: 9, usedAfter: 9, remainingAfter: 1, pcts })).toEqual([]);
  });

  it("follows custom threshold_pcts, sorted and without duplicates or invalid values", () => {
    expect(crossedThresholds({ base: 10, usedBefore: 0, usedAfter: 4, remainingAfter: 6, pcts: [40, 25, 25, 0, 101, 33.5] })).toEqual([25, 40]);
    expect(crossedThresholds({ base: 10, usedBefore: 0, usedAfter: 4, remainingAfter: 6, pcts: [] })).toEqual([]);
  });

  it("handles a zero base without dividing by zero", () => {
    expect(crossedThresholds({ base: 0, usedBefore: 0, usedAfter: 1, remainingAfter: 0, pcts })).toEqual(["exhausted"]);
  });
});

describe("threshold helpers", () => {
  it("fires only for purchase, import and transfer grants", () => {
    expect(["purchase", "import", "transfer"].every(firesThresholds)).toBe(true);
    expect(["membership", "bonus", "referral", "manual", "voucher"].some(firesThresholds)).toBe(false);
  });

  it("builds the dedupe keys of rules 21 and 22", () => {
    expect(thresholdDedupeKey("g1", 75)).toBe("grant:g1:threshold:75");
    expect(thresholdDedupeKey("g1", "last_unit")).toBe("grant:g1:threshold:last_unit");
    expect(thresholdDedupeKey("g1", "exhausted")).toBe("grant:g1:exhausted");
  });
});
