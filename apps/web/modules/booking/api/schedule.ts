/**
 * booking api, area `schedule` (booking spec 4.9 file layout): `getOpeningHours` and
 * `nextOpeningAt`. Typed stubs by booking-P1 with their final signatures; booking-P2 implements
 * them (pure parts: `openingHoursFor` and `nextOpening` in `@beam/core/booking`).
 */
import type { DbOrTx } from "@beam/db";
import { NotImplementedError } from "@beam/core/errors";
import type { LocalizedText } from "@beam/core/i18n";

const notYet = <T>(fn: string): Promise<T> => Promise.reject(new NotImplementedError(`booking.${fn}`));

/** Site footer and contact page: opening hours per date in `[from, to]` (3.0b). */
export function getOpeningHours(
  _db: DbOrTx,
  _input: { from: string; to: string },
): Promise<Array<{ onDate: string; opensAt: string | null; closesAt: string | null; exceptionName: LocalizedText | null }>> {
  return notYet("getOpeningHours");
}

/** Automation task due dates: the first open instant `>= from`, or null within 30 days (3.0b). */
export function nextOpeningAt(_db: DbOrTx, _from: Date, _opts?: { includePublicHolidays?: boolean }): Promise<Date | null> {
  return notYet("nextOpeningAt");
}
