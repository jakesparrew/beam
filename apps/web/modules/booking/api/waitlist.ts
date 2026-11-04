/**
 * booking api, area `waitlist` (booking spec 4.9 file layout): `listOpenOffersForPerson`.
 * Typed stub by booking-P1 with its final signature; booking-P5 implements it.
 */
import type { DbOrTx } from "@beam/db";
import { NotImplementedError } from "@beam/core/errors";
import type { LocalizedText } from "@beam/core/i18n";

/** Site account home: `offered` entries not yet expired (single person id, cross-module D66). */
export function listOpenOffersForPerson(
  _db: DbOrTx,
  _personId: string,
): Promise<Array<{ entryId: string; sessionId: string; title: LocalizedText; startsAt: Date; offerExpiresAt: Date }>> {
  return Promise.reject(new NotImplementedError("booking.listOpenOffersForPerson"));
}
