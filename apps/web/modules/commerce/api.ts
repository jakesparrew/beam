/**
 * commerce's cross-module door (commerce spec section 4.8, 02-data-model section 6.4). Every
 * function another module calls is declared here with its final signature (commerce-P1, build
 * order rule 1); a function whose package has not landed yet throws
 * `NotImplementedError('commerce.<fn>')`. commerce-P3 serves `getQuote`, `getProductPrice`,
 * `listPublicPrices` and `getProductCards` (`./server/catalogue`); commerce-P4a `createOrder`,
 * `startPayment`, `getOrderStatus`, `getPersonCommerceSummary` and `listPersonOrders`; commerce-P4b
 * `cancelOrder` and `cancelRenewalOrder` (`./server/cancel`), the renewal functions
 * (`./server/recurring`, `./server/payment-links`), `recordBankTransferPaid`
 * (`./server/bank-transfer`) and `revokeMandatesForPerson` (`./server/mandates`). `quote` is the pure core function, re-exported.
 * commerce-P6: `refundOrderLine` (`./server/refunds`), `listPaymentAttention`
 * (`./server/attention`) and the `redeemVoucher` server action re-exported from `./actions` (DM-13).
 */
import type { DbOrTx, Tx } from "@beam/db";
import { NotImplementedError } from "@beam/core/errors";
import type { Locale, LocalizedText } from "@beam/core/i18n";
import type {
  Audience,
  CartItem,
  CreditKind,
  OrderChannel,
  OrderStatus,
  OrderSummary,
  PaymentAttentionItem,
  ProductCard,
  ProductKind,
  Quote,
} from "@beam/core/commerce";
import type { Ctx } from "@/lib/ctx";
import type { CreateOrderInput, CreateOrderResult } from "./server/orders";

/**
 * The catalogue, order and payment services are loaded on first call: they import booking, credits, crm,
 * email, finance and site, whose import graphs reach booking, and booking imports this file. A
 * static import would close that cycle while this module is still evaluating (and would hand
 * the real functions to a module that a test mocks this file for).
 */
const catalogueService = () => import("./server/catalogue");
const orderService = () => import("./server/orders");
const paymentService = () => import("./server/payments");
const cancelService = () => import("./server/cancel");
const recurringService = () => import("./server/recurring");
const payLinkService = () => import("./server/payment-links");
const bankTransferService = () => import("./server/bank-transfer");
const mandateService = () => import("./server/mandates");
const refundService = () => import("./server/refunds");
const attentionService = () => import("./server/attention");

export { quote } from "@beam/core/commerce";
export type {
  Audience,
  CartItem,
  OrderChannel,
  OrderStatus,
  OrderSummary,
  PaymentAttentionItem,
  ProductCard,
  Quote,
  QuoteInput,
  QuoteLine,
  QuoteWarning,
} from "@beam/core/commerce";

const notYet = <T>(fn: string): Promise<T> => Promise.reject(new NotImplementedError(`commerce.${fn}`));

export type { CreateOrderInput, CreateOrderResult } from "./server/orders";
export type { DeliveredLine } from "./server/paid";
export type { ReportedPayment, SyncResult } from "./server/payments";

/** Loads products, prices, member benefits and eligible promotions, then calls the pure `quote` (commerce-P3). */
export function getQuote(
  db: DbOrTx,
  args: { personId: string | null; companyId?: string | null; items: CartItem[]; promoCode?: string | null; channel: OrderChannel; at?: Date },
): Promise<Quote> {
  return catalogueService().then((m) => m.getQuote(db, args));
}

/**
 * Prices and writes an order with its lines in the caller's transaction (rules 19 to 27).
 * `lineIds` come back in item order; `items[].bookingIds` are stored in
 * `order_lines.data.booking_ids` and booking is never called (rule 21, cross-module D21).
 */
export function createOrder(tx: Tx, ctx: Ctx, input: CreateOrderInput): Promise<CreateOrderResult> {
  return orderService().then((m) => m.createOrder(tx, ctx, input));
}

/** Inline `payments.create`; `redirectUrl` = the provider page, or the return page when nothing is due. */
export function startPayment(tx: Tx, ctx: Ctx, input: { orderId: string; returnPath?: string }): Promise<{ paymentId: string | null; redirectUrl: string }> {
  return paymentService().then((m) => m.startPayment(tx, ctx, input));
}

export function getOrderStatus(db: DbOrTx, orderId: string): Promise<{ status: OrderStatus; paidAt: Date | null; dueCents: number }> {
  return orderService().then((m) => m.getOrderStatus(db, orderId));
}

/**
 * Rule 22b: cancels a `draft` or `pending_payment` order with its releases; `{ cancelled: false }`
 * for a non-cancellable order (other status, live provider payment), never a throw for its
 * status (cross-module D31). An open bank-transfer invoice is credited in the same transaction.
 */
export function cancelOrder(tx: Tx, ctx: Ctx, input: { orderId: string; reason: string }): Promise<{ cancelled: boolean }> {
  return cancelService().then((m) => m.cancelOrder(tx, ctx, input));
}

/**
 * Rule 37a: refunds the full line, needs no staff permission, never calls booking back and is
 * idempotent per line and reason. `staff_override` marks a staff-forced refund booking starts
 * outside its policy, so finance can tell it from an in-policy cancellation.
 */
export function refundOrderLine(
  tx: Tx,
  ctx: Ctx,
  input: { orderLineId: string; reason: "cancelled_in_policy" | "session_cancelled" | "seat_no_longer_available" | "staff_override" },
): Promise<{ refundId: string | null; amountCents: number }> {
  return refundService().then((m) => m.refundOrderLine(tx, ctx, input));
}

// credits: membership renewals ------------------------------------------------------

/** Creates or reuses the period's renewal order, inserts a new recurring payment and enqueues `payments.charge_recurring`. */
export function createRecurringCharge(
  tx: Tx,
  ctx: Ctx,
  input: { membershipId: string; personId: string; productId: string; mandateId: string; periodEndOn: string },
): Promise<{ orderId: string; paymentId: string }> {
  return recurringService().then((m) => m.createRecurringCharge(tx, ctx, input));
}

/** Channel `link`; idempotent per membership and period. */
export function createRenewalLinkOrder(
  tx: Tx,
  ctx: Ctx,
  input: { membershipId: string; personId: string; productId: string; periodEndOn: string },
): Promise<{ orderId: string; payUrl: string }> {
  return recurringService().then((m) => m.createRenewalLinkOrder(tx, ctx, input));
}

/** Rule 41: the same URL while the link is valid, a new one only after it expired. */
export function getPayLinkForOrder(tx: Tx, ctx: Ctx, input: { orderId: string }): Promise<{ payUrl: string; expiresAt: Date }> {
  return payLinkService().then((m) => m.getPayLinkForOrder(tx, ctx, input));
}

/** Rule 22c: `cancelOrder` without the `payment_in_progress` refusal; open recurring payments are cancelled by `payments.cancel`. */
export function cancelRenewalOrder(tx: Tx, ctx: Ctx, input: { orderId: string; reason: string }): Promise<void> {
  return cancelService().then((m) => m.cancelRenewalOrder(tx, ctx, input));
}

/** The person's latest `valid` mandate (`mandateId` is `mandates.id`). */
export function getActiveMandate(db: DbOrTx, personId: string): Promise<{ mandateId: string; method: string; summary: string | null } | null> {
  return recurringService().then((m) => m.getActiveMandate(db, personId));
}

// finance: bank transfers -------------------------------------------------------------

/** Rule 43a: settles the open transfer and runs the paid transaction; idempotent on the order. */
export function recordBankTransferPaid(
  tx: Tx,
  ctx: Ctx,
  input: { orderId: string; paidOn: string; reference: string },
): Promise<{ applied: boolean }> {
  return bankTransferService().then((m) => m.recordBankTransferPaid(tx, ctx, input));
}

// ops: erasure ----------------------------------------------------------------------------

/** Ops rule 62: marks every valid mandate revoked and enqueues `commerce.revoke_mandate` per mandate. */
export function revokeMandatesForPerson(tx: Tx, ctx: Ctx, personId: string): Promise<{ revoked: number }> {
  return mandateService().then((m) => m.revokeMandatesForPerson(tx, ctx, personId));
}

// automation (R2) -------------------------------------------------------------------------

export function markCheckoutRecoveryMessage(_tx: Tx, _input: { checkoutId: string; emailMessageId: string }): Promise<void> {
  return notYet("markCheckoutRecoveryMessage");
}

export function getCheckoutRecoveryProps(
  _tx: Tx,
  _checkoutId: string,
): Promise<{ resumeUrl: string; items: ProductCard[]; totalCents: number; locale: Locale }> {
  return notYet("getCheckoutRecoveryProps");
}

// ops, crm, email, site -------------------------------------------------------------------

/** The action dashboard feed (`v_payment_attention`); `reason` is the feed kind. */
export function listPaymentAttention(db: DbOrTx, opts: { limit: number }): Promise<PaymentAttentionItem[]> {
  return attentionService().then((m) => m.listPaymentAttention(db, opts));
}

// credits' portal packages page: the redeem field submits commerce's own server action (DM-13).
export { redeemVoucher } from "./actions";

export function getPersonCommerceSummary(
  db: DbOrTx,
  personId: string,
): Promise<{ paidOrders: number; paidCents: number; lastPaidAt: Date | null; openOrders: number; activeVouchers: number }> {
  return orderService().then((m) => m.getPersonCommerceSummary(db, personId));
}

export function listPersonOrders(tx: DbOrTx, personId: string, opts: { limit: number }): Promise<OrderSummary[]> {
  return orderService().then((m) => m.listPersonOrders(tx, personId, opts));
}

export function getProductPrice(db: DbOrTx, productId: string, audience: Audience, at?: Date): Promise<{ priceVersionId: string; amountCents: number } | null> {
  return catalogueService().then((m) => m.getProductPrice(db, productId, audience, at));
}

export function listPublicPrices(
  db: DbOrTx,
  input: { productIds?: string[]; at: Date },
): Promise<
  Array<{
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
  }>
> {
  return catalogueService().then((m) => m.listPublicPrices(db, input));
}

export function getProductCards(tx: DbOrTx, productIds: string[], locale: Locale): Promise<ProductCard[]> {
  return catalogueService().then((m) => m.getProductCards(tx, productIds, locale));
}

export function countOrdersByLanding(
  _db: DbOrTx,
  _input: { from: Date; to: Date },
): Promise<Array<{ landingPath: string | null; utmCampaign: string | null; orders: number; revenueCents: number }>> {
  return notYet("countOrdersByLanding");
}
