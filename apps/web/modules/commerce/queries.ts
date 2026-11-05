/**
 * commerce queries (spec section 4.3). commerce-P3: the catalogue and promotion reads of the
 * back-office. Each takes the database first; the admin pages check the permission
 * (`pricing.write`, or `commerce.sell` for read-only product lists) before calling them.
 * Later commerce packages add the order, checkout, POS and attention queries here.
 * commerce-P5: the customer reads of the shop, checkout, order payment, return and orders pages
 * (`./server/checkouts`), each filtered on the viewer (session person or signed viewer cookie).
 * commerce-P6: the staff order reads (`listOrders`, `getOrder`), the refund and withdrawal
 * previews, the attention feed and the pay page read (`getPayOrderByToken`).
 * commerce-P7: the POS reads (`getPosOrder` for the `?order=` deep link, `getPosPaymentState`)
 * and the day summary (`getPosDaySummary`).
 * commerce-P8 (R2): the resume link read (`findCheckoutByResumeToken`, `resumeContinuePath`).
 * commerce-P9 (R3): the partner options of the promotion form (`listPromotionPartnerOptions`) and
 * the Lightspeed reads (`listLightspeedImports`, `getLightspeedDaily`).
 */
import {
  activityEvents,
  companies,
  orderLines,
  orders,
  payments,
  personPrices,
  persons,
  priceVersions,
  products,
  promotionRedemptions,
  promotions,
  refunds,
  users,
  vouchers,
} from "@beam/db/schema";
import type { InvoiceSummary } from "@beam/core/finance";
import { getInvoiceForOrder } from "@/modules/finance/api";
import { listPartnerCompanies } from "@/modules/crm/api";
import type { Audience, ProductKind } from "@beam/core/commerce";
import { priceVersionAt } from "@beam/core/commerce";
import { messagesFor, TIME_ZONE, type Locale } from "@beam/core/i18n";
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, or, sql, type DbOrTx, type SQL } from "@/lib/ctx";
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

// ---------------------------------------------------------------------------
// Screen helpers for the admin pages (server side)
// ---------------------------------------------------------------------------

/**
 * The flat labels of `commerce.<screen>.*` for client forms, later screens winning on equal keys
 * (for example `["common", "admin_products"]`). Messages with simple `{name}` parameters are
 * passed raw and filled in by the form; plural messages are formatted by the page.
 */
export function commerceLabels(locale: Locale, screens: readonly string[]): Record<string, string> {
  const tree = (messagesFor(locale, ["commerce"]).commerce ?? {}) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const screen of screens) {
    const node = tree[screen];
    if (!node || typeof node !== "object") continue;
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) if (typeof v === "string") out[k] = v;
  }
  return out;
}

/** `YYYY-MM-DDTHH:mm` of `date` in Europe/Brussels, for `datetime-local` inputs. */
export function brusselsInputValue(date: Date | null | undefined): string {
  if (!date) return "";
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

type Tr = (key: string, params?: Record<string, string | number>) => string;
type FormOption = { value: string; label: string };
const opts = (tr: Tr, prefix: string, values: readonly string[]): FormOption[] => values.map((value) => ({ value, label: tr(`commerce.${prefix}.${value}`) }));

/** The select options of the product form, in the staff locale. */
export function productFormOptions(tr: Tr) {
  return {
    kinds: opts(tr, "product_kind", ["session", "night", "package", "membership", "ticket", "item", "voucher"]),
    vatRates: [0, 6, 12, 21].map((r) => ({ value: String(r), label: tr("commerce.admin_products.vat_value", { rate: r }) })),
    creditKinds: opts(tr, "credit_kind", ["day", "night"]),
    intervals: opts(tr, "recurring_interval", ["month", "year"]),
    includedKinds: opts(tr, "credit_kind", ["day", "night"]),
    itemCategories: opts(tr, "item_category", ["merchandise", "wellness_product", "other"]),
    localeNames: { "nl-BE": tr("commerce.common.locale_nl"), "fr-BE": tr("commerce.common.locale_fr"), en: tr("commerce.common.locale_en") },
  };
}

/** The select and checkbox options of the promotion form, in the staff locale. */
export function promotionFormOptions(tr: Tr, locale: Locale, productOptions: Pick<ProductRow, "id" | "sku" | "name">[]) {
  return {
    kinds: opts(tr, "promotion_kind", ["percent", "fixed"]),
    products: productOptions.map((p) => ({ value: p.id, label: `${(p.name as Record<string, string | undefined>)[locale]?.trim() || p.sku} (${p.sku})` })),
    productKinds: opts(tr, "product_kind", ["session", "night", "package", "membership", "ticket", "item", "voucher"]),
    statuses: opts(tr, "person_status", ["lead", "customer", "member"]),
    channels: opts(tr, "channel", ["portal", "site", "admin", "pos", "link"]),
    localeNames: { "nl-BE": tr("commerce.common.locale_nl"), "fr-BE": tr("commerce.common.locale_fr"), en: tr("commerce.common.locale_en") },
  };
}

/**
 * R3: the partner options of the promotion form, from crm's partner companies
 * (`listPartnerCompanies`). `keepId` (the promotion's current partner) stays selectable when that
 * company is no longer a partner, so editing the promotion does not drop it silently.
 */
export async function listPromotionPartnerOptions(db: DbOrTx, keepId?: string | null): Promise<{ value: string; label: string }[]> {
  const partners = await listPartnerCompanies(db);
  const out = partners.map((p) => ({ value: p.id, label: p.name }));
  if (keepId && !out.some((o) => o.value === keepId)) {
    const [kept] = await db.select({ id: companies.id, name: companies.name }).from(companies).where(eq(companies.id, keepId));
    if (kept) out.push({ value: kept.id, label: kept.name });
  }
  return out;
}

/** Product options for pickers (promotion `applies_to`, person prices): id, SKU, kind, name. */
export async function listProductOptions(db: DbOrTx): Promise<Pick<ProductRow, "id" | "sku" | "kind" | "name" | "isActive">[]> {
  return db
    .select({ id: products.id, sku: products.sku, kind: products.kind, name: products.name, isActive: products.isActive })
    .from(products)
    .orderBy(asc(products.sortOrder), asc(products.sku));
}

// ---------------------------------------------------------------------------
// Customer reads (commerce-P5, section 5.2 and 5.3)
// ---------------------------------------------------------------------------

export {
  getCheckout,
  getShopCatalogue,
  getShopProduct,
  listMyOrders,
  getOrderForViewer as getOrderForPayment,
  getOrderForViewer as getMyOrder,
  readViewer,
  orderNeedsTerms,
  SHOP_KINDS,
} from "./server/checkouts";
export type { CheckoutView, CheckoutLineView, CheckoutViewer, CustomerOrderView, MyOrderRow, MyVoucherRow, ShopProduct } from "./server/checkouts";

// ---------------------------------------------------------------------------
// Staff order reads (commerce-P6, section 5.1)
// ---------------------------------------------------------------------------

export type OrderListRow = {
  id: string;
  reference: string;
  createdAt: Date;
  channel: OrderRow["channel"];
  status: OrderRow["status"];
  totalCents: number;
  paidCents: number;
  personId: string | null;
  personName: string | null;
  personEmail: string | null;
  companyName: string | null;
};

type OrderRow = typeof orders.$inferSelect;

export type ListOrdersInput = {
  status?: OrderRow["status"];
  channel?: OrderRow["channel"];
  personId?: string;
  from?: Date;
  to?: Date;
  /** Reference, email or name. */
  q?: string;
  /** `<created_at ISO>_<id>` of the last row of the previous page. */
  cursor?: string;
  limit?: number;
};

/** `listOrders(db, ...)`: keyset on `(created_at, id)` descending, 50 per page; drafts included. */
export async function listOrders(db: DbOrTx, input: ListOrdersInput = {}): Promise<{ rows: OrderListRow[]; nextCursor: string | null }> {
  const limit = Math.max(1, Math.min(200, input.limit ?? 50));
  const conds: SQL[] = [];
  if (input.status) conds.push(eq(orders.status, input.status));
  if (input.channel) conds.push(eq(orders.channel, input.channel));
  if (input.personId) conds.push(eq(orders.personId, input.personId));
  if (input.from) conds.push(gte(orders.createdAt, input.from));
  if (input.to) conds.push(lt(orders.createdAt, input.to));
  const q = input.q?.trim();
  if (q) {
    const like = `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    conds.push(sql`(${orders.reference} ilike ${like} or ${persons.email} ilike ${like} or (coalesce(${persons.firstName}, '') || ' ' || coalesce(${persons.lastName}, '')) ilike ${like})`);
  }
  if (input.cursor) {
    const [at, id] = input.cursor.split("_");
    const when = at ? new Date(at) : null;
    if (when && !Number.isNaN(when.getTime()) && id) conds.push(sql`(${orders.createdAt}, ${orders.id}) < (${when.toISOString()}::timestamptz, ${id}::uuid)`);
  }
  const rows = await db
    .select({
      id: orders.id,
      reference: orders.reference,
      createdAt: orders.createdAt,
      channel: orders.channel,
      status: orders.status,
      totalCents: orders.totalCents,
      personId: orders.personId,
      firstName: persons.firstName,
      lastName: persons.lastName,
      email: persons.email,
      companyName: companies.name,
      paidCents: sql<number>`(select coalesce(sum(p.amount_cents), 0)::int from payments p where p.order_id = ${orders.id} and p.status in ('paid','partially_refunded','refunded'))`,
    })
    .from(orders)
    .leftJoin(persons, eq(persons.id, orders.personId))
    .leftJoin(companies, eq(companies.id, orders.companyId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(orders.createdAt), desc(orders.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit).map((r) => ({
    id: r.id,
    reference: r.reference,
    createdAt: r.createdAt,
    channel: r.channel,
    status: r.status,
    totalCents: r.totalCents,
    paidCents: Number(r.paidCents),
    personId: r.personId,
    personName: r.personId ? [r.firstName, r.lastName].filter(Boolean).join(" ") || r.email : null,
    personEmail: r.email ?? null,
    companyName: r.companyName ?? null,
  }));
  const last = page.at(-1);
  return { rows: page, nextCursor: rows.length > limit && last ? `${last.createdAt.toISOString()}_${last.id}` : null };
}

export type OrderDetail = {
  order: OrderRow;
  person: { id: string; name: string; email: string | null } | null;
  companyName: string | null;
  lines: (typeof orderLines.$inferSelect)[];
  payments: (typeof payments.$inferSelect)[];
  refunds: (typeof refunds.$inferSelect)[];
  vouchers: (typeof vouchers.$inferSelect)[];
  invoice: InvoiceSummary | null;
  events: { id: string; kind: string; occurredAt: Date }[];
  paidCents: number;
  refundedCents: number;
  dueCents: number;
};

/** `getOrder(db, id)` with lines, payments, refunds, vouchers, the invoice and the order's timeline events. */
export async function getOrder(db: DbOrTx, id: string): Promise<OrderDetail | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [order] = await db.select().from(orders).where(eq(orders.id, id));
  if (!order) return null;
  const [person] = order.personId
    ? await db.select({ id: persons.id, firstName: persons.firstName, lastName: persons.lastName, email: persons.email }).from(persons).where(eq(persons.id, order.personId))
    : [];
  const [company] = order.companyId ? await db.select({ name: companies.name }).from(companies).where(eq(companies.id, order.companyId)) : [];
  const lines = await db.select().from(orderLines).where(eq(orderLines.orderId, id)).orderBy(asc(orderLines.lineNo));
  const pays = await db.select().from(payments).where(eq(payments.orderId, id)).orderBy(asc(payments.createdAt));
  const refundRows = await db.select().from(refunds).where(eq(refunds.orderId, id)).orderBy(asc(refunds.createdAt));
  const lineIds = lines.map((l) => l.id);
  const voucherRows = lineIds.length ? await db.select().from(vouchers).where(inArray(vouchers.orderLineId, lineIds)).orderBy(asc(vouchers.createdAt)) : [];
  const events = await db
    .select({ id: activityEvents.id, kind: activityEvents.kind, occurredAt: activityEvents.occurredAt })
    .from(activityEvents)
    .where(and(eq(activityEvents.refType, "order"), eq(activityEvents.refId, id)))
    .orderBy(desc(activityEvents.occurredAt))
    .limit(50);
  const paidCents = pays.filter((p) => ["paid", "partially_refunded", "refunded"].includes(p.status)).reduce((s, p) => s + p.amountCents, 0);
  const refundedCents = pays.reduce((s, p) => s + p.refundedCents, 0);
  return {
    order,
    person: person ? { id: person.id, name: [person.firstName, person.lastName].filter(Boolean).join(" ") || (person.email ?? "—"), email: person.email } : null,
    companyName: company?.name ?? null,
    lines,
    payments: pays,
    refunds: refundRows,
    vouchers: voucherRows,
    invoice: await getInvoiceForOrder(db, id),
    events: events.map((e) => ({ id: String(e.id), kind: e.kind, occurredAt: e.occurredAt })),
    paidCents,
    refundedCents,
    dueCents: Math.max(0, order.totalCents - paidCents),
  };
}

export { getRefundPreview, quickRefundLines } from "./server/refunds";
export { getWithdrawalPreview, withdrawalBlocker } from "./server/withdrawals";

/** The withdrawal plan of an order by id (the customer's order page), or null without a right. */
export async function getWithdrawalPreviewFor(db: DbOrTx, orderId: string) {
  const [row] = await db.select().from(orders).where(eq(orders.id, orderId));
  if (!row) return null;
  const { getWithdrawalPreview } = await import("./server/withdrawals");
  return getWithdrawalPreview(db, row);
}
export { getAttentionFeed, groupAttention, listPaymentAttention, ATTENTION_KINDS, type AttentionKind, type AttentionRow } from "./server/attention";
export { getPayOrderByToken, type PayPageView } from "./server/payment-links";

export { getPosOrder, getPosPaymentState, ANONYMOUS_KINDS, type PosOrderView } from "./server/pos";
export { getPosDaySummary, businessDayOf, isPosDayClosed, POS_DIFFERENCE_TASK_CENTS, type PosDaySummary, type PosDayTotals } from "./server/pos-day";
export { findCheckoutByResumeToken, resumeContinuePath, type ResumeTarget } from "./server/recovery";
export { getLightspeedDaily, listLightspeedImports, LIGHTSPEED_MAX_BYTES } from "./server/lightspeed";
