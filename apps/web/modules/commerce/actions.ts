"use server";
/**
 * commerce Server Actions (spec section 4.2, all through `action()`). commerce-P3: the catalogue,
 * price and promotion actions of the back-office (`pricing.write`). Each handler writes its own
 * audit row with the spec's audit name (`product.created`, `price.version_added`, ...), so the
 * wrapper's automatic row is off. Later commerce packages add checkout, order, POS, refund and
 * voucher actions here. commerce-P5 adds the customer checkout: `startCheckout`, `updateCheckout`,
 * `placeOrder`, `payOrder`, `retryPayment` and the return page's `checkOrderStatus` poll
 * (`./server/checkouts`). They are public (portal or site guest); guests are recognised by the
 * signed `beam_checkout` viewer cookie, which these actions extend. `setPersonPrice` also writes
 * the `person_price.set` timeline event.
 */
import { z } from "zod";
import { action } from "@/lib/action";
import { searchPersons } from "@/modules/crm/api";
import { readReferralCode } from "@/modules/site/api";
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
import {
  PayOrderInput,
  PlaceOrderInput,
  RetryPaymentInput,
  StartCheckoutInput,
  UpdateCheckoutInput,
  payOrder as payOrderRecord,
  placeOrder as placeOrderRecord,
  pollOrderStatus,
  readViewer,
  rememberInViewer,
  retryPayment as retryPaymentRecord,
  startCheckout as startCheckoutRecord,
  updateCheckout as updateCheckoutRecord,
} from "./server/checkouts";
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
  async (ctx, input) => {
    const out = await setPersonPriceRecord(ctx, input);
    await ctx.recordEvent({
      kind: "person_price.set",
      personId: input.personId,
      ref: { type: "person_price", id: out.personPriceId },
      dedupeKey: `person_price:${out.personPriceId}:set`,
      data: { product_id: input.productId },
    });
    return out;
  },
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

// ---------------------------------------------------------------------------
// Customer checkout (commerce-P5, rules 16, 20, 26 to 26c, 48)
// ---------------------------------------------------------------------------

/** Public actions: 20 per minute per IP (`api` bucket); placements and payments also per id. */
const perIp = (_input: unknown, meta: { ip: string }) => ({ route: "api" as const, ip: meta.ip });

export const startCheckout = action(
  { name: "commerce.start_checkout", audience: "public", input: StartCheckoutInput, audit: false, rateLimit: perIp },
  async (ctx, input) => {
    const out = await startCheckoutRecord(ctx.tx, ctx, input, await readViewer(ctx.actor));
    await rememberInViewer("checkout", out.checkoutId);
    return out;
  },
);

export const updateCheckout = action(
  { name: "commerce.update_checkout", audience: "public", input: UpdateCheckoutInput, audit: false, rateLimit: perIp },
  async (ctx, input) => updateCheckoutRecord(ctx.tx, ctx, input, await readViewer(ctx.actor)),
);

export const placeOrder = action(
  { name: "commerce.place_order", audience: "public", input: PlaceOrderInput, audit: false, rateLimit: perIp },
  async (ctx, input) => {
    const { cookies } = await import("next/headers");
    const referralCode = readReferralCode(await cookies());
    const out = await placeOrderRecord(ctx.tx, ctx, input, await readViewer(ctx.actor), { referralCode });
    await rememberInViewer("order", out.orderId);
    return out;
  },
);

export const payOrder = action(
  { name: "commerce.pay_order", audience: "public", input: PayOrderInput, audit: false, rateLimit: perIp },
  async (ctx, input) => payOrderRecord(ctx.tx, ctx, input, await readViewer(ctx.actor)),
);

export const retryPayment = action(
  { name: "commerce.retry_payment", audience: "public", input: RetryPaymentInput, audit: false, rateLimit: perIp },
  async (ctx, input) => retryPaymentRecord(ctx.tx, ctx, input, await readViewer(ctx.actor)),
);

/** The return page poll (`getOrderStatus` over a server action, section 4.4). */
export const checkOrderStatus = action(
  { name: "commerce.check_order_status", audience: "public", input: z.object({ orderId: z.uuid() }), audit: false, rateLimit: perIp },
  async (ctx, input) => pollOrderStatus(ctx.tx, ctx, input.orderId, await readViewer(ctx.actor)),
);
