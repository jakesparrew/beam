import { describe, expect, it } from "vitest";
import { CROCKFORD_ALPHABET, isCheckinCode, newCheckinCode, normaliseCheckinCode } from "./checkin-code";
import { BOOKING_CONFLICT_REASONS, BookingConflictError, SessionFullError, TermsRequiredError, isBookingConflict } from "./errors";
import { BookingRules, BusinessHours, DEFAULT_BOOKING_RULES, DEFAULT_BUSINESS_HOURS } from "./rules";

describe("newCheckinCode", () => {
  it("is 10 Crockford base32 characters", () => {
    for (let i = 0; i < 50; i++) expect(isCheckinCode(newCheckinCode())).toBe(true);
    expect(CROCKFORD_ALPHABET).toHaveLength(32);
    expect(CROCKFORD_ALPHABET).not.toMatch(/[ILOU]/);
  });
  it("uses the injected randomness", () => {
    expect(newCheckinCode((n) => new Uint8Array(n).fill(31))).toBe("ZZZZZZZZZZ");
    expect(newCheckinCode((n) => new Uint8Array(n))).toBe("0000000000");
  });
  it("normalises typed codes", () => {
    expect(normaliseCheckinCode(" abcd-efgh-jo ")).toBe("ABCDEFGHJ0");
    expect(normaliseCheckinCode("il")).toBe("11");
  });
});

describe("errors", () => {
  it("carry code conflict and their reason", () => {
    const e = new SessionFullError({ sessionId: "s1" });
    expect(e).toBeInstanceOf(BookingConflictError);
    expect(e.code).toBe("conflict");
    expect(e.reason).toBe("session_full");
    expect(e.message).toBe("session_full");
    expect(e.data).toEqual({ sessionId: "s1" });
    expect(isBookingConflict(new TermsRequiredError(), "terms_required")).toBe(true);
    expect(isBookingConflict(new Error("x"))).toBe(false);
    expect(BOOKING_CONFLICT_REASONS).toContain("shared_bed_limit");
  });
});

describe("settings schemas", () => {
  it("parse({}) yields the defaults and the defaults validate", () => {
    expect(BookingRules.parse({})).toEqual(DEFAULT_BOOKING_RULES);
    expect(BookingRules.parse(DEFAULT_BOOKING_RULES)).toEqual(DEFAULT_BOOKING_RULES);
    expect(BusinessHours.parse(DEFAULT_BUSINESS_HOURS)).toEqual(DEFAULT_BUSINESS_HOURS);
  });
  it("refuses out-of-range values", () => {
    expect(BookingRules.safeParse({ booking_horizon_days: 91 }).success).toBe(false);
    expect(BookingRules.safeParse({ max_shared_bed_guests_per_booking: 2 }).success).toBe(false);
    expect(BusinessHours.safeParse({ ...DEFAULT_BUSINESS_HOURS, week: { ...DEFAULT_BUSINESS_HOURS.week, 2: { opens_at: "8:30", closes_at: "19:00" } } }).success).toBe(false);
  });
});
