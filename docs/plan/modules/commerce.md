# Module spec: commerce (catalogue, pricing, checkout, payments and front desk)

Owner paths: `packages/db/src/schema/commerce.ts`, `packages/db/src/schema/commerce.views.ts`, `packages/core/src/commerce/`, `packages/integrations/src/payments/` (adapters beside the Wave 0 interface and fake), `apps/web/modules/commerce/`, `apps/web/app/(admin)/admin/{products,orders,pos}/`, `apps/web/app/[locale]/(portal)/account/{shop,checkout}/`, `apps/web/app/[locale]/(site)/{checkout,pay,gift}/`, `apps/web/app/api/webhooks/mollie/`, `packages/email/src/templates/commerce/`, `packages/core/src/i18n/messages/*/commerce.json`, `packages/db/src/seed/commerce.ts`, `e2e/commerce.spec.ts`.

Blueprint sections: 13 (payments), 14 (point of sale), 45 (promotions), 46 (pricing), 47 (abandoned checkout), plus requirements found in 5 (timeline: purchases, promotions used), 7 and 8 (pricing of sessions and nights), 10 (portal purchases), 11 and 12 (package and membership sales), 15 (ticket prices, member and promotional pricing), 21 and 31 (abandoned checkout sequence), 38 (failed payments on the action dashboard), 39 and 43 (sales and payment-method reporting), 44 (referral incentives), 53 (Lightspeed history), 56 (discount applied, refund issued in the audit log), 62 and 63 (payment data retention), 76 (pay, member discount, reporting acceptance tests).

## 1. Purpose and release mapping

Commerce turns "I want this" into a paid, VAT-correct, immutable order. It owns the catalogue, the price history, promotions, the pure `quote()`, checkout, orders, payments through `PaymentProvider`, refunds, mandates, gift vouchers, the reception POS and abandoned-checkout detection. When a payment is paid it orchestrates credits, booking, finance and email through their `api.ts` in one transaction. It never stores identity (that is `crm.persons`), credit balances (that is `credits`) or invoices (that is `finance`).

| Release | What commerce ships |
| --- | --- |
| **V1 (weeks 1-6)** | Products of all seven kinds with VAT, credit kind and units, validity, sharing defaults, member discount and recurring interval. Append-only `price_versions` per audience (`public`, `member`, `b2b`) with validity windows (time-limited pricing). `person_prices`. Promotions (percent, fixed, code or automatic, eligibility, dates, max uses, per-person limits). Pure `quote()` with `pricing_trace`. Gift vouchers (kind `voucher`, euro credits, codes, redemption). Portal shop and checkout, site checkout, BEAM-hosted pay page for payment links. Orders, immutable order lines, `client_key`. `PaymentProvider` with the Mollie adapter (Bancontact, cards, recurring mandates, terminal, refunds) and Stripe and Viva stub adapters, chosen per channel. `/api/webhooks/mollie`, `payments.sync`, forward-only payment state machine, the paid transaction, `payments.scan_expired`. Refunds with credit notes and ledger release or revoke. Failed-payment handling and the action-dashboard feed. Checkout tracking and abandoned detection every 10 minutes with `checkout.abandoned` events (the recovery sequence stays inactive). Staff payment links. Front-desk POS (terminal, cash, bank transfer, voucher redemption, PDF receipts). Admin screens for products, prices, promotions, orders, refunds and POS. B2B price versions and staff orders for a company. |
| **Release 2 (weeks 9-10)** | Abandoned checkout recovery: resume links, recovery attribution (`recovered_order_id`, recovery message), recovery report (abandoned, recovered, recovery revenue) and the switch that activates the seeded `abandoned-checkout` sequence (flag `ff_commerce_checkout_recovery`). Ticket checkout with several ticket types per event in one order (events and ticketing extensions). |
| **Release 3 (weeks 11-12)** | Nightly import of Lightspeed food-and-drink sales CSV for reporting. Referral and partner promotion codes (`promotions.partner_company_id`) with partner revenue attribution. Sales and payment-method views for the management and finance dashboards (`v_sales_lines`, `v_lightspeed_daily`). |
| **Release 4 (weeks 13-14)** | No new commerce features. `v_sales_lines` (defined in R3) is exposed by ops in the read-only `ai` schema for natural-language questions; churn and repurchase indicators are ops. |
| **Later (out of scope)** | Stock levels, inventory adjustments, low-stock warnings and supplier data (blueprint 14 "if physical inventory becomes relevant"); a certified cash register (GKS) for food and drink, which stays on Lightspeed; selling food and drink in the platform; company-funded employee credit wallets; Apple Pay or wallet-specific flows beyond what Mollie Checkout offers; multi-currency. |

## 2. Domain model

All tables live in `packages/db/src/schema/commerce.ts`, views in `commerce.views.ts`. Conventions from the architecture apply: `id uuid pk default gen_random_uuid()`, `created_at timestamptz not null default now()`, `updated_at timestamptz not null default now()` on mutable tables, enums `pgEnum('<table>_<column>')`, money integer cents EUR, `vat_rate_pct numeric(4,2)` in {0, 6, 12, 21}, `LocalizedText` jsonb. Wave 0 created stubs of `products`, `price_versions`, `orders`, `order_lines`; commerce-P1 only adds columns to them, never changes existing ones. "PII" marks a column with personal data (registered in `privacy.ts`); commerce owns no sensitive (Article 9) columns.

### 2.1 Enums

| Enum | Values |
| --- | --- |
| `products_kind` | `session`, `night`, `package`, `membership`, `ticket`, `item`, `voucher` |
| `products_credit_kind` | `day`, `night`, `euro` |
| `products_recurring_interval` | `month`, `year` |
| `products_item_category` | `merchandise`, `wellness_product`, `other` (no food or drink value exists, by design) |
| `price_versions_audience` | `public`, `member`, `b2b` |
| `promotions_kind` | `percent`, `fixed` |
| `checkouts_status` | `started`, `abandoned`, `completed`, `expired` |
| `checkouts_channel` | `portal`, `site` |
| `checkouts_abandoned_reason` | `left`, `payment_failed`, `payment_expired` |
| `orders_channel` | `portal`, `site`, `admin`, `pos`, `link`, `recurring` |
| `orders_status` | `draft`, `pending_payment`, `paid`, `cancelled`, `expired`, `refunded`, `partially_refunded` |
| `payments_provider` | `mollie`, `stripe`, `viva`, `cash`, `terminal`, `bank_transfer`, `credit_balance` (addition) |
| `payments_sequence_type` | `oneoff`, `first`, `recurring` |
| `payments_status` | `open`, `pending`, `authorized`, `paid`, `failed`, `expired`, `cancelled`, `refunded`, `partially_refunded` |
| `refunds_status` | `pending`, `sent`, `refunded`, `failed` |
| `refunds_credit_action` | `none`, `release`, `revoke` |
| `mandates_status` | `pending`, `valid`, `invalid`, `revoked` |
| `promotion_redemptions_status` | `reserved`, `confirmed`, `released` |
| `vouchers_status` | `pending`, `active`, `redeemed`, `expired`, `void` |
| `lightspeed_imports_status` (R3) | `uploaded`, `running`, `done`, `failed` |

### 2.2 Tables

**`products`** (mutable)

| Column | Type | Null | Default / check |
| --- | --- | --- | --- |
| id | uuid | no | pk |
| kind | products_kind | no | |
| sku | text | no | unique; check `sku ~ '^[A-Z0-9-]{3,32}$'` |
| name | jsonb LocalizedText | no | |
| description | jsonb LocalizedText | no | `'{}'` |
| vat_rate_pct | numeric(4,2) | no | check in (0, 6, 12, 21) |
| credit_kind | products_credit_kind | yes | |
| credit_units | integer | yes | check `> 0` when set |
| validity_days | integer | yes | check `> 0` when set |
| is_sharing_allowed | boolean | no | false |
| max_guest_uses_per_month | smallint | no | 2 |
| member_discount_pct | numeric(5,2) | yes | check between 0 and 100 |
| recurring_interval | products_recurring_interval | yes | |
| included_credit_kind | products_credit_kind | yes | check in (`day`, `night`) |
| included_credit_units | integer | yes | |
| item_category | products_item_category | yes | required when kind = `item` (addition) |
| is_custom_amount | boolean | no | false; vouchers only (addition) |
| min_amount_cents, max_amount_cents | integer | yes | required when `is_custom_amount` (addition) |
| is_shop_visible | boolean | no | false (portal and site shop) (addition) |
| is_pos_visible | boolean | no | true (addition) |
| image_file_id | uuid -> files.id | yes | (addition) |
| is_active | boolean | no | false |
| sort_order | integer | no | 0 |
| created_at, updated_at | timestamptz | no | now() |

Check constraints (one named check per rule):
- `products_package_chk`: kind = `package` implies credit_kind in (`day`,`night`) and credit_units and validity_days not null. One credit kind and one VAT rate per package follows from the single columns.
- `products_voucher_chk`: kind = `voucher` implies credit_kind = `euro`, vat_rate_pct = 0, validity_days >= 730.
- `products_membership_chk`: kind = `membership` iff recurring_interval is not null; included_credit_kind and included_credit_units are both null or both set.
- `products_no_credit_chk`: kind in (`session`,`night`,`ticket`,`item`) implies credit_kind is null.
- `products_custom_amount_chk`: is_custom_amount implies kind = `voucher` and 500 <= min_amount_cents <= max_amount_cents <= 100000.
Indexes: unique `sku`; `(kind, is_active, sort_order)`.

**`price_versions`** APPEND (in `APPEND_ONLY_TABLES`)

| Column | Type | Null | Default / check |
| --- | --- | --- | --- |
| id | uuid | no | pk |
| product_id | uuid -> products.id | no | on delete restrict |
| version | integer | no | check > 0 |
| audience | price_versions_audience | no | |
| amount_cents | integer | no | check >= 0; VAT included |
| valid_from_at | timestamptz | no | now() |
| valid_to_at | timestamptz | yes | check `valid_to_at > valid_from_at` |
| reason | text | yes | (addition) e.g. "Spring promotion" |
| created_by_user_id | uuid -> users.id | yes | null only for seed and import |
| created_at | timestamptz | no | now() |

Unique `(product_id, audience, version)`. Index `(product_id, audience, valid_from_at desc)`. Invariant: the price for (product, audience, at) is the row with the highest `version` whose window contains `at`; a time-limited price is a higher version with `valid_to_at`, and after it ends the lower open version applies again. Versions are numbered per (product, audience) with `max(version) + 1` under `SELECT ... FROM products WHERE id = $1 FOR UPDATE`.

**`person_prices`** (mutable): id; person_id uuid -> persons.id not null (PII link); product_id -> products.id not null; amount_cents integer not null check >= 0; valid_from_at timestamptz not null default now(); valid_to_at timestamptz null; reason text not null; created_by_user_id -> users.id not null; revoked_at timestamptz null (addition: revoking keeps history); created_at, updated_at. Index `(person_id, product_id)`.

**`promotions`** (mutable until first use, see rule 3.18)

| Column | Type | Null | Default / check |
| --- | --- | --- | --- |
| id | uuid | no | pk |
| code | text | yes | null = automatic; check `code ~ '^[A-Z0-9]{4,24}$'` (stored upper case) |
| name | jsonb LocalizedText | no | shown on lines and receipts (addition) |
| kind | promotions_kind | no | |
| value | integer | no | percent: 1-100; fixed: cents > 0 (check per kind) |
| applies_to | jsonb | no | `{"product_ids":[],"product_kinds":[]}`; both empty = all kinds except `voucher` and `membership` |
| eligibility | jsonb | no | `{}`; shape `{segment_id?, statuses?: ("lead"\|"customer"\|"member")[], channels?: orders_channel[], first_order_only?: boolean}` |
| starts_at | timestamptz | no | |
| ends_at | timestamptz | yes | check > starts_at |
| max_uses | integer | yes | check > 0 |
| max_uses_per_person | integer | yes | check > 0 |
| uses_count | integer | no | 0; check `uses_count >= 0 and (max_uses is null or uses_count <= max_uses)` |
| partner_company_id | uuid -> companies.id | yes | R3 addition, referral codes |
| is_active | boolean | no | true |
| created_by_user_id | uuid -> users.id | no | |
| created_at, updated_at | timestamptz | no | now() |

Partial unique index `promotions_code_uq` on `code` where `code is not null`. Index `(is_active, starts_at, ends_at)` where `code is null` (automatic lookup).

**`promotion_redemptions`** (addition; needed for per-person limits): id; promotion_id -> promotions.id not null; order_id -> orders.id not null; person_id -> persons.id null (PII link, nulled on erasure); status promotion_redemptions_status not null default `reserved`; created_at, updated_at. Unique `(promotion_id, order_id)`. Index `(promotion_id, person_id) where status <> 'released'`.

**`checkouts`** (mutable)

| Column | Type | Null | Default / check |
| --- | --- | --- | --- |
| id | uuid | no | pk |
| person_id | uuid -> persons.id | yes | PII link |
| email | text | yes | PII; lower-cased |
| channel | checkouts_channel | no | (addition) |
| items | jsonb | no | `CartItem[]` (see 4.1) |
| promo_code | text | yes | (addition) |
| total_cents | integer | yes | last quoted total (addition) |
| status | checkouts_status | no | `started` |
| locale | text | no | `nl-BE`, check in the three locales |
| utm | jsonb | yes | `{source, medium, campaign, term, content}` |
| order_id | uuid -> orders.id | yes | latest order made from it (addition) |
| last_activity_at | timestamptz | no | now() (addition) |
| expires_at | timestamptz | no | created_at + 30 days |
| abandoned_at | timestamptz | yes | |
| abandoned_reason | checkouts_abandoned_reason | yes | (addition) |
| resume_token_hash | text | yes | unique; sha256 (R2 addition) |
| recovery_message_id | uuid -> email_messages.id | yes | R2 |
| recovered_order_id | uuid -> orders.id | yes | R2 |
| recovered_at | timestamptz | yes | R2 (addition) |
| completed_at | timestamptz | yes | (addition) |
| created_at, updated_at | timestamptz | no | now() |

Indexes: `(status, last_activity_at) where status = 'started'`; `(person_id, created_at desc)`; `(status, abandoned_at) where status = 'abandoned'`. Check: `person_id is not null or email is not null or status = 'started'`.

**`orders`** (mutable through the state machine only)

| Column | Type | Null | Default / check |
| --- | --- | --- | --- |
| id | uuid | no | pk |
| reference | text | no | unique; `BO-` + 8 Crockford base32 characters, the customer-facing transaction reference (addition) |
| person_id | uuid -> persons.id | yes | PII link; null only for anonymous POS sales or after erasure |
| company_id | uuid -> companies.id | yes | set for B2B orders (audience `b2b`) |
| checkout_id | uuid -> checkouts.id | yes | |
| channel | orders_channel | no | |
| status | orders_status | no | `pending_payment` |
| subtotal_cents | integer | no | sum of `unit_amount_cents * quantity`; check >= 0 |
| discount_cents | integer | no | 0; check >= 0 |
| vat_cents | integer | no | sum of line VAT |
| total_cents | integer | no | check `total_cents = subtotal_cents - discount_cents and total_cents >= 0` |
| promotion_id | uuid -> promotions.id | yes | the winning code promotion, if any |
| locale | text | no | check in the three locales |
| client_key | uuid | no | unique; generated by the form, against double submit |
| expires_at | timestamptz | yes | pending orders: now() + 30 min (addition) |
| pay_token_hash | text | yes | unique; payment link token sha256 (addition) |
| pay_token_expires_at | timestamptz | yes | (addition) |
| is_erased_subject | boolean | no | false (addition, set by erasure) |
| created_by_user_id | uuid -> users.id | yes | staff for `admin`, `pos`, `link` |
| note | text | yes | staff note, PII-capable |
| paid_at, cancelled_at | timestamptz | yes | |
| version | integer | no | 0; incremented on each status change |
| created_at, updated_at | timestamptz | no | now() |

Checks: `orders_person_chk`: `person_id is not null or channel = 'pos' or is_erased_subject`. Indexes: `(person_id, created_at desc)`; `(status, expires_at) where status = 'pending_payment'`; `(company_id) where company_id is not null`; `(paid_at) where paid_at is not null`; `(checkout_id)`.

**`order_lines`** IMMUTABLE (in `APPEND_ONLY_TABLES`; holds no PII)

| Column | Type | Null | Default / check |
| --- | --- | --- | --- |
| id | uuid | no | pk |
| order_id | uuid -> orders.id | no | on delete restrict |
| line_no | smallint | no | unique with order_id (addition) |
| product_id | uuid -> products.id | no | |
| product_kind | products_kind | no | snapshot (addition) |
| sku | text | no | snapshot (addition) |
| price_version_id | uuid -> price_versions.id | yes | null only for custom-amount vouchers |
| description | jsonb LocalizedText | no | product name snapshot, plus session date for session lines |
| quantity | integer | no | check between 1 and 50 |
| unit_amount_cents | integer | no | list unit price of the audience, check >= 0 |
| discount_cents | integer | no | 0; total line discount |
| line_total_cents | integer | no | check `= unit_amount_cents * quantity - discount_cents` and >= 0 |
| vat_rate_pct | numeric(4,2) | no | copied from product |
| vat_cents | integer | no | `round_half_up(line_total * rate / (100 + rate))` |
| promotion_id | uuid -> promotions.id | yes | set when a promotion won on this line |
| pricing_trace | jsonb | no | `PricingTrace` (section 4.1) |
| session_id | uuid -> sessions.id | yes | session, night and ticket lines |
| ticket_type_id | uuid -> ticket_types.id | yes | |
| options | jsonb | no | `{}`; `{starts_on?: "YYYY-MM-DD", voucher_id?: uuid, credit_units?: int}` (addition) |
| created_at | timestamptz | no | now() |

Check `order_lines_session_chk`: product_kind in (`session`,`night`,`ticket`) implies session_id not null.

**`payments`** (mutable, forward-only status)

| Column | Type | Null | Default / check |
| --- | --- | --- | --- |
| id | uuid | no | pk |
| order_id | uuid -> orders.id | no | |
| provider | payments_provider | no | |
| provider_payment_id | text | yes | unique; `tr_...` for Mollie; null for cash, credit_balance and bank_transfer |
| method | text | yes | `bancontact`, `creditcard`, `kbc`, `belfius`, `ideal`, `paypal`, `pointofsale`, `cash`, `banktransfer`, `credit_balance` |
| sequence_type | payments_sequence_type | no | `oneoff` (addition) |
| status | payments_status | no | `open` |
| amount_cents | integer | no | check > 0 |
| refunded_cents | integer | no | 0; check `<= amount_cents` (addition) |
| chargeback_cents | integer | no | 0 (addition) |
| mandate_id | uuid -> mandates.id | yes | |
| checkout_url | text | yes | provider hosted page |
| terminal_id | text | yes | POS terminal (addition) |
| cash_received_cents | integer | yes | POS cash, for change (addition) |
| raw | jsonb | yes | PII: last provider payload (may hold consumer name and IBAN); scrubbed after 90 days |
| status_history | jsonb | no | `[]`; `[{status, at, source: "provider"\|"local_timeout"\|"staff"}]` |
| failed_reason | text | yes | (addition) |
| expires_at | timestamptz | yes | (addition) |
| created_by_user_id | uuid -> users.id | yes | |
| paid_at | timestamptz | yes | |
| created_at, updated_at | timestamptz | no | now() |

Indexes: `(order_id)`; `(status, created_at) where status in ('open','pending','authorized')`; `(status, updated_at) where status = 'failed'`.

**`refunds`** (mutable): id; payment_id -> payments.id not null; order_id -> orders.id not null (addition); amount_cents integer not null check > 0; reason text not null; lines jsonb not null `[{order_line_id, quantity, amount_cents}]` (addition); credit_action refunds_credit_action not null (addition); provider_refund_id text null unique; status refunds_status not null default `pending`; credit_note_id uuid -> invoices.id null; failed_reason text null; created_by_user_id -> users.id not null; created_at, updated_at. Index `(order_id)`, `(status) where status in ('pending','sent','failed')`.

**`mandates`** (mutable): id; person_id -> persons.id null (PII link, nulled on erasure); provider payments_provider not null; provider_mandate_id text not null unique; provider_customer_id text not null (addition); method text not null (`creditcard`, `directdebit`); details_summary text null (PII, e.g. "Visa ending 4242"); status mandates_status not null default `pending`; revoked_at timestamptz null; created_at, updated_at. Index `(person_id) where status = 'valid'`.

**`provider_customers`** (addition; Mollie recurring needs a customer object): id; person_id -> persons.id not null; provider payments_provider not null; provider_customer_id text not null unique; created_at. Unique `(person_id, provider)`.

**`vouchers`** (addition, mutable)

| Column | Type | Null | Default / check |
| --- | --- | --- | --- |
| id | uuid | no | pk |
| order_line_id | uuid -> order_lines.id | no | |
| code_hash | text | yes | unique; sha256 of the normalised code; set when activated |
| code_last4 | text | yes | shown to staff |
| amount_cents | integer | no | check between 500 and 100000 |
| purchaser_person_id | uuid -> persons.id | yes | PII link |
| recipient_name | text | yes | PII |
| recipient_email | text | yes | PII |
| message | text | yes | PII, max 500 chars |
| status | vouchers_status | no | `pending` |
| expires_at | timestamptz | yes | activated_at + product.validity_days |
| activated_at | timestamptz | yes | |
| redeemed_by_person_id | uuid -> persons.id | yes | PII link |
| redeemed_at | timestamptz | yes | |
| credit_grant_id | uuid -> credit_grants.id | yes | the euro grant created on redemption |
| failed_attempts | smallint | no | 0 |
| created_at, updated_at | timestamptz | no | now() |

**`lightspeed_imports`** (R3, addition): id; file_id -> files.id not null; status lightspeed_imports_status not null default `uploaded`; business_from_on date null; business_to_on date null; rows_total, rows_imported, rows_skipped integer not null default 0; errors jsonb not null default `[]`; created_by_user_id -> users.id not null; created_at, updated_at.

**`lightspeed_sales`** (R3, addition, APPEND; no PII; registered in `NO_PII_TABLES`): id; import_id -> lightspeed_imports.id not null; external_line_key text not null unique (`<receipt_number>:<line_number>`); business_day_on date not null; sold_at timestamptz not null; receipt_number text not null; product_name text not null; category text not null; quantity numeric(10,3) not null; total_cents integer not null; vat_rate_pct numeric(4,2) not null; vat_cents integer not null; payment_method text not null; created_at. Index `(business_day_on)`.

### 2.3 Views (`commerce.views.ts`, Drizzle `pgView`)

```sql
-- current price per product and audience
create view v_product_current_prices as
select distinct on (pv.product_id, pv.audience)
  pv.product_id, pv.audience, pv.id as price_version_id, pv.version, pv.amount_cents, pv.valid_to_at
from price_versions pv
where pv.valid_from_at <= now() and (pv.valid_to_at is null or pv.valid_to_at > now())
order by pv.product_id, pv.audience, pv.version desc;

-- money per order
create view v_order_balances as
select o.id as order_id, o.total_cents,
  coalesce(sum(p.amount_cents) filter (where p.status in ('paid','partially_refunded','refunded')), 0) as paid_cents,
  coalesce(sum(p.refunded_cents), 0) as refunded_cents,
  o.total_cents - coalesce(sum(p.amount_cents) filter (where p.status in ('paid','partially_refunded','refunded')), 0) as due_cents
from orders o left join payments p on p.order_id = o.id group by o.id;

-- action dashboard feed (ops reads it through listPaymentAttention)
create view v_payment_attention as
select 'payment_failed' as kind, p.id as payment_id, o.id as order_id, o.person_id, p.amount_cents, p.updated_at as since_at
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
  from payments p join orders o on o.id = p.order_id where p.chargeback_cents > 0 and p.updated_at > now() - interval '30 days';
```

- `v_checkout_recovery` (R2): one row per checkout with `status`, `abandoned_at`, `abandoned_reason`, `had_recovery_message` (`recovery_message_id is not null`), `is_recovered` (`recovered_order_id is not null`), `recovery_revenue_cents` (the recovered order's `total_cents`), `recovered_at`, `channel`, `utm->>'campaign'`. Ops' `v_abandoned_checkouts` selects from it.
- `v_sales_lines` (R3, defined in commerce-P9): one row per order line of a paid, partially refunded or refunded order: `paid_at`, `business_day_on` (`(paid_at at time zone 'Europe/Brussels')::date`), `channel`, `product_kind`, `product_id`, `line_total_cents`, `vat_cents`, `net_cents`, `refunded_cents` (sum from `refunds.lines`), `is_deferred` (true for `voucher` lines: multi-purpose voucher money is a liability, not revenue), `payment_methods` (array of providers on the order). No person columns, so it can be exposed to the `ai` schema.
- `v_lightspeed_daily` (R3): `business_day_on`, `category`, `sum(total_cents)`, `sum(vat_cents)`, `count(distinct receipt_number)`.

### 2.4 Tables of other modules this module reads or writes

| Table (module) | Access | How |
| --- | --- | --- |
| `persons`, `companies`, `v_person_status` (crm, credits) | read | `crm.findOrCreatePersonByEmail`, `crm.getPersonStatus`, `crm.matchesSegment` |
| `activity_events`, `audit_log`, `jobs`, `settings`, `files`, `webhook_events`, `integration_calls`, `feature_flags` (platform, crm) | write through helpers | `ctx.recordEvent`, `ctx.audit`, `ctx.enqueue`, `platform.receiveWebhook`, `platform.storeFile`, `getSetting` |
| `sessions`, `ticket_types`, `bookings` (booking) | read and write through api | `booking.getAvailability`, `booking.reserveForOrderLine`, `booking.confirmOrderBookings`, `booking.releaseOrderBookings`, `booking.cancelBookingForRefund` |
| `credit_grants`, `credit_entries`, `memberships` (credits) | write through api | `credits.grantCredits`, `credits.consumeCredits`, `credits.releaseCredits`, `credits.revokeGrantRemainder`, `credits.activateMembership`, `credits.applyRenewalPayment`, `credits.applyRenewalFailure`, `credits.cancelMembershipForRefund`, `credits.getEuroBalance` |
| `invoices` (finance) | write through api | `finance.issueInvoice`, `finance.issueCreditNote` |
| `email_messages` (email) | write through api, read for recovery | `email.sendTransactional`, `email.findLatestMessage` (R2) |

Settings keys commerce seeds and reads (rows in platform's `settings`): `payment_provider_by_channel` = `{portal:"mollie", site:"mollie", admin:"mollie", pos:"mollie", link:"mollie", recurring:"mollie"}`; `commerce` = `{order_expiry_minutes: 30, checkout_abandon_minutes: 60, checkout_expiry_days: 30, recovery_window_days: 7, pay_link_days: 14, bank_transfer_due_days: 14, max_voucher_attempts_per_hour: 5, pos_terminals: [{id:"term_xxx", name:"Reception"}], receipt_footer: LocalizedText}`.

## 3. Business rules

Catalogue and prices
1. A product can be activated only when `name` (and `description` if `is_shop_visible`) passes `assertComplete(text, ['nl-BE','fr-BE','en'])` and a `public` price version is valid now (custom-amount vouchers excepted). The action fails with the missing locales or `no_price`.
2. A package grants exactly one credit kind at exactly one VAT rate (check constraints). Default VAT: day session products and day packages 21 %, night products and night packages 6 %, memberships 21 %, tickets 21 %, items 21 %, vouchers 0 %. Staff may pick any of 0, 6, 12, 21.
3. Items have an `item_category`; food and drink cannot be modelled (no enum value) and stay on Lightspeed, because on-site food and drink sales need a certified cash register (GKS).
4. Price versions are append-only. "Changing a price" inserts `version + 1`; "ending a time-limited price early" inserts a new version with the base amount valid from now. No update or delete path exists; the trigger rejects both.
5. The price of (product, audience, at) is the highest version whose window contains `at`. If no `member` or `b2b` version is valid, the `public` version is used for that audience.
6. `person_prices` apply only to the named person and product inside their window and when `revoked_at is null`; the latest `valid_from_at` wins.

Quote (pure `quote()` in `packages/core/src/commerce/pricing.ts`)
7. Base unit price = the price version for the order's audience: `b2b` when the order has a `company_id`, else `public`. List price shown on the line is this base.
8. Candidate unit prices per line: (a) base; (b) `member` price version if the person is a member; (c) valid person price; (d) base minus `member_discount_pct` of the product (or the membership's `discount_pct` when the product has none) if the person is a member and the audience is not `b2b`; (e) base minus each applicable promotion (code or automatic). The lowest candidate wins. Discounts never stack.
9. Ties are broken in the order person price, member price version, member discount, automatic promotion, code promotion, so a promotion use is not consumed when it gives nothing extra.
10. Percent discount per unit = `round_half_up(base * pct / 100)`; a fixed promotion takes `value` cents off each unit, capped at the unit price. Line discount = per-unit discount times quantity.
11. VAT per line = `round_half_up(line_total_cents * rate / (100 + rate))`; order totals are sums of lines. Prices are VAT included.
12. Vouchers and memberships are never discounted by member pricing; promotions reach them only when listed explicitly in `applies_to.product_ids`.
13. A code that is unknown, inactive, outside its dates, exhausted, not eligible or not better returns the quote with a warning (`promo_unknown|promo_inactive|promo_expired|promo_exhausted|promo_not_eligible|promo_not_better`) and the order still proceeds without it.
14. `pricing_trace` holds: `at`, audience, base version id and amount, every candidate with its source id, amount and reason, the winner, rounding inputs and the person status used. It is stored verbatim on `order_lines.pricing_trace`.
15. A paid order never changes: lines are immutable and point to the price version used. Later price edits affect only new quotes.
16. The order is priced at creation. A checkout re-quotes on every step; if the total differs from `checkouts.total_cents` the page shows "The price changed" with the new total before the customer can pay.

Promotions
17. Eligibility is evaluated before `quote()` and passed in as a boolean per promotion: active, `starts_at <= now < ends_at`, channel in `eligibility.channels` (when set), person status in `eligibility.statuses` (when set), `crm.matchesSegment(segment_id, person)` (when set), `first_order_only` means no earlier paid order, and per-person count of non-released redemptions below `max_uses_per_person`. Anonymous buyers are eligible only for promotions without segment, status or first-order rules.
18. Once `uses_count > 0`, `kind`, `value` and `applies_to` are locked; only `name`, `ends_at`, `max_uses` (not below `uses_count`), `max_uses_per_person` and `is_active` can change.
19. Creating an order with a winning promotion locks the promotion `FOR UPDATE`, checks `uses_count < max_uses`, increments `uses_count` and inserts a `reserved` redemption. Paid confirms it; expired or cancelled releases it and decrements `uses_count`.

Checkout and orders
20. Every order has a `client_key` from the form. A second submit with the same key returns the existing order and its open `checkout_url` instead of creating anything.
21. A session, night or ticket line reserves capacity through `booking.reserveForOrderLine` in the order transaction (`reserved_until = orders.expires_at`). No capacity means the action returns `conflict` with `sold_out` and nothing is written.
22. Pending orders expire 30 minutes after the last payment was created (`settings.commerce.order_expiry_minutes`). Expiry releases reserved bookings and promotion redemptions and writes `order.expired`.
23. A customer may retry payment on a `pending_payment` order that has not expired; each retry is a new `payments` row. At most one payment per order is non-final at any time.
24. An order with `total_cents = 0` (100 % promotion, person price 0, or fully covered by euro credit) is paid in the creating transaction without a provider call.
25. Euro credit (from vouchers) can pay part or all of an order: a `credit_balance` payment is created and paid in the order transaction through `credits.consumeCredits(kind 'euro', units = cents)`. The rest goes to the provider. If the order expires, the euro credit is released.
26. Portal orders use the logged-in person. Site orders require an email; `crm.findOrCreatePersonByEmail` resolves the person and never overwrites existing names. After payment the site buyer receives a magic-link invitation to the portal.
27. Session and night products are pay-per-visit and always carry a `session_id`; multi-visit bundles are packages.

Payments
28. Status moves forward only: rank `open` 0, `pending` 1, `authorized` 2, then final `paid`, `failed`, `expired`, `cancelled` 3, `partially_refunded` 4, `refunded` 5. `applyProviderStatus()` ignores any transition to an equal or lower rank and appends every applied change to `status_history`. One exception: a payment set to `expired` with source `local_timeout` may still become `paid` when the provider reports paid.
29. The provider is chosen by `settings.payment_provider_by_channel[order.channel]`. Cash, bank transfer and credit balance are local providers and never call out.
30. The webhook body is never trusted: `payments.sync` fetches the payment by id from the provider, and that fetch is the verification.
31. An order becomes `paid` when the sum of paid payments reaches `total_cents`. The paid transaction runs once per order, guarded by `SELECT ... FROM orders WHERE id = $1 FOR UPDATE` and `status = 'pending_payment'`.
32. The paid transaction, in one database transaction: order `paid` with `paid_at`; promotion redemption `confirmed`; per line: package -> `credits.grantCredits` (one grant per quantity, starts at `options.starts_on` or `paid_at`, expires after `validity_days`, sharing from the product); membership -> `credits.activateMembership` (with the mandate when sequence `first`); session, night, ticket -> `booking.confirmOrderBookings`; voucher -> voucher `active` with a new code; item -> nothing. Then `finance.issueInvoice` (skipped when a bank-transfer invoice already exists), `order.paid` and `promotion.redeemed` events, and the jobs `email.send` (order confirmation, key `email:order:<id>:paid`) and, for vouchers, the voucher email.
33. A payment that ends `failed`, `expired` or `cancelled` writes `payment.failed` (with `reason`) on the person's timeline, marks the checkout `abandoned_reason` and shows on the action dashboard feed for 7 days unless the order is paid later.
34. A payment `pending` for more than 15 minutes (not bank transfer) appears on the feed and in the Slack alert of the architecture (High).
35. A chargeback reported by the provider sets `chargeback_cents`, writes `payment.charged_back`, creates a finance task and revokes nothing automatically.

Refunds
36. Refundable amount of an order = paid minus already refunded. A refund is for chosen lines and quantities; the default amount per line is pro rata to unused units; staff with `commerce.refund` may lower it, never raise it above the paid line total.
37. Credit effects: an unused package grant gets `credits.revokeGrantRemainder` (credit action `revoke`); a used package can be refunded only for its remaining units; a booking line cancels the booking through `booking.cancelBookingForRefund`; a membership is cancelled immediately through `credits.cancelMembershipForRefund`; a voucher can be refunded only while `active` and unredeemed, and becomes `void`.
38. A refund goes first back to `credit_balance` payments (restored as euro credit through `credits.releaseCredits`), then to provider payments, largest first. Cash refunds are paid at the counter and are `refunded` at once; bank-transfer refunds are `sent` until staff confirm.
39. Every refund issues a credit note (`finance.issueCreditNote`) in the refund transaction, writes `order.refunded` and an audit row `refund.issued`, and sets the order to `partially_refunded` or `refunded`.
40. A refund above €500 or on an order older than 365 days requires the `owner` or `finance` role; others get `forbidden`.

Payment links, POS and vouchers
41. A payment link is a BEAM-hosted page `/[locale]/pay/<token>` for one `pending_payment` order with `channel = link`. The token is 32 random bytes, stored as sha256, valid 14 days, single order. Opening it after expiry or after payment shows the matching state, never a payment form.
42. POS sales are `channel = pos`. Session, package, membership and ticket sales need a person; item and voucher sales may be anonymous.
43. POS payment methods: terminal (Mollie Terminal API, inline job), cash (paid immediately, `cash_received_cents >= amount`, change shown), bank transfer (invoice issued at once with due date 14 days; credits and bookings are delivered only when the transfer is recorded as paid).
44. A POS receipt PDF (`files.kind = receipt`) is rendered for every paid POS order and can be printed or emailed.
45. Voucher codes are 12 characters of Crockford base32 in groups of four (`BEAM-XXXX-XXXX-XXXX`), derived as `HMAC-SHA256(VOUCHER_CODE_SECRET, 'voucher:' + voucher_id)` truncated to 60 bits, and stored only as sha256 plus the last four. The voucher email job and the staff "resend voucher" action derive the code again; the plain code is never stored. Redemption grants euro credits of `amount_cents` to the redeemer (one grant, `unit_value_cents = 1`, expiry = voucher expiry) and sets the voucher `redeemed`. A voucher is redeemable once.
46. Vouchers are valid at least 730 days (product check). VAT is not charged on the voucher sale (multi-purpose voucher, usable for 6 % and 21 % services); VAT is charged on the lines bought with the euro credit.
47. Five failed code attempts per person or IP per hour block further attempts for one hour (`rate_limited`).

Abandoned checkout
48. A checkout row is created when the customer opens the checkout step with at least one item; every step updates `last_activity_at`, `items`, `total_cents`.
49. `checkouts.mark_abandoned` (every 10 minutes) sets `abandoned` on `started` checkouts with `last_activity_at` older than 60 minutes and a known person or email, with reason `payment_failed` or `payment_expired` when its last order's payment ended so, else `left`. It writes `checkout.abandoned` (dedupe `checkout:<id>:abandoned`) when a person is known.
50. A checkout becomes `completed` when its order is paid; `expired` 30 days after creation if never completed.
51. (R2) A checkout is recovered when the same person pays an order within 7 days after `abandoned_at` that contains at least one of the checkout's products; `recovered_order_id`, `recovered_at` are set and `checkout.recovered` is written. Recovery revenue is that order's `total_cents`. `recovery_message_id` is the latest `abandoned-checkout` email to the person after `abandoned_at`.
52. (R2) The abandoned-checkout sequence runs only while `ff_commerce_checkout_recovery` is `on`; it is a marketing automation with purpose `newsletter`, so it reaches only people for whom `v_marketing_reachability` is true for that purpose.

Lightspeed (R3)
53. A Lightspeed CSV is imported idempotently: `external_line_key` unique, so a re-upload of the same day adds nothing. Rows are reporting data only; they create no orders, persons or invoices.

## 4. Server surface

### 4.1 Core types (`packages/core/src/commerce/`)

```ts
// schemas.ts
export const CartItem = z.object({
  productId: z.string().uuid(), quantity: z.number().int().min(1).max(50),
  sessionId: z.string().uuid().optional(), ticketTypeId: z.string().uuid().optional(),
  amountCents: z.number().int().optional(),            // custom-amount voucher only
  startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  voucher: z.object({ recipientName: z.string().max(120), recipientEmail: z.string().email().optional(), message: z.string().max(500).optional() }).optional(),
});
export type Audience = 'public' | 'member' | 'b2b';
export type QuoteInput = {
  items: Array<CartItem & { product: QuoteProduct; prices: PriceVersionRow[] }>;
  audience: Audience; personStatus: 'lead' | 'customer' | 'member' | null; isMember: boolean;
  memberDiscountPct: number | null;                    // membership default when the product has none
  personPrices: PersonPriceRow[]; promotions: Array<PromotionRow & { isEligible: boolean }>;
  promoCode: string | null; at: Date;
};
export type PricingCandidate = { source: 'base' | 'member_version' | 'person_price' | 'member_discount' | 'promotion';
  sourceId: string | null; unitCents: number; reason: string };
export type PricingTrace = { at: string; audience: Audience; personStatus: string | null; baseVersionId: string | null;
  baseUnitCents: number; candidates: PricingCandidate[]; winner: PricingCandidate['source']; rounding: 'half_up' };
export type QuoteLine = { productId: string; priceVersionId: string | null; quantity: number; unitAmountCents: number;
  discountCents: number; lineTotalCents: number; vatRatePct: number; vatCents: number; promotionId: string | null; trace: PricingTrace };
export type Quote = { lines: QuoteLine[]; subtotalCents: number; discountCents: number; vatCents: number; totalCents: number;
  promotionId: string | null; warnings: QuoteWarning[] };
export function quote(input: QuoteInput): Quote;                      // pricing.ts, pure
export function vatOf(lineTotalCents: number, ratePct: number): number; // vat.ts
export function nextPaymentStatus(current: PaymentStatus, reported: PaymentStatus, source: StatusSource): PaymentStatus | null; // state-machine.ts, null = ignore
export function refundPlan(input: RefundPlanInput): RefundPlan;          // refunds.ts, pure: amounts per line and per payment, credit actions
export function deriveVoucherCode(secret: string, voucherId: string): Promise<string>;  // vouchers.ts, Web Crypto HMAC
export function normaliseVoucherCode(input: string): string;                 // upper case, strips spaces and dashes, maps O->0, I and L->1
export function parseLightspeedCsv(csv: string): { rows: LightspeedRow[]; errors: RowError[] }; // R3
```

### 4.2 Server actions (`apps/web/modules/commerce/actions.ts`, all through `action()`)

| Action | Audience, permission | Input (Zod summary) | Output | Events / audit |
| --- | --- | --- | --- | --- |
| `createProduct`, `updateProduct` | staff, `pricing.write` | product columns; `name`, `description` LocalizedText | `{productId}` | audit `product.created`, `product.updated` (old and new) |
| `setProductActive` | staff, `pricing.write` | `{productId, isActive}` | `{ok}` | audit `product.activated` / `product.deactivated`; fails with missing locales |
| `addPriceVersion` | staff, `pricing.write` | `{productId, audience, amountCents, validFromAt?, validToAt?, reason?}` | `{priceVersionId, version}` | audit `price.version_added` |
| `setPersonPrice`, `revokePersonPrice` | staff, `pricing.write` | `{personId, productId, amountCents, validFromAt?, validToAt?, reason}` / `{personPriceId}` | `{personPriceId}` | audit `person_price.set` / `.revoked`; event `pricing.person_price_set` |
| `createPromotion`, `updatePromotion` | staff, `pricing.write` | promotion columns, code upper-cased | `{promotionId}` | audit `promotion.created` / `.updated`; locked fields refused with `conflict` |
| `startCheckout` | customer or public | `{channel, items: CartItem[], locale, utm?, email?}` | `{checkoutId, quote}` | event `checkout.started` (when person known) |
| `updateCheckout` | customer or public | `{checkoutId, items?, promoCode?, email?}` | `{quote, priceChanged}` | none |
| `placeOrder` | customer or public | `{checkoutId, clientKey: uuid, useEuroCredit: boolean, acceptTerms: literal(true)}` | `{orderId, redirectUrl}` (provider URL, or the return page when total 0) | runs `payments.create` inline; event `order.placed` not written (timeline gets `order.paid`) |
| `retryPayment` | customer or public (order owner, or pay token) | `{orderId, clientKey}` | `{redirectUrl}` | none |
| `createStaffOrder` | staff, `commerce.sell` | `{personId?, companyId?, items, promoCode?, channel: 'admin', note?}` | `{orderId}` | audit `order.created`; discount override not possible |
| `sendPaymentLink` | staff, `commerce.sell` | `{orderId, email?}` | `{expiresAt}` | enqueues `payments.create_link`; event `payment_link.sent`; audit `payment_link.sent` |
| `cancelOrder` | staff, `commerce.sell` | `{orderId, reason}` | `{ok}` | only `pending_payment`; event `order.cancelled`; audit `order.cancelled` |
| `refundOrder` | staff, `commerce.refund` | `{orderId, lines: [{orderLineId, quantity, amountCents?}], reason: min 5 chars}` | `{refundIds, creditNoteId}` | event `order.refunded`; audit `refund.issued` with amounts |
| `confirmManualRefund` | staff, `commerce.refund` | `{refundId}` | `{ok}` | audit `refund.confirmed` |
| `recordBankTransfer` | staff, `invoices.issue` | `{orderId, paidOn, reference}` | `{ok}` | runs the paid transaction; audit `payment.bank_transfer_recorded` |
| `posSell` | staff, `commerce.sell` | `{personId?, items, promoCode?, method: 'terminal'\|'cash'\|'bank_transfer', terminalId?, cashReceivedCents?, useEuroCredit, clientKey}` | `{orderId, status, changeCents?}` | inline `payments.terminal` for terminal; event `order.paid` (cash); audit `pos.sale` |
| `posCancelTerminal` | staff, `commerce.sell` | `{paymentId}` | `{ok}` | payment `cancelled` (source staff); audit `pos.terminal_cancelled` |
| `redeemVoucher` | customer (portal) or staff `commerce.sell` | `{code, personId?}` | `{grantId, amountCents, expiresAt}` | event `voucher.redeemed`; audit `voucher.redeemed` when staff |
| `resendVoucher` | staff, `commerce.sell` | `{voucherId, email?}` | `{ok}` | enqueues `commerce.issue_voucher_email` with key `voucher-email:<id>:<n>`; audit `voucher.resent` |
| `voidVoucher` | staff, `commerce.refund` | `{voucherId, reason}` | `{ok}` | audit `voucher.voided` |
| `emailReceipt` | staff, `commerce.sell` | `{orderId, email?}` | `{ok}` | enqueues `email.send`; audit `receipt.emailed` |
| `uploadLightspeedCsv` (R3) | staff, `commerce.sell` | `{file: File (csv, max 5 MB)}` | `{importId}` | enqueues `commerce.import_lightspeed`; audit `lightspeed.uploaded` |

Public (unauthenticated) actions are rate limited to 20 per minute per IP, and `placeOrder` to 5 per minute per checkout.

### 4.3 Queries (`queries.ts`)

`listProducts(db, {kind?, activeOnly?, shop?: boolean, pos?: boolean})`, `getProduct(db, id)` with price history per audience, `listPromotions(db, {state: 'active'|'scheduled'|'ended'})`, `getPromotion(db, id)` with redemption counts, `listOrders(db, {status?, channel?, personId?, from?, to?, q? (reference or email), cursor})` (keyset on `created_at, id`, 50 per page), `getOrder(db, id)` with lines, payments, refunds, invoice ids, events, `getOrderStatus(db, orderId, viewer)` (the return page; reads only the database), `listMyOrders(db, personId)`, `getShopCatalogue(db, {personId, locale})` (products with the person's quoted unit price), `getCheckout(db, checkoutId, viewer)`, `getPayOrderByToken(db, token)`, `listPaymentAttention(db, {limit})`, `getPosDaySummary(db, {day})` (totals by method, counts, refunds), `listAbandonedCheckouts(db, {from, to, status})` and `getRecoveryReport(db, {from, to})` (R2), `listLightspeedImports(db)` and `getLightspeedDaily(db, {from, to})` (R3). Staff queries call `requirePermission()` (`commerce.sell` or `pricing.write` or `reports.read` for reads); customer queries filter on `ctx.actor.personId`.

### 4.4 Route handlers

- `POST /api/webhooks/mollie` (`app/api/webhooks/mollie/route.ts`, runtime nodejs): reads form field `id`; checks query `t` equals `MOLLIE_WEBHOOK_SECRET` (constant-time) or a valid `X-Mollie-Signature` through `provider.verifyWebhook`; on failure 401 and a signature-failure counter. Then `platform.receiveWebhook(db, {provider: 'mollie', externalEventId: `${id}:${receivedAtMs}`, payload, job: {kind: 'payments.sync', payload: {providerPaymentId: id}, key: `webhook:mollie:${id}:${receivedAtMs}`}})` and 200 within 2 s. Ids not starting with `tr_` are stored and ignored.
- No other route handlers. Return pages poll through a server action (`getOrderStatus`), not an API route.

### 4.5 Jobs (`jobs.ts`, `defineJob`)

| Kind | Lane, priority | Idempotency key | Payload | Behaviour and retries |
| --- | --- | --- | --- | --- |
| `payments.create` (inline) | fast, 1 | `payment-create:<payment_id>` | `{paymentId}` | `provider.createPayment({amountCents, description: reference, redirectUrl, webhookUrl, method?, customerId?, sequenceType, metadata: {orderId, paymentId}})`; stores `provider_payment_id`, `checkout_url`. Provider 4xx -> `PermanentError`, payment `failed`; 5xx or timeout -> retryable, the action answers "payment service unavailable, try again" |
| `payments.terminal` (inline) | fast, 1 | `payment-terminal:<payment_id>` | `{paymentId, terminalId}` | `provider.createTerminalPayment`; result through the webhook |
| `payments.sync` | fast, 1 | from webhook `webhook:mollie:<id>:<ms>`, from polls `payment-sync:<provider_payment_id>:<minute>` | `{providerPaymentId}` | `getPayment`, `applyProviderStatus`, paid transaction (rule 32), mandate upsert, refunds and chargebacks sync. Retryable 6 attempts; unknown id -> succeeded with `result.ignored` |
| `payments.refund` | fast, 2 | `refund:<refund_id>` | `{refundId}` | `provider.refund({providerPaymentId, amountCents, description})`; refund `sent`; final status from `payments.sync`. 4xx -> refund `failed` (on the feed) |
| `payments.create_link` | fast, 2 | `pay-link:<order_id>:<version>` | `{orderId, email}` | creates the token, sends `commerce.payment-link` with `email.sendTransactional` |
| `payments.charge_recurring` | fast, 2 | `recurring-payment:<payment_id>` (credits' `memberships.charge_renewal` keeps the architecture key `renewal:<membership_id>:<period_end>`) | `{paymentId}` | `provider.createRecurringPayment({customerId, mandateId, amountCents})`; failure -> payment `failed` -> `credits.applyRenewalFailure` |
| `payments.scan_expired` | fast, 3 | `schedule:payments.scan_expired:<minute>` | `{}` | open or pending provider payments older than 30 min: enqueue `payments.sync`; still open after the sync and older than 35 min -> `expired` (`local_timeout`); orders with no live payment and `expires_at < now()` -> `expired` with releases (rule 22) |
| `checkouts.mark_abandoned` | fast, 5 | `schedule:checkouts.mark_abandoned:<minute>` | `{}` | rules 49, 50; R2 also rule 51 attribution; batches of 500 |
| `commerce.render_receipt` | fast, 5 | `receipt:<order_id>` | `{orderId}` | renders the receipt PDF into `files` (kind `receipt`) |
| `commerce.issue_voucher_email` | fast, 2 | `voucher-email:<voucher_id>` | `{voucherId}` | sends `commerce.gift-voucher` to the recipient (or purchaser) with the code derived by `deriveVoucherCode`; PDF voucher attached |
| `commerce.erase_provider_customer` | fast, 5 | `privacy:<request_id>:mollie-customer:<provider_customer_id>` | `{providerCustomerId, mandateIds}` | revokes mandates and deletes the Mollie customer |
| `commerce.import_lightspeed_pending` (R3) | bulk, 9 | `schedule:commerce.import_lightspeed_pending:<minute>` | `{}` | enqueues `commerce.import_lightspeed {importId, offset: 0}` for every `uploaded` import |
| `commerce.import_lightspeed` (R3) | bulk, 9 | `lightspeed:<import_id>:<offset>` | `{importId, offset}` | 1,000 rows per run, self-continues; `on conflict (external_line_key) do nothing` |

Every handler passes the double-run test (`jobs.test.ts`).

### 4.6 Schedules (`schedules.ts`, Europe/Brussels)

`payments.scan_expired` `* * * * *`; `checkouts.mark_abandoned` `*/10 * * * *`; `commerce.import_lightspeed_pending` (R3) `40 2 * * *`.

### 4.7 Activity event kinds (`events.ts`)

`checkout.started`, `checkout.abandoned`, `checkout.recovered` (R2), `order.paid` (`{orderId, reference, totalCents, channel, lines: [{productId, kind, quantity}]}`), `order.expired`, `order.cancelled`, `order.refunded` (`{orderId, amountCents}`), `payment.failed` (`{orderId, reason}`), `payment.charged_back`, `promotion.redeemed` (`{promotionId, code, discountCents}`), `voucher.redeemed`, `payment_link.sent`, `pricing.person_price_set`. All non-sensitive; dedupe keys `<noun>:<id>:<kind>`.

### 4.8 Cross-module API (`apps/web/modules/commerce/api.ts`)

```ts
export { quote } from '@beam/core/commerce';
export function getQuote(db: DbOrTx, args: { personId: string | null; companyId?: string | null; items: CartItem[];
  promoCode?: string | null; channel: OrderChannel; at?: Date }): Promise<Quote>;
export function createOrder(tx: Tx, ctx: Ctx, input: { personId: string | null; companyId?: string | null;
  channel: OrderChannel; items: CartItem[]; promoCode?: string | null; clientKey: string; checkoutId?: string;
  locale: Locale; useEuroCredit?: boolean; note?: string }): Promise<{ orderId: string; reference: string;
  lineIds: string[]; totalCents: number; status: OrderStatus; isExisting: boolean }>;
export function startPayment(tx: Tx, ctx: Ctx, input: { orderId: string; returnPath: string }): Promise<{ paymentId: string | null; redirectUrl: string }>;
export function getOrderStatus(db: DbOrTx, orderId: string): Promise<{ status: OrderStatus; paidAt: Date | null; dueCents: number }>;
export function createRecurringCharge(tx: Tx, ctx: Ctx, input: { membershipId: string; personId: string;
  productId: string; mandateId: string; periodEndOn: string }): Promise<{ orderId: string; paymentId: string }>;
export function getActiveMandate(db: DbOrTx, personId: string): Promise<{ mandateId: string; method: string; summary: string | null } | null>;
export function recordBankTransferPaid(tx: Tx, ctx: Ctx, input: { orderId: string; paidOn: string; reference: string }): Promise<void>;
export function listPaymentAttention(db: DbOrTx, opts: { limit: number }): Promise<PaymentAttentionItem[]>;
export function getPersonCommerceSummary(db: DbOrTx, personId: string): Promise<{ paidOrders: number; paidCents: number;
  lastPaidAt: Date | null; openOrders: number; activeVouchers: number }>;
export function listOrdersForPerson(db: DbOrTx, personId: string, opts: { limit: number }): Promise<OrderSummary[]>;
export function getProductPrice(db: DbOrTx, productId: string, audience: Audience, at?: Date): Promise<{ priceVersionId: string; amountCents: number } | null>;
```
`createOrder` is used by booking (staff walk-in booking with payment), credits (never; renewals use `createRecurringCharge`) and site. `recordBankTransferPaid` is called by finance when Billit reports a transfer paid.

## 5. Screens

Every screen uses `@beam/ui` (`DataTable`, `LocalizedInput`, `FormField`), money through `Intl.NumberFormat(locale, {style: 'currency', currency: 'EUR'})`, dates in `Europe/Brussels`. Loading states are skeletons from `loading.tsx`; errors render `error.tsx` with the request id and a retry button; empty states have one sentence and the primary action. Navigation entries live in `modules/commerce/nav.ts`.

### 5.1 Back-office (`app/(admin)/admin/...`)

| Route | Who | Shows | Actions | Empty state |
| --- | --- | --- | --- | --- |
| `/admin/products` | `pricing.write`, read-only for `commerce.sell` | Table: name (staff locale), kind, SKU, VAT, current public, member and b2b price, active, shop, POS; filter by kind and active | New product, activate or deactivate, reorder | "No products yet. Create your first product." |
| `/admin/products/new`, `/admin/products/[id]` | `pricing.write` | Form by kind (fields hidden when not applicable: credit units only for packages, interval for memberships, item category for items, amount range for custom vouchers); `LocalizedInput` with completeness badge; price history per audience (version, amount, window, reason, who) | Save, add price version (dialog with "valid from" and optional "valid until"), activate (shows missing locales) | price history: "No price yet: add the public price to activate." |
| `/admin/products/[id]/person-prices` | `pricing.write` | Person-specific prices with person, amount, window, reason | Add (person picker), revoke | "No customer-specific prices." |
| `/admin/products/promotions`, `/admin/products/promotions/new`, `/admin/products/promotions/[id]` | `pricing.write` | Tabs active, scheduled, ended; code or "automatic", value, dates, uses / max, per-person limit; detail shows redemptions (order reference, person, discount) | Create, edit (locked fields disabled with tooltip "used N times"), deactivate | "No promotions. Create a code or an automatic offer." |
| `/admin/orders` | `commerce.sell`, `commerce.refund`, `invoices.read` | Orders table: reference, date, person or company, channel, status badge, total, paid; search by reference, email, name; filters status, channel, date | Open, new staff order | "No orders in this period." |
| `/admin/orders/new` | `commerce.sell` | Person or company picker, product picker with live quote and `pricing_trace` explanation per line ("member discount 10 % beat promo SPRING") | Create order, then pay at POS, send payment link or record bank transfer | |
| `/admin/orders/[id]` | as `/admin/orders` | Lines with trace, payments with `status_history`, refunds, invoice and credit-note links (finance), vouchers, timeline events | Send payment link, cancel (pending), refund (`commerce.refund`), record bank transfer (`invoices.issue`), email receipt, resend voucher | |
| `/admin/orders/[id]/refund` | `commerce.refund` | Per line: paid, used units, refundable default; total; where the money goes (credit balance, card, cash) from `refundPlan()` | Confirm refund with reason | "Nothing left to refund." |
| `/admin/orders/attention` | `commerce.sell`, `reports.read` | `v_payment_attention` grouped by kind with age; the same list feeds the ops action dashboard | Open order, send payment link, create task (crm) | "No payment problems." |
| `/admin/orders/abandoned` (R2) | `reports.read` | Abandoned, recovered, recovery revenue for a period, with and without recovery message, by channel and campaign; list of checkouts | Open person, export CSV (`persons.export`) | "No abandoned checkouts in this period." |
| `/admin/pos` | `commerce.sell` | Reception screen (tablet, 1024 px): left a product grid by kind tabs (Sessions today, Packages, Memberships, Tickets, Vouchers, Items) from `is_pos_visible`; today's sessions with free seats; right the basket with person search (name, email, phone) or "anonymous", live quote, euro credit available, voucher redeem field; a fixed banner "Food and drink: use Lightspeed" | Pay by terminal (spinner, polls status every 2 s up to 120 s, cancel button), cash (received amount, change), bank transfer; after payment: print receipt, email receipt | basket: "Add a product or scan a voucher." |
| `/admin/pos/receipt/[orderId]` | `commerce.sell` | 80 mm print layout of the receipt with BEAM company data from `settings.company`, lines, VAT per rate, payment method, reference | Print, download PDF | |
| `/admin/pos/day` | `commerce.sell`, `reports.read` | Today's POS totals by method (terminal, cash, bank transfer, credit balance), refunds, count; cash expected in drawer | Change day | "No sales today." |
| `/admin/pos/lightspeed` (R3) | `commerce.sell` upload, `reports.finance` view | Imports with status, period and counts; daily food-and-drink totals by category | Upload CSV | "No Lightspeed exports imported." |

### 5.2 Customer portal (`app/[locale]/(portal)/account/...`)

| Route | Shows | Actions | Empty / error |
| --- | --- | --- | --- |
| `/[locale]/account/shop` | Shop products (`is_shop_visible`) grouped by packages, memberships, vouchers, with the person's own price ("Member price") and "4 sessions, valid 6 months" from product data; member-only labelling | Add to basket, buy now | "Nothing for sale right now." |
| `/[locale]/account/checkout` | Basket, quote lines with discount reason, promo code field and warning texts, euro credit toggle with balance, terms checkbox, total incl. VAT | Update quantity, remove, apply code, Pay | price changed banner; sold out message per line |
| `/[locale]/account/checkout/return/[orderId]` | Polls `getOrderStatus` every 2 s for 30 s: paid -> success with what was granted ("4 sessions added", booking confirmed, voucher sent); failed -> retry button; still open -> "Payment pending, we will email you" | Retry payment, go to bookings | |
| `/[locale]/account/orders` | Own orders with reference, date, total, status, invoice link (finance route) | Open, redeem voucher (code field) | "No purchases yet." |

Session and night purchases start in the booking screens (`/[locale]/account/book`, owned by booking), which hand the cart to `/[locale]/account/checkout`.

### 5.3 Public (`app/[locale]/(site)/...`)

| Route | Shows | Actions |
| --- | --- | --- |
| `/[locale]/checkout` | Guest checkout started from site links `?sku=...&session=...`: email step first (creates the checkout row), then the same basket as the portal; link "Log in for member prices" | Pay |
| `/[locale]/checkout/return/[orderId]` | Same polling page as the portal; the order is identified by order id plus a signed cookie set at `placeOrder` | |
| `/[locale]/checkout/resume/[token]` (R2) | Restores an abandoned checkout from the recovery email and re-quotes it | Continue |
| `/[locale]/pay/[token]` | Payment link page: order reference, lines, total, then the provider redirect; states paid, expired, cancelled | Pay |
| `/[locale]/gift` | Voucher purchase page (amount, recipient name and email, message) leading to `/[locale]/checkout` | Buy voucher |

## 6. Integrations

All provider code sits in `packages/integrations/src/payments/`: `provider.ts` (the Wave 0 `PaymentProvider` interface, extended additively), `mollie.ts`, `stripe.ts`, `viva.ts`, `fake.ts` (Wave 0, extended), `select.ts`. Clients take credentials in the constructor, validate responses with Zod, throw `IntegrationError { provider, retryable }` and report each call to an `onCall` callback that the job runner writes to `integration_calls` (operation, digest, status, duration, never bodies).

```ts
export interface PaymentProvider {
  readonly name: 'mollie' | 'stripe' | 'viva' | 'fake';
  createPayment(i: { amountCents: number; description: string; redirectUrl: string; webhookUrl: string;
    locale: Locale; method?: string; customerId?: string; sequenceType: 'oneoff' | 'first';
    metadata: { orderId: string; paymentId: string }; expiresAt?: Date }): Promise<{ providerPaymentId: string; checkoutUrl: string; status: PaymentStatus }>;
  getPayment(providerPaymentId: string): Promise<ProviderPayment>; // status, method, amountCents, paidAt, mandateId, customerId, refunds[], chargebackCents, details (scrubbed)
  refund(i: { providerPaymentId: string; amountCents: number; description: string }): Promise<{ providerRefundId: string; status: 'pending' | 'refunded' | 'failed' }>;
  createCustomer(i: { name: string; email: string; locale: Locale }): Promise<{ customerId: string }>;           // addition
  createMandate(i: { customerId: string; method: 'directdebit'; consumerName: string; iban: string }): Promise<{ mandateId: string; status: string }>;
  getMandate(i: { customerId: string; mandateId: string }): Promise<{ status: 'pending' | 'valid' | 'invalid'; method: string; summary: string | null }>; // addition
  revokeMandate(i: { customerId: string; mandateId: string }): Promise<void>;                                     // addition
  deleteCustomer(customerId: string): Promise<void>;                                                               // addition
  createRecurringPayment(i: { customerId: string; mandateId: string; amountCents: number; description: string; webhookUrl: string; metadata: Record<string, string> }): Promise<{ providerPaymentId: string; status: PaymentStatus }>;
  createPaymentLink(i: { amountCents: number; description: string; expiresAt: Date; redirectUrl: string; webhookUrl: string }): Promise<{ linkId: string; url: string }>;
  createTerminalPayment(i: { terminalId: string; amountCents: number; description: string; webhookUrl: string; metadata: Record<string, string> }): Promise<{ providerPaymentId: string; status: PaymentStatus }>;
  verifyWebhook(req: { headers: Headers; rawBody: string; url: URL }): boolean;
}
export function selectProvider(channel: OrderChannel, settings: PaymentProviderByChannel, env: ProviderEnv): PaymentProvider; // select.ts
```

| Provider | Calls made | Failure handling | Idempotency |
| --- | --- | --- | --- |
| Mollie (`@mollie/api-client`, `MOLLIE_API_KEY`; test key outside production) | Payments API create and get (methods Bancontact, cards, KBC, Belfius; first payment with `sequenceType: first` creates the mandate), Refunds API, Customers API (create, delete), Mandates API (get, revoke), recurring payments, Terminal (point-of-sale) payments with `method: pointofsale` and `terminalId`, Payment Links API (implemented, not used by the platform, see 13) | 5xx, 429 and timeouts (10 s) are retryable with the job backoff; 4xx is `PermanentError`. At checkout a failure leaves the order `pending_payment` with a `failed` payment and the page offers "Try again". Webhook silence is caught by `payments.scan_expired`, which syncs every open payment after 30 minutes. | `Idempotency-Key` header = the job key on every create call; `provider_payment_id` and `provider_refund_id` unique; forward-only state machine; jobs keyed per payment and status |
| Stripe, Viva (stub adapters) | Same interface; every method throws `IntegrationError { retryable: false, message: 'not_configured' }` unless `STRIPE_API_KEY` or `VIVA_*` exists; `fake.ts` covers both in tests | Selecting them in `payment_provider_by_channel` is refused by the settings validation while no key is configured | n/a |
| Fake (`fake.ts`) | In-memory payments with controllable outcomes (`fake.settle(id, 'paid'|'failed'|'expired'|'cancelled')`, `fake.chargeback(id, cents)`, latency and error injection); used by every test and by `beam_dev` when `PAYMENTS_FAKE=1` | | |
| Email (internal, `email.sendTransactional`) | Templates in `packages/email/src/templates/commerce/`: `order-confirmation.tsx`, `payment-link.tsx`, `gift-voucher.tsx`, `refund-confirmation.tsx`, `pos-receipt.tsx`, `portal-invitation.tsx` | Missing translation blocks the message (`blocked_translation`) and alerts; the order itself is unaffected | `email:order:<id>:paid`, `email:refund:<id>`, `voucher-email:<id>`, `pay-link:<order_id>:<version>` |

Lightspeed has no API integration: BEAM staff export the daily sales CSV from Lightspeed back office and upload it (R3).

## 7. Permissions and audit

Permissions used (all from the architecture list; commerce declares `commerce.sell`, `commerce.refund`, `pricing.write` in `permissions.ts`):

| Capability | Permission | Default roles |
| --- | --- | --- |
| View products, prices, promotions | `commerce.sell` or `pricing.write` | owner, technical_admin, management, sales, reception, finance |
| Create and edit products, price versions, person prices, promotions | `pricing.write` | owner, technical_admin, management, finance |
| Staff orders, POS sales, payment links, cancel pending orders, email receipts, redeem vouchers for a customer, upload Lightspeed CSV | `commerce.sell` | owner, technical_admin, management, sales, reception |
| Refunds, confirm manual refunds, void vouchers | `commerce.refund` | owner, technical_admin, management, finance |
| Refund above €500 or on an order older than 365 days | `commerce.refund` plus role `owner` or `finance` (checked in the handler) | owner, finance |
| Record a bank transfer as paid | `invoices.issue` | owner, technical_admin, management, finance |
| View orders | `commerce.sell`, `commerce.refund` or `invoices.read` | as above |
| Recovery report, POS day summary, attention list | `reports.read` | all staff roles except external_partner |
| Lightspeed daily figures | `reports.finance` | owner, technical_admin, management, finance |
| Export recovery list as CSV | `persons.export` | owner, technical_admin, management |

External partners see no commerce screen. R3 partner referral counts are shown by ops through `partner.own`.

Audited actions (`audit_log`, written by `action()` for every staff write, with old and new value): `product.created`, `product.updated`, `product.activated`, `product.deactivated`, `price.version_added`, `person_price.set`, `person_price.revoked`, `promotion.created`, `promotion.updated`, `order.created`, `order.cancelled`, `payment_link.sent`, `pos.sale` (with payment method and any discount applied, which covers blueprint 56 "discount applied"), `pos.terminal_cancelled`, `refund.issued` (blueprint 56 "refund issued"), `refund.confirmed`, `payment.bank_transfer_recorded`, `voucher.redeemed` (staff), `voucher.resent`, `voucher.voided`, `receipt.emailed`, `lightspeed.uploaded`, `settings.payment_provider_changed`. Customer actions are not audited; they appear on the timeline.

## 8. Multi-language and content

- LocalizedText fields: `products.name`, `products.description`, `promotions.name`, `order_lines.description` (snapshot), `settings.commerce.receipt_footer`.
- Catalogue namespace `commerce`, files `packages/core/src/i18n/messages/{nl-BE,fr-BE,en}/commerce.json`, keys `commerce.<screen>.<element>`. Screens: `shop`, `checkout`, `return`, `orders`, `pay`, `gift`, `voucher`, `admin_products`, `admin_prices`, `admin_promotions`, `admin_orders`, `admin_refund`, `admin_attention`, `admin_abandoned`, `pos`, `receipt`, `lightspeed`. Plus `commerce.errors.*` for every action error code (`sold_out`, `price_changed`, `promo_unknown`, `promo_inactive`, `promo_expired`, `promo_exhausted`, `promo_not_eligible`, `promo_not_better`, `voucher_invalid`, `voucher_used`, `voucher_expired`, `rate_limited`, `payment_unavailable`, `refund_too_high`) and `commerce.payment_status.*`, `commerce.order_status.*`, `commerce.product_kind.*`.
- Publish-time check: `setProductActive(true)` and `updateProduct` on an active product call `assertComplete(name)` and, when `is_shop_visible`, `assertComplete(description)` for all three locales. Activating an automatic promotion or saving a code promotion calls `assertComplete(promotions.name)` because the name prints on lines, receipts and invoices.
- Customer-facing totals, receipts and emails render in `orders.locale` (the person's locale at order time). The receipt PDF and the voucher PDF exist per locale; a missing key blocks the PDF job with `PermanentError` and an alert, never a mixed language.
- Euro amounts use `Intl.NumberFormat`; "4 sessions remaining" style texts use ICU plurals in the catalogue.

## 9. Privacy

`apps/web/modules/commerce/privacy.ts` registers:

| Table | Person columns | Export includes | Erase action | Why |
| --- | --- | --- | --- | --- |
| `orders` | person_id, note | reference, date, channel, status, totals, lines (description, quantity, amounts, VAT, discount reason) | `retained_legal`: person_id set null, `is_erased_subject = true`, note null | Accounting records, 7 years; the invoice keeps the legal name and address (finance) |
| `order_lines` | none (reached through orders) | in orders | `retained_legal`, unchanged | no personal data |
| `payments` | raw (consumer name, IBAN, card summary) | provider, method, amount, status, dates | `retained_legal`: raw replaced by `{id, status, method, amount}` under `beam.allow_rewrite` | Payment trace for accounting; the provider keeps its own data under its legal obligations (noted in the report) |
| `refunds` | none direct | amount, reason, status, date | `retained_legal`, unchanged | |
| `mandates` | person_id, details_summary | method, summary, status | `anonymised`: person_id null, details_summary null, status `revoked`; job `commerce.erase_provider_customer` revokes at Mollie and deletes the customer | Stops future charges |
| `provider_customers` | person_id | provider and creation date | `deleted` | |
| `checkouts` | person_id, email, utm | items, dates, status | `deleted` | Marketing analytics only |
| `person_prices` | person_id | product, amount, window, reason | `deleted` | |
| `promotion_redemptions` | person_id | promotion name, order reference | `anonymised`: person_id null | Keeps use counts correct |
| `vouchers` | purchaser_person_id, recipient_name, recipient_email, message, redeemed_by_person_id | vouchers bought (amount, status, recipient) and redeemed | `anonymised`: person ids, recipient_name, recipient_email, message null; status and amount kept | A voucher is a liability that must stay countable; an active voucher stays redeemable by code |
| `lightspeed_imports`, `lightspeed_sales` | none | n/a | `NO_PII_TABLES` | Aggregated till data |

Erasure is refused with a clear message while the person has an order `pending_payment` with a live provider payment; the privacy job retries after 1 hour (the payment expires within 30 minutes). Open bank-transfer orders are cancelled first.

Retention policies (declared in `privacy.ts` as `retention: RetentionPolicySeed[]`, seeded into ops' `retention_policies` by the ops seed, enforced by `privacy.retention_sweep`): `commerce_checkouts` 395 days `delete` (13 months: a year of recovery comparisons); `commerce_payments_raw` 90 days `anonymise` (raw reduced as above); `commerce_orders` 2555 days (7 years after `paid_at`) `anonymise` (person_id null, then rows kept without person); `commerce_person_prices` 730 days after `valid_to_at` or `revoked_at` `delete`; `commerce_lightspeed_sales` 2555 days `delete`.

The subject's export (`export(tx, personId)`) returns `orders.json`, `payments.csv`, `vouchers.json`, `checkouts.json`, `mandates.json`, `person_prices.json`. Commerce has no sensitive columns, so nothing is added to `SENSITIVE_COLUMNS`. AI context gets only `revenue_cents` and `purchases` through ops' `person_stats`; no commerce column is in `AI_ALLOWED_FIELDS` or `SEGMENT_ALLOWED_FIELDS` except through `v_person_profile`.

## 10. Dependencies

Needs from other modules (all through `api.ts`; callers' unit tests mock them until the owner lands them):

| Module | Function or table | Used for |
| --- | --- | --- |
| platform | `ctx.recordEvent`, `ctx.audit`, `ctx.enqueue`, `runJobInline`, `defineJob`, `defineSchedule`, `getSetting(key)`, `flag('ff_commerce_checkout_recovery', ctx)`, `platform.receiveWebhook(db, {provider, externalEventId, payload, job})` (addition requested), `platform.storeFile(tx, {kind, name, mime, bytes, personId, expiresAt})` | jobs, audit, settings, webhook inbox, receipt files |
| crm | `crm.findOrCreatePersonByEmail(tx, ctx, {email, locale, firstName?, lastName?, acquisition?})`, `crm.getPersonStatus(db, personId)`, `crm.matchesSegment(db, segmentId, personId): Promise<boolean>` (addition requested), `crm.searchPersons(db, q)` for the POS picker, `companies` read | buyer identity, member status, promotion eligibility |
| booking | `booking.getAvailability(db, sessionId)`, `booking.reserveForOrderLine(tx, ctx, {sessionId, ticketTypeId?, personId, orderLineId, quantity, reservedUntil})`, `booking.confirmOrderBookings(tx, ctx, {orderId})`, `booking.releaseOrderBookings(tx, ctx, {orderId, reason: 'expired'|'cancelled'})`, `booking.cancelBookingForRefund(tx, ctx, {orderLineId, reason})`; reads `sessions.product_id` through `getAvailability` | session, night and ticket lines |
| credits | `credits.grantCredits(tx, ctx, {personId, productId, orderLineId, kind, units, unitValueCents, startsAt, expiresAt, sharing, source, key})`, `credits.consumeCredits(...)` and `credits.releaseCredits(...)` (kind `euro`), `credits.getEuroBalance(db, personId)`, `credits.revokeGrantRemainder(tx, ctx, {orderLineId, reason})`, `credits.getGrantUsage(db, orderLineId)`, `credits.activateMembership(tx, ctx, {personId, productId, orderId, priceVersionId, mandateId, startsAt})`, `credits.applyRenewalPayment(tx, ctx, {membershipId, orderId})`, `credits.applyRenewalFailure(tx, ctx, {membershipId, paymentId, reason})`, `credits.cancelMembershipForRefund(tx, ctx, {membershipId, reason})`, `credits.getMembershipForPerson(db, personId)` (discount and member flag) | packages, euro credit, memberships |
| finance | `finance.issueInvoice(tx, ctx, {orderId, status?: 'paid'|'open', dueOn?})`, `finance.issueCreditNote(tx, ctx, {invoiceId, lines, reason, refundId})`, `finance.getInvoiceForOrder(db, orderId)` | invoices and credit notes |
| email | `email.sendTransactional(tx, ctx, {templateSlug, personId?, toEmail?, locale, data, idempotencyKey, attachments?: fileId[]})`, `email.findLatestMessage(db, {personId, templateSlug, after})` (R2, addition requested) | receipts, links, vouchers, recovery attribution |
| automation | seeded `abandoned-checkout` automation triggered by `checkout.abandoned` | R2 recovery sequence |

Provides to other modules:

| Module | What |
| --- | --- |
| booking | `createOrder`, `getProductPrice` for walk-in prices and staff bookings with payment; capacity reservations through its own api |
| credits | `createRecurringCharge`, `getActiveMandate`, `mandates` table for renewals; product data (`credit_units`, `validity_days`, sharing defaults) passed in `grantCredits` |
| finance | `recordBankTransferPaid`; `orders` and `order_lines` read through `getOrder` for invoice lines |
| ops | `listPaymentAttention` (action dashboard "5 failed payments"), `v_checkout_recovery`, `v_sales_lines`, `v_lightspeed_daily`, `getPersonCommerceSummary`; `order.paid` events for `person_stats` |
| crm | the person page "Purchases" tab through `listOrdersForPerson`; timeline events listed in 4.7 |
| site | checkout entry links `/[locale]/checkout?sku=` and `/[locale]/gift` |
| automation | events `checkout.abandoned`, `checkout.recovered`, `order.paid`, `payment.failed`, `promotion.redeemed` as triggers and exits |

## 11. Edge cases and failure modes

1. **Double click on Pay.** Same `client_key` returns the existing order and its open `checkout_url`; a different key on the same checkout while an order is pending returns that pending order too (one pending order per checkout).
2. **Webhook arrives twice or out of order.** Each delivery has its own `webhook_events` row and job, but `applyProviderStatus` ignores non-forward moves and the paid transaction runs only from `pending_payment`; side effects have keys (`payment:<id>:paid`).
3. **Webhook never arrives.** `payments.scan_expired` syncs every open payment after 30 minutes; the return page can enqueue `payments.sync` while polling.
4. **Paid after local expiry.** The payment becomes `paid` (rule 28). Credits, membership and vouchers are delivered. If a booking's capacity is gone, `booking.confirmOrderBookings` returns the unconfirmed lines; commerce creates a `payment` task for customer service ("Paid after expiry, seat no longer free") and does not auto-refund.
5. **Price changes during checkout.** The order is priced at `placeOrder`; if that total differs from the last quote shown, `placeOrder` returns `conflict: price_changed` with the new quote and creates nothing.
6. **Promotion hits `max_uses` concurrently.** The `FOR UPDATE` lock on the promotion serialises; the second order gets `promo_exhausted` and is priced without it, after showing the customer the new total.
7. **Member status changes after the order is created.** Price stays as quoted; the trace records the status used.
8. **Mollie down at checkout.** `payments.create` fails; the payment is `failed`, the order stays `pending_payment`, the page says "Payment service unavailable, try again in a minute"; the dead-job alert fires if retries fail.
9. **Customer closes the browser on the Mollie page.** The webhook settles the status; if it stays open, expiry after 30 minutes releases seats, euro credit and promotion uses; the checkout becomes `abandoned` with `payment_expired`.
10. **Zero-total order.** Paid in the creating transaction, invoice with total 0 still issued (finance numbers every sale).
11. **Euro credit covers part, card payment fails.** The `credit_balance` payment stays paid until the order expires; expiry releases the euro credit with `credits.releaseCredits` (key `release:order:<id>`).
12. **Refund on a package already partly used.** `refundPlan` offers only the unused units pro rata; the used part stays consumed; revoking writes `revoke` entries for the remainder only.
13. **Refund larger than the payment it targets.** The plan splits across payments (rule 38); a total above the refundable amount is `validation: refund_too_high`.
14. **Provider refund fails** (insufficient Mollie balance). Refund `failed`, visible on the attention list with Retry; the credit note is already issued and stays (the money is owed); a retry enqueues `payments.refund` with key `refund:<id>:retry:<n>`.
15. **Chargeback.** Rule 35: task for finance, event, nothing revoked automatically.
16. **Terminal: customer walks away or card declined.** The terminal payment ends `failed` or `cancelled` through the webhook; the POS shows the result within 2 s of the webhook; staff can cancel a hanging terminal payment after 120 s and choose another method on the same order.
17. **Cash sale with wrong amount received.** `cashReceivedCents < total` is a validation error; change is shown and stored.
18. **Anonymous POS sale needs a refund.** Allowed for cash and terminal; the credit note goes to "Walk-in customer" (finance customer snapshot).
19. **Voucher code guessing.** 60-bit codes, sha256 lookup, 5 attempts per person or IP per hour (rule 47), constant-time compare.
20. **Same voucher redeemed twice at once.** Redemption locks the voucher row `FOR UPDATE` and requires `status = 'active'`; the second request gets `voucher_used`.
21. **Product deactivated while in an open checkout.** Re-quote drops the line with warning `product_unavailable`; existing paid lines are unaffected.
22. **Product name missing a translation.** The product cannot be active (rule 1), so it never reaches a checkout.
23. **Site guest uses the email of an existing customer.** The order attaches to that person; member pricing applies only after login (a guest checkout quotes as `public` until the session proves identity), so nobody gets member prices by typing a member's email.
24. **Lightspeed CSV uploaded twice or with a broken row.** Duplicate lines are skipped by `external_line_key`; broken rows are listed in `errors` with row numbers and the rest imports.
25. **Erasure with a live payment.** Refused and retried (section 9).
26. **Bank transfer never arrives.** After 14 days the order shows as `bank_transfer_overdue` on the attention list; staff cancel it, which issues a credit note for the open invoice.
27. **Renewal mandate revoked at the bank.** The recurring payment fails; `credits.applyRenewalFailure` starts dunning; the mandate is set `invalid` after `getMandate` reports it.

## 12. Build packages

All nine packages are **strictly sequential** (P1 before P2 before ... P9), so later packages may edit the module's shared registry files (`actions.ts`, `queries.ts`, `api.ts`, `jobs.ts`, `schedules.ts`, `events.ts`, `permissions.ts`, `nav.ts`, `privacy.ts`, `seed.ts`, the three `commerce.json` catalogues, `commerce.views.ts`, `e2e/commerce.spec.ts`); each package lists them. Logic lives in `apps/web/modules/commerce/server/<area>.ts` files that only one package creates. No package edits `package.json`, the lockfile, migrations, generated registries or frozen files. Every package's done-definition includes: `pnpm typecheck`, `pnpm lint`, its Vitest suites green on `createTestDb()` with the payments `fake.ts`, `pnpm i18n:check` for keys it added, and the module's `jobs.test.ts` double-run cases for any job it added.

### commerce-P1 (V1): schema, views and pure core
- Goal: every V1 table, enum, check, index and view of section 2; the pure pricing, VAT, state machine, refund plan and voucher code logic.
- Files: edit `packages/db/src/schema/commerce.ts` (add columns and tables to the Wave 0 stubs; existing columns untouched); create `packages/db/src/schema/commerce.views.ts` (`v_product_current_prices`, `v_order_balances`, `v_payment_attention`); create `packages/core/src/commerce/{index.ts,schemas.ts,pricing.ts,vat.ts,state-machine.ts,refunds.ts,vouchers.ts,references.ts}`.
- Interfaces: `quote`, `vatOf`, `nextPaymentStatus`, `refundPlan`, `deriveVoucherCode`, `normaliseVoucherCode`, `newOrderReference(random): string`, Zod `CartItem`, types of 4.1.
- Depends on: Wave 0 (`_shared.ts` helpers, `APPEND_ONLY_TABLES` containing `price_versions` and `order_lines`), `crm:persons`, `platform:users,files`, `booking:sessions,ticket_types` and `credits:credit_grants` tables for foreign keys, `finance:invoices`, `email:email_messages`.
- Tests: `packages/core/src/commerce/pricing.test.ts` (base by audience; member version beats member pct; person price wins; best single discount, no stacking; tie order of rule 9; fixed capped at unit price; vouchers and memberships excluded; each warning code; trace contents; historical `at` picks the older version; time-limited version falls back after `valid_to_at`); `vat.test.ts` (6, 12, 21 %, half-up at .5 cent, sum of lines); `state-machine.test.ts` (every pair of statuses, local_timeout exception); `refunds.test.ts` (pro rata unused units, payment order credit-balance first, cap); `vouchers.test.ts` (derivation stable, normalisation of O/I/L, format); `packages/db/src/schema/commerce.test.ts` on PGlite (each check constraint rejects bad rows; partial unique on promotion code; `order_lines` and `price_versions` reject update and delete; views return expected rows). Coverage of `commerce/pricing` above 90 %.
- Done: the above green; `createTestDb()` builds the schema.

### commerce-P2 (V1): payment provider adapters
- Goal: Mollie adapter, Stripe and Viva stubs, provider selection, fake extended with the added methods.
- Files: edit `packages/integrations/src/payments/provider.ts` (additive methods of section 6) and `fake.ts`; create `mollie.ts`, `stripe.ts`, `viva.ts`, `select.ts`, `index.ts` re-export edit.
- Interfaces: `PaymentProvider` (section 6), `createMollieProvider({apiKey, webhookBaseUrl, onCall, fetch?})`, `createStubProvider(name)`, `selectProvider(channel, settings, env)`, `FakePaymentProvider` with `settle`, `chargeback`, `failNext`.
- Depends on: Wave 0 `packages/integrations/src/payments/{provider.ts,fake.ts}`, `IntegrationError`.
- Tests: `mollie.test.ts` with an injected `fetch` returning recorded Mollie JSON (create payment with `Idempotency-Key`, get payment mapping every Mollie status, refunds, customers, mandates, terminal, 429 retryable, 422 permanent, Zod rejection of malformed bodies, `onCall` without bodies); `fake.test.ts`; `select.test.ts` (per channel; stub refused without key).
- Done: suites green; no network in tests.

### commerce-P3 (V1): catalogue, prices and promotions in the back-office
- Goal: products, price versions, person prices, promotions with all rules 1-6 and 17-18; seed data.
- Files: create `apps/web/modules/commerce/server/catalogue.ts`, `server/promotions.ts`; edit `actions.ts`, `queries.ts`, `permissions.ts`, `nav.ts`, `seed.ts`; create `packages/db/src/seed/commerce.ts` (products: day session walk-in €45, night €95, 5-day package €200 / 6 months, 10-day package €380 / 12 months, 2-night package €180, monthly membership €89 with 4 day credits and 10 % discount, event ticket €25, gift voucher custom €25-€500, merchandise item; settings keys of 2.4); create `app/(admin)/admin/products/{page.tsx,new/page.tsx,[id]/page.tsx,[id]/person-prices/page.tsx,promotions/page.tsx,promotions/new/page.tsx,promotions/[id]/page.tsx,loading.tsx,error.tsx}` and `apps/web/modules/commerce/ui/{product-form.tsx,price-history.tsx,promotion-form.tsx}`; edit `packages/core/src/i18n/messages/{nl-BE,fr-BE,en}/commerce.json`.
- Interfaces: actions `createProduct`, `updateProduct`, `setProductActive`, `addPriceVersion`, `setPersonPrice`, `revokePersonPrice`, `createPromotion`, `updatePromotion`; `api.getProductPrice`; `server/promotions.ts` `loadEligiblePromotions(tx, {personId, channel, code, at}): Promise<Array<PromotionRow & {isEligible: boolean}>>`.
- Depends on: P1; `crm:matchesSegment`, `crm:getPersonStatus`; `platform:action(), requirePermission, getSetting`.
- Tests: `apps/web/modules/commerce/server/catalogue.test.ts` (activation blocked by missing locale and by missing price; version numbering under concurrency; append-only enforced), `promotions.test.ts` (eligibility for each rule; locked fields after use; code upper-casing and uniqueness), `permissions.test.ts` (each action refused without its permission).
- Done: suites green; admin pages render with seed data in `pnpm dev`.

### commerce-P4 (V1): order engine, payments, webhook and the paid transaction
- Goal: `createOrder`, `startPayment`, provider sync, the paid transaction (rules 19-35), expiry, recurring charges, bank transfer recording, privacy registration.
- Files: create `apps/web/modules/commerce/server/{orders.ts,payments.ts,paid.ts,expiry.ts,recurring.ts}`, `app/api/webhooks/mollie/route.ts`, `packages/email/src/templates/commerce/{order-confirmation.tsx,portal-invitation.tsx,index.ts}`; edit `api.ts`, `jobs.ts` (`payments.create`, `payments.sync`, `payments.scan_expired`, `payments.charge_recurring`, `commerce.erase_provider_customer`), `schedules.ts`, `events.ts`, `privacy.ts`, `commerce.json` x3.
- Interfaces: all of 4.8 except `listPaymentAttention`; `applyProviderStatus(tx, ctx, payment, reported): Promise<{changed: boolean; becamePaid: boolean}>`; `finalizePaidOrder(tx, ctx, orderId): Promise<{delivered: DeliveredLine[]; unconfirmedBookings: string[]}>`.
- Depends on: P1, P2, P3; `booking:reserveForOrderLine, confirmOrderBookings, releaseOrderBookings`; `credits:grantCredits, consumeCredits, releaseCredits, getEuroBalance, activateMembership, applyRenewalPayment, applyRenewalFailure, getMembershipForPerson`; `finance:issueInvoice`; `email:sendTransactional`; `crm:findOrCreatePersonByEmail`; `platform:receiveWebhook, runJobInline`.
- Tests: `server/orders.test.ts` (client_key double submit; sold out writes nothing; promotion reservation and release; zero total paid inline; euro credit split), `server/paid.test.ts` (each product kind delivers exactly once; invoice issued once; events and email jobs keyed; paid after local expiry creates a task), `server/expiry.test.ts`, `webhook.test.ts` (bad token 401; duplicate delivery; unknown id), `jobs.test.ts` (double run of every job), `privacy.test.ts` (export contents; erase leaves no person reference except retained-legal rows; refusal with a live payment).
- Done: suites green with fakes; the paid transaction is one database transaction (asserted by a failing-credits mock rolling everything back).

### commerce-P5 (V1): customer shop and checkout (portal and site), checkout tracking
- Goal: portal shop, checkout, return pages, orders list, site guest checkout and gift page; `checkouts` lifecycle and `checkouts.mark_abandoned` (rules 48-50).
- Files: create `apps/web/modules/commerce/server/checkouts.ts`, `ui/{basket.tsx,quote-lines.tsx,promo-field.tsx,return-poller.tsx}`, `app/[locale]/(portal)/account/shop/page.tsx`, `account/checkout/page.tsx`, `account/checkout/return/[orderId]/page.tsx`, `account/orders/page.tsx`, `app/[locale]/(site)/checkout/page.tsx`, `(site)/checkout/return/[orderId]/page.tsx`, `(site)/gift/page.tsx` with `loading.tsx` and `error.tsx` each; edit `actions.ts` (`startCheckout`, `updateCheckout`, `placeOrder`, `retryPayment`), `queries.ts`, `jobs.ts` (`checkouts.mark_abandoned`), `schedules.ts`, `events.ts`, `commerce.json` x3; create `e2e/commerce.spec.ts`.
- Depends on: P4; `booking:getAvailability`; `credits:getEuroBalance`.
- Tests: `server/checkouts.test.ts` (re-quote and price-changed flag; abandoned after 60 min with each reason; event only with a person; completed on paid; expired after 30 days; guest gets public price even with a member's email); `e2e/commerce.spec.ts`: customer buys a 5-day package with the fake provider and sees "5 sessions remaining"; member sees the member price automatically (acceptance "member discount works"); guest buys a voucher on the site.
- Done: unit suites green; e2e green against `beam_dev` with `PAYMENTS_FAKE=1`.

### commerce-P6 (V1): orders back-office, refunds, payment links, attention feed, vouchers
- Goal: rules 36-41, 45-47; admin order screens; pay page; voucher redemption in the portal.
- Files: create `apps/web/modules/commerce/server/{refunds.ts,payment-links.ts,vouchers.ts,attention.ts}`, `app/(admin)/admin/orders/{page.tsx,new/page.tsx,[id]/page.tsx,[id]/refund/page.tsx,attention/page.tsx,loading.tsx,error.tsx}`, `app/[locale]/(site)/pay/[token]/page.tsx`, `packages/email/src/templates/commerce/{payment-link.tsx,refund-confirmation.tsx,gift-voucher.tsx}`; edit `templates/commerce/index.ts`, `actions.ts` (`createStaffOrder`, `sendPaymentLink`, `cancelOrder`, `refundOrder`, `confirmManualRefund`, `recordBankTransfer`, `redeemVoucher`, `resendVoucher`, `voidVoucher`, `emailReceipt`), `queries.ts`, `api.ts` (`listPaymentAttention`, `recordBankTransferPaid`), `jobs.ts` (`payments.refund`, `payments.create_link`, `commerce.issue_voucher_email`), `account/orders/page.tsx` (voucher field; P5 file, sequential), `commerce.json` x3.
- Depends on: P5; `finance:issueCreditNote, getInvoiceForOrder`; `credits:revokeGrantRemainder, getGrantUsage, cancelMembershipForRefund, grantCredits`; `booking:cancelBookingForRefund`; `crm` tasks api `crm.createTask`.
- Tests: `server/refunds.test.ts` (partial package; booking cancelled; membership cancelled; voucher refund only unredeemed; credit-balance first; >€500 needs owner or finance; credit note issued; provider failure path), `payment-links.test.ts` (token single order, expiry, paid state), `vouchers.test.ts` (redeem once under concurrency; rate limit; expiry), `attention.test.ts` (each feed kind appears and disappears).
- Done: suites green; e2e case "staff refunds an unused package" added to `e2e/commerce.spec.ts`.

### commerce-P7 (V1): front-desk POS and receipts
- Goal: POS screen, terminal, cash and bank-transfer payments, receipts, day summary (rules 42-44).
- Files: create `apps/web/modules/commerce/server/pos.ts`, `ui/{pos-grid.tsx,pos-basket.tsx,terminal-dialog.tsx,receipt-pdf.tsx}`, `app/(admin)/admin/pos/{page.tsx,receipt/[orderId]/page.tsx,day/page.tsx,loading.tsx,error.tsx}`, `packages/email/src/templates/commerce/pos-receipt.tsx`; edit `templates/commerce/index.ts`, `actions.ts` (`posSell`, `posCancelTerminal`), `queries.ts` (`getPosDaySummary`), `jobs.ts` (`payments.terminal`, `commerce.render_receipt`), `nav.ts`, `commerce.json` x3, `e2e/commerce.spec.ts`.
- Depends on: P6; `crm:searchPersons`; `platform:storeFile`.
- Tests: `server/pos.test.ts` (anonymous only for items and vouchers; cash change; bank transfer invoice open and delivery deferred; terminal paid via fake webhook; cancel hanging terminal; voucher redemption at the counter), `receipt.test.ts` (PDF bytes produced per locale; VAT per rate; missing key is permanent), e2e "reception sells a package by cash and prints the receipt".
- Done: suites and e2e green.

### commerce-P8 (R2): abandoned checkout recovery and multi-ticket carts
- Goal: rules 51-52, recovery report, resume links, flag `ff_commerce_checkout_recovery`; carts with several ticket types of one event.
- Files: create `apps/web/modules/commerce/server/recovery.ts`, `app/[locale]/(site)/checkout/resume/[token]/page.tsx`, `app/(admin)/admin/orders/abandoned/page.tsx`; edit `commerce.views.ts` (`v_checkout_recovery`; the R2 columns of `checkouts` already exist from P1), `jobs.ts` (attribution inside `checkouts.mark_abandoned`), `events.ts` (`checkout.recovered`), `queries.ts`, `nav.ts`, `commerce.json` x3; `packages/core/src/commerce/pricing.ts` ticket-type grouping.
- Depends on: P7; `email:findLatestMessage`; `automation:` seeded `abandoned-checkout` sequence; `booking:ticket_types` with several types per session.
- Tests: `server/recovery.test.ts` (recovered within 7 days with a matching product; not recovered after 8 days or with other products; revenue sum; message attribution), `pricing.test.ts` additions (two ticket types, member price per type).
- Done: suites green; the `scenario`-style e2e "abandon, receive email in sink, resume, pay, report shows 1 recovered" green with the flag on for testers.

### commerce-P9 (R3): Lightspeed import, referral codes, sales views
- Goal: rule 53, partner referral promotions, `v_sales_lines`, `v_lightspeed_daily`.
- Files: edit `packages/db/src/schema/commerce.ts` (add `lightspeed_imports`, `lightspeed_sales`, `promotions.partner_company_id`), `commerce.views.ts`; create `packages/core/src/commerce/lightspeed.ts`, `apps/web/modules/commerce/server/lightspeed.ts`, `app/(admin)/admin/pos/lightspeed/page.tsx`; edit `actions.ts` (`uploadLightspeedCsv`), `jobs.ts` (`commerce.import_lightspeed`, `commerce.import_lightspeed_pending`), `schedules.ts`, `privacy.ts` (`NO_PII_TABLES` entries), `seed.ts`, `server/promotions.ts` (partner code eligibility), `ui/promotion-form.tsx`, `commerce.json` x3.
- Depends on: P8; `crm:companies` (`is_partner`); `platform:files`.
- Tests: `packages/core/src/commerce/lightspeed.test.ts` (semicolon and comma CSV, Belgian decimal commas, VAT parsing, bad rows), `server/lightspeed.test.ts` (idempotent re-import, chunk continuation), `views.test.ts` (`v_sales_lines` deferred vouchers, refunds netted).
- Done: suites green.

Release 4 has no commerce package (section 1).

## 13. Decisions made

Additions to the architecture (tables, columns, enum values, interfaces):
1. New tables: `promotion_redemptions` (per-person limits need a per-person count), `vouchers` (gift voucher codes, recipients and redemption), `provider_customers` (Mollie recurring needs a customer object), `lightspeed_imports` and `lightspeed_sales` (R3 reporting import).
2. New `products` columns: `item_category`, `is_custom_amount`, `min_amount_cents`, `max_amount_cents`, `is_shop_visible`, `is_pos_visible`, `image_file_id`. New `price_versions.reason`, `person_prices.revoked_at`, `promotions.name` and `created_by_user_id`, `promotions.partner_company_id` (R3).
3. New `checkouts` columns: `channel`, `promo_code`, `total_cents`, `order_id`, `last_activity_at`, `abandoned_reason`, `resume_token_hash`, `recovered_at`, `completed_at`.
4. New `orders` columns: `reference`, `expires_at`, `pay_token_hash`, `pay_token_expires_at`, `is_erased_subject`, `created_by_user_id`, `note`, `cancelled_at`. New `order_lines` columns: `line_no`, `product_kind`, `sku`, `options`. New `payments` columns: `sequence_type`, `refunded_cents`, `chargeback_cents`, `terminal_id`, `cash_received_cents`, `failed_reason`, `expires_at`, `created_by_user_id`. New `refunds` columns: `order_id`, `lines`, `credit_action`, `failed_reason`. New `mandates` columns: `provider_customer_id`, `details_summary`, `revoked_at`.
5. `payments_provider` gains `credit_balance`, so euro credit from vouchers pays orders through the same payments model.
6. `PaymentProvider` gains `createCustomer`, `getMandate`, `revokeMandate`, `deleteCustomer` (recurring payments, dunning and erasure need them).
7. New env secret `VOUCHER_CODE_SECRET` (voucher codes are re-derivable, never stored in plain text).
8. New job kinds: `payments.charge_recurring`, `commerce.render_receipt`, `commerce.issue_voucher_email`, `commerce.erase_provider_customer`, `commerce.import_lightspeed` and `commerce.import_lightspeed_pending`, with its schedule at 02:40 (R3).
9. New settings keys `payment_provider_by_channel` (named in the architecture's integration table) and `commerce`.
10. Cross-module functions requested from other owners: `platform.receiveWebhook`, `platform.storeFile`, `crm.matchesSegment`, `crm.searchPersons`, `crm.createTask`, the booking, credits and finance functions of section 10, `email.findLatestMessage` (R2).
11. The Mollie webhook enqueues `payments.sync` directly (key `webhook:mollie:<id>:<ms>`, the architecture's key format) instead of a generic `webhook.process` job, saving one hop.
12. Promotions live at `/admin/products/promotions`, refunds at `/admin/orders/[id]/refund`, attention and recovery under `/admin/orders/...`, so commerce stays inside its owned folders `products`, `orders`, `pos`. Commerce also owns the public routes `(site)/checkout`, `(site)/pay` and `(site)/gift`; the site module must not create them.

Choices the inputs left open:
13. Lightspeed: food and drink stay on Lightspeed (GKS); everything else BEAM sells at the counter moves to the POS in V1. Proposal question 1 is answered this way by default.
14. Lightspeed data arrives as a CSV that staff export and upload; the nightly job processes uploads at 02:40, and an upload is also processed at once. No Lightspeed API client. Ships in R3 together with the management and finance dashboards that use it.
15. Gift vouchers ship in V1 (proposal question 4) as products of kind `voucher` with VAT 0 % at sale (multi-purpose voucher; VAT is charged when the euro credit buys a 6 % or 21 % service), 730 days minimum validity (the Belgian two-year minimum for gift vouchers), custom amounts from €5 to €1,000, one redemption per code into the redeemer's euro credit (1 unit = 1 cent).
16. Voucher sale lines are deferred revenue in `v_sales_lines` (`is_deferred`); revenue is recognised on orders paid with the euro credit.
17. Price resolution: highest version valid at the moment; time-limited prices are higher versions with an end; `member` and `b2b` fall back to `public` when they have no valid version.
18. Best single discount: lowest unit price among base, member version, person price, member percentage and promotions; tie order person price, member version, member percentage, automatic promotion, code promotion. Fixed promotions are per unit and capped. Vouchers and memberships get no member pricing.
19. B2B pricing applies when an order has a `company_id`; only staff create company orders (admin, payment link, POS), never the portal; B2B orders get no member pricing.
20. Promotion `value` is an integer: whole percent (1-100) or cents. `applies_to` empty means all kinds except vouchers and memberships.
21. Promotion uses are reserved at order creation and released on expiry or cancel, so `max_uses` can never be exceeded by pending orders.
22. Pending orders and capacity reservations expire after 30 minutes; bank-transfer payments are excluded from that and are due in 14 days.
23. A payment marked expired by our own timeout may still become paid when Mollie says so; the customer's money always wins, and a lost seat becomes a customer-service task rather than an automatic refund.
24. Payment links are BEAM-hosted pages (`/[locale]/pay/<token>`, 14 days) that create a normal Mollie payment on click: one payment flow, metadata on every payment, works with Stripe and Viva. The adapter still implements `createPaymentLink`; the platform does not call it.
25. The webhook is authenticated by a secret query token (and Mollie's signature header where present); the fetch by id stays the real verification.
26. Every Mollie create call sends `Idempotency-Key` = the job key.
27. Refund allocation: credit-balance payments first (restored as euro credit), then provider payments largest first. Refund amounts default to pro rata unused units and can only be lowered. Refunds above €500 or on orders older than 365 days need the owner or finance role.
28. Bank transfers are recorded by finance (`invoices.issue`) or by finance's Billit sync through `recordBankTransferPaid`; credits and bookings are delivered only after payment.
29. Anonymous POS sales are allowed only for items and vouchers.
30. A chargeback creates a finance task and revokes nothing automatically.
31. Abandoned means 60 minutes without checkout activity with a known person or email; the scan runs every 10 minutes; checkouts expire after 30 days; recovery counts a paid order by the same person within 7 days containing one of the checkout's products. The recovery sequence uses purpose `newsletter` and runs only behind `ff_commerce_checkout_recovery` (R2).
32. Guest site checkout always quotes the `public` audience; member prices need a logged-in session.
33. Order references are `BO-` plus 8 random Crockford base32 characters, unique and retried on collision (no database sequence needed).
34. POS receipts are PDFs rendered with the PDF library Wave 0 installs (`@react-pdf/renderer`) from `ui/receipt-pdf.tsx`, plus an 80 mm print page.
35. Retention: checkouts 13 months; raw provider payloads 90 days; orders and payments 7 years (matching the architecture's invoice period), then the person link is removed; person prices 2 years after they end.
36. Default VAT rates: day sessions, day packages, memberships, tickets and items 21 %; nights and night packages 6 %; vouchers 0 %.
37. Stripe and Viva adapters ship in V1 as stubs that refuse to run without keys; the settings screen refuses to select them until keys exist.
38. Release 4 has no commerce package; `v_sales_lines` has no person columns so ops can expose it to the `ai` schema.
