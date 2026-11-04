import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { activityEvents, bookings, creditEntries, emailMessages, sessions } from "@beam/db/schema";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import { eq, type Actor } from "@/lib/ctx";
import { resetRuntime, staffActor } from "@/lib/testing";
import { DAY, inTx, openSession, setBookingRules } from "../server/booking-p3a.fixtures";
import {
  getAvailability,
  getAvailabilityPreview,
  getNextBooking,
  getPersonBookingSummary,
  getSessionCards,
  hasFutureBooking,
  importBooking,
  listBookableSessions,
  listPersonBookings,
  listPublicEvents,
  listUpcomingBookingsForPerson,
} from "./bookings";

vi.mock("@/modules/credits/api", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getMembershipForPerson: vi.fn().mockResolvedValue({ isMember: false, membershipId: null, planProductId: null, discountPct: 0, status: null, periodEndAt: null, cancelAt: null }),
}));

let h: DbHandle;
let staff: Actor;
beforeAll(async () => {
  h = await createTestDb();
  staff = staffActor({ userId: (await makeUser(h.db)).id, permissions: ["ops.import"] });
  await setBookingRules(h.db);
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

const at = (days: number) => new Date(Date.now() + days * DAY);
type BookingInsert = typeof bookings.$inferInsert;
async function addBooking(sessionId: string, personId: string, over: Partial<BookingInsert> = {}) {
  const [row] = await h.db
    .insert(bookings)
    .values({ sessionId, personId, status: "confirmed", paidWith: "free", source: "admin", ...over })
    .returning();
  return row!;
}
/** A session in the past (published, ended). */
const pastSession = (days: number, kind: "day" | "night" | "event" = "day") => openSession(h.db, { kind, startsAt: at(-days) });

describe("people and history", () => {
  it("hasFutureBooking and getNextBooking see live future rows only, optionally by kind", async () => {
    const person = await makePerson(h.db);
    expect(await hasFutureBooking(h.db, person.id)).toBe(false);
    expect(await getNextBooking(h.db, person.id)).toBeNull();
    const past = await pastSession(3);
    await addBooking(past.id, person.id, { status: "attended", attendedAt: at(-3) });
    const cancelled = await openSession(h.db, { startsAt: at(1) });
    await addBooking(cancelled.id, person.id, { status: "cancelled", cancelledAt: new Date(), cancelReasonCode: "customer" });
    expect(await hasFutureBooking(h.db, person.id)).toBe(false);
    const later = await openSession(h.db, { kind: "night", startsAt: at(5) });
    const soon = await openSession(h.db, { startsAt: at(2) });
    const b1 = await addBooking(later.id, person.id);
    const b2 = await addBooking(soon.id, person.id);
    expect(await hasFutureBooking(h.db, person.id)).toBe(true);
    expect(await hasFutureBooking(h.db, person.id, ["event"])).toBe(false);
    expect(await hasFutureBooking(h.db, person.id, ["night"])).toBe(true);
    expect(await getNextBooking(h.db, person.id)).toEqual({ bookingId: b2.id, sessionId: soon.id, startsAt: soon.startsAt, kind: "day" });
    expect((await getNextBooking(h.db, person.id, ["night"]))?.bookingId).toBe(b1.id);
    // an expired reservation is not live
    const reserved = await makePerson(h.db);
    await addBooking(soon.id, reserved.id, { status: "reserved", paidWith: "free", reservedUntil: at(-0.01) });
    expect(await hasFutureBooking(h.db, reserved.id)).toBe(false);
  });

  it("getPersonBookingSummary counts visits, no-shows, cancellations, nights and events", async () => {
    const person = await makePerson(h.db);
    const d1 = await pastSession(20);
    const d2 = await pastSession(10);
    const n1 = await pastSession(8, "night");
    const e1 = await pastSession(6, "event");
    const ns = await pastSession(4);
    await addBooking(d1.id, person.id, { status: "attended", attendedAt: d1.startsAt });
    await addBooking(d2.id, person.id, { status: "attended", attendedAt: d2.startsAt });
    await addBooking(n1.id, person.id, { status: "attended", attendedAt: n1.startsAt });
    await addBooking(e1.id, person.id, { status: "attended", attendedAt: e1.startsAt });
    await addBooking(ns.id, person.id, { status: "no_show" });
    const c1 = await openSession(h.db, { startsAt: at(3) });
    await addBooking(c1.id, person.id, { status: "cancelled", cancelledAt: new Date(), cancelReasonCode: "customer" });
    const c2 = await openSession(h.db, { startsAt: at(3) });
    await addBooking(c2.id, person.id, { status: "cancelled", cancelledAt: new Date(), cancelReasonCode: "payment_expired" });
    const c3 = await openSession(h.db, { startsAt: at(3) });
    await addBooking(c3.id, person.id, { status: "late_cancelled", cancelledAt: new Date(), cancelReasonCode: "customer" });
    const up = await openSession(h.db, { startsAt: at(6) });
    await addBooking(up.id, person.id);
    const s = await getPersonBookingSummary(h.db, person.id);
    expect(s).toEqual({
      nextBookingAt: up.startsAt,
      upcoming: 1,
      attended: 4,
      noShows: 1,
      cancellations: 1,
      lateCancellations: 1,
      firstVisitAt: d1.startsAt,
      lastVisitAt: n1.startsAt,
      nightsBooked: 1,
      eventsAttended: 1,
    });
    const empty = await getPersonBookingSummary(h.db, (await makePerson(h.db)).id);
    expect(empty).toMatchObject({ nextBookingAt: null, upcoming: 0, attended: 0, firstVisitAt: null });
  });

  it("listPersonBookings and listUpcomingBookingsForPerson include the person's guests", async () => {
    const owner = await makePerson(h.db);
    const guest = await makePerson(h.db, { firstName: "Gwen" });
    const s = await openSession(h.db, { startsAt: at(2) });
    const own = await addBooking(s.id, owner.id, { bookedByPersonId: owner.id });
    await addBooking(s.id, guest.id, { paidWith: "guest", guestOfBookingId: own.id, bookedByPersonId: owner.id });
    const list = await listPersonBookings(h.db, owner.id);
    expect(list.map((r) => r.isGuest).sort()).toEqual([false, true]);
    expect(await listPersonBookings(h.db, guest.id)).toHaveLength(1);
    const upcoming = await listUpcomingBookingsForPerson(h.db, owner.id, 10);
    expect(upcoming.map((r) => [r.isGuest, r.guestFirstName]).sort()).toEqual([
      [false, null],
      [true, "Gwen"],
    ]);
  });
});

describe("availability and public lists", () => {
  it("getAvailability returns the person's availability with the view's pools", async () => {
    const s = await openSession(h.db, { capacitySeats: 3 });
    await addBooking(s.id, (await makePerson(h.db)).id);
    const a = await getAvailability(h.db, { sessionId: s.id, personId: (await makePerson(h.db)).id });
    expect(a).toMatchObject({ sessionId: s.id, kind: "day", capacity: 3, booked: 1, held: 0, waiting: 0, bookable: 2, reason: "ok" });
  });

  it("getAvailabilityPreview bands published day sessions and skips unpublished ones", async () => {
    const from = at(30);
    const to = at(31);
    const many = await openSession(h.db, { startsAt: new Date(from.getTime() + 3_600_000), capacitySeats: 10 });
    const few = await openSession(h.db, { startsAt: new Date(from.getTime() + 2 * 3_600_000), capacitySeats: 2 });
    const full = await openSession(h.db, { startsAt: new Date(from.getTime() + 3 * 3_600_000), capacitySeats: 1 });
    await openSession(h.db, { startsAt: new Date(from.getTime() + 4 * 3_600_000), publishedAt: null });
    await addBooking(full.id, (await makePerson(h.db)).id);
    await addBooking(few.id, (await makePerson(h.db)).id);
    const rows = await getAvailabilityPreview(h.db, { kind: "day", from, to });
    expect(rows.map((r) => [r.sessionId, r.band])).toEqual([
      [many.id, "available"],
      [few.id, "few"],
      [full.id, "full"],
    ]);
  });

  it("listPublicEvents pages published events (webinars included) and getSessionCards keeps the order", async () => {
    const from = at(40);
    const e1 = await openSession(h.db, { kind: "event", startsAt: new Date(from.getTime() + 1_000), creditKind: null, creditCost: 0 });
    const e2 = await openSession(h.db, {
      kind: "event",
      eventCategory: "webinar",
      webinarId: randomUUID(),
      capacitySeats: 0,
      startsAt: new Date(from.getTime() + 2_000),
      creditKind: null,
      creditCost: 0,
    });
    await openSession(h.db, { kind: "event", startsAt: new Date(from.getTime() + 3_000), publishedAt: null, creditKind: null, creditCost: 0 });
    const page = await listPublicEvents(h.db, { from, limit: 10, offset: 0 });
    expect(page.map((e) => e.sessionId)).toEqual([e1.id, e2.id]);
    expect(page[0]).toMatchObject({ eventCategory: "lecture", availabilityBand: "available", title: e1.title });
    expect((await listPublicEvents(h.db, { from, limit: 1, offset: 1 })).map((e) => e.sessionId)).toEqual([e2.id]);
    const cards = await getSessionCards(h.db, [e2.id, randomUUID(), e1.id], "fr-BE");
    expect(cards.map((c) => c.sessionId)).toEqual([e2.id, e1.id]);
    expect(cards[1]).toMatchObject({ title: "Session test", bookUrl: `/fr/account/book/${e1.id}`, opensForCustomersAt: null, availabilityBand: "available" });
    expect(await getSessionCards(h.db, [], "en")).toEqual([]);
  });

  it("listBookableSessions applies R7 (published, future, within the horizon, no webinars)", async () => {
    const onDay = at(12);
    const fromOn = onDay.toISOString().slice(0, 10);
    const s = await openSession(h.db, { startsAt: new Date(`${fromOn}T10:00:00Z`) });
    await openSession(h.db, { startsAt: new Date(`${fromOn}T12:00:00Z`), publishedAt: null });
    const list = await listBookableSessions(h.db, { kind: "day", fromOn, toOn: fromOn });
    expect(list.map((x) => x.sessionId)).toEqual([s.id]);
    expect(list[0]).toMatchObject({ free: 10, band: "available" });
  });
});

describe("importBooking (R65)", () => {
  it("creates a confirmed import row on the matching session, no ledger, no email, replay fact; idempotent on external_ref", async () => {
    const s = await openSession(h.db, { startsAt: new Date("2027-01-12T09:00:00Z"), capacitySeats: 1 });
    const person = await makePerson(h.db);
    const ref = `simplybook:${randomUUID()}`;
    const run = (externalRef: string, personId: string, over: Partial<Parameters<typeof importBooking>[2]> = {}) =>
      inTx(h.db, staff, (tx, ctx) => importBooking(tx, ctx, { externalRef, personId, kind: "day", startsAt: s.startsAt, paidWith: "credit", ...over }));
    const first = await run(ref, person.id);
    expect(first.outcome).toBe("created");
    const [row] = await h.db.select().from(bookings).where(eq(bookings.id, first.bookingId!));
    expect(row).toMatchObject({ status: "confirmed", source: "import", externalRef: ref, paidWith: "credit", isOverCapacity: false });
    expect(await h.db.select().from(creditEntries).where(eq(creditEntries.refId, row!.id))).toHaveLength(0);
    expect(await h.db.select().from(emailMessages).where(eq(emailMessages.personId, person.id))).toHaveLength(0);
    const [fact] = await h.db.select().from(activityEvents).where(eq(activityEvents.refId, row!.id));
    expect(fact).toMatchObject({ kind: "booking.confirmed" });
    expect(await run(ref, person.id)).toEqual({ bookingId: first.bookingId, outcome: "existing" });
    const over = await run(`simplybook:${randomUUID()}`, (await makePerson(h.db)).id, { paidWith: "order" });
    expect(over.outcome).toBe("over_capacity");
    const [overRow] = await h.db.select().from(bookings).where(eq(bookings.id, over.bookingId!));
    expect(overRow).toMatchObject({ isOverCapacity: true });
    expect(await run(`simplybook:${randomUUID()}`, person.id, { startsAt: new Date("2027-01-12T09:30:00Z") })).toEqual({ bookingId: null, outcome: "no_session" });
    expect(await run(`simplybook:${randomUUID()}`, person.id, { kind: "night" })).toEqual({ bookingId: null, outcome: "no_session" });
    const [count] = await h.db.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, s.id));
    expect(count).toBeDefined();
  });
});
