import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { bookings, emailMessages, jobs, sessions, waitlistEntries } from "@beam/db/schema";
import { createTestDb } from "@beam/db/testing";
import { and, asc, eq, inArray, sql } from "@/lib/ctx";
import { loadSchedules } from "@/lib/job-runner";
import { resetRuntime, runJobTwice } from "@/lib/testing";
import { cancelOrder, refundOrderLine } from "@/modules/commerce/api";
import { DAY, HOUR, openSession, setBookingRules } from "../server/booking-p3a.fixtures";
import { emailByKey, rawBooking, unpaidOrderBooking, waitEntry } from "../server/booking-p3b.fixtures";

vi.mock("@/modules/commerce/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), refundOrderLine: vi.fn(), cancelOrder: vi.fn() }));

let h: DbHandle;

beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(async () => {
  vi.mocked(refundOrderLine).mockReset().mockResolvedValue({ refundId: null, amountCents: 0 });
  vi.mocked(cancelOrder).mockReset().mockResolvedValue({ cancelled: true });
  await setBookingRules(h.db);
});

/** Booking rows, waitlist entries, booking emails and booking jobs: the state a double run must leave unchanged. */
async function snapshot() {
  return {
    bookings: await h.db.select({ id: bookings.id, status: bookings.status, version: bookings.version, code: bookings.cancelReasonCode }).from(bookings).orderBy(asc(bookings.id)),
    entries: await h.db.select({ id: waitlistEntries.id, state: waitlistEntries.state }).from(waitlistEntries).orderBy(asc(waitlistEntries.id)),
    emails: await h.db.select({ key: emailMessages.idempotencyKey }).from(emailMessages).orderBy(asc(emailMessages.idempotencyKey)),
    jobs: await h.db
      .select({ key: jobs.idempotencyKey })
      .from(jobs)
      .where(inArray(jobs.kind, ["waitlist.offer_next", "sessions.cancel_bookings", "email.send"]))
      .orderBy(asc(jobs.idempotencyKey)),
  };
}

async function twice(kind: Parameters<typeof runJobTwice>[1], payload: unknown) {
  let afterFirst: unknown;
  const result = await runJobTwice(h.db, kind, payload, { between: async () => void (afterFirst = await snapshot()) });
  expect(await snapshot()).toEqual(afterFirst);
  return result;
}

const row = async (id: string) => (await h.db.select().from(bookings).where(eq(bookings.id, id)))[0]!;

describe("booking schedules", () => {
  it("expire_reservations runs every minute and send_reminders every 15 minutes", async () => {
    const all = await loadSchedules();
    expect(all.find((s) => s.kind === "bookings.expire_reservations")?.cron).toBe("* * * * *");
    expect(all.find((s) => s.kind === "bookings.send_reminders")?.cron).toBe("*/15 * * * *");
  });
});

describe("bookings.expire_reservations (R18 safety net, R44, edge case 27)", () => {
  it("cancels lapsed unpaid reservations once: payment_expired, email, claimed offer expired, waitlist.offer_next", async () => {
    const session = await openSession(h.db);
    const lapsed = await unpaidOrderBooking(h.db, { sessionId: session.id, reservedUntil: new Date(Date.now() - 5 * 60_000) });
    const live = await unpaidOrderBooking(h.db, { sessionId: session.id, reservedUntil: new Date(Date.now() + 20 * 60_000) });
    const paid = await unpaidOrderBooking(h.db, { sessionId: session.id, reservedUntil: new Date(Date.now() - 5 * 60_000), orderStatus: "paid" });
    const claim = await waitEntry(h.db, { sessionId: session.id, personId: lapsed.booking.personId, state: "offered", bookingId: lapsed.booking.id });

    await twice("bookings.expire_reservations", {});
    expect(await row(lapsed.booking.id)).toMatchObject({ status: "cancelled", cancelReasonCode: "payment_expired", version: 2 });
    expect((await row(live.booking.id)).status).toBe("reserved");
    expect((await row(paid.booking.id)).status).toBe("reserved");
    expect(await emailByKey(h.db, `booking:${lapsed.booking.id}:cancelled`)).toMatchObject({ props: { reason: "payment_expired" } });
    const [entry] = await h.db.select().from(waitlistEntries).where(eq(waitlistEntries.id, claim.id));
    expect(entry).toMatchObject({ state: "expired", endedReason: "payment_not_completed" });
    const offer = await h.db.select().from(jobs).where(eq(jobs.idempotencyKey, `waitlist:${session.id}:offer_next:${lapsed.booking.id}`));
    expect(offer).toHaveLength(1);
  });

  it("pay-at-desk rows hold the seat until the session's ends_at, then expire", async () => {
    const upcoming = await openSession(h.db);
    const holding = await unpaidOrderBooking(h.db, { sessionId: upcoming.id, reservedUntil: upcoming.endsAt, isPayAtDesk: true });
    const ended = await openSession(h.db, { startsAt: new Date(Date.now() - 3 * HOUR) });
    expect(ended.endsAt.getTime()).toBeLessThan(Date.now());
    const noShow = await unpaidOrderBooking(h.db, { sessionId: ended.id, reservedUntil: ended.endsAt, isPayAtDesk: true });

    await twice("bookings.expire_reservations", {});
    expect((await row(holding.booking.id)).status).toBe("reserved");
    // Edge case 27: never paid, so `cancelled` with `payment_expired`, not `no_show`.
    expect(await row(noShow.booking.id)).toMatchObject({ status: "cancelled", cancelReasonCode: "payment_expired" });
  });
});

describe("bookings.send_reminders (R60)", () => {
  it("sends one reminder per offset with the inline QR, respects the late-entry skip and sends no event reminders by default", async () => {
    const day = await openSession(h.db, { startsAt: new Date(Date.now() + 20 * HOUR) });
    const early = await rawBooking(h.db, { sessionId: day.id, createdAt: new Date(Date.now() - 2 * DAY) });
    const late = await rawBooking(h.db, { sessionId: day.id, createdAt: new Date(Date.now() - HOUR) });
    const cancelled = await rawBooking(h.db, { sessionId: day.id, status: "cancelled", cancelledAt: new Date(), cancelReasonCode: "customer", createdAt: new Date(Date.now() - 2 * DAY) });
    const night = await openSession(h.db, { kind: "night", startsAt: new Date(Date.now() + 40 * HOUR) });
    const nightRow = await rawBooking(h.db, { sessionId: night.id, createdAt: new Date(Date.now() - 4 * DAY) });
    const farDay = await openSession(h.db, { startsAt: new Date(Date.now() + 30 * HOUR) });
    const notDue = await rawBooking(h.db, { sessionId: farDay.id, createdAt: new Date(Date.now() - 4 * DAY) });
    const event = await openSession(h.db, { kind: "event", creditKind: null, startsAt: new Date(Date.now() + 20 * HOUR) });
    const eventRow = await rawBooking(h.db, { sessionId: event.id, createdAt: new Date(Date.now() - 4 * DAY) });

    await twice("bookings.send_reminders", {});
    const dayMail = await emailByKey(h.db, `booking:${early.id}:reminder:24`);
    const earlyRow = await row(early.id);
    expect(dayMail).toMatchObject({ props: { kind: "day" }, attachments: [{ fileId: earlyRow.qrFileId, filename: "checkin-qr.png", inline: true }] });
    expect(earlyRow.reminderSentAt).not.toBeNull();
    expect(earlyRow.version).toBe(early.version);
    expect(await emailByKey(h.db, `booking:${nightRow.id}:reminder:48`)).toMatchObject({ props: { kind: "night" } });
    for (const b of [late, cancelled, notDue, eventRow]) {
      const mails = await h.db.select().from(emailMessages).where(sql`${emailMessages.idempotencyKey} like ${`booking:${b.id}:reminder:%`}`);
      expect(mails, b.id).toHaveLength(0);
    }
  });

  it("every configured offset is its own key", async () => {
    await setBookingRules(h.db, { reminder_hours_before: { day: [24, 2], night: [48], event: [] } });
    const soon = await openSession(h.db, { startsAt: new Date(Date.now() + 90 * 60_000) });
    const b = await rawBooking(h.db, { sessionId: soon.id, createdAt: new Date(Date.now() - 3 * DAY) });
    await twice("bookings.send_reminders", {});
    expect(await emailByKey(h.db, `booking:${b.id}:reminder:24`)).toBeDefined();
    expect(await emailByKey(h.db, `booking:${b.id}:reminder:2`)).toBeDefined();
  });
});

describe("sessions.cancel_bookings (R33)", () => {
  it("cancels one chunk of 50 per run, continues after the last id and repeats harmlessly", async () => {
    const session = await openSession(h.db, { creditKind: null, creditCost: 0, capacitySeats: 80 });
    for (let i = 0; i < 55; i++) await rawBooking(h.db, { sessionId: session.id });
    await h.db.update(sessions).set({ status: "cancelled", cancelledAt: new Date(), cancelReason: "storm" }).where(eq(sessions.id, session.id));

    const first = await twice("sessions.cancel_bookings", { sessionId: session.id, notify: false });
    const firstNext = (first.first as { next: string | null }).next;
    expect(first.first).toMatchObject({ cancelledBookings: 50 });
    expect(first.second).toMatchObject({ cancelledBookings: 0, next: firstNext });
    const continuation = await h.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.kind, "sessions.cancel_bookings"), eq(jobs.idempotencyKey, `cancel_session:${session.id}:${firstNext}`)));
    expect(continuation).toHaveLength(1);
    expect(continuation[0]!.payload).toMatchObject({ sessionId: session.id, afterBookingId: firstNext, notify: false });

    const second = await twice("sessions.cancel_bookings", continuation[0]!.payload);
    expect(second.first).toMatchObject({ cancelledBookings: 5, next: null });
    const left = await h.db.select().from(bookings).where(and(eq(bookings.sessionId, session.id), eq(bookings.status, "confirmed")));
    expect(left).toHaveLength(0);
  });

  it("refuses a session that is not cancelled (permanent)", async () => {
    const session = await openSession(h.db);
    await expect(runJobTwice(h.db, "sessions.cancel_bookings", { sessionId: session.id })).rejects.toThrow(/not cancelled/);
  });
});
