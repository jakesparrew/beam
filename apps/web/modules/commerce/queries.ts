/**
 * commerce queries (spec section 4.3). commerce-P3: the catalogue and promotion reads of the
 * back-office. Each takes the database first; the admin pages check the permission
 * (`pricing.write`, or `commerce.sell` for read-only product lists) before calling them.
 * Later commerce packages add the order, checkout, POS and attention queries here.
 */
import { orders, personPrices, persons, priceVersions, products, promotionRedemptions, promotions, users } from "@beam/db/schema";
import type { Audience, ProductKind } from "@beam/core/commerce";
import { priceVersionAt } from "@beam/core/commerce";
import { and, asc, desc, eq, gt, inArray, isNull, lte, or, sql, type DbOrTx } from "@/lib/ctx";
import { productCompleteness, toPriceVersionRow, type PersonPriceDbRow, type PriceVersionDbRow, type ProductRow } from "./server/catalogue";
import type { PromotionDbRow } from "./server/promotions";

const AUDIENCES: readonly Audience[] = ["public", "member", "b2b"];

export type ProductListRow = ProductRow & {
  /** The price valid now per audience (rule 5, without the public fallback), or null. */
  current: Record<Audience, number | null>;
};

/** `listProducts(db, {kind?, activeOnly?, shop?, pos?})`, sorted by `sort_order`, then SKU. */
export async function listProducts(
  db: DbOrTx,
  opts: { kind?: ProductKind; activeOnly?: boolean; shop?: boolean; pos?: boolean; at?: Date } = {},
): Promise<ProductListRow[]> {
  const at = opts.at ?? new Date();
  const where = and(
    opts.kind ? eq(products.kind, opts.kind) : undefined,
    opts.activeOnly ? eq(products.isActive, true) : undefined,
    opts.shop ? eq(products.isShopVisible, true) : undefined,
    opts.pos ? eq(products.isPosVisible, true) : undefined,
  );
  const rows = await db.select().from(products).where(where).orderBy(asc(products.sortOrder), asc(products.sku));
  const ids = rows.map((r) => r.id);
  const versions = ids.length ? await db.select().from(priceVersions).where(inArray(priceVersions.productId, ids)) : [];
  const byProduct = new Map<string, ReturnType<typeof toPriceVersionRow>[]>();
  for (const v of versions) byProduct.set(v.productId, [...(byProduct.get(v.productId) ?? []), toPriceVersionRow(v)]);
  return rows.map((r) => {
    const list = byProduct.get(r.id) ?? [];
    const current = Object.fromEntries(AUDIENCES.map((a) => [a, priceVersionAt(list, a, at)?.amountCents ?? null])) as Record<Audience, number | null>;
    return { ...r, current };
  });
}

export type PriceHistoryRow = PriceVersionDbRow & { createdByName: string | null; isCurrent: boolean };

export type ProductDetail = {
  product: ProductRow;
  /** Every version per audience, newest version first. */
  history: Record<Audience, PriceHistoryRow[]>;
  current: Record<Audience, number | null>;
  /** Locales still missing before the product can be active (rule 1). */
  missing: { name: string[]; description: string[] };
};

/** `getProduct(db, id)` with the price history per audience. */
export async function getProduct(db: DbOrTx, id: string, at: Date = new Date()): Promise<ProductDetail | null> {
  const [product] = await db.select().from(products).where(eq(products.id, id));
  if (!product) return null;
  const rows = await db
    .select({ v: priceVersions, createdByName: users.name })
    .from(priceVersions)
    .leftJoin(users, eq(users.id, priceVersions.createdByUserId))
    .where(eq(priceVersions.productId, id))
    .orderBy(asc(priceVersions.audience), desc(priceVersions.version));
  const list = rows.map((r) => toPriceVersionRow(r.v));
  const history = { public: [], member: [], b2b: [] } as Record<Audience, PriceHistoryRow[]>;
  const current = {} as Record<Audience, number | null>;
  for (const a of AUDIENCES) {
    const winner = priceVersionAt(list, a, at);
    current[a] = winner?.amountCents ?? null;
    history[a] = rows.filter((r) => r.v.audience === a).map((r) => ({ ...r.v, createdByName: r.createdByName, isCurrent: r.v.id === winner?.id }));
  }
  return { product, history, current, missing: productCompleteness(product) };
}

export type PersonPriceListRow = PersonPriceDbRow & { personName: string; personEmail: string | null; createdByName: string | null };

/** The person-specific prices of a product, newest first (revoked rows stay as history). */
export async function listPersonPrices(db: DbOrTx, productId: string): Promise<PersonPriceListRow[]> {
  const rows = await db
    .select({ pp: personPrices, firstName: persons.firstName, lastName: persons.lastName, email: persons.email, createdByName: users.name })
    .from(personPrices)
    .innerJoin(persons, eq(persons.id, personPrices.personId))
    .leftJoin(users, eq(users.id, personPrices.createdByUserId))
    .where(eq(personPrices.productId, productId))
    .orderBy(desc(personPrices.validFromAt), desc(personPrices.createdAt));
  return rows.map((r) => ({
    ...r.pp,
    personName: [r.firstName, r.lastName].filter(Boolean).join(" ") || (r.email ?? "—"),
    personEmail: r.email,
    createdByName: r.createdByName,
  }));
}

export type PromotionState = "active" | "scheduled" | "ended";

/** Which tab a promotion belongs to at `at`. */
export function promotionState(p: Pick<PromotionDbRow, "isActive" | "startsAt" | "endsAt">, at: Date = new Date()): PromotionState {
  if (!p.isActive || (p.endsAt && p.endsAt.getTime() <= at.getTime())) return "ended";
  if (p.startsAt.getTime() > at.getTime()) return "scheduled";
  return "active";
}

/** `listPromotions(db, {state})`: the tab's promotions, newest start first. */
export async function listPromotions(db: DbOrTx, opts: { state: PromotionState; at?: Date }): Promise<PromotionDbRow[]> {
  const at = opts.at ?? new Date();
  const notEnded = or(isNull(promotions.endsAt), gt(promotions.endsAt, at));
  const where =
    opts.state === "active"
      ? and(eq(promotions.isActive, true), lte(promotions.startsAt, at), notEnded)
      : opts.state === "scheduled"
        ? and(eq(promotions.isActive, true), gt(promotions.startsAt, at), notEnded)
        : or(eq(promotions.isActive, false), lte(promotions.endsAt, at));
  return db.select().from(promotions).where(where).orderBy(desc(promotions.startsAt), asc(promotions.id));
}

export type RedemptionRow = {
  id: string;
  status: "reserved" | "confirmed" | "released";
  orderId: string;
  orderReference: string;
  discountCents: number;
  personId: string | null;
  personName: string | null;
  createdAt: Date;
};

export type PromotionDetail = {
  promotion: PromotionDbRow;
  counts: { reserved: number; confirmed: number; released: number };
  /** `uses_count` above `max_uses` (late payments re-confirm, rule 19). */
  overrun: number;
  redemptions: RedemptionRow[];
};

/** `getPromotion(db, id)` with redemption counts and the latest 100 redemptions. */
export async function getPromotion(db: DbOrTx, id: string): Promise<PromotionDetail | null> {
  const [promotion] = await db.select().from(promotions).where(eq(promotions.id, id));
  if (!promotion) return null;
  const grouped = await db
    .select({ status: promotionRedemptions.status, n: sql<number>`count(*)::int` })
    .from(promotionRedemptions)
    .where(eq(promotionRedemptions.promotionId, id))
    .groupBy(promotionRedemptions.status);
  const counts = { reserved: 0, confirmed: 0, released: 0 };
  for (const g of grouped) counts[g.status] = Number(g.n);
  const rows = await db
    .select({
      id: promotionRedemptions.id,
      status: promotionRedemptions.status,
      orderId: orders.id,
      orderReference: orders.reference,
      discountCents: orders.discountCents,
      personId: promotionRedemptions.personId,
      firstName: persons.firstName,
      lastName: persons.lastName,
      email: persons.email,
      createdAt: promotionRedemptions.createdAt,
    })
    .from(promotionRedemptions)
    .innerJoin(orders, eq(orders.id, promotionRedemptions.orderId))
    .leftJoin(persons, eq(persons.id, promotionRedemptions.personId))
    .where(eq(promotionRedemptions.promotionId, id))
    .orderBy(desc(promotionRedemptions.createdAt))
    .limit(100);
  return {
    promotion,
    counts,
    overrun: promotion.maxUses != null ? Math.max(0, promotion.usesCount - promotion.maxUses) : 0,
    redemptions: rows.map((r) => ({
      id: r.id,
      status: r.status,
      orderId: r.orderId,
      orderReference: r.orderReference,
      discountCents: r.discountCents,
      personId: r.personId,
      personName: r.personId ? [r.firstName, r.lastName].filter(Boolean).join(" ") || r.email : null,
      createdAt: r.createdAt,
    })),
  };
}

/** Product options for pickers (promotion `applies_to`, person prices): id, SKU, kind, name. */
export async function listProductOptions(db: DbOrTx): Promise<Pick<ProductRow, "id" | "sku" | "kind" | "name" | "isActive">[]> {
  return db
    .select({ id: products.id, sku: products.sku, kind: products.kind, name: products.name, isActive: products.isActive })
    .from(products)
    .orderBy(asc(products.sortOrder), asc(products.sku));
}
