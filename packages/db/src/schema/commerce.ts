/**
 * commerce schema (commerce spec section 2, data model 1.2.4). Wave 0 (platform-P2) created the
 * contract stubs `products`, `price_versions`, `orders` and `order_lines`; commerce-P1 adds the
 * V1 columns, tables, checks and indexes and the foreign keys to its own tables (expand only:
 * no Wave 0 column is changed). R3 tables (`lightspeed_*`) and `promotions.partner_company_id`
 * come with commerce-P9.
 *
 * Every column that links to `crm.persons` has a `persons.id` foreign key (restrict: persons are
 * anonymised, never deleted), and its table is listed in `apps/web/modules/commerce/privacy.ts`
 * so the GDPR coverage test passes. Columns that point
 * at tables that do not exist yet (`companies`, `ticket_types`, `page_versions`, `memberships`)
 * get their foreign key from the owner in Wave 2.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  smallint,
  text,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sessions, ticketTypes } from "./booking";
import { creditGrants, memberships } from "./credits";
import { companies, persons } from "./crm";
import { emailMessages } from "./email";
import { invoices } from "./finance";
import { pageVersions } from "./site";
import {
  createdAt,
  id,
  localized,
  money,
  timestamps,
  tstz,
  vatRate,
  vatRateCheck,
} from "./_shared";
import { files, users } from "./platform";

export const productsKind = pgEnum("products_kind", [
  "session",
  "night",
  "package",
  "membership",
  "ticket",
  "item",
  "voucher",
]);
export const productsCreditKind = pgEnum("products_credit_kind", [
  "day",
  "night",
  "euro",
]);
export const productsRecurringInterval = pgEnum("products_recurring_interval", [
  "month",
  "year",
]);
export const priceVersionsAudience = pgEnum("price_versions_audience", [
  "public",
  "member",
  "b2b",
]);
export const ordersChannel = pgEnum("orders_channel", [
  "portal",
  "site",
  "admin",
  "pos",
  "link",
  "recurring",
]);
export const ordersStatus = pgEnum("orders_status", [
  "draft",
  "pending_payment",
  "paid",
  "cancelled",
  "expired",
  "refunded",
  "partially_refunded",
]);
export const productsItemCategory = pgEnum("products_item_category", [
  "merchandise",
  "wellness_product",
  "other",
]);
export const promotionsKind = pgEnum("promotions_kind", ["percent", "fixed"]);
export const promotionRedemptionsStatus = pgEnum("promotion_redemptions_status", [
  "reserved",
  "confirmed",
  "released",
]);
export const checkoutsStatus = pgEnum("checkouts_status", [
  "started",
  "abandoned",
  "completed",
  "expired",
]);
export const checkoutsChannel = pgEnum("checkouts_channel", ["portal", "site"]);
export const checkoutsAbandonedReason = pgEnum("checkouts_abandoned_reason", [
  "left",
  "payment_failed",
  "payment_expired",
]);
export const paymentsProvider = pgEnum("payments_provider", [
  "mollie",
  "stripe",
  "viva",
  "cash",
  "terminal",
  "bank_transfer",
  "credit_balance",
]);
export const paymentsSequenceType = pgEnum("payments_sequence_type", [
  "oneoff",
  "first",
  "recurring",
]);
export const paymentsStatus = pgEnum("payments_status", [
  "open",
  "pending",
  "authorized",
  "paid",
  "failed",
  "expired",
  "cancelled",
  "refunded",
  "partially_refunded",
]);
export const refundsStatus = pgEnum("refunds_status", [
  "pending",
  "sent",
  "refunded",
  "failed",
]);
export const refundsCreditAction = pgEnum("refunds_credit_action", [
  "none",
  "release",
  "revoke",
]);
export const mandatesStatus = pgEnum("mandates_status", [
  "pending",
  "valid",
  "invalid",
  "revoked",
]);
export const vouchersStatus = pgEnum("vouchers_status", [
  "pending",
  "active",
  "redeemed",
  "expired",
  "void",
]);
export const posDayClosesStatus = pgEnum("pos_day_closes_status", ["open", "closed"]);
/** R3 (commerce-P9). */
export const lightspeedImportsStatus = pgEnum("lightspeed_imports_status", [
  "uploaded",
  "running",
  "done",
  "failed",
]);

/** `payments.status_history[]` (rule 28). */
export type PaymentStatusHistoryEntry = {
  status: (typeof paymentsStatus.enumValues)[number];
  at: string;
  source: "provider" | "local_timeout" | "staff";
};
/** `refunds.lines[]`. */
export type RefundLineJson = { order_line_id: string; quantity: number; amount_cents: number };
/** `order_lines.data`. */
export type OrderLineData = { start_on?: string; voucher_id?: string; booking_ids?: string[] };
/** `promotions.applies_to`. */
export type PromotionAppliesToJson = {
  product_ids: string[];
  product_kinds: (typeof productsKind.enumValues)[number][];
};
/** `promotions.eligibility`. */
export type PromotionEligibilityJson = {
  segment_id?: string;
  statuses?: ("lead" | "customer" | "member")[];
  channels?: (typeof ordersChannel.enumValues)[number][];
  first_order_only?: boolean;
};

export const products = pgTable(
  "products",
  {
    id: id(),
    kind: productsKind().notNull(),
    sku: text().notNull().unique(),
    name: localized().notNull(),
    description: localized().notNull().default({}),
    vatRatePct: vatRate().notNull(),
    creditKind: productsCreditKind(),
    creditUnits: integer(),
    validityDays: integer(),
    isSharingAllowed: boolean().notNull().default(false),
    maxGuestUsesPerMonth: smallint().notNull().default(2),
    memberDiscountPct: numeric({ precision: 5, scale: 2 }),
    recurringInterval: productsRecurringInterval(),
    includedCreditKind: productsCreditKind(),
    includedCreditUnits: integer(),
    /** Required when kind = `item` (`products_item_category_chk`). */
    itemCategory: productsItemCategory(),
    isCustomAmount: boolean().notNull().default(false),
    minAmountCents: money(),
    maxAmountCents: money(),
    isShopVisible: boolean().notNull().default(false),
    isPosVisible: boolean().notNull().default(true),
    imageFileId: uuid().references(() => files.id),
    isActive: boolean().notNull().default(false),
    sortOrder: integer().notNull().default(0),
    ...timestamps(),
  },
  (t) => [
    index("products_kind_active_idx").on(t.kind, t.isActive, t.sortOrder),
    check("products_sku_chk", sql`${t.sku} ~ '^[A-Z0-9-]{3,32}$'`),
    vatRateCheck("products_vat_rate_chk", t.vatRatePct),
    check(
      "products_credit_units_chk",
      sql`${t.creditUnits} is null or ${t.creditUnits} > 0`,
    ),
    check(
      "products_validity_days_chk",
      sql`${t.validityDays} is null or ${t.validityDays} > 0`,
    ),
    check(
      "products_member_discount_chk",
      sql`${t.memberDiscountPct} is null or ${t.memberDiscountPct} between 0 and 100`,
    ),
    check(
      "products_included_credit_kind_chk",
      sql`${t.includedCreditKind} is null or ${t.includedCreditKind} in ('day', 'night')`,
    ),
    check(
      "products_package_chk",
      sql`${t.kind} <> 'package' or (${t.creditKind} in ('day', 'night') and ${t.creditUnits} is not null and ${t.validityDays} is not null)`,
    ),
    check(
      "products_voucher_chk",
      sql`${t.kind} <> 'voucher' or (${t.creditKind} = 'euro' and ${t.vatRatePct} = 0 and ${t.validityDays} >= 730)`,
    ),
    check(
      "products_membership_chk",
      sql`(${t.kind} = 'membership') = (${t.recurringInterval} is not null) and (${t.includedCreditKind} is null) = (${t.includedCreditUnits} is null)`,
    ),
    check(
      "products_no_credit_chk",
      sql`${t.kind} not in ('session', 'night', 'ticket', 'item') or ${t.creditKind} is null`,
    ),
    check(
      "products_custom_amount_chk",
      sql`not ${t.isCustomAmount} or (${t.kind} = 'voucher' and 500 <= ${t.minAmountCents} and ${t.minAmountCents} <= ${t.maxAmountCents} and ${t.maxAmountCents} <= 100000)`,
    ),
    check(
      "products_item_category_chk",
      sql`${t.kind} <> 'item' or ${t.itemCategory} is not null`,
    ),
  ],
);

/** APPEND. */
export const priceVersions = pgTable(
  "price_versions",
  {
    id: id(),
    productId: uuid()
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    version: integer().notNull(),
    audience: priceVersionsAudience().notNull(),
    amountCents: money().notNull(),
    validFromAt: tstz().notNull().defaultNow(),
    validToAt: tstz(),
    reason: text(),
    createdByUserId: uuid().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("price_versions_product_audience_version_uq").on(
      t.productId,
      t.audience,
      t.version,
    ),
    index("price_versions_product_audience_from_idx").on(
      t.productId,
      t.audience,
      t.validFromAt.desc(),
    ),
    check("price_versions_version_chk", sql`${t.version} > 0`),
    check("price_versions_amount_chk", sql`${t.amountCents} >= 0`),
    check(
      "price_versions_window_chk",
      sql`${t.validToAt} is null or ${t.validToAt} > ${t.validFromAt}`,
    ),
  ],
);

export const orders = pgTable(
  "orders",
  {
    id: id(),
    /**
     * `BO-` + 8 Crockford base32 characters: `newOrderReference()` in commerce code. The default
     * (8 upper-case hex characters, a subset of Crockford) only serves rows inserted by other
     * modules' fixtures.
     */
    reference: text()
      .notNull()
      .unique("orders_reference_unique")
      .default(sql`'BO-' || upper(substr(md5(gen_random_uuid()::text), 1, 8))`),
    personId: uuid().references(() => persons.id, { onDelete: "restrict" }),
    companyId: uuid().references((): AnyPgColumn => companies.id, { onDelete: "set null" }),
    checkoutId: uuid().references((): AnyPgColumn => checkouts.id),
    channel: ordersChannel().notNull(),
    status: ordersStatus().notNull().default("pending_payment"),
    subtotalCents: money().notNull(),
    discountCents: money().notNull().default(0),
    vatCents: money().notNull(),
    totalCents: money().notNull(),
    promotionId: uuid().references((): AnyPgColumn => promotions.id),
    locale: text().notNull(),
    clientKey: uuid().notNull().unique("orders_client_key_unique"),
    expiresAt: tstz(),
    renewalMembershipId: uuid().references((): AnyPgColumn => memberships.id, { onDelete: "set null" }),
    renewalPeriodEndOn: date(),
    termsVersionId: uuid().references((): AnyPgColumn => pageVersions.id, { onDelete: "restrict" }),
    withdrawalUntilAt: tstz(),
    payTokenHash: text().unique("orders_pay_token_hash_unique"),
    payTokenExpiresAt: tstz(),
    isErasedSubject: boolean().notNull().default(false),
    createdByUserId: uuid().references(() => users.id),
    /** Staff note; may hold personal data. */
    note: text(),
    paidAt: tstz(),
    cancelledAt: tstz(),
    version: integer().notNull().default(0),
    ...timestamps(),
  },
  (t) => [
    index("orders_person_created_idx").on(t.personId, t.createdAt.desc()),
    index("orders_pending_expires_idx")
      .on(t.status, t.expiresAt)
      .where(sql`${t.status} = 'pending_payment'`),
    uniqueIndex("orders_renewal_uq")
      .on(t.renewalMembershipId, t.renewalPeriodEndOn)
      .where(
        sql`${t.renewalMembershipId} is not null and ${t.status} in ('pending_payment', 'paid')`,
      ),
    index("orders_company_idx")
      .on(t.companyId)
      .where(sql`${t.companyId} is not null`),
    index("orders_paid_at_idx")
      .on(t.paidAt)
      .where(sql`${t.paidAt} is not null`),
    index("orders_checkout_idx").on(t.checkoutId),
    check("orders_subtotal_chk", sql`${t.subtotalCents} >= 0`),
    check("orders_discount_chk", sql`${t.discountCents} >= 0`),
    check(
      "orders_total_chk",
      sql`${t.totalCents} = ${t.subtotalCents} - ${t.discountCents} and ${t.totalCents} >= 0`,
    ),
    check("orders_locale_chk", sql`${t.locale} in ('nl-BE', 'fr-BE', 'en')`),
    check(
      "orders_person_chk",
      sql`${t.personId} is not null or ${t.companyId} is not null or ${t.channel} = 'pos' or ${t.isErasedSubject}`,
    ),
    check(
      "orders_terms_chk",
      sql`${t.channel} not in ('portal', 'site', 'link') or ${t.status} = 'draft' or ${t.termsVersionId} is not null`,
    ),
    // A renewal order always names its period; the membership link may be nulled (set null)
    // while the order keeps its period (fix-w09-credits-review request, commerce-P9).
    check(
      "orders_renewal_chk",
      sql`${t.renewalMembershipId} is null or ${t.renewalPeriodEndOn} is not null`,
    ),
  ],
);

/** IMMUTABLE and APPEND. Holds no personal data. */
export const orderLines = pgTable(
  "order_lines",
  {
    id: id(),
    orderId: uuid()
      .notNull()
      .references(() => orders.id, { onDelete: "restrict" }),
    lineNo: smallint().notNull(),
    productId: uuid()
      .notNull()
      .references(() => products.id),
    productKind: productsKind().notNull(),
    sku: text().notNull(),
    priceVersionId: uuid().references(() => priceVersions.id),
    description: localized().notNull(),
    quantity: integer().notNull(),
    unitAmountCents: money().notNull(),
    discountCents: money().notNull().default(0),
    lineTotalCents: money().notNull(),
    vatRatePct: vatRate().notNull(),
    vatCents: money().notNull(),
    promotionId: uuid().references((): AnyPgColumn => promotions.id),
    pricingTrace: jsonb().notNull(),
    sessionId: uuid().references(() => sessions.id),
    ticketTypeId: uuid().references((): AnyPgColumn => ticketTypes.id, { onDelete: "restrict" }),
    data: jsonb().$type<OrderLineData>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index("order_lines_order_idx").on(t.orderId),
    unique("order_lines_order_line_no_uq").on(t.orderId, t.lineNo),
    index("order_lines_session_idx")
      .on(t.sessionId)
      .where(sql`${t.sessionId} is not null`),
    check("order_lines_quantity_chk", sql`${t.quantity} between 1 and 50`),
    check("order_lines_unit_amount_chk", sql`${t.unitAmountCents} >= 0`),
    check(
      "order_lines_total_chk",
      sql`${t.lineTotalCents} = ${t.unitAmountCents} * ${t.quantity} - ${t.discountCents} and ${t.lineTotalCents} >= 0`,
    ),
    vatRateCheck("order_lines_vat_rate_chk", t.vatRatePct),
    check(
      "order_lines_session_chk",
      sql`${t.productKind} not in ('session', 'night', 'ticket') or (${t.sessionId} is not null and ${t.quantity} = 1 and (${t.data}->'booking_ids' is null or (jsonb_typeof(${t.data}->'booking_ids') = 'array' and jsonb_array_length(${t.data}->'booking_ids') = 1)))`,
    ),
  ],
);

/** Mutable. Revoking keeps history (`revoked_at`). */
export const personPrices = pgTable(
  "person_prices",
  {
    id: id(),
    /** PII link to `persons.id`. */
    personId: uuid()
      .notNull()
      .references(() => persons.id, { onDelete: "restrict" }),
    productId: uuid()
      .notNull()
      .references(() => products.id),
    amountCents: money().notNull(),
    validFromAt: tstz().notNull().defaultNow(),
    validToAt: tstz(),
    reason: text().notNull(),
    createdByUserId: uuid()
      .notNull()
      .references(() => users.id),
    revokedAt: tstz(),
    ...timestamps(),
  },
  (t) => [
    index("person_prices_person_product_idx").on(t.personId, t.productId),
    check("person_prices_amount_chk", sql`${t.amountCents} >= 0`),
    check(
      "person_prices_window_chk",
      sql`${t.validToAt} is null or ${t.validToAt} > ${t.validFromAt}`,
    ),
  ],
);

/** Mutable until first use (rule 18). */
export const promotions = pgTable(
  "promotions",
  {
    id: id(),
    /** Null = automatic; stored upper case. */
    code: text(),
    name: localized().notNull(),
    kind: promotionsKind().notNull(),
    value: integer().notNull(),
    appliesTo: jsonb()
      .$type<PromotionAppliesToJson>()
      .notNull()
      .default({ product_ids: [], product_kinds: [] }),
    eligibility: jsonb().$type<PromotionEligibilityJson>().notNull().default({}),
    startsAt: tstz().notNull(),
    endsAt: tstz(),
    maxUses: integer(),
    maxUsesPerPerson: integer(),
    usesCount: integer().notNull().default(0),
    /** R3 referral codes: the partner company a code promotion is attributed to (commerce-P9). */
    partnerCompanyId: uuid().references((): AnyPgColumn => companies.id, { onDelete: "set null" }),
    isActive: boolean().notNull().default(true),
    createdByUserId: uuid()
      .notNull()
      .references(() => users.id),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("promotions_code_uq")
      .on(t.code)
      .where(sql`${t.code} is not null`),
    index("promotions_automatic_idx")
      .on(t.isActive, t.startsAt, t.endsAt)
      .where(sql`${t.code} is null`),
    check("promotions_code_chk", sql`${t.code} is null or ${t.code} ~ '^[A-Z0-9]{4,24}$'`),
    check(
      "promotions_value_chk",
      sql`(${t.kind} = 'percent' and ${t.value} between 1 and 100) or (${t.kind} = 'fixed' and ${t.value} > 0)`,
    ),
    check("promotions_window_chk", sql`${t.endsAt} is null or ${t.endsAt} > ${t.startsAt}`),
    check("promotions_max_uses_chk", sql`${t.maxUses} is null or ${t.maxUses} > 0`),
    check(
      "promotions_max_uses_per_person_chk",
      sql`${t.maxUsesPerPerson} is null or ${t.maxUsesPerPerson} > 0`,
    ),
    check("promotions_uses_count_chk", sql`${t.usesCount} >= 0`),
    check(
      "promotions_partner_code_chk",
      sql`${t.partnerCompanyId} is null or ${t.code} is not null`,
    ),
    index("promotions_partner_idx")
      .on(t.partnerCompanyId)
      .where(sql`${t.partnerCompanyId} is not null`),
  ],
);

/** Per-person limits and use counting (rule 19). */
export const promotionRedemptions = pgTable(
  "promotion_redemptions",
  {
    id: id(),
    promotionId: uuid()
      .notNull()
      .references(() => promotions.id),
    orderId: uuid()
      .notNull()
      .references(() => orders.id),
    /** PII link, nulled on erasure. */
    personId: uuid().references(() => persons.id, { onDelete: "restrict" }),
    status: promotionRedemptionsStatus().notNull().default("reserved"),
    ...timestamps(),
  },
  (t) => [
    unique("promotion_redemptions_promotion_order_uq").on(t.promotionId, t.orderId),
    index("promotion_redemptions_person_idx")
      .on(t.promotionId, t.personId)
      .where(sql`${t.status} <> 'released'`),
  ],
);

/** Mutable. One row per checkout session (rules 48 to 51). */
export const checkouts = pgTable(
  "checkouts",
  {
    id: id(),
    /** PII link. */
    personId: uuid().references(() => persons.id, { onDelete: "restrict" }),
    /** PII; lower-cased. */
    email: text(),
    channel: checkoutsChannel().notNull(),
    /** `CartItem[]` without prices (D55). */
    items: jsonb().notNull(),
    promoCode: text(),
    totalCents: money(),
    status: checkoutsStatus().notNull().default("started"),
    locale: text().notNull().default("nl-BE"),
    utm: jsonb().$type<{
      source?: string;
      medium?: string;
      campaign?: string;
      term?: string;
      content?: string;
    }>(),
    landingPath: text(),
    orderId: uuid().references((): AnyPgColumn => orders.id),
    lastActivityAt: tstz().notNull().defaultNow(),
    expiresAt: tstz()
      .notNull()
      .default(sql`now() + interval '30 days'`),
    abandonedAt: tstz(),
    abandonedReason: checkoutsAbandonedReason(),
    resumeTokenHash: text().unique("checkouts_resume_token_hash_unique"),
    recoveryMessageId: uuid().references(() => emailMessages.id),
    recoveredOrderId: uuid().references((): AnyPgColumn => orders.id),
    recoveredAt: tstz(),
    completedAt: tstz(),
    ...timestamps(),
  },
  (t) => [
    index("checkouts_started_activity_idx")
      .on(t.status, t.lastActivityAt)
      .where(sql`${t.status} = 'started'`),
    index("checkouts_person_created_idx").on(t.personId, t.createdAt.desc()),
    index("checkouts_abandoned_idx")
      .on(t.status, t.abandonedAt)
      .where(sql`${t.status} = 'abandoned'`),
    check("checkouts_locale_chk", sql`${t.locale} in ('nl-BE', 'fr-BE', 'en')`),
    check(
      "checkouts_contact_chk",
      sql`${t.personId} is not null or ${t.email} is not null or ${t.status} = 'started'`,
    ),
  ],
);

/** Mutable (Mollie recurring). */
export const mandates = pgTable(
  "mandates",
  {
    id: id(),
    /** PII link, nulled on erasure. */
    personId: uuid().references(() => persons.id, { onDelete: "restrict" }),
    provider: paymentsProvider().notNull(),
    providerMandateId: text().notNull().unique("mandates_provider_mandate_id_unique"),
    providerCustomerId: text().notNull(),
    method: text().notNull(),
    /** PII, e.g. "Visa ending 4242". */
    detailsSummary: text(),
    status: mandatesStatus().notNull().default("pending"),
    revokedAt: tstz(),
    ...timestamps(),
  },
  (t) => [
    index("mandates_person_valid_idx")
      .on(t.personId)
      .where(sql`${t.status} = 'valid'`),
  ],
);

/** The provider's customer object per person (Mollie recurring). */
export const providerCustomers = pgTable(
  "provider_customers",
  {
    id: id(),
    /** PII link. */
    personId: uuid()
      .notNull()
      .references(() => persons.id, { onDelete: "restrict" }),
    provider: paymentsProvider().notNull(),
    providerCustomerId: text().notNull().unique("provider_customers_provider_customer_id_unique"),
    createdAt: createdAt(),
  },
  (t) => [unique("provider_customers_person_provider_uq").on(t.personId, t.provider)],
);

/** Mutable, forward-only status (rule 28). */
export const payments = pgTable(
  "payments",
  {
    id: id(),
    orderId: uuid()
      .notNull()
      .references(() => orders.id),
    provider: paymentsProvider().notNull(),
    providerPaymentId: text().unique("payments_provider_payment_id_unique"),
    method: text(),
    sequenceType: paymentsSequenceType().notNull().default("oneoff"),
    status: paymentsStatus().notNull().default("open"),
    amountCents: money().notNull(),
    refundedCents: money().notNull().default(0),
    chargebackCents: money().notNull().default(0),
    mandateId: uuid().references(() => mandates.id),
    checkoutUrl: text(),
    terminalId: text(),
    cashReceivedCents: money(),
    /** PII: last provider payload; scrubbed after 90 days. */
    raw: jsonb(),
    statusHistory: jsonb().$type<PaymentStatusHistoryEntry[]>().notNull().default([]),
    failedReason: text(),
    expiresAt: tstz(),
    createdByUserId: uuid().references(() => users.id),
    paidAt: tstz(),
    ...timestamps(),
  },
  (t) => [
    index("payments_order_idx").on(t.orderId),
    index("payments_live_idx")
      .on(t.status, t.createdAt)
      .where(sql`${t.status} in ('open', 'pending', 'authorized')`),
    index("payments_failed_idx")
      .on(t.status, t.updatedAt)
      .where(sql`${t.status} = 'failed'`),
    check("payments_amount_chk", sql`${t.amountCents} > 0`),
    check(
      "payments_refunded_chk",
      sql`${t.refundedCents} >= 0 and ${t.refundedCents} <= ${t.amountCents}`,
    ),
    check("payments_chargeback_chk", sql`${t.chargebackCents} >= 0`),
  ],
);

/** Mutable (rules 36 to 40). */
export const refunds = pgTable(
  "refunds",
  {
    id: id(),
    paymentId: uuid()
      .notNull()
      .references(() => payments.id),
    orderId: uuid()
      .notNull()
      .references(() => orders.id),
    amountCents: money().notNull(),
    reason: text().notNull(),
    lines: jsonb().$type<RefundLineJson[]>().notNull(),
    creditAction: refundsCreditAction().notNull(),
    providerRefundId: text().unique("refunds_provider_refund_id_unique"),
    status: refundsStatus().notNull().default("pending"),
    creditNoteId: uuid().references((): AnyPgColumn => invoices.id),
    failedReason: text(),
    /** Null = a system refund (rule 22c late-paid renewals, rule 37a from jobs). */
    createdByUserId: uuid().references(() => users.id),
    ...timestamps(),
  },
  (t) => [
    index("refunds_order_idx").on(t.orderId),
    index("refunds_open_idx")
      .on(t.status)
      .where(sql`${t.status} in ('pending', 'sent', 'failed')`),
    check("refunds_amount_chk", sql`${t.amountCents} > 0`),
  ],
);

/** Gift vouchers (rules 45 to 47a); one row per unit of a voucher line. */
export const vouchers = pgTable(
  "vouchers",
  {
    id: id(),
    orderLineId: uuid()
      .notNull()
      .references(() => orderLines.id),
    /** sha256 of the normalised code; set when activated. */
    codeHash: text().unique("vouchers_code_hash_unique"),
    codeLast4: text(),
    amountCents: money().notNull(),
    /** PII links. */
    purchaserPersonId: uuid().references(() => persons.id, { onDelete: "restrict" }),
    recipientName: text(),
    recipientEmail: text(),
    message: text(),
    deliverOn: date(),
    emailMessageId: uuid().references(() => emailMessages.id),
    status: vouchersStatus().notNull().default("pending"),
    expiresAt: tstz(),
    activatedAt: tstz(),
    redeemedByPersonId: uuid().references(() => persons.id, { onDelete: "restrict" }),
    redeemedAt: tstz(),
    creditGrantId: uuid().references((): AnyPgColumn => creditGrants.id),
    voidedReason: text(),
    ...timestamps(),
  },
  (t) => [
    index("vouchers_active_expires_idx")
      .on(t.status, t.expiresAt)
      .where(sql`${t.status} = 'active'`),
    index("vouchers_order_line_idx").on(t.orderLineId),
    check("vouchers_amount_chk", sql`${t.amountCents} between 500 and 100000`),
    check("vouchers_message_chk", sql`${t.message} is null or char_length(${t.message}) <= 500`),
  ],
);

/** POS day close with cash count (rule 55). No PII. */
export const posDayCloses = pgTable(
  "pos_day_closes",
  {
    id: id(),
    businessDayOn: date().notNull().unique("pos_day_closes_business_day_on_unique"),
    status: posDayClosesStatus().notNull().default("open"),
    expectedCashCents: money().notNull().default(0),
    countedCashCents: money(),
    differenceCents: money(),
    totals: jsonb().$type<Record<string, number>>().notNull().default({}),
    note: text(),
    closedByUserId: uuid().references(() => users.id),
    closedAt: tstz(),
    ...timestamps(),
  },
  (t) => [
    check(
      "pos_day_closes_note_chk",
      sql`${t.differenceCents} is null or ${t.differenceCents} = 0 or ${t.note} is not null`,
    ),
    check(
      "pos_day_closes_closed_chk",
      sql`${t.status} <> 'closed' or (${t.countedCashCents} is not null and ${t.closedAt} is not null)`,
    ),
  ],
);

/** R3 (rule 53): one uploaded Lightspeed sales CSV and its import progress. No PII. */
export const lightspeedImports = pgTable(
  "lightspeed_imports",
  {
    id: id(),
    fileId: uuid()
      .notNull()
      .references(() => files.id),
    status: lightspeedImportsStatus().notNull().default("uploaded"),
    businessFromOn: date({ mode: "string" }),
    businessToOn: date({ mode: "string" }),
    rowsTotal: integer().notNull().default(0),
    rowsImported: integer().notNull().default(0),
    rowsSkipped: integer().notNull().default(0),
    /** `{ row, code, column? }[]`: row numbers count the header as row 1. */
    errors: jsonb().$type<LightspeedImportErrorJson[]>().notNull().default([]),
    createdByUserId: uuid()
      .notNull()
      .references(() => users.id),
    ...timestamps(),
  },
  (t) => [
    index("lightspeed_imports_status_idx").on(t.status, t.createdAt),
    check(
      "lightspeed_imports_counts_chk",
      sql`${t.rowsTotal} >= 0 and ${t.rowsImported} >= 0 and ${t.rowsSkipped} >= 0`,
    ),
  ],
);

/** `lightspeed_imports.errors[]`. */
export type LightspeedImportErrorJson = { row: number; code: string; column?: string };

/** R3, APPEND (rule 53): Lightspeed till lines for reporting only. No PII (`NO_PII_TABLES`). */
export const lightspeedSales = pgTable(
  "lightspeed_sales",
  {
    id: id(),
    importId: uuid()
      .notNull()
      .references(() => lightspeedImports.id),
    /** `<receipt_number>:<line_number>`; a re-upload adds nothing. */
    externalLineKey: text().notNull().unique("lightspeed_sales_external_line_key_unique"),
    businessDayOn: date({ mode: "string" }).notNull(),
    soldAt: tstz().notNull(),
    receiptNumber: text().notNull(),
    productName: text().notNull(),
    category: text().notNull(),
    quantity: numeric({ precision: 10, scale: 3 }).notNull(),
    totalCents: integer().notNull(),
    vatRatePct: numeric({ precision: 4, scale: 2 }).notNull(),
    vatCents: integer().notNull(),
    paymentMethod: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("lightspeed_sales_business_day_idx").on(t.businessDayOn),
    index("lightspeed_sales_import_idx").on(t.importId),
  ],
);
