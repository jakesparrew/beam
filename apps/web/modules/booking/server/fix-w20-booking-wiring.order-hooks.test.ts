import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { activityEvents, jobs, waitlistEntries } from "@beam/db/schema";
import { createTestDb, makePerson } from "@beam/db/testing";
import { and, eq, type Actor } from "@/lib/ctx";
import { resetRuntime } from "@/lib/testing";
import { createOrder } from "@/modules/commerce/api";
import { getMembershipForPerson } from "@/modules/credits/api";
import { releaseBookingsForOrder } from "../api/bookings";
import { bookSeats } from "./book";
import { customerActor, fakeCreateOrder, inTx, openSession, sessionProduct, setBookingRules } from "./booking-p3a.fixtures";

// commerce's api barrel re-exports `redeemVoucher` from its actions, whose import graph reaches booking's
// book.ts: stubbing the actions file keeps that cycle closed, so booking sees the mocked createOrder.
vi.mock("@/modules/commerce/actions", () => ({ redeemVoucher: vi.fn() }));
vi.mock("@/modules/commerce/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), createOrder: vi.fn() }));
vi.mock("@/modules/credits/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), getMembershipForPerson: vi.fn() }));
vi.mock("@/modules/site/api", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getCurrentLegalVersion: vi.fn().mockResolvedValue(null),
  hasAcceptedCurrentTerms: vi.fn().mockResolvedValue(true),
  recordTermsAcceptance: vi.fn(),
}));

let h: DbHandle;
const system: Actor = { kind: "system", jobId: "" };

beforeAll(async () => {
  h = await createTestDb();
  await setBookingRules(h.db);
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(() => {
  vi.mocked(createOrder).mockReset().mockImplementation(fakeCreateOrder());
  vi.mocked(getMembershipForPerson).mockReset().mockResolvedValue({ isMember: false, membershipId: null, planProductId: null, discountPct: 0, status: null, periodEndAt: null, cancelAt: null });
});

/** A claimed waitlist offer: the owner's order-paid `reserved` row linked to an `offered` entry. */
async function claimedOffer() {
  const product = await sessionProduct(h.db);
  const session = await openSession(h.db, { productId: product.id, creditKind: null, creditCost: 0, capacitySeats: 10 });
  const owner = await makePerson(h.db);
  const result = await inTx(h.db, customerActor(owner.id), (tx, ctx) =>
    bookSeats(tx, ctx, { sessionId: session.id, personId: owner.id, payWith: "order", clientKey: randomUUID(), source: "waitlist", by: "customer" }),
  );
  if (result.kind !== "checkout") throw new Error("expected a checkout");
  const [entry] = await h.db
    .insert(waitlistEntries)
    .values({ sessionId: session.id, personId: owner.id, state: "offered", offeredAt: new Date(), offerExpiresAt: new Date(Date.now() + 3_600_000), offersCount: 1, bookingId: result.bookingIds[0]! })
    .returning();
  return { session, owner, orderId: result.orderId, bookingId: result.bookingIds[0]!, entry: entry! };
}

describe("releaseOrderBookings and a claimed waitlist offer (R44)", () => {
  it.each(["payment_expired", "payment_failed", "order_cancelled"] as const)("%s: the offered entry ends expired (payment_not_completed) and the seat goes to the waitlist", async (reason) => {
    const { session, owner, orderId, bookingId, entry } = await claimedOffer();
    const result = await inTx(h.db, system, (tx, ctx) => releaseBookingsForOrder(tx, ctx, { orderId, reason }));
    expect(result.releasedBookingIds).toEqual([bookingId]);

    const [after] = await h.db.select().from(waitlistEntries).where(eq(waitlistEntries.id, entry.id));
    expect(after).toMatchObject({ state: "expired", endedReason: "payment_not_completed" });
    const facts = await h.db.select().from(activityEvents).where(and(eq(activityEvents.kind, "waitlist.expired"), eq(activityEvents.personId, owner.id)));
    expect(facts).toHaveLength(1);
    expect(facts[0]!.data).toMatchObject({ booking_id: bookingId, ended_reason: "payment_not_completed" });
    const offers = await h.db.select().from(jobs).where(eq(jobs.idempotencyKey, `waitlist:${session.id}:offer_next:${bookingId}`));
    expect(offers).toHaveLength(1);

    // A second release changes nothing.
    expect((await inTx(h.db, system, (tx, ctx) => releaseBookingsForOrder(tx, ctx, { orderId, reason }))).releasedBookingIds).toEqual([]);
    expect(await h.db.select().from(activityEvents).where(and(eq(activityEvents.kind, "waitlist.expired"), eq(activityEvents.personId, owner.id)))).toHaveLength(1);
  });

  it("leaves an entry of another booking alone", async () => {
    const { orderId, session } = await claimedOffer();
    const other = await makePerson(h.db);
    const [waiting] = await h.db.insert(waitlistEntries).values({ sessionId: session.id, personId: other.id, state: "waiting" }).returning();
    await inTx(h.db, system, (tx, ctx) => releaseBookingsForOrder(tx, ctx, { orderId, reason: "payment_expired" }));
    const [after] = await h.db.select().from(waitlistEntries).where(eq(waitlistEntries.id, waiting!.id));
    expect(after!.state).toBe("waiting");
  });
});
