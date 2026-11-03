/**
 * booking types and settings schemas named in the cross-module contract (02-data-model
 * section 6.3, booking spec 3.0 and 3.0b). Wave 0 skeleton by platform-P7; booking owns this
 * file from booking-P1 on (it may move the schemas to `rules.ts` and re-export them here).
 */
import { z } from "zod";
import type { Locale } from "../i18n/locales";
import type { LocalizedText } from "../i18n/localized-text";

export type { Locale };

export type SessionKind = "day" | "night" | "event";
export type SessionStatus = "open" | "closed" | "cancelled";
export type EventCategory = "lecture" | "concert" | "member_event" | "experience" | "webinar" | "special_activity" | "partner_event";
export type BookingStatus = "reserved" | "confirmed" | "attended" | "cancelled" | "late_cancelled" | "no_show";
export type AvailabilityBand = "available" | "few" | "full";

/** Booking spec 4.8 (cross-module D48); `level` uses booking's own thresholds. */
export type BookingHealth = {
  level: "ok" | "warn" | "alert";
  materialisedThroughOn: string;
  overdueOffers: number;
  overdueReservations: number;
  unsentConfirmations24h: number;
};

/** What a person may do on a session right now (booking rule R-availability). */
export type Availability = {
  free: number;
  band: AvailabilityBand;
  canBook: boolean;
  canJoinWaitlist: boolean;
  reason: "full" | "closed" | "cancelled" | "member_only" | "lead_window" | "past" | "too_late" | null;
};

export type SessionSummary = {
  sessionId: string;
  kind: SessionKind;
  title: LocalizedText;
  startsAt: Date;
  endsAt: Date;
  status: SessionStatus;
  capacity: number;
  free: number;
  band: AvailabilityBand;
  productId: string | null;
  isMemberOnly: boolean;
};

export type SessionCard = {
  sessionId: string;
  kind: SessionKind;
  title: string;
  startsAt: Date;
  endsAt: Date;
  location: string | null;
  url: string;
  band: AvailabilityBand;
};

export type PersonBookingRow = {
  bookingId: string;
  sessionId: string;
  kind: SessionKind;
  title: LocalizedText;
  startsAt: Date;
  status: BookingStatus;
  isGuest: boolean;
  bookedByPersonId: string | null;
  createdAt: Date;
};

// ---------------------------------------------------------------------------
// settings.booking_rules and settings.business_hours (booking spec 3.0, 3.0b)
// ---------------------------------------------------------------------------

const minutes = z.number().int();
const reminderHours = z.array(z.number().int().min(1).max(336));

export const BookingRules = z.object({
  free_cancel_hours: z.object({
    day: z.number().int().min(0),
    night: z.number().int().min(0),
    event: z.number().int().min(0).nullable(),
  }),
  late_cancel_releases_credit: z.boolean(),
  no_show: z.object({ auto_mark: z.boolean(), after_end_minutes: z.number().int().min(0), releases_credit: z.boolean() }),
  book_until_minutes_before_start: z.object({ day: minutes, night: minutes, event: minutes }),
  booking_horizon_days: z.number().int().min(1).max(90),
  max_guests_per_booking: z.number().int().min(0).max(10),
  max_shared_bed_guests_per_booking: z.number().int().min(0).max(1),
  max_reschedules_per_booking: z.number().int().min(0),
  reminder_hours_before: z.object({ day: reminderHours, night: reminderHours, event: reminderHours }),
  waitlist: z.object({
    offer_cutoff_minutes_before_start: minutes,
    min_claim_minutes: minutes,
    max_offers_per_person_per_session: z.number().int().min(1).max(5),
  }),
  check_in: z.object({ opens_minutes_before_start: minutes, closes_minutes_after_end: minutes, revert_no_show_days: minutes }),
  pay_at_desk: z.object({ enabled: z.boolean(), kinds: z.array(z.enum(["day", "night", "event"])) }),
  require_health_declaration: z.boolean(),
  require_emergency_contact_for_nights: z.boolean(),
  guest_abuse: z.object({ distinct_guests_per_30_days: z.number().int().min(1) }),
});
export type BookingRules = z.infer<typeof BookingRules>;

export const DEFAULT_BOOKING_RULES: BookingRules = {
  free_cancel_hours: { day: 24, night: 72, event: null },
  late_cancel_releases_credit: false,
  no_show: { auto_mark: true, after_end_minutes: 120, releases_credit: false },
  book_until_minutes_before_start: { day: 0, night: 120, event: 0 },
  booking_horizon_days: 60,
  max_guests_per_booking: 3,
  max_shared_bed_guests_per_booking: 1,
  max_reschedules_per_booking: 2,
  reminder_hours_before: { day: [24], night: [48], event: [] },
  waitlist: { offer_cutoff_minutes_before_start: 60, min_claim_minutes: 15, max_offers_per_person_per_session: 2 },
  check_in: { opens_minutes_before_start: 120, closes_minutes_after_end: 120, revert_no_show_days: 7 },
  pay_at_desk: { enabled: true, kinds: ["day", "night"] },
  require_health_declaration: false,
  require_emergency_contact_for_nights: true,
  guest_abuse: { distinct_guests_per_30_days: 3 },
};

const hm = z.string().regex(/^\d{2}:\d{2}$/);
/** `null` = closed that weekday. */
export const DayHours = z.object({ opens_at: hm, closes_at: hm }).nullable();
export const BusinessHours = z.object({
  week: z.object({ 1: DayHours, 2: DayHours, 3: DayHours, 4: DayHours, 5: DayHours, 6: DayHours, 7: DayHours }),
  reception_phone: z.string().nullable(),
  note: z.partialRecord(z.enum(["nl-BE", "fr-BE", "en"]), z.string()).nullable(),
});
export type BusinessHours = z.infer<typeof BusinessHours>;

const open = { opens_at: "08:30", closes_at: "19:00" };
/** Monday closed; Tuesday to Sunday 08:30-19:00 (nights are outside business hours by design). */
export const DEFAULT_BUSINESS_HOURS: BusinessHours = {
  week: { 1: null, 2: open, 3: open, 4: open, 5: open, 6: open, 7: open },
  reception_phone: null,
  note: null,
};
