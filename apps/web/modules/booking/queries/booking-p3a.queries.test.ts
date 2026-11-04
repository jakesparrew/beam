import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { bookings } from "@beam/db/schema";
import { createTestDb, makePerson } from "@beam/db/testing";
import { resetRuntime } from "@/lib/testing";
import { DAY, openSession, setBookingRules } from "../server/booking-p3a.fixtures";
import { getBookableSession, getMyBooking, listBookings, listMyBookings, listRescheduleTargets } from "./bookings";

vi.mock("@/lib/auth", () => ({ requirePermission: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/modules/credits/api", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getMembershipForPerson: vi.fn().mockResolvedValue({ isMember: false, membershipId: null, planProductId: null, discountPct: 0, status: null, periodEndAt: null, cancelAt: null }),
}));

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
  await setBookingRules(h.db);
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

const at = (days: number) => new Date(Date.now() + days * DAY);
async function addBooking(values: Partial<typeof bookings.$inferInsert> & { sessionId: string; personId: string }) {
  const [row] = await h.db
    .insert(bookings)
    .values({ status: "confirmed", paidWith: "credit", source: "portal", ...values })
    .returning();
  return row!;
}

describe("booking queries (booking-P3a)", () => {
  it("customer booking queries show own and guest rows, never staff fields, and the QR only to the attendee", async () => {
    const owner = await makePerson(h.db);
    const guest = await makePerson(h.db, { firstName: "Gwen" });
    const stranger = await makePerson(h.db);
    const s = await openSession(h.db, { startsAt: at(5) });
    const own = await addBooking({ sessionId: s.id, personId: owner.id, bookedByPersonId: owner.id, notes: "staff only" });
    const g = await addBooking({ sessionId: s.id, personId: guest.id, paidWith: "guest", guestOfBookingId: own.id, bookedByPersonId: owner.id });
    const upcoming = await listMyBookings(h.db, owner.id, { scope: "upcoming" });
    expect(upcoming.map((r) => r.id).sort()).toEqual([own.id, g.id].sort());
    expect(Object.keys(upcoming[0]!)).not.toEqual(expect.arrayContaining(["notes"]));
    expect(await listMyBookings(h.db, owner.id, { scope: "past" })).toEqual([]);
    const mine = await getMyBooking(h.db, owner.id, own.id);
    expect(mine.qrSvg).toContain("<svg");
    expect(mine.guests.map((x) => x.firstName)).toEqual(["Gwen"]);
    expect(mine).not.toHaveProperty("notes");
    expect(mine).not.toHaveProperty("checkinCode");
    const ofGuest = await getMyBooking(h.db, owner.id, g.id);
    expect(ofGuest.qrSvg).toBeNull();
    await expect(getMyBooking(h.db, stranger.id, own.id)).rejects.toMatchObject({ code: "not_found" });
  });

  it("listRescheduleTargets offers same-kind sessions inside the window and respects the chain limit", async () => {
    const person = await makePerson(h.db);
    const from = await openSession(h.db, { startsAt: at(6) });
    const target = await openSession(h.db, { startsAt: at(7) });
    await openSession(h.db, { kind: "night", startsAt: at(7) });
    const row = await addBooking({ sessionId: from.id, personId: person.id });
    const targets = await listRescheduleTargets(h.db, person.id, row.id);
    expect(targets.map((t) => t.sessionId)).toContain(target.id);
    expect(targets.every((t) => t.kind === "day" && t.sessionId !== from.id)).toBe(true);
    // two earlier reschedules along the chain: the default limit of 2 is reached
    const s0 = await openSession(h.db, { startsAt: at(8) });
    const s1 = await openSession(h.db, { startsAt: at(9) });
    const s2 = await openSession(h.db, { startsAt: at(10) });
    const b0 = await addBooking({ sessionId: s0.id, personId: person.id, status: "cancelled", cancelledAt: new Date(), cancelReasonCode: "rescheduled" });
    const b1 = await addBooking({
      sessionId: s1.id,
      personId: person.id,
      status: "cancelled",
      cancelledAt: new Date(),
      cancelReasonCode: "rescheduled",
      rescheduledFromBookingId: b0.id,
    });
    const b2 = await addBooking({ sessionId: s2.id, personId: person.id, rescheduledFromBookingId: b1.id });
    expect(await listRescheduleTargets(h.db, person.id, b2.id)).toEqual([]);
    expect(await listRescheduleTargets(h.db, (await makePerson(h.db)).id, row.id)).toEqual([]);
  });

  it("getBookableSession lists payment options, the emergency contact need and reports a missing health declaration", async () => {
    const person = await makePerson(h.db);
    const night = await openSession(h.db, { kind: "night", creditKind: "night", startsAt: at(4) });
    const view = await getBookableSession(h.db, person.id, night.id);
    expect(view).toMatchObject({ payOptions: [], needsEmergencyContact: true, healthDeclaration: { valid: false, expiresAt: null }, credit: { ok: false } });
    expect(view.availability.reason).toBe("ok");
  });

  it("listBookings pages by (created_at, id)", async () => {
    const person = await makePerson(h.db);
    for (let i = 0; i < 3; i++) await addBooking({ sessionId: (await openSession(h.db, { startsAt: at(20 + i) })).id, personId: person.id });
    const all = await listBookings(h.db, { personId: person.id });
    expect(all.rows).toHaveLength(3);
    expect(all.nextCursor).toBeNull();
    const rest = await listBookings(h.db, { personId: person.id, cursor: { createdAt: all.rows[0]!.createdAt, id: all.rows[0]!.id } });
    expect(rest.rows.map((r) => r.id)).toEqual(all.rows.slice(1).map((r) => r.id));
  });
});
