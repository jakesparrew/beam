import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { bookings, creditGrants, waitlistEntries } from "@beam/db/schema";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import { makeCreditGrant } from "@beam/db/testing/credits-factories";
import { and, eq, type Actor } from "@/lib/ctx";
import { resetRuntime, staffActor } from "@/lib/testing";
import { cancelOrder, createOrder, refundOrderLine } from "@/modules/commerce/api";
import { getMembershipForPerson } from "@/modules/credits/api";
import { hasValidSubmission } from "@/modules/forms/api";
import { getCurrentLegalVersion, hasAcceptedCurrentTerms, recordTermsAcceptance } from "@/modules/site/api";
import { cancelBookingsForOrderLine } from "../api/bookings";
import { bookSeats, type BookSeatsInput } from "./book";
import { DAY, HOUR, customerActor, fakeCreateOrder, inTx, openSession, sessionProduct, setBookingRules } from "./booking-p3a.fixtures";
import {
  bookingById,
  bookingsOfSession,
  emailByKey,
  factsOf,
  jobsOf,
  paidOrderBooking,
  rawBooking,
  releasesOf,
  unpaidOrderBooking,
  waitEntry,
} from "./booking-p3b.fixtures";
import { SESSION_CANCEL_CHUNK, cancelBookingRow, cancelSessionChunk, cancelSessionRow, type CancelBookingInput } from "./cancel";

// commerce's api barrel re-exports `redeemVoucher` from its actions, whose import graph reaches booking's
// book.ts: stubbing the actions file keeps that cycle closed, so booking sees the mocked createOrder.
vi.mock("@/modules/commerce/actions", () => ({ redeemVoucher: vi.fn() }));
vi.mock("@/modules/commerce/api", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  createOrder: vi.fn(),
  refundOrderLine: vi.fn(),
  cancelOrder: vi.fn(),
}));
vi.mock("@/modules/credits/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), getMembershipForPerson: vi.fn() }));
vi.mock("@/modules/forms/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), hasValidSubmission: vi.fn() }));
vi.mock("@/modules/site/api", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getCurrentLegalVersion: vi.fn(),
  hasAcceptedCurrentTerms: vi.fn(),
  recordTermsAcceptance: vi.fn(),
}));

let h: DbHandle;
let staffUserId: string;

beforeAll(async () => {
  h = await createTestDb();
  staffUserId = (await makeUser(h.db)).id;
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(async () => {
  vi.mocked(createOrder).mockReset().mockImplementation(fakeCreateOrder());
  vi.mocked(refundOrderLine).mockReset().mockResolvedValue({ refundId: randomUUID(), amountCents: 2500 });
  vi.mocked(cancelOrder).mockReset().mockResolvedValue({ cancelled: true });
  vi.mocked(getMembershipForPerson).mockReset().mockResolvedValue({
    isMember: false,
    membershipId: null,
    planProductId: null,
    discountPct: 0,
    status: null,
    periodEndAt: null,
    cancelAt: null,
  });
  vi.mocked(hasValidSubmission).mockReset().mockResolvedValue({ valid: false, completedAt: null, expiresAt: null });
  vi.mocked(getCurrentLegalVersion).mockReset().mockResolvedValue(null);
  vi.mocked(hasAcceptedCurrentTerms).mockReset().mockResolvedValue(true);
  vi.mocked(recordTermsAcceptance).mockReset().mockResolvedValue({ acceptanceId: randomUUID(), created: true });
  await setBookingRules(h.db);
});

const staff = (permissions: string[] = ["bookings.write"]): Actor => staffActor({ userId: staffUserId, permissions });
const system: Actor = { kind: "system", jobId: "test" };
const grantFor = (personId: string, units = 5) =>
  makeCreditGrant(h.db, { personId, units, startsAt: new Date(Date.now() - 30 * DAY), expiresAt: new Date(Date.now() + 60 * DAY) });

function book(actor: Actor, input: Partial<BookSeatsInput> & Pick<BookSeatsInput, "sessionId" | "personId" | "payWith">) {
  const by = actor.kind === "staff" ? "staff" : "customer";
  return inTx(h.db, actor, (tx, ctx) => bookSeats(tx, ctx, { clientKey: randomUUID(), source: by === "staff" ? "admin" : "portal", by, ...input }));
}

/** A customer's credit booking (real ledger) on a new session starting in `startsIn`. */
async function creditBooking(startsIn = 2 * DAY, sessionOver: Parameters<typeof openSession>[1] = {}) {
  const session = await openSession(h.db, { startsAt: new Date(Date.now() + startsIn), ...sessionOver });
  const person = await makePerson(h.db);
  await grantFor(person.id);
  const result = await book(customerActor(person.id), { sessionId: session.id, personId: person.id, payWith: "credit" });
  const booking = await bookingById(h.db, result.bookingIds[0]!);
  return { session, person, booking };
}

function cancel(actor: Actor, input: Partial<CancelBookingInput> & Pick<CancelBookingInput, "bookingId" | "by">) {
  return inTx(h.db, actor, (tx, ctx) => cancelBookingRow(tx, ctx, { includeGuests: true, ...input }));
}

describe("imported credit bookings (R65)", () => {
  it("an imported credit booking cancelled inside the window gives its unit back as a manual grant", async () => {
    const session = await openSession(h.db, { startsAt: new Date(Date.now() + 2 * DAY) });
    const person = await makePerson(h.db);
    const live = await grantFor(person.id);
    const booking = await rawBooking(h.db, { sessionId: session.id, personId: person.id, paidWith: "credit", source: "import", bookedByPersonId: person.id });
    const result = await cancel(customerActor(person.id), { bookingId: booking.id, expectedVersion: booking.version, by: "customer" });
    expect(result).toMatchObject({ status: "cancelled", creditReleased: true });
    expect(await releasesOf(h.db, booking.id)).toEqual([]);
    const restored = (await h.db.select().from(creditGrants).where(and(eq(creditGrants.personId, person.id), eq(creditGrants.source, "manual")))).filter((g) => g.id !== live.id);
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({ creditKind: session.creditKind, unitsGranted: session.creditCost, expiresAt: live.expiresAt });
  });
});

describe("customer cancellation inside the free window (R28)", () => {
  it("tonight path: cancel inside the rules, credit back (cancelled_in_policy), fact, email and waitlist.offer_next", async () => {
    const { session, person, booking } = await creditBooking();
    const result = await cancel(customerActor(person.id), { bookingId: booking.id, expectedVersion: booking.version, by: "customer" });
    expect(result).toMatchObject({ status: "cancelled", creditReleased: true, refundRequested: false, cancelledBookingIds: [booking.id] });
    const row = await bookingById(h.db, booking.id);
    expect(row).toMatchObject({ status: "cancelled", cancelReasonCode: "customer", version: booking.version + 1 });
    expect(row.cancelledAt).not.toBeNull();
    expect(await releasesOf(h.db, booking.id)).toEqual([{ refId: booking.id, quantity: 1, reason: "cancelled_in_policy" }]);
    const facts = await factsOf(h.db, booking.id);
    expect(facts.find((f) => f.kind === "booking.cancelled")).toMatchObject({
      dedupeKey: `booking:${booking.id}:cancelled:${booking.version + 1}`,
      data: { cancel_reason_code: "customer", by: "customer", session_id: session.id },
    });
    const mail = await emailByKey(h.db, `booking:${booking.id}:cancelled`);
    expect(mail?.props).toMatchObject({ reason: "cancelled" });
    expect(await jobsOf(h.db, "waitlist.offer_next", `waitlist:${session.id}:offer_next:${booking.id}`)).toHaveLength(1);
  });

  it("an order-paid row inside the window requests refundOrderLine with cancelled_in_policy", async () => {
    const session = await openSession(h.db, { productId: (await sessionProduct(h.db)).id });
    const { booking, lineId } = await paidOrderBooking(h.db, { sessionId: session.id });
    const result = await cancel(customerActor(booking.personId), { bookingId: booking.id, expectedVersion: 1, by: "customer" });
    expect(result).toMatchObject({ status: "cancelled", refundRequested: true, creditReleased: false });
    expect(vi.mocked(refundOrderLine)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(refundOrderLine).mock.calls[0]![2]).toEqual({ orderLineId: lineId, reason: "cancelled_in_policy" });
  });

  it("a stale version, another person's row and a reserved row are refused", async () => {
    const { person, booking } = await creditBooking();
    await expect(cancel(customerActor(person.id), { bookingId: booking.id, expectedVersion: booking.version + 5, by: "customer" })).rejects.toMatchObject({ reason: "stale_version" });
    const stranger = await makePerson(h.db);
    await expect(cancel(customerActor(stranger.id), { bookingId: booking.id, by: "customer" })).rejects.toMatchObject({ code: "not_found" });

    const session = await openSession(h.db);
    const { booking: reserved } = await unpaidOrderBooking(h.db, { sessionId: session.id });
    await expect(cancel(customerActor(reserved.personId), { bookingId: reserved.id, by: "customer" })).rejects.toMatchObject({ reason: "invalid_transition" });
    expect((await bookingById(h.db, reserved.id)).status).toBe("reserved");
  });
});

describe("late cancellation (R29) and staff force (R32)", () => {
  it("after the free window the row is late_cancelled and the credit stays consumed", async () => {
    const { person, booking } = await creditBooking(10 * HOUR);
    const result = await cancel(customerActor(person.id), { bookingId: booking.id, by: "customer" });
    expect(result).toMatchObject({ status: "late_cancelled", creditReleased: false, refundRequested: false });
    expect(await bookingById(h.db, booking.id)).toMatchObject({ status: "late_cancelled", cancelReasonCode: "customer" });
    expect(await releasesOf(h.db, booking.id)).toEqual([]);
    expect((await factsOf(h.db, booking.id)).map((f) => f.kind)).toContain("booking.late_cancelled");
    expect(await emailByKey(h.db, `booking:${booking.id}:cancelled`)).toBeDefined();
  });

  it("with late_cancel_releases_credit the late cancellation releases with late_cancel_released", async () => {
    await setBookingRules(h.db, { late_cancel_releases_credit: true });
    const { person, booking } = await creditBooking(10 * HOUR);
    const result = await cancel(customerActor(person.id), { bookingId: booking.id, by: "customer" });
    expect(result).toMatchObject({ status: "late_cancelled", creditReleased: true });
    expect(await releasesOf(h.db, booking.id)).toEqual([{ refId: booking.id, quantity: 1, reason: "late_cancel_released" }]);
  });

  it("an order-paid late cancellation is not refunded; events with a null window are never free", async () => {
    const product = await sessionProduct(h.db);
    const event = await openSession(h.db, { kind: "event", creditKind: null, productId: product.id, startsAt: new Date(Date.now() + 20 * DAY) });
    const { booking } = await paidOrderBooking(h.db, { sessionId: event.id });
    const result = await cancel(customerActor(booking.personId), { bookingId: booking.id, by: "customer" });
    expect(result).toMatchObject({ status: "late_cancelled", refundRequested: false });
    expect(vi.mocked(refundOrderLine)).not.toHaveBeenCalled();
  });

  it("after the start a customer can no longer cancel", async () => {
    const started = await openSession(h.db, { startsAt: new Date(Date.now() - HOUR), creditKind: null, creditCost: 0 });
    const booking = await rawBooking(h.db, { sessionId: started.id, source: "portal" });
    await expect(cancel(customerActor(booking.personId), { bookingId: booking.id, by: "customer" })).rejects.toMatchObject({ reason: "outside_window" });
  });

  it("staff without force get the policy result; force needs bookings.override and a reason and releases with staff_override", async () => {
    const { booking } = await creditBooking(10 * HOUR);
    await expect(cancel(staff(), { bookingId: booking.id, by: "staff", force: "release_credit", reason: "ill" })).rejects.toMatchObject({ name: "ForbiddenError", permission: "bookings.override" });
    await expect(cancel(staff(["bookings.write", "bookings.override"]), { bookingId: booking.id, by: "staff", force: "release_credit" })).rejects.toMatchObject({ code: "validation" });
    const result = await cancel(staff(["bookings.write", "bookings.override"]), { bookingId: booking.id, by: "staff", force: "release_credit", reason: "doctor's note" });
    expect(result).toMatchObject({ status: "cancelled", creditReleased: true });
    expect(await bookingById(h.db, booking.id)).toMatchObject({ status: "cancelled", cancelReasonCode: "staff", cancelReason: "doctor's note" });
    expect(await releasesOf(h.db, booking.id)).toEqual([{ refId: booking.id, quantity: 1, reason: "staff_override" }]);

    const late = await creditBooking(10 * HOUR);
    expect(await cancel(staff(), { bookingId: late.booking.id, by: "staff", reason: "phone" })).toMatchObject({ status: "late_cancelled", creditReleased: false });
    // R32: a late_cancelled row converts to cancelled with release only through bookings.override.
    await expect(cancel(staff(), { bookingId: late.booking.id, by: "staff", reason: "phone" })).rejects.toMatchObject({ reason: "invalid_transition" });
    const converted = await cancel(staff(["bookings.write", "bookings.override"]), { bookingId: late.booking.id, by: "staff", force: "release_credit", reason: "goodwill" });
    expect(converted).toMatchObject({ status: "cancelled", creditReleased: true });
    expect(await releasesOf(h.db, late.booking.id)).toEqual([{ refId: late.booking.id, quantity: 1, reason: "staff_override" }]);
  });

  it("staff force refund of an order-paid row outside the window requests the refund", async () => {
    const session = await openSession(h.db, { productId: (await sessionProduct(h.db)).id, startsAt: new Date(Date.now() + 5 * HOUR) });
    const { booking, lineId } = await paidOrderBooking(h.db, { sessionId: session.id });
    const result = await cancel(staff(["bookings.write", "bookings.override"]), { bookingId: booking.id, by: "staff", force: "refund", reason: "session too full" });
    expect(result).toMatchObject({ status: "cancelled", refundRequested: true });
    expect(vi.mocked(refundOrderLine).mock.calls[0]![2]).toMatchObject({ orderLineId: lineId });
  });

  it("staff cancelling a reserved row cancels its unpaid order", async () => {
    const session = await openSession(h.db);
    const { booking, orderId } = await unpaidOrderBooking(h.db, { sessionId: session.id });
    expect(await cancel(staff(), { bookingId: booking.id, by: "staff", reason: "wrong date" })).toMatchObject({ status: "cancelled" });
    expect(vi.mocked(cancelOrder).mock.calls[0]![2]).toMatchObject({ orderId });
  });
});

describe("guests (R30) and shared beds (R13)", () => {
  const free = { creditKind: null, creditCost: 0 } as const;

  it("cancelling the owner cancels the guests too by default, or leaves them with includeGuests false", async () => {
    const session = await openSession(h.db, free);
    const owner = await makePerson(h.db);
    const res = await book(customerActor(owner.id), { sessionId: session.id, personId: owner.id, payWith: "free", guests: [{ firstName: "Gast", lastName: "Een", payWith: "free" }] });
    const [ownerId, guestId] = res.bookingIds;
    const r = await cancel(customerActor(owner.id), { bookingId: ownerId!, by: "customer" });
    expect(r.cancelledBookingIds).toEqual([ownerId, guestId]);
    expect((await bookingsOfSession(h.db, session.id)).map((b) => b.status)).toEqual(["cancelled", "cancelled"]);

    const s2 = await openSession(h.db, free);
    const res2 = await book(customerActor(owner.id), { sessionId: s2.id, personId: owner.id, payWith: "free", guests: [{ firstName: "Gast", lastName: "Twee", payWith: "free" }] });
    await cancel(customerActor(owner.id), { bookingId: res2.bookingIds[0]!, by: "customer", includeGuests: false });
    expect((await bookingById(h.db, res2.bookingIds[1]!)).status).toBe("confirmed");
    // The owner may cancel a guest row alone.
    expect(await cancel(customerActor(owner.id), { bookingId: res2.bookingIds[1]!, by: "customer" })).toMatchObject({ status: "cancelled" });
  });

  it("a sharing guest who stays takes a bed of their own, or the cancellation is refused with session_full", async () => {
    await setBookingRules(h.db, { require_emergency_contact_for_nights: false });
    const night = await openSession(h.db, { kind: "night", capacityBeds: 2, capacitySeats: null, creditKind: null, creditCost: 0, startsAt: new Date(Date.now() + 5 * DAY) });
    const owner = await makePerson(h.db);
    const res = await book(customerActor(owner.id), { sessionId: night.id, personId: owner.id, payWith: "free", guests: [{ firstName: "Partner", lastName: "Een", sharesBed: true, payWith: "free" }] });
    await cancel(customerActor(owner.id), { bookingId: res.bookingIds[0]!, by: "customer", includeGuests: false });
    expect(await bookingById(h.db, res.bookingIds[1]!)).toMatchObject({ status: "confirmed", capacityUnits: 1 });

    const full = await openSession(h.db, { kind: "night", capacityBeds: 1, capacitySeats: null, creditKind: null, creditCost: 0, startsAt: new Date(Date.now() + 5 * DAY) });
    const owner2 = await makePerson(h.db);
    const res2 = await book(customerActor(owner2.id), { sessionId: full.id, personId: owner2.id, payWith: "free", guests: [{ firstName: "Partner", lastName: "Twee", sharesBed: true, payWith: "free" }] });
    await rawBooking(h.db, { sessionId: full.id, isOverCapacity: true });
    await expect(cancel(customerActor(owner2.id), { bookingId: res2.bookingIds[0]!, by: "customer", includeGuests: false })).rejects.toMatchObject({ reason: "session_full" });
    expect((await bookingById(h.db, res2.bookingIds[0]!)).status).toBe("confirmed");
    expect(await cancel(customerActor(owner2.id), { bookingId: res2.bookingIds[0]!, by: "customer", includeGuests: true })).toMatchObject({ status: "cancelled" });
  });
});

describe("session cancellation (R33)", () => {
  it("cancels every live booking with session_cancelled, releases credits, refunds paid lines, cancels unpaid orders and releases the waitlist", async () => {
    const product = await sessionProduct(h.db);
    const session = await openSession(h.db, { productId: product.id, startsAt: new Date(Date.now() + 5 * HOUR) });
    const credit = await makePerson(h.db);
    await grantFor(credit.id);
    const creditRes = await book(customerActor(credit.id), { sessionId: session.id, personId: credit.id, payWith: "credit" });
    const paid = await paidOrderBooking(h.db, { sessionId: session.id });
    const unpaid = await unpaidOrderBooking(h.db, { sessionId: session.id });
    const waiting = await waitEntry(h.db, { sessionId: session.id });
    const offered = await waitEntry(h.db, { sessionId: session.id, state: "offered" });

    const result = await inTx(h.db, staff(["bookings.write", "bookings.override"]), (tx, ctx) => cancelSessionRow(tx, ctx, { sessionId: session.id, reason: "teacher ill", notify: true }));
    expect(result).toMatchObject({ cancelledBookings: 3, refundsRequested: 1, creditsReleased: 1, ordersCancelled: 1, releasedEntries: 2, queuedBookings: 0 });
    const rows = await bookingsOfSession(h.db, session.id);
    expect(rows.every((b) => b.status === "cancelled" && b.cancelReasonCode === "session_cancelled")).toBe(true);
    expect(await releasesOf(h.db, creditRes.bookingIds[0]!)).toEqual([{ refId: creditRes.bookingIds[0]!, quantity: 1, reason: "session_cancelled" }]);
    expect(vi.mocked(refundOrderLine).mock.calls.map((c) => c[2])).toEqual([{ orderLineId: paid.lineId, reason: "session_cancelled" }]);
    expect(vi.mocked(cancelOrder).mock.calls.map((c) => c[2].orderId)).toEqual([unpaid.orderId]);
    const entries = await h.db.select().from(waitlistEntries).where(eq(waitlistEntries.sessionId, session.id));
    expect(entries.map((e) => [e.id, e.state, e.endedReason]).sort()).toEqual(
      [
        [waiting.id, "released", "session_cancelled"],
        [offered.id, "released", "session_cancelled"],
      ].sort(),
    );
    expect(await emailByKey(h.db, `booking:${paid.booking.id}:cancelled`)).toMatchObject({ props: { refunded: true, creditReleased: false } });
    expect(await emailByKey(h.db, `booking:${creditRes.bookingIds[0]}:cancelled`)).toMatchObject({ props: { refunded: false, creditReleased: true } });
    expect((await factsOf(h.db, paid.booking.id)).find((f) => f.kind === "booking.cancelled")?.data).toMatchObject({ by: "beam", cancel_reason_code: "session_cancelled" });
    // A cancelled session offers nothing.
    expect(await jobsOf(h.db, "waitlist.offer_next", `waitlist:${session.id}:offer_next:${paid.booking.id}`)).toHaveLength(0);
    await expect(inTx(h.db, staff(["bookings.override"]), (tx, ctx) => cancelSessionRow(tx, ctx, { sessionId: session.id, reason: "again", notify: true }))).rejects.toMatchObject({
      reason: "invalid_transition",
    });
  });

  it("notify false sends no session_cancelled email", async () => {
    const session = await openSession(h.db, free());
    const b = await rawBooking(h.db, { sessionId: session.id });
    await inTx(h.db, staff(["bookings.override"]), (tx, ctx) => cancelSessionRow(tx, ctx, { sessionId: session.id, reason: "storm", notify: false }));
    expect((await bookingById(h.db, b.id)).status).toBe("cancelled");
    expect(await emailByKey(h.db, `booking:${b.id}:cancelled`)).toBeUndefined();
  });

  it("above 50 live bookings the session is cancelled at once and the bookings in chunks of 50 by sessions.cancel_bookings", async () => {
    const session = await openSession(h.db, { ...free(), capacitySeats: 80 });
    for (let i = 0; i < SESSION_CANCEL_CHUNK + 5; i++) await rawBooking(h.db, { sessionId: session.id });
    const result = await inTx(h.db, staff(["bookings.override"]), (tx, ctx) => cancelSessionRow(tx, ctx, { sessionId: session.id, reason: "closed", notify: false }));
    expect(result).toMatchObject({ cancelledBookings: 0, queuedBookings: SESSION_CANCEL_CHUNK + 5 });
    expect(await jobsOf(h.db, "sessions.cancel_bookings", `cancel_session:${session.id}:start`)).toHaveLength(1);
    const first = await inTx(h.db, system, (tx, ctx) => cancelSessionChunk(tx, ctx, { sessionId: session.id, notify: false }));
    expect(first.cancelledBookings).toBe(SESSION_CANCEL_CHUNK);
    expect(first.nextAfterBookingId).not.toBeNull();
    const second = await inTx(h.db, system, (tx, ctx) => cancelSessionChunk(tx, ctx, { sessionId: session.id, afterBookingId: first.nextAfterBookingId!, notify: false }));
    expect(second).toMatchObject({ cancelledBookings: 5, nextAfterBookingId: null });
    expect((await bookingsOfSession(h.db, session.id)).every((b) => b.status === "cancelled")).toBe(true);
  });

  function free() {
    return { creditKind: null, creditCost: 0 } as const;
  }
});

describe("commerce refund of a session line (cancelBookingsForOrderLine)", () => {
  it("cancels the line's live rows with refunded, frees the seat and never refunds twice", async () => {
    const session = await openSession(h.db, { productId: (await sessionProduct(h.db)).id });
    const { booking, lineId } = await paidOrderBooking(h.db, { sessionId: session.id });
    const first = await inTx(h.db, staff(["commerce.refund"]), (tx, ctx) => cancelBookingsForOrderLine(tx, ctx, { orderLineId: lineId, reason: "refunded" }));
    expect(first).toEqual({ cancelledBookingIds: [booking.id] });
    expect(await bookingById(h.db, booking.id)).toMatchObject({ status: "cancelled", cancelReasonCode: "refunded" });
    expect(vi.mocked(refundOrderLine)).not.toHaveBeenCalled();
    expect(await emailByKey(h.db, `booking:${booking.id}:cancelled`)).toMatchObject({ props: { reason: "cancelled" } });
    expect(await jobsOf(h.db, "waitlist.offer_next", `waitlist:${session.id}:offer_next:${booking.id}`)).toHaveLength(1);
    const second = await inTx(h.db, staff(["commerce.refund"]), (tx, ctx) => cancelBookingsForOrderLine(tx, ctx, { orderLineId: lineId, reason: "refunded" }));
    expect(second).toEqual({ cancelledBookingIds: [] });
    expect(await h.db.select().from(bookings).where(eq(bookings.orderLineId, lineId))).toHaveLength(1);
  });
});
