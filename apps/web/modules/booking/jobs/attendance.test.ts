import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { activityEvents, bookings, sessions } from "@beam/db/schema";
import { createTestDb } from "@beam/db/testing";
import { DEFAULT_BOOKING_RULES } from "@beam/core/booking";
import { asc, eq, sql } from "@/lib/ctx";
import { loadSchedules } from "@/lib/job-runner";
import { resetRuntime, runJobTwice } from "@/lib/testing";
import { releaseCredits } from "@/modules/credits/api";
import { HOUR, openSession, setBookingRules } from "../server/booking-p3a.fixtures";
import { bookingById, factsOf, rawBooking, unpaidOrderBooking } from "../server/booking-p3b.fixtures";
import { checkInWindow, isInCheckInWindow, revertNoShowUntil } from "./attendance";

vi.mock("@/modules/credits/api", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  releaseCredits: vi.fn().mockResolvedValue({ releasedUnits: 1 }),
}));

let h: DbHandle;
const MIN = 60_000;

/** A two-hour session whose end lies `ms` in the past. */
const endedSession = (ms: number) => openSession(h.db, { startsAt: new Date(Date.now() - ms - 2 * HOUR) });

beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(async () => {
  vi.mocked(releaseCredits).mockClear();
  await setBookingRules(h.db);
});

async function snapshot() {
  return {
    bookings: await h.db.select({ id: bookings.id, status: bookings.status, version: bookings.version }).from(bookings).orderBy(asc(bookings.id)),
    facts: await h.db.select({ key: activityEvents.dedupeKey }).from(activityEvents).where(sql`${activityEvents.kind} like 'booking.%'`).orderBy(asc(activityEvents.dedupeKey)),
  };
}

async function twice() {
  let afterFirst: unknown;
  const result = await runJobTwice(h.db, "bookings.mark_no_shows", {}, { between: async () => void (afterFirst = await snapshot()) });
  expect(await snapshot()).toEqual(afterFirst);
  return result;
}

describe("bookings.mark_no_shows (R37, edge case 20)", () => {
  it("is scheduled every 15 minutes", async () => {
    expect((await loadSchedules()).find((s) => s.kind === "bookings.mark_no_shows")?.cron).toBe("*/15 * * * *");
  });

  it("marks only confirmed rows of sessions past ends_at + after_end_minutes, once, and keeps credits", async () => {
    const ended = await endedSession(3 * HOUR);
    const due = await rawBooking(h.db, { sessionId: ended.id, paidWith: "credit" });
    const attended = await rawBooking(h.db, { sessionId: ended.id, status: "attended", attendedAt: new Date(Date.now() - 4 * HOUR) });
    const cancelled = await rawBooking(h.db, { sessionId: ended.id, status: "cancelled", cancelledAt: new Date(), cancelReasonCode: "customer" });
    const reserved = (await unpaidOrderBooking(h.db, { sessionId: ended.id, reservedUntil: new Date(Date.now() + 10 * MIN) })).booking;
    const recent = await rawBooking(h.db, { sessionId: (await endedSession(60 * MIN)).id });
    const upcoming = await rawBooking(h.db, { sessionId: (await openSession(h.db)).id });

    const { first, second } = await twice();
    expect(first).toMatchObject({ marked: expect.any(Number) });
    expect(second).toMatchObject({ marked: 0 });

    expect(await bookingById(h.db, due.id)).toMatchObject({ status: "no_show", version: due.version + 1, noShowMarkedAt: expect.any(Date) });
    expect((await bookingById(h.db, attended.id)).status).toBe("attended");
    expect((await bookingById(h.db, cancelled.id)).status).toBe("cancelled");
    expect((await bookingById(h.db, reserved.id)).status).toBe("reserved");
    expect((await bookingById(h.db, recent.id)).status).toBe("confirmed");
    expect((await bookingById(h.db, upcoming.id)).status).toBe("confirmed");

    const facts = await factsOf(h.db, due.id);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ kind: "booking.no_show", dedupeKey: `booking:${due.id}:no_show:${due.version + 1}`, data: { by: "system", paid_with: "credit" } });
    expect(releaseCredits).not.toHaveBeenCalled();
  });

  it("follows no_show.after_end_minutes", async () => {
    await setBookingRules(h.db, { no_show: { ...DEFAULT_BOOKING_RULES.no_show, after_end_minutes: 30 } });
    const b = await rawBooking(h.db, { sessionId: (await endedSession(60 * MIN)).id });
    await twice();
    expect((await bookingById(h.db, b.id)).status).toBe("no_show");
  });

  it("respects no_show.auto_mark = false", async () => {
    await setBookingRules(h.db, { no_show: { ...DEFAULT_BOOKING_RULES.no_show, auto_mark: false } });
    const b = await rawBooking(h.db, { sessionId: (await endedSession(5 * HOUR)).id });
    const { first } = await twice();
    expect(first).toMatchObject({ marked: 0, skipped: "auto_mark_off" });
    expect((await bookingById(h.db, b.id)).status).toBe("confirmed");
    expect(await factsOf(h.db, b.id)).toHaveLength(0);
  });

  it("releases credits with no_show_released only when no_show.releases_credit is on", async () => {
    await setBookingRules(h.db, { no_show: { ...DEFAULT_BOOKING_RULES.no_show, releases_credit: true } });
    const credit = await rawBooking(h.db, { sessionId: (await endedSession(3 * HOUR)).id, paidWith: "credit" });
    const free = await rawBooking(h.db, { sessionId: (await endedSession(3 * HOUR)).id, paidWith: "free" });
    await twice();
    expect((await bookingById(h.db, credit.id)).status).toBe("no_show");
    expect((await bookingById(h.db, free.id)).status).toBe("no_show");
    const calls = vi.mocked(releaseCredits).mock.calls.map((c) => c[2]);
    expect(calls).toEqual([{ ref: { type: "booking", id: credit.id }, reason: "no_show_released" }]);
  });

  it("leaves rows of cancelled sessions alone", async () => {
    const s = await endedSession(3 * HOUR);
    const b = await rawBooking(h.db, { sessionId: s.id });
    // A cancelled session whose chunked cancellation (sessions.cancel_bookings) has not reached this row yet.
    await h.db.update(sessions).set({ status: "cancelled", cancelledAt: new Date(), cancelReason: "storm" }).where(eq(sessions.id, s.id));
    await twice();
    expect((await bookingById(h.db, b.id)).status).toBe("confirmed");
  });
});

describe("attendance windows (R35-R37)", () => {
  it("derives the check-in and revert windows from settings.booking_rules.check_in", () => {
    const startsAt = new Date("2026-11-04T09:00:00Z");
    const endsAt = new Date("2026-11-04T11:00:00Z");
    const w = checkInWindow({ startsAt, endsAt }, DEFAULT_BOOKING_RULES);
    expect(w).toEqual({ opensAt: new Date("2026-11-04T07:00:00Z"), closesAt: new Date("2026-11-04T13:00:00Z") });
    expect(isInCheckInWindow({ startsAt, endsAt }, DEFAULT_BOOKING_RULES, new Date("2026-11-04T06:59:59Z"))).toBe(false);
    expect(isInCheckInWindow({ startsAt, endsAt }, DEFAULT_BOOKING_RULES, new Date("2026-11-04T13:00:00Z"))).toBe(true);
    expect(revertNoShowUntil({ startsAt, endsAt }, DEFAULT_BOOKING_RULES)).toEqual(new Date("2026-11-11T11:00:00Z"));
  });
});
