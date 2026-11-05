/**
 * booking-P9 (R3): partner holds. External partners see and fill only their own company's holds,
 * never other attendees, never past the hold's quantity; staff can do all. An assigned seat is a
 * `confirmed`, `paid_with = free` booking whose `booking.confirmed` fact carries
 * `data.partner_company_id` (booking spec 4.2, 4.3, 5.1, 7; R9-R11).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { capacityHolds, companies, persons, roles } from "@beam/db/schema";
import { createTestDb, ensureRole, makePerson, makeUser } from "@beam/db/testing";

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

const { assignHoldSeat, unassignHoldSeat } = await import("./partner");
const { listMyPartnerHolds } = await import("../queries/partner");
const { createAuthSession, SESSION_COOKIE } = await import("@/lib/auth");
const { eq, setAppDb } = await import("@/lib/ctx");
const { resetRuntime } = await import("@/lib/testing");
const { addBooking, clearSchedule, staffSession } = await import("./booking-p2.fixtures");
const { DAY, HOUR, openSession, setBookingRules } = await import("../server/booking-p3a.fixtures");
const { bookingById, emailByKey, factsOf } = await import("../server/booking-p3b.fixtures");

let h: DbHandle;
let companyA: string;
let companyB: string;

async function makeCompany(name: string): Promise<string> {
  const [row] = await h.db.insert(companies).values({ name, isPartner: true }).returning({ id: companies.id });
  return row!.id;
}

/** Signs in an `external_partner` (only `partner.own`) linked to `companyId`. */
async function partnerSession(companyId: string) {
  const person = await makePerson(h.db, { partnerCompanyId: companyId });
  const user = await makeUser(h.db, { roleKey: "external_partner", personId: person.id });
  const { token } = await createAuthSession(h.db, { userId: user.id, audience: "staff", roleKey: "external_partner", now: new Date(), mfaAt: new Date() });
  jar.set(SESSION_COOKIE, token);
  return user;
}

async function makeHold(sessionId: string, over: Partial<typeof capacityHolds.$inferInsert> = {}) {
  const [row] = await h.db
    .insert(capacityHolds)
    .values({ sessionId, kind: "partner", quantity: 2, companyId: companyA, note: "Speaker Example", ...over })
    .returning();
  return row!;
}

/** An event in two days and a quarter, 20 seats, free registration. */
const event = (over: Parameters<typeof openSession>[1] = {}) =>
  openSession(h.db, { kind: "event", eventCategory: "partner_event", partnerCompanyId: companyA, creditKind: null, creditCost: 0, capacitySeats: 20, startsAt: new Date(Date.now() + 2.25 * DAY), ...over });

const seat = (holdId: string, n: number, email?: string) => ({ holdId, firstName: `Guest${n}`, lastName: "Example", ...(email ? { email } : {}) });

beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
  await ensureRole(h.db, "external_partner");
  await h.db.update(roles).set({ permissions: ["partner.own"] }).where(eq(roles.key, "external_partner"));
  companyA = await makeCompany("Partner A BV");
  companyB = await makeCompany("Partner B BV");
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(async () => {
  jar.clear();
  await clearSchedule(h.db);
  await setBookingRules(h.db);
});

describe("assignHoldSeat (R3)", () => {
  it("fills a seat of the partner's own hold: confirmed, free, in the hold, with data.partner_company_id", async () => {
    const session = await event();
    const hold = await makeHold(session.id);
    await partnerSession(companyA);
    const res = await assignHoldSeat(seat(hold.id, 1, "guest1.partner@example.com"));
    expect(res).toMatchObject({ ok: true });
    const bookingId = res.ok ? res.data.bookingId : "";
    const row = await bookingById(h.db, bookingId);
    expect(row).toMatchObject({ status: "confirmed", paidWith: "free", capacityHoldId: hold.id, capacityUnits: 1, source: "admin", sessionId: session.id });
    expect(row.bookedByUserId).not.toBeNull();
    const [person] = await h.db.select().from(persons).where(eq(persons.id, row.personId));
    expect(person).toMatchObject({ firstName: "Guest1", lastName: "Example", email: "guest1.partner@example.com" });
    expect(person!.acquisition).toMatchObject({ source: "partner", partner_company_id: companyA, event_session_id: session.id });
    const facts = await factsOf(h.db, bookingId);
    expect(facts.map((f) => f.kind)).toEqual(["booking.confirmed"]);
    expect(facts[0]!.data).toMatchObject({ paid_with: "free", partner_company_id: companyA, session_id: session.id, by: "staff" });
    expect(await emailByKey(h.db, `booking:${bookingId}:confirmed`)).toBeDefined();
  });

  it("uses the hold's company for data.partner_company_id, not the session's organiser", async () => {
    const session = await event({ partnerCompanyId: companyA });
    const hold = await makeHold(session.id, { companyId: companyB });
    await partnerSession(companyB);
    const res = await assignHoldSeat(seat(hold.id, 2));
    const bookingId = res.ok ? res.data.bookingId : "";
    const [fact] = await factsOf(h.db, bookingId);
    expect(fact!.data).toMatchObject({ partner_company_id: companyB });
    // Without an email the person is created without one and no confirmation is sent.
    expect(await emailByKey(h.db, `booking:${bookingId}:confirmed`)).toBeUndefined();
  });

  it("refuses another company's hold as not_found and writes nothing", async () => {
    const session = await event();
    const other = await makeHold(session.id, { companyId: companyB });
    await partnerSession(companyA);
    expect(await assignHoldSeat(seat(other.id, 3))).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await listMyPartnerHolds(h.db, { companyId: companyA })).toEqual([]);
    const [all] = await listMyPartnerHolds(h.db, { companyId: null });
    expect(all!.used).toBe(0);
  });

  it("never exceeds the hold's quantity (session_full), and a freed seat can be filled again", async () => {
    const session = await event();
    const hold = await makeHold(session.id, { quantity: 2 });
    await partnerSession(companyA);
    const first = await assignHoldSeat(seat(hold.id, 4));
    expect(await assignHoldSeat(seat(hold.id, 5))).toMatchObject({ ok: true });
    expect(await assignHoldSeat(seat(hold.id, 6))).toMatchObject({ ok: false, error: { code: "conflict", message: "session_full" } });
    const firstId = first.ok ? first.data.bookingId : "";
    expect(await unassignHoldSeat({ bookingId: firstId })).toMatchObject({ ok: true });
    expect(await assignHoldSeat(seat(hold.id, 6))).toMatchObject({ ok: true });
    const [row] = await listMyPartnerHolds(h.db, { companyId: companyA });
    expect(row).toMatchObject({ quantity: 2, used: 2 });
  });

  it("refuses the same person twice in one session (already_booked)", async () => {
    const session = await event();
    const hold = await makeHold(session.id, { quantity: 3 });
    await partnerSession(companyA);
    expect(await assignHoldSeat(seat(hold.id, 7, "twice.partner@example.com"))).toMatchObject({ ok: true });
    expect(await assignHoldSeat(seat(hold.id, 7, "twice.partner@example.com"))).toMatchObject({ ok: false, error: { code: "conflict", message: "already_booked" } });
  });

  it("stops once the session started (outside_window) and on a cancelled session (session_closed)", async () => {
    const started = await event({ startsAt: new Date(Date.now() - 0.5 * HOUR) });
    const startedHold = await makeHold(started.id);
    const cancelled = await event({ status: "cancelled", cancelledAt: new Date(), cancelReason: "weather" });
    const cancelledHold = await makeHold(cancelled.id);
    await partnerSession(companyA);
    expect(await assignHoldSeat(seat(startedHold.id, 8))).toMatchObject({ ok: false, error: { code: "conflict", message: "outside_window" } });
    expect(await assignHoldSeat(seat(cancelledHold.id, 9))).toMatchObject({ ok: false, error: { code: "conflict", message: "session_closed" } });
  });

  it("staff with bookings.write fill any hold, of any kind", async () => {
    const session = await event({ partnerCompanyId: null });
    const partnerHold = await makeHold(session.id, { companyId: companyB });
    const speakerHold = await makeHold(session.id, { kind: "speaker", companyId: null, quantity: 1 });
    await staffSession(h.db, jar, ["bookings.read", "bookings.write"]);
    const a = await assignHoldSeat(seat(partnerHold.id, 10));
    const b = await assignHoldSeat(seat(speakerHold.id, 11));
    expect(a).toMatchObject({ ok: true });
    expect(b).toMatchObject({ ok: true });
    const [factB] = await factsOf(h.db, b.ok ? b.data.bookingId : "");
    expect(factB!.data).toMatchObject({ paid_with: "free" });
    expect(factB!.data).not.toHaveProperty("partner_company_id");
    expect(await unassignHoldSeat({ bookingId: a.ok ? a.data.bookingId : "" })).toMatchObject({ ok: true });
  });
});

describe("unassignHoldSeat (R3)", () => {
  it("cancels the seat with code staff and a booking.cancelled fact that keeps the partner company", async () => {
    const session = await event();
    const hold = await makeHold(session.id);
    await partnerSession(companyA);
    const res = await assignHoldSeat(seat(hold.id, 12, "leaves.partner@example.com"));
    const bookingId = res.ok ? res.data.bookingId : "";
    expect(await unassignHoldSeat({ bookingId })).toMatchObject({ ok: true, data: { bookingId } });
    expect(await bookingById(h.db, bookingId)).toMatchObject({ status: "cancelled", cancelReasonCode: "staff", version: 2 });
    const facts = await factsOf(h.db, bookingId);
    expect(facts.map((f) => f.kind)).toEqual(["booking.confirmed", "booking.cancelled"]);
    expect(facts[1]!.data).toMatchObject({ partner_company_id: companyA, cancel_reason_code: "staff" });
    expect(await emailByKey(h.db, `booking:${bookingId}:cancelled`)).toBeDefined();
    // A second call finds a cancelled row: not a live seat any more.
    expect(await unassignHoldSeat({ bookingId })).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("refuses seats of another company's hold and bookings outside any hold (not_found)", async () => {
    const session = await event();
    const other = await makeHold(session.id, { companyId: companyB });
    await staffSession(h.db, jar, ["bookings.write"]);
    const theirs = await assignHoldSeat(seat(other.id, 13));
    const general = await addBooking(h.db, session.id);
    await partnerSession(companyA);
    expect(await unassignHoldSeat({ bookingId: theirs.ok ? theirs.data.bookingId : "" })).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await unassignHoldSeat({ bookingId: general.id })).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect((await bookingById(h.db, general.id)).status).toBe("confirmed");
  });
});

describe("listMyPartnerHolds (R3)", () => {
  it("shows a partner only their own holds and the names in them, never other attendees or notes", async () => {
    const session = await event();
    const mine = await makeHold(session.id, { quantity: 3 });
    const theirs = await makeHold(session.id, { companyId: companyB });
    const general = await addBooking(h.db, session.id);
    await staffSession(h.db, jar, ["bookings.write"]);
    await assignHoldSeat(seat(theirs.id, 14));
    await partnerSession(companyA);
    await assignHoldSeat(seat(mine.id, 15, "mine.partner@example.com"));
    const past = await event({ startsAt: new Date(Date.now() - 3 * DAY) });
    await makeHold(past.id);

    const rows = await listMyPartnerHolds(h.db, { companyId: companyA });
    expect(rows.map((r) => r.id)).toEqual([mine.id]);
    const [row] = rows;
    expect(row).toMatchObject({ kind: "partner", quantity: 3, used: 1, companyId: companyA, companyName: "Partner A BV", note: null, isStarted: false, isCancelled: false });
    expect(row!.seats).toHaveLength(1);
    const { bookingId, ...visible } = row!.seats[0]!;
    expect(bookingId).toMatch(/^[0-9a-f-]{36}$/);
    expect(visible).toEqual({ firstName: "Guest15", lastName: "Example", status: "confirmed" });
    const shown = JSON.stringify(rows);
    expect(shown).not.toContain(general.personId);
    expect(shown).not.toContain("Guest14");
    expect(shown).not.toContain("@example.com");

    const staffView = await listMyPartnerHolds(h.db, { companyId: null });
    expect(staffView.map((r) => r.id).sort()).toEqual([mine.id, theirs.id].sort());
    expect(staffView.find((r) => r.id === mine.id)!.note).toBe("Speaker Example");
  });
});
