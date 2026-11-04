/**
 * Test fixtures of booking-P3b (BS-23): booking rows of this module's own table in any state,
 * order-paid rows over commerce's shared factories (`makeOrder`, `makeOrderLine`,
 * `makePaidOrder`), waitlist entries, and readers for facts, emails, jobs and credit releases.
 * Imported by the booking-P3b test files only; never by production code.
 */
import type { DbOrTx } from "@beam/db";
import { activityEvents, bookings, creditEntries, emailMessages, jobs, waitlistEntries } from "@beam/db/schema";
import { makePerson } from "@beam/db/testing";
import { makeOrder, makeOrderLine, makePaidOrder } from "@beam/db/testing/commerce-factories";
import { and, asc, eq, inArray, sql } from "@/lib/ctx";

export type BookingInsert = typeof bookings.$inferInsert;
export type BookingRow = typeof bookings.$inferSelect;

/** A booking row (default: `confirmed`, `free`, one unit, staff source) for a new person. */
export async function rawBooking(db: DbOrTx, overrides: Partial<BookingInsert> & { sessionId: string }): Promise<BookingRow> {
  const personId = overrides.personId ?? (await makePerson(db)).id;
  const [row] = await db
    .insert(bookings)
    .values({ status: "confirmed", paidWith: "free", source: "admin", capacityUnits: 1, ...overrides, personId })
    .returning();
  return row!;
}

/** A `confirmed` booking paid by a `paid` portal order with one session line. */
export async function paidOrderBooking(db: DbOrTx, input: { sessionId: string; personId?: string }): Promise<{ booking: BookingRow; orderId: string; lineId: string }> {
  const personId = input.personId ?? (await makePerson(db)).id;
  const { order, lines } = await makePaidOrder(db, { personId, lines: [{ productKind: "session", sessionId: input.sessionId, unitAmountCents: 2_500 }] });
  const booking = await rawBooking(db, { sessionId: input.sessionId, personId, paidWith: "order", orderLineId: lines[0]!.id, source: "portal", bookedByPersonId: personId });
  return { booking, orderId: order.id, lineId: lines[0]!.id };
}

/** A `reserved` booking of an unpaid (`pending_payment`) admin order, reserved until `reservedUntil`. */
export async function unpaidOrderBooking(
  db: DbOrTx,
  input: { sessionId: string; personId?: string; reservedUntil?: Date; isPayAtDesk?: boolean; orderStatus?: "pending_payment" | "paid" | "expired" },
): Promise<{ booking: BookingRow; orderId: string; lineId: string }> {
  const personId = input.personId ?? (await makePerson(db)).id;
  const reservedUntil = input.reservedUntil ?? new Date(Date.now() + 30 * 60_000);
  const order = await makeOrder(db, { personId, channel: "admin", status: input.orderStatus ?? "pending_payment", expiresAt: reservedUntil });
  const line = await makeOrderLine(db, { orderId: order.id, productKind: "session", sessionId: input.sessionId, unitAmountCents: 2_500 });
  const booking = await rawBooking(db, {
    sessionId: input.sessionId,
    personId,
    status: "reserved",
    paidWith: "order",
    orderLineId: line.id,
    reservedUntil,
    isPayAtDesk: input.isPayAtDesk ?? false,
  });
  return { booking, orderId: order.id, lineId: line.id };
}

/** A waitlist entry (default `waiting`; `offered` gets an expiry in an hour). */
export async function waitEntry(
  db: DbOrTx,
  input: { sessionId: string; personId?: string; state?: "waiting" | "offered"; bookingId?: string; offerExpiresAt?: Date },
): Promise<typeof waitlistEntries.$inferSelect> {
  const personId = input.personId ?? (await makePerson(db)).id;
  const offered = input.state === "offered";
  const [row] = await db
    .insert(waitlistEntries)
    .values({
      sessionId: input.sessionId,
      personId,
      state: input.state ?? "waiting",
      ...(offered ? { offeredAt: new Date(), offerExpiresAt: input.offerExpiresAt ?? new Date(Date.now() + 3_600_000), offersCount: 1 } : {}),
      bookingId: input.bookingId ?? null,
    })
    .returning();
  return row!;
}

export const bookingById = async (db: DbOrTx, id: string) => (await db.select().from(bookings).where(eq(bookings.id, id)))[0]!;
export const bookingsOfSession = (db: DbOrTx, sessionId: string) => db.select().from(bookings).where(eq(bookings.sessionId, sessionId)).orderBy(asc(bookings.createdAt), asc(bookings.id));

/** The booking facts of a booking (`ref_id`), oldest first. */
export const factsOf = (db: DbOrTx, bookingId: string) =>
  db
    .select({ kind: activityEvents.kind, data: activityEvents.data, dedupeKey: activityEvents.dedupeKey, personId: activityEvents.personId })
    .from(activityEvents)
    .where(and(eq(activityEvents.refType, "booking"), eq(activityEvents.refId, bookingId)))
    .orderBy(asc(activityEvents.id));

/** The email message with this idempotency key, or undefined. */
export const emailByKey = async (db: DbOrTx, key: string) => (await db.select().from(emailMessages).where(eq(emailMessages.idempotencyKey, key)))[0];

/** Email messages whose key starts with `booking:<id>:`. */
export const emailsOfBooking = (db: DbOrTx, bookingId: string) =>
  db.select().from(emailMessages).where(sql`${emailMessages.idempotencyKey} like ${`booking:${bookingId}:%`}`);

/** Jobs of a kind, optionally with one idempotency key. */
export const jobsOf = (db: DbOrTx, kind: string, key?: string) =>
  db
    .select()
    .from(jobs)
    .where(and(eq(jobs.kind, kind), key ? eq(jobs.idempotencyKey, key) : undefined));

/** The `release` ledger entries of a booking with their `data.reason`. */
export async function releasesOf(db: DbOrTx, bookingIds: string | string[]): Promise<Array<{ refId: string | null; quantity: number; reason: string | undefined }>> {
  const ids = Array.isArray(bookingIds) ? bookingIds : [bookingIds];
  const rows = await db
    .select({ refId: creditEntries.refId, quantity: creditEntries.quantity, data: creditEntries.data })
    .from(creditEntries)
    .where(and(eq(creditEntries.kind, "release"), eq(creditEntries.refType, "booking"), inArray(creditEntries.refId, ids)));
  return rows.map((r) => ({ refId: r.refId, quantity: r.quantity, reason: (r.data as { reason?: string }).reason }));
}

/** The `consume` ledger entries of a booking. */
export const consumesOf = (db: DbOrTx, bookingId: string) =>
  db.select().from(creditEntries).where(and(eq(creditEntries.kind, "consume"), eq(creditEntries.refType, "booking"), eq(creditEntries.refId, bookingId)));
