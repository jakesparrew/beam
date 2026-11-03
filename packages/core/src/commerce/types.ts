/**
 * commerce types named in the cross-module contract (02-data-model section 6.4). Wave 0
 * skeleton by platform-P7; commerce owns this file from commerce-P1 on and may widen the
 * shapes, never rename them.
 */
import type { Locale } from "../i18n/locales";
import type { LocalizedText } from "../i18n/localized-text";

export type ProductKind = "session" | "night" | "package" | "membership" | "ticket" | "item" | "voucher";
export type CreditKind = "day" | "night" | "euro";
export type Audience = "public" | "member" | "b2b";
export type OrderChannel = "portal" | "site" | "admin" | "pos" | "link" | "recurring";
export type OrderStatus = "draft" | "pending_payment" | "paid" | "cancelled" | "expired" | "refunded" | "partially_refunded";

/** One cart line; `bookingIds` are booking's `reserved` rows for session lines (rule 21, D21). */
export type CartItem = {
  productId: string;
  quantity: number;
  sessionId?: string;
  bookingIds?: string[];
  voucherAmountCents?: number;
  voucherRecipient?: { name?: string; email?: string; message?: string };
};

export type QuoteLine = {
  productId: string;
  quantity: number;
  description: string;
  priceVersionId: string;
  unitAmountCents: number;
  discountCents: number;
  totalCents: number;
  vatRatePct: number;
  vatCents: number;
};

export type Quote = {
  lines: QuoteLine[];
  subtotalCents: number;
  discountCents: number;
  vatCents: number;
  totalCents: number;
  promoCode: string | null;
  promotionId: string | null;
  memberDiscountPct: number;
  euroCreditCents: number;
  dueCents: number;
  problems: { code: string; productId?: string }[];
};

/** The pure input of `quote()`: everything already loaded by `getQuote()`. */
export type QuoteInput = {
  items: CartItem[];
  channel: OrderChannel;
  at: Date;
  products: Array<{
    id: string;
    kind: ProductKind;
    name: LocalizedText;
    isActive: boolean;
    prices: Array<{ priceVersionId: string; audience: Audience; amountCents: number; vatRatePct: number; validFrom: Date; validTo: Date | null }>;
  }>;
  isMember: boolean;
  memberDiscountPct: number;
  promotion?: { id: string; code: string | null; kind: "percent" | "amount"; value: number; productIds: string[] | null } | null;
  euroCreditCents?: number;
  locale: Locale;
};

export type ProductCard = {
  productId: string;
  sku: string;
  kind: ProductKind;
  name: string;
  priceCents: number;
  memberPriceCents: number | null;
  imageUrl: string | null;
  url: string;
};

export type PaymentAttentionItem = {
  orderId: string;
  reference: string;
  personId: string | null;
  status: OrderStatus;
  reason: string;
  amountCents: number;
  since: Date;
};

export type OrderSummary = {
  orderId: string;
  reference: string;
  channel: OrderChannel;
  status: OrderStatus;
  totalCents: number;
  createdAt: Date;
  paidAt: Date | null;
  lineCount: number;
};
