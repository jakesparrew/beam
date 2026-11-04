/**
 * The customer-facing label of an availability (booking spec 4.1, 5.2, decision 32): a catalogue
 * key under `booking.availability.*` plus its parameters. Exact places only when 5 or fewer.
 */
import { formatDateTime } from "../i18n/format";
import type { Locale } from "../i18n/locales";
import { FEW_PLACES_THRESHOLD, type Availability } from "./types";

export function describeAvailability(a: Availability, locale: Locale): { labelKey: string; params: Record<string, string> } {
  switch (a.reason) {
    case "ok":
      return a.bookable <= FEW_PLACES_THRESHOLD
        ? { labelKey: "booking.availability.placesLeft", params: { count: String(a.bookable) } }
        : { labelKey: "booking.availability.available", params: {} };
    case "not_open_yet":
      return a.opensAt
        ? { labelKey: "booking.availability.openForYouOn", params: { date: formatDateTime(a.opensAt, locale, "full") } }
        : { labelKey: "booking.availability.notOpenYet", params: {} };
    case "full":
      return { labelKey: "booking.availability.full", params: {} };
    case "member_only":
      return { labelKey: "booking.availability.memberOnly", params: {} };
    case "closed":
      return { labelKey: "booking.availability.closed", params: {} };
    case "cancelled":
      return { labelKey: "booking.availability.cancelled", params: {} };
    case "past":
      return { labelKey: "booking.availability.past", params: {} };
    case "webinar":
      return { labelKey: "booking.availability.webinar", params: {} };
  }
}
