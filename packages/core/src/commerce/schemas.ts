/**
 * commerce's Zod schemas and the pure types of spec section 4.1 (`@beam/core/commerce`).
 *
 * `CartItem` is what a cart, a checkout row (`checkouts.items`) and `createOrder` carry: no
 * prices, ever (cross-module D55). `CommerceSettings` and `PaymentProviderByChannel` validate
 * the two settings keys of spec section 2.4; their defaults are exported beside them.
 */
import { z } from "zod";
import { LocalizedTextSchema, type LocalizedText } from "../i18n/localized-text";
import type { Audience, OrderChannel, ProductKind } from "./types";

// ---------------------------------------------------------------------------
// Enum unions (mirrors of the pgEnums in packages/db/src/schema/commerce.ts)
// ---------------------------------------------------------------------------

export const PRODUCT_KINDS = ["session", "night", "package", "membership", "ticket", "item", "voucher"] as const;
export const ORDER_CHANNELS = ["portal", "site", "admin", "pos", "link", "recurring"] as const;
export const ORDER_STATUSES = ["draft", "pending_payment", "paid", "cancelled", "expired", "refunded", "partially_refunded"] as const;
export const PAYMENT_PROVIDERS = ["mollie", "stripe", "viva", "cash", "terminal", "bank_transfer", "credit_balance"] as const;
export type PaymentProvider = (typeof PAYMENT_PROVIDERS)[number];
/** Providers that never call out (rule 29). */
export const LOCAL_PAYMENT_PROVIDERS = ["cash", "bank_transfer", "credit_balance"] as const satisfies readonly PaymentProvider[];
export const PAYMENT_STATUSES = [
  "open",
  "pending",
  "authorized",
  "paid",
  "failed",
  "expired",
  "cancelled",
  "refunded",
  "partially_refunded",
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
export const PAYMENT_SEQUENCE_TYPES = ["oneoff", "first", "recurring"] as const;
export type PaymentSequenceType = (typeof PAYMENT_SEQUENCE_TYPES)[number];
/** `payments.status_history[].source`. */
export const STATUS_SOURCES = ["provider", "local_timeout", "staff"] as const;
export type StatusSource = (typeof STATUS_SOURCES)[number];
export const REFUND_STATUSES = ["pending", "sent", "refunded", "failed"] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];
export const REFUND_CREDIT_ACTIONS = ["none", "release", "revoke"] as const;
export type RefundCreditAction = (typeof REFUND_CREDIT_ACTIONS)[number];
export const VOUCHER_STATUSES = ["pending", "active", "redeemed", "expired", "void"] as const;
export type VoucherStatus = (typeof VOUCHER_STATUSES)[number];
export const CHECKOUT_STATUSES = ["started", "abandoned", "completed", "expired"] as const;
export type CheckoutStatus = (typeof CHECKOUT_STATUSES)[number];
export const CHECKOUT_CHANNELS = ["portal", "site"] as const;
export type CheckoutChannel = (typeof CHECKOUT_CHANNELS)[number];
export const CHECKOUT_ABANDONED_REASONS = ["left", "payment_failed", "payment_expired"] as const;
export type CheckoutAbandonedReason = (typeof CHECKOUT_ABANDONED_REASONS)[number];
export const REDEMPTION_STATUSES = ["reserved", "confirmed", "released"] as const;
export type RedemptionStatus = (typeof REDEMPTION_STATUSES)[number];
export const MANDATE_STATUSES = ["pending", "valid", "invalid", "revoked"] as const;
export type MandateStatus = (typeof MANDATE_STATUSES)[number];
export const POS_DAY_STATUSES = ["open", "closed"] as const;
export type PosDayStatus = (typeof POS_DAY_STATUSES)[number];
export const PROMOTION_KINDS = ["percent", "fixed"] as const;
export type PromotionKind = (typeof PROMOTION_KINDS)[number];
export const ITEM_CATEGORIES = ["merchandise", "wellness_product", "other"] as const;
export type ItemCategory = (typeof ITEM_CATEGORIES)[number];
/** Products sold per seat: one line per booking row, quantity 1 (rule 21). */
export const DATED_PRODUCT_KINDS = ["session", "night", "ticket"] as const satisfies readonly ProductKind[];
export type VatRatePct = 0 | 6 | 12 | 21;
export const VAT_RATES: readonly VatRatePct[] = [0, 6, 12, 21];

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// ---------------------------------------------------------------------------
// CartItem
// ---------------------------------------------------------------------------

export const CartItem = z
  .object({
    productId: z.string().uuid(),
    quantity: z.number().int().min(1).max(50),
    sessionId: z.string().uuid().optional(),
    ticketTypeId: z.string().uuid().optional(),
    /** Booking-originated session, night and ticket lines: exactly one `reserved` booking id (rule 21, D21). */
    bookingIds: z.array(z.string().uuid()).optional(),
    /** Custom-amount voucher only. */
    amountCents: z.number().int().optional(),
    /** Future start of a membership or package, at most 90 days ahead. */
    startOn: isoDate.optional(),
    voucher: z
      .object({
        recipientName: z.string().max(120),
        recipientEmail: z.string().email().optional(),
        message: z.string().max(500).optional(),
        /** Rule 45a: today up to 365 days ahead. */
        deliverOn: isoDate.optional(),
      })
      .optional(),
  })
  .superRefine((item, ctx) => {
    if (item.sessionId !== undefined && item.quantity !== 1) {
      ctx.addIssue({ code: "custom", path: ["quantity"], message: "session_line_quantity" });
    }
    if (item.bookingIds !== undefined && item.bookingIds.length > 1) {
      ctx.addIssue({ code: "custom", path: ["bookingIds"], message: "one_booking_per_line" });
    }
    if (item.bookingIds !== undefined && item.bookingIds.length > 0 && item.sessionId === undefined) {
      ctx.addIssue({ code: "custom", path: ["sessionId"], message: "booking_without_session" });
    }
  });
export type CartItem = z.infer<typeof CartItem>;

// ---------------------------------------------------------------------------
// Quote input and output (pricing.ts)
// ---------------------------------------------------------------------------

/** The product columns `quote()` reads. */
export type QuoteProduct = {
  id: string;
  kind: ProductKind;
  sku: string;
  name: LocalizedText;
  vatRatePct: number;
  memberDiscountPct: number | null;
  isActive: boolean;
  isCustomAmount: boolean;
  minAmountCents: number | null;
  maxAmountCents: number | null;
};

export type PriceVersionRow = {
  id: string;
  productId: string;
  version: number;
  audience: Audience;
  amountCents: number;
  validFromAt: Date;
  validToAt: Date | null;
};

export type PersonPriceRow = {
  id: string;
  productId: string;
  amountCents: number;
  validFromAt: Date;
  validToAt: Date | null;
  revokedAt: Date | null;
};

export type PromotionAppliesTo = { productIds: string[]; productKinds: ProductKind[] };

export type PromotionRow = {
  id: string;
  /** Null = automatic. Stored upper case. */
  code: string | null;
  name: LocalizedText;
  kind: PromotionKind;
  /** Percent 1-100, or cents off each unit. */
  value: number;
  appliesTo: PromotionAppliesTo;
  startsAt: Date;
  endsAt: Date | null;
  maxUses: number | null;
  usesCount: number;
  isActive: boolean;
};

export type QuoteWarningCode =
  | "promo_unknown"
  | "promo_inactive"
  | "promo_expired"
  | "promo_exhausted"
  | "promo_not_eligible"
  | "promo_not_better"
  | "product_unavailable"
  | "no_price"
  | "amount_out_of_range"
  | "already_member"
  | "pending_exists";
export type QuoteWarning = { code: QuoteWarningCode; productId?: string };

export type QuoteInput = {
  items: Array<CartItem & { product: QuoteProduct; prices: PriceVersionRow[] }>;
  /** `b2b` when the order has a company, else `public` (rule 7); `member` is treated as `public`. */
  audience: Audience;
  personStatus: "lead" | "customer" | "member" | null;
  /** `credits.getMembershipForPerson(...).isMember` (rule 8). */
  isMember: boolean;
  /** The membership's default discount, used when the product has none. */
  memberDiscountPct: number | null;
  personPrices: PersonPriceRow[];
  /** Eligibility (rule 17) is decided by the caller and passed in per promotion. */
  promotions: Array<PromotionRow & { isEligible: boolean }>;
  promoCode: string | null;
  at: Date;
};

export type PricingCandidateSource = "base" | "member_version" | "person_price" | "member_discount" | "promotion";
export type PricingCandidate = {
  source: PricingCandidateSource;
  sourceId: string | null;
  unitCents: number;
  reason: string;
};
export type PricingTrace = {
  at: string;
  audience: Audience;
  personStatus: string | null;
  baseVersionId: string | null;
  baseUnitCents: number;
  candidates: PricingCandidate[];
  winner: PricingCandidate["source"];
  /** The id behind the winning candidate (price version, person price or promotion). */
  winnerSourceId: string | null;
  isMember: boolean;
  quantity: number;
  vatRatePct: number;
  rounding: "half_up";
};

export type QuoteLine = {
  productId: string;
  priceVersionId: string | null;
  quantity: number;
  unitAmountCents: number;
  discountCents: number;
  lineTotalCents: number;
  vatRatePct: number;
  vatCents: number;
  promotionId: string | null;
  trace: PricingTrace;
};

export type Quote = {
  lines: QuoteLine[];
  subtotalCents: number;
  discountCents: number;
  vatCents: number;
  totalCents: number;
  /** The winning code promotion, if any (`orders.promotion_id`). */
  promotionId: string | null;
  warnings: QuoteWarning[];
};

// ---------------------------------------------------------------------------
// Settings (spec section 2.4)
// ---------------------------------------------------------------------------

const positiveInt = z.number().int().positive();
const nonNegativeInt = z.number().int().nonnegative();

export type CommerceSettingsValue = {
  order_expiry_minutes: number;
  checkout_abandon_minutes: number;
  checkout_expiry_days: number;
  recovery_window_days: number;
  pay_link_days: number;
  bank_transfer_due_days: number;
  draft_expiry_days: number;
  max_voucher_attempts_per_hour: number;
  refund_second_permission_above_cents: number;
  refund_second_permission_after_days: number;
  withdrawal_days: number;
  voucher_expiry_warning_days: number;
  pos_cash_float_cents: number;
  pos_terminals: Array<{ id: string; name: string }>;
  receipt_footer: LocalizedText;
};

export const CommerceSettings: z.ZodType<CommerceSettingsValue> = z.object({
  order_expiry_minutes: positiveInt,
  checkout_abandon_minutes: positiveInt,
  checkout_expiry_days: positiveInt,
  recovery_window_days: positiveInt,
  pay_link_days: positiveInt,
  bank_transfer_due_days: positiveInt,
  draft_expiry_days: positiveInt,
  max_voucher_attempts_per_hour: positiveInt,
  refund_second_permission_above_cents: nonNegativeInt,
  refund_second_permission_after_days: positiveInt,
  withdrawal_days: positiveInt,
  voucher_expiry_warning_days: positiveInt,
  pos_cash_float_cents: nonNegativeInt,
  pos_terminals: z.array(z.object({ id: z.string().min(1), name: z.string().min(1) })),
  receipt_footer: LocalizedTextSchema,
});

export const COMMERCE_SETTINGS_DEFAULTS: CommerceSettingsValue = {
  order_expiry_minutes: 30,
  checkout_abandon_minutes: 60,
  checkout_expiry_days: 30,
  recovery_window_days: 7,
  pay_link_days: 14,
  bank_transfer_due_days: 14,
  draft_expiry_days: 30,
  max_voucher_attempts_per_hour: 5,
  refund_second_permission_above_cents: 50_000,
  refund_second_permission_after_days: 365,
  withdrawal_days: 14,
  voucher_expiry_warning_days: 30,
  pos_cash_float_cents: 15_000,
  pos_terminals: [{ id: "term_xxx", name: "Reception" }],
  receipt_footer: {
    "nl-BE": "Bedankt voor je bezoek aan BEAM. Onze algemene voorwaarden vind je op beam.be/voorwaarden.",
    "fr-BE": "Merci pour votre visite chez BEAM. Nos conditions générales sont disponibles sur beam.be/conditions.",
    en: "Thank you for visiting BEAM. Our terms and conditions are at beam.be/terms.",
  },
};

/** Online payment providers that can serve a channel (rule 29). */
export const ONLINE_PAYMENT_PROVIDERS = ["mollie", "stripe", "viva"] as const;
export type OnlinePaymentProvider = (typeof ONLINE_PAYMENT_PROVIDERS)[number];

export type PaymentProviderByChannelValue = Record<OrderChannel, OnlinePaymentProvider>;
const onlineProvider = z.enum(ONLINE_PAYMENT_PROVIDERS);
export const PaymentProviderByChannel: z.ZodType<PaymentProviderByChannelValue> = z.object({
  portal: onlineProvider,
  site: onlineProvider,
  admin: onlineProvider,
  pos: onlineProvider,
  link: onlineProvider,
  recurring: onlineProvider,
});

export const PAYMENT_PROVIDER_BY_CHANNEL_DEFAULTS: PaymentProviderByChannelValue = {
  portal: "mollie",
  site: "mollie",
  admin: "mollie",
  pos: "mollie",
  link: "mollie",
  recurring: "mollie",
};
