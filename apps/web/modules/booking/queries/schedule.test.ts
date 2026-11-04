import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { sessionExceptions } from "@beam/db/schema";
import { createTestDb, makePerson, makeSession } from "@beam/db/testing";
import { makeOrder, makeOrderLine, makePaidOrder } from "@beam/db/testing/commerce-factories";
import { addDays, brusselsDate, zonedTimeToUtc } from "@beam/core/booking";

const valid = new Set<string>();
const accepted = new Set<string>();
vi.mock("@/modules/forms/api", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  hasValidSubmission: vi.fn((_db: unknown, input: { personId: string; formSlug: string }) =>
    Promise.resolve({ valid: input.formSlug === "health-declaration" && valid.has(input.personId), completedAt: null, expiresAt: null }),
  ),
}));
vi.mock("../server/terms", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  hasEverAcceptedTerms: vi.fn((_db: unknown, personId: string) => Promise.resolve(accepted.has(personId))),
}));

const { getDayPrintList, getDayView, getOpeningHours, listUpcomingHolidays } = await import("./schedule");
const { resetRuntime } = await import("@/lib/testing");
const { addBooking, clearSchedule } = await import("../actions/booking-p2.fixtures");

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(async () => {
  valid.clear();
  accepted.clear();
  await clearSchedule(h.db);
});

const onDate = "2027-03-09";

describe("getDayPrintList (booking spec 4.3, R62b)", () => {
  it("lists every session of the day with time, name, guest of, paid with, to pay, terms, health declaration and notes", async () => {
    const morning = await makeSession(h.db, { startsAt: zonedTimeToUtc(onDate, "09:00"), endsAt: zonedTimeToUtc(onDate, "11:00") });
    const afternoon = await makeSession(h.db, { startsAt: zonedTimeToUtc(onDate, "14:00"), endsAt: zonedTimeToUtc(onDate, "16:00") });
    await makeSession(h.db, { startsAt: zonedTimeToUtc(onDate, "16:30"), status: "cancelled", cancelledAt: new Date() });
    await makeSession(h.db, { startsAt: zonedTimeToUtc(addDays(onDate, 1), "09:00") });

    const ann = await makePerson(h.db, { firstName: "Ann", lastName: "Peeters" });
    const bob = await makePerson(h.db, { firstName: "Bob", lastName: "Janssens" });
    const cleo = await makePerson(h.db, { firstName: "Cleo", lastName: "Maes" });
    valid.add(ann.id);
    accepted.add(ann.id);

    const owner = await addBooking(h.db, morning.id, { personId: ann.id, paidWith: "credit", notes: "Allergic to nothing relevant" });
    await addBooking(h.db, morning.id, { personId: bob.id, paidWith: "guest", guestOfBookingId: owner.id });
    // Pay at the desk: an unpaid order line.
    const order = await makeOrder(h.db, { personId: cleo.id, channel: "admin" });
    const line = await makeOrderLine(h.db, { orderId: order.id, productKind: "session", sessionId: afternoon.id, quantity: 1, unitAmountCents: 2_500 });
    await addBooking(h.db, afternoon.id, { personId: cleo.id, status: "reserved", paidWith: "order", isPayAtDesk: true, orderLineId: line.id });
    // A paid order booking has nothing left to pay; a cancelled booking is not listed.
    const paid = await makePaidOrder(h.db, { personId: ann.id, lines: [{ productKind: "session", sessionId: afternoon.id, unitAmountCents: 2_500 }] });
    await addBooking(h.db, afternoon.id, { personId: ann.id, paidWith: "order", orderLineId: paid.lines[0]!.id });
    await addBooking(h.db, afternoon.id, { status: "cancelled" });

    const list = await getDayPrintList(h.db, { onDate });
    expect(list.sessions.map((s) => s.sessionId)).toEqual([morning.id, afternoon.id]);
    expect(list.sessions[0]!.attendees).toEqual([
      expect.objectContaining({ name: "Bob Janssens", guestOf: "Ann Peeters", paidWith: "guest", toPayCents: null, termsPending: true, healthMissing: true, notes: null }),
      expect.objectContaining({ name: "Ann Peeters", guestOf: null, paidWith: "credit", toPayCents: null, termsPending: false, healthMissing: false, notes: "Allergic to nothing relevant" }),
    ]);
    expect(list.sessions[1]!.attendees).toEqual([
      expect.objectContaining({ name: "Cleo Maes", status: "reserved", paidWith: "order", isPayAtDesk: true, toPayCents: 2_500, termsPending: true, healthMissing: true }),
      expect.objectContaining({ name: "Ann Peeters", status: "confirmed", paidWith: "order", toPayCents: null, healthMissing: false }),
    ]);
  });

  it("a day without sessions has an empty list", async () => {
    expect(await getDayPrintList(h.db, { onDate })).toEqual({ onDate, sessions: [] });
  });
});

describe("getOpeningHours and the day view (3.0b)", () => {
  it("a special-hours exception replaces the weekday hours of its date only", async () => {
    const name = { "nl-BE": "Personeelsfeest", "fr-BE": "Fête du personnel", en: "Staff party" };
    await h.db.insert(sessionExceptions).values({ onDate, kind: "special_hours", opensAt: "12:00", closesAt: "16:00", name });
    expect(await getOpeningHours(h.db, { from: addDays(onDate, -1), to: addDays(onDate, 1) })).toEqual([
      { onDate: "2027-03-08", opensAt: null, closesAt: null, exceptionName: null },
      { onDate, opensAt: "12:00", closesAt: "16:00", exceptionName: name },
      { onDate: "2027-03-10", opensAt: "08:30", closesAt: "19:00", exceptionName: null },
    ]);
    const view = await getDayView(h.db, { onDate });
    expect(view).toMatchObject({ onDate, openingHours: { opensAt: "12:00", closesAt: "16:00" }, sessions: [], conflicts: [] });
    expect(view.exceptions).toHaveLength(1);
  });

  it("the day view counts attendees, check-ins and unpaid desk bookings", async () => {
    const s = await makeSession(h.db, { startsAt: zonedTimeToUtc(onDate, "09:00"), capacitySeats: 5 });
    await addBooking(h.db, s.id);
    await addBooking(h.db, s.id, { status: "attended" });
    const order = await makeOrder(h.db);
    const line = await makeOrderLine(h.db, { orderId: order.id, productKind: "session", sessionId: s.id });
    await addBooking(h.db, s.id, { status: "reserved", paidWith: "order", isPayAtDesk: true, orderLineId: line.id });
    const [row] = (await getDayView(h.db, { onDate })).sessions;
    expect(row).toMatchObject({ id: s.id, capacity: 5, booked: 3, attendees: 3, checkedIn: 1, unpaidAtDesk: 1, availableTotal: 2 });
  });
});

describe("listUpcomingHolidays (R4b)", () => {
  it("lists the next 12 months of public holidays without an exception, named in three locales", async () => {
    const now = zonedTimeToUtc("2027-02-01", "10:00");
    const all = await listUpcomingHolidays(h.db, now);
    expect(all.map((x) => x.key)).toEqual(["easter_monday", "labour_day", "ascension", "whit_monday", "national_day", "assumption", "all_saints", "armistice", "christmas", "new_year"]);
    expect(all[0]).toEqual({ onDate: "2027-03-29", key: "easter_monday", name: { "nl-BE": expect.any(String) as string, "fr-BE": expect.any(String) as string, en: "Easter Monday" } });
    await h.db.insert(sessionExceptions).values({ onDate: "2027-03-29", kind: "holiday", name: all[0]!.name });
    const left = await listUpcomingHolidays(h.db, now);
    expect(left.map((x) => x.key)).not.toContain("easter_monday");
    expect(left.every((x) => x.onDate >= brusselsDate(now))).toBe(true);
  });
});
