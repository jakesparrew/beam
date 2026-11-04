import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { activityEvents, bookings, emailMessages, jobs, orders, waitlistEntries } from "@beam/db/schema";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import { and, asc, eq, sql, type Actor } from "@/lib/ctx";
import { resetRuntime, staffActor } from "@/lib/testing";
import { createOrder } from "@/modules/commerce/api";
import { getMembershipForPerson } from "@/modules/credits/api";
import { confirmBookingsForOrder, createBookingForPosLine, releaseBookingsForOrder } from "../api/bookings";
import { bookSeats } from "./book";
import { customerActor, fakeCreateOrder, inTx, openSession, posOrderLine, sessionProduct, setBookingRules } from "./booking-p3a.fixtures";
import { linkOrderLines } from "./order-hooks";

vi.mock("@/modules/commerce/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), createOrder: vi.fn() }));
vi.mock("@/modules/credits/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), getMembershipForPerson: vi.fn() }));
vi.mock("@/modules/site/api", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getCurrentLegalVersion: vi.fn().mockResolvedValue(null),
  hasAcceptedCurrentTerms: vi.fn().mockResolvedValue(true),
  recordTermsAcceptance: vi.fn(),
}));

let h: DbHandle;
let staff: Actor;
const system: Actor = { kind: "system", jobId: "" };

beforeAll(async () => {
  h = await createTestDb();
  staff = staffActor({ userId: (await makeUser(h.db)).id, permissions: ["bookings.write", "commerce.pos"] });
  await setBookingRules(h.db);
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(() => {
  vi.mocked(createOrder).mockReset().mockImplementation(fakeCreateOrder());
  vi.mocked(getMembershipForPerson).mockReset().mockResolvedValue({
    isMember: false,
    membershipId: null,
    planProductId: null,
    discountPct: 0,
    status: null,
    periodEndAt: null,
    cancelAt: null,
  });
});

/** An order-paid portal booking of the owner plus `guests` guests; returns the order and rows. */
async function orderBooking(opts: { capacitySeats?: number; guests?: number } = {}) {
  const product = await sessionProduct(h.db);
  const session = await openSession(h.db, { productId: product.id, creditKind: null, creditCost: 0, capacitySeats: opts.capacitySeats ?? 10 });
  const owner = await makePerson(h.db);
  const guests = Array.from({ length: opts.guests ?? 0 }, (_, i) => ({ firstName: `G${i}`, lastName: "Gast", payWith: "order" as const }));
  const result = await inTx(h.db, customerActor(owner.id), (tx, ctx) =>
    bookSeats(tx, ctx, { sessionId: session.id, personId: owner.id, payWith: "order", guests, clientKey: randomUUID(), source: "portal", by: "customer" }),
  );
  if (result.kind !== "checkout") throw new Error("expected a checkout");
  return { session, owner, orderId: result.orderId, bookingIds: result.bookingIds, product };
}
const rowsOf = (sessionId: string) => h.db.select().from(bookings).where(eq(bookings.sessionId, sessionId)).orderBy(asc(bookings.createdAt));
const confirm = (orderId: string) => inTx(h.db, system, (tx, ctx) => confirmBookingsForOrder(tx, ctx, { orderId }));

describe("linkOrderLines (R18)", () => {
  it("sets order_line_id and reserved_until = orders.expires_at on every reserved row", async () => {
    const { session, orderId } = await orderBooking({ guests: 2 });
    const [order] = await h.db.select().from(orders).where(eq(orders.id, orderId));
    const rows = await rowsOf(session.id);
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.orderLineId).not.toBeNull();
      expect(r.reservedUntil!.getTime()).toBe(order!.expiresAt!.getTime());
    }
  });

  it("refuses a row and line count mismatch, and the database refuses a committed order-paid row without a line", async () => {
    await expect(inTx(h.db, system, (tx) => linkOrderLines(tx, [{ id: randomUUID() }], []))).rejects.toThrow(/1 rows but 0 order lines/);
    const session = await openSession(h.db);
    const person = await makePerson(h.db);
    await expect(h.db.insert(bookings).values({ sessionId: session.id, personId: person.id, status: "confirmed", paidWith: "order", source: "admin" })).rejects.toThrow();
    const [lineless] = await h.db
      .select({ n: sql<number>`count(*)::int` })
      .from(bookings)
      .where(and(eq(bookings.paidWith, "order"), sql`${bookings.orderLineId} is null`, sql`${bookings.status} <> 'reserved'`));
    expect(lineless!.n).toBe(0);
  });
});

describe("confirmBookingsForOrder", () => {
  it("confirms every reserved row once; a second call is idempotent", async () => {
    const { session, owner, orderId, bookingIds } = await orderBooking({ guests: 1 });
    const first = await confirm(orderId);
    expect([...first.confirmedBookingIds].sort()).toEqual([...bookingIds].sort());
    expect(first.unavailableOrderLineIds).toEqual([]);
    const second = await confirm(orderId);
    expect(second).toEqual(first);
    const rows = await rowsOf(session.id);
    expect(rows.map((r) => [r.status, r.reservedUntil, r.version])).toEqual(rows.map(() => ["confirmed", null, 2]));
    const facts = await h.db.select().from(activityEvents).where(and(eq(activityEvents.kind, "booking.confirmed"), eq(activityEvents.personId, owner.id)));
    expect(facts).toHaveLength(1);
    const ownerRow = rows.find((r) => r.personId === owner.id)!;
    expect(await h.db.select().from(emailMessages).where(eq(emailMessages.idempotencyKey, `booking:${ownerRow.id}:confirmed`))).toHaveLength(1);
  });

  it("confirms a linked offered waitlist entry (R44)", async () => {
    const { session, owner, orderId, bookingIds } = await orderBooking();
    const [entry] = await h.db
      .insert(waitlistEntries)
      .values({ sessionId: session.id, personId: owner.id, state: "offered", offeredAt: new Date(), offerExpiresAt: new Date(Date.now() + 3_600_000), offersCount: 1, bookingId: bookingIds[0]! })
      .returning();
    await confirm(orderId);
    const [after] = await h.db.select().from(waitlistEntries).where(eq(waitlistEntries.id, entry!.id));
    expect(after!.state).toBe("confirmed");
  });

  it("after expiry: re-books on a new confirmed row with the same line when capacity is free (the lapsed row untouched)", async () => {
    const { session, orderId, bookingIds } = await orderBooking();
    await h.db.update(bookings).set({ status: "cancelled", cancelledAt: new Date(), cancelReasonCode: "payment_expired" }).where(eq(bookings.id, bookingIds[0]!));
    const result = await confirm(orderId);
    expect(result.unavailableOrderLineIds).toEqual([]);
    const rows = await rowsOf(session.id);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: bookingIds[0], status: "cancelled" });
    expect(rows[1]).toMatchObject({ status: "confirmed", orderLineId: rows[0]!.orderLineId, paidWith: "order" });
    expect(result.confirmedBookingIds).toEqual([rows[1]!.id]);
    expect(await confirm(orderId)).toEqual(result);
  });

  it("after expiry with the session full: returns the line in unavailableOrderLineIds", async () => {
    const { session, orderId, bookingIds } = await orderBooking({ capacitySeats: 1 });
    await h.db.update(bookings).set({ status: "cancelled", cancelledAt: new Date(), cancelReasonCode: "payment_expired" }).where(eq(bookings.id, bookingIds[0]!));
    const other = await makePerson(h.db);
    await h.db.insert(bookings).values({ sessionId: session.id, personId: other.id, status: "confirmed", paidWith: "free", source: "admin" });
    const [lapsed] = await h.db.select().from(bookings).where(eq(bookings.id, bookingIds[0]!));
    const result = await confirm(orderId);
    expect(result).toEqual({ confirmedBookingIds: [], unavailableOrderLineIds: [lapsed!.orderLineId] });
    expect(await rowsOf(session.id)).toHaveLength(2);
  });
});

describe("releaseBookingsForOrder", () => {
  it.each([
    ["payment_expired", "payment_expired"],
    ["payment_failed", "payment_expired"],
    ["order_cancelled", "order_cancelled"],
  ] as const)("%s cancels the reserved rows with code %s and enqueues waitlist.offer_next", async (reason, code) => {
    const { session, orderId, bookingIds } = await orderBooking({ guests: 1 });
    const result = await inTx(h.db, system, (tx, ctx) => releaseBookingsForOrder(tx, ctx, { orderId, reason }));
    expect([...result.releasedBookingIds].sort()).toEqual([...bookingIds].sort());
    for (const r of await rowsOf(session.id)) expect(r).toMatchObject({ status: "cancelled", cancelReasonCode: code });
    const queued = await h.db.select().from(jobs).where(and(eq(jobs.kind, "waitlist.offer_next"), sql`${jobs.payload}->>'sessionId' = ${session.id}`));
    expect(queued).toHaveLength(2);
    const again = await inTx(h.db, system, (tx, ctx) => releaseBookingsForOrder(tx, ctx, { orderId, reason }));
    expect(again.releasedBookingIds).toEqual([]);
  });

  it("never touches confirmed rows", async () => {
    const { session, orderId } = await orderBooking();
    await confirm(orderId);
    await inTx(h.db, system, (tx, ctx) => releaseBookingsForOrder(tx, ctx, { orderId, reason: "order_cancelled" }));
    expect((await rowsOf(session.id))[0]!.status).toBe("confirmed");
  });
});

describe("createBookingForPosLine", () => {
  it("reserves under the session lock with source pos and the order's expiry; the POS paid transaction confirms it", async () => {
    const session = await openSession(h.db);
    const person = await makePerson(h.db);
    const { orderId, lineId } = await posOrderLine(h.db, session.id, { personId: person.id });
    const { bookingId } = await inTx(h.db, staff, (tx, ctx) => createBookingForPosLine(tx, ctx, { orderLineId: lineId, sessionId: session.id, personId: person.id }));
    const [order] = await h.db.select().from(orders).where(eq(orders.id, orderId));
    const [row] = await h.db.select().from(bookings).where(eq(bookings.id, bookingId));
    expect(row).toMatchObject({ status: "reserved", source: "pos", orderLineId: lineId, paidWith: "order" });
    expect(row!.reservedUntil!.getTime()).toBe(order!.expiresAt!.getTime());
    const again = await inTx(h.db, staff, (tx, ctx) => createBookingForPosLine(tx, ctx, { orderLineId: lineId, sessionId: session.id, personId: person.id }));
    expect(again.bookingId).toBe(bookingId);
    expect(await confirm(orderId)).toEqual({ confirmedBookingIds: [bookingId], unavailableOrderLineIds: [] });
  });

  it("refuses a full session with session_full, a member-only session with member_only and a booked person with already_booked", async () => {
    const full = await openSession(h.db, { capacitySeats: 1 });
    await h.db.insert(bookings).values({ sessionId: full.id, personId: (await makePerson(h.db)).id, status: "confirmed", paidWith: "free", source: "admin" });
    const person = await makePerson(h.db);
    const a = await posOrderLine(h.db, full.id);
    await expect(inTx(h.db, staff, (tx, ctx) => createBookingForPosLine(tx, ctx, { orderLineId: a.lineId, sessionId: full.id, personId: person.id }))).rejects.toMatchObject({
      code: "conflict",
      reason: "session_full",
    });
    const members = await openSession(h.db, { isMemberOnly: true });
    const b = await posOrderLine(h.db, members.id);
    await expect(inTx(h.db, staff, (tx, ctx) => createBookingForPosLine(tx, ctx, { orderLineId: b.lineId, sessionId: members.id, personId: person.id }))).rejects.toMatchObject({
      reason: "member_only",
    });
    const open = await openSession(h.db);
    await h.db.insert(bookings).values({ sessionId: open.id, personId: person.id, status: "confirmed", paidWith: "free", source: "admin" });
    const c = await posOrderLine(h.db, open.id);
    await expect(inTx(h.db, staff, (tx, ctx) => createBookingForPosLine(tx, ctx, { orderLineId: c.lineId, sessionId: open.id, personId: person.id }))).rejects.toMatchObject({
      reason: "already_booked",
    });
  });

  it("two parallel POS sales of the last seat: one reserved, one session_full", async () => {
    const session = await openSession(h.db, { capacitySeats: 1 });
    const lines = [await posOrderLine(h.db, session.id), await posOrderLine(h.db, session.id)];
    const people = [await makePerson(h.db), await makePerson(h.db)];
    const results = await Promise.allSettled(
      lines.map((l, i) => inTx(h.db, staff, (tx, ctx) => createBookingForPosLine(tx, ctx, { orderLineId: l.lineId, sessionId: session.id, personId: people[i]!.id }))),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ reason: "session_full" });
  });
});
