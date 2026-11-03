/**
 * booking settings and flags (02-data-model 5.4 and 5.5, booking spec 3.0 and 3.0b). Facade read
 * by `pnpm gen:indexes`: every `key` is a literal. Wave 0 by platform-P7; booking owns it from
 * booking-P1 on.
 */
import { BookingRules, BusinessHours, DEFAULT_BOOKING_RULES, DEFAULT_BUSINESS_HOURS } from "@beam/core/booking";
import { defineSetting } from "@/lib/settings";

export const settings = [
  defineSetting({
    key: "booking_rules",
    schema: BookingRules,
    default: DEFAULT_BOOKING_RULES,
    description: "Cancellation windows, no-show marking, reminders, waitlist and check-in rules",
  }),
  defineSetting({
    key: "business_hours",
    schema: BusinessHours,
    default: DEFAULT_BUSINESS_HOURS,
    description: "Public opening hours per weekday (special hours are session exceptions)",
  }),
] as const;

export const flags = [
  { key: "ff_booking_lead_priority", description: "Lead Magnet access windows on events (R2)" },
  { key: "ff_booking_ticket_types", description: "Ticket types on events (R2)" },
] as const;
