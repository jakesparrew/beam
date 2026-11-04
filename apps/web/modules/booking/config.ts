/**
 * booking settings and flags (booking spec 3.0, 3.0b and decision 13; 02-data-model 5.4 and 5.5).
 * Facade read by `pnpm gen:indexes`: every `key` is a literal. The schemas and defaults live in
 * `@beam/core/booking` (`rules.ts`); staff edit both settings only through platform's
 * `updateSetting` action at `/admin/sessions/rules`.
 */
import { BookingRules, BusinessHours, DEFAULT_BOOKING_RULES, DEFAULT_BUSINESS_HOURS } from "@beam/core/booking";
import { defineSetting } from "@/lib/settings";

export const settings = [
  defineSetting({
    key: "booking_rules",
    schema: BookingRules,
    default: DEFAULT_BOOKING_RULES,
    description: "Cancellation windows, no-show marking, reminders, waitlist, check-in and pay-at-desk rules",
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
  { key: "ff_booking_ticket_types", description: "Several ticket types per event (R2)" },
] as const;
