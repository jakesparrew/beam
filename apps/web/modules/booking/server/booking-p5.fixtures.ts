/**
 * Test fixtures of booking-P5 (BS-23): full sessions, waitlist entries (with real claim tokens),
 * a `commerce.createOrder` double built on the shared commerce factories (`makeOrder`,
 * `makeOrderLine`), and readers for entries, facts, emails and jobs. Imported by the booking-P5
 * test files only; never by production code.
 */
import type { DbOrTx, Tx } from "@beam/db";
import { activityEvents, emailMessages, jobs, waitlistEntries } from "@beam/db/schema";
import { makePerson, makeProduct, type SessionRow } from "@beam/db/testing";
import { makeOrder, makeOrderLine } from "@beam/db/testing/commerce-factories";
import { claimToken, hashToken } from "@beam/core/booking";
import { and, asc, eq, sql, type Ctx } from "@/lib/ctx";
import type { CreateOrderInput, CreateOrderResult } from "@/modules/commerce/api";
import { openSession } from "./booking-p3a.fixtures";
import { rawBooking } from "./booking-p3b.fixtures";
import { claimKey } from "./claim";

// Claim tokens and IP hashes derive from AUTH_SECRET (R43, R48).
process.env.AUTH_SECRET ??= "test-auth-secret-booking-p5";

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

export type EntryRow = typeof waitlistEntries.$inferSelect;

/** An open, published session with `seats` seats, all taken by confirmed bookings (default 1). */
export async function fullSession(db: DbOrTx, opts: { seats?: number; startsIn?: number; overrides?: Parameters<typeof openSession>[1] } = {}): Promise<{ session: SessionRow; bookingIds: string[] }> {
  const seats = opts.seats ?? 1;
  const session = await openSession(db, { capacitySeats: seats, startsAt: new Date(Date.now() + (opts.startsIn ?? 2 * DAY)), ...opts.overrides });
  const bookingIds: string[] = [];
  for (let i = 0; i < seats; i++) bookingIds.push((await rawBooking(db, { sessionId: session.id })).id);
  return { session, bookingIds };
}

/** A waitlist entry with any columns (default `waiting`, `public`, a new person). */
export async function entry(db: DbOrTx, sessionId: string, overrides: Partial<typeof waitlistEntries.$inferInsert> = {}): Promise<EntryRow> {
  const personId = overrides.personId ?? (await makePerson(db)).id;
  const [row] = await db.insert(waitlistEntries).values({ sessionId, state: "waiting", ...overrides, personId }).returning();
  return row!;
}

/** An `offered` entry with a real claim token (offer number `offersCount`, default 1). */
export async function offeredEntry(
  db: DbOrTx,
  sessionId: string,
  overrides: Partial<typeof waitlistEntries.$inferInsert> = {},
): Promise<{ entry: EntryRow; token: string }> {
  const e = await entry(db, sessionId, { state: "waiting", ...overrides });
  const offersCount = overrides.offersCount ?? 1;
  const token = claimToken(claimKey(), e.id, offersCount);
  const [row] = await db
    .update(waitlistEntries)
    .set({
      state: "offered",
      offersCount,
      offeredAt: new Date(),
      offerExpiresAt: overrides.offerExpiresAt ?? new Date(Date.now() + HOUR),
      claimTokenHash: hashToken(token),
      bookingId: overrides.bookingId ?? null,
    })
    .where(eq(waitlistEntries.id, e.id))
    .returning();
  return { entry: row!, token };
}

export const entryById = async (db: DbOrTx, id: string) => (await db.select().from(waitlistEntries).where(eq(waitlistEntries.id, id)))[0]!;
export const entriesOf = (db: DbOrTx, sessionId: string) =>
  db.select().from(waitlistEntries).where(eq(waitlistEntries.sessionId, sessionId)).orderBy(asc(waitlistEntries.joinedAt), asc(waitlistEntries.id));

/** Waitlist facts of an entry (`ref_type = waitlist_entry`), oldest first. */
export const entryFacts = (db: DbOrTx, entryId: string) =>
  db
    .select({ kind: activityEvents.kind, data: activityEvents.data, dedupeKey: activityEvents.dedupeKey })
    .from(activityEvents)
    .where(and(eq(activityEvents.refType, "waitlist_entry"), eq(activityEvents.refId, entryId)))
    .orderBy(asc(activityEvents.id));

export const emailByKey = async (db: DbOrTx, key: string) => (await db.select().from(emailMessages).where(eq(emailMessages.idempotencyKey, key)))[0];

/** `waitlist.offer_next` jobs of a session. */
export const offerNextJobs = (db: DbOrTx, sessionId: string) =>
  db
    .select()
    .from(jobs)
    .where(and(eq(jobs.kind, "waitlist.offer_next"), sql`${jobs.payload}->>'sessionId' = ${sessionId}`));

/** A person with an email and a person without one (a staff-added walk-in). */
export const walkIn = (db: DbOrTx) => makePerson(db, { email: null });

/** A `session` product for order-paid claims. */
export const sessionProduct = (db: DbOrTx) => makeProduct(db, { kind: "session", priceCents: 2_500 });

/**
 * A `createOrder` double on the shared commerce factories: one `pending_payment` order (expiry in
 * 30 minutes) with one `session` line per item carrying `data.booking_ids`; line ids in item order.
 */
export function factoryCreateOrder(calls: CreateOrderInput[] = []) {
  return async (tx: Tx, _ctx: Ctx, input: CreateOrderInput): Promise<CreateOrderResult> => {
    calls.push(input);
    const expiresAt = input.expiresAt ?? new Date(Date.now() + 30 * MIN);
    const order = await makeOrder(tx, { personId: input.personId, channel: input.channel, expiresAt, clientKey: input.clientKey, locale: input.locale });
    const lineIds: string[] = [];
    for (const item of input.items) {
      const line = await makeOrderLine(tx, {
        orderId: order.id,
        productId: item.productId,
        productKind: "session",
        sessionId: item.sessionId ?? null,
        unitAmountCents: 2_500,
        data: item.bookingIds ? { booking_ids: item.bookingIds } : {},
      });
      lineIds.push(line.id);
    }
    return { orderId: order.id, reference: order.reference, lineIds, totalCents: order.totalCents, status: order.status, expiresAt, isExisting: false } as CreateOrderResult;
  };
}
