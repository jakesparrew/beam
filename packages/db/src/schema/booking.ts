/**
 * booking contract stubs created by Wave 0 on behalf of booking (platform-P2): `sessions` and
 * `bookings` with their architecture columns (data model 1.2.3). booking takes the file over and
 * adds columns, tables and the foreign keys to its own Wave 1 tables (expand only).
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  smallint,
  text,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { orderLines } from "./commerce";
import { persons } from "./crm";
import { localized, timestamps, id, tstz } from "./_shared";
import { users } from "./platform";

export const sessionsKind = pgEnum("sessions_kind", ["day", "night", "event"]);
export const sessionsCreditKind = pgEnum("sessions_credit_kind", [
  "day",
  "night",
]);
export const sessionsStatus = pgEnum("sessions_status", [
  "open",
  "closed",
  "cancelled",
]);
export const bookingsStatus = pgEnum("bookings_status", [
  "reserved",
  "confirmed",
  "cancelled",
  "late_cancelled",
  "no_show",
  "attended",
]);
export const bookingsPaidWith = pgEnum("bookings_paid_with", [
  "credit",
  "order",
  "guest",
  "free",
]);
export const bookingsSource = pgEnum("bookings_source", [
  "portal",
  "admin",
  "waitlist",
  "import",
  "pos",
  "site",
]);

export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    // FK to session_templates is added by booking with that table (Wave 1).
    templateId: uuid(),
    kind: sessionsKind().notNull(),
    title: localized().notNull(),
    startsAt: tstz().notNull(),
    endsAt: tstz().notNull(),
    capacitySeats: integer(),
    capacityBeds: integer(),
    creditKind: sessionsCreditKind(),
    creditCost: smallint().notNull().default(1),
    status: sessionsStatus().notNull().default("open"),
    isMemberOnly: boolean().notNull().default(false),
    isLeadMagnet: boolean().notNull().default(false),
    leadReservedSeats: integer().notNull().default(0),
    leadWindowStartAt: tstz(),
    leadWindowEndAt: tstz(),
    claimWindowMinutes: integer().notNull().default(120),
    // Plain uuid, no FK: `webinars.session_id` is the owning FK (webinar module).
    webinarId: uuid(),
    location: text(),
    notes: text(),
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
    check(
      "sessions_claim_window_ck",
      sql`${t.claimWindowMinutes} between 10 and 2880`,
    ),
    check(
      "sessions_lead_magnet_ck",
      sql`${t.isLeadMagnet} = false or (${t.kind} = 'event' and ${t.leadWindowStartAt} is not null and ${t.leadWindowEndAt} is not null)`,
    ),
  ],
);

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
    orderLineId: uuid().references((): AnyPgColumn => orderLines.id),
    // FK to ticket_types is added by booking with that table (Wave 1).
    ticketTypeId: uuid(),
    bookedByUserId: uuid().references(() => users.id),
    source: bookingsSource().notNull(),
    reservedUntil: tstz(),
    cancelledAt: tstz(),
    cancelReason: text(),
    attendedAt: tstz(),
    version: integer().notNull().default(1),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("bookings_session_person_active_uq")
      .on(t.sessionId, t.personId)
      .where(sql`${t.status} in ('reserved', 'confirmed')`),
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
    check("bookings_guest_not_self_ck", sql`${t.guestOfBookingId} <> ${t.id}`),
    check(
      "bookings_reserved_until_ck",
      sql`${t.status} <> 'reserved' or ${t.reservedUntil} is not null`,
    ),
    check(
      "bookings_attended_at_ck",
      sql`${t.status} <> 'attended' or ${t.attendedAt} is not null`,
    ),
  ],
);
