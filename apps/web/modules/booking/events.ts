/**
 * booking timeline facts (booking spec 4.7 and R61, data model 4.2). Facade read by
 * `pnpm gen:indexes`: every `kind` is a literal. Booking facts start with `booking.`, waitlist
 * facts with `waitlist.` (decision 10, cross-module D53). All have subject `person`, are not
 * sensitive and carry the R61 contract keys that crm's timeline, segments and automation read;
 * `ref` is `{ type: 'booking' | 'waitlist_entry', id }` and `dedupeKey` follows R61.
 */
import { z } from "zod";
import { BOOKING_SOURCES, CANCEL_REASON_CODES, EVENT_CATEGORIES, PAID_WITH, SESSION_KINDS, WAITLIST_QUEUES } from "@beam/core/booking";
import { defineEvent } from "@/lib/events";

/** An instant: a `Date` or an ISO string, stored as ISO text. */
const instant = z.union([z.date(), z.iso.datetime({ offset: true })]).transform((v) => (typeof v === "string" ? v : v.toISOString()));

/** Who caused a change (`data.by`): the customer, staff, BEAM cancelling a session, or the system. */
export const EventActor = z.enum(["customer", "staff", "beam", "system"]);

/** R61: the keys every booking and waitlist fact carries. */
export const BookingFactData = z.object({
  session_id: z.uuid(),
  session_kind: z.enum(SESSION_KINDS),
  event_category: z.enum(EVENT_CATEGORIES).nullable(),
  starts_at: instant,
  paid_with: z.enum(PAID_WITH).nullable(),
  is_guest: z.boolean(),
  guest_of_person_id: z.uuid().nullable(),
  owner_person_id: z.uuid(),
  /** No earlier non-cancelled booking of the person (computed under the person row lock). */
  is_first_booking: z.boolean(),
  /** No earlier `attended` row of kind day or night. */
  is_first_visit: z.boolean(),
  queue: z.enum(WAITLIST_QUEUES).nullable(),
  /** Optional context. */
  booking_id: z.uuid().optional(),
  source: z.enum(BOOKING_SOURCES).optional(),
  by: EventActor.optional(),
  partner_company_id: z.uuid().nullable().optional(),
});
export type BookingFactData = z.input<typeof BookingFactData>;

const ConfirmedData = BookingFactData.extend({ rescheduled_from_booking_id: z.uuid().nullable().optional() });
const CancelledData = BookingFactData.extend({ cancel_reason_code: z.enum(CANCEL_REASON_CODES) });
const RescheduledData = BookingFactData.extend({ rescheduled_from_booking_id: z.uuid(), new_booking_id: z.uuid() });
const EventEndedData = BookingFactData.extend({ attended: z.boolean() });
const OfferedData = BookingFactData.extend({ offer_expires_at: instant, offers_count: z.number().int().min(1).max(5) });
const RequeuedData = BookingFactData.extend({
  from: z.enum(WAITLIST_QUEUES),
  to: z.enum(WAITLIST_QUEUES),
  reason: z.enum(["status_changed", "staff"]),
});
const FlaggedData = BookingFactData.extend({ signals: z.array(z.string()).min(1) });
const WaitlistEndData = BookingFactData.extend({ ended_reason: z.string().nullable().optional() });

export const events = [
  defineEvent({ kind: "booking.reserved", data: BookingFactData, subject: "person" }),
  defineEvent({ kind: "booking.confirmed", data: ConfirmedData, subject: "person" }),
  defineEvent({ kind: "booking.cancelled", data: CancelledData, subject: "person" }),
  defineEvent({ kind: "booking.late_cancelled", data: CancelledData, subject: "person" }),
  defineEvent({ kind: "booking.rescheduled", data: RescheduledData, subject: "person" }),
  defineEvent({ kind: "booking.guest_added", data: BookingFactData, subject: "person" }),
  defineEvent({ kind: "booking.attended", data: BookingFactData, subject: "person" }),
  defineEvent({ kind: "booking.check_in_undone", data: BookingFactData, subject: "person" }),
  defineEvent({ kind: "booking.no_show", data: BookingFactData, subject: "person" }),
  defineEvent({ kind: "booking.event_ended", data: EventEndedData, subject: "person" }),
  defineEvent({ kind: "waitlist.joined", data: BookingFactData, subject: "person" }),
  defineEvent({ kind: "waitlist.flagged", data: FlaggedData, subject: "person" }),
  defineEvent({ kind: "waitlist.requeued", data: RequeuedData, subject: "person" }),
  defineEvent({ kind: "waitlist.offered", data: OfferedData, subject: "person" }),
  defineEvent({ kind: "waitlist.confirmed", data: WaitlistEndData, subject: "person" }),
  defineEvent({ kind: "waitlist.expired", data: WaitlistEndData, subject: "person" }),
  defineEvent({ kind: "waitlist.released", data: WaitlistEndData, subject: "person" }),
  defineEvent({ kind: "waitlist.withdrawn", data: WaitlistEndData, subject: "person" }),
];
