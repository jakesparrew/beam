/**
 * booking api, area `waitlist` (booking spec 4.9 file layout): `listOpenOffersForPerson`
 * (booking-P5), read by site's account home.
 */
import type { DbOrTx } from "@beam/db";
import type { LocalizedText } from "@beam/core/i18n";
import { openOffersOf } from "../server/claim";

/** Site account home: `offered` entries not yet expired and not claimed (single person id, cross-module D66). */
export async function listOpenOffersForPerson(
  db: DbOrTx,
  personId: string,
): Promise<Array<{ entryId: string; sessionId: string; title: LocalizedText; startsAt: Date; offerExpiresAt: Date }>> {
  const rows = await openOffersOf(db, personId);
  return rows.map((r) => ({ ...r, offerExpiresAt: r.offerExpiresAt! }));
}
