import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { activityEvents } from "@beam/db/schema";
import { createTestDb } from "@beam/db/testing";
import { DEFAULT_BOOKING_RULES } from "@beam/core/booking";
import { asc, sql } from "@/lib/ctx";
import { resetRuntime, runJobTwice } from "@/lib/testing";
import { HOUR, openSession, setBookingRules } from "../server/booking-p3a.fixtures";
import { bookingById, factsOf, rawBooking } from "../server/booking-p3b.fixtures";
import { EVENT_ENDED_LOOKBACK_MS, eventEndedKey } from "./attendance";

vi.mock("@/modules/credits/api", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  releaseCredits: vi.fn().mockResolvedValue({ releasedUnits: 1 }),
}));

let h: DbHandle;
const MIN = 60_000;

/** A two-hour event (lecture) whose end lies `ms` in the past. */
const endedEvent = (ms: number, over: Parameters<typeof openSession>[1] = {}) =>
  openSession(h.db, { kind: "event", eventCategory: "lecture", creditKind: null, creditCost: 0, capacitySeats: 30, startsAt: new Date(Date.now() - ms - 2 * HOUR), ...over });

const endedFacts = (bookingId: string) => factsOf(h.db, bookingId).then((f) => f.filter((x) => x.kind === "booking.event_ended"));

async function snapshot() {
  return h.db
    .select({ key: activityEvents.dedupeKey })
    .from(activityEvents)
    .where(sql`${activityEvents.kind} like 'booking.%'`)
    .orderBy(asc(activityEvents.dedupeKey));
}

/** Runs `bookings.mark_no_shows` twice and asserts the second run changes nothing. */
async function twice() {
  let afterFirst: unknown;
  const result = await runJobTwice(h.db, "bookings.mark_no_shows", {}, { between: async () => void (afterFirst = await snapshot()) });
  expect(await snapshot()).toEqual(afterFirst);
  return result as { first: { eventsEnded: number }; second: { eventsEnded: number } };
}

beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(async () => {
  await setBookingRules(h.db);
});

describe("bookings.mark_no_shows: booking.event_ended (R39)", () => {
  it("emits one event per booking of an ended event, with the attended flag, and a double run adds nothing", async () => {
    const ev = await endedEvent(3 * HOUR);
    const attended = await rawBooking(h.db, { sessionId: ev.id, status: "attended", attendedAt: new Date(Date.now() - 4 * HOUR) });
    const confirmed = await rawBooking(h.db, { sessionId: ev.id });
    const noShow = await rawBooking(h.db, { sessionId: ev.id, status: "no_show", noShowMarkedAt: new Date(Date.now() - HOUR) });
    const guest = await rawBooking(h.db, { sessionId: ev.id, status: "attended", attendedAt: new Date(Date.now() - 4 * HOUR), paidWith: "guest", guestOfBookingId: attended.id, bookedByPersonId: attended.personId });
    const cancelled = await rawBooking(h.db, { sessionId: ev.id, status: "cancelled", cancelledAt: new Date(), cancelReasonCode: "customer" });

    const { first, second } = await twice();
    expect(first.eventsEnded).toBeGreaterThanOrEqual(4);
    expect(second.eventsEnded).toBe(0);

    // auto_mark is on by default: the still-confirmed row became no_show first.
    expect((await bookingById(h.db, confirmed.id)).status).toBe("no_show");

    for (const [b, flag] of [
      [attended, true],
      [confirmed, false],
      [noShow, false],
      [guest, true],
    ] as const) {
      const facts = await endedFacts(b.id);
      expect(facts).toHaveLength(1);
      expect(facts[0]).toMatchObject({
        dedupeKey: eventEndedKey(b.id),
        personId: b.personId,
        data: { attended: flag, event_category: "lecture", session_kind: "event", session_id: ev.id, by: "system" },
      });
    }
    expect((await endedFacts(guest.id))[0]!.data).toMatchObject({ is_guest: true, guest_of_person_id: attended.personId, owner_person_id: attended.personId });
    expect(await endedFacts(cancelled.id)).toHaveLength(0);
  });

  it("emits with no_show.auto_mark = false and leaves confirmed rows confirmed", async () => {
    await setBookingRules(h.db, { no_show: { ...DEFAULT_BOOKING_RULES.no_show, auto_mark: false } });
    const ev = await endedEvent(3 * HOUR);
    const confirmed = await rawBooking(h.db, { sessionId: ev.id });
    const attended = await rawBooking(h.db, { sessionId: ev.id, status: "attended", attendedAt: new Date(Date.now() - 4 * HOUR) });

    const { first } = await twice();
    expect(first).toMatchObject({ marked: 0, skipped: "auto_mark_off" });
    expect((await bookingById(h.db, confirmed.id)).status).toBe("confirmed");
    expect((await endedFacts(confirmed.id)).map((f) => f.data)).toEqual([expect.objectContaining({ attended: false })]);
    expect((await endedFacts(attended.id)).map((f) => f.data)).toEqual([expect.objectContaining({ attended: true })]);
  });

  it("waits for ends_at + after_end_minutes, skips day sessions, cancelled events and events older than the lookback", async () => {
    const recent = await rawBooking(h.db, { sessionId: (await endedEvent(30 * MIN)).id, status: "attended", attendedAt: new Date(Date.now() - HOUR) });
    const day = await rawBooking(h.db, { sessionId: (await endedEvent(3 * HOUR, { kind: "day", eventCategory: null, creditKind: "day", creditCost: 1 })).id, status: "attended", attendedAt: new Date() });
    const cancelledEvent = await endedEvent(3 * HOUR, { status: "cancelled", cancelledAt: new Date(), cancelReason: "storm" });
    const ofCancelled = await rawBooking(h.db, { sessionId: cancelledEvent.id, status: "attended", attendedAt: new Date() });
    const old = await rawBooking(h.db, { sessionId: (await endedEvent(EVENT_ENDED_LOOKBACK_MS + 3 * HOUR)).id, status: "attended", attendedAt: new Date() });

    await twice();
    for (const b of [recent, day, ofCancelled, old]) expect(await endedFacts(b.id)).toHaveLength(0);
  });

  it("does not emit again after a later status change of the row (dedupe without version)", async () => {
    const ev = await endedEvent(3 * HOUR);
    const b = await rawBooking(h.db, { sessionId: ev.id, status: "no_show", noShowMarkedAt: new Date() });
    await twice();
    // Staff correct the no-show to attended afterwards (version + 1): no second follow-up.
    await h.db.execute(sql`update bookings set status = 'attended', attended_at = now(), version = version + 1 where id = ${b.id}`);
    await twice();
    expect(await endedFacts(b.id)).toHaveLength(1);
  });
});
