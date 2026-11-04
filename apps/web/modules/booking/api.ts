/**
 * booking's cross-module door (02-data-model section 6.3, booking spec 4.9). Only a barrel: every
 * booking API function lives in exactly one area file of `api/` (gap G14). Other modules import
 * only from `@/modules/booking/api`, never from an area file.
 */
export type {
  Availability,
  AvailabilityBand,
  BookingHealth,
  EventCategory,
  Locale,
  PersonBookingRow,
  SessionCard,
  SessionKind,
  SessionStatus,
  SessionSummary,
} from "@beam/core/booking";

export * from "./api/schedule";
export * from "./api/bookings";
export * from "./api/waitlist";
export * from "./api/webinar";
export * from "./api/partner";
