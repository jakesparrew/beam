import { describe, expect, it } from "vitest";
import { bandFor, FEW_SEATS_RATIO, FEW_SEATS_THRESHOLD } from "./availability";

describe("bandFor (rule 30)", () => {
  it("pins the shared thresholds", () => {
    expect(FEW_SEATS_THRESHOLD).toBe(5);
    expect(FEW_SEATS_RATIO).toBe(0.1);
  });

  it.each([
    [0, 20, "full"],
    [1, 20, "few"],
    [4, 20, "few"],
    [5, 20, "available"],
  ] as const)("%i of %i seats -> %s", (bookable, capacity, band) => {
    expect(bandFor({ bookable, capacity, reason: "ok" })).toBe(band);
  });

  it("below 10 % of capacity is few, at 10 % is available", () => {
    expect(bandFor({ bookable: 9, capacity: 100, reason: "ok" })).toBe("few");
    expect(bandFor({ bookable: 10, capacity: 100, reason: "ok" })).toBe("available");
  });

  it("reason full wins over seats left", () => {
    expect(bandFor({ bookable: 12, capacity: 20, reason: "full" })).toBe("full");
    expect(bandFor({ bookable: -1, capacity: 20, reason: "ok" })).toBe("full");
  });
});
