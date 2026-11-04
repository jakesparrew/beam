/**
 * The preference link's 365-day edit window (crm spec 4.4, edge case 26): within the window a
 * token may change every purpose; afterwards only unsubscribing is allowed (the route answers
 * 410 for the rest). The rule is `canEditPreferences` of `@beam/core/crm`.
 */
import { describe, expect, it } from "vitest";
import { canEditPreferences, PREFERENCE_EDIT_WINDOW_DAYS } from "@beam/core/crm";

const DAY = 24 * 60 * 60 * 1000;
const sentAt = new Date("2025-11-03T09:00:00Z");

describe("preference edit window", () => {
  it("is 365 days", () => {
    expect(PREFERENCE_EDIT_WINDOW_DAYS).toBe(365);
  });

  it("allows edits on the day of sending and up to exactly 365 days later", () => {
    expect(canEditPreferences(sentAt, sentAt)).toBe(true);
    expect(canEditPreferences(sentAt, new Date(sentAt.getTime() + 364 * DAY))).toBe(true);
    expect(canEditPreferences(sentAt, new Date(sentAt.getTime() + 365 * DAY))).toBe(true);
  });

  it("refuses edits once 365 days have passed", () => {
    expect(canEditPreferences(sentAt, new Date(sentAt.getTime() + 365 * DAY + 1))).toBe(false);
    expect(canEditPreferences(sentAt, new Date(sentAt.getTime() + 400 * DAY))).toBe(false);
  });

  it("counts elapsed time, not calendar days, across the DST change", () => {
    const beforeDst = new Date("2026-03-28T12:00:00Z");
    expect(canEditPreferences(beforeDst, new Date(beforeDst.getTime() + 365 * DAY))).toBe(true);
    expect(canEditPreferences(beforeDst, new Date(beforeDst.getTime() + 366 * DAY))).toBe(false);
  });
});
