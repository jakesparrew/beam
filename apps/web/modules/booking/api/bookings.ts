/**
 * booking api, area `bookings` (booking spec 4.9 file layout): availability, the commerce hooks,
 * people and history, the import and booking health. Typed stubs by booking-P1 with the final
 * signatures of 02-data-model 6.3; booking-P3a implements them (`cancelBookingsForOrderLine` and
 * `getBookingHealth` by booking-P3b, `opensForCustomersAt` of `getSessionCards` by booking-P7).
 * `getBookingHealth` is platform-P5's forward stub, kept unchanged (DR-10).
 */
import type { DbOrTx, Tx } from "@beam/db";
import { NotImplementedError } from "@beam/core/errors";
import type { Locale, LocalizedText } from "@beam/core/i18n";
import type {
  Availability,
  AvailabilityBand,
  BookingHealth,
  EventCategory,
  PersonBookingRow,
  SessionCard,
  SessionKind,
  SessionStatus,
  SessionSummary,
} from "@beam/core/booking";
import type { Ctx } from "@/lib/ctx";

const notYet = <T>(fn: string): Promise<T> => Promise.reject(new NotImplementedError(`booking.${fn}`));

// availability ------------------------------------------------------------------

/** One session's availability for a person (or the public), with the view's pools (Wave 0 contract). */
export function getAvailability(
  _db: DbOrTx,
  _input: { sessionId: string; personId?: string; at?: Date },
): Promise<
  Availability & { sessionId: string; kind: SessionKind; productId: string | null; capacity: number; held: number; booked: number; waiting: number }
> {
  return notYet("getAvailability");
}

/** Site `availability_preview` block. */
export function getAvailabilityPreview(
  _db: DbOrTx,
  _input: { kind: "day" | "night"; from: Date; to: Date },
): Promise<Array<{ sessionId: string; startsAt: Date; band: AvailabilityBand }>> {
  return notYet("getAvailabilityPreview");
}

/** Customer booking lists and commerce's POS session picker. */
export function listBookableSessions(
  _db: DbOrTx,
  _input: { kind?: SessionKind; fromOn: string; toOn: string; personId?: string },
): Promise<SessionSummary[]> {
  return notYet("listBookableSessions");
}

/** Site events pages; webinar sessions included. */
export function listPublicEvents(
  _db: DbOrTx,
  _input: { from: Date; limit: number; offset: number },
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
  return notYet("listPublicEvents");
}

/** Email `event` block; `opensForCustomersAt` stays null until booking-P7. */
export function getSessionCards(_tx: DbOrTx, _sessionIds: string[], _locale: Locale): Promise<SessionCard[]> {
  return notYet("getSessionCards");
}

// commerce hooks (R18; booking reserves before createOrder) -------------------------

/** In commerce's paid transaction; also confirms linked waitlist entries. */
export function confirmBookingsForOrder(
  _tx: Tx,
  _ctx: Ctx,
  _input: { orderId: string },
): Promise<{ confirmedBookingIds: string[]; unavailableOrderLineIds: string[] }> {
  return notYet("confirmBookingsForOrder");
}

/** Order ended unpaid: codes `payment_expired` (also for `payment_failed`) or `order_cancelled`. */
export function releaseBookingsForOrder(
  _tx: Tx,
  _ctx: Ctx,
  _input: { orderId: string; reason: "payment_expired" | "payment_failed" | "order_cancelled" },
): Promise<{ releasedBookingIds: string[] }> {
  return notYet("releaseBookingsForOrder");
}

/** Staff refund in commerce; code `refunded`, never a second refund. */
export function cancelBookingsForOrderLine(
  _tx: Tx,
  _ctx: Ctx,
  _input: { orderLineId: string; reason: "refunded" },
): Promise<{ cancelledBookingIds: string[] }> {
  return notYet("cancelBookingsForOrderLine");
}

/** POS walk-in: `reserved` until the POS payment; throws `ConflictError('session_full'|'member_only'|'already_booked')`. */
export function createBookingForPosLine(
  _tx: Tx,
  _ctx: Ctx,
  _input: { orderLineId: string; sessionId: string; personId: string },
): Promise<{ bookingId: string }> {
  return notYet("createBookingForPosLine");
}

// people and history -------------------------------------------------------------

/** Automation `unless`. */
export function hasFutureBooking(_db: DbOrTx, _personId: string, _kinds?: SessionKind[]): Promise<boolean> {
  return notYet("hasFutureBooking");
}

/** Email tokens. */
export function getNextBooking(
  _tx: DbOrTx,
  _personId: string,
): Promise<{ bookingId: string; sessionId: string; startsAt: Date; kind: SessionKind } | null> {
  return notYet("getNextBooking");
}

/** Ops' person_stats and churn inputs. */
export function getPersonBookingSummary(
  _db: DbOrTx,
  _personId: string,
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
  return notYet("getPersonBookingSummary");
}

/** crm person page. */
export function listPersonBookings(_db: DbOrTx, _personId: string, _opts?: { limit?: number }): Promise<PersonBookingRow[]> {
  return notYet("listPersonBookings");
}

/** Site account home: live rows where the person is attendee or booker, `starts_at > now()`. */
export function listUpcomingBookingsForPerson(
  _db: DbOrTx,
  _personId: string,
  _limit: number,
): Promise<
  Array<{ bookingId: string; sessionId: string; title: LocalizedText; kind: SessionKind; startsAt: Date; isGuest: boolean; guestFirstName: string | null }>
> {
  return notYet("listUpcomingBookingsForPerson");
}

/** Ops cut-over import (R65): `confirmed`, `source = 'import'`, idempotent on `external_ref`. */
export function importBooking(
  _tx: Tx,
  _ctx: Ctx,
  _row: { externalRef: string; personId: string; kind: SessionKind; startsAt: Date; paidWith: "credit" | "order" | "free" },
): Promise<{ bookingId: string | null; outcome: "created" | "existing" | "no_session" | "over_capacity" }> {
  return notYet("importBooking");
}

/** Monitoring (4.8): platform's `/api/health` (`checks.booking`) and `platform.check_alerts`. */
export function getBookingHealth(db: DbOrTx): Promise<BookingHealth> {
  void db;
  return Promise.reject(new NotImplementedError("booking.getBookingHealth"));
}
