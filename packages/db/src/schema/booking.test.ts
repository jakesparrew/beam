import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeAvailability, type AvailabilityRow } from "@beam/core/booking";
import type { DbHandle } from "../client";
import { createTestDb, makePerson, makeProduct, makeSession } from "../testing";
import { bookings, capacityHolds, sessionExceptions, sessions, sessionTemplates, ticketTypes, waitlistEntries } from "./booking";
import { vPersonBookings, vSessionAvailability, vSessionUtilisation } from "./booking.views";

/** The Postgres error behind a failed query (message and SQLSTATE). */
async function pgError(promise: Promise<unknown>): Promise<{ message: string; code?: string }> {
  try {
    await promise;
  } catch (error) {
    const cause = (error as { cause?: { message?: string; code?: string } }).cause ?? (error as { message?: string; code?: string });
    return { message: String(cause.message ?? error), code: cause.code };
  }
  throw new Error("expected the query to fail");
}

/** Expects a check-constraint violation naming `constraint`. */
async function expectCheck(promise: Promise<unknown>, constraint: string) {
  const err = await pgError(promise);
  expect(err.code).toBe("23514");
  expect(err.message).toContain(constraint);
}

/** Expects a unique violation naming `index`. */
async function expectUnique(promise: Promise<unknown>, index: string) {
  const err = await pgError(promise);
  expect(err.code).toBe("23505");
  expect(err.message).toContain(index);
}

const title = { "nl-BE": "Sessie", "fr-BE": "Séance", en: "Session" };
const H = 3_600_000;
const inHours = (h: number) => new Date(Date.now() + h * H);

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
});
afterAll(() => h.close());

async function availability(sessionId: string) {
  const [row] = await h.db.select().from(vSessionAvailability).where(eq(vSessionAvailability.sessionId, sessionId));
  return row!;
}

describe("session_templates", () => {
  const base = {
    kind: "day" as const,
    name: title,
    weekdays: [2, 3, 4, 5, 6, 7],
    startTime: "09:00",
    durationMinutes: 120,
    capacitySeats: 12,
    creditKind: "day" as const,
    activeFromOn: "2026-01-01",
  };

  it("accepts a day template and a night template", async () => {
    const [t] = await h.db.insert(sessionTemplates).values(base).returning();
    expect(t).toMatchObject({ version: 1, isActive: true, creditCost: 1, startTime: "09:00:00" });
    await h.db.insert(sessionTemplates).values({ ...base, kind: "night", capacitySeats: null, capacityBeds: 6, creditKind: "night", startTime: "21:00", durationMinutes: 720 });
  });

  it("enforces every check", async () => {
    await expectCheck(h.db.insert(sessionTemplates).values({ ...base, weekdays: [0, 1] }), "session_templates_weekdays_ck");
    await expectCheck(h.db.insert(sessionTemplates).values({ ...base, weekdays: [] }), "session_templates_weekdays_ck");
    await expectCheck(h.db.insert(sessionTemplates).values({ ...base, durationMinutes: 10 }), "session_templates_duration_ck");
    await expectCheck(h.db.insert(sessionTemplates).values({ ...base, durationMinutes: 1441 }), "session_templates_duration_ck");
    await expectCheck(h.db.insert(sessionTemplates).values({ ...base, capacitySeats: -1 }), "session_templates_capacity_seats_ck");
    await expectCheck(h.db.insert(sessionTemplates).values({ ...base, creditCost: 11 }), "session_templates_credit_cost_ck");
    await expectCheck(h.db.insert(sessionTemplates).values({ ...base, activeToOn: "2025-12-31" }), "session_templates_active_range_ck");
    await expectCheck(h.db.insert(sessionTemplates).values({ ...base, capacityBeds: 4 }), "session_templates_night_beds_ck");
    await expectCheck(h.db.insert(sessionTemplates).values({ ...base, kind: "night", capacityBeds: null, creditKind: "night" }), "session_templates_night_beds_ck");
    await expectCheck(h.db.insert(sessionTemplates).values({ ...base, capacitySeats: null }), "session_templates_seats_ck");
    await expectCheck(h.db.insert(sessionTemplates).values({ ...base, creditKind: null }), "session_templates_credit_kind_ck");
    await h.db.insert(sessionTemplates).values({ ...base, kind: "event", creditKind: null });
  });
});

describe("session_exceptions", () => {
  it("requires hours exactly for special_hours, closing after opening", async () => {
    await h.db.insert(sessionExceptions).values({ onDate: "2026-12-25", kind: "holiday", name: title });
    await h.db.insert(sessionExceptions).values({ onDate: "2026-12-24", kind: "special_hours", opensAt: "10:00", closesAt: "15:00", name: title });
    await expectCheck(h.db.insert(sessionExceptions).values({ onDate: "2026-12-24", kind: "special_hours", name: title }), "session_exceptions_special_hours_ck");
    await expectCheck(h.db.insert(sessionExceptions).values({ onDate: "2026-12-24", kind: "closed", opensAt: "10:00", closesAt: "15:00", name: title }), "session_exceptions_special_hours_ck");
    await expectCheck(
      h.db.insert(sessionExceptions).values({ onDate: "2026-12-24", kind: "special_hours", opensAt: "15:00", closesAt: "10:00", name: title }),
      "session_exceptions_hours_order_ck",
    );
  });
});

describe("sessions", () => {
  it("keeps one materialised session per template and start", async () => {
    const [t] = await h.db
      .insert(sessionTemplates)
      .values({ kind: "day", name: title, weekdays: [1], startTime: "10:00", durationMinutes: 60, capacitySeats: 5, creditKind: "day", activeFromOn: "2026-01-01" })
      .returning();
    const startsAt = inHours(30);
    await makeSession(h.db, { templateId: t!.id, startsAt });
    await expectUnique(makeSession(h.db, { templateId: t!.id, startsAt }), "sessions_template_starts_uq");
    const inserted = await h.db
      .insert(sessions)
      .values({ templateId: t!.id, kind: "day", title, startsAt, endsAt: inHours(31), capacitySeats: 5 })
      .onConflictDoNothing()
      .returning();
    expect(inserted).toEqual([]);
    await makeSession(h.db, { startsAt });
    await makeSession(h.db, { startsAt });
  });

  it("keeps one session per webinar", async () => {
    const webinarId = crypto.randomUUID();
    await makeSession(h.db, { kind: "event", creditKind: null, eventCategory: "webinar", capacitySeats: 0, webinarId });
    await expectUnique(makeSession(h.db, { kind: "event", creditKind: null, eventCategory: "webinar", capacitySeats: 0, webinarId }), "sessions_webinar_uq");
  });

  it("enforces every check", async () => {
    await expectCheck(makeSession(h.db, { startsAt: inHours(5), endsAt: inHours(4) }), "sessions_ends_after_starts_ck");
    await expectCheck(makeSession(h.db, { capacitySeats: 4, leadReservedSeats: 5 }), "sessions_lead_seats_ck");
    await expectCheck(makeSession(h.db, { claimWindowMinutes: 5 }), "sessions_claim_window_ck");
    await expectCheck(makeSession(h.db, { isLeadMagnet: true }), "sessions_lead_magnet_ck");
    await expectCheck(
      makeSession(h.db, { kind: "event", creditKind: null, eventCategory: "lecture", isLeadMagnet: true, leadWindowStartAt: inHours(2), leadWindowEndAt: inHours(1) }),
      "sessions_lead_window_ck",
    );
    await expectCheck(makeSession(h.db, { capacitySeats: -1 }), "sessions_capacity_seats_ck");
    await expectCheck(makeSession(h.db, { kind: "night", capacityBeds: null, capacitySeats: 4 }), "sessions_night_beds_ck");
    await expectCheck(makeSession(h.db, { capacityBeds: 3 }), "sessions_night_beds_ck");
    await expectCheck(makeSession(h.db, { capacitySeats: null }), "sessions_seats_ck");
    await expectCheck(makeSession(h.db, { creditCost: 11 }), "sessions_credit_cost_ck");
    await expectCheck(makeSession(h.db, { status: "cancelled" }), "sessions_cancelled_at_ck");
    await expectCheck(makeSession(h.db, { cancelledAt: new Date() }), "sessions_cancelled_at_ck");
    await expectCheck(makeSession(h.db, { eventCategory: "lecture" }), "sessions_event_category_ck");
    await makeSession(h.db, { status: "cancelled", cancelledAt: new Date(), cancelReason: "storm" });
    await makeSession(h.db, {
      kind: "event",
      creditKind: null,
      eventCategory: "lecture",
      isLeadMagnet: true,
      leadReservedSeats: 4,
      leadWindowStartAt: inHours(1),
      leadWindowEndAt: inHours(2),
    });
  });
});

describe("capacity_holds and ticket_types", () => {
  it("enforce their checks and cascade with the session", async () => {
    const s = await makeSession(h.db, { kind: "event", creditKind: null, eventCategory: "concert" });
    await expectCheck(h.db.insert(capacityHolds).values({ sessionId: s.id, kind: "staff", quantity: 0 }), "capacity_holds_quantity_ck");
    await expectCheck(h.db.insert(capacityHolds).values({ sessionId: s.id, kind: "partner", quantity: 2 }), "capacity_holds_partner_company_ck");
    await h.db.insert(capacityHolds).values({ sessionId: s.id, kind: "partner", quantity: 2, companyId: crypto.randomUUID() });
    const product = await makeProduct(h.db);
    const tt = { sessionId: s.id, productId: product.id, name: title };
    await expectCheck(h.db.insert(ticketTypes).values({ ...tt, capacity: 0 }), "ticket_types_capacity_ck");
    await expectCheck(h.db.insert(ticketTypes).values({ ...tt, salesStartAt: inHours(2), salesEndAt: inHours(1) }), "ticket_types_sales_window_ck");
    await expectCheck(h.db.insert(ticketTypes).values({ ...tt, maxPerBooking: 0 }), "ticket_types_max_per_booking_ck");
    const [type] = await h.db.insert(ticketTypes).values(tt).returning();
    expect(type).toMatchObject({ maxPerBooking: 4, requiresGuestDetails: true, isActive: true, sortOrder: 0 });
    await h.db.delete(sessions).where(eq(sessions.id, s.id));
    expect(await h.db.select().from(capacityHolds).where(eq(capacityHolds.sessionId, s.id))).toEqual([]);
    expect(await h.db.select().from(ticketTypes).where(eq(ticketTypes.sessionId, s.id))).toEqual([]);
  });
});

describe("bookings", () => {
  it("allows one live booking per person and session; cancelled rows do not count", async () => {
    const s = await makeSession(h.db);
    const p = await makePerson(h.db);
    const row = { sessionId: s.id, personId: p.id, paidWith: "credit" as const, source: "portal" as const };
    const [first] = await h.db.insert(bookings).values({ ...row, status: "confirmed" }).returning();
    expect(first!.checkinCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{10}$/);
    expect(first).toMatchObject({ capacityUnits: 1, version: 1, isOverCapacity: false, usedLeadSeat: false });
    await expectUnique(h.db.insert(bookings).values({ ...row, status: "reserved", reservedUntil: inHours(1) }), "bookings_session_person_active_uq");
    await h.db.update(bookings).set({ status: "cancelled", cancelledAt: new Date(), cancelReasonCode: "customer" }).where(eq(bookings.id, first!.id));
    await h.db.insert(bookings).values({ ...row, status: "confirmed" });
    await expectUnique(h.db.insert(bookings).values({ ...row, status: "attended", attendedAt: new Date(), checkinCode: first!.checkinCode }), "bookings_checkin_code_uq");
  });

  it("keeps external_ref unique for imports", async () => {
    const s = await makeSession(h.db);
    const row = { sessionId: s.id, paidWith: "free" as const, source: "import" as const, status: "attended" as const, attendedAt: new Date(), externalRef: "simplybook:1" };
    await h.db.insert(bookings).values({ ...row, personId: (await makePerson(h.db)).id });
    await expectUnique(h.db.insert(bookings).values({ ...row, personId: (await makePerson(h.db)).id }), "bookings_external_ref_uq");
  });

  it("enforces every check", async () => {
    const s = await makeSession(h.db);
    const p = await makePerson(h.db);
    const row = { sessionId: s.id, personId: p.id, paidWith: "credit" as const, source: "admin" as const, status: "no_show" as const };
    await expectCheck(h.db.insert(bookings).values({ ...row, status: "reserved" }), "bookings_reserved_until_ck");
    await expectCheck(h.db.insert(bookings).values({ ...row, status: "attended" }), "bookings_attended_at_ck");
    await expectCheck(h.db.insert(bookings).values({ ...row, capacityUnits: 2 }), "bookings_capacity_units_ck");
    await expectCheck(h.db.insert(bookings).values({ ...row, paidWith: "order", status: "confirmed" }), "bookings_order_line_ck");
    await expectCheck(h.db.insert(bookings).values({ ...row, status: "cancelled" }), "bookings_cancelled_ck");
    await expectCheck(h.db.insert(bookings).values({ ...row, status: "late_cancelled", cancelledAt: new Date() }), "bookings_cancelled_ck");
    await expectCheck(h.db.insert(bookings).values({ ...row, isPayAtDesk: true }), "bookings_pay_at_desk_ck");
    const id = crypto.randomUUID();
    await expectCheck(h.db.insert(bookings).values({ ...row, id, guestOfBookingId: id }), "bookings_guest_not_self_ck");
    // A reserved order row may lack its line until commerce returns it (R18); pay at desk is order only.
    await h.db.insert(bookings).values({ ...row, paidWith: "order", status: "reserved", reservedUntil: inHours(1), isPayAtDesk: true });
  });
});

describe("waitlist_entries", () => {
  it("allows one entry per person and session and unique claim hashes", async () => {
    const s = await makeSession(h.db);
    const p = await makePerson(h.db);
    const [e] = await h.db.insert(waitlistEntries).values({ sessionId: s.id, personId: p.id }).returning();
    expect(e).toMatchObject({ queue: "public", state: "waiting", offersCount: 0, rejoinCount: 0, isFlaggedDuplicate: false });
    await expectUnique(h.db.insert(waitlistEntries).values({ sessionId: s.id, personId: p.id }), "waitlist_entries_session_person_uq");
    const offered = { state: "offered" as const, offerExpiresAt: inHours(2), claimTokenHash: "a".repeat(64) };
    await h.db.insert(waitlistEntries).values({ sessionId: s.id, personId: (await makePerson(h.db)).id, ...offered });
    await expectUnique(h.db.insert(waitlistEntries).values({ sessionId: s.id, personId: (await makePerson(h.db)).id, ...offered }), "waitlist_entries_claim_token_uq");
  });

  it("enforces every check, rejoin_count included", async () => {
    const s = await makeSession(h.db);
    const entry = async (values: Partial<typeof waitlistEntries.$inferInsert>) =>
      h.db.insert(waitlistEntries).values({ sessionId: s.id, personId: (await makePerson(h.db)).id, ...values });
    await expectCheck(entry({ state: "offered" }), "waitlist_entries_offered_ck");
    await expectCheck(entry({ state: "confirmed" }), "waitlist_entries_confirmed_ck");
    await expectCheck(entry({ offersCount: 6 }), "waitlist_entries_offers_count_ck");
    await expectCheck(entry({ rejoinCount: 2 }), "waitlist_entries_rejoin_count_ck");
    await expectCheck(entry({ rejoinCount: -1 }), "waitlist_entries_rejoin_count_ck");
    await expectCheck(entry({ state: "released", endedReason: "bored" }), "waitlist_entries_ended_reason_ck");
    await entry({ state: "released", endedReason: "session_cancelled", rejoinCount: 1, offersCount: 5 });
  });
});

describe("v_session_availability", () => {
  it("returns a full row for an empty session", async () => {
    const s = await makeSession(h.db, { capacitySeats: 8 });
    expect(await availability(s.id)).toMatchObject({
      capacity: 8,
      held: 0,
      booked: 0,
      leadBooked: 0,
      liveOffers: 0,
      liveLeadOffers: 0,
      availableTotal: 8,
      leadReservedRemaining: 0,
      leadPhase: "none",
      availableGeneral: 8,
      opensForCustomersAt: null,
      opensForPublicAt: null,
      waiting: 0,
    });
  });

  it("subtracts holds, live bookings and live offers; ignores lapsed and hold-filled rows", async () => {
    const s = await makeSession(h.db, { capacitySeats: 10 });
    const [hold] = await h.db.insert(capacityHolds).values({ sessionId: s.id, kind: "speaker", quantity: 2 }).returning();
    const person = async () => (await makePerson(h.db)).id;
    const b = { sessionId: s.id, paidWith: "credit" as const, source: "portal" as const };
    await h.db.insert(bookings).values([
      { ...b, personId: await person(), status: "confirmed" },
      { ...b, personId: await person(), status: "attended", attendedAt: new Date() },
      { ...b, personId: await person(), status: "no_show" },
      { ...b, personId: await person(), status: "reserved", paidWith: "order", reservedUntil: inHours(1) },
      { ...b, personId: await person(), status: "reserved", paidWith: "order", reservedUntil: inHours(-1) },
      { ...b, personId: await person(), status: "cancelled", cancelledAt: new Date(), cancelReasonCode: "customer" },
      { ...b, personId: await person(), status: "confirmed", capacityHoldId: hold!.id },
      { ...b, personId: await person(), status: "confirmed", capacityUnits: 0 },
    ]);
    await h.db.insert(waitlistEntries).values([
      { sessionId: s.id, personId: await person(), state: "offered", offerExpiresAt: inHours(1) },
      { sessionId: s.id, personId: await person(), state: "offered", offerExpiresAt: inHours(-1) },
      { sessionId: s.id, personId: await person(), state: "waiting" },
      { sessionId: s.id, personId: await person(), state: "waiting" },
      { sessionId: s.id, personId: await person(), state: "expired", endedReason: "offer_timeout" },
    ]);
    expect(await availability(s.id)).toMatchObject({ capacity: 10, held: 2, booked: 4, liveOffers: 1, availableTotal: 3, availableGeneral: 3, waiting: 2 });
  });

  it("computes the lead phases and reserved pools", async () => {
    const lead = (start: number, end: number, extra: Partial<typeof sessions.$inferInsert> = {}) =>
      makeSession(h.db, {
        kind: "event",
        creditKind: null,
        eventCategory: "lecture",
        capacitySeats: 10,
        isLeadMagnet: true,
        leadReservedSeats: 4,
        leadWindowStartAt: inHours(start),
        leadWindowEndAt: inHours(end),
        startsAt: inHours(100),
        endsAt: inHours(102),
        ...extra,
      });
    const pre = await lead(1, 2);
    expect(await availability(pre.id)).toMatchObject({ leadPhase: "pre", leadReservedRemaining: 4, availableGeneral: 6 });
    const during = await lead(-1, 2);
    await h.db.insert(bookings).values({ sessionId: during.id, personId: (await makePerson(h.db)).id, status: "confirmed", paidWith: "free", source: "portal", usedLeadSeat: true });
    await h.db.insert(waitlistEntries).values({ sessionId: during.id, personId: (await makePerson(h.db)).id, state: "offered", queue: "lead", offerExpiresAt: inHours(1) });
    const d = await availability(during.id);
    expect(d).toMatchObject({ leadPhase: "lead", leadBooked: 1, liveLeadOffers: 1, leadReservedRemaining: 2, availableTotal: 8, availableGeneral: 6 });
    expect(d.opensForCustomersAt?.getTime()).toBe(during.leadWindowEndAt!.getTime());
    expect(d.opensForPublicAt?.getTime()).toBe(during.leadWindowEndAt!.getTime() + 120 * 60_000);
    expect(await availability((await lead(-3, -1)).id)).toMatchObject({ leadPhase: "customer_release", leadReservedRemaining: 0, availableGeneral: 10 });
    expect(await availability((await lead(-5, -4)).id)).toMatchObject({ leadPhase: "public" });
    expect(await availability((await lead(-3, -1, { leadReleaseRule: "public" })).id)).toMatchObject({ leadPhase: "public", leadReservedRemaining: 0 });
    expect(await availability((await lead(-5, -4, { leadReleaseRule: "keep_for_leads" })).id)).toMatchObject({ leadPhase: "public", leadReservedRemaining: 4, availableGeneral: 6 });
    expect(await availability((await lead(-3, -2, { publicReleaseAt: inHours(5) })).id)).toMatchObject({ leadPhase: "customer_release" });
  });

  it("matches computeAvailability on 10 fixture sessions", async () => {
    type Fixture = { session: Partial<typeof sessions.$inferInsert>; booked: number; held: number; offers: number; expect: { customer: number; lead: number; reason: string } };
    const lm = (start: number, end: number, rule: "customers_then_public" | "public" | "keep_for_leads" = "customers_then_public") => ({
      kind: "event" as const,
      creditKind: null,
      eventCategory: "lecture" as const,
      isLeadMagnet: true,
      leadReservedSeats: 3,
      leadWindowStartAt: inHours(start),
      leadWindowEndAt: inHours(end),
      leadReleaseRule: rule,
    });
    const fixtures: Fixture[] = [
      { session: {}, booked: 0, held: 0, offers: 0, expect: { customer: 10, lead: 10, reason: "ok" } },
      { session: {}, booked: 6, held: 2, offers: 1, expect: { customer: 1, lead: 1, reason: "ok" } },
      { session: {}, booked: 8, held: 2, offers: 0, expect: { customer: 0, lead: 0, reason: "full" } },
      { session: { status: "closed" }, booked: 0, held: 0, offers: 0, expect: { customer: 0, lead: 0, reason: "closed" } },
      { session: { isMemberOnly: true }, booked: 0, held: 0, offers: 0, expect: { customer: 0, lead: 0, reason: "member_only" } },
      { session: { publishedAt: null }, booked: 0, held: 0, offers: 0, expect: { customer: 0, lead: 0, reason: "not_open_yet" } },
      { session: lm(1, 2), booked: 2, held: 0, offers: 0, expect: { customer: 5, lead: 5, reason: "ok" } },
      { session: lm(-1, 2), booked: 7, held: 0, offers: 0, expect: { customer: 0, lead: 3, reason: "not_open_yet" } },
      { session: lm(-3, -1), booked: 4, held: 0, offers: 0, expect: { customer: 6, lead: 0, reason: "ok" } },
      { session: lm(-5, -4, "keep_for_leads"), booked: 5, held: 0, offers: 1, expect: { customer: 1, lead: 4, reason: "ok" } },
    ];
    const now = new Date();
    for (const f of fixtures) {
      const s = await makeSession(h.db, { capacitySeats: 10, startsAt: inHours(72), endsAt: inHours(74), publishedAt: inHours(-1), ...f.session });
      for (let i = 0; i < f.booked; i++) {
        await h.db.insert(bookings).values({ sessionId: s.id, personId: (await makePerson(h.db)).id, status: "confirmed", paidWith: "free", source: "admin" });
      }
      if (f.held) await h.db.insert(capacityHolds).values({ sessionId: s.id, kind: "blocked", quantity: f.held });
      for (let i = 0; i < f.offers; i++) {
        await h.db.insert(waitlistEntries).values({ sessionId: s.id, personId: (await makePerson(h.db)).id, state: "offered", offerExpiresAt: inHours(1) });
      }
      const v = await availability(s.id);
      const row: AvailabilityRow = { ...v, publishedAt: v.publishedAt, isMemberOnly: s.isMemberOnly, webinarId: s.webinarId };
      const customer = computeAvailability(row, { status: "customer", isMember: false }, now);
      const lead = computeAvailability(row, { status: "lead", isMember: false }, now);
      expect({ customer: customer.bookable, lead: lead.bookable, reason: customer.reason }).toEqual(f.expect);
    }
  });
});

describe("v_person_bookings and v_session_utilisation", () => {
  it("links guests to their owner and counts utilisation", async () => {
    const s = await makeSession(h.db, { capacitySeats: 4, startsAt: inHours(-5), endsAt: inHours(-3) });
    const owner = await makePerson(h.db);
    const guest = await makePerson(h.db);
    const [ob] = await h.db.insert(bookings).values({ sessionId: s.id, personId: owner.id, status: "attended", attendedAt: new Date(), paidWith: "credit", source: "portal" }).returning();
    await h.db.insert(bookings).values({ sessionId: s.id, personId: guest.id, status: "no_show", paidWith: "guest", source: "portal", guestOfBookingId: ob!.id, bookedByPersonId: owner.id });
    await h.db.insert(bookings).values({ sessionId: s.id, personId: (await makePerson(h.db)).id, status: "late_cancelled", cancelledAt: new Date(), cancelReasonCode: "customer", paidWith: "credit", source: "portal" });
    await h.db.insert(waitlistEntries).values({ sessionId: s.id, personId: (await makePerson(h.db)).id, state: "released", endedReason: "session_started" });

    const rows = await h.db.select().from(vPersonBookings).where(sql`${vPersonBookings.personId} = ${owner.id} or ${vPersonBookings.ownerPersonId} = ${owner.id}`);
    expect(rows).toHaveLength(2);
    const g = rows.find((r) => r.personId === guest.id)!;
    expect(g).toMatchObject({ isGuest: true, ownerPersonId: owner.id, kind: "day", sessionStatus: "open" });
    expect(g.title).toMatchObject({ en: "Test session" });

    const [u] = await h.db.select().from(vSessionUtilisation).where(eq(vSessionUtilisation.sessionId, s.id));
    expect(u).toMatchObject({ capacity: 4, bookedTotal: 2, attended: 1, noShows: 1, lateCancellations: 1, cancellations: 0, waitlistPeak: 1, utilisationPct: 50 });

    const future = await makeSession(h.db, { capacitySeats: 3 });
    await h.db.insert(bookings).values({ sessionId: future.id, personId: owner.id, status: "confirmed", paidWith: "credit", source: "portal" });
    const [fu] = await h.db.select().from(vSessionUtilisation).where(eq(vSessionUtilisation.sessionId, future.id));
    expect(fu!.utilisationPct).toBeCloseTo(33.3, 1);
    expect(fu!.weekday).toBeGreaterThanOrEqual(1);
  });
});
