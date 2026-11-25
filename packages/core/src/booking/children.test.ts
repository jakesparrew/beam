import { describe, expect, it } from "vitest";
import { childrenAllowed } from "./children";
import { zonedTimeToUtc } from "./schedule";

describe("childrenAllowed (owner's review 1.1, 1.2)", () => {
  // 2026-11-28 is a Saturday; 2026-11-27 a Friday. Summer time: 2026-07-04 is a Saturday.
  it("takes children on the Saturday 13:00 day session only", () => {
    expect(childrenAllowed({ kind: "day", startsAt: zonedTimeToUtc("2026-11-28", "13:00") })).toBe(true);
    expect(childrenAllowed({ kind: "day", startsAt: zonedTimeToUtc("2026-07-04", "13:00") })).toBe(true);
    expect(childrenAllowed({ kind: "day", startsAt: zonedTimeToUtc("2026-11-28", "10:00") })).toBe(false);
    expect(childrenAllowed({ kind: "day", startsAt: zonedTimeToUtc("2026-11-28", "16:00") })).toBe(false);
    expect(childrenAllowed({ kind: "day", startsAt: zonedTimeToUtc("2026-11-27", "13:00") })).toBe(false);
  });

  it("takes children on every night session and never on events", () => {
    expect(childrenAllowed({ kind: "night", startsAt: zonedTimeToUtc("2026-11-25", "20:00") })).toBe(true);
    expect(childrenAllowed({ kind: "event", startsAt: zonedTimeToUtc("2026-11-28", "13:00") })).toBe(false);
  });
});
