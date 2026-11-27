import { describe, expect, it } from "vitest";
import { previousMonthSpan, weekStart } from "./daily";

describe("revenue period spans", () => {
  it("compares the month to date with the same days of the previous month, capped at its last day", () => {
    expect(previousMonthSpan("2026-11-27")).toEqual(["2026-10-01", "2026-10-27"]);
    expect(previousMonthSpan("2026-03-31")).toEqual(["2026-02-01", "2026-02-28"]);
    expect(previousMonthSpan("2027-01-15")).toEqual(["2026-12-01", "2026-12-15"]);
  });
  it("starts the week on Monday", () => {
    expect(weekStart("2026-11-27")).toBe("2026-11-23");
    expect(weekStart("2026-11-23")).toBe("2026-11-23");
    expect(weekStart("2026-11-29")).toBe("2026-11-23");
  });
});
