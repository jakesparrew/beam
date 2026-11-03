/**
 * booking's cross-module door (02-data-model section 6.3). Wave 0 stubs by platform-P7 with the
 * owner's final signatures: each throws `NotImplementedError('booking.<fn>')` until booking
 * implements it. `getBookingHealth` is platform-P5's forward stub, kept unchanged (DR-10):
 * platform's `/api/health` and `platform.check_alerts` call it; booking-P3b implements it.
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

export type { Availability, BookingHealth, EventCategory, PersonBookingRow, SessionCard, SessionKind, SessionStatus, SessionSummary } from "@beam/core/booking";

const notYet = <T>(fn: string): Promise<T> => Promise.reject(new NotImplementedError(`booking.${fn}`));

// availability ------------------------------------------------------------------

export function getAvailability(
  _db: DbOrTx,
  _input: { sessionId: string; personId?: string; at?: Date },
): Promise<
  Availability & { sessionId: string; kind: SessionKind; productId: string | null; capacity: number; held: number; booked: number; waiting: number }
> {
  return notYet("getAvailability");
}

export function getAvailabilityPreview(
  _db: DbOrTx,
  _input: { kind: "day" | "night"; from: Date; to: Date },
): Promise<Array<{ sessionId: string; startsAt: Date; band: AvailabilityBand }>> {
  return notYet("getAvailabilityPreview");
}

export function listBookableSessions(
  _db: DbOrTx,
  _input: { kind?: SessionKind; fromOn: string; toOn: string; personId?: string },
): Promise<SessionSummary[]> {
  return notYet("listBookableSessions");
}

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

export function getSessionCards(_tx: DbOrTx, _sessionIds: string[], _locale: Locale): Promise<SessionCard[]> {
  return notYet("getSessionCards");
}

export function getOpeningHours(
  _db: DbOrTx,
  _input: { from: string; to: string },
): Promise<Array<{ onDate: string; opensAt: string | null; closesAt: string | null; exceptionName: LocalizedText | null }>> {
  return notYet("getOpeningHours");
}

export function nextOpeningAt(_db: DbOrTx, _from: Date, _opts?: { includePublicHolidays?: boolean }): Promise<Date | null> {
  return notYet("nextOpeningAt");
}

// commerce hooks ------------------------------------------------------------------

export function confirmBookingsForOrder(
  _tx: Tx,
  _ctx: Ctx,
  _input: { orderId: string },
): Promise<{ confirmedBookingIds: string[]; unavailableOrderLineIds: string[] }> {
  return notYet("confirmBookingsForOrder");
}

export function releaseBookingsForOrder(
  _tx: Tx,
  _ctx: Ctx,
  _input: { orderId: string; reason: "payment_expired" | "payment_failed" | "order_cancelled" },
): Promise<{ releasedBookingIds: string[] }> {
  return notYet("releaseBookingsForOrder");
}

export function cancelBookingsForOrderLine(
  _tx: Tx,
  _ctx: Ctx,
  _input: { orderLineId: string; reason: "refunded" },
): Promise<{ cancelledBookingIds: string[] }> {
  return notYet("cancelBookingsForOrderLine");
}

export function createBookingForPosLine(
  _tx: Tx,
  _ctx: Ctx,
  _input: { orderLineId: string; sessionId: string; personId: string },
): Promise<{ bookingId: string }> {
  return notYet("createBookingForPosLine");
}

// people and history -------------------------------------------------------------

export function hasFutureBooking(_db: DbOrTx, _personId: string, _kinds?: SessionKind[]): Promise<boolean> {
  return notYet("hasFutureBooking");
}

export function getNextBooking(
  _tx: DbOrTx,
  _personId: string,
): Promise<{ bookingId: string; sessionId: string; startsAt: Date; kind: SessionKind } | null> {
  return notYet("getNextBooking");
}

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

export function listPersonBookings(_db: DbOrTx, _personId: string, _opts?: { limit?: number }): Promise<PersonBookingRow[]> {
  return notYet("listPersonBookings");
}

export function listUpcomingBookingsForPerson(
  _db: DbOrTx,
  _personId: string,
  _limit: number,
): Promise<
  Array<{ bookingId: string; sessionId: string; title: LocalizedText; kind: SessionKind; startsAt: Date; isGuest: boolean; guestFirstName: string | null }>
> {
  return notYet("listUpcomingBookingsForPerson");
}

export function listOpenOffersForPerson(
  _db: DbOrTx,
  _personId: string,
): Promise<Array<{ entryId: string; sessionId: string; title: LocalizedText; startsAt: Date; offerExpiresAt: Date }>> {
  return notYet("listOpenOffersForPerson");
}

export function importBooking(
  _tx: Tx,
  _ctx: Ctx,
  _row: { externalRef: string; personId: string; kind: SessionKind; startsAt: Date; paidWith: "credit" | "order" | "free" },
): Promise<{ bookingId: string | null; outcome: "created" | "existing" | "no_session" | "over_capacity" }> {
  return notYet("importBooking");
}

export function getBookingHealth(db: DbOrTx): Promise<BookingHealth> {
  void db;
  return Promise.reject(new NotImplementedError("booking.getBookingHealth"));
}

// webinar (R2) ---------------------------------------------------------------------

export function upsertWebinarSession(
  _tx: Tx,
  _ctx: Ctx,
  _input: { webinarId: string; sessionId?: string; title: LocalizedText; startsAt: Date; endsAt: Date },
): Promise<{ sessionId: string; created: boolean }> {
  return notYet("upsertWebinarSession");
}

export function cancelWebinarSession(_tx: Tx, _ctx: Ctx, _input: { webinarId: string; reason: string }): Promise<{ cancelled: boolean }> {
  return notYet("cancelWebinarSession");
}
