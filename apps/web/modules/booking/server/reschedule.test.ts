import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import { makeCreditGrant } from "@beam/db/testing/credits-factories";
import type { Actor } from "@/lib/ctx";
import { resetRuntime, staffActor } from "@/lib/testing";
import { createOrder, refundOrderLine } from "@/modules/commerce/api";
import { getMembershipForPerson } from "@/modules/credits/api";
import { hasValidSubmission } from "@/modules/forms/api";
import { getCurrentLegalVersion, hasAcceptedCurrentTerms } from "@/modules/site/api";
import { bookSeats, type BookSeatsInput } from "./book";
import { DAY, customerActor, fakeCreateOrder, inTx, openSession, sessionProduct, setBookingRules } from "./booking-p3a.fixtures";
import { bookingById, consumesOf, emailByKey, emailsOfBooking, factsOf, jobsOf, paidOrderBooking, releasesOf } from "./booking-p3b.fixtures";
import { rescheduleRow, type RescheduleInput } from "./reschedule";

vi.mock("@/modules/commerce/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), createOrder: vi.fn(), refundOrderLine: vi.fn() }));
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
  vi.mocked(refundOrderLine).mockReset();
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
  await setBookingRules(h.db);
});

const staff = (permissions: string[] = ["bookings.write"]): Actor => staffActor({ userId: staffUserId, permissions });
const inDays = (d: number) => ({ startsAt: new Date(Date.now() + d * DAY) });

function book(actor: Actor, input: Partial<BookSeatsInput> & Pick<BookSeatsInput, "sessionId" | "personId" | "payWith">) {
  return inTx(h.db, actor, (tx, ctx) => bookSeats(tx, ctx, { clientKey: randomUUID(), source: "portal", by: "customer", ...input }));
}
const move = (actor: Actor, input: Omit<RescheduleInput, "by"> & { by?: RescheduleInput["by"] }) =>
  inTx(h.db, actor, (tx, ctx) => rescheduleRow(tx, ctx, { by: actor.kind === "staff" ? "staff" : "customer", ...input }));

async function creditBooking(startsInDays = 3) {
  const session = await openSession(h.db, inDays(startsInDays));
  const person = await makePerson(h.db);
  await makeCreditGrant(h.db, { personId: person.id, units: 5, startsAt: new Date(Date.now() - 30 * DAY), expiresAt: new Date(Date.now() + 60 * DAY) });
  const res = await book(customerActor(person.id), { sessionId: session.id, personId: person.id, payWith: "credit" });
  return { session, person, booking: await bookingById(h.db, res.bookingIds[0]!) };
}

describe("reschedule (R31)", () => {
  it("moves a credit booking: old cancelled (rescheduled), new confirmed, credit released and consumed again, three facts, one email", async () => {
    const { session, person, booking } = await creditBooking();
    const target = await openSession(h.db, inDays(5));
    const { newBookingId } = await move(customerActor(person.id), { bookingId: booking.id, expectedVersion: booking.version, targetSessionId: target.id });

    const old = await bookingById(h.db, booking.id);
    expect(old).toMatchObject({ status: "cancelled", cancelReasonCode: "rescheduled" });
    const next = await bookingById(h.db, newBookingId);
    expect(next).toMatchObject({ sessionId: target.id, personId: person.id, status: "confirmed", paidWith: "credit", rescheduledFromBookingId: booking.id });
    expect(next.checkinCode).not.toBe(booking.checkinCode);

    expect(await releasesOf(h.db, booking.id)).toEqual([{ refId: booking.id, quantity: 1, reason: "rescheduled" }]);
    const consumes = await consumesOf(h.db, newBookingId);
    expect(consumes).toHaveLength(1);
    expect(consumes[0]!.idempotencyKey).not.toBe((await consumesOf(h.db, booking.id))[0]!.idempotencyKey);

    const oldFacts = await factsOf(h.db, booking.id);
    expect(oldFacts.find((f) => f.kind === "booking.rescheduled")?.data).toMatchObject({ rescheduled_from_booking_id: booking.id, new_booking_id: newBookingId, session_id: session.id });
    expect(oldFacts.find((f) => f.kind === "booking.cancelled")?.data).toMatchObject({ cancel_reason_code: "rescheduled", by: "customer" });
    const newFacts = await factsOf(h.db, newBookingId);
    // The first booking stays first: the old row's is_first_booking is carried over.
    expect(newFacts.find((f) => f.kind === "booking.confirmed")?.data).toMatchObject({ rescheduled_from_booking_id: booking.id, is_first_booking: true, session_id: target.id });

    expect(await emailsOfBooking(h.db, booking.id)).toHaveLength(1); // only the original confirmation
    expect(await emailByKey(h.db, `booking:${booking.id}:cancelled`)).toBeUndefined();
    const mail = await emailByKey(h.db, `booking:${newBookingId}:confirmed`);
    expect(mail?.props).toMatchObject({ oldDate: expect.any(String), date: expect.any(String) });
    expect(mail?.attachments).toEqual([{ fileId: next.qrFileId, filename: "checkin-qr.png", inline: true }]);
    expect(await jobsOf(h.db, "waitlist.offer_next", `waitlist:${session.id}:offer_next:${booking.id}`)).toHaveLength(1);
  });

  it("customers only inside the free window; staff may move outside it", async () => {
    const { person, booking } = await creditBooking(0.5);
    const target = await openSession(h.db, inDays(4));
    await expect(move(customerActor(person.id), { bookingId: booking.id, expectedVersion: booking.version, targetSessionId: target.id })).rejects.toMatchObject({ reason: "outside_window" });
    const { newBookingId } = await move(staff(), { bookingId: booking.id, expectedVersion: booking.version, targetSessionId: target.id, reason: "asked by phone" });
    expect(await bookingById(h.db, booking.id)).toMatchObject({ status: "cancelled", cancelReasonCode: "rescheduled", cancelReason: "asked by phone" });
    expect((await factsOf(h.db, booking.id)).find((f) => f.kind === "booking.cancelled")?.data).toMatchObject({ by: "staff" });
    expect((await bookingById(h.db, newBookingId)).status).toBe("confirmed");
  });

  it("refuses another kind and a stale version", async () => {
    const { person, booking } = await creditBooking();
    const night = await openSession(h.db, { kind: "night", ...inDays(5) });
    await expect(move(customerActor(person.id), { bookingId: booking.id, expectedVersion: booking.version, targetSessionId: night.id })).rejects.toMatchObject({
      code: "validation",
      fields: { targetSessionId: "different_kind" },
    });
    const target = await openSession(h.db, inDays(5));
    await expect(move(customerActor(person.id), { bookingId: booking.id, expectedVersion: booking.version + 1, targetSessionId: target.id })).rejects.toMatchObject({ reason: "stale_version" });
  });

  it("an order-paid row keeps its order line, needs the same product, and is never refunded", async () => {
    const product = await sessionProduct(h.db);
    const session = await openSession(h.db, { productId: product.id, ...inDays(3) });
    const { booking, lineId } = await paidOrderBooking(h.db, { sessionId: session.id });
    const other = await openSession(h.db, { productId: (await sessionProduct(h.db)).id, ...inDays(4) });
    await expect(move(customerActor(booking.personId), { bookingId: booking.id, expectedVersion: 1, targetSessionId: other.id })).rejects.toMatchObject({
      fields: { targetSessionId: "different_product" },
    });
    // Staff: across products needs bookings.override.
    await expect(move(staff(), { bookingId: booking.id, expectedVersion: 1, targetSessionId: other.id, reason: "x" })).rejects.toMatchObject({ fields: { targetSessionId: "different_product" } });
    const same = await openSession(h.db, { productId: product.id, ...inDays(4) });
    const { newBookingId } = await move(customerActor(booking.personId), { bookingId: booking.id, expectedVersion: 1, targetSessionId: same.id });
    expect(await bookingById(h.db, newBookingId)).toMatchObject({ paidWith: "order", orderLineId: lineId, status: "confirmed" });
    expect(vi.mocked(refundOrderLine)).not.toHaveBeenCalled();
    const acrossOk = await move(staff(["bookings.write", "bookings.override"]), { bookingId: newBookingId, expectedVersion: 1, targetSessionId: other.id, reason: "upgrade" });
    expect((await bookingById(h.db, acrossOk.newBookingId)).orderLineId).toBe(lineId);
  });

  it("stops at max_reschedules_per_booking along the chain (customers)", async () => {
    await setBookingRules(h.db, { max_reschedules_per_booking: 2 });
    const { person, booking } = await creditBooking();
    const a = await openSession(h.db, inDays(4));
    const b = await openSession(h.db, inDays(5));
    const c = await openSession(h.db, inDays(6));
    const first = await move(customerActor(person.id), { bookingId: booking.id, expectedVersion: 1, targetSessionId: a.id });
    const second = await move(customerActor(person.id), { bookingId: first.newBookingId, expectedVersion: 1, targetSessionId: b.id });
    await expect(move(customerActor(person.id), { bookingId: second.newBookingId, expectedVersion: 1, targetSessionId: c.id })).rejects.toMatchObject({
      fields: { targetSessionId: "too_many" },
    });
  });

  it("moves the guests with the owner and refuses a full target", async () => {
    const free = { creditKind: null, creditCost: 0 } as const;
    const session = await openSession(h.db, { ...free, ...inDays(3) });
    const owner = await makePerson(h.db);
    const res = await book(customerActor(owner.id), { sessionId: session.id, personId: owner.id, payWith: "free", guests: [{ firstName: "Gast", lastName: "Een", payWith: "free" }] });
    const small = await openSession(h.db, { ...free, capacitySeats: 1, ...inDays(4) });
    await expect(move(customerActor(owner.id), { bookingId: res.bookingIds[0]!, expectedVersion: 1, targetSessionId: small.id })).rejects.toMatchObject({ reason: "session_full" });
    const target = await openSession(h.db, { ...free, ...inDays(4) });
    const moved = await move(customerActor(owner.id), { bookingId: res.bookingIds[0]!, expectedVersion: 1, targetSessionId: target.id });
    expect(moved.bookingIds).toHaveLength(2);
    const guest = await bookingById(h.db, moved.bookingIds[1]!);
    expect(guest).toMatchObject({ guestOfBookingId: moved.newBookingId, rescheduledFromBookingId: res.bookingIds[1], status: "confirmed" });
    expect((await bookingById(h.db, res.bookingIds[1]!)).cancelReasonCode).toBe("rescheduled");
  });
});
