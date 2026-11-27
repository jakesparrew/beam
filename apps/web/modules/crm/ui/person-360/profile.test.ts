/** The 360's twelve-month visit strip buckets visits by Brussels month, oldest first. */
import { describe, expect, it } from "vitest";
import { visitsByMonth } from "./profile";

describe("visitsByMonth", () => {
  it("counts per Brussels month for the twelve months up to now, and drops older visits", () => {
    const now = new Date("2026-11-27T10:00:00Z");
    const months = visitsByMonth(
      [
        new Date("2026-11-03T10:00:00Z"),
        new Date("2026-10-31T23:30:00Z"), // 1 November 00:30 in Brussels
        new Date("2026-01-10T10:00:00Z"),
        new Date("2025-11-30T10:00:00Z"), // outside the twelve months
      ],
      now,
      "nl-BE",
    );
    expect(months.map((m) => m.key)).toEqual(["2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11"]);
    expect(months.find((m) => m.key === "2026-11")!.count).toBe(2);
    expect(months.find((m) => m.key === "2026-10")!.count).toBe(0);
    expect(months.find((m) => m.key === "2026-01")!.count).toBe(1);
    expect(months.reduce((s, m) => s + m.count, 0)).toBe(3);
  });
});
