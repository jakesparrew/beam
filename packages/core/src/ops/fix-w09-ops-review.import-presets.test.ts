import { describe, expect, it } from "vitest";
import { IMPORT_PRESETS, presetTargetsValid } from "./import-presets";
import { IMPORT_TARGETS, missingTargets } from "./import-targets";

describe("webinar attendance targets (request ops-P4 -> ops)", () => {
  it("history has the targets mode and watched_minutes; neither is required", () => {
    expect(IMPORT_TARGETS.history).toEqual(expect.arrayContaining(["mode", "watched_minutes"]));
    expect(missingTargets("history", ["email", "history_kind", "occurred_at", "external_id"])).toEqual([]);
  });

  it("the attendee presets map the watched-minutes column of each tool; the registrant presets do not", () => {
    expect(IMPORT_PRESETS.webinargeek_attendees.columns).toMatchObject({ "Watched minutes": "watched_minutes" });
    expect(IMPORT_PRESETS.zoom_attendees.columns).toMatchObject({ "Time in Session (minutes)": "watched_minutes" });
    for (const key of ["webinargeek_registrants", "zoom_registrants"] as const) {
      expect(Object.values(IMPORT_PRESETS[key].columns), key).not.toContain("watched_minutes");
    }
    for (const key of ["webinargeek_attendees", "zoom_attendees"] as const) expect(presetTargetsValid(IMPORT_PRESETS[key]), key).toBe(true);
  });
});
