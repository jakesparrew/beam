/**
 * booking api, area `bookings` (booking spec 4.9 file layout): availability, the commerce hooks,
 * people and history, and the cut-over import. Implemented by booking-P3a over the internal
 * service in `../server/`; `cancelBookingsForOrderLine` and `getBookingHealth` are booking-P3b's
 * (stubs kept unchanged until then), `opensForCustomersAt` of `getSessionCards` is booking-P7's.
 */
import type { DbOrTx, Tx } from "@beam/db";
import { bookings, persons, sessions, vPersonBookings, vSessionAvailability } from "@beam/db/schema";
import { NotImplementedError } from "@beam/core/errors";
import { pick, type Locale, type LocalizedText } from "@beam/core/i18n";
import {
  availabilityBand,
  computeAvailability,
  type Availability,
  type AvailabilityBand,
  type AvailabilityRow,
  type BookingHealth,
  type BookingRules,
  type EventCategory,
  type PersonBookingRow,
  type SessionCard,
  type SessionKind,
  type SessionStatus,
  type SessionSummary,
} from "@beam/core/booking";
import { URL_SEGMENT } from "@beam/core/i18n";
import { NotFoundError, and, asc, desc, eq, gt, gte, inArray, isNull, lte, ne, or, sql, type Ctx } from "@/lib/ctx";
import { getSetting } from "@/lib/settings";
import { LIVE_STATUSES, lockSession, readAvailabilityRow, viewerFor, type SessionRow } from "../server/book";
import { recordBookingFact } from "../server/facts";
import { confirmOrderBookings, createPosBooking, releaseOrderBookings } from "../server/order-hooks";

const notYet = <T>(fn: string): Promise<T> => Promise.reject(new NotImplementedError(`booking.${fn}`));

/** `reserved` rows still within their reservation, or `confirmed` (R9 live, without the past states). */
const liveNow = sql`(${bookings.status} = 'confirmed' or (${bookings.status} = 'reserved' and ${bookings.reservedUntil} > now()))`;

async function sessionWithRow(db: DbOrTx, sessionId: string): Promise<{ session: SessionRow; row: AvailabilityRow }> {
  const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
  if (!session) throw new NotFoundError("session_not_found");
  return { session, row: await readAvailabilityRow(db, session) };
}

/** The public band: general seats of an open session (R7, decision 32). */
const publicBand = (status: SessionStatus, availableGeneral: number): AvailabilityBand => (status === "open" ? availabilityBand(Number(availableGeneral)) : "full");

// availability ------------------------------------------------------------------

/** One session's availability for a person (or the public), with the view's pools (Wave 0 contract). */
export async function getAvailability(
  db: DbOrTx,
  input: { sessionId: string; personId?: string; at?: Date },
): Promise<
  Availability & { sessionId: string; kind: SessionKind; productId: string | null; capacity: number; held: number; booked: number; waiting: number }
> {
  const { session, row } = await sessionWithRow(db, input.sessionId);
  const rules = await getSetting(db, "booking_rules");
  const viewer = await viewerFor(db, session, input.personId ?? null);
  const a = computeAvailability(row, viewer, input.at ?? new Date(), rules);
  return { ...a, sessionId: session.id, kind: session.kind, productId: session.productId, capacity: row.capacity, held: row.held, booked: row.booked, waiting: row.waiting };
}

/** Site `availability_preview` block: published day or night sessions in `[from, to)`. */
export async function getAvailabilityPreview(
  db: DbOrTx,
  input: { kind: "day" | "night"; from: Date; to: Date },
): Promise<Array<{ sessionId: string; startsAt: Date; band: AvailabilityBand }>> {
  const rows = await db
    .select({ sessionId: vSessionAvailability.sessionId, startsAt: vSessionAvailability.startsAt, status: vSessionAvailability.status, general: vSessionAvailability.availableGeneral })
    .from(vSessionAvailability)
    .innerJoin(sessions, eq(sessions.id, vSessionAvailability.sessionId))
    .where(
      and(
        eq(sessions.kind, input.kind),
        inArray(sessions.status, ["open", "closed"]),
        lte(sessions.publishedAt, sql`now()`),
        isNull(sessions.webinarId),
        gte(sessions.startsAt, input.from),
        sql`${sessions.startsAt} < ${input.to}`,
      ),
    )
    .orderBy(asc(sessions.startsAt));
  return rows.map((r) => ({ sessionId: r.sessionId, startsAt: r.startsAt, band: publicBand(r.status, r.general) }));
}

function summaryOf(s: SessionRow, row: AvailabilityRow, a: Availability): SessionSummary {
  const free = Math.max(0, a.bookable);
  return {
    sessionId: s.id,
    templateId: s.templateId,
    kind: s.kind,
    title: s.title,
    description: s.description ?? null,
    startsAt: s.startsAt,
    endsAt: s.endsAt,
    status: s.status,
    location: s.location,
    capacity: row.capacity,
    free,
    band: s.status === "open" ? availabilityBand(free) : "full",
    productId: s.productId,
    creditKind: s.creditKind,
    creditCost: s.creditCost,
    isMemberOnly: s.isMemberOnly,
    isLeadMagnet: s.isLeadMagnet,
    eventCategory: s.eventCategory,
    availability: a,
  };
}

/** R7: sessions a customer sees (published, open or closed, future, within the booking horizon; never webinars). */
export async function listBookableSessions(
  db: DbOrTx,
  input: { kind?: SessionKind; fromOn: string; toOn: string; personId?: string; templateId?: string },
): Promise<SessionSummary[]> {
  const rules: BookingRules = await getSetting(db, "booking_rules");
  const now = new Date();
  const list = await db
    .select()
    .from(sessions)
    .where(
      and(
        input.kind ? eq(sessions.kind, input.kind) : undefined,
        input.templateId ? eq(sessions.templateId, input.templateId) : undefined,
        inArray(sessions.status, ["open", "closed"]),
        lte(sessions.publishedAt, sql`now()`),
        isNull(sessions.webinarId),
        gt(sessions.startsAt, sql`now()`),
        sql`${sessions.startsAt} <= now() + make_interval(days => ${rules.booking_horizon_days})`,
        sql`(${sessions.startsAt} at time zone 'Europe/Brussels')::date between ${input.fromOn}::date and ${input.toOn}::date`,
      ),
    )
    .orderBy(asc(sessions.startsAt));
  const out: SessionSummary[] = [];
  for (const s of list) {
    const row = await readAvailabilityRow(db, s);
    const viewer = await viewerFor(db, s, input.personId ?? null);
    out.push(summaryOf(s, row, computeAvailability(row, viewer, now, rules)));
  }
  return out;
}

/** Site events pages: published, not cancelled events from `from`; webinar sessions included. */
export async function listPublicEvents(
  db: DbOrTx,
  input: { from: Date; limit: number; offset: number },
): Promise<
  Array<{
    sessionId: string;
    title: LocalizedText;
    startsAt: Date;
    endsAt: Date;
    status: SessionStatus;
    eventCategory: EventCategory;
    isMemberOnly: boolean;
    isLeadMagnet: boolean;
    leadWindowEndAt: Date | null;
    location: string | null;
    productId: string | null;
    availabilityBand: AvailabilityBand;
  }>
> {
  const rows = await db
    .select({ s: sessions, general: vSessionAvailability.availableGeneral })
    .from(sessions)
    .innerJoin(vSessionAvailability, eq(vSessionAvailability.sessionId, sessions.id))
    .where(and(eq(sessions.kind, "event"), ne(sessions.status, "cancelled"), lte(sessions.publishedAt, sql`now()`), gte(sessions.startsAt, input.from)))
    .orderBy(asc(sessions.startsAt), asc(sessions.id))
    .limit(Math.max(0, input.limit))
    .offset(Math.max(0, input.offset));
  return rows.map(({ s, general }) => ({
    sessionId: s.id,
    title: s.title,
    startsAt: s.startsAt,
    endsAt: s.endsAt,
    status: s.status,
    eventCategory: (s.eventCategory ?? "special_activity") as EventCategory,
    isMemberOnly: s.isMemberOnly,
    isLeadMagnet: s.isLeadMagnet,
    leadWindowEndAt: s.leadWindowEndAt,
    location: s.location,
    productId: s.productId,
    availabilityBand: s.webinarId ? "available" : publicBand(s.status, general),
  }));
}

/** Email `event` block, in the order of `sessionIds`; `opensForCustomersAt` stays null until booking-P7. */
export async function getSessionCards(tx: DbOrTx, sessionIds: string[], locale: Locale): Promise<SessionCard[]> {
  if (!sessionIds.length) return [];
  const rows = await tx
    .select({ s: sessions, general: vSessionAvailability.availableGeneral })
    .from(sessions)
    .innerJoin(vSessionAvailability, eq(vSessionAvailability.sessionId, sessions.id))
    .where(inArray(sessions.id, sessionIds));
  const byId = new Map(rows.map((r) => [r.s.id, r]));
  return sessionIds.flatMap((id) => {
    const r = byId.get(id);
    if (!r) return [];
    const s = r.s;
    return [
      {
        sessionId: s.id,
        title: pick(s.title, locale, "session title"),
        kind: s.kind,
        startsAt: s.startsAt,
        endsAt: s.endsAt,
        location: s.location,
        productId: s.productId,
        isMemberOnly: s.isMemberOnly,
        isLeadMagnet: s.isLeadMagnet,
        availabilityBand: publicBand(s.status, r.general),
        bookUrl: `/${URL_SEGMENT[locale]}/account/book/${s.id}`,
        opensForCustomersAt: null,
      },
    ];
  });
}

// commerce hooks (R18; booking reserves before createOrder) -------------------------

/** In commerce's paid transaction; also confirms linked waitlist entries. */
export function confirmBookingsForOrder(
  tx: Tx,
  ctx: Ctx,
  input: { orderId: string },
): Promise<{ confirmedBookingIds: string[]; unavailableOrderLineIds: string[] }> {
  return confirmOrderBookings(tx, ctx, input.orderId);
}

/** Order ended unpaid: codes `payment_expired` (also for `payment_failed`) or `order_cancelled`. */
export function releaseBookingsForOrder(
  tx: Tx,
  ctx: Ctx,
  input: { orderId: string; reason: "payment_expired" | "payment_failed" | "order_cancelled" },
): Promise<{ releasedBookingIds: string[] }> {
  return releaseOrderBookings(tx, ctx, input);
}

/** Staff refund in commerce; code `refunded`, never a second refund. */
export function cancelBookingsForOrderLine(
  _tx: Tx,
  _ctx: Ctx,
  _input: { orderLineId: string; reason: "refunded" },
): Promise<{ cancelledBookingIds: string[] }> {
  return notYet("cancelBookingsForOrderLine");
}

/** POS walk-in: `reserved` until the POS payment; throws `conflict` `session_full`, `member_only` or `already_booked`. */
export function createBookingForPosLine(
  tx: Tx,
  ctx: Ctx,
  input: { orderLineId: string; sessionId: string; personId: string },
): Promise<{ bookingId: string }> {
  return createPosBooking(tx, ctx, input);
}

// people and history -------------------------------------------------------------

/** Automation `unless`: a live booking (attendee) of a future session, optionally of these kinds. */
export async function hasFutureBooking(db: DbOrTx, personId: string, kinds?: SessionKind[]): Promise<boolean> {
  return (await getNextBooking(db, personId, kinds)) !== null;
}

/** Email tokens: the person's next live booking. */
export async function getNextBooking(
  tx: DbOrTx,
  personId: string,
  kinds?: SessionKind[],
): Promise<{ bookingId: string; sessionId: string; startsAt: Date; kind: SessionKind } | null> {
  if (kinds && kinds.length === 0) return null;
  const [row] = await tx
    .select({ bookingId: bookings.id, sessionId: sessions.id, startsAt: sessions.startsAt, kind: sessions.kind })
    .from(bookings)
    .innerJoin(sessions, eq(sessions.id, bookings.sessionId))
    .where(and(eq(bookings.personId, personId), liveNow, ne(sessions.status, "cancelled"), gt(sessions.startsAt, sql`now()`), kinds ? inArray(sessions.kind, kinds) : undefined))
    .orderBy(asc(sessions.startsAt), asc(bookings.id))
    .limit(1);
  return row ?? null;
}

/** Cancellation codes that are not a customer's or BEAM's cancellation (bookkeeping only). */
const NOT_A_CANCELLATION = ["rescheduled", "payment_expired", "order_cancelled", "duplicate", "erased"] as const;

/** Ops' person_stats and churn inputs. Visits are `attended` rows of kind day or night (R38). */
export async function getPersonBookingSummary(
  db: DbOrTx,
  personId: string,
): Promise<{
  nextBookingAt: Date | null;
  upcoming: number;
  attended: number;
  noShows: number;
  cancellations: number;
  lateCancellations: number;
  firstVisitAt: Date | null;
  lastVisitAt: Date | null;
  nightsBooked: number;
  eventsAttended: number;
}> {
  const excluded = sql.join(
    NOT_A_CANCELLATION.map((c) => sql`${c}`),
    sql`, `,
  );
  const [r] = await db
    .select({
      nextBookingAt: sql<Date | string | null>`min(${sessions.startsAt}) filter (where ${liveNow} and ${sessions.startsAt} > now() and ${sessions.status} <> 'cancelled')`,
      upcoming: sql<number>`count(*) filter (where ${liveNow} and ${sessions.startsAt} > now() and ${sessions.status} <> 'cancelled')::int`,
      attended: sql<number>`count(*) filter (where ${bookings.status} = 'attended')::int`,
      noShows: sql<number>`count(*) filter (where ${bookings.status} = 'no_show')::int`,
      cancellations: sql<number>`count(*) filter (where ${bookings.status} = 'cancelled' and ${bookings.cancelReasonCode}::text not in (${excluded}))::int`,
      lateCancellations: sql<number>`count(*) filter (where ${bookings.status} = 'late_cancelled')::int`,
      firstVisitAt: sql<Date | string | null>`min(coalesce(${bookings.attendedAt}, ${sessions.startsAt})) filter (where ${bookings.status} = 'attended' and ${sessions.kind} in ('day', 'night'))`,
      lastVisitAt: sql<Date | string | null>`max(coalesce(${bookings.attendedAt}, ${sessions.startsAt})) filter (where ${bookings.status} = 'attended' and ${sessions.kind} in ('day', 'night'))`,
      nightsBooked: sql<number>`count(*) filter (where ${sessions.kind} = 'night' and ${bookings.status} in ('confirmed', 'attended', 'no_show'))::int`,
      eventsAttended: sql<number>`count(*) filter (where ${sessions.kind} = 'event' and ${bookings.status} = 'attended')::int`,
    })
    .from(bookings)
    .innerJoin(sessions, eq(sessions.id, bookings.sessionId))
    .where(eq(bookings.personId, personId));
  const date = (v: Date | string | null | undefined) => (v === null || v === undefined ? null : v instanceof Date ? v : new Date(v));
  return {
    nextBookingAt: date(r?.nextBookingAt),
    upcoming: Number(r?.upcoming ?? 0),
    attended: Number(r?.attended ?? 0),
    noShows: Number(r?.noShows ?? 0),
    cancellations: Number(r?.cancellations ?? 0),
    lateCancellations: Number(r?.lateCancellations ?? 0),
    firstVisitAt: date(r?.firstVisitAt),
    lastVisitAt: date(r?.lastVisitAt),
    nightsBooked: Number(r?.nightsBooked ?? 0),
    eventsAttended: Number(r?.eventsAttended ?? 0),
  };
}

/** crm person page: rows the person attends or owns (their guests), newest session first. */
export async function listPersonBookings(db: DbOrTx, personId: string, opts?: { limit?: number }): Promise<PersonBookingRow[]> {
  const v = vPersonBookings;
  const rows = await db
    .select()
    .from(v)
    .where(or(eq(v.personId, personId), eq(v.ownerPersonId, personId)))
    .orderBy(desc(v.startsAt), asc(v.id))
    .limit(Math.min(Math.max(opts?.limit ?? 50, 1), 500));
  return rows.map((b) => ({
    bookingId: b.id,
    sessionId: b.sessionId,
    kind: b.kind,
    title: b.title,
    startsAt: b.startsAt,
    endsAt: b.endsAt,
    status: b.status,
    sessionStatus: b.sessionStatus,
    paidWith: b.paidWith,
    source: b.source,
    isGuest: b.isGuest,
    ownerPersonId: b.ownerPersonId,
    bookedByPersonId: b.bookedByPersonId,
    attendedAt: b.attendedAt,
    cancelledAt: b.cancelledAt,
    cancelReasonCode: b.cancelReasonCode,
    createdAt: b.createdAt,
  }));
}

/** Site account home: live rows where the person is attendee or booker, `starts_at > now()`. */
export async function listUpcomingBookingsForPerson(
  db: DbOrTx,
  personId: string,
  limit: number,
): Promise<
  Array<{ bookingId: string; sessionId: string; title: LocalizedText; kind: SessionKind; startsAt: Date; isGuest: boolean; guestFirstName: string | null }>
> {
  const rows = await db
    .select({
      bookingId: bookings.id,
      sessionId: sessions.id,
      title: sessions.title,
      kind: sessions.kind,
      startsAt: sessions.startsAt,
      attendee: bookings.personId,
      guestOf: bookings.guestOfBookingId,
      firstName: persons.firstName,
    })
    .from(bookings)
    .innerJoin(sessions, eq(sessions.id, bookings.sessionId))
    .innerJoin(persons, eq(persons.id, bookings.personId))
    .where(and(or(eq(bookings.personId, personId), eq(bookings.bookedByPersonId, personId)), liveNow, ne(sessions.status, "cancelled"), gt(sessions.startsAt, sql`now()`)))
    .orderBy(asc(sessions.startsAt), asc(bookings.id))
    .limit(Math.max(0, limit));
  return rows.map((r) => ({
    bookingId: r.bookingId,
    sessionId: r.sessionId,
    title: r.title,
    kind: r.kind,
    startsAt: r.startsAt,
    isGuest: r.guestOf !== null,
    guestFirstName: r.attendee !== personId ? r.firstName : null,
  }));
}

/**
 * Ops cut-over import (R65): a `confirmed` row with `source = 'import'` on the session of that
 * kind and exact `starts_at`, idempotent on `external_ref`, no ledger entry and no email. The
 * fact is written with `mode = 'replay'` so automations do not start sequences for old customers.
 * `bookings_order_line_ck` forbids an order-paid row without an order line, so an imported
 * order-paid booking is stored as `free` with a staff note (requested: allow imports in the check).
 */
export async function importBooking(
  tx: Tx,
  ctx: Ctx,
  row: { externalRef: string; personId: string; kind: SessionKind; startsAt: Date; paidWith: "credit" | "order" | "free" },
): Promise<{ bookingId: string | null; outcome: "created" | "existing" | "no_session" | "over_capacity" }> {
  const [existing] = await tx.select({ id: bookings.id }).from(bookings).where(eq(bookings.externalRef, row.externalRef));
  if (existing) return { bookingId: existing.id, outcome: "existing" };
  const [match] = await tx
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.kind, row.kind), eq(sessions.startsAt, row.startsAt), ne(sessions.status, "cancelled"), isNull(sessions.webinarId)))
    .orderBy(sql`${sessions.templateId} is null`, asc(sessions.id))
    .limit(1);
  if (!match) return { bookingId: null, outcome: "no_session" };
  const session = await lockSession(tx, match.id);
  const [live] = await tx
    .select({ id: bookings.id })
    .from(bookings)
    .where(and(eq(bookings.sessionId, session.id), eq(bookings.personId, row.personId), inArray(bookings.status, [...LIVE_STATUSES])));
  if (live) return { bookingId: live.id, outcome: "existing" };
  const availability = await readAvailabilityRow(tx, session);
  const over = availability.availableTotal < 1;
  const [b] = await tx
    .insert(bookings)
    .values({
      sessionId: session.id,
      personId: row.personId,
      status: "confirmed",
      paidWith: row.paidWith === "order" ? "free" : row.paidWith,
      isOverCapacity: over,
      bookedByUserId: ctx.actor.kind === "staff" ? ctx.actor.userId : null,
      source: "import",
      externalRef: row.externalRef,
      notes: row.paidWith === "order" ? "Imported booking, paid by order in the previous system" : null,
    })
    .returning();
  await recordBookingFact(ctx, "booking.confirmed", b!, { by: ctx.actor.kind === "staff" ? "staff" : "system", mode: "replay" });
  return { bookingId: b!.id, outcome: over ? "over_capacity" : "created" };
}

/** Monitoring (4.8): platform's `/api/health` (`checks.booking`) and `platform.check_alerts`. */
export function getBookingHealth(db: DbOrTx): Promise<BookingHealth> {
  void db;
  return Promise.reject(new NotImplementedError("booking.getBookingHealth"));
}
