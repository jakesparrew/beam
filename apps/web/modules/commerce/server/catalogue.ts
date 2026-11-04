/**
 * The catalogue (commerce spec rules 1 to 6, commerce-P3): products, append-only price versions
 * and person prices, plus the read functions other modules call through `api.ts`
 * (`getProductPrice`, `listPublicPrices`, `getProductCards`) and `getQuote`, which loads
 * everything the pure `quote()` needs and calls it.
 *
 * Writes take the action's `Ctx` (staff only) and audit themselves with the spec's audit names
 * (`product.created`, `price.version_added`, ...), so the actions turn the wrapper's row off.
 */
import { z } from "zod";
import { products, personPrices, priceVersions } from "@beam/db/schema";
import {
  ITEM_CATEGORIES,
  PRODUCT_KINDS,
  quote,
  type Audience,
  type CartItem,
  type CreditKind,
  type OrderChannel,
  type PersonPriceRow,
  type PriceVersionRow,
  type ProductCard,
  type ProductKind,
  type Quote,
  type QuoteInput,
  type QuoteProduct,
  type QuoteWarning,
  priceVersionAt,
} from "@beam/core/commerce";
import { LocalizedTextSchema, missingLocales, pick, URL_SEGMENT, type Locale, type LocalizedText } from "@beam/core/i18n";
import { appUrl } from "@/lib/auth";
import { and, asc, eq, inArray, isNull, sql, NotFoundError, ValidationError, type Ctx, type DbOrTx } from "@/lib/ctx";
import { signFileUrl } from "@/lib/files";
import { getPersonStatus } from "@/modules/crm/api";
import { canStartMembership, getMembershipForPerson } from "@/modules/credits/api";
import { loadEligiblePromotions } from "./promotions";

export type ProductRow = typeof products.$inferSelect;
export type PriceVersionDbRow = typeof priceVersions.$inferSelect;
export type PersonPriceDbRow = typeof personPrices.$inferSelect;

const ALL_LOCALES: readonly Locale[] = ["nl-BE", "fr-BE", "en"];

// ---------------------------------------------------------------------------
// Input schemas (shared by the actions and the forms)
// ---------------------------------------------------------------------------

const optionalPositive = z.number().int().positive().nullable().optional();
const vatRate = z.union([z.literal(0), z.literal(6), z.literal(12), z.literal(21)]);

/** The editable product columns; `kind` is fixed at creation. */
export const ProductFields = z.object({
  sku: z
    .string()
    .trim()
    .transform((s) => s.toUpperCase())
    .pipe(z.string().regex(/^[A-Z0-9-]{3,32}$/, "sku_format")),
  name: LocalizedTextSchema,
  description: LocalizedTextSchema.default({}),
  vatRatePct: vatRate.optional(),
  creditKind: z.enum(["day", "night", "euro"]).nullable().optional(),
  creditUnits: optionalPositive,
  validityDays: optionalPositive,
  isSharingAllowed: z.boolean().default(false),
  maxGuestUsesPerMonth: z.number().int().min(0).max(31).default(2),
  memberDiscountPct: z.number().min(0).max(100).nullable().optional(),
  recurringInterval: z.enum(["month", "year"]).nullable().optional(),
  includedCreditKind: z.enum(["day", "night"]).nullable().optional(),
  includedCreditUnits: optionalPositive,
  itemCategory: z.enum(ITEM_CATEGORIES).nullable().optional(),
  isCustomAmount: z.boolean().default(false),
  minAmountCents: optionalPositive,
  maxAmountCents: optionalPositive,
  isShopVisible: z.boolean().default(false),
  isPosVisible: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(100_000).default(0),
});
export type ProductFieldsInput = z.input<typeof ProductFields>;
export type ProductFieldsValue = z.output<typeof ProductFields>;

export const CreateProductInput = ProductFields.extend({ kind: z.enum(PRODUCT_KINDS) });
export const UpdateProductInput = ProductFields.extend({ productId: z.uuid() });
export const SetProductActiveInput = z.object({ productId: z.uuid(), isActive: z.boolean() });

export const AddPriceVersionInput = z
  .object({
    productId: z.uuid(),
    audience: z.enum(["public", "member", "b2b"]),
    amountCents: z.number().int().min(0).max(10_000_000),
    validFromAt: z.coerce.date().optional(),
    validToAt: z.coerce.date().optional(),
    reason: z.string().trim().max(200).optional(),
  })
  .refine((v) => !v.validToAt || v.validToAt.getTime() > (v.validFromAt ?? new Date()).getTime(), { path: ["validToAt"], message: "window" });

export const SetPersonPriceInput = z
  .object({
    personId: z.uuid(),
    productId: z.uuid(),
    amountCents: z.number().int().min(0).max(10_000_000),
    validFromAt: z.coerce.date().optional(),
    validToAt: z.coerce.date().optional(),
    reason: z.string().trim().min(3).max(500),
  })
  .refine((v) => !v.validToAt || v.validToAt.getTime() > (v.validFromAt ?? new Date()).getTime(), { path: ["validToAt"], message: "window" });

export const RevokePersonPriceInput = z.object({ personPriceId: z.uuid() });

// ---------------------------------------------------------------------------
// Product shape per kind (mirrors the `products_*_chk` checks, with field errors)
// ---------------------------------------------------------------------------

/** Default VAT per kind (rule 2): night products and night packages 6 %, vouchers 0 %, else 21 %. */
export function defaultVatRate(kind: ProductKind, creditKind?: CreditKind | null): 0 | 6 | 21 {
  if (kind === "voucher") return 0;
  if (kind === "night") return 6;
  if (kind === "package" && creditKind === "night") return 6;
  return 21;
}

type ProductColumns = Omit<typeof products.$inferInsert, "id" | "createdAt" | "updatedAt" | "isActive" | "imageFileId">;

/** The row values of a product of `kind`; columns that do not apply to the kind are cleared. */
export function productColumns(kind: ProductKind, v: ProductFieldsValue): ProductColumns {
  const fields: Record<string, string> = {};
  const isPackage = kind === "package";
  const isVoucher = kind === "voucher";
  const isMembership = kind === "membership";
  const creditKind: CreditKind | null = isVoucher ? "euro" : isPackage ? (v.creditKind ?? null) : null;
  const vat = v.vatRatePct ?? defaultVatRate(kind, creditKind);

  if (isPackage) {
    if (creditKind !== "day" && creditKind !== "night") fields.creditKind = "required";
    if (!v.creditUnits) fields.creditUnits = "required";
    if (!v.validityDays) fields.validityDays = "required";
  }
  if (isVoucher) {
    if (vat !== 0) fields.vatRatePct = "voucher_vat_zero";
    if ((v.validityDays ?? 730) < 730) fields.validityDays = "voucher_min_730";
  }
  if (isMembership) {
    if (!v.recurringInterval) fields.recurringInterval = "required";
    if ((v.includedCreditKind ?? null) === null !== ((v.includedCreditUnits ?? null) === null)) fields.includedCreditUnits = "both_or_neither";
  }
  if (kind === "item" && !v.itemCategory) fields.itemCategory = "required";
  const isCustomAmount = isVoucher && v.isCustomAmount;
  if (v.isCustomAmount && !isVoucher) fields.isCustomAmount = "voucher_only";
  if (isCustomAmount) {
    const min = v.minAmountCents ?? 0;
    const max = v.maxAmountCents ?? 0;
    if (min < 500) fields.minAmountCents = "custom_amount_range";
    if (max < min || max > 100_000) fields.maxAmountCents = "custom_amount_range";
  }
  if (Object.keys(fields).length) throw new ValidationError("validation", fields);

  return {
    kind,
    sku: v.sku,
    name: v.name,
    description: v.description,
    vatRatePct: vat.toFixed(2),
    creditKind,
    creditUnits: isPackage ? (v.creditUnits ?? null) : null,
    validityDays: isPackage || isVoucher ? (v.validityDays ?? (isVoucher ? 730 : null)) : null,
    isSharingAllowed: isPackage ? v.isSharingAllowed : false,
    maxGuestUsesPerMonth: v.maxGuestUsesPerMonth,
    memberDiscountPct: v.memberDiscountPct == null || isVoucher ? null : v.memberDiscountPct.toFixed(2),
    recurringInterval: isMembership ? (v.recurringInterval ?? null) : null,
    includedCreditKind: isMembership ? (v.includedCreditKind ?? null) : null,
    includedCreditUnits: isMembership ? (v.includedCreditUnits ?? null) : null,
    itemCategory: kind === "item" ? (v.itemCategory ?? null) : null,
    isCustomAmount,
    minAmountCents: isCustomAmount ? (v.minAmountCents ?? null) : null,
    maxAmountCents: isCustomAmount ? (v.maxAmountCents ?? null) : null,
    isShopVisible: v.isShopVisible,
    isPosVisible: v.isPosVisible,
    sortOrder: v.sortOrder,
  };
}

/** Rule 1 and section 8: the locales a product lacks to be (or stay) active. */
export function productCompleteness(row: Pick<ProductRow, "name" | "description" | "isShopVisible">): { name: Locale[]; description: Locale[] } {
  return {
    name: missingLocales(row.name, ALL_LOCALES),
    description: row.isShopVisible ? missingLocales(row.description, ALL_LOCALES) : [],
  };
}

function assertProductComplete(row: Pick<ProductRow, "name" | "description" | "isShopVisible">): void {
  const missing = productCompleteness(row);
  const fields: Record<string, string> = {};
  if (missing.name.length) fields.name = missing.name.join(",");
  if (missing.description.length) fields.description = missing.description.join(",");
  if (Object.keys(fields).length) throw new ValidationError("missing_translation", fields);
}

function staffUserId(ctx: Ctx): string | null {
  return ctx.actor.kind === "staff" ? ctx.actor.userId : null;
}

function requireStaffUserId(ctx: Ctx): string {
  const id = staffUserId(ctx);
  if (!id) throw new ValidationError("staff_only");
  return id;
}

async function lockProduct(tx: DbOrTx, productId: string): Promise<ProductRow> {
  const [row] = await tx.select().from(products).where(eq(products.id, productId)).for("update");
  if (!row) throw new NotFoundError("product_not_found");
  return row;
}

async function skuTaken(tx: DbOrTx, sku: string, exceptId?: string): Promise<boolean> {
  const rows = await tx.select({ id: products.id }).from(products).where(eq(products.sku, sku));
  return rows.some((r) => r.id !== exceptId);
}

// ---------------------------------------------------------------------------
// Product writes
// ---------------------------------------------------------------------------

/** `createProduct`: a new, inactive product (rule 1: it is activated separately). */
export async function createProductRecord(ctx: Ctx, input: z.output<typeof CreateProductInput>): Promise<{ productId: string }> {
  const { kind, ...fields } = input;
  const values = productColumns(kind, fields);
  if (await skuTaken(ctx.tx, values.sku)) throw new ValidationError("validation", { sku: "sku_taken" });
  const [row] = await ctx.tx.insert(products).values({ ...values, isActive: false }).returning();
  await ctx.audit({ action: "product.created", entityType: "product", entityId: row!.id, newValue: row });
  return { productId: row!.id };
}

/** `updateProduct`: every editable column; an active product must stay complete (section 8). */
export async function updateProductRecord(ctx: Ctx, input: z.output<typeof UpdateProductInput>): Promise<{ productId: string }> {
  const { productId, ...fields } = input;
  const before = await lockProduct(ctx.tx, productId);
  const values = productColumns(before.kind, fields);
  if (values.sku !== before.sku && (await skuTaken(ctx.tx, values.sku, productId))) throw new ValidationError("validation", { sku: "sku_taken" });
  if (before.isActive) assertProductComplete({ name: values.name, description: values.description ?? {}, isShopVisible: values.isShopVisible ?? false });
  const [after] = await ctx.tx
    .update(products)
    .set({ ...values, updatedAt: sql`now()` })
    .where(eq(products.id, productId))
    .returning();
  await ctx.audit({ action: "product.updated", entityType: "product", entityId: productId, oldValue: before, newValue: after });
  return { productId };
}

/** `setProductActive` (rule 1): activation needs complete texts and a `public` price valid now. */
export async function setProductActiveRecord(ctx: Ctx, input: z.output<typeof SetProductActiveInput>): Promise<{ ok: true }> {
  const before = await lockProduct(ctx.tx, input.productId);
  if (before.isActive === input.isActive) return { ok: true };
  if (input.isActive) {
    assertProductComplete(before);
    if (!before.isCustomAmount && !(await getProductPrice(ctx.tx, before.id, "public", ctx.now))) {
      throw new ValidationError("no_price", { price: "no_price" });
    }
  }
  await ctx.tx.update(products).set({ isActive: input.isActive, updatedAt: sql`now()` }).where(eq(products.id, before.id));
  await ctx.audit({
    action: input.isActive ? "product.activated" : "product.deactivated",
    entityType: "product",
    entityId: before.id,
    oldValue: { is_active: before.isActive },
    newValue: { is_active: input.isActive },
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Price versions (append-only, rule 4) and person prices (rule 6)
// ---------------------------------------------------------------------------

/**
 * `addPriceVersion`: inserts `max(version) + 1` for (product, audience) under the product row
 * lock, so two staff saving at once get consecutive versions. "Ending a time-limited price early"
 * is a new version with the base amount valid from now; nothing is ever updated or deleted.
 */
export async function addPriceVersionRecord(ctx: Ctx, input: z.output<typeof AddPriceVersionInput>): Promise<{ priceVersionId: string; version: number }> {
  const product = await lockProduct(ctx.tx, input.productId);
  if (product.isCustomAmount) throw new ValidationError("validation", { amountCents: "custom_amount_product" });
  const [last] = await ctx.tx
    .select({ max: sql<number | null>`max(${priceVersions.version})` })
    .from(priceVersions)
    .where(and(eq(priceVersions.productId, product.id), eq(priceVersions.audience, input.audience)));
  const version = Number(last?.max ?? 0) + 1;
  const [row] = await ctx.tx
    .insert(priceVersions)
    .values({
      productId: product.id,
      version,
      audience: input.audience,
      amountCents: input.amountCents,
      validFromAt: input.validFromAt ?? ctx.now,
      validToAt: input.validToAt ?? null,
      reason: input.reason || null,
      createdByUserId: staffUserId(ctx),
    })
    .returning();
  await ctx.audit({ action: "price.version_added", entityType: "product", entityId: product.id, newValue: row });
  return { priceVersionId: row!.id, version };
}

/** `setPersonPrice`: a customer-specific price; the latest `valid_from_at` wins (rule 6). */
export async function setPersonPriceRecord(ctx: Ctx, input: z.output<typeof SetPersonPriceInput>): Promise<{ personPriceId: string }> {
  const userId = requireStaffUserId(ctx);
  await lockProduct(ctx.tx, input.productId);
  const [row] = await ctx.tx
    .insert(personPrices)
    .values({
      personId: input.personId,
      productId: input.productId,
      amountCents: input.amountCents,
      validFromAt: input.validFromAt ?? ctx.now,
      validToAt: input.validToAt ?? null,
      reason: input.reason,
      createdByUserId: userId,
    })
    .returning();
  await ctx.audit({ action: "person_price.set", entityType: "person_price", entityId: row!.id, personId: input.personId, newValue: row });
  return { personPriceId: row!.id };
}

/** `revokePersonPrice`: sets `revoked_at` (the row stays as history). Revoking twice is a no-op. */
export async function revokePersonPriceRecord(ctx: Ctx, input: z.output<typeof RevokePersonPriceInput>): Promise<{ personPriceId: string }> {
  const [before] = await ctx.tx.select().from(personPrices).where(eq(personPrices.id, input.personPriceId)).for("update");
  if (!before) throw new NotFoundError("person_price_not_found");
  if (before.revokedAt) return { personPriceId: before.id };
  const [after] = await ctx.tx
    .update(personPrices)
    .set({ revokedAt: ctx.now, updatedAt: sql`now()` })
    .where(eq(personPrices.id, before.id))
    .returning();
  await ctx.audit({ action: "person_price.revoked", entityType: "person_price", entityId: before.id, personId: before.personId, oldValue: before, newValue: after });
  return { personPriceId: before.id };
}

// ---------------------------------------------------------------------------
// Reads (api.ts)
// ---------------------------------------------------------------------------

export function toPriceVersionRow(r: PriceVersionDbRow): PriceVersionRow {
  return { id: r.id, productId: r.productId, version: r.version, audience: r.audience, amountCents: r.amountCents, validFromAt: r.validFromAt, validToAt: r.validToAt };
}

async function priceRowsFor(db: DbOrTx, productIds: readonly string[]): Promise<Map<string, PriceVersionRow[]>> {
  const out = new Map<string, PriceVersionRow[]>();
  if (productIds.length === 0) return out;
  const rows = await db.select().from(priceVersions).where(inArray(priceVersions.productId, [...productIds]));
  for (const r of rows) {
    const list = out.get(r.productId) ?? [];
    list.push(toPriceVersionRow(r));
    out.set(r.productId, list);
  }
  return out;
}

/**
 * The price of (product, audience, at): the highest version whose window contains `at` (rule 5).
 * When no `member` or `b2b` version is valid, the `public` version is used for that audience.
 */
export async function getProductPrice(
  db: DbOrTx,
  productId: string,
  audience: Audience,
  at: Date = new Date(),
): Promise<{ priceVersionId: string; amountCents: number } | null> {
  const prices = (await priceRowsFor(db, [productId])).get(productId) ?? [];
  const row = priceVersionAt(prices, audience, at) ?? (audience === "public" ? null : priceVersionAt(prices, "public", at));
  return row ? { priceVersionId: row.id, amountCents: row.amountCents } : null;
}

export type PublicPrice = {
  productId: string;
  sku: string;
  kind: ProductKind;
  name: LocalizedText;
  publicAmountCents: number;
  memberAmountCents: number | null;
  vatRatePct: number;
  creditUnits: number | null;
  creditKind: CreditKind | null;
  validityDays: number | null;
  isActive: boolean;
};

/**
 * Prices for site pages: the given products (active or not), or every active product when no
 * ids are given. `memberAmountCents` is set only when a `member` version is valid at `at`; a
 * product without a valid `public` price is left out (a custom-amount voucher shows its minimum).
 */
export async function listPublicPrices(db: DbOrTx, input: { productIds?: string[]; at: Date }): Promise<PublicPrice[]> {
  if (input.productIds && input.productIds.length === 0) return [];
  const rows = await db
    .select()
    .from(products)
    .where(input.productIds ? inArray(products.id, input.productIds) : eq(products.isActive, true))
    .orderBy(asc(products.sortOrder), asc(products.sku));
  const prices = await priceRowsFor(
    db,
    rows.map((r) => r.id),
  );
  const out: PublicPrice[] = [];
  for (const p of rows) {
    const list = prices.get(p.id) ?? [];
    const pub = priceVersionAt(list, "public", input.at);
    const publicAmountCents = pub?.amountCents ?? (p.isCustomAmount ? p.minAmountCents : null);
    if (publicAmountCents == null) continue;
    out.push({
      productId: p.id,
      sku: p.sku,
      kind: p.kind,
      name: p.name,
      publicAmountCents,
      memberAmountCents: priceVersionAt(list, "member", input.at)?.amountCents ?? null,
      vatRatePct: Number(p.vatRatePct),
      creditUnits: p.creditUnits,
      creditKind: p.creditKind,
      validityDays: p.validityDays,
      isActive: p.isActive,
    });
  }
  return out;
}

/** The shop URL of a product (`/[locale]/account/shop/[sku]`). */
export function productShopUrl(sku: string, locale: Locale): string {
  return appUrl(`/${URL_SEGMENT[locale]}/account/shop/${encodeURIComponent(sku)}`);
}

/**
 * Cards for email's product block, in the order of `productIds`. Only active products with a
 * price are returned; names are in `locale` without fallback (an active product is complete,
 * rule 1). Image URLs are signed for 7 days.
 */
export async function getProductCards(tx: DbOrTx, productIds: string[], locale: Locale): Promise<ProductCard[]> {
  if (productIds.length === 0) return [];
  const at = new Date();
  const rows = await tx
    .select()
    .from(products)
    .where(and(inArray(products.id, productIds), eq(products.isActive, true)));
  const prices = await priceRowsFor(
    tx,
    rows.map((r) => r.id),
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const cards: ProductCard[] = [];
  for (const id of productIds) {
    const p = byId.get(id);
    if (!p) continue;
    const list = prices.get(p.id) ?? [];
    const priceCents = priceVersionAt(list, "public", at)?.amountCents ?? (p.isCustomAmount ? p.minAmountCents : null);
    if (priceCents == null) continue;
    cards.push({
      productId: p.id,
      sku: p.sku,
      kind: p.kind,
      name: pick(p.name, locale, `products.name ${p.sku}`),
      priceCents,
      memberPriceCents: priceVersionAt(list, "member", at)?.amountCents ?? null,
      imageUrl: p.imageFileId ? appUrl(signFileUrl(p.imageFileId, 7 * 24 * 3600)) : null,
      url: productShopUrl(p.sku, locale),
    });
  }
  return cards;
}

// ---------------------------------------------------------------------------
// getQuote
// ---------------------------------------------------------------------------

export function toQuoteProduct(p: ProductRow): QuoteProduct {
  return {
    id: p.id,
    kind: p.kind,
    sku: p.sku,
    name: p.name,
    vatRatePct: Number(p.vatRatePct),
    memberDiscountPct: p.memberDiscountPct === null ? null : Number(p.memberDiscountPct),
    isActive: p.isActive,
    isCustomAmount: p.isCustomAmount,
    minAmountCents: p.minAmountCents,
    maxAmountCents: p.maxAmountCents,
  };
}

/**
 * Loads products, price versions, person prices, member benefits and eligible promotions, then
 * calls the pure `quote()` (rules 5 to 17, 26c). Audience is `b2b` with a company, else `public`.
 * Member pricing follows `credits.getMembershipForPerson(...).isMember`, never the crm status
 * override (rule 8); a guest (no person) quotes as `public` without person prices. Unknown
 * products are dropped with `product_unavailable`; a membership line gets `already_member` or
 * `pending_exists` from `credits.canStartMembership`.
 */
export async function getQuote(
  db: DbOrTx,
  args: { personId: string | null; companyId?: string | null; items: CartItem[]; promoCode?: string | null; channel: OrderChannel; at?: Date },
): Promise<Quote> {
  const at = args.at ?? new Date();
  const personId = args.personId ?? null;
  const ids = [...new Set(args.items.map((i) => i.productId))];
  const rows = ids.length ? await db.select().from(products).where(inArray(products.id, ids)) : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const prices = await priceRowsFor(db, ids);

  const warnings: QuoteWarning[] = [];
  const items: QuoteInput["items"] = [];
  for (const item of args.items) {
    const row = byId.get(item.productId);
    if (!row) {
      warnings.push({ code: "product_unavailable", productId: item.productId });
      continue;
    }
    items.push({ ...item, product: toQuoteProduct(row), prices: prices.get(row.id) ?? [] });
  }

  let isMember = false;
  let memberDiscountPct: number | null = null;
  let personStatus: QuoteInput["personStatus"] = null;
  let personPriceRows: PersonPriceRow[] = [];
  if (personId) {
    const membership = await getMembershipForPerson(db, personId);
    isMember = membership.isMember;
    memberDiscountPct = membership.isMember && membership.discountPct > 0 ? membership.discountPct : null;
    personStatus = (await getPersonStatus(db, personId)).status;
    if (ids.length) {
      const pp = await db
        .select()
        .from(personPrices)
        .where(and(eq(personPrices.personId, personId), inArray(personPrices.productId, ids), isNull(personPrices.revokedAt)));
      personPriceRows = pp.map((r) => ({ id: r.id, productId: r.productId, amountCents: r.amountCents, validFromAt: r.validFromAt, validToAt: r.validToAt, revokedAt: r.revokedAt }));
    }
    for (const item of items) {
      if (item.product.kind !== "membership") continue;
      const verdict = await canStartMembership(db, personId, item.startOn ? { startsOn: item.startOn } : {});
      if (!verdict.ok) warnings.push({ code: verdict.reason, productId: item.productId });
    }
  }

  const promotions = await loadEligiblePromotions(db, { personId, channel: args.channel, code: args.promoCode ?? null, at });
  const result = quote({
    items,
    audience: args.companyId ? "b2b" : "public",
    personStatus,
    isMember,
    memberDiscountPct,
    personPrices: personPriceRows,
    promotions,
    promoCode: args.promoCode ?? null,
    at,
  });
  return { ...result, warnings: [...warnings, ...result.warnings] };
}
