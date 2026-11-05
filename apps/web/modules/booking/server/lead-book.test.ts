import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { activityEvents, bookings, persons, vSessionAvailability, waitlistEntries } from "@beam/db/schema";
import { createTestDb, makePerson } from "@beam/db/testing";
import { isBookingConflict } from "@beam/core/booking";
import { and, asc, createCtx, eq, flushDurableWrites, type Actor, type Ctx } from "@/lib/ctx";
import { resetRuntime } from "@/lib/testing";
import { getMembershipForPerson } from "@/modules/credits/api";
import { hasValidSubmission } from "@/modules/forms/api";
import { getCurrentLegalVersion, hasAcceptedCurrentTerms } from "@/modules/site/api";
import { availabilityFor, bookSeats, type BookSeatsInput } from "./book";
import { DAY, HOUR, customerActor, inTx, openSession, setBookingRules } from "./booking-p3a.fixtures";
import { rawBooking } from "./booking-p3b.fixtures";

vi.mock("@/modules/commerce/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), createOrder: vi.fn() }));
vi.mock("@/modules/commerce/actions", () => ({ redeemVoucher: vi.fn() }));
vi.mock("@/modules/credits/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), getMembershipForPerson: vi.fn() }));
vi.mock("@/modules/forms/api", () => ({ hasValidSubmission: vi.fn() }));
vi.mock("@/modules/site/api", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getCurrentLegalVersion: vi.fn(),
  hasAcceptedCurrentTerms: vi.fn(),
  recordTermsAcceptance: vi.fn(),
}));

// The duplicate IP signal (R48) derives its salt from AUTH_SECRET.
process.env.AUTH_SECRET ??= "test-auth-secret-booking-p7";

let h: DbHandle;

beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(async () => {
  vi.mocked(getMembershipForPerson).mockReset().mockResolvedValue({ isMember: false, membershipId: null, planProductId: null, discountPct: 0, status: null, periodEndAt: null, cancelAt: null });
  vi.mocked(hasValidSubmission).mockReset().mockResolvedValue({ valid: false, completedAt: null, expiresAt: null });
  vi.mocked(getCurrentLegalVersion).mockReset().mockResolvedValue(null);
  vi.mocked(hasAcceptedCurrentTerms).mockReset().mockResolvedValue(true);
  await setBookingRules(h.db);
});

/**
 * A free Lead Magnet event in three days: 4 seats, 2 reserved for leads, lead window open now
 * (default) or shifted by `window`; `generalTaken` general seats are booked by other people.
 */
async function leadEvent(opts: { generalTaken?: number; window?: { startAt: Date; endAt: Date }; publicReleaseAt?: Date | null } = {}) {
  const session = await openSession(h.db, {
    kind: "event",
    eventCategory: "lecture",
    creditKind: null,
    creditCost: 0,
    capacitySeats: 4,
    startsAt: new Date(Date.now() + 3 * DAY),
    isLeadMagnet: true,
    leadReservedSeats: 2,
    leadWindowStartAt: opts.window?.startAt ?? new Date(Date.now() - HOUR),
    leadWindowEndAt: opts.window?.endAt ?? new Date(Date.now() + DAY),
    publicReleaseAt: opts.publicReleaseAt ?? null,
  });
  for (let i = 0; i < (opts.generalTaken ?? 0); i++) await rawBooking(h.db, { sessionId: session.id });
  return session;
}

const lead = () => makePerson(h.db);
async function customer() {
  const p = await makePerson(h.db);
  await h.db.update(persons).set({ statusOverride: "customer", statusOverrideReason: "paid at the desk before the import" }).where(eq(persons.id, p.id));
  return p;
}

function book(actor: Actor, input: Partial<BookSeatsInput> & Pick<BookSeatsInput, "sessionId" | "personId">) {
  return inTx(h.db, actor, (tx, ctx) => bookSeats(tx, ctx, { clientKey: randomUUID(), source: "portal", by: "customer", payWith: "free", ...input }));
}
const rowsOf = (sessionId: string) => h.db.select().from(bookings).where(eq(bookings.sessionId, sessionId)).orderBy(asc(bookings.createdAt));
const view = async (sessionId: string) => (await h.db.select().from(vSessionAvailability).where(eq(vSessionAvailability.sessionId, sessionId)))[0]!;

async function refusal(p: Promise<unknown>) {
  const error = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error, "expected a refusal").not.toBeNull();
  return error as { reason?: string; data?: Record<string, unknown> };
}

describe("lead window bookings (R21-R23)", () => {
  it("a lead books a reserved seat first (used_lead_seat) while general seats stay free", async () => {
    const session = await leadEvent();
    const person = await lead();
    const result = await book(customerActor(person.id), { sessionId: session.id, personId: person.id });
    expect(result.kind).toBe("confirmed");
    const [row] = await rowsOf(session.id);
    expect(row).toMatchObject({ personId: person.id, status: "confirmed", usedLeadSeat: true });
    expect(await view(session.id)).toMatchObject({ leadBooked: 1, leadReservedRemaining: 1, availableGeneral: 2, leadPhase: "lead" });
    expect(await availabilityFor(h.db, session.id, person.id)).toMatchObject({ phase: "lead", queue: "lead" });
  });

  it("a customer is refused a reserved seat but sees the opening time and the customer queue", async () => {
    const session = await leadEvent({ generalTaken: 2 });
    const person = await customer();
    const a = await availabilityFor(h.db, session.id, person.id);
    expect(a).toMatchObject({ bookable: 0, reason: "not_open_yet", canJoinWaitlist: true, queue: "customer", phase: "lead", useLeadSeat: false });
    expect(a.opensAt?.toISOString()).toBe(session.leadWindowEndAt!.toISOString());

    const error = await refusal(book(customerActor(person.id), { sessionId: session.id, personId: person.id }));
    expect(isBookingConflict(error, "session_full")).toBe(true);
    expect(error.data).toMatchObject({ opensAt: session.leadWindowEndAt!.toISOString(), phase: "lead", queue: "customer" });
    expect(await rowsOf(session.id)).toHaveLength(2);

    // The lead still books one of the two reserved seats.
    const l = await lead();
    expect((await book(customerActor(l.id), { sessionId: session.id, personId: l.id })).kind).toBe("confirmed");
  });

  it("a customer books a general seat during the lead window while one is left", async () => {
    const session = await leadEvent({ generalTaken: 1 });
    const person = await customer();
    expect(await availabilityFor(h.db, session.id, person.id)).toMatchObject({ reason: "ok", bookable: 1, useLeadSeat: false });
    await book(customerActor(person.id), { sessionId: session.id, personId: person.id });
    const mine = (await rowsOf(session.id)).find((r) => r.personId === person.id)!;
    expect(mine.usedLeadSeat).toBe(false);
  });

  it("a lead in customer_release sees the public opening time and cannot book; a customer can", async () => {
    const endAt = new Date(Date.now() - HOUR);
    const publicAt = new Date(Date.now() + 5 * HOUR);
    const session = await leadEvent({ window: { startAt: new Date(Date.now() - 2 * DAY), endAt }, publicReleaseAt: publicAt });
    const l = await lead();
    const a = await availabilityFor(h.db, session.id, l.id);
    expect(a).toMatchObject({ phase: "customer_release", reason: "not_open_yet", queue: "lead", canJoinWaitlist: true });
    expect(a.opensAt?.toISOString()).toBe(publicAt.toISOString());
    const error = await refusal(book(customerActor(l.id), { sessionId: session.id, personId: l.id }));
    expect(error.reason).toBe("session_full");
    expect(error.data).toMatchObject({ opensAt: publicAt.toISOString(), phase: "customer_release" });

    const c = await customer();
    expect(await availabilityFor(h.db, session.id, c.id)).toMatchObject({ reason: "ok", bookable: 4 });
    expect((await book(customerActor(c.id), { sessionId: session.id, personId: c.id })).kind).toBe("confirmed");
  });

  it("without a public release time the public opening is the window end plus the claim window", async () => {
    const endAt = new Date(Date.now() - 30 * 60_000);
    const session = await leadEvent({ window: { startAt: new Date(Date.now() - DAY), endAt } });
    const a = await availabilityFor(h.db, session.id, (await lead()).id);
    expect(a.opensAt?.toISOString()).toBe(new Date(endAt.getTime() + session.claimWindowMinutes * 60_000).toISOString());
  });

  it("guests of a lead need general seats (R23)", async () => {
    const full = await leadEvent({ generalTaken: 2 });
    const l = await lead();
    const error = await refusal(book(customerActor(l.id), { sessionId: full.id, personId: l.id, guests: [{ firstName: "Gast", lastName: "Een", payWith: "free" }] }));
    expect(error.reason).toBe("session_full");
    expect(error.data).toMatchObject({ pool: "general" });
    expect(await rowsOf(full.id)).toHaveLength(2);

    const roomy = await leadEvent({ generalTaken: 1 });
    const l2 = await lead();
    await book(customerActor(l2.id), { sessionId: roomy.id, personId: l2.id, guests: [{ firstName: "Gast", lastName: "Twee", payWith: "free" }] });
    const rows = (await rowsOf(roomy.id)).filter((r) => r.personId === l2.id || r.bookedByPersonId === l2.id);
    expect(rows.find((r) => r.personId === l2.id)!.usedLeadSeat).toBe(true);
    expect(rows.find((r) => r.guestOfBookingId !== null)!.usedLeadSeat).toBe(false);
    expect(await view(roomy.id)).toMatchObject({ leadBooked: 1, availableGeneral: 0 });
  });
});

describe("duplicate protection on lead seats (R48, edge case 15)", () => {
  it("a duplicate signal refuses the lead seat with needs_review and puts the person on the lead queue, flagged", async () => {
    const session = await leadEvent();
    const first = await makePerson(h.db, { phone: "0470 12 34 56" });
    await rawBooking(h.db, { sessionId: session.id, personId: first.id, usedLeadSeat: true });
    const second = await makePerson(h.db, { phone: "+32470123456" });

    let ctx: Ctx | undefined;
    const error = await refusal(
      h.db.transaction(async (tx) => {
        ctx = createCtx({ tx, actor: customerActor(second.id), durableMode: "deferred", ip: "198.51.100.7" });
        return bookSeats(tx, ctx, { sessionId: session.id, personId: second.id, payWith: "free", clientKey: randomUUID(), source: "portal", by: "customer" });
      }),
    );
    expect(isBookingConflict(error, "needs_review")).toBe(true);
    // The booking transaction rolled back; the flagged entry is written after it.
    await flushDurableWrites(h.db, ctx!);
    expect((await rowsOf(session.id)).map((r) => r.personId)).toEqual([first.id]);
    const [entry] = await h.db.select().from(waitlistEntries).where(and(eq(waitlistEntries.sessionId, session.id), eq(waitlistEntries.personId, second.id)));
    expect(entry).toMatchObject({ queue: "lead", state: "waiting", isFlaggedDuplicate: true });
    expect(entry!.flagReason).toContain("same_phone:");
    expect(entry!.joinIpHash).toMatch(/^[0-9a-f]{64}$/);
    const facts = await h.db.select({ kind: activityEvents.kind }).from(activityEvents).where(and(eq(activityEvents.refType, "waitlist_entry"), eq(activityEvents.refId, entry!.id)));
    expect(facts.map((f) => f.kind).sort()).toEqual(["waitlist.flagged", "waitlist.joined"]);
  });

  it("a clean lead is not flagged and a customer booking a general seat skips the lead-seat check", async () => {
    const session = await leadEvent({ generalTaken: 0 });
    const first = await makePerson(h.db, { phone: "0471 00 00 01" });
    await rawBooking(h.db, { sessionId: session.id, personId: first.id });
    const c = await customer();
    await h.db.update(persons).set({ phone: "0471 00 00 01" }).where(eq(persons.id, c.id));
    expect((await book(customerActor(c.id), { sessionId: session.id, personId: c.id })).kind).toBe("confirmed");
    const other = await lead();
    expect((await book(customerActor(other.id), { sessionId: session.id, personId: other.id })).kind).toBe("confirmed");
    expect(await h.db.select().from(waitlistEntries).where(eq(waitlistEntries.sessionId, session.id))).toHaveLength(0);
  });
});
