import { describe, expect, it } from "vitest";
import { availabilityBand, computeAvailability } from "./availability";
import { describeAvailability } from "./describe";
import { DEFAULT_BOOKING_RULES } from "./rules";
import type { AvailabilityRow, AvailabilityViewer, LeadPhase } from "./types";

const NOW = new Date("2026-11-03T10:00:00Z");
const H = 3_600_000;
const inHours = (h: number) => new Date(NOW.getTime() + h * H);

/** A row as `v_session_availability` returns it, with the pools derived like the view does. */
function row(p: Partial<AvailabilityRow> & { leadReservedSeats?: number } = {}): AvailabilityRow {
  const capacity = p.capacity ?? 10;
  const held = p.held ?? 0;
  const booked = p.booked ?? 0;
  const liveOffers = p.liveOffers ?? 0;
  const availableTotal = p.availableTotal ?? Math.max(0, capacity - held - booked - liveOffers);
  const leadReservedRemaining = p.leadReservedRemaining ?? 0;
  return {
    sessionId: "s1",
    kind: "day",
    startsAt: inHours(48),
    endsAt: inHours(50),
    status: "open",
    isLeadMagnet: false,
    publishedAt: inHours(-24),
    held,
    booked,
    leadBooked: 0,
    liveOffers,
    liveLeadOffers: 0,
    leadPhase: "none",
    opensForCustomersAt: null,
    opensForPublicAt: null,
    waiting: 0,
    isMemberOnly: false,
    webinarId: null,
    ...p,
    capacity,
    availableTotal,
    leadReservedRemaining,
    availableGeneral: p.availableGeneral ?? Math.max(0, availableTotal - leadReservedRemaining),
  };
}

const lead: AvailabilityViewer = { status: "lead", isMember: false };
const customer: AvailabilityViewer = { status: "customer", isMember: false };
const member: AvailabilityViewer = { status: "member", isMember: true };
const anonymous: AvailabilityViewer = { status: "anonymous", isMember: false };

describe("computeAvailability: capacity (R9)", () => {
  it("counts holds, bookings and live offers through the view's pools", () => {
    const a = computeAvailability(row({ capacity: 10, held: 2, booked: 5, liveOffers: 1 }), customer, NOW);
    expect(a).toMatchObject({ bookable: 2, reason: "ok", canJoinWaitlist: false, queue: "public", phase: "none", useLeadSeat: false });
  });

  it("is full when holds and bookings use every seat, and offers the waitlist", () => {
    const a = computeAvailability(row({ capacity: 4, held: 2, booked: 2 }), customer, NOW);
    expect(a).toMatchObject({ bookable: 0, reason: "full", canJoinWaitlist: true, queue: "public" });
  });

  it("treats an expired reservation as free (the view no longer counts it)", () => {
    // The view counts `reserved` rows only while `reserved_until > now()`: one live, one lapsed.
    expect(computeAvailability(row({ capacity: 2, booked: 1 }), customer, NOW).bookable).toBe(1);
  });

  it("counts a live offer against capacity", () => {
    expect(computeAvailability(row({ capacity: 1, liveOffers: 1 }), customer, NOW).reason).toBe("full");
  });
});

describe("computeAvailability: blocking reasons", () => {
  it("member-only needs a real membership (R15)", () => {
    const r = row({ isMemberOnly: true });
    expect(computeAvailability(r, customer, NOW)).toMatchObject({ reason: "member_only", bookable: 0, canJoinWaitlist: false, queue: null });
    expect(computeAvailability(r, { status: "member", isMember: false }, NOW).reason).toBe("member_only");
    expect(computeAvailability(r, member, NOW).reason).toBe("ok");
  });

  it("closed sessions are visible but not bookable", () => {
    expect(computeAvailability(row({ status: "closed" }), customer, NOW)).toMatchObject({ reason: "closed", canJoinWaitlist: false });
  });

  it("cancelled, past and webinar sessions are never bookable (R64)", () => {
    expect(computeAvailability(row({ status: "cancelled" }), customer, NOW).reason).toBe("cancelled");
    expect(computeAvailability(row({ startsAt: inHours(-1), endsAt: inHours(1) }), customer, NOW).reason).toBe("past");
    expect(computeAvailability(row({ webinarId: "w1" }), customer, NOW).reason).toBe("webinar");
  });

  it("unpublished sessions and sessions beyond the booking horizon are not open yet (R7)", () => {
    expect(computeAvailability(row({ publishedAt: null }), customer, NOW)).toMatchObject({ reason: "not_open_yet", opensAt: null });
    const far = row({ startsAt: inHours(24 * 61), endsAt: inHours(24 * 61 + 2) });
    const a = computeAvailability(far, customer, NOW);
    expect(a.reason).toBe("not_open_yet");
    expect(a.opensAt).toEqual(inHours(24 * 1));
    expect(computeAvailability(row({ startsAt: inHours(24 * 60), endsAt: inHours(24 * 60 + 2) }), customer, NOW).reason).toBe("ok");
  });

  it("closes at the per-kind booking cut-off (R7)", () => {
    const night = row({ kind: "night", startsAt: inHours(2), endsAt: inHours(14) });
    expect(computeAvailability(night, customer, NOW).reason).toBe("closed");
    expect(computeAvailability({ ...night, startsAt: new Date(NOW.getTime() + 2 * H + 1000) }, customer, NOW).reason).toBe("ok");
    const rules = { ...DEFAULT_BOOKING_RULES, book_until_minutes_before_start: { day: 30, night: 120, event: 0 } };
    expect(computeAvailability(row({ startsAt: new Date(NOW.getTime() + 20 * 60_000) }), customer, NOW, rules).reason).toBe("closed");
  });
});

describe("computeAvailability: Lead Magnet phases (R20-R25)", () => {
  const lm = (phase: LeadPhase, p: Partial<AvailabilityRow> = {}) =>
    row({
      kind: "event",
      isLeadMagnet: true,
      leadPhase: phase,
      capacity: 10,
      leadReservedRemaining: phase === "lead" || phase === "pre" ? 4 : 0,
      opensForCustomersAt: inHours(24),
      opensForPublicAt: inHours(26),
      ...p,
    });

  it("pre: only general seats, for everyone", () => {
    const r = lm("pre");
    expect(computeAvailability(r, lead, NOW)).toMatchObject({ bookable: 6, useLeadSeat: false, queue: "lead", phase: "pre" });
    expect(computeAvailability(r, customer, NOW)).toMatchObject({ bookable: 6, queue: "customer" });
    expect(computeAvailability(r, member, NOW)).toMatchObject({ bookable: 6, queue: "customer" });
  });

  it("lead: leads use reserved seats first; customers only general seats", () => {
    const r = lm("lead");
    expect(computeAvailability(r, lead, NOW)).toMatchObject({ bookable: 10, useLeadSeat: true, reason: "ok", queue: "lead" });
    expect(computeAvailability(r, customer, NOW)).toMatchObject({ bookable: 6, useLeadSeat: false, queue: "customer" });
    expect(computeAvailability(r, member, NOW)).toMatchObject({ bookable: 6, useLeadSeat: false });
  });

  it("lead: no general seat left shows 'Opens for you on' with the customer queue", () => {
    const r = lm("lead", { booked: 6 });
    expect(computeAvailability(r, customer, NOW)).toMatchObject({ bookable: 0, reason: "not_open_yet", opensAt: inHours(24), canJoinWaitlist: true, queue: "customer" });
    expect(computeAvailability(r, member, NOW)).toMatchObject({ reason: "not_open_yet", queue: "customer" });
    expect(computeAvailability(r, anonymous, NOW)).toMatchObject({ reason: "not_open_yet", queue: "public" });
    expect(computeAvailability(r, lead, NOW)).toMatchObject({ bookable: 4, useLeadSeat: true });
  });

  it("lead: a fully booked session is full for everyone", () => {
    const r = lm("lead", { booked: 10, leadReservedRemaining: 0 });
    expect(computeAvailability(r, customer, NOW)).toMatchObject({ reason: "full", canJoinWaitlist: true });
    expect(computeAvailability(r, lead, NOW)).toMatchObject({ reason: "full", queue: "lead" });
  });

  it("customer_release: customers and members book, leads wait for public release", () => {
    const r = lm("customer_release", { booked: 7 });
    expect(computeAvailability(r, customer, NOW)).toMatchObject({ bookable: 3, reason: "ok" });
    expect(computeAvailability(r, member, NOW)).toMatchObject({ bookable: 3, reason: "ok" });
    expect(computeAvailability(r, lead, NOW)).toMatchObject({ bookable: 0, reason: "not_open_yet", opensAt: inHours(26), canJoinWaitlist: true, queue: "lead" });
    expect(computeAvailability(r, anonymous, NOW)).toMatchObject({ reason: "not_open_yet", queue: "public" });
  });

  it("public: everyone books general seats", () => {
    const r = lm("public", { booked: 5 });
    for (const v of [lead, customer, member]) expect(computeAvailability(r, v, NOW)).toMatchObject({ bookable: 5, reason: "ok", useLeadSeat: false });
  });

  it("keep_for_leads: reserved seats stay lead-only after the window", () => {
    const r = lm("public", { leadReservedRemaining: 3, booked: 2 });
    expect(computeAvailability(r, lead, NOW)).toMatchObject({ bookable: 8, useLeadSeat: true });
    expect(computeAvailability(r, customer, NOW)).toMatchObject({ bookable: 5, useLeadSeat: false });
    const full = lm("public", { leadReservedRemaining: 3, booked: 7 });
    expect(computeAvailability(full, customer, NOW)).toMatchObject({ reason: "full", canJoinWaitlist: true });
    expect(computeAvailability(full, lead, NOW)).toMatchObject({ bookable: 3, useLeadSeat: true });
  });

  it("ignores the lead phase on a session that is not a lead magnet", () => {
    const r = row({ leadPhase: "lead", isLeadMagnet: false });
    expect(computeAvailability(r, customer, NOW)).toMatchObject({ phase: "none", queue: "public", bookable: 10 });
  });
});

describe("availabilityBand and describeAvailability (decision 32)", () => {
  it("bands", () => {
    expect(availabilityBand(0)).toBe("full");
    expect(availabilityBand(5)).toBe("few");
    expect(availabilityBand(6)).toBe("available");
  });

  it("labels", () => {
    const ok = computeAvailability(row({ booked: 7 }), customer, NOW);
    expect(describeAvailability(ok, "en")).toEqual({ labelKey: "booking.availability.placesLeft", params: { count: "3" } });
    expect(describeAvailability(computeAvailability(row(), customer, NOW), "en").labelKey).toBe("booking.availability.available");
    expect(describeAvailability(computeAvailability(row({ booked: 10 }), customer, NOW), "en").labelKey).toBe("booking.availability.full");
    const opens = describeAvailability({ ...ok, bookable: 0, reason: "not_open_yet", opensAt: new Date("2026-11-04T09:00:00Z") }, "en");
    expect(opens.labelKey).toBe("booking.availability.openForYouOn");
    expect(opens.params.date).toContain("10:00");
    expect(describeAvailability({ ...ok, reason: "member_only" }, "nl-BE").labelKey).toBe("booking.availability.memberOnly");
    expect(describeAvailability({ ...ok, reason: "closed" }, "fr-BE").labelKey).toBe("booking.availability.closed");
  });
});
