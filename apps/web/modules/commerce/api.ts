/**
 * commerce's cross-module door (commerce spec section 4.8, 02-data-model section 6.4). Every
 * function another module calls is declared here with its final signature (commerce-P1, build
 * order rule 1); a function whose package has not landed yet throws
 * `NotImplementedError('commerce.<fn>')`. commerce-P3 serves `getQuote`, `getProductPrice`,
 * `listPublicPrices` and `getProductCards` (`./server/catalogue`); commerce-P4a `createOrder`,
 * `startPayment`, `getOrderStatus`, `getPersonCommerceSummary` and `listPersonOrders`. `quote` is the pure core function, re-exported.
 * `redeemVoucher` is re-exported from `./actions` once commerce-P6 builds that server action
 * (actions are `export {}` until then; DM-13).
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
import * as catalogue from "./server/catalogue";
import * as orders from "./server/orders";
import type { CreateOrderInput, CreateOrderResult } from "./server/orders";
import * as payments from "./server/payments";

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
  return catalogue.getQuote(db, args);
}

/**
 * Prices and writes an order with its lines in the caller's transaction (rules 19 to 27).
 * `lineIds` come back in item order; `items[].bookingIds` are stored in
 * `order_lines.data.booking_ids` and booking is never called (rule 21, cross-module D21).
 */
export function createOrder(tx: Tx, ctx: Ctx, input: CreateOrderInput): Promise<CreateOrderResult> {
  return orders.createOrder(tx, ctx, input);
}

/** Inline `payments.create`; `redirectUrl` = the provider page, or the return page when nothing is due. */
export function startPayment(tx: Tx, ctx: Ctx, input: { orderId: string; returnPath?: string }): Promise<{ paymentId: string | null; redirectUrl: string }> {
  return payments.startPayment(tx, ctx, input);
}

export function getOrderStatus(db: DbOrTx, orderId: string): Promise<{ status: OrderStatus; paidAt: Date | null; dueCents: number }> {
  return orders.getOrderStatus(db, orderId);
}

export function cancelOrder(_tx: Tx, _ctx: Ctx, _input: { orderId: string; reason: string }): Promise<{ cancelled: boolean }> {
  return notYet("cancelOrder");
}

export function refundOrderLine(
  _tx: Tx,
  _ctx: Ctx,
  _input: { orderLineId: string; reason: "cancelled_in_policy" | "session_cancelled" | "seat_no_longer_available" },
): Promise<{ refundId: string | null; amountCents: number }> {
  return notYet("refundOrderLine");
}

// credits: membership renewals ------------------------------------------------------

export function createRecurringCharge(
  _tx: Tx,
  _ctx: Ctx,
  _input: { membershipId: string; personId: string; productId: string; mandateId: string; periodEndOn: string },
): Promise<{ orderId: string; paymentId: string }> {
  return notYet("createRecurringCharge");
}

export function createRenewalLinkOrder(
  _tx: Tx,
  _ctx: Ctx,
  _input: { membershipId: string; personId: string; productId: string; periodEndOn: string },
): Promise<{ orderId: string; payUrl: string }> {
  return notYet("createRenewalLinkOrder");
}

export function getPayLinkForOrder(_tx: Tx, _ctx: Ctx, _input: { orderId: string }): Promise<{ payUrl: string; expiresAt: Date }> {
  return notYet("getPayLinkForOrder");
}

export function cancelRenewalOrder(_tx: Tx, _ctx: Ctx, _input: { orderId: string; reason: string }): Promise<void> {
  return notYet("cancelRenewalOrder");
}

export function getActiveMandate(_db: DbOrTx, _personId: string): Promise<{ mandateId: string; method: string; summary: string | null } | null> {
  return notYet("getActiveMandate");
}

// finance: bank transfers -------------------------------------------------------------

export function recordBankTransferPaid(
  _tx: Tx,
  _ctx: Ctx,
  _input: { orderId: string; paidOn: string; reference: string },
): Promise<{ applied: boolean }> {
  return notYet("recordBankTransferPaid");
}

// ops: erasure ----------------------------------------------------------------------------

export function revokeMandatesForPerson(_tx: Tx, _ctx: Ctx, _personId: string): Promise<{ revoked: number }> {
  return notYet("revokeMandatesForPerson");
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

export function listPaymentAttention(_db: DbOrTx, _opts: { limit: number }): Promise<PaymentAttentionItem[]> {
  return notYet("listPaymentAttention");
}

export function getPersonCommerceSummary(
  db: DbOrTx,
  personId: string,
): Promise<{ paidOrders: number; paidCents: number; lastPaidAt: Date | null; openOrders: number; activeVouchers: number }> {
  return orders.getPersonCommerceSummary(db, personId);
}

export function listPersonOrders(tx: DbOrTx, personId: string, opts: { limit: number }): Promise<OrderSummary[]> {
  return orders.listPersonOrders(tx, personId, opts);
}

export function getProductPrice(db: DbOrTx, productId: string, audience: Audience, at?: Date): Promise<{ priceVersionId: string; amountCents: number } | null> {
  return catalogue.getProductPrice(db, productId, audience, at);
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
  return catalogue.listPublicPrices(db, input);
}

export function getProductCards(tx: DbOrTx, productIds: string[], locale: Locale): Promise<ProductCard[]> {
  return catalogue.getProductCards(tx, productIds, locale);
}

export function countOrdersByLanding(
  _db: DbOrTx,
  _input: { from: Date; to: Date },
): Promise<Array<{ landingPath: string | null; utmCampaign: string | null; orders: number; revenueCents: number }>> {
  return notYet("countOrdersByLanding");
}
