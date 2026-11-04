import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import { makeCreditGrant } from "@beam/db/testing/credits-factories";
import type { DbHandle } from "@beam/db";
import { bookings, roles } from "@beam/db/schema";
import { DEFAULT_BOOKING_RULES } from "@beam/core/booking";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (name: string) => void jar.delete(name),
    }),
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "192.0.2.10" })),
}));
vi.mock("next/server", () => ({ after: () => undefined }));
vi.mock("@/modules/credits/api", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  releaseCredits: vi.fn().mockResolvedValue({ releasedUnits: 1 }),
}));

const actions = await import("./attendance");
const { createAuthSession, SESSION_COOKIE } = await import("@/lib/auth");
const { eq, setAppDb } = await import("@/lib/ctx");
const { resetRuntime } = await import("@/lib/testing");
const { releaseCredits } = await import("@/modules/credits/api");
const { DAY, HOUR, inTx, openSession, setBookingRules } = await import("../server/booking-p3a.fixtures");
const { bookingById, factsOf, rawBooking, unpaidOrderBooking } = await import("../server/booking-p3b.fixtures");

let h: DbHandle;
const MIN = 60_000;
const ago = (ms: number) => new Date(Date.now() - ms);
const ahead = (ms: number) => new Date(Date.now() + ms);

async function asStaff(permissions: string[] = ["bookings.read", "bookings.write"]) {
  const user = await makeUser(h.db, { roleKey: "reception" });
  await h.db.update(roles).set({ permissions }).where(eq(roles.key, "reception"));
  const { token } = await createAuthSession(h.db, { userId: user.id, audience: "staff", roleKey: "reception", now: new Date(), mfaAt: new Date() });
  jar.set(SESSION_COOKIE, token);
  return user;
}

/** A session running now (started 30 minutes ago, ends in 90 minutes). */
const runningSession = () => openSession(h.db, { startsAt: ago(30 * MIN) });
/** A session whose end lies `ms` in the past (two hours long). */
const endedSession = (ms: number) => openSession(h.db, { startsAt: ago(ms + 2 * HOUR) });

beforeAll(async () => {
  // Noon in Brussels today, so the "same day" rule of R35 never depends on when the suite runs.
  const noon = new Date();
  noon.setUTCHours(11, 0, 0, 0);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(noon);
  h = await createTestDb();
  setAppDb(h.db);
});
afterAll(async () => {
  vi.useRealTimers();
  resetRuntime();
  await h.close();
});
beforeEach(async () => {
  jar.clear();
  vi.mocked(releaseCredits).mockClear();
  await setBookingRules(h.db);
  await asStaff();
});

const conflict = (reason: string) => ({ ok: false, error: { code: "conflict", message: reason } });

describe("checkIn (R35)", () => {
  it("follows the check-in window of settings.booking_rules.check_in", async () => {
    const soon = await openSession(h.db, { startsAt: ahead(3 * HOUR) });
    const early = await rawBooking(h.db, { sessionId: soon.id });
    expect(await actions.checkIn({ bookingId: early.id })).toMatchObject(conflict("outside_window"));
    await setBookingRules(h.db, { check_in: { ...DEFAULT_BOOKING_RULES.check_in, opens_minutes_before_start: 240 } });
    expect(await actions.checkIn({ bookingId: early.id })).toMatchObject({ ok: true, data: { status: "attended" } });

    await setBookingRules(h.db);
    const late = await rawBooking(h.db, { sessionId: (await endedSession(3 * HOUR)).id });
    expect(await actions.checkIn({ bookingId: late.id })).toMatchObject(conflict("outside_window"));
    // `override: true` without `bookings.override` changes nothing.
    expect(await actions.checkIn({ bookingId: late.id, override: true })).toMatchObject(conflict("outside_window"));
    await asStaff(["bookings.read", "bookings.write", "bookings.override"]);
    expect(await actions.checkIn({ bookingId: late.id })).toMatchObject(conflict("outside_window"));
    expect(await actions.checkIn({ bookingId: late.id, override: true })).toMatchObject({ ok: true, data: { status: "attended" } });

    const inside = await rawBooking(h.db, { sessionId: (await endedSession(90 * MIN)).id });
    await asStaff();
    expect(await actions.checkIn({ bookingId: inside.id })).toMatchObject({ ok: true, data: { status: "attended" } });
  });

  it("refuses another day's session unless overridden, even inside a wide window", async () => {
    await setBookingRules(h.db, { check_in: { ...DEFAULT_BOOKING_RULES.check_in, opens_minutes_before_start: 4 * 24 * 60 } });
    const later = await openSession(h.db, { startsAt: ahead(2 * DAY) });
    const b = await rawBooking(h.db, { sessionId: later.id });
    expect(await actions.checkIn({ bookingId: b.id })).toMatchObject(conflict("outside_window"));
    expect((await bookingById(h.db, b.id)).status).toBe("confirmed");
    await asStaff(["bookings.read", "bookings.write", "bookings.override"]);
    expect(await actions.checkIn({ bookingId: b.id, override: true })).toMatchObject({ ok: true, data: { status: "attended" } });
  });

  it("finds the booking by code (typed, lower case or the QR URL) and by id", async () => {
    const s = await runningSession();
    const person = await makePerson(h.db, { firstName: "Ilse", lastName: "Peeters" });
    const byCode = await rawBooking(h.db, { sessionId: s.id, personId: person.id });
    const res = await actions.checkIn({ checkinCode: byCode.checkinCode.toLowerCase() });
    expect(res).toMatchObject({ ok: true, data: { bookingId: byCode.id, personName: "Ilse Peeters", status: "attended", alreadyCheckedIn: false } });
    const row = await bookingById(h.db, byCode.id);
    expect(row.attendedAt).toBeInstanceOf(Date);
    expect(row.version).toBe(byCode.version + 1);

    const byUrl = await rawBooking(h.db, { sessionId: s.id });
    expect(await actions.checkIn({ checkinCode: `https://beam.example.com/admin/bookings/checkin?c=${byUrl.checkinCode}` })).toMatchObject({ ok: true, data: { bookingId: byUrl.id } });

    const byId = await rawBooking(h.db, { sessionId: s.id });
    expect(await actions.checkIn({ bookingId: byId.id })).toMatchObject({ ok: true, data: { bookingId: byId.id, status: "attended" } });

    expect(await actions.checkIn({ checkinCode: "ZZZZZZZZZZ" })).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await actions.checkIn({ checkinCode: "Jan Janssens" })).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await actions.checkIn({})).toMatchObject({ ok: false, error: { code: "validation" } });
  });

  it("refuses a reserved (unpaid, pay-at-desk) row with payment_required and checks it in once paid", async () => {
    const s = await runningSession();
    const { booking } = await unpaidOrderBooking(h.db, { sessionId: s.id, isPayAtDesk: true, reservedUntil: s.endsAt });
    expect(await actions.checkIn({ bookingId: booking.id })).toMatchObject(conflict("payment_required"));
    expect((await bookingById(h.db, booking.id)).status).toBe("reserved");
    // commerce confirms the row through confirmBookingsForOrder; then check-in is allowed.
    await h.db.update(bookings).set({ status: "confirmed" }).where(eq(bookings.id, booking.id));
    expect(await actions.checkIn({ bookingId: booking.id })).toMatchObject({ ok: true, data: { status: "attended" } });
  });

  it("refuses cancelled rows and never blocks on a missing health declaration", async () => {
    const s = await runningSession();
    const cancelled = await rawBooking(h.db, { sessionId: s.id, status: "cancelled", cancelledAt: new Date(), cancelReasonCode: "customer" });
    expect(await actions.checkIn({ bookingId: cancelled.id })).toMatchObject(conflict("invalid_transition"));
    await setBookingRules(h.db, { require_health_declaration: true });
    const b = await rawBooking(h.db, { sessionId: s.id });
    expect(await actions.checkIn({ bookingId: b.id })).toMatchObject({ ok: true, data: { status: "attended" } });
  });

  it("writes booking.attended once with is_first_visit, and recomputes it after an undo", async () => {
    const person = await makePerson(h.db);
    const s1 = await runningSession();
    const s2 = await runningSession();
    const first = await rawBooking(h.db, { sessionId: s1.id, personId: person.id });
    const second = await rawBooking(h.db, { sessionId: s2.id, personId: person.id });

    expect(await actions.checkIn({ bookingId: first.id })).toMatchObject({ ok: true, data: { alreadyCheckedIn: false } });
    // A double scan returns the check-in time and writes nothing.
    expect(await actions.checkIn({ bookingId: first.id })).toMatchObject({ ok: true, data: { status: "attended", alreadyCheckedIn: true } });
    let facts = (await factsOf(h.db, first.id)).filter((f) => f.kind === "booking.attended");
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ dedupeKey: `booking:${first.id}:attended:${first.version + 1}`, data: { is_first_visit: true, by: "staff" } });

    await actions.checkIn({ bookingId: second.id });
    expect((await factsOf(h.db, second.id)).find((f) => f.kind === "booking.attended")?.data).toMatchObject({ is_first_visit: false });

    // Undo both, then check in the second again: it is now the first visit.
    expect(await actions.undoCheckIn({ bookingId: second.id })).toMatchObject({ ok: true, data: { status: "confirmed" } });
    expect(await actions.undoCheckIn({ bookingId: first.id })).toMatchObject({ ok: true, data: { status: "confirmed" } });
    expect((await factsOf(h.db, first.id)).map((f) => f.kind)).toEqual(["booking.attended", "booking.check_in_undone"]);
    expect((await bookingById(h.db, first.id)).attendedAt).toBeNull();
    await actions.checkIn({ bookingId: second.id });
    facts = (await factsOf(h.db, second.id)).filter((f) => f.kind === "booking.attended");
    expect(facts).toHaveLength(2);
    expect(facts[1]).toMatchObject({ dedupeKey: `booking:${second.id}:attended:${second.version + 3}`, data: { is_first_visit: true } });
  });
});

describe("undoCheckIn (R36)", () => {
  it("is allowed until ends_at + closes_minutes_after_end", async () => {
    const inside = await rawBooking(h.db, { sessionId: (await endedSession(90 * MIN)).id, status: "attended", attendedAt: ago(3 * HOUR) });
    expect(await actions.undoCheckIn({ bookingId: inside.id })).toMatchObject({ ok: true, data: { status: "confirmed" } });
    const outside = await rawBooking(h.db, { sessionId: (await endedSession(150 * MIN)).id, status: "attended", attendedAt: ago(4 * HOUR) });
    expect(await actions.undoCheckIn({ bookingId: outside.id })).toMatchObject(conflict("outside_window"));
    expect((await bookingById(h.db, outside.id)).status).toBe("attended");
    const confirmed = await rawBooking(h.db, { sessionId: (await runningSession()).id });
    expect(await actions.undoCheckIn({ bookingId: confirmed.id })).toMatchObject(conflict("invalid_transition"));
  });
});

describe("markNoShow and revertNoShow (R37)", () => {
  it("marks a no-show by hand only after starts_at, keeping the credit by default", async () => {
    const future = await rawBooking(h.db, { sessionId: (await openSession(h.db, { startsAt: ahead(HOUR) })).id, paidWith: "credit" });
    expect(await actions.markNoShow({ bookingId: future.id })).toMatchObject(conflict("outside_window"));
    const started = await rawBooking(h.db, { sessionId: (await runningSession()).id, paidWith: "credit" });
    expect(await actions.markNoShow({ bookingId: started.id })).toMatchObject({ ok: true, data: { status: "no_show" } });
    expect((await bookingById(h.db, started.id)).noShowMarkedAt).toBeInstanceOf(Date);
    expect(releaseCredits).not.toHaveBeenCalled();
    expect((await factsOf(h.db, started.id)).map((f) => f.kind)).toEqual(["booking.no_show"]);
    // A second click is an invalid transition, not a second fact.
    expect(await actions.markNoShow({ bookingId: started.id })).toMatchObject(conflict("invalid_transition"));
  });

  it("releases the credit when no_show.releases_credit is on", async () => {
    await setBookingRules(h.db, { no_show: { ...DEFAULT_BOOKING_RULES.no_show, releases_credit: true } });
    const b = await rawBooking(h.db, { sessionId: (await runningSession()).id, paidWith: "credit" });
    expect(await actions.markNoShow({ bookingId: b.id })).toMatchObject({ ok: true });
    expect(releaseCredits).toHaveBeenCalledWith(expect.anything(), expect.anything(), { ref: { type: "booking", id: b.id }, reason: "no_show_released" });
  });

  it("a no-show whose credit was released is not turned into attended (revert or check-in); a kept credit is", async () => {
    const actual = await vi.importActual<typeof import("@/modules/credits/api")>("@/modules/credits/api");
    const creditRow = async () => {
      const session = await runningSession();
      const person = await makePerson(h.db);
      await makeCreditGrant(h.db, { personId: person.id, units: 3, startsAt: ago(30 * DAY), expiresAt: ahead(60 * DAY) });
      const b = await rawBooking(h.db, { sessionId: session.id, personId: person.id, paidWith: "credit" });
      await inTx(h.db, { kind: "system", jobId: "test" }, (tx, ctx) =>
        actual.consumeCredits(tx, ctx, { personId: person.id, beneficiaryPersonId: person.id, kind: session.creditKind!, units: session.creditCost, ref: { type: "booking", id: b.id }, validAt: session.startsAt }),
      );
      return b;
    };

    const kept = await creditRow();
    expect(await actions.markNoShow({ bookingId: kept.id })).toMatchObject({ ok: true, data: { status: "no_show" } });
    expect(await actions.revertNoShow({ bookingId: kept.id })).toMatchObject({ ok: true, data: { status: "attended" } });

    await setBookingRules(h.db, { no_show: { ...DEFAULT_BOOKING_RULES.no_show, releases_credit: true } });
    vi.mocked(releaseCredits).mockImplementationOnce(actual.releaseCredits);
    const released = await creditRow();
    expect(await actions.markNoShow({ bookingId: released.id })).toMatchObject({ ok: true, data: { status: "no_show" } });
    expect(await actions.revertNoShow({ bookingId: released.id })).toMatchObject(conflict("invalid_transition"));
    expect(await actions.checkIn({ bookingId: released.id })).toMatchObject(conflict("invalid_transition"));
    expect(await bookingById(h.db, released.id)).toMatchObject({ status: "no_show", attendedAt: null });
  });

  it("reverts a no-show to attended within revert_no_show_days", async () => {
    const recent = await rawBooking(h.db, { sessionId: (await endedSession(6 * DAY)).id, status: "no_show", noShowMarkedAt: ago(6 * DAY) });
    expect(await actions.revertNoShow({ bookingId: recent.id })).toMatchObject({ ok: true, data: { status: "attended" } });
    const row = await bookingById(h.db, recent.id);
    expect(row.attendedAt).toBeInstanceOf(Date);
    expect((await factsOf(h.db, recent.id)).map((f) => f.kind)).toEqual(["booking.attended"]);
    const old = await rawBooking(h.db, { sessionId: (await endedSession(8 * DAY)).id, status: "no_show", noShowMarkedAt: ago(8 * DAY) });
    expect(await actions.revertNoShow({ bookingId: old.id })).toMatchObject(conflict("outside_window"));
    const confirmed = await rawBooking(h.db, { sessionId: (await runningSession()).id });
    expect(await actions.revertNoShow({ bookingId: confirmed.id })).toMatchObject(conflict("invalid_transition"));
  });
});

describe("updateBookingNotes", () => {
  it("stores and clears staff notes and bumps the version", async () => {
    const b = await rawBooking(h.db, { sessionId: (await runningSession()).id });
    expect(await actions.updateBookingNotes({ bookingId: b.id, notes: "  Arrives by bike  " })).toMatchObject({ ok: true, data: { id: b.id } });
    expect(await bookingById(h.db, b.id)).toMatchObject({ notes: "Arrives by bike", version: b.version + 1 });
    await actions.updateBookingNotes({ bookingId: b.id, notes: " " });
    expect((await bookingById(h.db, b.id)).notes).toBeNull();
    expect(await actions.updateBookingNotes({ bookingId: "00000000-0000-4000-8000-000000000000", notes: "x" })).toMatchObject({ ok: false, error: { code: "not_found" } });
  });
});
