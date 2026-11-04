/**
 * `settings.booking_rules` and `settings.business_hours` (booking spec 3.0 and 3.0b). Every
 * field is snake_case (cross-module D16). Each field carries its default, so `parse({})`
 * returns the defaults; `DEFAULT_BOOKING_RULES` and `DEFAULT_BUSINESS_HOURS` are those values.
 */
import { z } from "zod";

const int = () => z.number().int();
const reminderHours = (def: number[]) => z.array(int().min(1).max(336)).default(def);

export const BookingRules = z.object({
  /** Hours before start until which a customer cancels free; `event: null` = never free. */
  free_cancel_hours: z
    .object({
      day: int().min(0).default(24),
      night: int().min(0).default(72),
      event: int().min(0).nullable().default(null),
    })
    .prefault({}),
  late_cancel_releases_credit: z.boolean().default(false),
  no_show: z
    .object({
      auto_mark: z.boolean().default(true),
      after_end_minutes: int().min(0).default(120),
      releases_credit: z.boolean().default(false),
    })
    .prefault({}),
  book_until_minutes_before_start: z
    .object({ day: int().default(0), night: int().default(120), event: int().default(0) })
    .prefault({}),
  /** How far ahead customers may book. */
  booking_horizon_days: int().min(1).max(90).default(60),
  max_guests_per_booking: int().min(0).max(10).default(3),
  /** A night bed is for at most two people. */
  max_shared_bed_guests_per_booking: int().min(0).max(1).default(1),
  max_reschedules_per_booking: int().min(0).default(2),
  /** Events: automation's `event-registration` sequence sends the reminders. */
  reminder_hours_before: z
    .object({ day: reminderHours([24]), night: reminderHours([48]), event: reminderHours([]) })
    .prefault({}),
  waitlist: z
    .object({
      offer_cutoff_minutes_before_start: int().default(60),
      min_claim_minutes: int().default(15),
      max_offers_per_person_per_session: int().min(1).max(5).default(2),
    })
    .prefault({}),
  check_in: z
    .object({
      opens_minutes_before_start: int().default(120),
      closes_minutes_after_end: int().default(120),
      revert_no_show_days: int().default(7),
    })
    .prefault({}),
  pay_at_desk: z
    .object({
      enabled: z.boolean().default(true),
      kinds: z.array(z.enum(["day", "night", "event"])).default(["day", "night"]),
    })
    .prefault({}),
  /** R62b; the field forms names `settings.booking_rules.require_health_declaration`. */
  require_health_declaration: z.boolean().default(false),
  /** R62b; crm `persons.emergency_contact`. */
  require_emergency_contact_for_nights: z.boolean().default(true),
  /** Read by credits' `v_sharing_review` (credits rule 43). */
  guest_abuse: z.object({ distinct_guests_per_30_days: int().min(1).default(3) }).prefault({}),
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
/** Opening hours of one weekday; `null` = closed. */
export const DayHours = z.object({ opens_at: hm, closes_at: hm }).nullable();
export type DayHours = z.infer<typeof DayHours>;

/** ISO weekday 1 = Monday ... 7 = Sunday. */
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
