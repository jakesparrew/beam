import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "@beam/db";
import { bookings, waitlistEntries } from "@beam/db/schema";
import { createTestDb, makePerson, makeSession } from "@beam/db/testing";
import { claimToken, hashToken } from "@beam/core/booking";
import { eq } from "@/lib/ctx";
import { makeJobCtx, resetRuntime, runJobTwice } from "@/lib/testing";
import { setBookingRules } from "../server/booking-p3a.fixtures";
import { rawBooking } from "../server/booking-p3b.fixtures";
import { DAY, HOUR, MIN, emailByKey, entriesOf, entry, entryById, entryFacts, fullSession, offerNextJobs, offeredEntry, walkIn } from "../server/booking-p5.fixtures";
import { claimKey } from "../server/claim";
import { runExpireOffers, runOfferNext } from "./waitlist";

let h: DbHandle;

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

const offerNext = (sessionId: string, now?: Date) => runOfferNext(makeJobCtx(h.db, "waitlist.offer_next", now ? { now } : {}), { sessionId });
const expireOffers = (now?: Date) => runExpireOffers(makeJobCtx(h.db, "waitlist.expire_offers", now ? { now } : {}), {});
const freeSeat = (bookingId: string) => h.db.update(bookings).set({ status: "cancelled", cancelledAt: new Date(), cancelReasonCode: "customer" }).where(eq(bookings.id, bookingId));
const joined = (minutesAgo: number) => new Date(Date.now() - minutesAgo * MIN);

describe("waitlist.offer_next (R42, R43)", () => {
  it("offers the freed seat to the first eligible entry: token hash, expiry, fact and seat_offered email", async () => {
    const { session, bookingIds } = await fullSession(h.db, { seats: 2 });
    const a = await entry(h.db, session.id, { joinedAt: joined(30) });
    const b = await entry(h.db, session.id, { joinedAt: joined(20) });
    await freeSeat(bookingIds[0]!);
    const before = Date.now();
    const result = await offerNext(session.id);
    expect(result.offered).toEqual([a.id]);

    const offered = await entryById(h.db, a.id);
    expect(offered).toMatchObject({ state: "offered", offersCount: 1, bookingId: null });
    const token = claimToken(claimKey(), a.id, 1);
    expect(offered.claimTokenHash).toBe(hashToken(token));
    const expected = before + session.claimWindowMinutes * MIN;
    expect(Math.abs(offered.offerExpiresAt!.getTime() - expected)).toBeLessThan(10_000);
    expect((await entryById(h.db, b.id)).state).toBe("waiting");

    const facts = await entryFacts(h.db, a.id);
    expect(facts.map((f) => f.kind)).toEqual(["waitlist.offered"]);
    expect(facts[0]!.dedupeKey).toBe(`waitlist:${a.id}:offered:1:0`);
    expect(facts[0]!.data).toMatchObject({ session_id: session.id, offers_count: 1 });
    const email = await emailByKey(h.db, `waitlist:${a.id}:offer:1`);
    expect(email).toBeDefined();
    expect(JSON.stringify(email)).toContain(`/api/public/claim/${token}`);
  });

  it("makes no offer when the cut-off before start leaves less than min_claim_minutes", async () => {
    const { session, bookingIds } = await fullSession(h.db, { startsIn: 70 * MIN });
    const a = await entry(h.db, session.id);
    await freeSeat(bookingIds[0]!);
    expect(await offerNext(session.id)).toMatchObject({ offered: [], skipped: "cutoff" });
    expect((await entryById(h.db, a.id)).state).toBe("waiting");
  });

  it("caps the expiry at start minus offer_cutoff_minutes_before_start", async () => {
    const { session, bookingIds } = await fullSession(h.db, { startsIn: 100 * MIN });
    const a = await entry(h.db, session.id);
    await freeSeat(bookingIds[0]!);
    await offerNext(session.id);
    const e = await entryById(h.db, a.id);
    expect(e.state).toBe("offered");
    expect(e.offerExpiresAt!.getTime()).toBe(session.startsAt.getTime() - 60 * MIN);
  });

  it("skips flagged entries and people who reached max_offers_per_person_per_session", async () => {
    const { session, bookingIds } = await fullSession(h.db, { seats: 1 });
    const flagged = await entry(h.db, session.id, { joinedAt: joined(40), isFlaggedDuplicate: true, flagReason: "same_phone:x" });
    const maxed = await entry(h.db, session.id, { joinedAt: joined(30), offersCount: 2, rejoinCount: 1 });
    const next = await entry(h.db, session.id, { joinedAt: joined(20) });
    await freeSeat(bookingIds[0]!);
    expect((await offerNext(session.id)).offered).toEqual([next.id]);
    expect((await entryById(h.db, flagged.id)).state).toBe("waiting");
    expect((await entryById(h.db, maxed.id)).state).toBe("waiting");
  });

  it("offers a walk-in without an email on screen only (no message, the offer still expires)", async () => {
    const { session, bookingIds } = await fullSession(h.db);
    const person = await walkIn(h.db);
    const e = await entry(h.db, session.id, { personId: person.id });
    await freeSeat(bookingIds[0]!);
    const result = await offerNext(session.id);
    expect(result).toMatchObject({ offered: [e.id], onScreenOnly: [e.id] });
    expect(await emailByKey(h.db, `waitlist:${e.id}:offer:1`)).toBeUndefined();
    expect((await entryById(h.db, e.id)).offerExpiresAt).not.toBeNull();
  });

  it("offers nothing while the session is full (live offers count against capacity)", async () => {
    const { session } = await fullSession(h.db, { seats: 2 });
    await entry(h.db, session.id);
    expect(await offerNext(session.id)).toMatchObject({ offered: [], skipped: "no_capacity" });
  });

  it("runs twice with the same payload and yields the same state", async () => {
    const { session, bookingIds } = await fullSession(h.db, { seats: 2 });
    await entry(h.db, session.id, { joinedAt: joined(30) });
    await entry(h.db, session.id, { joinedAt: joined(20) });
    await entry(h.db, session.id, { joinedAt: joined(10) });
    await freeSeat(bookingIds[0]!);
    let afterFirst: unknown;
    const { first, second } = await runJobTwice(h.db, "waitlist.offer_next", { sessionId: session.id }, {
      between: async () => {
        afterFirst = await entriesOf(h.db, session.id);
      },
    });
    expect((first as { offered: string[] }).offered).toHaveLength(1);
    expect((second as { offered: string[] }).offered).toEqual([]);
    expect(await entriesOf(h.db, session.id)).toEqual(afterFirst);
  });
});

describe("waitlist.expire_offers (R44, R45, R47, edge case 23)", () => {
  it("expires an unclaimed offer after its claim window and passes the seat to the next entry", async () => {
    const { session } = await fullSession(h.db, { seats: 1 });
    // The seat is held by A's live offer; B waits.
    await h.db.update(bookings).set({ status: "cancelled", cancelledAt: new Date(), cancelReasonCode: "customer" }).where(eq(bookings.sessionId, session.id));
    const { entry: a } = await offeredEntry(h.db, session.id, { joinedAt: joined(60), offerExpiresAt: new Date(Date.now() - MIN) });
    const b = await entry(h.db, session.id, { joinedAt: joined(30) });

    const result = await expireOffers();
    expect(result.expired).toBe(1);
    const expired = await entryById(h.db, a.id);
    expect(expired).toMatchObject({ state: "expired", endedReason: "offer_timeout" });
    expect(await emailByKey(h.db, `waitlist:${a.id}:expired:1`)).toBeDefined();
    expect((await entryFacts(h.db, a.id)).map((f) => f.kind)).toContain("waitlist.expired");
    expect((await offerNextJobs(h.db, session.id)).map((j) => j.idempotencyKey)).toContain(`waitlist:${session.id}:offer_next:${a.id}:1`);

    await offerNext(session.id);
    expect((await entryById(h.db, b.id)).state).toBe("offered");
  });

  it("releases waiting and offered entries when the session starts (session_started)", async () => {
    const session = await makeSession(h.db, { startsAt: new Date(Date.now() - 10 * MIN), publishedAt: new Date(Date.now() - DAY) });
    const w = await entry(h.db, session.id);
    const { entry: o } = await offeredEntry(h.db, session.id);
    await expireOffers();
    expect(await entryById(h.db, w.id)).toMatchObject({ state: "released", endedReason: "session_started" });
    expect(await entryById(h.db, o.id)).toMatchObject({ state: "released", endedReason: "session_started" });
    expect(await offerNextJobs(h.db, session.id)).toHaveLength(0);
  });

  it("expires a claimed offer whose reserved booking lapsed (payment_not_completed, R44)", async () => {
    const { session } = await fullSession(h.db, { seats: 1 });
    const person = await makePerson(h.db);
    const lapsed = await rawBooking(h.db, { sessionId: session.id, personId: person.id, status: "cancelled", cancelledAt: new Date(), cancelReasonCode: "payment_expired" });
    const { entry: claimed } = await offeredEntry(h.db, session.id, { personId: person.id, bookingId: lapsed.id });
    const result = await expireOffers();
    expect(result.unpaid).toBe(1);
    expect(await entryById(h.db, claimed.id)).toMatchObject({ state: "expired", endedReason: "payment_not_completed" });
  });

  it("re-enqueues offer_next for a session with free places and waiting entries but no pending job", async () => {
    const { session, bookingIds } = await fullSession(h.db, { seats: 1 });
    await entry(h.db, session.id);
    await freeSeat(bookingIds[0]!);
    const now = new Date();
    const first = await expireOffers(now);
    expect(first.reEnqueued).toContain(session.id);
    const keys = (await offerNextJobs(h.db, session.id)).map((j) => j.idempotencyKey);
    expect(keys).toEqual([`waitlist:${session.id}:offer_next:${now.toISOString().slice(0, 16)}`]);
    // A pending job exists now: the next minute adds none.
    const second = await expireOffers(new Date(now.getTime() + MIN));
    expect(second.reEnqueued).not.toContain(session.id);
    expect(await offerNextJobs(h.db, session.id)).toHaveLength(1);
  });

  it("runs twice with the same payload and yields the same state", async () => {
    const { session } = await fullSession(h.db, { seats: 1 });
    await h.db.update(bookings).set({ status: "cancelled", cancelledAt: new Date(), cancelReasonCode: "customer" }).where(eq(bookings.sessionId, session.id));
    await offeredEntry(h.db, session.id, { joinedAt: joined(60), offerExpiresAt: new Date(Date.now() - MIN) });
    await entry(h.db, session.id, { joinedAt: joined(30) });
    let afterFirst: unknown;
    let jobsAfterFirst = 0;
    await runJobTwice(h.db, "waitlist.expire_offers", {}, {
      between: async () => {
        afterFirst = await entriesOf(h.db, session.id);
        jobsAfterFirst = (await offerNextJobs(h.db, session.id)).length;
      },
    });
    expect(await entriesOf(h.db, session.id)).toEqual(afterFirst);
    expect(await offerNextJobs(h.db, session.id)).toHaveLength(jobsAfterFirst);
  });
});

describe("confirmed entries are protected (R41, edge case 13)", () => {
  it("no job touches a confirmed entry, even past its offer expiry or after the start", async () => {
    const { session } = await fullSession(h.db, { seats: 1, startsIn: 3 * HOUR });
    const person = await makePerson(h.db);
    const booking = await rawBooking(h.db, { sessionId: session.id, personId: person.id, source: "waitlist" });
    const { entry: seat } = await offeredEntry(h.db, session.id, { personId: person.id, bookingId: booking.id, offerExpiresAt: new Date(Date.now() - HOUR) });
    await h.db.update(waitlistEntries).set({ state: "confirmed" }).where(eq(waitlistEntries.id, seat.id));
    const before = await entryById(h.db, seat.id);

    await expireOffers();
    await offerNext(session.id);
    await expireOffers(new Date(Date.now() + 4 * HOUR));
    await offerNext(session.id, new Date(Date.now() + 4 * HOUR));
    expect(await entryById(h.db, seat.id)).toEqual(before);
    expect((await h.db.select().from(bookings).where(eq(bookings.id, booking.id)))[0]!.status).toBe("confirmed");
  });
});
