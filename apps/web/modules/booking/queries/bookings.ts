/**
 * booking queries, area `bookings` (booking spec 4.3), booking-P3a: the staff booking list,
 * booking detail and utilisation (`bookings.read`, checked with `requirePermission`), and the
 * customer booking queries, scoped to the signed-in person (the page passes
 * `(await requireCustomer(locale)).personId`). Customer rows never carry `notes`,
 * `cancel_reason`, `booked_by_user_id`, or the `checkin_code` of a row the viewer does not
 * attend. Other modules never import this file (they use `../api.ts`).
 */
import type { DbOrTx } from "@beam/db";
import { bookings, persons, sessions, vPersonBookings, vSessionUtilisation } from "@beam/db/schema";
import { NotImplementedError } from "@beam/core/errors";
import { canReschedule, computeAvailability, type Availability, type PaidWith, type SessionKind, type SessionSummary } from "@beam/core/booking";
import type { LocalizedText } from "@beam/core/i18n";
import { requirePermission } from "@/lib/auth";
import { NotFoundError, and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, or, sql, type SQL } from "@/lib/ctx";
import { getSetting } from "@/lib/settings";
import { checkCredits, listGrantsSharedWith } from "@/modules/credits/api";
import { hasValidSubmission } from "@/modules/forms/api";
import { listBookableSessions as listBookableSessionsApi } from "../api/bookings";
import { HEALTH_DECLARATION_FORM } from "../server/declarations";
import { checkinQrSvg } from "../server/qr";
import { guestUseState, readAvailabilityRow, ticketTypeOffers, viewerFor } from "../server/book";

const PAGE = 50;

/** A stub of another module (not landed yet) reads as "unknown" instead of failing the page. */
async function orNull<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (error) {
    if (error instanceof NotImplementedError) return null;
    throw error;
  }
}

// staff (bookings.read) ----------------------------------------------------------------

export type StaffBookingRow = {
  id: string;
  sessionId: string;
  sessionTitle: LocalizedText;
  kind: SessionKind;
  startsAt: Date;
  personId: string;
  personName: string;
  status: (typeof bookings.$inferSelect)["status"];
  paidWith: PaidWith;
  source: (typeof bookings.$inferSelect)["source"];
  isGuest: boolean;
  isPayAtDesk: boolean;
  isOverCapacity: boolean;
  createdAt: Date;
};

/**
 * `/admin/bookings`: filters (person, session, status, payment, source, the session's date range)
 * and keyset on `(created_at, id)` descending, 50 per page.
 */
export async function listBookings(
  db: DbOrTx,
  input: {
    personId?: string;
    sessionId?: string;
    status?: StaffBookingRow["status"];
    paidWith?: PaidWith;
    source?: StaffBookingRow["source"];
    from?: Date;
    to?: Date;
    cursor?: { createdAt: Date; id: string } | null;
  },
): Promise<{ rows: StaffBookingRow[]; nextCursor: { createdAt: Date; id: string } | null }> {
  await requirePermission("bookings.read");
  const where: (SQL | undefined)[] = [
    input.personId ? eq(bookings.personId, input.personId) : undefined,
    input.sessionId ? eq(bookings.sessionId, input.sessionId) : undefined,
    input.status ? eq(bookings.status, input.status) : undefined,
    input.paidWith ? eq(bookings.paidWith, input.paidWith) : undefined,
    input.source ? eq(bookings.source, input.source) : undefined,
    input.from ? gte(sessions.startsAt, input.from) : undefined,
    input.to ? lt(sessions.startsAt, input.to) : undefined,
    input.cursor
      ? or(lt(bookings.createdAt, input.cursor.createdAt), and(eq(bookings.createdAt, input.cursor.createdAt), lt(bookings.id, input.cursor.id)))
      : undefined,
  ];
  const rows = await db
    .select({
      id: bookings.id,
      sessionId: bookings.sessionId,
      sessionTitle: sessions.title,
      kind: sessions.kind,
      startsAt: sessions.startsAt,
      personId: bookings.personId,
      firstName: persons.firstName,
      lastName: persons.lastName,
      status: bookings.status,
      paidWith: bookings.paidWith,
      source: bookings.source,
      guestOf: bookings.guestOfBookingId,
      isPayAtDesk: bookings.isPayAtDesk,
      isOverCapacity: bookings.isOverCapacity,
      createdAt: bookings.createdAt,
    })
    .from(bookings)
    .innerJoin(sessions, eq(sessions.id, bookings.sessionId))
    .innerJoin(persons, eq(persons.id, bookings.personId))
    .where(and(...where))
    .orderBy(desc(bookings.createdAt), desc(bookings.id))
    .limit(PAGE + 1);
  const page = rows.slice(0, PAGE).map((r) => ({
    id: r.id,
    sessionId: r.sessionId,
    sessionTitle: r.sessionTitle,
    kind: r.kind,
    startsAt: r.startsAt,
    personId: r.personId,
    personName: [r.firstName, r.lastName].filter(Boolean).join(" "),
    status: r.status,
    paidWith: r.paidWith,
    source: r.source,
    isGuest: r.guestOf !== null,
    isPayAtDesk: r.isPayAtDesk,
    isOverCapacity: r.isOverCapacity,
    createdAt: r.createdAt,
  }));
  const last = page[page.length - 1];
  return { rows: page, nextCursor: rows.length > PAGE && last ? { createdAt: last.createdAt, id: last.id } : null };
}

/** `/admin/bookings/[id]`: the row, its session, the person and its guests. */
export async function getBooking(db: DbOrTx, id: string) {
  await requirePermission("bookings.read");
  const [row] = await db
    .select({ booking: bookings, session: sessions, person: { id: persons.id, firstName: persons.firstName, lastName: persons.lastName, email: persons.email } })
    .from(bookings)
    .innerJoin(sessions, eq(sessions.id, bookings.sessionId))
    .innerJoin(persons, eq(persons.id, bookings.personId))
    .where(eq(bookings.id, id));
  if (!row) throw new NotFoundError("booking_not_found");
  const guests = await db
    .select({ id: bookings.id, personId: bookings.personId, firstName: persons.firstName, lastName: persons.lastName, status: bookings.status, paidWith: bookings.paidWith })
    .from(bookings)
    .innerJoin(persons, eq(persons.id, bookings.personId))
    .where(eq(bookings.guestOfBookingId, id))
    .orderBy(asc(bookings.createdAt));
  return { ...row, guests };
}

/** Utilisation per session (`v_session_utilisation`) for a date range of Brussels days. */
export async function getUtilisation(db: DbOrTx, input: { from: string; to: string; kind?: SessionKind }) {
  await requirePermission("bookings.read");
  const v = vSessionUtilisation;
  return db
    .select()
    .from(v)
    .where(and(gte(v.dayOn, input.from), lte(v.dayOn, input.to), input.kind ? eq(v.kind, input.kind) : undefined))
    .orderBy(asc(v.dayOn), asc(v.localStartTime));
}

// customer (scoped to the signed-in person) ----------------------------------------------

/** `/account/book`: R7 sessions with this person's availability (`?template=` filters a template). */
export function listBookableSessions(
  db: DbOrTx,
  personId: string,
  input: { kind: SessionKind; fromOn: string; toOn: string; templateId?: string },
): Promise<SessionSummary[]> {
  return listBookableSessionsApi(db, { ...input, personId });
}

/**
 * `/account/book/[sessionId]`: availability for this person, payment options, the credit check,
 * the health declaration state and whether a night needs an emergency contact (R16, R62b), the
 * event's ticket types with their state (R51), the guest uses left this month (R55) and the
 * packages shared with this person that can pay for the session (R2). Prices come from commerce's
 * quote on the page itself (R19).
 */
export async function getBookableSession(db: DbOrTx, personId: string, sessionId: string) {
  const [session] = await db.select().from(sessions).where(and(eq(sessions.id, sessionId), isNull(sessions.webinarId)));
  if (!session) throw new NotFoundError("session_not_found");
  const rules = await getSetting(db, "booking_rules");
  const row = await readAvailabilityRow(db, session);
  const availability: Availability = computeAvailability(row, await viewerFor(db, session, personId), new Date(), rules);
  const credit =
    session.creditKind && session.creditCost > 0
      ? await checkCredits(db, { personId, beneficiaryPersonId: personId, kind: session.creditKind, units: session.creditCost, validAt: session.startsAt })
      : null;
  // R51 (booking-P8 request): an event with ticket types sells them by order, each at its product.
  const ticketTypes = session.kind === "event" ? await ticketTypeOffers(db, session, personId) : [];
  const payOptions: PaidWith[] = [];
  if (credit?.ok) payOptions.push("credit");
  if (session.productId || ticketTypes.length > 0) payOptions.push("order");
  if (!session.productId && ticketTypes.length === 0 && (!session.creditKind || session.creditCost === 0)) payOptions.push("free");
  // R55 guest uses, and R2 packages shared with this person that can pay for this session.
  const guestUses = credit ? await guestUseState(db, personId, session) : null;
  const sharedPackages =
    session.creditKind && session.creditCost > 0
      ? (await listGrantsSharedWith(db, personId))
          .filter(
            (p) =>
              p.kind === session.creditKind &&
              p.unitsForMe >= session.creditCost &&
              p.startsAt.getTime() <= session.startsAt.getTime() &&
              (p.expiresAt === null || p.expiresAt.getTime() > session.startsAt.getTime()),
          )
          .map((p) => ({ grantId: p.grantId, ownerName: p.ownerName, unitsForMe: p.unitsForMe, productName: p.productName, expiresAt: p.expiresAt }))
      : [];
  const health =
    session.kind === "day" || session.kind === "night" ? await orNull(hasValidSubmission(db, { personId, formSlug: HEALTH_DECLARATION_FORM })) : null;
  const [me] = await db.select({ emergencyContact: persons.emergencyContact }).from(persons).where(eq(persons.id, personId));
  const contact = me?.emergencyContact as { name?: string; phone?: string } | null | undefined;
  return {
    session,
    availability,
    payOptions,
    credit: credit ? { ok: credit.ok, available: credit.ok ? session.creditCost : credit.available } : null,
    ticketTypes,
    guestUses,
    sharedPackages,
    healthDeclaration: health ? { valid: health.valid, expiresAt: health.expiresAt } : null,
    healthDeclarationRequired: rules.require_health_declaration && (session.kind === "day" || session.kind === "night"),
    needsEmergencyContact: session.kind === "night" && rules.require_emergency_contact_for_nights && !(contact?.name && contact.phone),
    maxGuests: rules.max_guests_per_booking,
  };
}

const myColumns = {
  id: vPersonBookings.id,
  sessionId: vPersonBookings.sessionId,
  personId: vPersonBookings.personId,
  status: vPersonBookings.status,
  paidWith: vPersonBookings.paidWith,
  isGuest: vPersonBookings.isGuest,
  ownerPersonId: vPersonBookings.ownerPersonId,
  guestOfBookingId: vPersonBookings.guestOfBookingId,
  isPayAtDesk: vPersonBookings.isPayAtDesk,
  reservedUntil: vPersonBookings.reservedUntil,
  cancelledAt: vPersonBookings.cancelledAt,
  cancelReasonCode: vPersonBookings.cancelReasonCode,
  attendedAt: vPersonBookings.attendedAt,
  version: vPersonBookings.version,
  kind: vPersonBookings.kind,
  title: vPersonBookings.title,
  startsAt: vPersonBookings.startsAt,
  endsAt: vPersonBookings.endsAt,
  location: vPersonBookings.location,
  sessionStatus: vPersonBookings.sessionStatus,
};

const mine = (personId: string) => or(eq(vPersonBookings.personId, personId), eq(vPersonBookings.ownerPersonId, personId));

/** `/account/bookings`: upcoming (live, future), past (started) or events. */
export async function listMyBookings(db: DbOrTx, personId: string, input: { scope: "upcoming" | "past" | "events" }) {
  const v = vPersonBookings;
  const scope =
    input.scope === "upcoming"
      ? and(gt(v.startsAt, sql`now()`), inArray(v.status, ["reserved", "confirmed"]))
      : input.scope === "past"
        ? lte(v.startsAt, sql`now()`)
        : eq(v.kind, "event");
  return db
    .select(myColumns)
    .from(v)
    .where(and(mine(personId), scope))
    .orderBy(input.scope === "past" ? desc(v.startsAt) : asc(v.startsAt), asc(v.id))
    .limit(200);
}

/** `/account/bookings/[id]`: the row (attendee or owner) with the QR as inline SVG for the attendee. */
export async function getMyBooking(db: DbOrTx, personId: string, id: string) {
  const [row] = await db
    .select({ ...myColumns, checkinCode: vPersonBookings.checkinCode })
    .from(vPersonBookings)
    .where(and(eq(vPersonBookings.id, id), mine(personId)));
  if (!row) throw new NotFoundError("booking_not_found");
  const { checkinCode, ...rest } = row;
  const attends = row.personId === personId;
  const live = row.status === "confirmed" || row.status === "reserved";
  const guests = await db
    .select({ id: bookings.id, firstName: persons.firstName, lastName: persons.lastName, status: bookings.status })
    .from(bookings)
    .innerJoin(persons, eq(persons.id, bookings.personId))
    .where(eq(bookings.guestOfBookingId, id))
    .orderBy(asc(bookings.createdAt));
  return { ...rest, guests, qrSvg: attends && live ? await checkinQrSvg(checkinCode) : null };
}

/** R31: sessions a customer may move this booking to (same kind, credit kind and, for orders, product). */
export async function listRescheduleTargets(db: DbOrTx, personId: string, bookingId: string): Promise<SessionSummary[]> {
  const [row] = await db
    .select({ booking: bookings, session: sessions })
    .from(bookings)
    .innerJoin(sessions, eq(sessions.id, bookings.sessionId))
    .where(and(eq(bookings.id, bookingId), eq(bookings.status, "confirmed"), or(eq(bookings.personId, personId), eq(bookings.bookedByPersonId, personId))));
  if (!row) return [];
  const rules = await getSetting(db, "booking_rules");
  // Reschedules so far along the chain (R31), walking `rescheduled_from_booking_id` back.
  let chainLength = 0;
  let prev = row.booking.rescheduledFromBookingId;
  while (prev && chainLength <= rules.max_reschedules_per_booking) {
    chainLength++;
    const [p] = await db.select({ prev: bookings.rescheduledFromBookingId }).from(bookings).where(eq(bookings.id, prev));
    prev = p?.prev ?? null;
  }
  const from = { kind: row.session.kind, startsAt: row.session.startsAt, creditKind: row.session.creditKind, productId: row.session.productId, paidWith: row.booking.paidWith };
  const now = new Date();
  const toOn = new Date(now.getTime() + rules.booking_horizon_days * 86_400_000).toISOString().slice(0, 10);
  const candidates = await listBookableSessionsApi(db, { kind: row.session.kind, fromOn: now.toISOString().slice(0, 10), toOn, personId });
  return candidates.filter(
    (c) =>
      c.sessionId !== row.session.id &&
      c.availability.bookable >= row.booking.capacityUnits &&
      canReschedule(from, { kind: c.kind, startsAt: c.startsAt, creditKind: c.creditKind, productId: c.productId }, rules, chainLength, now).ok,
  );
}
