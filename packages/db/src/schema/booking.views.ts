/**
 * booking views (booking spec section 2 "Views", data model 2.3). Each view is
 * `pgView(name, columns).existing()` with its SQL beside it as `<name>Sql`; `pnpm db:views`
 * writes the migration and `createTestDb()` applies the same SQL. "Now" is `now()`.
 */
import { boolean, date, integer, jsonb, numeric, pgView, smallint, text, time, timestamp, uuid } from "drizzle-orm/pg-core";
import type { LocalizedText } from "./_shared";
import {
  bookingsCancelReasonCode,
  bookingsPaidWith,
  bookingsSource,
  bookingsStatus,
  sessionsKind,
  sessionsStatus,
} from "./booking";

const tz = (name: string) => timestamp(name, { withTimezone: true });

const CAPACITY = "coalesce(s.capacity_beds, s.capacity_seats)";
const AVAILABLE_TOTAL = `greatest(0, ${CAPACITY} - coalesce(h.held, 0) - coalesce(b.booked, 0) - coalesce(o.live_offers, 0))`;
const LEAD_RESERVED_REMAINING = `case when s.is_lead_magnet and (now() < s.lead_window_end_at or s.lead_release_rule = 'keep_for_leads')
       then greatest(0, s.lead_reserved_seats - coalesce(b.lead_booked, 0) - coalesce(o.live_lead_offers, 0)) else 0 end`;
const OPENS_FOR_PUBLIC = "coalesce(s.public_release_at, s.lead_window_end_at + make_interval(mins => s.claim_window_minutes))";

/** One row per session: capacity pools, Lead Magnet phase and waiting count (R8, R9, R20-R25). */
export const vSessionAvailabilitySql = `select s.id as session_id, s.kind, s.starts_at, s.ends_at, s.status, s.is_lead_magnet, s.published_at,
  ${CAPACITY} as capacity,
  coalesce(h.held, 0)::int as held,
  coalesce(b.booked, 0)::int as booked,
  coalesce(b.lead_booked, 0)::int as lead_booked,
  coalesce(o.live_offers, 0)::int as live_offers,
  coalesce(o.live_lead_offers, 0)::int as live_lead_offers,
  ${AVAILABLE_TOTAL}::int as available_total,
  (${LEAD_RESERVED_REMAINING})::int as lead_reserved_remaining,
  case when not s.is_lead_magnet then 'none'
       when now() < s.lead_window_start_at then 'pre'
       when now() < s.lead_window_end_at then 'lead'
       when s.lead_release_rule = 'customers_then_public' and now() < ${OPENS_FOR_PUBLIC} then 'customer_release'
       else 'public' end as lead_phase,
  greatest(0, ${AVAILABLE_TOTAL} - (${LEAD_RESERVED_REMAINING}))::int as available_general,
  case when s.is_lead_magnet then s.lead_window_end_at end as opens_for_customers_at,
  case when s.is_lead_magnet then ${OPENS_FOR_PUBLIC} end as opens_for_public_at,
  coalesce(w.waiting, 0)::int as waiting
from sessions s
left join (select session_id, sum(quantity) as held from capacity_holds group by 1) h on h.session_id = s.id
left join (select session_id, sum(capacity_units) as booked, sum(capacity_units) filter (where used_lead_seat) as lead_booked
           from bookings where capacity_hold_id is null
             and (status in ('confirmed', 'attended', 'no_show') or (status = 'reserved' and reserved_until > now()))
           group by 1) b on b.session_id = s.id
left join (select session_id, count(*) as live_offers, count(*) filter (where queue = 'lead') as live_lead_offers
           from waitlist_entries where state = 'offered' and offer_expires_at > now() and booking_id is null group by 1) o on o.session_id = s.id
left join (select session_id, count(*) as waiting from waitlist_entries where state = 'waiting' group by 1) w on w.session_id = s.id`;

export const vSessionAvailability = pgView("v_session_availability", {
  sessionId: uuid("session_id").notNull(),
  kind: sessionsKind("kind").notNull(),
  startsAt: tz("starts_at").notNull(),
  endsAt: tz("ends_at").notNull(),
  status: sessionsStatus("status").notNull(),
  isLeadMagnet: boolean("is_lead_magnet").notNull(),
  publishedAt: tz("published_at"),
  capacity: integer("capacity").notNull(),
  held: integer("held").notNull(),
  booked: integer("booked").notNull(),
  leadBooked: integer("lead_booked").notNull(),
  liveOffers: integer("live_offers").notNull(),
  liveLeadOffers: integer("live_lead_offers").notNull(),
  availableTotal: integer("available_total").notNull(),
  leadReservedRemaining: integer("lead_reserved_remaining").notNull(),
  leadPhase: text("lead_phase").$type<"none" | "pre" | "lead" | "customer_release" | "public">().notNull(),
  availableGeneral: integer("available_general").notNull(),
  opensForCustomersAt: tz("opens_for_customers_at"),
  opensForPublicAt: tz("opens_for_public_at"),
  waiting: integer("waiting").notNull(),
}).existing();

/** Every booking with its session; portal queries filter `person_id = $me or owner_person_id = $me`. */
export const vPersonBookingsSql = `select b.*, s.kind, s.title, s.starts_at, s.ends_at, s.location, s.status as session_status,
  (b.guest_of_booking_id is not null) as is_guest, coalesce(owner.person_id, b.person_id) as owner_person_id
from bookings b
join sessions s on s.id = b.session_id
left join bookings owner on owner.id = b.guest_of_booking_id`;

export const vPersonBookings = pgView("v_person_bookings", {
  id: uuid("id").notNull(),
  sessionId: uuid("session_id").notNull(),
  personId: uuid("person_id").notNull(),
  status: bookingsStatus("status").notNull(),
  paidWith: bookingsPaidWith("paid_with").notNull(),
  guestOfBookingId: uuid("guest_of_booking_id"),
  capacityUnits: smallint("capacity_units").notNull(),
  orderLineId: uuid("order_line_id"),
  ticketTypeId: uuid("ticket_type_id"),
  capacityHoldId: uuid("capacity_hold_id"),
  usedLeadSeat: boolean("used_lead_seat").notNull(),
  isOverCapacity: boolean("is_over_capacity").notNull(),
  isPayAtDesk: boolean("is_pay_at_desk").notNull(),
  bookedByUserId: uuid("booked_by_user_id"),
  bookedByPersonId: uuid("booked_by_person_id"),
  source: bookingsSource("source").notNull(),
  externalRef: text("external_ref"),
  reservedUntil: tz("reserved_until"),
  rescheduledFromBookingId: uuid("rescheduled_from_booking_id"),
  checkinCode: text("checkin_code").notNull(),
  qrFileId: uuid("qr_file_id"),
  reminderSentAt: tz("reminder_sent_at"),
  cancelledAt: tz("cancelled_at"),
  cancelReasonCode: bookingsCancelReasonCode("cancel_reason_code"),
  cancelReason: text("cancel_reason"),
  attendedAt: tz("attended_at"),
  noShowMarkedAt: tz("no_show_marked_at"),
  notes: text("notes"),
  version: integer("version").notNull(),
  createdAt: tz("created_at").notNull(),
  updatedAt: tz("updated_at").notNull(),
  kind: sessionsKind("kind").notNull(),
  title: jsonb("title").$type<LocalizedText>().notNull(),
  startsAt: tz("starts_at").notNull(),
  endsAt: tz("ends_at").notNull(),
  location: text("location"),
  sessionStatus: sessionsStatus("session_status").notNull(),
  isGuest: boolean("is_guest").notNull(),
  ownerPersonId: uuid("owner_person_id").notNull(),
}).existing();

/** Capacity utilisation per session (V1 basic reporting; ops' capacity report reads it). */
export const vSessionUtilisationSql = `select s.id as session_id, s.template_id, s.kind,
  (s.starts_at at time zone 'Europe/Brussels')::date as day_on,
  extract(isodow from (s.starts_at at time zone 'Europe/Brussels'))::int as weekday,
  (s.starts_at at time zone 'Europe/Brussels')::time as local_start_time,
  ${CAPACITY} as capacity,
  coalesce(h.held, 0)::int as held,
  coalesce(b.booked_total, 0)::int as booked_total,
  coalesce(b.attended, 0)::int as attended,
  coalesce(b.no_shows, 0)::int as no_shows,
  coalesce(b.cancellations, 0)::int as cancellations,
  coalesce(b.late_cancellations, 0)::int as late_cancellations,
  coalesce(w.waitlist_peak, 0)::int as waitlist_peak,
  case when s.ends_at <= now()
       then round(100.0 * coalesce(b.used_units, 0) / nullif(${CAPACITY}, 0), 1)
       else round(100.0 * coalesce(b.booked_total, 0) / nullif(${CAPACITY}, 0), 1) end as utilisation_pct
from sessions s
left join (select session_id, sum(quantity) as held from capacity_holds group by 1) h on h.session_id = s.id
left join (select session_id,
             sum(capacity_units) filter (where status not in ('cancelled', 'late_cancelled')) as booked_total,
             sum(capacity_units) filter (where status in ('attended', 'no_show')) as used_units,
             count(*) filter (where status = 'attended') as attended,
             count(*) filter (where status = 'no_show') as no_shows,
             count(*) filter (where status = 'cancelled') as cancellations,
             count(*) filter (where status = 'late_cancelled') as late_cancellations
           from bookings group by 1) b on b.session_id = s.id
left join (select session_id, count(*) as waitlist_peak from waitlist_entries group by 1) w on w.session_id = s.id`;

export const vSessionUtilisation = pgView("v_session_utilisation", {
  sessionId: uuid("session_id").notNull(),
  templateId: uuid("template_id"),
  kind: sessionsKind("kind").notNull(),
  dayOn: date("day_on").notNull(),
  weekday: integer("weekday").notNull(),
  localStartTime: time("local_start_time").notNull(),
  capacity: integer("capacity").notNull(),
  held: integer("held").notNull(),
  bookedTotal: integer("booked_total").notNull(),
  attended: integer("attended").notNull(),
  noShows: integer("no_shows").notNull(),
  cancellations: integer("cancellations").notNull(),
  lateCancellations: integer("late_cancellations").notNull(),
  waitlistPeak: integer("waitlist_peak").notNull(),
  utilisationPct: numeric("utilisation_pct", { mode: "number" }),
}).existing();
