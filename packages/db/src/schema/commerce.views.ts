/**
 * commerce views (commerce spec section 2.3, data model 2.4). Each view is
 * `pgView(name, columns).existing()` with its SQL exported beside it as `<name>Sql`;
 * `pnpm db:views` writes the migration and `createTestDb()` applies the same SQL (DM-1).
 * Sums are cast to `int` so Drizzle reads numbers, not bigint strings.
 */
import { boolean, date, integer, pgView, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { ordersChannel, priceVersionsAudience, productsKind } from "./commerce";

/** The price version valid now per product and audience (highest version wins, rule 5). */
export const vProductCurrentPricesSql = `select distinct on (pv.product_id, pv.audience)
  pv.product_id, pv.audience, pv.id as price_version_id, pv.version, pv.amount_cents, pv.valid_to_at
from price_versions pv
where pv.valid_from_at <= now() and (pv.valid_to_at is null or pv.valid_to_at > now())
order by pv.product_id, pv.audience, pv.version desc`;

export const vProductCurrentPrices = pgView("v_product_current_prices", {
  productId: uuid("product_id").notNull(),
  audience: priceVersionsAudience("audience").notNull(),
  priceVersionId: uuid("price_version_id").notNull(),
  version: integer("version").notNull(),
  amountCents: integer("amount_cents").notNull(),
  validToAt: timestamp("valid_to_at", { withTimezone: true }),
}).existing();

/** Money per order: paid, refunded and still due. */
export const vOrderBalancesSql = `select o.id as order_id, o.total_cents,
  coalesce(sum(p.amount_cents) filter (where p.status in ('paid','partially_refunded','refunded')), 0)::int as paid_cents,
  coalesce(sum(p.refunded_cents), 0)::int as refunded_cents,
  (o.total_cents - coalesce(sum(p.amount_cents) filter (where p.status in ('paid','partially_refunded','refunded')), 0))::int as due_cents
from orders o left join payments p on p.order_id = o.id group by o.id`;

export const vOrderBalances = pgView("v_order_balances", {
  orderId: uuid("order_id").notNull(),
  totalCents: integer("total_cents").notNull(),
  paidCents: integer("paid_cents").notNull(),
  refundedCents: integer("refunded_cents").notNull(),
  dueCents: integer("due_cents").notNull(),
}).existing();

/** The action dashboard feed (ops reads it through `listPaymentAttention`). */
export const vPaymentAttentionSql = `select 'payment_failed'::text as kind, p.id as payment_id, o.id as order_id, o.person_id, p.amount_cents, p.updated_at as since_at
  from payments p join orders o on o.id = p.order_id
  where p.status = 'failed' and p.updated_at > now() - interval '7 days' and o.status not in ('paid','refunded','partially_refunded')
union all
select 'payment_pending_15m', p.id, o.id, o.person_id, p.amount_cents, p.created_at
  from payments p join orders o on o.id = p.order_id
  where p.status in ('open','pending','authorized') and p.provider <> 'bank_transfer' and p.created_at < now() - interval '15 minutes'
union all
select 'bank_transfer_overdue', p.id, o.id, o.person_id, p.amount_cents, p.expires_at
  from payments p join orders o on o.id = p.order_id
  where p.provider = 'bank_transfer' and p.status = 'open' and p.expires_at < now()
union all
select 'refund_failed', r.payment_id, r.order_id, o.person_id, r.amount_cents, r.updated_at
  from refunds r join orders o on o.id = r.order_id where r.status = 'failed'
union all
select 'chargeback', p.id, o.id, o.person_id, p.chargeback_cents, p.updated_at
  from payments p join orders o on o.id = p.order_id where p.chargeback_cents > 0 and p.updated_at > now() - interval '30 days'`;

export const PAYMENT_ATTENTION_KINDS = [
  "payment_failed",
  "payment_pending_15m",
  "bank_transfer_overdue",
  "refund_failed",
  "chargeback",
] as const;
export type PaymentAttentionKind = (typeof PAYMENT_ATTENTION_KINDS)[number];

export const vPaymentAttention = pgView("v_payment_attention", {
  kind: text("kind").$type<PaymentAttentionKind>().notNull(),
  paymentId: uuid("payment_id").notNull(),
  orderId: uuid("order_id").notNull(),
  personId: uuid("person_id"),
  amountCents: integer("amount_cents").notNull(),
  sinceAt: timestamp("since_at", { withTimezone: true }),
}).existing();

/**
 * R3 (commerce-P9): one row per order line of a paid, partially refunded or refunded order, for
 * the management and finance dashboards and ops' read-only `ai` schema. No person columns (the
 * persons join only drops tester orders, like `v_revenue_daily`). `refunded_cents` sums the
 * line's share of the order's `sent` and `refunded` refunds (`refunds.lines`); `is_deferred`
 * marks voucher lines (multi-purpose voucher money is a liability, not revenue, decision 16);
 * `payment_methods` are the providers of the order's settled payments; `partner_company_id` is
 * the partner of the line's (or order's) promotion code (R3 referral attribution).
 */
export const vSalesLinesSql = `select ol.id as order_line_id, o.id as order_id, o.paid_at,
  (o.paid_at at time zone 'Europe/Brussels')::date as business_day_on,
  o.channel, ol.product_kind, ol.product_id, ol.quantity,
  ol.line_total_cents, ol.vat_cents, (ol.line_total_cents - ol.vat_cents)::int as net_cents,
  coalesce(rf.refunded_cents, 0)::int as refunded_cents,
  (ol.product_kind = 'voucher') as is_deferred,
  coalesce(pm.methods, '{}'::text[]) as payment_methods,
  coalesce(ol.promotion_id, o.promotion_id) as promotion_id,
  pr.partner_company_id
from order_lines ol
join orders o on o.id = ol.order_id
left join persons pe on pe.id = o.person_id
left join lateral (
  select sum((l.value->>'amount_cents')::int) as refunded_cents
  from refunds r cross join lateral jsonb_array_elements(r.lines) l
  where r.order_id = o.id and r.status in ('sent', 'refunded') and l.value->>'order_line_id' = ol.id::text
) rf on true
left join lateral (
  select array_agg(distinct p.provider::text order by p.provider::text) as methods
  from payments p
  where p.order_id = o.id and p.status in ('paid', 'partially_refunded', 'refunded')
) pm on true
left join promotions pr on pr.id = coalesce(ol.promotion_id, o.promotion_id)
where o.paid_at is not null and o.status in ('paid', 'partially_refunded', 'refunded')
  and coalesce(pe.is_tester, false) = false`;

export const vSalesLines = pgView("v_sales_lines", {
  orderLineId: uuid("order_line_id").notNull(),
  orderId: uuid("order_id").notNull(),
  paidAt: timestamp("paid_at", { withTimezone: true }).notNull(),
  businessDayOn: date("business_day_on", { mode: "string" }).notNull(),
  channel: ordersChannel("channel").notNull(),
  productKind: productsKind("product_kind").notNull(),
  productId: uuid("product_id").notNull(),
  quantity: integer("quantity").notNull(),
  lineTotalCents: integer("line_total_cents").notNull(),
  vatCents: integer("vat_cents").notNull(),
  netCents: integer("net_cents").notNull(),
  refundedCents: integer("refunded_cents").notNull(),
  isDeferred: boolean("is_deferred").notNull(),
  paymentMethods: text("payment_methods").array().notNull(),
  promotionId: uuid("promotion_id"),
  partnerCompanyId: uuid("partner_company_id"),
}).existing();

/** The columns of `v_sales_lines` (none of them names a person). */
export const SALES_LINES_COLUMNS = [
  "order_line_id",
  "order_id",
  "paid_at",
  "business_day_on",
  "channel",
  "product_kind",
  "product_id",
  "quantity",
  "line_total_cents",
  "vat_cents",
  "net_cents",
  "refunded_cents",
  "is_deferred",
  "payment_methods",
  "promotion_id",
  "partner_company_id",
] as const;

/** R3 (commerce-P9): Lightspeed food-and-drink figures per business day and category. */
export const vLightspeedDailySql = `select business_day_on, category,
  sum(total_cents)::int as total_cents, sum(vat_cents)::int as vat_cents,
  count(distinct receipt_number)::int as receipts, count(*)::int as lines
from lightspeed_sales
group by business_day_on, category`;

export const vLightspeedDaily = pgView("v_lightspeed_daily", {
  businessDayOn: date("business_day_on", { mode: "string" }).notNull(),
  category: text("category").notNull(),
  totalCents: integer("total_cents").notNull(),
  vatCents: integer("vat_cents").notNull(),
  receipts: integer("receipts").notNull(),
  lines: integer("lines").notNull(),
}).existing();
