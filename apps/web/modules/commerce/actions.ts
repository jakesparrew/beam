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
 * the `person_price.set` timeline event. commerce-P6 adds the staff order, payment-path, payment
 * link, cancellation, refund, voucher and receipt actions, the customer's `withdrawOrder` and
 * `redeemVoucher`, and the pay page's `payByToken` (`./server/{staff-orders,refunds,withdrawals,
 * vouchers,payment-links}`).
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
import { CartItem } from "@beam/core/commerce";
import { BillingDetailsInput } from "@beam/core/finance";
import { ValidationError } from "@/lib/ctx";
import { getQuote } from "./server/catalogue";
import { PayByTokenInput, payByToken as payByTokenRecord, sendPaymentLink as sendPaymentLinkRecord } from "./server/payment-links";
import { confirmManualRefund as confirmManualRefundRecord, issueRefund, retryRefund as retryRefundRecord } from "./server/refunds";
import {
  choosePaymentPath as choosePaymentPathRecord,
  createStaffOrder as createStaffOrderRecord,
  emailReceipt as emailReceiptRecord,
  staffCancelOrder,
} from "./server/staff-orders";
import { redeemVoucher as redeemVoucherRecord, resendVoucher as resendVoucherRecord, voidVoucher as voidVoucherRecord } from "./server/vouchers";
import { withdrawOrder as withdrawOrderRecord } from "./server/withdrawals";

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

// ---------------------------------------------------------------------------
// Staff orders, payment paths and links (commerce-P6, rules 22a, 22b, 41, 43)
// ---------------------------------------------------------------------------

const Reason = z.string().trim().min(3).max(500);
const OptionalEmail = z.string().trim().toLowerCase().pipe(z.email().max(254)).optional();

const CreateStaffOrderInput = z
  .object({
    personId: z.uuid().nullable().optional(),
    companyId: z.uuid().nullable().optional(),
    items: z.array(CartItem).min(1).max(20),
    promoCode: z.string().trim().max(40).nullable().optional(),
    note: z.string().trim().max(1000).nullable().optional(),
    billingDetails: BillingDetailsInput.optional(),
    clientKey: z.uuid().optional(),
  })
  .refine((v) => !!v.personId || !!v.companyId, { message: "required", path: ["personId"] });

export const createStaffOrder = action(
  { name: "commerce.create_staff_order", audience: "staff", permission: "commerce.sell", input: CreateStaffOrderInput, audit: false },
  (ctx, input) => createStaffOrderRecord(ctx.tx, ctx, input),
);

/** The live quote of `/admin/orders/new` (with the `pricing_trace` of every line). */
export const quoteStaffOrder = action(
  {
    name: "commerce.quote_staff_order",
    audience: "staff",
    permission: "commerce.sell",
    input: z.object({ personId: z.uuid().nullable().optional(), companyId: z.uuid().nullable().optional(), items: z.array(CartItem).min(1).max(20), promoCode: z.string().trim().max(40).nullable().optional() }),
    audit: false,
  },
  (ctx, input) => getQuote(ctx.tx, { personId: input.personId ?? null, companyId: input.companyId ?? null, items: input.items, promoCode: input.promoCode ?? null, channel: "admin", at: ctx.now }),
);

/** The person picker of `/admin/orders/new` (up to 8 matches). */
export const findOrderPersons = action(
  { name: "commerce.find_order_persons", audience: "staff", permission: "commerce.sell", input: z.object({ q: z.string().trim().min(2).max(100) }), audit: false },
  async (ctx, input) => (await searchPersons(ctx.tx, { q: input.q, limit: 8 })).map((p) => ({ id: p.personId, name: p.name, email: p.email, customerNumber: p.customerNumber })),
);

export const choosePaymentPath = action(
  {
    name: "commerce.choose_payment_path",
    audience: "staff",
    permission: "commerce.sell",
    input: z.object({ orderId: z.uuid(), path: z.enum(["pos", "link", "bank_transfer"]) }),
    audit: false,
  },
  (ctx, input) => choosePaymentPathRecord(ctx.tx, ctx, input),
);

export const sendPaymentLink = action(
  { name: "commerce.send_payment_link", audience: "staff", permission: "commerce.sell", input: z.object({ orderId: z.uuid(), email: OptionalEmail }), audit: false },
  async (ctx, input) => {
    const out = await sendPaymentLinkRecord(ctx.tx, ctx, input);
    return { expiresAt: out.expiresAt };
  },
);

export const cancelOrder = action(
  { name: "commerce.cancel_order", audience: "staff", permission: "commerce.sell", input: z.object({ orderId: z.uuid(), reason: Reason }), audit: false },
  (ctx, input) => staffCancelOrder(ctx.tx, ctx, input),
);

export const emailReceipt = action(
  { name: "commerce.email_receipt", audience: "staff", permission: "commerce.sell", input: z.object({ orderId: z.uuid(), email: OptionalEmail }), audit: false },
  async (ctx, input) => {
    await emailReceiptRecord(ctx.tx, ctx, input);
    return { ok: true as const };
  },
);

// ---------------------------------------------------------------------------
// Refunds and withdrawals (rules 36 to 40, 54)
// ---------------------------------------------------------------------------

const RefundOrderInput = z.object({
  orderId: z.uuid(),
  lines: z
    .array(z.object({ orderLineId: z.uuid(), quantity: z.number().int().min(1).max(50), amountCents: z.number().int().min(0).optional() }))
    .min(1)
    .max(50),
  reason: z.string().trim().min(5).max(500),
  kind: z.enum(["refund", "withdrawal"]),
});

export const refundOrder = action(
  { name: "commerce.refund_order", audience: "staff", permission: "commerce.refund", input: RefundOrderInput, audit: false },
  async (ctx, input) => {
    const out = await issueRefund(ctx.tx, ctx, { orderId: input.orderId, lines: input.lines, reason: input.reason, kind: input.kind, checkSecondPermission: true });
    await ctx.audit({
      action: "refund.issued",
      entityType: "order",
      entityId: input.orderId,
      newValue: { refundIds: out.refundIds, amountCents: out.amountCents, kind: input.kind, lines: input.lines },
    });
    return { refundIds: out.refundIds, creditNoteId: out.creditNoteId };
  },
);

export const withdrawOrder = action(
  { name: "commerce.withdraw_order", audience: "customer", input: z.object({ orderId: z.uuid(), lineIds: z.array(z.uuid()).min(1).max(50) }), audit: false },
  async (ctx, input) => {
    const personId = ctx.actor.kind === "customer" ? ctx.actor.personId : null;
    const out = await withdrawOrderRecord(ctx.tx, ctx, input, { personId });
    return { refundIds: out.refundIds };
  },
);

export const retryRefund = action(
  { name: "commerce.retry_refund", audience: "staff", permission: "commerce.refund", input: z.object({ refundId: z.uuid() }), audit: false },
  async (ctx, input) => {
    await retryRefundRecord(ctx.tx, ctx, input);
    return { ok: true as const };
  },
);

export const confirmManualRefund = action(
  { name: "commerce.confirm_manual_refund", audience: "staff", permission: "commerce.refund", input: z.object({ refundId: z.uuid() }), audit: false },
  (ctx, input) => confirmManualRefundRecord(ctx.tx, ctx, input),
);

// ---------------------------------------------------------------------------
// Vouchers (rules 45 to 47)
// ---------------------------------------------------------------------------

/**
 * `redeemVoucher`: a customer redeems for themselves (portal, credits' packages page); staff with
 * `commerce.sell` redeem for the person they name.
 */
export const redeemVoucher = action(
  { name: "commerce.redeem_voucher", audience: "any_signed_in", input: z.object({ code: z.string().trim().min(4).max(40), personId: z.uuid().optional() }), audit: false },
  async (ctx, input) => {
    let personId: string;
    if (ctx.actor.kind === "customer") personId = ctx.actor.personId;
    else {
      ctx.require("commerce.sell");
      if (!input.personId) throw new ValidationError("validation", { personId: "required" });
      personId = input.personId;
    }
    return redeemVoucherRecord(ctx.tx, ctx, { code: input.code, personId });
  },
);

export const resendVoucher = action(
  { name: "commerce.resend_voucher", audience: "staff", permission: "commerce.sell", input: z.object({ voucherId: z.uuid(), email: OptionalEmail }), audit: false },
  async (ctx, input) => {
    await resendVoucherRecord(ctx.tx, ctx, input);
    return { ok: true as const };
  },
);

export const voidVoucher = action(
  { name: "commerce.void_voucher", audience: "staff", permission: "commerce.refund", input: z.object({ voucherId: z.uuid(), reason: Reason }), audit: false },
  (ctx, input) => voidVoucherRecord(ctx.tx, ctx, input),
);

// ---------------------------------------------------------------------------
// The pay page (rule 41): public, the token is the proof
// ---------------------------------------------------------------------------

export const payByToken = action(
  { name: "commerce.pay_by_token", audience: "public", input: PayByTokenInput, audit: false, rateLimit: perIp },
  async (ctx, input) => {
    const out = await payByTokenRecord(ctx.tx, ctx, input);
    return { redirectUrl: out.redirectUrl };
  },
);
