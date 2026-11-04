import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { createTestDb, makePerson } from "@beam/db/testing";
import { DEFAULT_BOOKING_RULES, brusselsDate } from "@beam/core/booking";
import { NotImplementedError } from "@beam/core/errors";
import { resetRuntime } from "@/lib/testing";
import { getReceptionCard, type ReceptionCardData } from "@/modules/crm/api";
import { hasValidSubmission } from "@/modules/forms/api";
import { DAY, HOUR, openSession, setBookingRules } from "../server/booking-p3a.fixtures";
import { rawBooking, unpaidOrderBooking } from "../server/booking-p3b.fixtures";
import { attendanceFlags, codeFromScan, getCheckinCard, getCheckinDay, getSessionAttendees, listManualBookingSessions, searchCheckin } from "./attendance";

vi.mock("@/lib/auth", () => ({ requirePermission: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/modules/forms/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), hasValidSubmission: vi.fn() }));
vi.mock("@/modules/crm/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), getReceptionCard: vi.fn() }));

/** A reception card of the crm contract shape (crm getReceptionCard), returned by the mock. */
const receptionCard: ReceptionCardData = {
  name: "Rita Receptie",
  customerNumber: "B-000123",
  status: "member",
  isMember: true,
  tags: ["vip"],
  emergencyContact: { name: "Rudi Receptie", phone: "+32 470 00 00 00" },
  declarations: { termsAccepted: true, healthDeclarationValid: false, guardianConsentValid: false },
  isMinor: false,
};

let h: DbHandle;
const valid = new Set<string>();
const expired = new Set<string>();

beforeAll(async () => {
  h = await createTestDb();
  await setBookingRules(h.db);
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(() => {
  vi.mocked(hasValidSubmission).mockReset().mockImplementation((_db, { personId }) => {
    if (valid.has(personId)) return Promise.resolve({ valid: true, completedAt: new Date(Date.now() - DAY), expiresAt: new Date(Date.now() + 300 * DAY) });
    if (expired.has(personId)) return Promise.resolve({ valid: false, completedAt: new Date(Date.now() - 400 * DAY), expiresAt: new Date(Date.now() - 35 * DAY) });
    return Promise.resolve({ valid: false, completedAt: null, expiresAt: null });
  });
  vi.mocked(getReceptionCard).mockReset().mockResolvedValue(receptionCard);
});

describe("codeFromScan", () => {
  it("reads typed codes, the Crockford look-alikes and the QR URL; names are not codes", () => {
    expect(codeFromScan("abcd-efgh-jk")).toBe("ABCDEFGHJK");
    expect(codeFromScan("O1IL0ABCDE")).toBe("0111" + "0ABCDE");
    expect(codeFromScan("https://beam.example.com/admin/bookings/checkin?c=7K3M9P2QRS")).toBe("7K3M9P2QRS");
    expect(codeFromScan("/admin/bookings/checkin?x=1&c=7k3m9p2qrs#top")).toBe("7K3M9P2QRS");
    expect(codeFromScan("Jan Janssens")).toBeNull();
    expect(codeFromScan("")).toBeNull();
  });
});

describe("searchCheckin (booking spec 4.3, R62b)", () => {
  it("searches name or email among the attendees of that Brussels day only", async () => {
    const today = await openSession(h.db, { startsAt: new Date(Date.now() + HOUR) });
    const tomorrow = await openSession(h.db, { startsAt: new Date(Date.now() + DAY + HOUR) });
    const onDate = brusselsDate(today.startsAt);
    const anna = await makePerson(h.db, { firstName: "Annelies", lastName: "Vermeulen", email: "annelies.v@example.com" });
    const other = await makePerson(h.db, { firstName: "Bram", lastName: "Claes", email: "zonnebloem@example.com" });
    await rawBooking(h.db, { sessionId: today.id, personId: anna.id });
    await rawBooking(h.db, { sessionId: today.id, personId: other.id });
    await rawBooking(h.db, { sessionId: tomorrow.id, personId: anna.id });
    const cancelled = await makePerson(h.db, { firstName: "Annelies", lastName: "Cancelled" });
    await rawBooking(h.db, { sessionId: today.id, personId: cancelled.id, status: "cancelled", cancelledAt: new Date(), cancelReasonCode: "customer" });

    const byName = await searchCheckin(h.db, { onDate, q: "annelies verm" });
    expect(byName.map((r) => [r.personId, r.sessionId])).toEqual([[anna.id, today.id]]);
    const byEmail = await searchCheckin(h.db, { onDate, q: "ZONNEBLOEM" });
    expect(byEmail.map((r) => r.personId)).toEqual([other.id]);
    expect(await searchCheckin(h.db, { onDate: brusselsDate(tomorrow.startsAt), q: "annelies" })).toHaveLength(brusselsDate(tomorrow.startsAt) === onDate ? 2 : 1);
    expect(await searchCheckin(h.db, { onDate, q: "  " })).toEqual([]);
    expect(await searchCheckin(h.db, { onDate, q: "%" })).toEqual([]);
  });

  it("finds guests without an email by name, with the owner's name", async () => {
    const s = await openSession(h.db, { startsAt: new Date(Date.now() + 2 * HOUR) });
    const owner = await makePerson(h.db, { firstName: "Olivia", lastName: "Wouters" });
    const guest = await makePerson(h.db, { firstName: "Gerrit", lastName: "Gastmans", email: null });
    const ownerRow = await rawBooking(h.db, { sessionId: s.id, personId: owner.id });
    await rawBooking(h.db, { sessionId: s.id, personId: guest.id, guestOfBookingId: ownerRow.id, paidWith: "guest" });
    const [row] = await searchCheckin(h.db, { onDate: brusselsDate(s.startsAt), q: "gastmans" });
    expect(row).toMatchObject({ personId: guest.id, email: null, name: "Gerrit Gastmans", guestOfBookingId: ownerRow.id, guestOfName: "Olivia Wouters", paidWith: "guest" });
  });

  it("carries the health declaration state and terms acceptance on every row", async () => {
    const s = await openSession(h.db, { startsAt: new Date(Date.now() + 3 * HOUR) });
    const ok = await makePerson(h.db, { firstName: "Hanne", lastName: "Healthy" });
    const old = await makePerson(h.db, { firstName: "Hanne", lastName: "Expired" });
    const none = await makePerson(h.db, { firstName: "Hanne", lastName: "Missing" });
    valid.add(ok.id);
    expired.add(old.id);
    for (const p of [ok, old, none]) await rawBooking(h.db, { sessionId: s.id, personId: p.id });
    const rows = await searchCheckin(h.db, { onDate: brusselsDate(s.startsAt), q: "hanne" });
    const state = Object.fromEntries(rows.map((r) => [r.personId, r.healthDeclaration.state]));
    expect(state).toEqual({ [ok.id]: "valid", [old.id]: "expired", [none.id]: "missing" });
    expect(rows.find((r) => r.personId === ok.id)?.healthDeclaration.expiresAt).toBeInstanceOf(Date);
    expect(rows.every((r) => r.termsAccepted === false)).toBe(true);
    expect(vi.mocked(hasValidSubmission).mock.calls.every((c) => c[1].formSlug === "health-declaration")).toBe(true);

    // While forms has not landed `hasValidSubmission`, the declaration reads as missing.
    vi.mocked(hasValidSubmission).mockRejectedValue(new NotImplementedError("forms.hasValidSubmission"));
    const fallback = await searchCheckin(h.db, { onDate: brusselsDate(s.startsAt), q: "hanne healthy" });
    expect(fallback[0]?.healthDeclaration).toEqual({ valid: false, expiresAt: null, state: "missing" });
  });
});

describe("getCheckinCard and getCheckinDay", () => {
  it("shows the scanned booking with its guests, the payment due and the window flags", async () => {
    const now = new Date();
    const s = await openSession(h.db, { startsAt: new Date(now.getTime() - 30 * 60_000) });
    const owner = await rawBooking(h.db, { sessionId: s.id });
    const guest = await rawBooking(h.db, { sessionId: s.id, guestOfBookingId: owner.id, paidWith: "guest" });
    const card = await getCheckinCard(h.db, { code: `https://beam.example.com/admin/bookings/checkin?c=${owner.checkinCode}`, now });
    expect(card).toMatchObject({ bookingId: owner.id, status: "confirmed", canCheckIn: true, canUndo: false, canMarkNoShow: true, wrongDay: false, inWindow: true });
    expect(card?.receptionCard).toEqual(receptionCard);
    expect(vi.mocked(getReceptionCard)).toHaveBeenCalledWith(h.db, owner.personId);
    expect(card?.guests.map((g) => g.bookingId)).toEqual([guest.id]);

    const unpaid = await unpaidOrderBooking(h.db, { sessionId: s.id, isPayAtDesk: true, reservedUntil: s.endsAt });
    const due = await getCheckinCard(h.db, { bookingId: unpaid.booking.id, now });
    expect(due).toMatchObject({ status: "reserved", canCheckIn: false, orderId: unpaid.orderId, toPayCents: 2500, isPayAtDesk: true });

    const later = await openSession(h.db, { startsAt: new Date(now.getTime() + 3 * DAY) });
    const other = await rawBooking(h.db, { sessionId: later.id });
    expect(await getCheckinCard(h.db, { code: other.checkinCode, now })).toMatchObject({ wrongDay: true, canCheckIn: false });
    expect(await getCheckinCard(h.db, { code: "ZZZZZZZZZZ", now })).toBeNull();
    expect(await getCheckinCard(h.db, { code: "a name", now })).toBeNull();

    const day = await getCheckinDay(h.db, { onDate: brusselsDate(s.startsAt) });
    const mine = day.find((d) => d.sessionId === s.id);
    expect(mine?.notArrived.map((r) => r.bookingId).sort()).toEqual([owner.id, guest.id, unpaid.booking.id].sort());
    expect(mine?.notArrived.every((r) => r.healthDeclaration.state === "missing")).toBe(true);
  });
});

describe("session detail and manual booking helpers", () => {
  it("lists a session's attendees with guests after their owner and the amount still to pay", async () => {
    const s = await openSession(h.db, { startsAt: new Date(Date.now() + 4 * HOUR) });
    const owner = await rawBooking(h.db, { sessionId: s.id, personId: (await makePerson(h.db, { firstName: "Zoe", lastName: "Zeger" })).id });
    const guest = await rawBooking(h.db, { sessionId: s.id, guestOfBookingId: owner.id, paidWith: "guest", personId: (await makePerson(h.db, { firstName: "Anna", lastName: "Aerts" })).id });
    const unpaid = await unpaidOrderBooking(h.db, { sessionId: s.id, isPayAtDesk: true });
    const gone = await rawBooking(h.db, { sessionId: s.id, status: "cancelled", cancelledAt: new Date(), cancelReasonCode: "staff" });
    const rows = await getSessionAttendees(h.db, s.id);
    const ids = rows.map((r) => r.bookingId);
    expect(ids.indexOf(guest.id)).toBe(ids.indexOf(owner.id) + 1);
    expect(ids[ids.length - 1]).toBe(gone.id);
    expect(rows.find((r) => r.bookingId === owner.id)).toMatchObject({ guestCount: 1, name: "Zoe Zeger" });
    expect(rows.find((r) => r.bookingId === guest.id)).toMatchObject({ guestOfName: "Zoe Zeger" });
    expect(rows.find((r) => r.bookingId === unpaid.booking.id)).toMatchObject({ toPayCents: 2500, isPayAtDesk: true });
  });

  it("offers the attendance buttons by the check-in rules", () => {
    const startsAt = new Date("2026-11-04T09:00:00Z");
    const endsAt = new Date("2026-11-04T11:00:00Z");
    const at = (iso: string, status: "confirmed" | "attended" | "no_show") => attendanceFlags({ status, startsAt, endsAt }, DEFAULT_BOOKING_RULES, new Date(iso));
    expect(at("2026-11-04T06:00:00Z", "confirmed")).toMatchObject({ canCheckIn: false, canMarkNoShow: false });
    expect(at("2026-11-04T08:00:00Z", "confirmed")).toMatchObject({ canCheckIn: true, canMarkNoShow: false });
    expect(at("2026-11-04T09:30:00Z", "confirmed")).toMatchObject({ canCheckIn: true, canMarkNoShow: true });
    expect(at("2026-11-04T12:59:00Z", "attended")).toMatchObject({ canUndo: true });
    expect(at("2026-11-04T13:01:00Z", "attended")).toMatchObject({ canUndo: false });
    expect(at("2026-11-10T11:00:00Z", "no_show")).toMatchObject({ canRevertNoShow: true });
    expect(at("2026-11-12T11:00:00Z", "no_show")).toMatchObject({ canRevertNoShow: false });
  });

  it("lists the wizard's sessions with pay-at-desk from the rules, without cancelled sessions", async () => {
    const from = new Date(Date.now() + 20 * DAY);
    const plain = await openSession(h.db, { startsAt: new Date(from.getTime() + HOUR) });
    const cancelled = await openSession(h.db, { startsAt: new Date(from.getTime() + 2 * HOUR), status: "cancelled", cancelledAt: new Date(), cancelReason: "x" });
    const rows = await listManualBookingSessions(h.db, { from, to: new Date(from.getTime() + DAY) });
    expect(rows.map((r) => r.id)).toContain(plain.id);
    expect(rows.map((r) => r.id)).not.toContain(cancelled.id);
    expect(rows.find((r) => r.id === plain.id)).toMatchObject({ payAtDeskAllowed: false, availableTotal: 10, creditBalance: null });
  });
});
