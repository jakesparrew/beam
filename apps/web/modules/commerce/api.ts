/**
 * commerce's cross-module door (commerce spec section 4.8, 02-data-model section 6.4). Every
 * function another module calls is declared here with its final signature (commerce-P1, build
 * order rule 1); each throws `NotImplementedError('commerce.<fn>')` until the commerce package
 * that implements it replaces the body. `quote` is the pure core function, re-exported.
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

export type CreateOrderInput = {
  personId: string | null;
  companyId?: string | null;
  channel: OrderChannel;
  items: CartItem[];
  promoCode?: string | null;
  clientKey: string;
  checkoutId?: string;
  locale: Locale;
  useEuroCredit?: boolean;
  note?: string;
  /** Channel `admin` only (booking R63 pay-at-desk: the session's `ends_at`). */
  expiresAt?: Date;
};

export function getQuote(
  _db: DbOrTx,
  _args: { personId: string | null; companyId?: string | null; items: CartItem[]; promoCode?: string | null; channel: OrderChannel; at?: Date },
): Promise<Quote> {
  return notYet("getQuote");
}

export function createOrder(
  _tx: Tx,
  _ctx: Ctx,
  _input: CreateOrderInput,
): Promise<{ orderId: string; reference: string; lineIds: string[]; totalCents: number; status: OrderStatus; expiresAt: Date | null; isExisting: boolean }> {
  return notYet("createOrder");
}

export function startPayment(_tx: Tx, _ctx: Ctx, _input: { orderId: string; returnPath?: string }): Promise<{ paymentId: string | null; redirectUrl: string }> {
  return notYet("startPayment");
}

export function getOrderStatus(_db: DbOrTx, _orderId: string): Promise<{ status: OrderStatus; paidAt: Date | null; dueCents: number }> {
  return notYet("getOrderStatus");
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
  _db: DbOrTx,
  _personId: string,
): Promise<{ paidOrders: number; paidCents: number; lastPaidAt: Date | null; openOrders: number; activeVouchers: number }> {
  return notYet("getPersonCommerceSummary");
}

export function listPersonOrders(_tx: DbOrTx, _personId: string, _opts: { limit: number }): Promise<OrderSummary[]> {
  return notYet("listPersonOrders");
}

export function getProductPrice(
  _db: DbOrTx,
  _productId: string,
  _audience: Audience,
  _at?: Date,
): Promise<{ priceVersionId: string; amountCents: number } | null> {
  return notYet("getProductPrice");
}

export function listPublicPrices(
  _db: DbOrTx,
  _input: { productIds?: string[]; at: Date },
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
  return notYet("listPublicPrices");
}

export function getProductCards(_tx: DbOrTx, _productIds: string[], _locale: Locale): Promise<ProductCard[]> {
  return notYet("getProductCards");
}

export function countOrdersByLanding(
  _db: DbOrTx,
  _input: { from: Date; to: Date },
): Promise<Array<{ landingPath: string | null; utmCampaign: string | null; orders: number; revenueCents: number }>> {
  return notYet("countOrdersByLanding");
}
