/**
 * Public seat bands (rule 30): "Available", "Few places left" (fewer than 5 bookable, or below
 * 10 % of capacity) and "Full" (`bookable = 0` or `reason = 'full'`). Booking's
 * `availabilityBand` uses the same thresholds; `availability.test.ts` pins them.
 */
import type { AvailabilityBand } from "./types";

export const FEW_SEATS_THRESHOLD = 5;
export const FEW_SEATS_RATIO = 0.1;

export function bandFor(availability: { bookable: number; capacity: number; reason: string }): AvailabilityBand {
  const { bookable, capacity, reason } = availability;
  if (reason === "full" || bookable <= 0) return "full";
  if (bookable < FEW_SEATS_THRESHOLD) return "few";
  if (capacity > 0 && bookable < capacity * FEW_SEATS_RATIO) return "few";
  return "available";
}
