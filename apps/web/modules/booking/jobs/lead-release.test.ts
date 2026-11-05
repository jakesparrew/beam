import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "@beam/db";
import { emailMessages, jobs, sessions } from "@beam/db/schema";
import { createTestDb, makePerson, type SessionRow } from "@beam/db/testing";
import { makePaidOrder } from "@beam/db/testing/commerce-factories";
import { and, eq, sql } from "@/lib/ctx";
import { makeJobCtx, resetRuntime } from "@/lib/testing";
import { openSession, setBookingRules } from "../server/booking-p3a.fixtures";
import { rawBooking } from "../server/booking-p3b.fixtures";
import { DAY, HOUR, MIN, entry, entryById, entryFacts, offerNextJobs, offeredEntry } from "../server/booking-p5.fixtures";
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

const offerNext = (sessionId: string, trigger?: string) => runOfferNext(makeJobCtx(h.db, "waitlist.offer_next"), { sessionId, ...(trigger ? { trigger } : {}) });
const expireOffers = () => runExpireOffers(makeJobCtx(h.db, "waitlist.expire_offers"), {});
const joined = (minutesAgo: number) => new Date(Date.now() - minutesAgo * MIN);
/** The template of the message with idempotency key `key` (from its `email.send` job). */
async function templateOf(key: string): Promise<string | undefined> {
  const [m] = await h.db.select({ id: emailMessages.id }).from(emailMessages).where(eq(emailMessages.idempotencyKey, key));
  if (!m) return undefined;
  const [j] = await h.db
    .select({ template: sql<string>`${jobs.payload}->>'template'` })
    .from(jobs)
    .where(and(eq(jobs.kind, "email.send"), sql`${jobs.payload}->>'emailMessageId' = ${m.id}`));
  return j?.template;
}
const state = async (ids: string[]) => Promise.all(ids.map(async (id) => ({ ...(await entryById(h.db, id)), updatedAt: null })));

/**
 * A Lead Magnet event in three days: 4 seats, 2 reserved for leads, both general seats booked
 * (customers wait in the customer queue), lead window open until `windowEndIn` from now.
 */
async function leadEvent(rule: SessionRow["leadReleaseRule"] = "customers_then_public"): Promise<SessionRow> {
  const session = await openSession(h.db, {
    kind: "event",
    eventCategory: "lecture",
    creditKind: null,
    creditCost: 0,
    capacitySeats: 4,
    startsAt: new Date(Date.now() + 3 * DAY),
    isLeadMagnet: true,
    leadReservedSeats: 2,
    leadWindowStartAt: new Date(Date.now() - 2 * DAY),
    leadWindowEndAt: new Date(Date.now() + DAY),
    leadReleaseRule: rule,
  });
  await rawBooking(h.db, { sessionId: session.id });
  await rawBooking(h.db, { sessionId: session.id });
  return session;
}

/** Moves the session's window end (and public release) to the past, as time passing would. */
const endWindow = (s: SessionRow, publicReleaseAt: Date | null) =>
  h.db.update(sessions).set({ leadWindowEndAt: new Date(Date.now() - MIN), publicReleaseAt }).where(eq(sessions.id, s.id));
const openToPublic = (s: SessionRow) => h.db.update(sessions).set({ publicReleaseAt: new Date(Date.now() - 30_000) }).where(eq(sessions.id, s.id));

describe("lead window release (R24, R24b, R25)", () => {
  it("customers_then_public: window end offers to the customer queue with booking.lead_window_open, then the rest at opens_for_public_at", async () => {
    const s = await leadEvent();
    // The public entry joined first, then a lead, then a customer: order is by queue first.
    const pub = await entry(h.db, s.id, { queue: "public", joinedAt: joined(90) });
    const ld = await entry(h.db, s.id, { queue: "lead", joinedAt: joined(60) });
    const cust = await entry(h.db, s.id, { queue: "customer", joinedAt: joined(30) });

    await endWindow(s, new Date(Date.now() + 5 * HOUR));
    const first = await expireOffers();
    expect(first.leadReleases).toContain(s.id);
    await expireOffers();
    const jobs = (await offerNextJobs(h.db, s.id)).filter((j) => j.idempotencyKey === `waitlist:${s.id}:offer_next:release:customer_release`);
    expect(jobs).toHaveLength(1);

    const released = await offerNext(s.id, "release:customer_release");
    expect(released.offered).toEqual([cust.id]);
    expect(await templateOf(`waitlist:${cust.id}:offer:1`)).toBe("booking.lead_window_open");
    expect((await entryById(h.db, ld.id)).state).toBe("waiting");
    expect((await entryById(h.db, pub.id)).state).toBe("waiting");
    // Double run: the second seat stays directly bookable by customers; nothing more is offered.
    const before = await state([cust.id, ld.id, pub.id]);
    expect((await offerNext(s.id, "release:customer_release")).offered).toEqual([]);
    expect(await state([cust.id, ld.id, pub.id])).toEqual(before);

    await openToPublic(s);
    await expireOffers();
    expect((await offerNextJobs(h.db, s.id)).some((j) => j.idempotencyKey === `waitlist:${s.id}:offer_next:release:public`)).toBe(true);
    const pubRun = await offerNext(s.id, "release:public");
    // R25: customer, then lead, then public queue; one seat is left after the customer's live offer.
    expect(pubRun.offered).toEqual([ld.id]);
    expect(await templateOf(`waitlist:${ld.id}:offer:1`)).toBe("booking.seat_offered");
    expect((await entryById(h.db, pub.id)).state).toBe("waiting");
    const after = await state([cust.id, ld.id, pub.id]);
    expect((await offerNext(s.id, "release:public")).offered).toEqual([]);
    expect(await state([cust.id, ld.id, pub.id])).toEqual(after);
  });

  it("public: window end opens the reserved seats to every queue at once (customer, lead, public)", async () => {
    const s = await leadEvent("public");
    const pub = await entry(h.db, s.id, { queue: "public", joinedAt: joined(90) });
    const ld = await entry(h.db, s.id, { queue: "lead", joinedAt: joined(60) });
    const cust = await entry(h.db, s.id, { queue: "customer", joinedAt: joined(30) });
    await endWindow(s, null);
    await expireOffers();
    expect((await offerNextJobs(h.db, s.id)).some((j) => j.idempotencyKey === `waitlist:${s.id}:offer_next:release:public`)).toBe(true);
    const run = await offerNext(s.id, "release:public");
    expect(run.offered).toEqual([cust.id, ld.id]);
    expect(await templateOf(`waitlist:${cust.id}:offer:1`)).toBe("booking.lead_window_open");
    expect((await entryById(h.db, pub.id)).state).toBe("waiting");
    expect((await offerNext(s.id, "release:public")).offered).toEqual([]);
  });

  it("keep_for_leads: reserved seats stay lead-only after the window; customers get nothing", async () => {
    const s = await leadEvent("keep_for_leads");
    const cust = await entry(h.db, s.id, { queue: "customer", joinedAt: joined(90) });
    const ld = await entry(h.db, s.id, { queue: "lead", joinedAt: joined(30) });
    await endWindow(s, null);
    await expireOffers();
    const run = await offerNext(s.id, "release:public");
    expect(run.offered).toEqual([ld.id]);
    expect(await templateOf(`waitlist:${ld.id}:offer:1`)).toBe("booking.seat_offered");
    expect((await entryById(h.db, cust.id)).state).toBe("waiting");
    expect((await offerNext(s.id, "release:public")).offered).toEqual([]);
  });

  it("enqueues no release run during the lead window", async () => {
    const s = await leadEvent();
    await entry(h.db, s.id, { queue: "customer" });
    expect((await expireOffers()).leadReleases).not.toContain(s.id);
    expect((await offerNextJobs(h.db, s.id)).filter((j) => j.idempotencyKey?.includes(":release:"))).toHaveLength(0);
  });
});

describe("lead requeue (R26, edge case 14)", () => {
  it("a waiting lead who buys moves to the customer queue keeping joined_at; offered and confirmed leads stay; double run is a no-op", async () => {
    const s = await leadEvent();
    const buyer = await makePerson(h.db);
    const waiting = await entry(h.db, s.id, { personId: buyer.id, queue: "lead", joinedAt: joined(45) });
    const offeredBuyer = await makePerson(h.db);
    const { entry: offered } = await offeredEntry(h.db, s.id, { personId: offeredBuyer.id, queue: "lead" });
    const confirmedBuyer = await makePerson(h.db);
    const booking = await rawBooking(h.db, { sessionId: s.id, personId: confirmedBuyer.id, usedLeadSeat: true });
    const confirmed = await entry(h.db, s.id, { personId: confirmedBuyer.id, queue: "lead", state: "confirmed", bookingId: booking.id });
    const stillLead = await entry(h.db, s.id, { queue: "lead", joinedAt: joined(20) });
    for (const p of [buyer, offeredBuyer, confirmedBuyer]) {
      await makePaidOrder(h.db, { personId: p.id, lines: [{ productKind: "package", unitAmountCents: 9_000 }] });
    }

    const run = await expireOffers();
    expect(run.requeued).toBeGreaterThanOrEqual(1);
    const moved = await entryById(h.db, waiting.id);
    expect(moved).toMatchObject({ queue: "customer", state: "waiting" });
    expect(moved.joinedAt.toISOString()).toBe(waiting.joinedAt.toISOString());
    const facts = await entryFacts(h.db, waiting.id);
    expect(facts.map((f) => f.kind)).toEqual(["waitlist.requeued"]);
    expect(facts[0]!.data).toMatchObject({ from: "lead", to: "customer", reason: "status_changed", queue: "customer" });

    expect(await entryById(h.db, offered.id)).toMatchObject({ queue: "lead", state: "offered" });
    expect(await entryById(h.db, confirmed.id)).toMatchObject({ queue: "lead", state: "confirmed", bookingId: booking.id });
    expect(await entryById(h.db, stillLead.id)).toMatchObject({ queue: "lead", state: "waiting" });

    const before = await state([waiting.id, offered.id, confirmed.id, stillLead.id]);
    await expireOffers();
    expect(await state([waiting.id, offered.id, confirmed.id, stillLead.id])).toEqual(before);
    expect(await entryFacts(h.db, waiting.id)).toHaveLength(1);
  });

  it("a staff status override to customer also moves the entry; a customer corrected back to lead never moves back", async () => {
    const s = await leadEvent();
    const p = await makePerson(h.db, { statusOverride: "customer", statusOverrideReason: "staff correction" });
    const e = await entry(h.db, s.id, { personId: p.id, queue: "lead" });
    await expireOffers();
    expect((await entryById(h.db, e.id)).queue).toBe("customer");

    const back = await makePerson(h.db, { statusOverride: "lead", statusOverrideReason: "staff correction" });
    await makePaidOrder(h.db, { personId: back.id, lines: [{ productKind: "package", unitAmountCents: 9_000 }] });
    const c = await entry(h.db, s.id, { personId: back.id, queue: "customer" });
    await expireOffers();
    expect((await entryById(h.db, c.id)).queue).toBe("customer");
  });
});
