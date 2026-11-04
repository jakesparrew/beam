"use server";
/**
 * commerce Server Actions (spec section 4.2, all through `action()`). commerce-P3: the catalogue,
 * price and promotion actions of the back-office (`pricing.write`). Each handler writes its own
 * audit row with the spec's audit name (`product.created`, `price.version_added`, ...), so the
 * wrapper's automatic row is off. Later commerce packages add checkout, order, POS, refund and
 * voucher actions here.
 */
import { z } from "zod";
import { action } from "@/lib/action";
import { searchPersons } from "@/modules/crm/api";
import {
  AddPriceVersionInput,
  CreateProductInput,
  RevokePersonPriceInput,
  SetPersonPriceInput,
  SetProductActiveInput,
  UpdateProductInput,
  addPriceVersionRecord,
  createProductRecord,
  revokePersonPriceRecord,
  setPersonPriceRecord,
  setProductActiveRecord,
  updateProductRecord,
} from "./server/catalogue";
import { CreatePromotionInput, UpdatePromotionInput, createPromotionRecord, updatePromotionRecord } from "./server/promotions";

export const createProduct = action(
  { name: "commerce.create_product", audience: "staff", permission: "pricing.write", input: CreateProductInput, audit: false },
  (ctx, input) => createProductRecord(ctx, input),
);

export const updateProduct = action(
  { name: "commerce.update_product", audience: "staff", permission: "pricing.write", input: UpdateProductInput, audit: false },
  (ctx, input) => updateProductRecord(ctx, input),
);

export const setProductActive = action(
  { name: "commerce.set_product_active", audience: "staff", permission: "pricing.write", input: SetProductActiveInput, audit: false },
  (ctx, input) => setProductActiveRecord(ctx, input),
);

export const addPriceVersion = action(
  { name: "commerce.add_price_version", audience: "staff", permission: "pricing.write", input: AddPriceVersionInput, audit: false },
  (ctx, input) => addPriceVersionRecord(ctx, input),
);

export const setPersonPrice = action(
  { name: "commerce.set_person_price", audience: "staff", permission: "pricing.write", input: SetPersonPriceInput, audit: false },
  (ctx, input) => setPersonPriceRecord(ctx, input),
);

export const revokePersonPrice = action(
  { name: "commerce.revoke_person_price", audience: "staff", permission: "pricing.write", input: RevokePersonPriceInput, audit: false },
  (ctx, input) => revokePersonPriceRecord(ctx, input),
);

export const createPromotion = action(
  { name: "commerce.create_promotion", audience: "staff", permission: "pricing.write", input: CreatePromotionInput, audit: false },
  (ctx, input) => createPromotionRecord(ctx, input),
);

export const updatePromotion = action(
  { name: "commerce.update_promotion", audience: "staff", permission: "pricing.write", input: UpdatePromotionInput, audit: false },
  (ctx, input) => updatePromotionRecord(ctx, input),
);

/** The person picker of `/admin/products/[id]/person-prices` (up to 8 matches). */
export const findPricePersons = action(
  { name: "commerce.find_price_persons", audience: "staff", permission: "pricing.write", input: z.object({ q: z.string().trim().min(2).max(100) }), audit: false },
  async (ctx, input) => (await searchPersons(ctx.tx, { q: input.q, limit: 8 })).map((p) => ({ id: p.personId, name: p.name, email: p.email, customerNumber: p.customerNumber })),
);
