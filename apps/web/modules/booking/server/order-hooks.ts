/**
 * The order hooks commerce calls (booking spec R18, 4.9; commerce rule 21: commerce never
 * reserves capacity). Booking inserts `reserved` rows, commerce creates the order with
 * `bookingIds` per quantity-1 item, and `linkOrderLines` sets each row's `order_line_id` and
 * `reserved_until = orders.expires_at` before commit. Commerce then calls back
 * `confirmBookingsForOrder` (paid), `releaseBookingsForOrder` (ended unpaid) and, at the POS,
 * `createBookingForPosLine`. The api wrappers live in `../api/bookings.ts`.
 */
import type { Tx } from "@beam/db";
import { bookings, orderLines, orders, persons, sessions, waitlistEntries } from "@beam/db/schema";
import { AlreadyBookedError, BookingConflictError, SessionFullError, bookingTransition, transition as waitlistTransition } from "@beam/core/booking";
import { URL_SEGMENT, formatDateTime, pick } from "@beam/core/i18n";
import { NotFoundError, and, eq, inArray, or, sql, type Ctx } from "@/lib/ctx";
import { getMembershipForPerson } from "@/modules/credits/api";
import { sendTransactional } from "@/modules/email/api";
import { LIVE_STATUSES, PROVISIONAL_RESERVATION_MS, lockSession, readAvailabilityRow, sendConfirmationEmail, type BookingRow, type SessionRow } from "./book";
import { recordBookingFact } from "./facts";

const actorKind = (ctx: Ctx) => ctx.actor.kind;

/** The order lines of an order that carry bookings (by `order_line_id` or `data.booking_ids`). */
async function orderSessionLines(tx: Tx, orderId: string) {
  return tx
    .select({ id: orderLines.id, sessionId: orderLines.sessionId, data: orderLines.data, lineNo: orderLines.lineNo })
    .from(orderLines)
    .where(and(eq(orderLines.orderId, orderId), sql`${orderLines.sessionId} is not null`))
    .orderBy(orderLines.lineNo);
}

/**
 * R18: sets `order_line_id = lineIds[i]` on `rows[i]` and `reserved_until` to the order's
 * `expires_at` (kept when the order has none). Rows and lines are in item order.
 */
export async function linkOrderLines(
  tx: Tx,
  rows: ReadonlyArray<{ id: string }>,
  lineIds: readonly string[],
): Promise<Array<{ id: string; orderLineId: string; reservedUntil: Date | null }>> {
  if (rows.length !== lineIds.length) throw new Error(`linkOrderLines: ${rows.length} rows but ${lineIds.length} order lines`);
  const out: Array<{ id: string; orderLineId: string; reservedUntil: Date | null }> = [];
  for (let i = 0; i < rows.length; i++) {
    const lineId = lineIds[i]!;
    const [line] = await tx
      .select({ expiresAt: orders.expiresAt })
      .from(orderLines)
      .innerJoin(orders, eq(orders.id, orderLines.orderId))
      .where(eq(orderLines.id, lineId));
    if (!line) throw new NotFoundError("order_line_not_found");
    const [row] = await tx
      .update(bookings)
      .set({ orderLineId: lineId, reservedUntil: sql`coalesce(${line.expiresAt}::timestamptz, ${bookings.reservedUntil})`, updatedAt: sql`now()` })
      .where(and(eq(bookings.id, rows[i]!.id), eq(bookings.status, "reserved")))
      .returning({ id: bookings.id, orderLineId: bookings.orderLineId, reservedUntil: bookings.reservedUntil });
    if (!row) throw new NotFoundError("reserved_booking_not_found");
    out.push({ id: row.id, orderLineId: row.orderLineId!, reservedUntil: row.reservedUntil });
  }
  return out;
}

/** Confirms the linked waitlist entry of a booking (claim, booking-P5) when it is still `offered`. */
async function confirmLinkedEntries(ctx: Ctx, booking: BookingRow, session: SessionRow): Promise<void> {
  const entries = await ctx.tx.select().from(waitlistEntries).where(and(eq(waitlistEntries.bookingId, booking.id), eq(waitlistEntries.state, "offered")));
  for (const entry of entries) {
    waitlistTransition(entry, "confirmed", actorKind(ctx));
    await ctx.tx.update(waitlistEntries).set({ state: "confirmed", updatedAt: ctx.now }).where(eq(waitlistEntries.id, entry.id));
    await ctx.recordEvent({
      kind: "waitlist.confirmed",
      personId: entry.personId,
      data: {
        session_id: session.id,
        session_kind: session.kind,
        event_category: session.eventCategory,
        starts_at: session.startsAt,
        paid_with: booking.paidWith,
        is_guest: false,
        guest_of_person_id: null,
        owner_person_id: entry.personId,
        is_first_booking: false,
        is_first_visit: false,
        queue: entry.queue,
        booking_id: booking.id,
      },
      ref: { type: "waitlist_entry", id: entry.id },
      dedupeKey: `waitlist:${entry.id}:confirmed:${entry.offersCount}:${entry.rejoinCount}`,
    });
  }
}

/**
 * R18 paid: every `reserved` row of the order becomes `confirmed` (facts, confirmation emails,
 * linked waitlist entries). A line whose row lapsed meanwhile is re-booked under the session lock
 * when a unit is free and the person holds no other live booking; otherwise its id is returned
 * in `unavailableOrderLineIds` (commerce refunds it). Running it twice changes nothing.
 */
export async function confirmOrderBookings(
  tx: Tx,
  ctx: Ctx,
  orderId: string,
): Promise<{ confirmedBookingIds: string[]; unavailableOrderLineIds: string[] }> {
  const lines = await orderSessionLines(tx, orderId);
  const confirmedBookingIds: string[] = [];
  const unavailableOrderLineIds: string[] = [];
  const sessionIds = [...new Set(lines.map((l) => l.sessionId!))].sort();
  const locked = new Map<string, SessionRow>();
  for (const id of sessionIds) locked.set(id, await lockSession(tx, id));

  for (const line of lines) {
    const raw = (line.data as { booking_ids?: unknown } | null)?.booking_ids;
    const ids = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
    const rows = await tx
      .select()
      .from(bookings)
      .where(ids.length ? or(eq(bookings.orderLineId, line.id), inArray(bookings.id, ids)) : eq(bookings.orderLineId, line.id))
      .orderBy(bookings.createdAt);
    if (!rows.length) continue;
    const session = locked.get(line.sessionId!)!;
    const live = rows.find((r) => r.status === "confirmed" || r.status === "attended" || r.status === "no_show");
    if (live) {
      confirmedBookingIds.push(live.id);
      continue;
    }
    const reserved = rows.find((r) => r.status === "reserved");
    if (reserved) {
      bookingTransition("reserved", "confirmed", actorKind(ctx));
      const [row] = await tx
        .update(bookings)
        .set({ status: "confirmed", orderLineId: line.id, reservedUntil: null, version: sql`${bookings.version} + 1`, updatedAt: ctx.now })
        .where(eq(bookings.id, reserved.id))
        .returning();
      await recordBookingFact(ctx, "booking.confirmed", row!, { by: "system" });
      await sendConfirmationEmail(ctx, row!, session);
      await confirmLinkedEntries(ctx, row!, session);
      confirmedBookingIds.push(row!.id);
      continue;
    }
    // Every row lapsed (`cancelled` after expiry): re-book when a unit is free.
    const lapsed = rows[rows.length - 1]!;
    const availability = await readAvailabilityRow(tx, session);
    const [other] = await tx
      .select({ id: bookings.id })
      .from(bookings)
      .where(and(eq(bookings.sessionId, session.id), eq(bookings.personId, lapsed.personId), inArray(bookings.status, [...LIVE_STATUSES])));
    const bookable = session.status !== "cancelled" && session.endsAt.getTime() > ctx.now.getTime() && availability.availableTotal >= lapsed.capacityUnits;
    if (!bookable || other) {
      unavailableOrderLineIds.push(line.id);
      continue;
    }
    const [row] = await tx
      .insert(bookings)
      .values({
        sessionId: session.id,
        personId: lapsed.personId,
        status: "confirmed",
        paidWith: "order",
        guestOfBookingId: lapsed.guestOfBookingId,
        capacityUnits: lapsed.capacityUnits,
        orderLineId: line.id,
        ticketTypeId: lapsed.ticketTypeId,
        isPayAtDesk: lapsed.isPayAtDesk,
        bookedByUserId: lapsed.bookedByUserId,
        bookedByPersonId: lapsed.bookedByPersonId,
        source: lapsed.source,
      })
      .returning();
    await recordBookingFact(ctx, "booking.confirmed", row!, { by: "system" });
    await sendConfirmationEmail(ctx, row!, session);
    confirmedBookingIds.push(row!.id);
  }
  return { confirmedBookingIds, unavailableOrderLineIds };
}

/** R18 unpaid end: `reserved` rows become `cancelled` with `payment_expired` (also `payment_failed`) or `order_cancelled`. */
export async function releaseOrderBookings(
  tx: Tx,
  ctx: Ctx,
  input: { orderId: string; reason: "payment_expired" | "payment_failed" | "order_cancelled" },
): Promise<{ releasedBookingIds: string[] }> {
  const code = input.reason === "order_cancelled" ? "order_cancelled" : "payment_expired";
  const lines = await orderSessionLines(tx, input.orderId);
  if (!lines.length) return { releasedBookingIds: [] };
  const released: string[] = [];
  const locked = new Map<string, SessionRow>();
  for (const sessionId of [...new Set(lines.map((l) => l.sessionId!))].sort()) locked.set(sessionId, await lockSession(tx, sessionId));
  const rows = await tx
    .select()
    .from(bookings)
    .where(and(inArray(bookings.orderLineId, lines.map((l) => l.id)), eq(bookings.status, "reserved")));
  for (const b of rows) {
    bookingTransition("reserved", "cancelled", ctx.actor.kind === "customer" || ctx.actor.kind === "public" ? "system" : ctx.actor.kind);
    const [row] = await tx
      .update(bookings)
      .set({ status: "cancelled", cancelledAt: ctx.now, cancelReasonCode: code, version: sql`${bookings.version} + 1`, updatedAt: ctx.now })
      .where(eq(bookings.id, b.id))
      .returning();
    await recordBookingFact(ctx, "booking.cancelled", row!, { by: "system", cancelReasonCode: code });
    await sendCancelledEmail(ctx, row!);
    // R44: a claimed offer whose payment did not complete ends `expired` (`payment_not_completed`).
    await expireClaimedOffers(ctx, row!, locked.get(b.sessionId)!);
    // R34: freed capacity goes to the waitlist.
    await ctx.enqueue({ kind: "waitlist.offer_next", payload: { sessionId: b.sessionId, trigger: b.id }, key: `waitlist:${b.sessionId}:offer_next:${b.id}` });
    released.push(b.id);
  }
  return { releasedBookingIds: released };
}

/**
 * R44, edge case 27: the `offered` waitlist entries whose claim made `booking` (its payment did not
 * complete) become `expired` with `ended_reason = payment_not_completed` and a `waitlist.expired`
 * fact. Used by `releaseOrderBookings` and `expireReservedRow`; the caller enqueues
 * `waitlist.offer_next` for the freed seat. Returns how many entries ended.
 */
export async function expireClaimedOffers(ctx: Ctx, booking: BookingRow, session: SessionRow): Promise<number> {
  const entries = await ctx.tx
    .select()
    .from(waitlistEntries)
    .where(and(eq(waitlistEntries.bookingId, booking.id), eq(waitlistEntries.state, "offered")))
    .for("update");
  for (const entry of entries) {
    waitlistTransition(entry, "expired", "system");
    await ctx.tx.update(waitlistEntries).set({ state: "expired", endedReason: "payment_not_completed", updatedAt: ctx.now }).where(eq(waitlistEntries.id, entry.id));
    await ctx.recordEvent({
      kind: "waitlist.expired",
      personId: entry.personId,
      data: {
        session_id: session.id,
        session_kind: session.kind,
        event_category: session.eventCategory,
        starts_at: session.startsAt,
        paid_with: booking.paidWith,
        is_guest: false,
        guest_of_person_id: null,
        owner_person_id: entry.personId,
        is_first_booking: false,
        is_first_visit: false,
        queue: entry.queue,
        booking_id: booking.id,
        ended_reason: "payment_not_completed",
      },
      ref: { type: "waitlist_entry", id: entry.id },
      dedupeKey: `waitlist:${entry.id}:expired:${entry.offersCount}:${entry.rejoinCount}`,
    });
  }
  return entries.length;
}

/** R59 `booking.booking_cancelled` (template from booking-P3b), `reason: 'payment_expired' | 'cancelled'`. */
async function sendCancelledEmail(ctx: Ctx, booking: BookingRow): Promise<void> {
  const [person] = await ctx.tx.select({ email: persons.email, locale: persons.locale }).from(persons).where(eq(persons.id, booking.personId));
  if (!person?.email) return;
  const [session] = await ctx.tx.select({ title: sessions.title, startsAt: sessions.startsAt }).from(sessions).where(eq(sessions.id, booking.sessionId));
  const locale = person.locale;
  await sendTransactional(ctx, {
    template: "booking.booking_cancelled",
    personId: booking.personId,
    locale,
    data: {
      title: pick(session!.title, locale, "session title"),
      date: formatDateTime(session!.startsAt, locale, "full"),
      url: `${(process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "")}/${URL_SEGMENT[locale]}/account/book`,
      reason: booking.cancelReasonCode === "payment_expired" ? "payment_expired" : "cancelled",
    },
    key: `booking:${booking.id}:cancelled`,
  });
}

/**
 * R18 POS walk-in: the same eligibility and capacity checks under the session lock, then one
 * `reserved` row with `source = 'pos'`, the line id and `reserved_until = orders.expires_at`.
 * Throws `conflict` `session_full`, `member_only` or `already_booked` (commerce maps them to
 * `sold_out`); the POS paid transaction confirms the row through `confirmBookingsForOrder`.
 */
export async function createPosBooking(tx: Tx, ctx: Ctx, input: { orderLineId: string; sessionId: string; personId: string }): Promise<{ bookingId: string }> {
  const session = await lockSession(tx, input.sessionId);
  const [existingForLine] = await tx.select({ id: bookings.id }).from(bookings).where(and(eq(bookings.orderLineId, input.orderLineId), inArray(bookings.status, [...LIVE_STATUSES])));
  if (existingForLine) return { bookingId: existingForLine.id };
  if (session.webinarId || session.status === "cancelled" || session.endsAt.getTime() <= ctx.now.getTime()) throw new SessionFullError({ reason: "not_bookable" });
  if (session.isMemberOnly && !(await getMembershipForPerson(tx, input.personId)).isMember) throw new BookingConflictError("member_only");
  const [other] = await tx
    .select({ id: bookings.id })
    .from(bookings)
    .where(and(eq(bookings.sessionId, session.id), eq(bookings.personId, input.personId), inArray(bookings.status, [...LIVE_STATUSES])));
  if (other) throw new AlreadyBookedError();
  const availability = await readAvailabilityRow(tx, session);
  if (availability.availableTotal < 1) throw new SessionFullError();
  const [line] = await tx
    .select({ expiresAt: orders.expiresAt })
    .from(orderLines)
    .innerJoin(orders, eq(orders.id, orderLines.orderId))
    .where(eq(orderLines.id, input.orderLineId));
  if (!line) throw new NotFoundError("order_line_not_found");
  bookingTransition(null, "reserved", ctx.actor.kind === "staff" ? "staff" : "public");
  const [row] = await tx
    .insert(bookings)
    .values({
      sessionId: session.id,
      personId: input.personId,
      status: "reserved",
      paidWith: "order",
      orderLineId: input.orderLineId,
      bookedByUserId: ctx.actor.kind === "staff" ? ctx.actor.userId : null,
      source: "pos",
      reservedUntil: line.expiresAt ?? new Date(ctx.now.getTime() + PROVISIONAL_RESERVATION_MS),
    })
    .returning();
  await recordBookingFact(ctx, "booking.reserved", row!, { by: ctx.actor.kind === "staff" ? "staff" : "system" });
  return { bookingId: row!.id };
}
