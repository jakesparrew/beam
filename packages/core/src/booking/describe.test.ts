import { describe, expect, it } from "vitest";
import { LOCALES } from "../i18n/locales";
import { t } from "../i18n/t";
import { BELGIAN_HOLIDAY_KEYS } from "../platform/holidays";
import { describeAvailability } from "./describe";
import { BOOKING_CONFLICT_REASONS } from "./errors";
import { BOOKING_STATUSES, CANCEL_REASON_CODES, EVENT_CATEGORIES, WAITLIST_STATES, type Availability } from "./types";

const base: Availability = { bookable: 3, reason: "ok", opensAt: null, useLeadSeat: false, canJoinWaitlist: false, queue: "public", phase: "none" };
const REASONS: Availability["reason"][] = ["ok", "full", "member_only", "not_open_yet", "closed", "cancelled", "past", "webinar"];

describe("booking catalogue (section 8)", () => {
  it("names each of platform's ten holiday keys in three locales (R4b)", () => {
    expect(BELGIAN_HOLIDAY_KEYS).toHaveLength(10);
    for (const locale of LOCALES) for (const key of BELGIAN_HOLIDAY_KEYS) expect(t.has(locale, `booking.holidays.${key}`), `${locale} ${key}`).toBe(true);
  });

  it("has a message for every conflict reason, event category, status and waitlist state", () => {
    for (const locale of LOCALES) {
      for (const r of BOOKING_CONFLICT_REASONS) expect(t.has(locale, `booking.errors.${r}`), `${locale} errors.${r}`).toBe(true);
      for (const c of EVENT_CATEGORIES) expect(t.has(locale, `booking.eventCategory.${c}`)).toBe(true);
      for (const s of BOOKING_STATUSES) expect(t.has(locale, `booking.status.${s}`)).toBe(true);
      for (const s of WAITLIST_STATES) expect(t.has(locale, `booking.waitlistState.${s}`)).toBe(true);
      for (const c of CANCEL_REASON_CODES) expect(t.has(locale, `booking.cancelReason.${c}`)).toBe(true);
    }
  });

  it("renders every availability label in every locale", () => {
    for (const locale of LOCALES) {
      for (const reason of REASONS) {
        for (const opensAt of [null, new Date("2026-11-20T17:00:00Z")]) {
          const { labelKey, params } = describeAvailability({ ...base, reason, opensAt, bookable: reason === "ok" ? 3 : 0 }, locale);
          expect(t(locale, labelKey, params)).not.toMatch(/[{}⟦]/);
        }
      }
      expect(t(locale, "booking.availability.placesLeft", { count: 1 })).toMatch(/1/);
    }
    expect(t("en", "booking.availability.placesLeft", { count: 3 })).toBe("3 places left");
    expect(t("nl-BE", "booking.availability.openForYouOn", describeAvailability({ ...base, reason: "not_open_yet", opensAt: new Date("2026-11-20T17:00:00Z") }, "nl-BE").params)).toContain("18:00");
  });
});
