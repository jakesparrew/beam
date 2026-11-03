/**
 * commerce contract stubs created by Wave 0 on behalf of commerce (platform-P2): `products`,
 * `price_versions`, `orders` and `order_lines` with their architecture columns (data model
 * 1.2.4). commerce takes the file over and only adds columns, tables and the foreign keys to
 * its own Wave 1 tables (expand only).
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  smallint,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sessions } from "./booking";
import { persons } from "./crm";
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
import { users } from "./platform";

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
    personId: uuid().references(() => persons.id, { onDelete: "restrict" }),
    // FKs to companies, checkouts and promotions are added by their owners (Wave 1).
    companyId: uuid(),
    checkoutId: uuid(),
    channel: ordersChannel().notNull(),
    status: ordersStatus().notNull().default("pending_payment"),
    subtotalCents: money().notNull(),
    discountCents: money().notNull().default(0),
    vatCents: money().notNull(),
    totalCents: money().notNull(),
    promotionId: uuid(),
    locale: text().notNull(),
    clientKey: uuid().notNull().unique("orders_client_key_unique"),
    paidAt: tstz(),
    cancelledAt: tstz(),
    version: integer().notNull().default(0),
    ...timestamps(),
  },
  (t) => [
    index("orders_person_created_idx").on(t.personId, t.createdAt.desc()),
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
    productId: uuid()
      .notNull()
      .references(() => products.id),
    productKind: productsKind().notNull(),
    priceVersionId: uuid().references(() => priceVersions.id),
    description: localized().notNull(),
    quantity: integer().notNull(),
    unitAmountCents: money().notNull(),
    discountCents: money().notNull().default(0),
    lineTotalCents: money().notNull(),
    vatRatePct: vatRate().notNull(),
    vatCents: money().notNull(),
    // FKs to promotions and ticket_types are added by their owners (Wave 1).
    promotionId: uuid(),
    pricingTrace: jsonb().notNull(),
    sessionId: uuid().references(() => sessions.id),
    ticketTypeId: uuid(),
    createdAt: createdAt(),
  },
  (t) => [
    index("order_lines_order_idx").on(t.orderId),
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
  ],
);
