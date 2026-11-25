/**
 * Owner's review 1, 3 and 8: the prices the public booking flow shows for one session: the single
 * price, the children's prices (child free, youth half) and the packages it offers instead, with
 * the saving per session (10 day sessions at EUR 890 = EUR 89 a session instead of EUR 120). Only
 * packages of the session's credit kind with enough units for it: day packages for day sessions,
 * night packages for nights, never mixed (the same rule `bookSeats` checks).
 */
import type { DbOrTx } from "@beam/db";
import { sessions } from "@beam/db/schema";
import { CHILD_PRODUCT_SKUS } from "@beam/core/booking";
import type { LocalizedText } from "@beam/core/i18n";
import { eq } from "@/lib/ctx";
import { getProductPrice, listPublicPrices } from "@/modules/commerce/api";

export type PackageOffer = {
  productId: string;
  sku: string;
  name: LocalizedText;
  /** Sessions of this kind the package pays for. */
  units: number;
  priceCents: number;
  perSessionCents: number;
  /** Whole percent saved per session against the single price; null when it is not cheaper. */
  savingPct: number | null;
};

export type BookingOffers = {
  singleCents: number | null;
  /** The child (under 12) and youth (12 to 17) prices of the session kind; null when not sold. */
  childCents: { child: number | null; youth: number | null };
  offers: PackageOffer[];
};

/** The single public price of a session, its children's prices and the packages that can pay for it, smallest first. */
export async function getBookingOffers(db: DbOrTx, sessionId: string, at: Date = new Date()): Promise<BookingOffers> {
  const none: BookingOffers = { singleCents: null, childCents: { child: null, youth: null }, offers: [] };
  const [s] = await db
    .select({ kind: sessions.kind, productId: sessions.productId, creditKind: sessions.creditKind, creditCost: sessions.creditCost })
    .from(sessions)
    .where(eq(sessions.id, sessionId));
  if (!s) return none;
  const singleCents = s.productId ? ((await getProductPrice(db, s.productId, "public", at))?.amountCents ?? null) : null;
  const prices = await listPublicPrices(db, { at });
  const skus = s.kind === "day" || s.kind === "night" ? CHILD_PRODUCT_SKUS[s.kind] : null;
  const priceOf = (sku: string | undefined) => prices.find((p) => p.sku === sku && p.isActive)?.publicAmountCents ?? null;
  const childCents = { child: priceOf(skus?.child), youth: priceOf(skus?.youth) };
  if (!s.creditKind || s.creditCost <= 0) return { singleCents, childCents, offers: [] };
  const offers = prices
    .filter((p) => p.isActive && p.kind === "package" && p.creditKind === s.creditKind && (p.creditUnits ?? 0) >= s.creditCost)
    .map((p): PackageOffer => {
      const units = Math.floor(p.creditUnits! / s.creditCost);
      const perSessionCents = Math.round(p.publicAmountCents / units);
      const savingPct = singleCents && perSessionCents < singleCents ? Math.round((1 - perSessionCents / singleCents) * 100) : null;
      return { productId: p.productId, sku: p.sku, name: p.name, units, priceCents: p.publicAmountCents, perSessionCents, savingPct };
    })
    .sort((a, b) => a.units - b.units || a.priceCents - b.priceCents);
  return { singleCents, childCents, offers };
}
