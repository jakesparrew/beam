import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { bookings, sessions, vSessionAvailability, waitlistEntries } from "@beam/db/schema";
import { createTestDb, makePerson } from "@beam/db/testing";
import { makeCreditGrant } from "@beam/db/testing/credits-factories";
import { claimToken, hashToken } from "@beam/core/booking";
import { eq, setAppDb, type Actor } from "@/lib/ctx";
import { resetRuntime } from "@/lib/testing";
import { createOrder } from "@/modules/commerce/api";
import { GET, POST } from "@/app/api/public/claim/[token]/route";
import { customerActor, inTx, setBookingRules } from "./booking-p3a.fixtures";
import { DAY, HOUR, MIN, emailByKey, entryById, entryFacts, factoryCreateOrder, fullSession, offeredEntry, sessionProduct } from "./booking-p5.fixtures";
import { expireReservedRow } from "./cancel";
import { SignInRequiredError, claimKey, claimSeatRow } from "./claim";
import { confirmOrderBookings } from "./order-hooks";

// commerce's api barrel re-exports `redeemVoucher` from its actions, whose import graph reaches booking's
// book.ts: stubbing the actions file keeps that cycle closed, so booking sees the mocked createOrder.
vi.mock("@/modules/commerce/actions", () => ({ redeemVoucher: vi.fn() }));
vi.mock("@/modules/commerce/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), createOrder: vi.fn() }));

let h: DbHandle;

beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(async () => {
  vi.mocked(createOrder).mockReset().mockImplementation(factoryCreateOrder());
  await setBookingRules(h.db);
});

const publicActor: Actor = { kind: "public" };
const claim = (actor: Actor, token: string, payWith?: "credit" | "order", now?: Date) =>
  inTx(h.db, actor, (tx, ctx) => claimSeatRow(tx, ctx, { token, ...(payWith ? { payWith } : {}) }), now);
const grant = (personId: string) => makeCreditGrant(h.db, { personId, units: 3, startsAt: new Date(Date.now() - 30 * DAY), expiresAt: new Date(Date.now() + 60 * DAY) });

/** A full session whose only seat is held by the person's live offer. */
async function offerSetup(sessionOverrides: NonNullable<NonNullable<Parameters<typeof fullSession>[1]>["overrides"]> = {}) {
  const { session } = await fullSession(h.db, { seats: 1, overrides: sessionOverrides });
  await h.db.update(bookings).set({ status: "cancelled", cancelledAt: new Date(), cancelReasonCode: "customer" }).where(eq(bookings.sessionId, session.id));
  const person = await makePerson(h.db);
  const { entry, token } = await offeredEntry(h.db, session.id, { personId: person.id });
  return { session, person, entry, token };
}

const availability = async (sessionId: string) => (await h.db.select().from(vSessionAvailability).where(eq(vSessionAvailability.sessionId, sessionId)))[0]!;

describe("GET /api/public/claim/[token] (R44, edge case 9)", () => {
  it("redirects to the claim page in the person's locale and changes nothing", async () => {
    const { entry, token } = await offerSetup();
    const before = await entryById(h.db, entry.id);
    const res = await GET(new Request("http://localhost/api/public/claim/x"), { params: Promise.resolve({ token }) });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toMatch(new RegExp(`/nl/claim/${token}$`));
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await entryById(h.db, entry.id)).toEqual(before);
  });

  it("sends an unknown token to the invalid page; POST is not served", async () => {
    const res = await GET(new Request("http://localhost/api/public/claim/x"), { params: Promise.resolve({ token: "not-a-real-token-000000000000" }) });
    expect(res.headers.get("location")).toMatch(/\/nl\/claim\/invalid$/);
    expect(POST().status).toBe(405);
  });
});

describe("claimSeatRow (R44)", () => {
  it("claims once with credits: confirmed booking from the waitlist, confirmed entry, seat_claimed email; a second call returns the same booking", async () => {
    const { session, person, entry, token } = await offerSetup();
    await grant(person.id);
    const first = await claim(publicActor, token);
    expect(first).toHaveProperty("bookingId");
    const bookingId = (first as { bookingId: string }).bookingId;
    const [row] = await h.db.select().from(bookings).where(eq(bookings.id, bookingId));
    expect(row).toMatchObject({ status: "confirmed", paidWith: "credit", source: "waitlist", personId: person.id, bookedByPersonId: person.id });
    expect(await entryById(h.db, entry.id)).toMatchObject({ state: "confirmed", bookingId });
    expect((await entryFacts(h.db, entry.id)).map((f) => f.kind)).toContain("waitlist.confirmed");
    expect(await emailByKey(h.db, `booking:${bookingId}:confirmed`)).toBeDefined();

    expect(await claim(publicActor, token)).toEqual({ bookingId });
    expect(await h.db.select().from(bookings).where(eq(bookings.sessionId, session.id))).toHaveLength(2); // the cancelled seat and the claim
    expect((await availability(session.id)).availableTotal).toBe(0);
  });

  it("books a free session as free", async () => {
    const { token } = await offerSetup({ creditKind: null, creditCost: 0, productId: null });
    const result = (await claim(publicActor, token)) as { bookingId: string };
    expect((await h.db.select().from(bookings).where(eq(bookings.id, result.bookingId)))[0]!.paidWith).toBe("free");
  });

  it("refuses an expired token and a superseded token (outside_window) and changes nothing", async () => {
    const { session } = await offerSetup();
    const person = await makePerson(h.db);
    const { entry: late, token: lateToken } = await offeredEntry(h.db, session.id, { personId: person.id, offerExpiresAt: new Date(Date.now() - MIN) });
    await expect(claim(publicActor, lateToken)).rejects.toMatchObject({ reason: "outside_window" });
    expect((await entryById(h.db, late.id)).bookingId).toBeNull();

    const other = await makePerson(h.db);
    const { entry: renewed } = await offeredEntry(h.db, session.id, { personId: other.id, offersCount: 2 });
    const oldToken = claimToken(claimKey(), renewed.id, 1);
    expect(renewed.claimTokenHash).toBe(hashToken(claimToken(claimKey(), renewed.id, 2)));
    await expect(claim(publicActor, oldToken)).rejects.toMatchObject({ reason: "outside_window" });
  });

  it("refuses a claim while staff closed the session (session_closed); the offer stays", async () => {
    const { session, person, entry, token } = await offerSetup();
    await grant(person.id);
    await h.db.update(sessions).set({ status: "closed" }).where(eq(sessions.id, session.id));
    await expect(claim(publicActor, token)).rejects.toMatchObject({ reason: "session_closed" });
    expect((await entryById(h.db, entry.id)).state).toBe("offered");
  });

  it("a paid claim without the person's portal session asks for sign-in and changes nothing; after sign-in it reserves and redirects to checkout", async () => {
    const product = await sessionProduct(h.db);
    const { session, person, entry, token } = await offerSetup({ productId: product.id });
    await expect(claim(publicActor, token)).rejects.toBeInstanceOf(SignInRequiredError);
    await expect(claim(customerActor((await makePerson(h.db)).id), token)).rejects.toMatchObject({ code: "unauthorized", message: "sign_in_required" });
    expect(await entryById(h.db, entry.id)).toMatchObject({ state: "offered", bookingId: null });
    expect(await h.db.select().from(bookings).where(eq(bookings.personId, person.id))).toHaveLength(0);
    expect(createOrder).not.toHaveBeenCalled();

    const result = (await claim(customerActor(person.id), token)) as { orderId: string; redirectTo: string };
    expect(result.redirectTo).toBe(`/nl/account/checkout/${result.orderId}`);
    const claimed = await entryById(h.db, entry.id);
    expect(claimed.state).toBe("offered");
    const [reserved] = await h.db.select().from(bookings).where(eq(bookings.id, claimed.bookingId!));
    expect(reserved).toMatchObject({ status: "reserved", paidWith: "order", source: "waitlist" });
    expect(reserved!.orderLineId).not.toBeNull();
    // The reserved row holds the seat instead of the offer.
    const v = await availability(session.id);
    expect(Number(v.liveOffers)).toBe(0);
    expect(Number(v.booked)).toBe(1);
    expect(await claim(customerActor(person.id), token)).toEqual(result);
  });

  it("a paid claim becomes confirmed when the order is paid", async () => {
    const product = await sessionProduct(h.db);
    const { person, entry, token } = await offerSetup({ productId: product.id });
    const { orderId } = (await claim(customerActor(person.id), token)) as { orderId: string };
    await inTx(h.db, { kind: "webhook", provider: "mollie" }, (tx, ctx) => confirmOrderBookings(tx, ctx, orderId));
    const done = await entryById(h.db, entry.id);
    expect(done.state).toBe("confirmed");
    expect((await h.db.select().from(bookings).where(eq(bookings.id, done.bookingId!)))[0]!.status).toBe("confirmed");
  });

  it("when the reservation lapses unpaid the entry becomes expired with payment_not_completed", async () => {
    const product = await sessionProduct(h.db);
    const { person, entry, token } = await offerSetup({ productId: product.id });
    await claim(customerActor(person.id), token);
    const { bookingId } = await entryById(h.db, entry.id);
    await inTx(h.db, { kind: "system", jobId: "test" }, (tx, ctx) => expireReservedRow(tx, ctx, bookingId!), new Date(Date.now() + HOUR));
    expect(await entryById(h.db, entry.id)).toMatchObject({ state: "expired", endedReason: "payment_not_completed" });
    await expect(claim(customerActor(person.id), token)).rejects.toMatchObject({ reason: "outside_window" });
    expect((await h.db.select().from(waitlistEntries).where(eq(waitlistEntries.id, entry.id)))[0]!.bookingId).toBe(bookingId);
  });
});
