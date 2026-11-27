/**
 * Owner's review 1, 3 and 8: the prices the public booking flow shows for one session: the single
 * price, the children's prices (child free, youth half) and the packages it offers instead, with
 * the saving per session (10 day sessions at EUR 890 = EUR 89 a session instead of EUR 120). Only
 * packages of the session's credit kind with enough units for it: day packages for day sessions,
 * night packages for nights, never mixed (the same rule `bookSeats` checks).
 */
import type { DbOrTx } from "@beam/db";
import { products, sessions } from "@beam/db/schema";
import { CHILD_PRODUCT_SKUS, childrenAllowed } from "@beam/core/booking";
import type { LocalizedText } from "@beam/core/i18n";
import { and, asc, eq, inArray } from "@/lib/ctx";
import { getProductPrice, listPublicPrices } from "@/modules/commerce/api";
import { getAvailabilityPreview } from "../api/bookings";

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

/** Owner decision: a booking extra the booking form offers, at its public price (the order's quote applies member discounts). */
export type BookingExtraOffer = { productId: string; name: LocalizedText; priceCents: number; kinds: string[] };

/** Owner decision: a day or night session of the next days that the same booking can add. */
export type MoreSessionOffer = { sessionId: string; kind: "day" | "night"; startsAt: Date; endsAt: Date; singleCents: number | null; youthCents: number | null; childrenAllowed: boolean };

/**
 * The add-ons of the public booking form for `sessionId`: the booking extras (active `item`
 * products marked `is_booking_extra`, in sort order) and the other bookable day and night sessions
 * of the next `days` days (the 7-day picker of `/book`), each with its single public price.
 */
export async function getBookingAddOns(db: DbOrTx, sessionId: string, opts: { days?: number; at?: Date } = {}): Promise<{ extras: BookingExtraOffer[]; moreSessions: MoreSessionOffer[] }> {
  const at = opts.at ?? new Date();
  const extraRows = await db
    .select({ id: products.id, name: products.name, kinds: products.bookingExtraKinds })
    .from(products)
    .where(and(eq(products.isBookingExtra, true), eq(products.isActive, true), eq(products.kind, "item")))
    .orderBy(asc(products.sortOrder), asc(products.sku));
  const extras: BookingExtraOffer[] = [];
  for (const r of extraRows) {
    const price = await getProductPrice(db, r.id, "public", at);
    if (price) extras.push({ productId: r.id, name: r.name, priceCents: price.amountCents, kinds: r.kinds });
  }

  const to = new Date(at.getTime() + (opts.days ?? 7) * 86_400_000);
  const slots = [...(await getAvailabilityPreview(db, { kind: "day", from: at, to })), ...(await getAvailabilityPreview(db, { kind: "night", from: at, to }))].filter(
    (s) => s.sessionId !== sessionId && s.band !== "full",
  );
  if (!slots.length) return { extras, moreSessions: [] };
  const rows = await db
    .select({ id: sessions.id, kind: sessions.kind, startsAt: sessions.startsAt, endsAt: sessions.endsAt, productId: sessions.productId })
    .from(sessions)
    .where(inArray(sessions.id, slots.map((s) => s.sessionId)))
    .orderBy(asc(sessions.startsAt));
  const priceOf = new Map<string, number | null>();
  for (const productId of new Set(rows.map((r) => r.productId).filter((x): x is string => !!x))) {
    priceOf.set(productId, (await getProductPrice(db, productId, "public", at))?.amountCents ?? null);
  }
  const prices = await listPublicPrices(db, { at });
  const youthOf = (kind: "day" | "night") => prices.find((p) => p.sku === CHILD_PRODUCT_SKUS[kind].youth && p.isActive)?.publicAmountCents ?? null;
  const moreSessions = rows.map((r): MoreSessionOffer => {
    const kind = r.kind as "day" | "night";
    return {
      sessionId: r.id,
      kind,
      startsAt: r.startsAt,
      endsAt: r.endsAt,
      singleCents: r.productId ? (priceOf.get(r.productId) ?? null) : null,
      youthCents: youthOf(kind),
      childrenAllowed: childrenAllowed(r),
    };
  });
  return { extras, moreSessions };
}
