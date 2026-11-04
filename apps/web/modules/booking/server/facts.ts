/**
 * Booking facts (booking spec R61, 4.7): one `activity_events` row per booking state change,
 * written through `ctx.recordEvent` with `dedupe_key = booking:<id>:<kind suffix>:<version>` and
 * the contract `data` keys crm's timeline, segments and automation read. `is_first_booking` and
 * `is_first_visit` are computed in the writing transaction after the person row lock, so two
 * parallel first bookings cannot both claim them.
 */
import type { DbOrTx } from "@beam/db";
import { bookings, persons, sessions } from "@beam/db/schema";
import type { BookingSource, CancelReasonCode, EventCategory, PaidWith, SessionKind, WaitlistQueue } from "@beam/core/booking";
import { and, eq, inArray, ne, notInArray, sql, type Ctx } from "@/lib/ctx";

/** The booking facts this module writes (`events.ts`). */
export type BookingFactKind =
  | "booking.reserved"
  | "booking.confirmed"
  | "booking.cancelled"
  | "booking.late_cancelled"
  | "booking.rescheduled"
  | "booking.guest_added"
  | "booking.attended"
  | "booking.check_in_undone"
  | "booking.no_show"
  | "booking.event_ended";

/** The booking row fields a fact needs (a `bookings` select row fits). */
export type FactBooking = {
  id: string;
  sessionId: string;
  personId: string;
  paidWith: PaidWith;
  guestOfBookingId: string | null;
  bookedByPersonId: string | null;
  source: BookingSource;
  version: number;
};

export type FactSession = { kind: SessionKind; eventCategory: EventCategory | null; startsAt: Date; partnerCompanyId?: string | null };

export type FactExtra = {
  /** The session; read from the database when missing. */
  session?: FactSession;
  /** Who caused the change (`data.by`). */
  by?: "customer" | "staff" | "beam" | "system";
  /** Overrides the computed value (a reschedule carries the old row's value over, R31). */
  isFirstBooking?: boolean;
  isFirstVisit?: boolean;
  queue?: WaitlistQueue | null;
  cancelReasonCode?: CancelReasonCode;
  rescheduledFromBookingId?: string | null;
  newBookingId?: string;
  attended?: boolean;
  /** The timeline the fact is written to; default the attendee. `booking.guest_added` uses the owner (R58). */
  subjectPersonId?: string;
  /** Overrides the version part of the dedupe key. */
  dedupeVersion?: number | string;
  /** Event mode (`replay` for imports, so automations do not react). */
  mode?: "live" | "replay" | "on_demand";
};

const NOT_COUNTED: readonly ("cancelled" | "late_cancelled")[] = ["cancelled", "late_cancelled"];

/** Takes the person row lock (R61) for the first-booking and first-visit flags. */
export async function lockPerson(tx: DbOrTx, personId: string): Promise<void> {
  await tx.select({ id: persons.id }).from(persons).where(eq(persons.id, personId)).for("update");
}

/** R61: no other non-cancelled booking of the person (call after `lockPerson`). */
export async function isFirstBooking(tx: DbOrTx, personId: string, exceptBookingId: string): Promise<boolean> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(bookings)
    .where(and(eq(bookings.personId, personId), ne(bookings.id, exceptBookingId), notInArray(bookings.status, [...NOT_COUNTED])));
  return Number(row?.n ?? 0) === 0;
}

/** R61: no other `attended` row of kind day or night. */
export async function isFirstVisit(tx: DbOrTx, personId: string, exceptBookingId: string): Promise<boolean> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(bookings)
    .innerJoin(sessions, eq(sessions.id, bookings.sessionId))
    .where(
      and(
        eq(bookings.personId, personId),
        ne(bookings.id, exceptBookingId),
        eq(bookings.status, "attended"),
        inArray(sessions.kind, ["day", "night"]),
      ),
    );
  return Number(row?.n ?? 0) === 0;
}

const suffixOf = (kind: BookingFactKind) => kind.slice("booking.".length);

/** The R61 dedupe key of a booking fact. */
export function bookingFactKey(kind: BookingFactKind, bookingId: string, version: number | string): string {
  return `booking:${bookingId}:${suffixOf(kind)}:${version}`;
}

/** Writes one booking fact. Returns the event id, or null when the dedupe key already exists. */
export async function recordBookingFact(ctx: Ctx, kind: BookingFactKind, booking: FactBooking, extra: FactExtra = {}): Promise<{ id: bigint | null }> {
  const tx = ctx.tx;
  let session = extra.session;
  if (!session) {
    const [s] = await tx
      .select({ kind: sessions.kind, eventCategory: sessions.eventCategory, startsAt: sessions.startsAt, partnerCompanyId: sessions.partnerCompanyId })
      .from(sessions)
      .where(eq(sessions.id, booking.sessionId));
    if (!s) throw new Error(`recordBookingFact: unknown session ${booking.sessionId}`);
    session = s;
  }
  let ownerPersonId = booking.personId;
  let guestOfPersonId: string | null = null;
  if (booking.guestOfBookingId) {
    const [owner] = await tx.select({ personId: bookings.personId }).from(bookings).where(eq(bookings.id, booking.guestOfBookingId));
    if (owner) {
      ownerPersonId = owner.personId;
      guestOfPersonId = owner.personId;
    }
  }
  let firstBooking = extra.isFirstBooking;
  let firstVisit = extra.isFirstVisit;
  if (firstBooking === undefined || firstVisit === undefined) {
    await lockPerson(tx, booking.personId);
    firstBooking ??= await isFirstBooking(tx, booking.personId, booking.id);
    firstVisit ??= await isFirstVisit(tx, booking.personId, booking.id);
  }
  const data: Record<string, unknown> = {
    session_id: booking.sessionId,
    session_kind: session.kind,
    event_category: session.eventCategory ?? null,
    starts_at: session.startsAt,
    paid_with: booking.paidWith,
    is_guest: booking.guestOfBookingId !== null,
    guest_of_person_id: guestOfPersonId,
    owner_person_id: ownerPersonId,
    is_first_booking: firstBooking,
    is_first_visit: firstVisit,
    queue: extra.queue ?? null,
    booking_id: booking.id,
    source: booking.source,
  };
  if (extra.by) data.by = extra.by;
  if (session.partnerCompanyId) data.partner_company_id = session.partnerCompanyId;
  if (kind === "booking.confirmed" && extra.rescheduledFromBookingId !== undefined) data.rescheduled_from_booking_id = extra.rescheduledFromBookingId;
  if (kind === "booking.cancelled" || kind === "booking.late_cancelled") data.cancel_reason_code = extra.cancelReasonCode;
  if (kind === "booking.rescheduled") {
    data.rescheduled_from_booking_id = extra.rescheduledFromBookingId;
    data.new_booking_id = extra.newBookingId;
  }
  if (kind === "booking.event_ended") data.attended = extra.attended ?? false;
  return ctx.recordEvent({
    kind,
    personId: extra.subjectPersonId ?? booking.personId,
    data,
    ref: { type: "booking", id: booking.id },
    dedupeKey: bookingFactKey(kind, booking.id, extra.dedupeVersion ?? booking.version),
    ...(extra.mode ? { mode: extra.mode } : {}),
  });
}
