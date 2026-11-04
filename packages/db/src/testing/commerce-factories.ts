/**
 * commerce test factories (fix-w05-schema-1). Each takes `(db, overrides?)`, fills every required
 * column with a value that satisfies the commerce checks and returns the inserted row:
 *
 * - `orders_terms_chk`: a non-draft `portal`, `site` or `link` order carries the accepted terms
 *   version. `ensureTermsVersion` creates the legal `terms` page with a published version once per
 *   database (through site's schema) and reuses it afterwards; `admin` and `pos` orders need none.
 * - `orders_person_chk`: a person is created unless the order names a person or a company, is a
 *   `pos` order or an erased subject.
 * - `order_lines_session_chk`: a `session`, `night` or `ticket` line gets a session and quantity 1.
 * - `order_lines_total_chk`: `line_total_cents = unit_amount_cents * quantity - discount_cents`.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import type { DbOrTx } from "../client";
import { orderLines, orders, products, type productsKind } from "../schema/commerce";
import { pages, pageVersions } from "../schema/site";
import { makePerson, makeProduct, makeSession } from "./factories";

export type OrderRow = typeof orders.$inferSelect;
export type OrderInsert = typeof orders.$inferInsert;
export type OrderLineRow = typeof orderLines.$inferSelect;
export type OrderLineInsert = typeof orderLines.$inferInsert;
export type PageVersionRow = typeof pageVersions.$inferSelect;
type ProductKind = (typeof productsKind.enumValues)[number];

/** The channels whose non-draft orders need `terms_version_id` (`orders_terms_chk`). */
export const TERMS_CHANNELS: readonly OrderInsert["channel"][] = ["portal", "site", "link"];
/** The product kinds whose lines need a session and quantity 1 (`order_lines_session_chk`). */
export const SESSION_LINE_KINDS: readonly ProductKind[] = ["session", "night", "ticket"];

/**
 * The published version of the legal `terms` page: the page's current version, else its latest
 * version. Creates the page (`kind = legal`, `legal_key = terms`) and a published version 1 when
 * no live terms page exists, so every call on one database returns the same row.
 */
export async function ensureTermsVersion(db: DbOrTx): Promise<PageVersionRow> {
  const [page] = await db
    .select()
    .from(pages)
    .where(and(eq(pages.legalKey, "terms"), ne(pages.status, "archived")))
    .limit(1);
  if (page) {
    const [current] = page.currentVersionId
      ? await db.select().from(pageVersions).where(eq(pageVersions.id, page.currentVersionId))
      : await db
          .select()
          .from(pageVersions)
          .where(eq(pageVersions.pageId, page.id))
          .orderBy(desc(pageVersions.version))
          .limit(1);
    if (current) return current;
    return publishVersion(db, page.id, 1);
  }
  const taken = await db.select({ id: pages.id }).from(pages).where(eq(pages.slug, "terms"));
  const [created] = await db
    .insert(pages)
    .values({
      kind: "legal",
      legalKey: "terms",
      slug: taken.length ? `terms-${randomUUID().slice(0, 8)}` : "terms",
    })
    .returning();
  return publishVersion(db, created!.id, 1);
}

async function publishVersion(db: DbOrTx, pageId: string, version: number): Promise<PageVersionRow> {
  const [row] = await db
    .insert(pageVersions)
    .values({
      pageId,
      version,
      state: "published",
      publishedAt: new Date(),
      title: { "nl-BE": "Algemene voorwaarden", "fr-BE": "Conditions générales", en: "Terms and conditions" },
    })
    .returning();
  await db
    .update(pages)
    .set({ status: "published", currentVersionId: row!.id, firstPublishedAt: sql`coalesce(${pages.firstPublishedAt}, now())` })
    .where(eq(pages.id, pageId));
  return row!;
}

/**
 * An order (default: an `admin` order of a new person, `pending_payment`, € 45.00 incl. € 7.81
 * VAT, `nl-BE`). A `paid` order gets `paid_at = now()` unless given. A non-draft `portal`, `site`
 * or `link` order without `termsVersionId` gets `ensureTermsVersion(db)`.
 */
export async function makeOrder(db: DbOrTx, overrides: Partial<OrderInsert> = {}): Promise<OrderRow> {
  const channel = overrides.channel ?? "admin";
  const status = overrides.status ?? "pending_payment";
  const needsPerson =
    overrides.personId === undefined &&
    !overrides.companyId &&
    channel !== "pos" &&
    !overrides.isErasedSubject;
  const needsTerms =
    overrides.termsVersionId === undefined && TERMS_CHANNELS.includes(channel) && status !== "draft";
  const subtotal = overrides.subtotalCents ?? overrides.totalCents ?? 4_500;
  const discount = overrides.discountCents ?? 0;
  const [row] = await db
    .insert(orders)
    .values({
      channel,
      status,
      subtotalCents: subtotal,
      discountCents: discount,
      vatCents: Math.round(((subtotal - discount) * 21) / 121),
      totalCents: subtotal - discount,
      locale: "nl-BE",
      clientKey: randomUUID(),
      ...(needsPerson ? { personId: (await makePerson(db)).id } : {}),
      ...(needsTerms ? { termsVersionId: (await ensureTermsVersion(db)).id } : {}),
      ...(status === "paid" ? { paidAt: new Date() } : {}),
      ...overrides,
    })
    .returning();
  return row!;
}

/** Line overrides without the order; `orderId` is optional in `makeOrderLine`. */
export type LineOverrides = Partial<OrderLineInsert>;

/**
 * An order line (default: one `item` of a new product at € 45.00, 21 % VAT). A missing order is
 * created with `makeOrder`, a missing product with `makeProduct` of `productKind`; `sku` and
 * `description` come from the product, `line_no` is the next free number of the order and
 * `line_total_cents` follows the amounts. A `session`, `night` or `ticket` line without
 * `sessionId` gets a new session (a night for `night`, an event for `ticket`, else a day).
 */
export async function makeOrderLine(db: DbOrTx, overrides: LineOverrides = {}): Promise<OrderLineRow> {
  const orderId = overrides.orderId ?? (await makeOrder(db)).id;
  const values = await lineValues(db, orderId, overrides);
  const [row] = await db.insert(orderLines).values(values).returning();
  return row!;
}

async function lineValues(db: DbOrTx, orderId: string, overrides: LineOverrides): Promise<OrderLineInsert> {
  const product = overrides.productId
    ? (await db.select().from(products).where(eq(products.id, overrides.productId)))[0]!
    : await makeProduct(db, { kind: overrides.productKind ?? "item" });
  const kind = overrides.productKind ?? product.kind;
  const quantity = overrides.quantity ?? 1;
  const unit = overrides.unitAmountCents ?? 4_500;
  const discount = overrides.discountCents ?? 0;
  const total = unit * quantity - discount;
  const lineNo =
    overrides.lineNo ??
    Number(
      (
        await db
          .select({ next: sql<number>`coalesce(max(${orderLines.lineNo}), 0) + 1` })
          .from(orderLines)
          .where(eq(orderLines.orderId, orderId))
      )[0]!.next,
    );
  const needsSession = SESSION_LINE_KINDS.includes(kind) && overrides.sessionId === undefined;
  return {
    orderId,
    lineNo,
    productId: product.id,
    productKind: kind,
    sku: product.sku,
    description: product.name,
    quantity,
    unitAmountCents: unit,
    discountCents: discount,
    lineTotalCents: total,
    vatRatePct: "21.00",
    vatCents: Math.round((total * 21) / 121),
    pricingTrace: {},
    ...(needsSession
      ? {
          sessionId: (
            await makeSession(db, { kind: kind === "night" ? "night" : kind === "ticket" ? "event" : "day" })
          ).id,
        }
      : {}),
    ...overrides,
  };
}

/**
 * A paid order of `personId` with `lines` (default: one `item` line), its subtotal and total the
 * sum of the line totals. The order is a `portal` order with the terms version unless `order`
 * says otherwise; `order` overrides any order column (`paidAt`, `status`, `channel`, ...).
 */
export async function makePaidOrder(
  db: DbOrTx,
  input: { personId: string; lines?: Omit<LineOverrides, "orderId">[]; order?: Partial<OrderInsert> },
): Promise<{ order: OrderRow; lines: OrderLineRow[] }> {
  const specs = input.lines ?? [{}];
  const totals = specs.map(
    (l) => (l.lineTotalCents ?? (l.unitAmountCents ?? 4_500) * (l.quantity ?? 1) - (l.discountCents ?? 0)),
  );
  const sum = totals.reduce((a, b) => a + b, 0);
  const order = await makeOrder(db, {
    personId: input.personId,
    channel: "portal",
    status: "paid",
    subtotalCents: sum,
    totalCents: sum,
    vatCents: Math.round((sum * 21) / 121),
    ...input.order,
  });
  const lines: OrderLineRow[] = [];
  for (const [i, spec] of specs.entries()) {
    lines.push(await makeOrderLine(db, { lineNo: i + 1, ...spec, orderId: order.id }));
  }
  return { order, lines };
}
