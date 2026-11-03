/**
 * booking's cross-module door. Forward stub written by platform-P5 (runbook DR-10): platform's
 * `/api/health` and `platform.check_alerts` call `getBookingHealth`. platform-P7 rewrites this
 * file with the full stub set and keeps this export unchanged; booking-P3b implements it.
 */
import type { DbOrTx } from "@beam/db";
import { NotImplementedError } from "@beam/core/errors";

/** Booking spec 4.8 (cross-module D48); `level` uses booking's own thresholds. */
export type BookingHealth = {
  level: "ok" | "warn" | "alert";
  materialisedThroughOn: string;
  overdueOffers: number;
  overdueReservations: number;
  unsentConfirmations24h: number;
};

export function getBookingHealth(db: DbOrTx): Promise<BookingHealth> {
  void db;
  return Promise.reject(new NotImplementedError("booking.getBookingHealth"));
}
