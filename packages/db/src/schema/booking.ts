/**
 * booking tables (booking spec section 2, data model 1.2.3). Taken over by booking-P1 from the
 * Wave 0 contract stubs of `sessions` and `bookings` (every contract column kept, expand only).
 * None of these tables is APPEND or IMMUTABLE and none has a sensitive column. Foreign keys to
 * other modules use Drizzle's lazy form, so the mutual import with `commerce.ts` is safe.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  smallint,
  text,
  time,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { newCheckinCode } from "@beam/core/booking";
import { orderLines, products } from "./commerce";
import { companies, persons } from "./crm";
import { localized, timestamps, id, tstz } from "./_shared";
import { files, users } from "./platform";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const sessionTemplatesKind = pgEnum("session_templates_kind", ["day", "night", "event"]);
export const sessionTemplatesCreditKind = pgEnum("session_templates_credit_kind", ["day", "night"]);
export const sessionsKind = pgEnum("sessions_kind", ["day", "night", "event"]);
export const sessionsCreditKind = pgEnum("sessions_credit_kind", ["day", "night"]);
export const sessionsStatus = pgEnum("sessions_status", ["open", "closed", "cancelled"]);
export const sessionsEventCategory = pgEnum("sessions_event_category", [
  "lecture",
  "concert",
  "member_event",
  "experience",
  "webinar",
  "special_activity",
  "partner_event",
]);
export const sessionsLeadReleaseRule = pgEnum("sessions_lead_release_rule", ["customers_then_public", "public", "keep_for_leads"]);
export const sessionExceptionsKind = pgEnum("session_exceptions_kind", ["closed", "holiday", "special_hours"]);
export const capacityHoldsKind = pgEnum("capacity_holds_kind", ["staff", "partner", "host", "speaker", "blocked"]);
export const bookingsStatus = pgEnum("bookings_status", ["reserved", "confirmed", "cancelled", "late_cancelled", "no_show", "attended"]);
export const bookingsPaidWith = pgEnum("bookings_paid_with", ["credit", "order", "guest", "free"]);
export const bookingsSource = pgEnum("bookings_source", ["portal", "admin", "waitlist", "import", "pos", "site"]);
export const bookingsCancelReasonCode = pgEnum("bookings_cancel_reason_code", [
  "customer",
  "staff",
  "session_cancelled",
  "payment_expired",
  "order_cancelled",
  "refunded",
  "rescheduled",
  "erased",
  "duplicate",
]);
export const waitlistEntriesQueue = pgEnum("waitlist_entries_queue", ["lead", "customer", "public"]);
export const waitlistEntriesState = pgEnum("waitlist_entries_state", ["waiting", "offered", "confirmed", "released", "expired", "withdrawn"]);

// ---------------------------------------------------------------------------
// session_templates
// ---------------------------------------------------------------------------

export const sessionTemplates = pgTable(
  "session_templates",
  {
    id: id(),
    kind: sessionTemplatesKind().notNull(),
    name: localized().notNull(),
    description: localized(),
    /** ISO weekdays, 1 = Monday ... 7 = Sunday. */
    weekdays: smallint().array().notNull(),
    /** Europe/Brussels wall-clock time. */
    startTime: time().notNull(),
    durationMinutes: integer().notNull(),
    capacitySeats: integer(),
    capacityBeds: integer(),
    creditKind: sessionTemplatesCreditKind(),
    creditCost: smallint().notNull().default(1),
    productId: uuid().references((): AnyPgColumn => products.id),
    isMemberOnly: boolean().notNull().default(false),
    location: text(),
    activeFromOn: date().notNull(),
    activeToOn: date(),
    isActive: boolean().notNull().default(true),
    version: integer().notNull().default(1),
    createdByUserId: uuid().references(() => users.id),
    ...timestamps(),
  },
  (t) => [
    index("session_templates_active_kind_idx").on(t.isActive, t.kind),
    check("session_templates_weekdays_ck", sql`${t.weekdays} <@ '{1,2,3,4,5,6,7}'::smallint[] and cardinality(${t.weekdays}) >= 1`),
    check("session_templates_duration_ck", sql`${t.durationMinutes} between 15 and 1440`),
    check("session_templates_capacity_seats_ck", sql`${t.capacitySeats} >= 0`),
    check("session_templates_capacity_beds_ck", sql`${t.capacityBeds} >= 0`),
    check("session_templates_credit_cost_ck", sql`${t.creditCost} between 0 and 10`),
    check("session_templates_active_range_ck", sql`${t.activeToOn} is null or ${t.activeToOn} >= ${t.activeFromOn}`),
    check("session_templates_night_beds_ck", sql`(${t.kind} = 'night') = (${t.capacityBeds} is not null)`),
    check("session_templates_seats_ck", sql`${t.kind} = 'night' or ${t.capacitySeats} is not null`),
    check("session_templates_credit_kind_ck", sql`${t.kind} = 'event' or ${t.creditKind} is not null`),
  ],
);

// ---------------------------------------------------------------------------
// session_exceptions
// ---------------------------------------------------------------------------

export const sessionExceptions = pgTable(
  "session_exceptions",
  {
    id: id(),
    /** Europe/Brussels calendar date. */
    onDate: date().notNull(),
    kind: sessionExceptionsKind().notNull(),
    /** null = every template. */
    templateIds: uuid().array(),
    opensAt: time(),
    closesAt: time(),
    name: localized().notNull(),
    note: text(),
    version: integer().notNull().default(1),
    createdByUserId: uuid().references(() => users.id),
    ...timestamps(),
  },
  (t) => [
    index("session_exceptions_on_date_idx").on(t.onDate),
    check("session_exceptions_special_hours_ck", sql`(${t.kind} = 'special_hours') = (${t.opensAt} is not null and ${t.closesAt} is not null)`),
    check("session_exceptions_hours_order_ck", sql`${t.closesAt} is null or ${t.opensAt} is null or ${t.closesAt} > ${t.opensAt}`),
  ],
);

// ---------------------------------------------------------------------------
// sessions
// ---------------------------------------------------------------------------

export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    templateId: uuid().references((): AnyPgColumn => sessionTemplates.id),
    templateVersion: integer(),
    kind: sessionsKind().notNull(),
    title: localized().notNull(),
    description: localized(),
    startsAt: tstz().notNull(),
    endsAt: tstz().notNull(),
    capacitySeats: integer(),
    capacityBeds: integer(),
    creditKind: sessionsCreditKind(),
    creditCost: smallint().notNull().default(1),
    productId: uuid().references((): AnyPgColumn => products.id),
    status: sessionsStatus().notNull().default("open"),
    eventCategory: sessionsEventCategory(),
    partnerCompanyId: uuid().references((): AnyPgColumn => companies.id, { onDelete: "set null" }),
    publishedAt: tstz(),
    hasManualChanges: boolean().notNull().default(false),
    isMemberOnly: boolean().notNull().default(false),
    isLeadMagnet: boolean().notNull().default(false),
    leadReservedSeats: integer().notNull().default(0),
    leadWindowStartAt: tstz(),
    leadWindowEndAt: tstz(),
    leadReleaseRule: sessionsLeadReleaseRule().notNull().default("customers_then_public"),
    publicReleaseAt: tstz(),
    isWaitlistPositionVisible: boolean().notNull().default(false),
    claimWindowMinutes: integer().notNull().default(120),
    // Plain uuid, no FK: `webinars.session_id` is the owning FK (webinar module).
    webinarId: uuid(),
    location: text(),
    notes: text(),
    cancelledAt: tstz(),
    cancelReason: text(),
    ...timestamps(),
  },
  (t) => [
    index("sessions_starts_at_idx").on(t.startsAt),
    index("sessions_open_kind_idx")
      .on(t.kind, t.startsAt)
      .where(sql`${t.status} = 'open'`),
    index("sessions_ends_at_idx")
      .on(t.endsAt)
      .where(sql`${t.status} <> 'cancelled'`),
    uniqueIndex("sessions_template_starts_uq")
      .on(t.templateId, t.startsAt)
      .where(sql`${t.templateId} is not null`),
    uniqueIndex("sessions_webinar_uq")
      .on(t.webinarId)
      .where(sql`${t.webinarId} is not null`),
    check("sessions_ends_after_starts_ck", sql`${t.endsAt} > ${t.startsAt}`),
    check(
      "sessions_lead_seats_ck",
      sql`${t.leadReservedSeats} >= 0 and ${t.leadReservedSeats} <= coalesce(${t.capacitySeats}, ${t.capacityBeds})`,
    ),
    check(
      "sessions_lead_window_ck",
      sql`${t.leadWindowEndAt} is null or ${t.leadWindowStartAt} is null or ${t.leadWindowEndAt} > ${t.leadWindowStartAt}`,
    ),
    check("sessions_claim_window_ck", sql`${t.claimWindowMinutes} between 10 and 2880`),
    check(
      "sessions_lead_magnet_ck",
      sql`${t.isLeadMagnet} = false or (${t.kind} = 'event' and ${t.leadWindowStartAt} is not null and ${t.leadWindowEndAt} is not null)`,
    ),
    check("sessions_capacity_seats_ck", sql`${t.capacitySeats} >= 0`),
    check("sessions_capacity_beds_ck", sql`${t.capacityBeds} >= 0`),
    check("sessions_night_beds_ck", sql`(${t.kind} = 'night') = (${t.capacityBeds} is not null)`),
    check("sessions_seats_ck", sql`${t.kind} = 'night' or ${t.capacitySeats} is not null`),
    check("sessions_credit_cost_ck", sql`${t.creditCost} between 0 and 10`),
    check("sessions_cancelled_at_ck", sql`(${t.status} = 'cancelled') = (${t.cancelledAt} is not null)`),
    // Exactly the events carry a category (data model, `sessions` checks).
    check("sessions_event_category_ck", sql`(${t.kind} = 'event') = (${t.eventCategory} is not null)`),
  ],
);

// ---------------------------------------------------------------------------
// capacity_holds
// ---------------------------------------------------------------------------

export const capacityHolds = pgTable(
  "capacity_holds",
  {
    id: id(),
    sessionId: uuid()
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    kind: capacityHoldsKind().notNull(),
    quantity: integer().notNull(),
    companyId: uuid().references((): AnyPgColumn => companies.id, { onDelete: "set null" }),
    note: text(),
    createdByUserId: uuid().references(() => users.id),
    ...timestamps(),
  },
  (t) => [
    index("capacity_holds_session_idx").on(t.sessionId),
    index("capacity_holds_company_idx")
      .on(t.companyId)
      .where(sql`${t.companyId} is not null`),
    check("capacity_holds_quantity_ck", sql`${t.quantity} > 0`),
    check("capacity_holds_partner_company_ck", sql`${t.kind} <> 'partner' or ${t.companyId} is not null`),
  ],
);

// ---------------------------------------------------------------------------
// ticket_types (used from R2)
// ---------------------------------------------------------------------------

export const ticketTypes = pgTable(
  "ticket_types",
  {
    id: id(),
    sessionId: uuid()
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    productId: uuid()
      .notNull()
      .references((): AnyPgColumn => products.id),
    name: localized().notNull(),
    capacity: integer(),
    isMemberOnly: boolean().notNull().default(false),
    salesStartAt: tstz(),
    salesEndAt: tstz(),
    maxPerBooking: smallint().notNull().default(4),
    requiresGuestDetails: boolean().notNull().default(true),
    sortOrder: smallint().notNull().default(0),
    isActive: boolean().notNull().default(true),
    ...timestamps(),
  },
  (t) => [
    index("ticket_types_session_sort_idx").on(t.sessionId, t.sortOrder),
    check("ticket_types_capacity_ck", sql`${t.capacity} > 0`),
    check("ticket_types_sales_window_ck", sql`${t.salesEndAt} is null or ${t.salesStartAt} is null or ${t.salesEndAt} > ${t.salesStartAt}`),
    check("ticket_types_max_per_booking_ck", sql`${t.maxPerBooking} >= 1`),
  ],
);

// ---------------------------------------------------------------------------
// bookings
// ---------------------------------------------------------------------------

export const bookings = pgTable(
  "bookings",
  {
    id: id(),
    sessionId: uuid()
      .notNull()
      .references(() => sessions.id),
    personId: uuid()
      .notNull()
      .references(() => persons.id, { onDelete: "restrict" }),
    status: bookingsStatus().notNull(),
    paidWith: bookingsPaidWith().notNull(),
    guestOfBookingId: uuid().references((): AnyPgColumn => bookings.id),
    /** Seats or beds this row uses; 0 = a guest sharing the owner's bed (R13). */
    capacityUnits: smallint().notNull().default(1),
    orderLineId: uuid().references((): AnyPgColumn => orderLines.id),
    ticketTypeId: uuid().references((): AnyPgColumn => ticketTypes.id),
    capacityHoldId: uuid().references((): AnyPgColumn => capacityHolds.id),
    usedLeadSeat: boolean().notNull().default(false),
    isOverCapacity: boolean().notNull().default(false),
    isPayAtDesk: boolean().notNull().default(false),
    bookedByUserId: uuid().references(() => users.id),
    bookedByPersonId: uuid().references(() => persons.id),
    source: bookingsSource().notNull(),
    /** Id in the source system for imports (`simplybook:12345`). */
    externalRef: text(),
    reservedUntil: tstz(),
    rescheduledFromBookingId: uuid().references((): AnyPgColumn => bookings.id),
    /** 10 characters Crockford base32, in the QR code; Drizzle fills a fresh one on insert. */
    checkinCode: text()
      .notNull()
      .$defaultFn(() => newCheckinCode()),
    qrFileId: uuid().references(() => files.id),
    reminderSentAt: tstz(),
    cancelledAt: tstz(),
    cancelReasonCode: bookingsCancelReasonCode(),
    cancelReason: text(),
    attendedAt: tstz(),
    noShowMarkedAt: tstz(),
    notes: text(),
    version: integer().notNull().default(1),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("bookings_session_person_active_uq")
      .on(t.sessionId, t.personId)
      .where(sql`${t.status} in ('reserved', 'confirmed')`),
    uniqueIndex("bookings_checkin_code_uq").on(t.checkinCode),
    uniqueIndex("bookings_external_ref_uq")
      .on(t.externalRef)
      .where(sql`${t.externalRef} is not null`),
    index("bookings_session_status_idx").on(t.sessionId, t.status),
    index("bookings_person_created_idx").on(t.personId, t.createdAt.desc()),
    index("bookings_guest_of_idx")
      .on(t.guestOfBookingId)
      .where(sql`${t.guestOfBookingId} is not null`),
    index("bookings_order_line_idx")
      .on(t.orderLineId)
      .where(sql`${t.orderLineId} is not null`),
    index("bookings_reserved_until_idx")
      .on(t.reservedUntil)
      .where(sql`${t.status} = 'reserved'`),
    index("bookings_rescheduled_from_idx")
      .on(t.rescheduledFromBookingId)
      .where(sql`${t.rescheduledFromBookingId} is not null`),
    index("bookings_capacity_hold_idx")
      .on(t.capacityHoldId)
      .where(sql`${t.capacityHoldId} is not null`),
    check("bookings_guest_not_self_ck", sql`${t.guestOfBookingId} <> ${t.id}`),
    check("bookings_reserved_until_ck", sql`${t.status} <> 'reserved' or ${t.reservedUntil} is not null`),
    check("bookings_attended_at_ck", sql`${t.status} <> 'attended' or ${t.attendedAt} is not null`),
    check("bookings_capacity_units_ck", sql`${t.capacityUnits} between 0 and 1`),
    check("bookings_order_line_ck", sql`${t.paidWith} <> 'order' or ${t.orderLineId} is not null or ${t.status} = 'reserved'`),
    check(
      "bookings_cancelled_ck",
      sql`${t.status} not in ('cancelled', 'late_cancelled') or (${t.cancelledAt} is not null and ${t.cancelReasonCode} is not null)`,
    ),
    check("bookings_pay_at_desk_ck", sql`not ${t.isPayAtDesk} or ${t.paidWith} = 'order'`),
  ],
);

// ---------------------------------------------------------------------------
// waitlist_entries
// ---------------------------------------------------------------------------

export const waitlistEntries = pgTable(
  "waitlist_entries",
  {
    id: id(),
    sessionId: uuid()
      .notNull()
      .references(() => sessions.id),
    personId: uuid()
      .notNull()
      .references(() => persons.id, { onDelete: "restrict" }),
    queue: waitlistEntriesQueue().notNull().default("public"),
    state: waitlistEntriesState().notNull().default("waiting"),
    joinedAt: tstz().notNull().defaultNow(),
    offeredAt: tstz(),
    offerExpiresAt: tstz(),
    offersCount: smallint().notNull().default(0),
    rejoinCount: smallint().notNull().default(0),
    /** sha256 hex of the claim token (R43). */
    claimTokenHash: text(),
    bookingId: uuid().references((): AnyPgColumn => bookings.id),
    isFlaggedDuplicate: boolean().notNull().default(false),
    flagReason: text(),
    flagReviewedByUserId: uuid().references(() => users.id),
    flagReviewedAt: tstz(),
    /** Personal data: lower-case, `+tag` removed, gmail dots removed. */
    emailNormalised: text(),
    /** Personal data: sha256(ip || HKDF(AUTH_SECRET, 'beam-ip-v1')). */
    joinIpHash: text(),
    endedReason: text(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("waitlist_entries_session_person_uq").on(t.sessionId, t.personId),
    uniqueIndex("waitlist_entries_claim_token_uq")
      .on(t.claimTokenHash)
      .where(sql`${t.claimTokenHash} is not null`),
    index("waitlist_entries_queue_idx").on(t.sessionId, t.state, t.queue, t.joinedAt),
    index("waitlist_entries_offer_expiry_idx")
      .on(t.offerExpiresAt)
      .where(sql`${t.state} = 'offered'`),
    index("waitlist_entries_session_email_idx").on(t.sessionId, t.emailNormalised),
    index("waitlist_entries_person_idx").on(t.personId),
    check("waitlist_entries_offered_ck", sql`${t.state} <> 'offered' or ${t.offerExpiresAt} is not null`),
    check("waitlist_entries_confirmed_ck", sql`${t.state} <> 'confirmed' or ${t.bookingId} is not null`),
    check("waitlist_entries_offers_count_ck", sql`${t.offersCount} between 0 and 5`),
    check("waitlist_entries_rejoin_count_ck", sql`${t.rejoinCount} between 0 and 1`),
    check(
      "waitlist_entries_ended_reason_ck",
      sql`${t.endedReason} is null or ${t.endedReason} in ('declined', 'session_started', 'session_cancelled', 'staff', 'booked_directly', 'offer_timeout', 'payment_not_completed', 'flag_withdrawn', 'customer')`,
    ),
  ],
);
