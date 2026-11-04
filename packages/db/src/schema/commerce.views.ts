/**
 * commerce views (commerce spec section 2.3, data model 2.4). Each view is
 * `pgView(name, columns).existing()` with its SQL exported beside it as `<name>Sql`;
 * `pnpm db:views` writes the migration and `createTestDb()` applies the same SQL (DM-1).
 * Sums are cast to `int` so Drizzle reads numbers, not bigint strings.
 */
import { integer, pgView, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { priceVersionsAudience } from "./commerce";

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
