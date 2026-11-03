# Module spec: commerce (catalogue, pricing, checkout, payments and front desk)

Owner paths: `packages/db/src/schema/commerce.ts`, `packages/db/src/schema/commerce.views.ts`, `packages/core/src/commerce/`, `packages/integrations/src/payments/` (adapters beside the Wave 0 interface and fake), `apps/web/modules/commerce/`, `apps/web/app/(admin)/admin/{products,orders,pos}/`, `apps/web/app/[locale]/(portal)/account/{shop,checkout}/` and `apps/web/app/[locale]/(portal)/account/orders/` (the architecture lists `{shop,checkout}`; `orders` is added because finance owns only `account/invoices`), `apps/web/app/[locale]/(site)/{checkout,pay,gift}/`, `apps/web/app/api/webhooks/mollie/route.ts` (a one-liner over platform's `handleWebhook`), `packages/email/src/templates/commerce/`, `packages/core/src/i18n/messages/*/commerce.json`, `packages/db/src/seed/commerce.ts`, `apps/web/e2e/commerce.spec.ts`. Paths written below as `e2e/commerce.spec.ts`, `server/...`, `ui/...` are relative to `apps/web/` and `apps/web/modules/commerce/`.

Blueprint sections: 13 (payments), 14 (point of sale), 45 (promotions), 46 (pricing), 47 (abandoned checkout), plus requirements found in 5 (timeline: purchases, promotions used), 7 and 8 (pricing of sessions and nights), 10 (portal purchases), 11 and 12 (package and membership sales), 15 (ticket prices, member and promotional pricing), 21 and 31 (abandoned checkout sequence), 38 (failed payments on the action dashboard), 39 and 43 (sales and payment-method reporting), 44 (referral incentives), 48 (revenue impact of cancellations: refunds and `refunds.lines` feed booking's `v_booking_outcomes`), 53 (purchase history: migrated by ops into `imported_history` kind `purchase`, never into `orders`; Lightspeed till history in R3 here), 56 (discount applied, refund issued in the audit log), 62 and 63 (payment data retention), 76 (pay, member discount, reporting acceptance tests), 77 (go-live: Mollie live key and webhook only after the gate), 87 (scenario 7 deletion reaches orders, payments, mandates and Mollie customers).

Cross-module contracts in this spec are aligned with the sibling specs: booking validates seats, inserts its `reserved` rows first under its session lock and then calls `createOrder` with one quantity-1 item per seat carrying `bookingIds: [bookingId]`, and commerce never calls booking inside `createOrder` (booking R18, cross-module D21); commerce orchestrates the paid transaction and calls one credits function per line (`credits.grantCredits` once per package unit, `activateMembership`, `applyRenewalPayment`; credits rule 1 and 10a); finance issues invoices and settles bank transfers (`finance.issueInvoice`, `commerce.recordBankTransferPaid`), platform owns the webhook inbox (`handleWebhook`, `webhook.process`), ops owns every report screen over commerce tables (revenue, abandoned checkouts), email owns the template registry, whose keys are `<m>.<name>` with `<name>` the snake_case file basename of commerce's own template files (`commerce.order_confirmation`, `commerce.pos_receipt`, `commerce.payment_failed`, `commerce.payment_link`, `commerce.gift_voucher`, `commerce.refund_confirmation`, `commerce.portal_invitation`, R2 `commerce.checkout_recovery`; cross-module D1 and D2).

## 1. Purpose and release mapping

Commerce turns "I want this" into a paid, VAT-correct, immutable order. It owns the catalogue, the price history, promotions, the pure `quote()`, checkout, orders, payments through `PaymentProvider`, refunds, mandates, gift vouchers, the reception POS and abandoned-checkout detection. When a payment is paid it orchestrates credits, booking, finance and email through their `api.ts` in one transaction. It never stores identity (that is `crm.persons`), credit balances (that is `credits`) or invoices (that is `finance`).

| Release | What commerce ships |
| --- | --- |
| **V1 (weeks 1-6)** | Products of all seven kinds with VAT, credit kind and units, validity, sharing defaults, member discount and recurring interval. Append-only `price_versions` per audience (`public`, `member`, `b2b`) with validity windows (time-limited pricing). `person_prices`. Promotions (percent, fixed, code or automatic, eligibility, dates, max uses, per-person limits). Pure `quote()` with `pricing_trace`. Gift vouchers (kind `voucher`, euro credits, codes, redemption). Portal shop and checkout, site checkout, BEAM-hosted pay page for payment links. Orders, immutable order lines, `client_key`. `PaymentProvider` with the Mollie adapter (Bancontact, cards, recurring mandates, terminal, refunds) and Stripe and Viva stub adapters, chosen per channel. `/api/webhooks/mollie`, `payments.sync`, forward-only payment state machine, the paid transaction, `payments.scan_expired`. Refunds with credit notes and ledger release or revoke. Failed-payment handling and the action-dashboard feed. Checkout tracking and abandoned detection every 10 minutes with `checkout.abandoned` and `checkout.completed` events (the recovery sequence stays a draft). Staff payment links and the order payment page that booking and credits send customers to. Payment-failed email with a retry link. Terms acceptance at checkout (versioned, through site's legal versions). Company invoice details at checkout (through finance). 14-day withdrawal for online purchases of undated services. Voucher expiry. Front-desk POS (terminal, cash, bank transfer, voucher redemption, PDF receipts, day close with cash count). Admin screens for products, prices, promotions, orders, refunds and POS. B2B price versions and staff orders for a company. WCAG 2.1 AA for shop, checkout, pay page and POS. |
| **Release 2 (weeks 9-10)** | Abandoned checkout recovery: resume links, recovery attribution (`recovered_order_id`, `recovery_message_id` set by automation through `markCheckoutRecoveryMessage`), the switch that activates the seeded `abandoned-checkout` sequence (flag `ff_commerce_checkout_recovery`). The recovery report screen (abandoned, recovered, recovery revenue) is ops' `/admin/reports/abandoned-checkouts` over ops' `v_abandoned_checkouts`, which reads the commerce columns. Ticket checkout with several ticket types per event in one order (events and ticketing extensions). |
| **Release 3 (weeks 11-12)** | Nightly import of Lightspeed food-and-drink sales CSV for reporting. Referral and partner promotion codes (`promotions.partner_company_id`) with partner revenue attribution. Sales and payment-method views for the management and finance dashboards (`v_sales_lines`, `v_lightspeed_daily`). |
| **Release 4 (weeks 13-14)** | No new commerce features. `v_sales_lines` (defined in R3) is exposed by ops in the read-only `ai` schema for natural-language questions; churn and repurchase indicators are ops. |
| **Later (out of scope)** | Stock levels, inventory adjustments, low-stock warnings and supplier data (blueprint 14 makes these conditional on "if physical inventory becomes relevant"; BEAM's merchandise is sold without stock tracking, so they are not built and come as a change proposal if BEAM needs them); a certified cash register (GKS) for food and drink, which stays on Lightspeed; selling food and drink in the platform; company-funded employee credit wallets; Apple Pay or wallet-specific flows beyond what Mollie Checkout offers; multi-currency. |

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
| `pos_day_closes_status` | `open`, `closed` |
| `orders_channel` | `portal`, `site`, `admin`, `pos`, `link`, `recurring` |
| `orders_status` | `draft`, `pending_payment`, `paid`, `cancelled`, `expired`, `refunded`, `partially_refunded` |
| `payments_provider` | `mollie`, `stripe`, `viva`, `cash`, `terminal`, `bank_transfer`, `credit_balance` (addition; credits' request for a value `voucher` is answered by this one value, because euro credit also comes from bonuses and refunds, not only vouchers) |
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
| uses_count | integer | no | 0; check `uses_count >= 0`. `max_uses` is enforced at reservation (rule 19), not by a check, because a payment that settles after local expiry re-confirms its redemption even when the code has since been used up (rule 28) |
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
| items | jsonb | no | `CartItem[]` without prices (see 4.1); readers take the product mix from `items[].productId` and `quantity` and never a unit price (cross-module D55) |
| promo_code | text | yes | (addition) |
| total_cents | integer | yes | quote total at the last save, set by commerce from the quote every time the checkout is saved; ops' `v_abandoned_checkouts` takes the checkout value from here (cross-module D55) (addition) |
| status | checkouts_status | no | `started` |
| locale | text | no | `nl-BE`, check in the three locales |
| utm | jsonb | yes | `{source, medium, campaign, term, content}` |
| landing_path | text | yes | path of the site page the buyer came from (`/nl/offers/day-pass`), from the `from` query parameter that site's buy links carry, else the same-origin `Referer` path; feeds `countOrdersByLanding` (R3) (addition) |
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
| expires_at | timestamptz | yes | pending orders: now() + 30 min, or the explicit `expiresAt` a caller passes for channel `admin` (booking's pay-at-desk orders expire at the session's `ends_at`, booking R63); null for `draft` and for bank-transfer orders (addition) |
| renewal_membership_id | uuid -> memberships.id | yes | set on membership renewal orders created by `createRecurringCharge` or `createRenewalLinkOrder` (addition) |
| renewal_period_end_on | date | yes | the period end the renewal pays for; set together with `renewal_membership_id` (addition) |
| terms_version_id | uuid -> page_versions.id | yes | the terms version the buyer accepted (`site.getCurrentLegalVersion(db, 'terms').versionId`); required for `portal`, `site` and `link` orders (addition) |
| withdrawal_until_at | timestamptz | yes | `paid_at + 14 days` for online orders with a package, membership or voucher line (rule 54) (addition) |
| pay_token_hash | text | yes | unique; payment link token sha256 (addition) |
| pay_token_expires_at | timestamptz | yes | (addition) |
| is_erased_subject | boolean | no | false (addition, set by erasure) |
| created_by_user_id | uuid -> users.id | yes | staff for `admin`, `pos`, `link` |
| note | text | yes | staff note, PII-capable |
| paid_at, cancelled_at | timestamptz | yes | |
| version | integer | no | 0; incremented on each status change |
| created_at, updated_at | timestamptz | no | now() |

Checks: `orders_person_chk`: `person_id is not null or company_id is not null or channel = 'pos' or is_erased_subject`; `orders_terms_chk`: `channel not in ('portal','site','link') or status = 'draft' or terms_version_id is not null`; `orders_renewal_chk`: `(renewal_membership_id is null) = (renewal_period_end_on is null)`. Partial unique `orders_renewal_uq` on `(renewal_membership_id, renewal_period_end_on) where renewal_membership_id is not null and status in ('pending_payment','paid')`, so a period has at most one live renewal order and dunning retries reuse it. Indexes: `(person_id, created_at desc)`; `(status, expires_at) where status = 'pending_payment'`; `(company_id) where company_id is not null`; `(paid_at) where paid_at is not null`; `(checkout_id)`.

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
| data | jsonb | no | `{}`; `{start_on?: "YYYY-MM-DD", voucher_id?: uuid, booking_ids?: uuid[]}` (addition; `start_on` is the future start of a membership or package from which the paid transaction computes the `startsAt` it passes to credits, rule 32; `booking_ids` are the `reserved` booking rows booking passed as `items[].bookingIds`, cross-module D21) |
| created_at | timestamptz | no | now() |

Check `order_lines_session_chk`: product_kind in (`session`,`night`,`ticket`) implies session_id not null, quantity = 1 (one line per seat; booking R18) and `data->'booking_ids'` is either absent or an array of exactly one element. One `booking_ids` element is required for every channel except `pos` (POS walk-in lines get their booking afterwards through `booking.createBookingForPosLine`, rule 21); because a check constraint cannot read `orders.channel`, `createOrder` enforces the presence part with `validation` before anything is written, and the check enforces quantity 1 and at most one element (cross-module D21). The booking row also links to the line through `bookings.order_line_id`, which booking sets from the returned `lineIds`; the line stores no attendee id (the attendee is the booking row's `person_id`).

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
| deliver_on | date | yes | chosen delivery date of the gift email (Brussels), max 365 days after purchase; null = at payment (addition) |
| email_message_id | uuid -> email_messages.id | yes | the latest voucher email, so a refund before delivery can cancel it (addition) |
| status | vouchers_status | no | `pending` |
| expires_at | timestamptz | yes | activated_at + product.validity_days |
| activated_at | timestamptz | yes | |
| redeemed_by_person_id | uuid -> persons.id | yes | PII link |
| redeemed_at | timestamptz | yes | |
| credit_grant_id | uuid -> credit_grants.id | yes | the euro grant created on redemption |
| voided_reason | text | yes | set with status `void` |
| created_at, updated_at | timestamptz | no | now() |

Vouchers rows are inserted at order creation (status `pending`, one row per unit of a voucher line, `data.voucher_id` on the line when quantity is 1). Index `(status, expires_at) where status = 'active'`. Code guessing is limited through platform's `rate_limits` (keys `voucher:ip:<ip>` and `voucher:person:<id>`), so `failed_attempts` is not needed and is not created.

**`pos_day_closes`** (addition, mutable until closed): id; business_day_on date not null unique; status pos_day_closes_status not null default `open`; expected_cash_cents integer not null default 0 (cash payments minus cash refunds of the day); counted_cash_cents integer null; difference_cents integer null (`counted - expected`); totals jsonb not null default `{}` (`{terminal, cash, bank_transfer, credit_balance, refunds, orders}` in cents and counts, frozen at close); note text null (required when `difference_cents <> 0`); closed_by_user_id -> users.id null; closed_at timestamptz null; created_at, updated_at. No PII (`NO_PII_TABLES`). Blueprint 14 "payment registration" and "sales reporting" at the counter: reception counts the drawer at closing time and the difference is visible to finance.

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

- No recovery view in commerce: ops defines `v_abandoned_checkouts` (V1 view, R2 screen) directly over `checkouts`, `orders` and `payments`. Commerce guarantees the columns it reads: `abandoned_at`, `abandoned_reason`, `recovery_message_id`, `recovered_order_id`, `recovered_at`, `items`, `utm`, `locale`.
- Revenue reporting (acceptance "reports reflect the transaction") is ops' `v_revenue_daily` over `orders`, `order_lines`, `products` and `refunds`. Commerce guarantees: `paid_at` is set exactly once by the paid transaction, status is one of `paid`, `partially_refunded`, `refunded` afterwards, and `refunds.status = 'refunded'` only once money has left.
- `v_sales_lines` (R3, defined in commerce-P9): one row per order line of a paid, partially refunded or refunded order: `paid_at`, `business_day_on` (`(paid_at at time zone 'Europe/Brussels')::date`), `channel`, `product_kind`, `product_id`, `line_total_cents`, `vat_cents`, `net_cents`, `refunded_cents` (sum from `refunds.lines`), `is_deferred` (true for `voucher` lines: multi-purpose voucher money is a liability, not revenue), `payment_methods` (array of providers on the order). No person columns, so it can be exposed to the `ai` schema.
- `v_lightspeed_daily` (R3): `business_day_on`, `category`, `sum(total_cents)`, `sum(vat_cents)`, `count(distinct receipt_number)`.

### 2.4 Tables of other modules this module reads or writes

| Table (module) | Access | How |
| --- | --- | --- |
| `persons`, `companies`, `v_person_status` (crm, credits) | read | `crm.findOrCreatePersonByEmail` (with `acquisition.referral_code` from `site.readReferralCode()` when checkout creates the person, rule 26), `crm.createPersonWithoutEmail`, `crm.getPersonStatus`, `crm.isInSegment` (never a `matchesSegment`), `crm.getCompany`, `crm.searchPersons` (POS picker) |
| `tasks` (crm) | write through api | `crm.createTask` (chargebacks, failed refunds) |
| `activity_events`, `audit_log`, `jobs`, `settings`, `files`, `webhook_events`, `integration_calls`, `feature_flags`, `rate_limits` (platform, crm) | write through helpers | `ctx.recordEvent`, `ctx.audit`, `ctx.enqueue`, `handleWebhook` plus `defineWebhookHandler` (inbox and `webhook.process`), `storeFile`, `getSetting`, `rateLimit` |
| `sessions`, `ticket_types`, `bookings` (booking) | read, and write through api | `booking.getAvailability(db, {sessionId, ...})` (object input, Wave 0 contract), the `reserved` rows booking passes as `items[].bookingIds` (stored in `order_lines.data.booking_ids`), `booking.confirmBookingsForOrder`, `booking.releaseBookingsForOrder`, `booking.cancelBookingsForOrderLine`, `booking.createBookingForPosLine` (POS walk-in lines in `posSell`), `booking.listBookableSessions` (cross-module D21) |
| `credit_grants`, `credit_entries`, `memberships` (credits) | read `memberships.id`; write through api | `credits.grantCredits` (package units, voucher redemption, partial euro refunds), `credits.activateMembership`, `credits.applyRenewalPayment`, `credits.applyRenewalFailure`, `credits.cancelMembershipForRefund`, `credits.consumeCredits` and `credits.releaseCredits` (kind `euro`, ref `{type: 'order'}`), `credits.getEuroBalance`, `credits.getGrantUsage`, `credits.revokeGrantRemainder`, `credits.getMembershipForPerson`, `credits.canStartMembership`; R3 `credits.onOrderPaidForReferrals`, `credits.onOrderRefundedForReferrals` |
| `invoices` (finance) | write through api | `finance.issueInvoice`, `finance.issueCreditNote`, `finance.markCreditNoteSettled`, `finance.setOrderBillingDetails`, `finance.getInvoiceForOrder` |
| `email_messages` (email) | write through api | `email.sendTransactional` (with `sendAt` for dated gift vouchers; commerce stores the returned `emailMessageId`), `email.cancelScheduledMessage`, R2 `email.findLatestMessage` |
| legal versions (site) | read and write through api | `site.getCurrentLegalVersion(db, 'terms')`, `site.recordTermsAcceptance(tx, ctx, {personId, versionId, context: 'checkout', refType: 'order', refId, ip})` |

Settings keys commerce declares, seeds and reads (rows in platform's `settings`; top-level snake_case keys with snake_case fields, declared once in `apps/web/modules/commerce/config.ts` with their Zod schema and default, listed in platform's settings register and edited only through platform's `updateSetting`, from the generic editor `/admin/settings/[key]`; commerce calls no `setSetting`; Convention 3, cross-module D17): `payment_provider_by_channel` = `{portal:"mollie", site:"mollie", admin:"mollie", pos:"mollie", link:"mollie", recurring:"mollie"}`; `commerce` = `{order_expiry_minutes: 30, checkout_abandon_minutes: 60, checkout_expiry_days: 30, recovery_window_days: 7, pay_link_days: 14, bank_transfer_due_days: 14, draft_expiry_days: 30, max_voucher_attempts_per_hour: 5, refund_second_permission_above_cents: 50000, refund_second_permission_after_days: 365, withdrawal_days: 14, voucher_expiry_warning_days: 30, pos_cash_float_cents: 15000, pos_terminals: [{id:"term_xxx", name:"Reception"}], receipt_footer: LocalizedText}`. Settings are validated by a Zod schema `CommerceSettings` in `packages/core/src/commerce/schemas.ts`, which `config.ts` registers with the defaults above (and `PaymentProviderByChannel` for the other key); `getSetting` returns these defaults when no row exists. Commerce reads booking's `business_hours` setting (through `getSetting`) only to label the POS business day; it adds no opening-hours or holiday logic (closed days are booking's sessions).

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
8. Candidate unit prices per line: (a) base; (b) `member` price version if the person is a member; (c) valid person price; (d) base minus `member_discount_pct` of the product (or the membership's `discount_pct` when the product has none) if the person is a member and the audience is not `b2b`; (e) base minus each applicable promotion (code or automatic). The lowest candidate wins. Discounts never stack. "Member" means `credits.getMembershipForPerson(db, personId).isMember` (an `active` or `past_due` membership), never the crm status override; `discountPct` comes from the same call.
9. Ties are broken in the order person price, member price version, member discount, automatic promotion, code promotion, so a promotion use is not consumed when it gives nothing extra.
10. Percent discount per unit = `round_half_up(base * pct / 100)`; a fixed promotion takes `value` cents off each unit, capped at the unit price. Line discount = per-unit discount times quantity.
11. VAT per line = `round_half_up(line_total_cents * rate / (100 + rate))`; order totals are sums of lines. Prices are VAT included.
12. Vouchers and memberships are never discounted by member pricing; promotions reach them only when listed explicitly in `applies_to.product_ids`.
13. A code that is unknown, inactive, outside its dates, exhausted, not eligible or not better returns the quote with a warning (`promo_unknown|promo_inactive|promo_expired|promo_exhausted|promo_not_eligible|promo_not_better`) and the order still proceeds without it.
14. `pricing_trace` holds: `at`, audience, base version id and amount, every candidate with its source id, amount and reason, the winner, rounding inputs and the person status used. It is stored verbatim on `order_lines.pricing_trace`.
15. A paid order never changes: lines are immutable and point to the price version used. Later price edits affect only new quotes.
16. The order is priced at creation. A checkout re-quotes on every step; if the total differs from `checkouts.total_cents` the page shows "The price changed" with the new total before the customer can pay.

Promotions
17. Eligibility is evaluated before `quote()` and passed in as a boolean per promotion: active, `starts_at <= now < ends_at`, channel in `eligibility.channels` (when set), person status (`crm.getPersonStatus(db, personId).status`, which respects a staff override) in `eligibility.statuses` (when set), `crm.isInSegment(db, segment_id, personId)` (when set), `first_order_only` means no earlier paid order, and per-person count of non-released redemptions below `max_uses_per_person`. Anonymous buyers are eligible only for promotions without segment, status or first-order rules.
18. Once `uses_count > 0`, `kind`, `value` and `applies_to` are locked; only `name`, `ends_at`, `max_uses` (not below `uses_count`), `max_uses_per_person` and `is_active` can change.
19. Creating an order with a winning promotion locks the promotion `FOR UPDATE`, checks `uses_count < max_uses` and the person's non-released redemptions `< max_uses_per_person`, increments `uses_count` and inserts a `reserved` redemption. Paid confirms it; expired or cancelled releases it and decrements `uses_count`. A payment that settles after the order expired re-confirms the released redemption and increments `uses_count` again, even above `max_uses` (the customer paid the discounted price); the promotion detail shows such overruns. A refund never releases a confirmed redemption.

Checkout and orders
20. Every order has a `client_key` from the form. A second submit with the same key returns the existing order and its open `checkout_url` instead of creating anything.
21. Commerce never decides capacity itself; booking does (cross-module D21). Session, night and ticket lines reach `createOrder` only from booking (booking R18: booking has validated eligibility and capacity and inserted one `reserved` row per seat under its session lock before the call) and from `posSell`. Each such line has `quantity = 1`; a booking-originated item carries `bookingIds: [bookingId]` (exactly one id, stored in `order_lines.data.booking_ids`). A line with quantity above 1, or without exactly one booking id on any channel other than `pos`, is refused with `validation` before anything is written. `createOrder` never calls booking: it returns `lineIds` in item order, and booking sets `order_line_id`, `reserved_until` and its own pay-at-desk marker on its rows in the same transaction. The portal shop and the site checkout sell only packages, memberships, vouchers and items; their session links lead to booking's screens. At the POS, `createOrder` writes a walk-in session or ticket line without booking ids, and `posSell` then calls `booking.createBookingForPosLine(tx, ctx, {orderLineId, sessionId, personId})` per such line in the same transaction; booking checks eligibility and capacity under its session lock and inserts a `reserved` row (returns `{bookingId}`). A `ConflictError` from booking (`session_full`, `member_only`, `already_booked`) rolls the whole sale back and is returned as `conflict: sold_out` (with booking's reason). The paid transaction confirms all these rows (rule 32).
22. Pending orders expire 30 minutes after the last payment was created (`settings.commerce.order_expiry_minutes`). An `admin` order created with an explicit `expiresAt` (booking's pay-at-desk orders, `expiresAt = session.ends_at`, booking R63) keeps that expiry and is not extended by new payments. Expiry calls `booking.releaseBookingsForOrder(tx, ctx, {orderId, reason: 'payment_expired'})`, `credits.releaseCredits(tx, ctx, {ref: {type: 'order', id: orderId}, reason: 'order_expired'})` when euro credit was used, releases promotion redemptions, voids `pending` vouchers and writes `order.expired`. A failed payment on an order nobody retries ends the same way at expiry; booking's `bookings.expire_reservations` is only its safety net.
22a. Staff orders (`createStaffOrder`) start as `draft`: no expiry, no promotion reservation, no invoice. Choosing a payment path (POS, payment link, bank transfer) re-quotes, reserves the promotion and moves the order to `pending_payment`. A draft untouched for 30 days (`draft_expiry_days`) is set `cancelled` by `payments.scan_expired`.
22b. Cancelling (`cancelOrder`, staff action and api) works on `draft` and `pending_payment` orders: releases bookings (`booking.releaseBookingsForOrder` reason `order_cancelled`), euro credit, promotion redemptions and pending vouchers like expiry, sets `cancelled_at`, writes `order.cancelled` and returns `{cancelled: true}`. An order that is not cancellable (any other status, or a provider payment `open`, `pending` or `authorized`; an open `bank_transfer` payment does not block and becomes `cancelled`) makes the api return `{cancelled: false}`; it never throws for a non-cancellable status (cross-module D31), and the staff action reports it as `conflict: payment_in_progress` (live provider payment) or `conflict: invalid_transition`; when the order has an `open` bank-transfer invoice, the same transaction calls `finance.issueCreditNote(tx, ctx, {orderId, reason, noRefund: true})`, so the order and its invoice are cancelled together (finance rule 25). A finance manual credit note that fully credits an open bank-transfer invoice calls `commerce.cancelOrder(tx, ctx, {orderId, reason})` inside finance's own transaction; `issueCreditNote` is idempotent on (order, reason), so the nested call issues one credit note, and on `{cancelled: false}` finance fails its action with `finance.errors.order_not_cancellable`.
22c. Renewal orders (credits rules 48-53): `createRecurringCharge` creates the period's renewal order (channel `recurring`, the plan's `public` price version valid at creation, no promotion, no member pricing, `renewal_membership_id` and `renewal_period_end_on` set) or, on a dunning retry, reuses the live one found through `orders_renewal_uq`, then inserts a new `recurring` payment and enqueues `payments.charge_recurring`. `createRenewalLinkOrder` creates the same order with channel `link` and a pay link, idempotent per membership and period. Renewal orders do not expire after 30 minutes (`expires_at` = period end + 10 days, the dunning end); credits ends them through `cancelRenewalOrder`, which is `cancelOrder` without the `payment_in_progress` refusal: an open recurring payment is cancelled at the provider by the job `payments.cancel` (`provider.cancelPayment`), and a provider `paid` that still arrives for a cancelled renewal order is refunded in full automatically (refund reason `order_cancelled`).
23. A customer may retry payment on a `pending_payment` order that has not expired; each retry is a new `payments` row. At most one payment per order is non-final at any time.
24. An order with `total_cents = 0` (100 % promotion, person price 0) or fully covered by euro credit is paid in the creating transaction without a provider call. finance issues no invoice for a 0 total (finance rule 3), so no invoice exists for it; an order paid fully with euro credit gets a normal invoice (VAT is due at redemption, credits rule 65).
25. Euro credit (from vouchers, bonuses or refunds) can pay part or all of an order: a `credit_balance` payment is created and paid in the order transaction through `credits.consumeCredits(tx, ctx, {personId, beneficiaryPersonId: personId, kind: 'euro', units: amountCents, ref: {type: 'order', id: orderId}})` (credits rule 20; available balance from `credits.getEuroBalance`). The rest goes to the provider. If the order expires or is cancelled, `credits.releaseCredits(tx, ctx, {ref: {type: 'order', id: orderId}, reason: 'order_expired'})` gives it back (credits allows only `order_expired` and `refund` for order refs, so a cancellation uses `order_expired` too) and the `credit_balance` payment becomes `cancelled`. Finance snapshots a `credit_balance` payment as `payment_method = 'voucher'` (`'mixed'` with a provider payment, finance rule 8); commerce keeps the one provider value.
26. Portal orders use the logged-in person. Site orders require an email; `crm.findOrCreatePersonByEmail` resolves the person and never overwrites existing names. When checkout creates the person, it passes `acquisition.referral_code` from `site.readReferralCode()` (site's `beam_ref` cookie) in the `acquisition` argument, and crm resolves it (cross-module D18). After payment the site buyer receives the `commerce.portal_invitation` magic-link email.
26a. Terms: `placeOrder` for `portal` and `site`, and the pay page for `link` orders, require the checkbox and call `site.getCurrentLegalVersion(db, 'terms')`; the order stores `terms_version_id` and the action calls `site.recordTermsAcceptance(..., context 'checkout', refType 'order')` in the same transaction. When no terms version is published, checkout refuses with `terms_unavailable` in every environment; the site seed publishes a demo terms page in `beam_dev`, so tests and previews always have one (site edge case 28 asks the same for production). POS and admin orders are exempt (the receipt footer names the terms URL). Portal orders created by booking through `createOrder` take their acceptance from booking (booking R62 records it in the booking transaction): `createOrder` stores the current version as `terms_version_id` and records nothing itself; the later order payment page does not ask again for the same version.
26b. Company invoice: the checkout offers "Invoice to a company" (company name, VAT number, address); the details are stored through `finance.setOrderBillingDetails(tx, ctx, {orderId, details})` in the `placeOrder` transaction. The POS basket has the same "Invoice to a company" toggle: `posSell` and `posPayOrder` take `billingDetails` and call `finance.setOrderBillingDetails` in their transaction before any payment is created (cash, terminal or bank transfer), so the invoice that the paid transaction or the bank-transfer placement issues carries the company. The audience stays `public` (B2B prices need a staff order with `company_id`, rule 7).
26c. Memberships: `getQuote` (so on every checkout step and POS basket change) calls `credits.canStartMembership(db, personId, {startsOn: item.startOn})` for a membership line and returns the warning `already_member` or `pending_exists`; `placeOrder`, `posSell` and `createStaffOrder` refuse such a basket with `conflict` (same reason). `credits.activateMembership` stays the last guard in the paid transaction.
27. Session and night products are pay-per-visit and always carry a `session_id`; multi-visit bundles are packages.

Payments
28. Status moves forward only, along the payment transition table of section 3.1. `nextPaymentStatus()` returns null for any pair not in the table, and `applyProviderStatus()` then changes nothing; every applied change is appended to `status_history`. One exception: a payment set to `expired` with source `local_timeout` may still become `paid` when the provider reports paid, and its order moves `expired -> paid`.
29. The provider is chosen by `settings.payment_provider_by_channel[order.channel]`. Cash, bank transfer and credit balance are local providers and never call out.
30. The webhook body is never trusted: `payments.sync` fetches the payment by id from the provider, and that fetch is the verification.
31. An order becomes `paid` when the sum of paid payments reaches `total_cents`. The paid transaction runs once per order, guarded by `SELECT ... FROM orders WHERE id = $1 FOR UPDATE` and `status = 'pending_payment'`.
32. The paid transaction (`finalizePaidOrder`), in one database transaction, in this order: order `paid` with `paid_at` (and `withdrawal_until_at`, rule 54); mandate upsert when the payment carries one; promotion redemption `confirmed`; then one credits call per line (credits rules 1, 45, 49): a package line calls `credits.grantCredits(tx, ctx, {personId, kind: products.credit_kind, units: products.credit_units, source: 'purchase', productId, orderLineId, lineUnitIndex: n, unitValueCents, vatRatePct, startsAt, expiresAt, key: 'grant:order_line:<order_line_id>:<n>'})` once per unit n = 1..`order_lines.quantity`, where `startsAt` = `order_lines.data.start_on` at 00:00 Europe/Brussels when set, else `orders.paid_at`, and `expiresAt` = `computeExpiresAt(startsAt, products.validity_days)` from `@beam/core/credits` (cross-module D24; credits reads nothing from `order_lines.data`, and there is no per-line `credit_units` override); a membership line calls `credits.activateMembership(tx, ctx, {personId, productId, orderId, priceVersionId, mandateId, startsAt})`; a renewal order (`renewal_membership_id` set) calls `credits.applyRenewalPayment(tx, ctx, {membershipId: renewal_membership_id, orderId})` instead; voucher lines create no grant (rule 45); `booking.confirmBookingsForOrder(tx, ctx, {orderId})` when any line is a session, night or ticket line (online, payment link and POS alike; returns `{confirmedBookingIds, unavailableOrderLineIds}`); voucher lines -> vouchers `active` with `activated_at` and `expires_at`; item lines -> nothing; from R3 `credits.onOrderPaidForReferrals(tx, ctx, {orderId})`. Then `finance.issueInvoice(tx, ctx, {orderId, status: 'paid', paymentId})`, always, also when an `open` bank-transfer invoice exists (finance settles that invoice and returns it with `status: 'existing'`, finance rule 2a; no invoice is issued for 0 totals, finance rule 3), the `order.paid` and `promotion.redeemed` events, and `email.sendTransactional` for `commerce.order_confirmation` (non-POS orders, key `order:<order_id>:receipt`) or `commerce.pos_receipt` (POS orders with a buyer email, receipt PDF attached, same key) and, per voucher, `commerce.gift_voucher` through the job `commerce.issue_voucher_email` (rule 45a). Lines that `confirmBookingsForOrder` returns as `unavailableOrderLineIds` (seat gone after a late payment) are handed to the job `commerce.refund_unavailable_lines` (key `refund_unavailable:<order_id>`), which runs `refundOrderLine` with reason `seat_no_longer_available` for each, so the money goes back without staff work.
33. A payment that ends `failed`, `expired` or `cancelled` writes `payment.failed` (with `reason`) on the person's timeline, calls `credits.applyRenewalFailure(tx, ctx, {membershipId: renewal_membership_id, paymentId, reason})` when the order is a renewal order (credits starts or continues dunning there; nothing is called for other orders), marks the checkout `abandoned_reason`, sends `commerce.payment_failed` with a retry link to the order payment page (key `payment:<payment_id>:failed`; not for renewal orders, whose reminder credits sends, and not for POS) and shows on the action dashboard feed for 7 days unless the order is paid later.
34. A payment `open`, `pending` or `authorized` for more than 15 minutes (not bank transfer) appears on the feed, and `payments.scan_expired` raises the architecture's High alert through `notifySlack(ctx, {fingerprint: 'commerce:payment_pending_15m', severity: 'high', text})` with counts and ids only (platform sends one per fingerprint per hour). Dead `payments.*` jobs alert through the platform dead-job path. Mollie webhook silence is platform's check (PL-75). Of the PL-75a "payment failures" row, commerce owns the 15-minute pending check and the dead `payments.*` jobs; the "3 failed renewals a day" count is credits' (`applyRenewalFailure`, credits rule 50a), because only credits knows which failure is a renewal attempt; both alert through `notifySlack()`. These are the payment signals behind the Critical SLA class "payments not working".
35. A chargeback reported by the provider sets `chargeback_cents`, writes `payment.charged_back`, creates a task through `crm.createTask(tx, ctx, {title, kind: 'payment', ownerRole: 'finance', personId, source: 'system', ref: {type: 'payment', id}, dedupeKey: 'chargeback:<payment_id>'})` and revokes nothing automatically.

Refunds
36. Refundable amount of an order = paid minus already refunded. A refund is for chosen lines and quantities; the default amount per line is pro rata to unused units; staff with `commerce.refund` may lower it, never raise it above the paid line total.
37. Credit effects: a package line is planned from `credits.getGrantUsage(db, orderLineId)` and calls `credits.revokeGrantRemainder(tx, ctx, {orderLineId, grantIds, refundId, reason: 'refund'})` (credit action `revoke`; used units are never revoked, so a used package can be refunded only for its remaining units; `grantIds` names the refunded units' grants, one grant per unit); a session, night or ticket line cancels its booking through `booking.cancelBookingsForOrderLine(tx, ctx, {orderLineId, reason: 'refunded'})` unless booking itself started the refund (rule 37a); a membership line calls `credits.cancelMembershipForRefund(tx, ctx, {membershipId, reason})` in the refund transaction (immediate cancel, unused current-period inclusion units revoked by credits, credits rule 27a), with a default amount pro rata to the unused days of the current period; a voucher can be refunded only while `active` and unredeemed, and becomes `void` (a scheduled, undelivered voucher email is cancelled through `email.cancelScheduledMessage(ctx, {messageId: vouchers.email_message_id})`). From R3 every refund also calls `credits.onOrderRefundedForReferrals(tx, ctx, {orderId, refundId})`.
37a. `refundOrderLine(tx, ctx, {orderLineId, reason})` is the api booking calls for an in-policy cancellation (`cancelled_in_policy`) or a session BEAM cancelled (`session_cancelled`), and commerce uses for `seat_no_longer_available`. It refunds the full line total, needs no staff permission (the caller's rules decide), never calls booking back, and is idempotent per line and reason (key `refund_line:<order_line_id>:<reason>`). A line already fully refunded returns the existing refund.
38. A refund goes first back to `credit_balance` payments, then to provider payments, largest first. Euro credit is restored in the refund transaction: when the refund returns the whole `credit_balance` amount of the order, through `credits.releaseCredits(tx, ctx, {ref: {type: 'order', id: orderId}, reason: 'refund'})` (the original grants and expiry come back); when it returns only part of it, through `credits.grantCredits(tx, ctx, {personId, kind: 'euro', units: <cents>, source: 'manual', refundId, vatRatePct: null, expiresAt: null, key: 'grant:refund:<refund_id>', reason: 'partial_refund'})` (multi-purpose VAT, kept on erasure, credits rule 20a; cross-module D25), because `releaseCredits` has no `amountCents`: each release mirrors exactly one consume and releases the whole ref. A later full refund of the same order then releases only the not yet restored remainder the same way (grant), never twice. Cash refunds are paid at the counter and are `refunded` at once; bank-transfer refunds are `sent` until staff confirm.
39. Every refund issues one credit note through `finance.issueCreditNote(tx, ctx, {orderId, refundId, reason, lines: [{orderLineId, quantity, amountCents}]})` in the refund transaction (`refunds.lines` mapped to finance's `CreditNoteLineInput`), writes `order.refunded` and an audit row `refund.issued` (staff refunds), and sets the order to `partially_refunded` or `refunded`. When a refund reaches `refunded`, commerce calls `finance.markCreditNoteSettled(tx, ctx, {refundId, settledAt})` and sends `commerce.refund_confirmation` (key `refund:<refund_id>:confirmation`). A refund on an order without invoice (0 total) issues no credit note.
40. A refund above €500 (`refund_second_permission_above_cents`) or on an order older than 365 days also requires `invoices.issue`, checked with `ctx.require('invoices.issue')` (owner, technical_admin, management and finance by default); others get `forbidden`.

Payment links, POS and vouchers
41. A payment link is a BEAM-hosted page `/[locale]/pay/<token>` for one `pending_payment` order with `channel = link`. The token is derived, not random: `base64url(HMAC-SHA256(VOUCHER_CODE_SECRET, 'pay:' + order_id + ':' + pay_token_expires_at epoch seconds))` (32 bytes; the `pay:` label keeps it apart from voucher codes), stored only as sha256 in `pay_token_hash`, valid 14 days (`pay_link_days`), single order. Because it can be derived again, `getPayLinkForOrder` returns the same URL to every caller while it is valid (credits' dunning reminders, staff resend) and issues a new expiry, and so a new token, only after it expired. Opening it after expiry or after payment shows the matching state, never a payment form. Renewal orders (`createRenewalLinkOrder`, credits rule 52) and the pay links of dunning (credits rule 50) use this page.
42. POS sales are `channel = pos`. Session, package, membership and ticket sales need a person; item and voucher sales may be anonymous.
43. POS payment methods: terminal (Mollie Terminal API, inline job), cash (paid immediately, `cash_received_cents >= amount`, change shown), bank transfer (a `bank_transfer` payment `open` with `expires_at` = today + `bank_transfer_due_days` (14) at 23:59 Brussels, and in the same transaction the invoice through `finance.issueInvoice(tx, ctx, {orderId, status: 'open', dueOn: <that expires_at as YYYY-MM-DD Brussels>, paymentId})`, so commerce's overdue feed and finance's invoice show the same due date; credits are delivered only when finance reports the transfer paid through `commerce.recordBankTransferPaid(tx, ctx, {orderId, paidOn, reference})`). Bank transfer is refused for orders with session, night or ticket lines (a seat cannot wait 14 days). Staff orders paid by bank transfer follow the same path from `/admin/orders/[id]`.
43a. `recordBankTransferPaid(tx, ctx, {orderId, paidOn, reference})` is idempotent on the order: under the order row lock it settles the open `bank_transfer` payment (`paid`, `paid_at = paidOn` 12:00 Brussels, amount = the order's `due_cents`, `raw = {reference}`) and runs the paid transaction, whose `issueInvoice` call returns the open invoice, now settled, with `status: 'existing'` (finance rule 2a, 02-data-model DM-3); a second call for a paid order, or for a `cancelled` order, changes nothing and returns. The amount check is finance's (Billit must report at least the amount due, finance rule 26), so commerce never sees a short payment. Commerce has no own "record bank transfer" action: staff mark the open invoice paid in finance (`markInvoicePaid`), which calls this function.
44. A POS receipt PDF (`files.kind = receipt`) is rendered for every paid POS order and can be printed or emailed.
45. Voucher codes are 12 characters of Crockford base32 in groups of four (`BEAM-XXXX-XXXX-XXXX`), derived as `HMAC-SHA256(VOUCHER_CODE_SECRET, 'voucher:' + voucher_id)` truncated to 60 bits, and stored only as sha256 plus the last four. The voucher email job and the staff "resend voucher" action derive the code again; the plain code is never stored. Redemption locks the voucher `FOR UPDATE`, requires `status = 'active'` and `expires_at > now()`, grants euro credits of `amount_cents` to the redeemer through `credits.grantCredits(tx, ctx, {personId: <redeemer>, kind: 'euro', units: amount_cents, source: 'voucher', orderLineId: vouchers.order_line_id, voucherId, unitValueCents: 1, expiresAt: vouchers.expires_at, key: 'grant:voucher:<voucher_id>'})` (credits sets `vat_treatment = multi_purpose`, credits rule 1a), stores the returned `grantId` in `vouchers.credit_grant_id` and sets the voucher `redeemed`. A voucher is redeemable once. The purchaser receives no euro credit at payment: the paid transaction makes no credits call for `voucher` lines.
45a. Voucher delivery: the buyer may choose a delivery date (`CartItem.voucher.deliverOn`, today to 365 days ahead, stored in `vouchers.deliver_on`). `commerce.issue_voucher_email` renders the voucher PDF and calls `email.sendTransactional(ctx, {template: 'commerce.gift_voucher', to: recipient_email ?? purchaser email, personId: purchaser_person_id, locale, data, key: 'voucher:<voucher_id>:email:<n>', attachments: [{fileId, filename: 'BEAM-gift-voucher.pdf'}], sendAt: deliver_on 09:00 Europe/Brussels when in the future})` and stores the returned `emailMessageId` in `vouchers.email_message_id`. A voucher refunded or voided before a scheduled email went out calls `email.cancelScheduledMessage(ctx, {messageId: email_message_id})` in that transaction; the purchaser's order page shows "Scheduled for <date>".
46. Vouchers are valid at least 730 days (product check). VAT is not charged on the voucher sale (multi-purpose voucher, usable for 6 % and 21 % services); VAT is charged on the lines bought with the euro credit.
47. Five failed code attempts per IP or per person per hour (`rateLimit(tx, {key: 'voucher:ip:<ip>' | 'voucher:person:<id>', limit: 5, windowSeconds: 3600})`) block further attempts for the rest of the window (`rate_limited`). A successful redemption does not count.
47a. `commerce.expire_vouchers` (daily 00:20) sets `active` vouchers with `expires_at <= now()` to `expired` and writes `voucher.expired`; it writes `voucher.expiring { days: 30 }` once per voucher (dedupe `voucher:<id>:expiring:30`) for the purchaser so an automation can remind them. Expired vouchers stay listed on the purchaser's orders page and in the liability count of finance (R3).

Abandoned checkout
48. A checkout row is created when the customer opens the checkout step with at least one item; every step updates `last_activity_at`, `items`, `total_cents`.
49. `checkouts.mark_abandoned` (every 10 minutes) sets `abandoned` on `started` checkouts with `last_activity_at` older than 60 minutes and a known person or email, with reason `payment_failed` or `payment_expired` when its last order's payment ended so, else `left`. It writes `checkout.abandoned` (`{checkout_id, total_cents, product_ids, channel, reason}`, dedupe `checkout:<id>:abandoned`) when a person is known. The checkout is chosen by `SELECT ... FOR UPDATE SKIP LOCKED` in batches of 500 so a concurrent `placeOrder` is never overwritten.
50. A checkout becomes `completed` when its order is paid (also from `abandoned`, when the customer comes back to the same checkout), writing `checkout.completed` (dedupe `checkout:<id>:completed`), which the automation uses as an exit; `expired` 30 days after creation if never completed (from `started` or `abandoned`). `completed` and `expired` are final.
51. (R2) A checkout is recovered when the same person pays an order within 7 days after `abandoned_at` that contains at least one of the checkout's products; `recovered_order_id`, `recovered_at` are set and `checkout.recovered` is written. Recovery revenue is that order's `total_cents`. `recovery_message_id` is written by automation through `commerce.markCheckoutRecoveryMessage(tx, {checkoutId, emailMessageId})` when its recovery step sends; the function sets it only while null. When the attribution runs and `recovery_message_id` is still null (the step sent but the link call failed or was retried), commerce fills it from `email.findLatestMessage(db, {personId, templateSlug: 'commerce.checkout_recovery', after: abandoned_at})` (email R2, cross-module D54), so attribution never depends on one call.
52. (R2) The abandoned-checkout sequence (automation's seeded `abandoned-checkout`, group `checkout`, `requires_flag = ff_commerce_checkout_recovery`) runs only while `ff_commerce_checkout_recovery` is `on`; it is a marketing automation with purpose `newsletter`, triggered by `checkout.abandoned` (data includes `total_cents`), so it reaches only people for whom `v_marketing_reachability` is true for that purpose. Both reminders (`remind_1h`, `remind_24h`) send the registry template `commerce.checkout_recovery` as a marketing message (reachability for `newsletter` checked); commerce's `getCheckoutRecoveryProps` serves the template and automation calls `commerce.markCheckoutRecoveryMessage` (cross-module D54).

Lightspeed (R3)
53. A Lightspeed CSV is imported idempotently: `external_line_key` unique, so a re-upload of the same day adds nothing. Rows are reporting data only; they create no orders, persons or invoices.

Consumer law, front desk and accessibility (hidden requirements the blueprint leaves out)
54. Right of withdrawal (Belgian Code of Economic Law, art. VI.47): an online order (`portal`, `site`, `link`) with a package, membership or voucher line can be withdrawn within 14 days of `paid_at` (`withdrawal_until_at`). Dated services (session, night, ticket lines) are exempt (art. VI.53, 12°, leisure services on a specific date); checkout shows this per line. A withdrawal is a refund with reason `withdrawal` started by the customer from `/[locale]/account/orders/[id]` or by staff with `commerce.refund`: unused package units and an unredeemed voucher are refunded in full, used package units are deducted pro rata at the line's unit value. A membership line cannot be withdrawn by the customer alone: `withdrawOrder` creates a `payment` task for customer service (dedupe `withdrawal:<order_line_id>`), who refund the line here pro rata to the days elapsed with reason `withdrawal`; that refund cancels the membership at once through `credits.cancelMembershipForRefund` (rule 37). It needs no second permission (rule 40) and the order confirmation email and receipt carry the withdrawal notice and a link to the form. POS sales have no withdrawal right.
55. POS day close: `/admin/pos/day` shows the day's expected cash (`pos_cash_float_cents` plus cash payments minus cash refunds). Reception enters the counted amount; `closePosDay` freezes `totals`, stores the difference, requires a note when it is not 0 and writes audit `pos.day_closed`. A closed day accepts no more cash sales for that `business_day_on` (`conflict: day_closed`) until staff with `commerce.refund` reopen it (audit `pos.day_reopened`). A difference above €20 creates a finance task through `crm.createTask` (dedupe `pos_close:<YYYY-MM-DD>`).
56. Accessibility: the shop, checkout, return, pay, gift and POS screens meet WCAG 2.1 AA: every input has a visible label, errors are linked with `aria-describedby`, payment status changes are announced in an `aria-live="polite"` region, the whole checkout works by keyboard, touch targets are at least 44 px on the POS, colour is never the only status signal, and amounts are read with currency (`Intl.NumberFormat`). Playwright runs `@axe-core/playwright` on these pages in `e2e/commerce.spec.ts` and fails on serious or critical issues.

### 3.1 State machines

Each table is a pure transition map in `packages/core/src/commerce/state-machine.ts` (`nextOrderStatus`, `nextPaymentStatus`, `nextRefundStatus`, `nextVoucherStatus`, `nextCheckoutStatus`); server code updates a status only through these functions, inside a transaction holding `SELECT ... FOR UPDATE` on the row, and increments `orders.version` on every order change. Any pair not listed is refused (`conflict: invalid_transition`). `state-machine.test.ts` tests every listed pair and every unlisted pair.

| Machine | From -> to (trigger) |
| --- | --- |
| orders | `draft` -> `pending_payment` (payment path chosen, rule 22a); `draft` -> `cancelled` (staff, or 30-day draft expiry); `pending_payment` -> `paid` (paid transaction); `pending_payment` -> `expired` (`payments.scan_expired`); `pending_payment` -> `cancelled` (staff `cancelOrder`, credits dunning day 10, overdue bank transfer); `expired` -> `paid` (late provider `paid`, rule 28); `paid` -> `partially_refunded`, `paid` -> `refunded`, `partially_refunded` -> `refunded` (refunds). Final: `cancelled`, `refunded`. |
| payments | `open` -> `pending`, `authorized`, `paid`, `failed`, `expired`, `cancelled`; `pending` -> `authorized`, `paid`, `failed`, `expired`, `cancelled`; `authorized` -> `paid`, `failed`, `expired`, `cancelled`; `expired` (source `local_timeout` only) -> `paid`; `paid` -> `partially_refunded`, `refunded`; `partially_refunded` -> `refunded`. Final: `failed`, `cancelled`, `refunded`, and `expired` from the provider. |
| refunds | `pending` -> `sent` (provider accepted), `refunded` (cash, credit balance), `failed`; `sent` -> `refunded` (provider or staff confirm), `failed`; `failed` -> `pending` (staff Retry). Final: `refunded`. |
| vouchers | `pending` -> `active` (paid), `void` (order expired or cancelled); `active` -> `redeemed`, `expired` (`commerce.expire_vouchers`), `void` (refund, `voidVoucher`). Final: `redeemed`, `expired`, `void`. |
| checkouts | `started` -> `abandoned`, `completed`, `expired`; `abandoned` -> `completed`, `expired`. Final: `completed`, `expired`. |
| promotion_redemptions | `reserved` -> `confirmed` (paid), `released` (expired, cancelled); `released` -> `confirmed` (late paid). Final: `confirmed`. |
| mandates | `pending` -> `valid`, `invalid`; `valid` -> `invalid` (provider), `revoked` (erasure, staff). Final: `invalid`, `revoked`. |
| pos_day_closes | `open` -> `closed` (`closePosDay`); `closed` -> `open` (`reopenPosDay`). |

## 4. Server surface

### 4.1 Core types (`packages/core/src/commerce/`)

```ts
// schemas.ts
export const CartItem = z.object({
  productId: z.string().uuid(), quantity: z.number().int().min(1).max(50),
  sessionId: z.string().uuid().optional(), ticketTypeId: z.string().uuid().optional(),
  bookingIds: z.array(z.string().uuid()).optional(),   // booking-originated session, night and ticket lines: exactly one `reserved` booking id (booking R18, rule 21, cross-module D21); stored in order_lines.data.booking_ids
  amountCents: z.number().int().optional(),            // custom-amount voucher only
  startOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), // future start of a membership or package, max 90 days ahead
  voucher: z.object({ recipientName: z.string().max(120), recipientEmail: z.string().email().optional(), message: z.string().max(500).optional(),
    deliverOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).optional(),   // rule 45a, today .. +365 days
}).superRefine((i, c) => { /* sessionId set => quantity === 1 and bookingIds at most one element; createOrder requires exactly one except for channel 'pos' (rule 21) */ });
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
export function nextOrderStatus(current: OrderStatus, to: OrderStatus): OrderStatus | null;      // section 3.1 tables, same file
export function nextRefundStatus(current: RefundStatus, to: RefundStatus): RefundStatus | null;
export function nextVoucherStatus(current: VoucherStatus, to: VoucherStatus): VoucherStatus | null;
export function nextCheckoutStatus(current: CheckoutStatus, to: CheckoutStatus): CheckoutStatus | null;
export function withdrawalPlan(input: { lines: WithdrawalLineInput[]; paidAt: Date; at: Date }): WithdrawalPlan; // refunds.ts, rule 54
export const CommerceSettings: z.ZodType<CommerceSettingsValue>;            // schemas.ts, defaults of section 2.4
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
| `setPersonPrice`, `revokePersonPrice` | staff, `pricing.write` | `{personId, productId, amountCents, validFromAt?, validToAt?, reason}` / `{personPriceId}` | `{personPriceId}` | audit `person_price.set` / `.revoked`; event `person_price.set` |
| `createPromotion`, `updatePromotion` | staff, `pricing.write` | promotion columns, code upper-cased | `{promotionId}` | audit `promotion.created` / `.updated`; locked fields refused with `conflict` |
| `startCheckout` | customer or public | `{channel, items: CartItem[], locale, utm?, landingPath?, email?}` | `{checkoutId, quote}` | event `checkout.started` (when person known) |
| `updateCheckout` | customer or public | `{checkoutId, items?, promoCode?, email?}` | `{quote, priceChanged}` | none |
| `placeOrder` | customer or public | `{checkoutId, clientKey: uuid, useEuroCredit: boolean, acceptTerms: literal(true), billingDetails?: BillingDetailsInput (finance schema)}` | `{orderId, redirectUrl}` (provider URL, or the return page when total 0) | runs `payments.create` inline; records terms acceptance (rule 26a); no `order.placed` event (the timeline gets `order.paid`) |
| `payOrder` | customer (order owner) or public with pay token | `{orderId, clientKey, useEuroCredit: boolean, acceptTerms: literal(true)}` | `{redirectUrl}` | pays an existing `pending_payment` order created by booking (R18), a waitlist claim or credits (renewal link); same inline `payments.create` |
| `retryPayment` | customer or public (order owner, or pay token) | `{orderId, clientKey}` | `{redirectUrl}` | none |
| `createStaffOrder` | staff, `commerce.sell` | `{personId?, companyId?, items, promoCode?, note?, billingDetails?}` | `{orderId}` (status `draft`, channel `admin`) | audit `order.created`; discount override not possible |
| `choosePaymentPath` | staff, `commerce.sell` | `{orderId, path: 'pos'\|'link'\|'bank_transfer'}` | `{status}` | `draft` -> `pending_payment` (rule 22a); bank transfer issues the open invoice; audit `order.payment_path_chosen` |
| `sendPaymentLink` | staff, `commerce.sell` | `{orderId, email?}` | `{expiresAt}` | enqueues `payments.create_link`; event `payment_link.sent`; audit `payment_link.sent` |
| `cancelOrder` | staff, `commerce.sell` | `{orderId, reason}` | `{ok}` | rule 22b: only `draft` or `pending_payment`; the api's `{cancelled: false}` is reported as `payment_in_progress` while a provider payment is `open`, `pending` or `authorized` (bank transfer excepted), else as `invalid_transition`; an open bank-transfer invoice is cancelled by `finance.issueCreditNote({orderId, reason, noRefund: true})` in the same transaction; event `order.cancelled`; audit `order.cancelled` |
| `refundOrder` | staff, `commerce.refund` (+ `invoices.issue` above €500 or after 365 days) | `{orderId, lines: [{orderLineId, quantity, amountCents?}], reason: min 5 chars, kind: 'refund'\|'withdrawal'}` | `{refundIds, creditNoteId}` | event `order.refunded`; audit `refund.issued` with amounts |
| `withdrawOrder` | customer (order owner) | `{orderId, lineIds}` | `{refundIds}` | only before `withdrawal_until_at` (rule 54); event `order.withdrawn`; staff are emailed through a `payment` task |
| `retryRefund` | staff, `commerce.refund` | `{refundId}` | `{ok}` | `failed` -> `pending`, enqueues `payments.refund` with key `refund:<id>:retry:<n>`; audit `refund.retried` |
| `confirmManualRefund` | staff, `commerce.refund` | `{refundId}` | `{ok}` | audit `refund.confirmed` |
| `posSell` | staff, `commerce.sell` | `{personId?, items (session and ticket lines quantity 1, no booking ids), promoCode?, method: 'terminal'\|'cash'\|'bank_transfer', terminalId?, cashReceivedCents?, useEuroCredit, billingDetails?: BillingDetailsInput, clientKey}` | `{orderId, status, changeCents?}` | after `createOrder`, each session and ticket line gets its `reserved` row through `booking.createBookingForPosLine(tx, ctx, {orderLineId, sessionId, personId})` in the same transaction (`ConflictError` -> `sold_out`, rule 21) and is confirmed by the paid transaction's `confirmBookingsForOrder`; `billingDetails` stored through `finance.setOrderBillingDetails` before any payment (rule 26b); `bank_transfer` refused with such lines (`bank_transfer_not_allowed`); cash refused on a closed day (`day_closed`); inline `payments.terminal` for terminal; event `order.paid` (cash); audit `pos.sale` |
| `posPayOrder` | staff, `commerce.sell` | `{orderId, method: 'terminal'\|'cash'\|'bank_transfer', terminalId?, cashReceivedCents?, useEuroCredit, billingDetails?: BillingDetailsInput, clientKey}` | `{orderId, status, changeCents?}` | takes payment at the counter for an existing `pending_payment` order (booking's pay-at-desk and manual-booking orders, renewal link orders) opened through `/admin/pos?order=<orderId>`; same payment rules as `posSell` (bank transfer refused with session lines, cash refused on a closed day); the order keeps its channel; audit `pos.order_paid` |
| `posCancelTerminal` | staff, `commerce.sell` | `{paymentId}` | `{ok}` | payment `cancelled` (source staff); audit `pos.terminal_cancelled` |
| `redeemVoucher` | customer (portal) or staff `commerce.sell` | `{code, personId?}` | `{grantId, amountCents, expiresAt}` | event `voucher.redeemed`; audit `voucher.redeemed` when staff |
| `resendVoucher` | staff, `commerce.sell` | `{voucherId, email?}` | `{ok}` | enqueues `commerce.issue_voucher_email` with key `voucher_email:<voucher_id>:<n>` (n = resend count); audit `voucher.resent` |
| `voidVoucher` | staff, `commerce.refund` | `{voucherId, reason}` | `{ok}` | audit `voucher.voided` |
| `emailReceipt` | staff, `commerce.sell` | `{orderId, email?}` | `{ok}` | `email.sendTransactional` `commerce.order_confirmation` (online and admin orders) or `commerce.pos_receipt` (POS orders) with the receipt PDF (key `order:<order_id>:receipt:<n>`); audit `receipt.emailed` |
| `closePosDay`, `reopenPosDay` | staff, `commerce.sell` / `commerce.refund` | `{businessDayOn, countedCashCents, note?}` / `{businessDayOn, reason}` | `{differenceCents}` / `{ok}` | rule 55; audit `pos.day_closed` / `pos.day_reopened` |
| `uploadLightspeedCsv` (R3) | staff, `commerce.sell` | `{file: File (csv, max 5 MB)}` | `{importId}` | enqueues `commerce.import_lightspeed`; audit `lightspeed.uploaded` |

Public (unauthenticated) actions are rate limited through platform's `rateLimit` to 20 per minute per IP (key `commerce:ip:<ip>`), and `placeOrder` and `payOrder` to 5 per minute per checkout or order (key `commerce:pay:<id>`); exceeding returns `rate_limited`.

### 4.3 Queries (`queries.ts`)

`listProducts(db, {kind?, activeOnly?, shop?: boolean, pos?: boolean})`, `getProduct(db, id)` with price history per audience, `listPromotions(db, {state: 'active'|'scheduled'|'ended'})`, `getPromotion(db, id)` with redemption counts, `listOrders(db, {status?, channel?, personId?, from?, to?, q? (reference or email), cursor})` (keyset on `created_at, id`, 50 per page), `getOrder(db, id)` with lines, payments, refunds, invoice ids, events, `getOrderStatus(db, orderId, viewer)` (the return page; reads only the database), `listMyOrders(db, personId)`, `getShopCatalogue(db, {personId, locale})` (products with the person's quoted unit price), `getCheckout(db, checkoutId, viewer)`, `getPayOrderByToken(db, token)`, `listPaymentAttention(db, {limit})`, `getPosDaySummary(db, {day})` (totals by method, counts, refunds, expected cash, close state), `getOrderForPayment(db, orderId, viewer)` (the order payment page: owner or pay-token holder only), `listLightspeedImports(db)` and `getLightspeedDaily(db, {from, to})` (R3). Staff queries call `requirePermission()` (`commerce.sell` or `pricing.write` or `reports.read` for reads); customer queries filter on `ctx.actor.personId`.

### 4.4 Route handlers

- `POST /api/webhooks/mollie` (`app/api/webhooks/mollie/route.ts`, runtime nodejs) is a one-liner over platform's `handleWebhook(req, {provider: 'mollie', verify})` (platform PL-39). `verify` reads form field `id`, checks query `t` equals `MOLLIE_WEBHOOK_SECRET` (constant-time) or a valid `X-Mollie-Signature` through `provider.verifyWebhook`, and returns `{ok: true, externalEventId: `${id}:${receivedAtMs}`, payload: {id}}`; a failure returns 401 and counts towards the signature-failure alert. Platform inserts `webhook_events` and enqueues `webhook.process` (key `webhook:mollie:<id>:<ms>`), answering 200 within 2 s.
- The handler is registered in `apps/web/modules/commerce/jobs.ts` as `export const mollieWebhook = defineWebhookHandler({provider: 'mollie', handle})` and collected into `WEBHOOK_HANDLERS` by `pnpm gen:indexes`. `handle` runs `syncPayment(ctx, providerPaymentId)` (the same function the `payments.sync` job runs) inside the `webhook.process` transaction. Ids not starting with `tr_` are ignored. A payment id not yet committed (the webhook raced the order transaction) throws `RetryableError` and the 60 s backoff resolves it (platform edge case 8).
- No other route handlers. Return pages poll through a server action (`getOrderStatus`), not an API route.

### 4.5 Jobs (`jobs.ts`, `defineJob`)

| Kind | Lane, priority | Idempotency key | Payload | Behaviour and retries |
| --- | --- | --- | --- | --- |
| `payments.create` (inline) | fast, 1 | `payment_create:<payment_id>` | `{paymentId}` | `provider.createPayment({amountCents, description: reference, redirectUrl, webhookUrl, method?, customerId?, sequenceType, metadata: {orderId, paymentId}})`; stores `provider_payment_id`, `checkout_url`. Provider 4xx -> `PermanentError`, payment `failed`; 5xx or timeout -> retryable, the action answers "payment service unavailable, try again" |
| `payments.terminal` (inline) | fast, 1 | `payment_terminal:<payment_id>` | `{paymentId, terminalId}` | `provider.createTerminalPayment`; result through the webhook |
| `payments.sync` | fast, 1 | `payment_sync:<provider_payment_id>:<YYYY-MM-DDTHH:mm>` (return-page polls and `payments.scan_expired`; webhooks run the same `syncPayment()` inside platform's `webhook.process`) | `{providerPaymentId}` | `getPayment`, `applyProviderStatus`, paid transaction (rule 32), mandate upsert, refunds and chargebacks sync. Retryable 6 attempts; unknown id -> succeeded with `result.ignored` |
| `payments.charge_recurring` | fast, 2 | `charge_recurring:<payment_id>` | `{paymentId}` | enqueued by `createRecurringCharge` (credits' `memberships.charge_renewal` makes no provider call); `provider.createRecurringPayment({customerId, mandateId, amountCents, description: reference, webhookUrl, metadata: {orderId, paymentId}, idempotencyKey: <job key>})`, stores `provider_payment_id`; final status through the webhook and `payments.sync`. 4xx -> payment `failed` -> `applyRenewalFailure` (rule 33) |
| `payments.cancel` | fast, 2 | `payment_cancel:<payment_id>` | `{paymentId}` | `provider.cancelPayment(providerPaymentId)` for an open recurring payment of a cancelled renewal order (rule 22c); a provider answer "not cancelable" succeeds with `result.notCancelable` and the later `paid` is refunded |
| `payments.refund` | fast, 2 | `refund:<refund_id>` | `{refundId}` | `provider.refund({providerPaymentId, amountCents, description})`; refund `sent`; final status from `payments.sync`. 4xx -> refund `failed` (on the feed) |
| `payments.create_link` | fast, 2 | `pay_link:<order_id>:<version>` | `{orderId, email}` | creates the token, sends `commerce.payment_link` with `email.sendTransactional` (same key) |
| `payments.scan_expired` | fast, 3 | `schedule:payments.scan_expired:<minute>` | `{}` | open or pending provider payments older than 30 min: enqueue `payments.sync`; still open after the sync and older than 35 min -> `expired` (`local_timeout`); orders with no live payment and `expires_at < now()` -> `expired` with releases (rule 22); drafts older than 30 days -> `cancelled` (rule 22a). Batches of 200 rows locked `FOR UPDATE SKIP LOCKED` |
| `checkouts.mark_abandoned` | fast, 5 | `schedule:checkouts.mark_abandoned:<minute>` | `{}` | rules 49, 50; R2 also rule 51 attribution; batches of 500 |
| `commerce.render_receipt` | fast, 5 | `receipt:<order_id>` | `{orderId}` | renders the receipt PDF into `files` (kind `receipt`) |
| `commerce.issue_voucher_email` | fast, 2 | `voucher_email:<voucher_id>:<n>` (0 for the first send) | `{voucherId, n, email?}` | renders the voucher PDF (`files.kind = receipt`) and sends `commerce.gift_voucher` to the recipient (or purchaser) with the code derived by `deriveVoucherCode`, the PDF attached as `{fileId, filename}` and `sendAt` for a future `deliver_on` (rule 45a); stores `vouchers.email_message_id` |
| `commerce.revoke_mandate` | fast, 3 | `mandate_revoke:<mandate_id>` | `{mandateId}` | `provider.revokeMandate({customerId, mandateId})`; mandate `revoked`; an already revoked or unknown mandate at the provider succeeds (no-op) |
| `commerce.refund_unavailable_lines` | fast, 2 | `refund_unavailable:<order_id>` | `{orderId, orderLineIds}` | `refundOrderLine` per line (idempotent per line and reason), then `payments.refund` jobs |
| `commerce.expire_vouchers` | bulk, 9 | `schedule:commerce.expire_vouchers:<minute>` | `{}` | rule 47a; batches of 500 |
| `commerce.erase_provider_customer` | fast, 5 | `mollie_customer:<provider_customer_id>:delete` | `{providerCustomerId, mandateIds}` | revokes any mandate still valid at the provider and deletes the Mollie customer; enqueued by commerce's `erase(tx, personId)` handler, which has no privacy request id (the `PrivacyRegistration` signature is unchanged and no `beam.privacy_request_id` setting exists, cross-module D35 and D69); the mandate revocation itself already ran in ops' `privacy.erase_external` (provider `mandates`, `revokeMandatesForPerson`) |
| `commerce.import_lightspeed_pending` (R3) | bulk, 9 | `schedule:commerce.import_lightspeed_pending:<minute>` | `{}` | enqueues `commerce.import_lightspeed {importId, offset: 0}` for every `uploaded` import |
| `commerce.import_lightspeed` (R3) | bulk, 9 | `lightspeed:<import_id>:<offset>` | `{importId, offset}` | 1,000 rows per run, self-continues; `on conflict (external_line_key) do nothing` |

Every handler passes the double-run test (`jobs.test.ts`).

### 4.6 Schedules (`schedules.ts`, Europe/Brussels)

`payments.scan_expired` `* * * * *`; `checkouts.mark_abandoned` `*/10 * * * *`; `commerce.expire_vouchers` `20 0 * * *`; `commerce.import_lightspeed_pending` (R3) `40 2 * * *`.

### 4.7 Activity event kinds (`events.ts`)

`checkout.started`, `checkout.abandoned` (`{checkout_id, total_cents, product_ids, channel, reason}`), `checkout.completed` (`{checkout_id, order_id}`), `checkout.recovered` (R2), `order.paid` (`{order_id, reference, total_cents, channel, product_kinds: products_kind[], lines: [{product_id, kind, quantity}]}`, where `lines[].kind` is the product kind; automation filters on `product_kinds` and `lines[].kind`), `order.expired`, `order.cancelled`, `order.refunded` (`{order_id, amount_cents, reason}`), `order.withdrawn`, `payment.failed` (`{order_id, reason}`), `payment.charged_back`, `promotion.redeemed` (`{promotion_id, code, discount_cents}`), `voucher.redeemed`, `voucher.expiring` (`{voucher_id, days: 30}`, on the purchaser), `voucher.expired`, `payment_link.sent`, `person_price.set`. Kinds follow `<entity>.<past_tense_or_fact>` with entities commerce owns, each declared once in commerce's `events.ts`, and every `data` key is snake_case (Convention 2). All non-sensitive; declared with `defineEvent` in `events.ts`; dedupe keys `<noun>:<id>:<kind>` (for example `order:<id>:paid`). Events for an order without a person (anonymous POS, company-only orders) are recorded with `company_id` or skipped, because `activity_events` needs a person or a company.

### 4.8 Cross-module API (`apps/web/modules/commerce/api.ts`)

```ts
export { quote } from '@beam/core/commerce';
export function getQuote(db: DbOrTx, args: { personId: string | null; companyId?: string | null; items: CartItem[];
  promoCode?: string | null; channel: OrderChannel; at?: Date }): Promise<Quote>;
export function createOrder(tx: Tx, ctx: Ctx, input: { personId: string | null; companyId?: string | null;
  channel: OrderChannel; items: CartItem[]; promoCode?: string | null; clientKey: string; checkoutId?: string;
  locale: Locale; useEuroCredit?: boolean; note?: string;
  expiresAt?: Date;            // channel 'admin' only (booking R63 pay-at-desk: the session's ends_at); refused with validation otherwise
}): Promise<{ orderId: string; reference: string; lineIds: string[]; totalCents: number; status: OrderStatus;
  expiresAt: Date | null; isExisting: boolean }>;   // lineIds in item order; stores items[].bookingIds in order_lines.data.booking_ids and never calls booking (rule 21, cross-module D21)
export function startPayment(tx: Tx, ctx: Ctx, input: { orderId: string; returnPath?: string }):
  Promise<{ paymentId: string | null; redirectUrl: string }>;   // inline payments.create; redirectUrl = provider page, or the return page when nothing is due
export function getOrderStatus(db: DbOrTx, orderId: string): Promise<{ status: OrderStatus; paidAt: Date | null; dueCents: number }>;
export function cancelOrder(tx: Tx, ctx: Ctx, input: { orderId: string; reason: string }): Promise<{ cancelled: boolean }>; // rule 22b; { cancelled: false } for a non-cancellable order, never throws for its status (cross-module D31); booking (session cancelled), finance (manual credit note on an open transfer, inside finance's transaction)
export function refundOrderLine(tx: Tx, ctx: Ctx, input: { orderLineId: string;
  reason: 'cancelled_in_policy' | 'session_cancelled' | 'seat_no_longer_available' }): Promise<{ refundId: string | null; amountCents: number }>; // rule 37a; booking uses the first two
// credits: membership renewals (credits rules 48-53, commerce rule 22c)
export function createRecurringCharge(tx: Tx, ctx: Ctx, input: { membershipId: string; personId: string; productId: string;
  mandateId: string; periodEndOn: string }): Promise<{ orderId: string; paymentId: string }>; // creates or reuses the period's renewal order, new payment, enqueues payments.charge_recurring
export function createRenewalLinkOrder(tx: Tx, ctx: Ctx, input: { membershipId: string; personId: string; productId: string;
  periodEndOn: string }): Promise<{ orderId: string; payUrl: string }>;   // channel 'link'; idempotent per membership and period
export function getPayLinkForOrder(tx: Tx, ctx: Ctx, input: { orderId: string }): Promise<{ payUrl: string; expiresAt: Date }>; // rule 41; same URL while valid
export function cancelRenewalOrder(tx: Tx, ctx: Ctx, input: { orderId: string; reason: string }): Promise<void>; // rule 22c
export function getActiveMandate(db: DbOrTx, personId: string): Promise<{ mandateId: string; method: string; summary: string | null } | null>;
// finance: bank transfers (finance rules 2, 2a, 25-27)
export function recordBankTransferPaid(tx: Tx, ctx: Ctx, input: { orderId: string; paidOn: string /* YYYY-MM-DD */;
  reference: string /* invoice number */ }): Promise<{ applied: boolean }>;   // idempotent on the order (rule 43a)
// ops: erasure (ops rule 62)
export function revokeMandatesForPerson(tx: Tx, ctx: Ctx, personId: string): Promise<{ revoked: number }>; // marks every valid mandate revoked and enqueues commerce.revoke_mandate per mandate
// automation (R2)
export function markCheckoutRecoveryMessage(tx: Tx, input: { checkoutId: string; emailMessageId: string }): Promise<void>;
export function getCheckoutRecoveryProps(tx: Tx, checkoutId: string): Promise<{ resumeUrl: string; items: ProductCard[]; totalCents: number; locale: Locale }>; // creates the resume token once
// credits' portal packages page: the redeem field submits commerce's own server action (02-data-model DM-13)
export { redeemVoucher } from './actions';
// ops, crm, email, site
export function listPaymentAttention(db: DbOrTx, opts: { limit: number }): Promise<PaymentAttentionItem[]>;
export function getPersonCommerceSummary(db: DbOrTx, personId: string): Promise<{ paidOrders: number; paidCents: number;
  lastPaidAt: Date | null; openOrders: number; activeVouchers: number }>;
export function listPersonOrders(tx: DbOrTx, personId: string, opts: { limit: number }): Promise<OrderSummary[]>;   // crm 360 panel
export function getProductPrice(db: DbOrTx, productId: string, audience: Audience, at?: Date): Promise<{ priceVersionId: string; amountCents: number } | null>;
export function listPublicPrices(db: DbOrTx, input: { productIds?: string[]; at: Date }): Promise<Array<{ productId: string; sku: string;
  kind: ProductKind; name: LocalizedText; publicAmountCents: number; memberAmountCents: number | null; vatRatePct: number;
  creditUnits: number | null; creditKind: CreditKind | null; validityDays: number | null; isActive: boolean }>>; // site
export function getProductCards(tx: DbOrTx, productIds: string[], locale: Locale): Promise<ProductCard[]>;          // email product block
export function countOrdersByLanding(db: DbOrTx, input: { from: Date; to: Date }): Promise<Array<{ landingPath: string | null;
  utmCampaign: string | null; orders: number; revenueCents: number }>>; // R3, site insights: paid orders of checkouts in the window grouped by checkouts.landing_path and utm->>'campaign'
```
`createOrder` is used by booking (portal bookings, claims, staff and pay-at-desk bookings with payment; booking has validated the seats and inserted the `reserved` rows before the call and passes them as `items[].bookingIds`; pay-at-desk orders use channel `admin` with `expiresAt`, and the pay-at-desk marker is booking's own), credits never (renewals use `createRecurringCharge` and `createRenewalLinkOrder`) and site never (it links to the shop and checkout). Booking then sends the customer to `/[locale]/account/checkout/[orderId]`, where `payOrder` starts the payment (cross-module D21); credits calls `startPayment` (credits' `payMyRenewal`). `recordBankTransferPaid` is called by finance when Billit reports a transfer paid or staff mark the invoice paid. The cross-module item key is `items[].bookingIds` (rule 21); `CartItem` has no attendee field, because the attendee is the booking row's `person_id` (cross-module D21). The Wave 0 stub `commerce.quote` keeps its signature (`quote(input: QuoteInput): Quote`, the pure function re-exported).

## 5. Screens

Every screen uses `@beam/ui` (`DataTable`, `LocalizedInput`, `FormField`), money through `Intl.NumberFormat(locale, {style: 'currency', currency: 'EUR'})`, dates in `Europe/Brussels`. Loading states are skeletons from `loading.tsx`; errors render `error.tsx` with the request id and a retry button; empty states have one sentence and the primary action. Navigation entries live in `modules/commerce/nav.ts`. Customer-facing pages and the POS follow rule 56 (WCAG 2.1 AA).

### 5.1 Back-office (`app/(admin)/admin/...`)

| Route | Who | Shows | Actions | Empty state |
| --- | --- | --- | --- | --- |
| `/admin/products` | `pricing.write`, read-only for `commerce.sell` | Table: name (staff locale), kind, SKU, VAT, current public, member and b2b price, active, shop, POS; filter by kind and active | New product, activate or deactivate, reorder | "No products yet. Create your first product." |
| `/admin/products/new`, `/admin/products/[id]` | `pricing.write` | Form by kind (fields hidden when not applicable: credit units only for packages, interval for memberships, item category for items, amount range for custom vouchers); `LocalizedInput` with completeness badge; price history per audience (version, amount, window, reason, who) | Save, add price version (dialog with "valid from" and optional "valid until"), activate (shows missing locales) | price history: "No price yet: add the public price to activate." |
| `/admin/products/[id]/person-prices` | `pricing.write` | Person-specific prices with person, amount, window, reason | Add (person picker), revoke | "No customer-specific prices." |
| `/admin/products/promotions`, `/admin/products/promotions/new`, `/admin/products/promotions/[id]` | `pricing.write` | Tabs active, scheduled, ended; code or "automatic", value, dates, uses / max, per-person limit; detail shows redemptions (order reference, person, discount) | Create, edit (locked fields disabled with tooltip "used N times"), deactivate | "No promotions. Create a code or an automatic offer." |
| `/admin/orders` | `commerce.sell`, `commerce.refund`, `invoices.read` | Orders table: reference, date, person or company, channel, status badge, total, paid; search by reference, email, name; filters status, channel, date | Open, new staff order | "No orders in this period." |
| `/admin/orders/new` | `commerce.sell` | Person or company picker, product picker with live quote and `pricing_trace` explanation per line ("member discount 10 % beat promo SPRING") | Create order, then choose the payment path: pay at POS, send payment link or bank transfer (the transfer is settled later in finance, cross-module D32) | |
| `/admin/orders/[id]` | as `/admin/orders` | Lines with trace, payments with `status_history`, refunds, invoice and credit-note links (finance), vouchers, timeline events | Choose payment path (drafts), send payment link, cancel (draft or pending), refund (`commerce.refund`), retry failed refund, open the finance invoice to mark a bank transfer paid (finance `markInvoicePaid`, `invoices.issue`), email receipt, resend voucher | |
| `/admin/orders/[id]/refund` | `commerce.refund` | Per line: paid, used units, refundable default; total; where the money goes (credit balance, card, cash) from `refundPlan()` | Confirm refund with reason | "Nothing left to refund." |
| `/admin/orders/attention` | `commerce.sell`, `reports.read` | `v_payment_attention` grouped by kind with age; the same list feeds the ops action dashboard | Open order, send payment link, create task (crm) | "No payment problems." |
| `/admin/pos` | `commerce.sell` | Reception screen (tablet, 1024 px): left a product grid by kind tabs (Sessions today, Packages, Memberships, Tickets, Vouchers, Items) from `is_pos_visible`; today's sessions with free seats; right the basket with person search (name, email, phone) or "anonymous", live quote, euro credit available, voucher redeem field; a fixed banner "Food and drink: use Lightspeed"; "Invoice to a company" toggle with finance's billing fields. Deep link `/admin/pos?order=<orderId>` (booking's check-in desk "Take payment", the order screen) opens that `pending_payment` order read-only in the basket with its lines, total and reservation expiry, and pays it through `posPayOrder`; a paid, expired or cancelled order shows its state and a link to `/admin/orders/[id]` | Pay by terminal (spinner, polls status every 2 s up to 120 s, cancel button), cash (received amount, change), bank transfer; after payment: print receipt, email receipt | basket: "Add a product or scan a voucher." |
| `/admin/pos/receipt/[orderId]` | `commerce.sell` | 80 mm print layout of the receipt with BEAM company data from `settings.company`, lines, VAT per rate, payment method, reference | Print, download PDF | |
| `/admin/pos/day` | `commerce.sell` | Today's POS totals by method (terminal, cash, bank transfer, credit balance), refunds, count; cash float plus expected cash in drawer; close state with counted amount and difference | Change day, close day (counted cash, note), reopen (`commerce.refund`) | "No sales today." |
| `/admin/pos/lightspeed` (R3) | `commerce.sell` upload, `reports.finance` view | Imports with status, period and counts; daily food-and-drink totals by category | Upload CSV | "No Lightspeed exports imported." |

### 5.2 Customer portal (`app/[locale]/(portal)/account/...`)

| Route | Shows | Actions | Empty / error |
| --- | --- | --- | --- |
| `/[locale]/account/shop` | Shop products (`is_shop_visible`) grouped by packages, memberships, vouchers, with the person's own price ("Member price") and "4 sessions, valid 6 months" from product data; member-only labelling. `?product=<productId>` (forms' result-page product CTAs) opens that product's detail (`/[locale]/account/shop/[sku]`, redirect with the query kept for analytics); an unknown, inactive or hidden product id shows the shop with the notice "This product is not available" | Add to basket, buy now | "Nothing for sale right now." |
| `/[locale]/account/checkout` | Basket, quote lines with discount reason, promo code field and warning texts, euro credit toggle with balance, terms checkbox, total incl. VAT | Update quantity, remove, apply code, Pay | price changed banner; sold out message per line |
| `/[locale]/account/shop/[sku]` | One product with description, the person's price, validity, sharing, withdrawal notice; site product links land here | Add to basket, buy now | "This product is not available." for inactive or hidden products |
| `/[locale]/account/checkout/[orderId]` | Pay an existing `pending_payment` order (booking reservations, waitlist claims, renewal links): lines, reservation countdown ("Your seat is held until 14:35"), euro credit toggle, terms checkbox, company invoice box | Pay (`payOrder`) | expired order: "This reservation has expired" with a link back to the session; paid order: redirect to the return page |
| `/[locale]/account/checkout/return/[orderId]` | Polls `getOrderStatus` every 2 s for 30 s: paid -> success with what was granted ("4 sessions added", booking confirmed, voucher sent); failed -> retry button; still open -> "Payment pending, we will email you" | Retry payment, go to bookings | |
| `/[locale]/account/orders` | Own orders with reference, date, total, status, invoice link (finance route); own vouchers bought (amount, recipient, status, expiry) | Open, redeem voucher (code field) | "No purchases yet." |
| `/[locale]/account/orders/[id]` | Lines, payments, refunds, invoice and credit note links, withdrawal deadline when it applies | Withdraw (rule 54, confirmation dialog), retry payment (pending) | |

Session, night and event purchases start in the booking screens (`/[locale]/account/book`, owned by booking), which insert the `reserved` rows, call `createOrder` with `items[].bookingIds` and redirect to `/[locale]/account/checkout/[orderId]`, where the customer pays (cross-module D21); an order left unpaid (failed payment, waitlist claim, guest after the magic link) is paid on the same page. A guest without an account is asked for an email and gets a magic link first (booking and platform own that step).

### 5.3 Public (`app/[locale]/(site)/...`)

| Route | Shows | Actions |
| --- | --- | --- |
| `/[locale]/checkout` | Guest checkout started from site links `?sku=...` (packages, memberships, vouchers, items only; session and event links go to booking): email step first (creates the checkout row), then the same basket as the portal with terms and company invoice box; link "Log in for member prices" | Pay |
| `/[locale]/checkout/return/[orderId]` | Same polling page as the portal; the order is identified by order id plus a signed cookie set at `placeOrder` | |
| `/[locale]/checkout/resume/[token]` (R2) | Restores an abandoned checkout from the recovery email and re-quotes it | Continue |
| `/[locale]/pay/[token]` | Payment link page: order reference, lines, total, then the provider redirect; states paid, expired, cancelled | Pay |
| `/[locale]/gift` | Voucher purchase page (amount, recipient name and email, message, optional delivery date "Send on", rule 45a) leading to `/[locale]/checkout` | Buy voucher |

## 6. Integrations

All provider code sits in `packages/integrations/src/payments/`: `provider.ts` (the Wave 0 `PaymentProvider` interface, extended additively), `mollie.ts`, `stripe.ts`, `viva.ts`, `fake.ts` (Wave 0, extended), `select.ts`. Clients take credentials in the constructor, validate responses with Zod, throw `IntegrationError { provider, retryable }` and report each call to an `onCall` callback that the job runner writes to `integration_calls` (operation, digest, status, duration, never bodies).

```ts
export interface PaymentProvider {
  readonly name: 'mollie' | 'stripe' | 'viva' | 'fake';
  createPayment(i: { amountCents: number; description: string; redirectUrl: string; webhookUrl: string;
    locale: Locale; method?: string; customerId?: string; sequenceType: 'oneoff' | 'first';
    metadata: { orderId: string; paymentId: string }; expiresAt?: Date; idempotencyKey: string }): Promise<{ providerPaymentId: string; checkoutUrl: string; status: PaymentStatus }>;
  getPayment(providerPaymentId: string): Promise<ProviderPayment>; // status, method, amountCents, paidAt, mandateId, customerId, refunds[], chargebackCents, details (scrubbed)
  refund(i: { providerPaymentId: string; amountCents: number; description: string }): Promise<{ providerRefundId: string; status: 'pending' | 'refunded' | 'failed' }>;
  createCustomer(i: { name: string; email: string; locale: Locale }): Promise<{ customerId: string }>;           // addition
  createMandate(i: { customerId: string; method: 'directdebit'; consumerName: string; iban: string }): Promise<{ mandateId: string; status: string }>;
  getMandate(i: { customerId: string; mandateId: string }): Promise<{ status: 'pending' | 'valid' | 'invalid'; method: string; summary: string | null }>; // addition
  revokeMandate(i: { customerId: string; mandateId: string }): Promise<void>;                                     // addition
  deleteCustomer(customerId: string): Promise<void>;                                                               // addition
  createRecurringPayment(i: { customerId: string; mandateId: string; amountCents: number; description: string; webhookUrl: string; metadata: Record<string, string>; idempotencyKey: string }): Promise<{ providerPaymentId: string; status: PaymentStatus }>;
  cancelPayment(providerPaymentId: string): Promise<{ cancelled: boolean }>;                                      // addition (rule 22c); false when the provider says not cancelable
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
| Fake (`fake.ts`) | In-memory payments with controllable outcomes (`fake.settle(id, 'paid'|'failed'|'expired'|'cancelled')`, `fake.chargeback(id, cents)`, latency and error injection); used by every test and by `beam_dev` when `PAYMENTS_FAKE=1`. `PAYMENTS_FAKE=1` selects the payments fake only (every other provider keeps its own switch); in production it makes the `config` check of `/api/health` fail with 503 (cross-module D49) | | |
| Email (internal, `email.sendTransactional(ctx, {template, personId?, to?, locale, data, key, attachments?: {fileId, filename, inline?}[], context?, sendAt?, replyTo?, headers?}): Promise<{emailMessageId, jobId}>`, email's published shape; commerce passes `data`, `key` and `to`, uses `context`, `replyTo` and `headers` only when needed, and stores the returned `emailMessageId`; cross-module D5) | Template keys in email's `TEMPLATE_REGISTRY` are `<m>.<name>`, `<name>` the file basename with `-` replaced by `_`, one file one key (Convention 1, cross-module D1 and D2), exactly these 8: `commerce.order_confirmation` (online, admin, link and recurring orders; receipt PDF attached, withdrawal notice for online orders), `commerce.pos_receipt` (POS orders, receipt PDF attached), `commerce.payment_failed`, `commerce.payment_link`, `commerce.gift_voucher` (voucher PDF attached, `sendAt` for a delivery date), `commerce.refund_confirmation`, `commerce.portal_invitation`, R2 `commerce.checkout_recovery` (sent by the automation as a marketing message, cross-module D54). The same strings are the `email_templates.slug` of email's system rows. Files `packages/email/src/templates/commerce/{order-confirmation,pos-receipt,payment-failed,payment-link,gift-voucher,refund-confirmation,portal-invitation}.tsx` (R2 `checkout-recovery.tsx`) written with email's `defineTemplate()`, plus `index.ts` exporting each props schema; the architecture gives this folder to the commerce package, and the copy lives in commerce's catalogue under `commerce.email.<name>.<slot>` (for example `commerce.email.order_confirmation.subject`). A scheduled gift-voucher email is withdrawn with `email.cancelScheduledMessage(ctx, {messageId})` | The call returns no status: suppression and translation are decided later by `email.send`, where a missing translation blocks the message and alerts; the order itself is unaffected | `email_messages.idempotency_key` = `order:<order_id>:receipt`, `order:<order_id>:receipt:<n>` (staff resend), `payment:<payment_id>:failed`, `pay_link:<order_id>:<version>`, `voucher:<voucher_id>:email:<n>`, `refund:<refund_id>:confirmation`, `order:<order_id>:portal_invitation` (passed as `key`); the `email.send` job key stays `email:<message_id>` (email module) |

Lightspeed has no API integration: BEAM staff export the daily sales CSV from Lightspeed back office and upload it (R3).

## 7. Permissions and audit

Permissions used (all from the architecture list; commerce declares `commerce.sell`, `commerce.refund`, `pricing.write` in `permissions.ts`):

| Capability | Permission | Default roles |
| --- | --- | --- |
| View products, prices, promotions | `commerce.sell` or `pricing.write` | owner, technical_admin, management, sales, reception, finance |
| Create and edit products, price versions, person prices, promotions | `pricing.write` | owner, technical_admin, management, finance |
| Staff orders, POS sales, payment links, cancel draft or pending orders, email receipts, redeem vouchers for a customer, POS day summary and day close, attention list, upload Lightspeed CSV | `commerce.sell` | owner, technical_admin, management, sales, reception |
| Refunds, retry and confirm manual refunds, void vouchers, reopen a closed POS day | `commerce.refund` | owner, technical_admin, management, finance |
| Refund above €500 or on an order older than 365 days | `commerce.refund` plus `invoices.issue` through `ctx.require('invoices.issue')` | owner, technical_admin, management, finance |
| Mark a bank-transfer invoice paid | finance's `markInvoicePaid` (`invoices.issue`), which calls `commerce.recordBankTransferPaid` | owner, technical_admin, management, finance |
| View orders | `commerce.sell`, `commerce.refund` or `invoices.read` | as above |
| Attention list read-only | `reports.read` | owner, technical_admin, management, customer_service, sales, marketing, finance (reception reaches it through `commerce.sell`) |
| Lightspeed daily figures | `reports.finance` | owner, technical_admin, management, finance |

External partners see no commerce screen. R3 partner referral counts are shown by ops through `partner.own`.

Audited actions (`audit_log`, written by `action()` for every staff write, with old and new value): `product.created`, `product.updated`, `product.activated`, `product.deactivated`, `price.version_added`, `person_price.set`, `person_price.revoked`, `promotion.created`, `promotion.updated`, `order.created`, `order.cancelled`, `payment_link.sent`, `pos.sale` (with payment method and any discount applied, which covers blueprint 56 "discount applied"), `pos.terminal_cancelled`, `pos.order_paid`, `refund.issued` (blueprint 56 "refund issued"), `refund.confirmed`, `refund.retried`, `order.payment_path_chosen`, `pos.day_closed`, `pos.day_reopened`, `voucher.redeemed` (staff), `voucher.resent`, `voucher.voided`, `receipt.emailed`, `lightspeed.uploaded`, `settings.payment_provider_changed`. Customer actions are not audited; they appear on the timeline.

## 8. Multi-language and content

- LocalizedText fields: `products.name`, `products.description`, `promotions.name`, `order_lines.description` (snapshot), `settings.commerce.receipt_footer`.
- Catalogue namespace `commerce`, files `packages/core/src/i18n/messages/{nl-BE,fr-BE,en}/commerce.json`, keys `commerce.<screen>.<element>`; email copy slots are `commerce.email.<name>.<slot>` with `<name>` the template name of section 6 (Convention 1). Screens: `shop`, `checkout`, `return`, `orders`, `pay`, `gift`, `voucher`, `admin_products`, `admin_prices`, `admin_promotions`, `admin_orders`, `admin_refund`, `admin_attention`, `pos`, `pos_day`, `receipt`, `order_pay`, `withdrawal`, `lightspeed`. Plus `commerce.errors.*` for every action error code (`sold_out`, `price_changed`, `product_unavailable`, `promo_unknown`, `promo_inactive`, `promo_expired`, `promo_exhausted`, `promo_not_eligible`, `promo_not_better`, `voucher_invalid`, `voucher_used`, `voucher_expired`, `rate_limited`, `payment_unavailable`, `payment_in_progress`, `refund_too_high`, `terms_unavailable`, `already_member`, `pending_exists`, `day_closed`, `withdrawal_expired`, `invalid_transition`, `bank_transfer_not_allowed`) and `commerce.payment_status.*`, `commerce.order_status.*`, `commerce.product_kind.*`.
- Publish-time check: `setProductActive(true)` and `updateProduct` on an active product call `assertComplete(name)` and, when `is_shop_visible`, `assertComplete(description)` for all three locales. Activating an automatic promotion or saving a code promotion calls `assertComplete(promotions.name)` because the name prints on lines, receipts and invoices.
- Customer-facing totals, receipts and emails render in `orders.locale` (the person's locale at order time). The receipt PDF and the voucher PDF exist per locale; a missing key blocks the PDF job with `PermanentError` and an alert, never a mixed language.
- Euro amounts use `Intl.NumberFormat`; "4 sessions remaining" style texts use ICU plurals in the catalogue.
- The withdrawal notice, the terms checkbox label and the receipt footer are legal texts: their keys live in `commerce.withdrawal.*` and `commerce.checkout.terms_*` and are reviewed by BEAM in all three locales before go-live (part of the go-live checklist in ops).

## 9. Privacy

`apps/web/modules/commerce/privacy.ts` registers:

| Table | Person columns | Export includes | Erase action | Why |
| --- | --- | --- | --- | --- |
| `orders` | person_id, note | reference, date, channel, status, totals, lines (description, quantity, amounts, VAT, discount reason) | `retained_legal`: person_id set null, `is_erased_subject = true`, note null | Accounting records, 10 years (3653 days, cross-module D34); the invoice keeps the legal name and address (finance) |
| `order_lines` | none (reached through orders) | in orders | `retained_legal`, unchanged | no personal data |
| `payments` | raw (consumer name, IBAN, card summary) | provider, method, amount, status, dates | `retained_legal`: raw replaced by `{id, status, method, amount}` (a plain update; `payments` is not append-only) | Payment trace for accounting; the provider keeps its own data under its legal obligations (noted in the report) |
| `refunds` | none direct | amount, reason, status, date | `retained_legal`, unchanged | |
| `mandates` | person_id, details_summary | method, summary, status | `anonymised`: person_id null, details_summary null, status `revoked`; job `commerce.erase_provider_customer` deletes the Mollie customer | Stops future charges; the revocation itself already happened in ops' first erasure step through `revokeMandatesForPerson` (ops rule 62), which sets every `valid` mandate `revoked` and enqueues `commerce.revoke_mandate` per mandate |
| `provider_customers` | person_id | provider and creation date | `deleted` | |
| `checkouts` | person_id, email, utm | items, dates, status | `deleted` | Marketing analytics only |
| `person_prices` | person_id | product, amount, window, reason | `deleted` | |
| `promotion_redemptions` | person_id | promotion name, order reference | `anonymised`: person_id null | Keeps use counts correct |
| `vouchers` | purchaser_person_id, recipient_name, recipient_email, message, redeemed_by_person_id | vouchers bought (amount, status, recipient) and redeemed | `anonymised`: person ids, recipient_name, recipient_email, message null; status and amount kept | A voucher is a liability that must stay countable; an active voucher stays redeemable by code |
| `lightspeed_imports`, `lightspeed_sales`, `pos_day_closes` | none | n/a | `NO_PII_TABLES` | Aggregated till and drawer data |

Erasure is refused with a clear message while the person has an order `pending_payment` with a live provider payment: the handler throws `RetryableError('live_payment')` and the privacy job retries with the standard backoff (the payment expires within 30 minutes). Open bank-transfer orders and drafts are cancelled first through `cancelOrder`. The terms acceptance of an order is site's record (`site` privacy handler); `orders.terms_version_id` names a document version, not a person.

Retention policies (declared in `privacy.ts` as `retention: RetentionPolicySeed[]`, seeded into ops' `retention_policies` by the ops seed `on conflict (key) do nothing`, enforced by `privacy.retention_sweep` through commerce's `sweep[key]` handlers; keys are `commerce.<table>[_<qualifier>]`, Convention 4, cross-module D37): `commerce.checkouts` 395 days `delete` (13 months: a year of recovery comparisons); `commerce.payments_raw` 90 days `anonymise` (raw reduced as above); `commerce.orders` 3653 days (10 years, counted from 1 January after the fiscal year of `paid_at`, Belgian law of 20 November 2022; cross-module D34) `anonymise` (person_id null, then rows kept without person); `commerce.person_prices` 730 days after `valid_to_at` or `revoked_at` `delete`; `commerce.lightspeed_sales` 3653 days (same horizon, D34) `delete`. No sweep touches an order younger than 3653 days; an erasure before then is `retained_legal` as in the table above.

The subject's export (`export(tx, personId)`) returns `orders.json`, `payments.csv`, `vouchers.json`, `checkouts.json`, `mandates.json`, `person_prices.json`. Commerce has no sensitive columns, so nothing is added to `SENSITIVE_COLUMNS`. AI context gets only `revenue_cents` and `purchases` through ops' `person_stats`; no commerce column is in `AI_ALLOWED_FIELDS` or `SEGMENT_ALLOWED_FIELDS` except through `v_person_profile`.

## 10. Dependencies

Needs from other modules (all through `api.ts`; callers' unit tests mock them until the owner lands them):

| Module | Function or table | Used for |
| --- | --- | --- |
| platform | `ctx.recordEvent`, `ctx.audit`, `ctx.enqueue`, `ctx.require`, `runJobInline`, `defineJob`, `defineSchedule`, `defineEvent`, `getSetting(key)`, `flag('ff_commerce_checkout_recovery', ctx)`, `handleWebhook(req, {provider, verify})`, `defineWebhookHandler({provider, handle})`, `storeFile(ctx, {kind, name, mime, bytes, personId, expiresAt})`, `signFileUrl(fileId)`, `rateLimit(tx, {key, limit, windowSeconds})`, `notifySlack` | jobs, audit, settings, webhook inbox, receipt files, rate limits |
| crm | `crm.findOrCreatePersonByEmail(tx, ctx, {email, locale, firstName?, lastName?, acquisition?})` (checkout passes `acquisition.referral_code` from `site.readReferralCode()`, crm resolves it; cross-module D18), `crm.createPersonWithoutEmail` (POS walk-in with a name only), `crm.getPersonStatus(db, personId)` (`.status`), `crm.isInSegment(db, segmentId, personId)`, `crm.getCompany(db, companyId)`, `crm.createTask(tx, ctx, {...})`, `crm.searchPersons(db, {q, limit})` (POS person picker; exists in crm's `api.ts`) | buyer identity, status, promotion eligibility, tasks |
| booking | `booking.getAvailability(db, {sessionId, personId?, at?})` (object input), `booking.confirmBookingsForOrder(tx, ctx, {orderId})` (paid transaction; returns `{confirmedBookingIds, unavailableOrderLineIds}`), `booking.releaseBookingsForOrder(tx, ctx, {orderId, reason: 'payment_expired'|'payment_failed'|'order_cancelled'})` (expiry, failure, cancellation; commerce passes `payment_expired` at expiry and `order_cancelled` on cancellation), `booking.cancelBookingsForOrderLine(tx, ctx, {orderLineId, reason: 'refunded'})` (staff refund), `booking.createBookingForPosLine(tx, ctx, {orderLineId, sessionId, personId}): {bookingId}` (POS walk-in in `posSell`; `ConflictError('session_full'|'member_only'|'already_booked')` mapped to `sold_out`), `booking.listBookableSessions` (POS "today" tab). Booking calls `createOrder` with `items[].bookingIds` after inserting its `reserved` rows; commerce never calls booking inside `createOrder`. `reserveForOrderLine`, `confirmOrderBookings`, `releaseOrderBookings` and `CartItem.attendeePersonId` do not exist (cross-module D21) | session, night and ticket lines |
| credits | `credits.grantCredits(tx, ctx, GrantCreditsInput)` (package lines once per unit with `lineUnitIndex` and key `grant:order_line:<order_line_id>:<n>`; voucher redemption with source `voucher`, `voucherId`, key `grant:voucher:<voucher_id>`; partial euro refunds with source `manual`, key `grant:refund:<refund_id>`), `credits.activateMembership`, `credits.applyRenewalPayment`, `credits.applyRenewalFailure`, `credits.cancelMembershipForRefund`, `credits.consumeCredits` and `credits.releaseCredits` (kind `euro`, ref `{type: 'order', id}`, release reasons `order_expired` and `refund`), `credits.getEuroBalance`, `credits.getGrantUsage`, `credits.revokeGrantRemainder`, `credits.getMembershipForPerson` (member pricing), `credits.canStartMembership(db, personId, {startsOn})` (quote time); R3 `credits.onOrderPaidForReferrals`, `credits.onOrderRefundedForReferrals` | packages, euro credit, memberships, vouchers, referrals |
| finance | `finance.issueInvoice(tx, ctx, {orderId, status?: 'paid'|'open', dueOn?, paymentId?, paidAt?, settledVia?})` returning finance's `IssueInvoiceResult` = `{status: 'issued'|'existing', invoiceId, number} | {status: 'skipped', reason: 'zero_total'}` (02-data-model DM-3 replaces D30's `created` flag) (paid transaction, always, and bank-transfer placement with `dueOn`; no invoice for a 0 total, finance rule 3), `finance.issueCreditNote(tx, ctx, {orderId, refundId, reason, lines})` (refunds) and `{orderId, reason, noRefund: true}` (`cancelOrder` on an open bank-transfer order), `finance.markCreditNoteSettled(tx, ctx, {refundId, settledAt})`, `finance.setOrderBillingDetails(tx, ctx, {orderId, details})` (checkout and POS), `finance.getInvoiceForOrder(db, orderId)` (D30), schema `BillingDetailsInput`; finance maps `payments.provider = credit_balance` to its `payment_method` `voucher` or `mixed` | invoices, credit notes, company invoice details |
| email | `email.sendTransactional(ctx, {template, personId?, to?, locale, data, key, attachments?: {fileId, filename, inline?}[], context?, sendAt?, replyTo?, headers?})` returning `{emailMessageId, jobId}` (commerce stores `emailMessageId`; cross-module D5) with the 8 dotted `commerce.<name>` template keys of section 6 (cross-module D1, D2), `email.cancelScheduledMessage(ctx, {messageId})` (refunded gift voucher before delivery), R2 `email.findLatestMessage(db, {personId, templateSlug: 'commerce.checkout_recovery', after})` (recovery attribution fallback, cross-module D54) | receipts, links, vouchers, failed payments |
| site | `site.getCurrentLegalVersion(db, 'terms')`, `site.recordTermsAcceptance(tx, ctx, {...})`, `site.readReferralCode()` (checkout, cross-module D18) | terms acceptance at checkout, referral code of a new person |
| automation | seeded `abandoned-checkout` marketing automation (purpose `newsletter`, group `checkout`, `requires_flag = ff_commerce_checkout_recovery`) triggered by `checkout.abandoned`, exits on `order.paid` and `checkout.completed`; both reminders `remind_1h` and `remind_24h` send `commerce.checkout_recovery` as marketing messages; calls `getCheckoutRecoveryProps` and `markCheckoutRecoveryMessage` (cross-module D54) | R2 recovery sequence |

Provides to other modules:

| Module | What |
| --- | --- |
| booking | `createOrder` (items with `bookingIds: [bookingId]`, quantity 1 per seat; optional `expiresAt` for `admin` pay-at-desk orders; no `isPayAtDesk`), `startPayment`, `getQuote`, `refundOrderLine`, `cancelOrder`, `getProductPrice`; the order payment page `/[locale]/account/checkout/[orderId]` and the POS deep link `/admin/pos?order=<orderId>` |
| credits | `createRecurringCharge` (reuses the period's open renewal order on dunning retries), `createRenewalLinkOrder`, `getPayLinkForOrder`, `cancelRenewalOrder`, `startPayment`, `getActiveMandate`, `redeemVoucher` (portal field); tables `products`, `orders` (`renewal_membership_id`), `order_lines`, `price_versions`, `mandates`, `refunds`, `vouchers` (read) |
| finance | `recordBankTransferPaid(tx, ctx, {orderId, paidOn, reference})`, `cancelOrder` (manual credit note on an open transfer); read access to `orders`, `order_lines`, `payments`, `refunds`, `products` for invoice lines |
| ops | `listPaymentAttention` (action dashboard "5 failed payments"), `revokeMandatesForPerson` (erasure, ops rule 62), tables read by `v_revenue_daily` and `v_abandoned_checkouts` (including `checkouts.abandoned_reason`), `v_sales_lines` and `v_lightspeed_daily` (R3), `getPersonCommerceSummary`; `order.paid` events for `person_stats` |
| crm | `listPersonOrders` for the person 360 panel; timeline events listed in 4.7 |
| site | `getProductPrice`, `listPublicPrices`, the routes `/[locale]/account/shop/[sku]`, `/[locale]/checkout?sku=&from=<page path>` and `/[locale]/gift`; R3 `countOrdersByLanding` (`{landingPath, utmCampaign, orders, revenueCents}[]`) |
| email | `getProductCards(tx, productIds, locale)` for the product block |
| forms | `/[locale]/account/shop?product=<productId>` opens that product (result-page product CTAs) |
| automation | events `checkout.abandoned`, `checkout.completed`, `checkout.recovered`, `order.paid`, `payment.failed`, `promotion.redeemed`, `voucher.expiring` as triggers and exits; `markCheckoutRecoveryMessage` (R2) |

## 11. Edge cases and failure modes

1. **Double click on Pay.** Same `client_key` returns the existing order and its open `checkout_url`; a different key on the same checkout while an order is pending returns that pending order too (one pending order per checkout).
2. **Webhook arrives twice or out of order.** Each delivery has its own `webhook_events` row and job, but `applyProviderStatus` ignores non-forward moves and the paid transaction runs only from `pending_payment`; side effects have keys (`payment:<id>:paid`).
3. **Webhook never arrives.** `payments.scan_expired` syncs every open payment after 30 minutes; the return page can enqueue `payments.sync` while polling.
4. **Paid after local expiry.** The payment becomes `paid` and the order `expired -> paid` (rule 28). Credits, membership and vouchers are delivered and the promotion redemption is re-confirmed. If a booking's seat is gone, `booking.confirmBookingsForOrder` re-books when capacity is free and otherwise returns the line in `unavailableOrderLineIds`; commerce refunds that line through the job `commerce.refund_unavailable_lines` and `refundOrderLine` (`seat_no_longer_available`) within seconds and the customer gets `commerce.refund_confirmation` (no staff task; cross-module D22).
5. **Price changes during checkout.** The order is priced at `placeOrder`; if that total differs from the last quote shown, `placeOrder` returns `conflict: price_changed` with the new quote and creates nothing.
6. **Promotion hits `max_uses` concurrently.** The `FOR UPDATE` lock on the promotion serialises; the second order gets `promo_exhausted` and is priced without it, after showing the customer the new total.
7. **Member status changes after the order is created.** Price stays as quoted; the trace records the status used.
8. **Mollie down at checkout.** `payments.create` fails; the payment is `failed`, the order stays `pending_payment`, the page says "Payment service unavailable, try again in a minute"; the dead-job alert fires if retries fail.
9. **Customer closes the browser on the Mollie page.** The webhook settles the status; if it stays open, expiry after 30 minutes releases seats, euro credit and promotion uses; the checkout becomes `abandoned` with `payment_expired`.
10. **Zero-total order.** Paid in the creating transaction; no invoice is issued for it: finance issues no invoice for a 0 total (finance rule 3), so no invoice number is used; the order confirmation email still goes out, without invoice link.
11. **Euro credit covers part, card payment fails.** The `credit_balance` payment stays paid until the order expires; expiry gives the euro credit back with `credits.releaseCredits(tx, ctx, {ref: {type: 'order', id: orderId}, reason: 'order_expired'})` (one release per consume entry, so idempotent) and the `credit_balance` payment becomes `cancelled`.
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
26. **Bank transfer never arrives.** After 14 days the order shows as `bank_transfer_overdue` on the attention list and finance emits `invoice.overdue` at day 7 overdue; staff cancel it (commerce `cancelOrder` or finance's manual credit note, which calls `commerce.cancelOrder`), the open invoice is fully credited and nothing was delivered.
27. **Renewal mandate revoked at the bank.** The recurring payment fails; `credits.applyRenewalFailure` starts dunning (credits rule 50) and the retry on day 3 reuses the same renewal order through `createRecurringCharge`; the mandate is set `invalid` after `getMandate` reports it.
28. **Webhook and return-page poll sync the same payment at once.** Both run `syncPayment`; the order row lock and `status = 'pending_payment'` guard make the second a no-op, and the credits calls (`grantCredits` keys per unit, `activateMembership` per order, `applyRenewalPayment` per period) and `finance.issueInvoice` are idempotent.
29. **Customer already has a membership and buys another.** `credits.canStartMembership(db, personId, {startsOn})` already warns in the quote and `placeOrder` refuses (`already_member`); a plan change is cancel at period end plus a new plan that starts later (credits rule 57, `data.start_on`).
30. **No published terms.** Checkout refuses with `terms_unavailable`; the site's go-live banner shows the cause (rule 26a).
31. **Cash sale after the day was closed.** `posSell` with method cash refuses with `day_closed`; staff with `commerce.refund` reopen the day, the reopen is audited and the next close recounts.
32. **Withdrawal after part of a package was used.** `withdrawalPlan` refunds the unused units only; a membership becomes a staff task and is refunded pro rata to days elapsed after staff cancel it; past the deadline the action returns `withdrawal_expired` and staff can still refund as a normal refund.
33. **A session line arrives with quantity 2, or a non-POS session line without exactly one `bookingIds` element** (a caller bug). `createOrder` refuses with `validation` before writing anything (rule 21; `order_lines_session_chk` would refuse quantity 2 or a second id too).
34. **The last seat is taken at the counter while the POS basket is open.** Online, booking checks capacity and inserts its `reserved` rows under its session lock before calling `createOrder`, so `createOrder` meets no capacity race. At the POS, `booking.createBookingForPosLine` throws `ConflictError('session_full')` inside the `posSell` transaction; the transaction rolls back, the caller gets `conflict: sold_out`, and no order, line, booking or promotion use remains.
35. **Gift voucher refunded before its delivery date.** The refund voids the voucher and cancels the queued email through `email.cancelScheduledMessage`; if the email already went out, the voucher is still voided, so the code no longer redeems.
36. **Late `paid` for a cancelled renewal order** (the SEPA debit could not be cancelled). The payment is recorded `paid`, the order stays `cancelled`, a full refund (reason `order_cancelled`) is created at once and credits is not called, so the expired membership is not revived.

## 12. Build packages

All nine packages are **strictly sequential** (P1 before P2 before ... P9), so later packages may edit the module's shared registry files (`actions.ts`, `queries.ts`, `api.ts`, `jobs.ts`, `schedules.ts`, `events.ts`, `permissions.ts`, `nav.ts`, `privacy.ts`, `seed.ts`, `config.ts`, the three `commerce.json` catalogues, `commerce.views.ts`, `e2e/commerce.spec.ts`); each package lists them. Logic lives in `apps/web/modules/commerce/server/<area>.ts` files that only one package creates. No package edits `package.json`, the lockfile, migrations, generated registries or frozen files. Every package's done-definition includes: `pnpm typecheck`, `pnpm lint`, its Vitest suites green on `createTestDb()` with the payments `fake.ts`, `pnpm i18n:check` for keys it added, and the module's `jobs.test.ts` double-run cases for any job it added. Cross-module functions that are not merged yet are mocked in the caller's tests (architecture section 11); the real seams are proven in Wave 2.

Proposal promises and where they are tested:

| Promise (proposal section 12 V1 and R2, section 11 scenarios) | Package and test |
| --- | --- |
| Customer can pay | P4 `paid.test.ts`, P5 e2e "buys a 5-day package" |
| Customer can cancel (money side) | P6 `refunds.test.ts` (`refundOrderLine` from booking, in-policy cancellation), booking's own e2e for the booking side |
| Package balance updates | P5 e2e "sees 5 sessions remaining" (credits fulfils) |
| Member discount applies automatically | P1 `pricing.test.ts`, P3 `quote.test.ts`, P5 e2e member price |
| Reports reflect the transaction | P4 `paid.test.ts` asserts `paid_at`, status and lines that ops' `v_revenue_daily` reads; ops' view test |
| Data can be exported, deletion propagates (scenario 7) | P4 `privacy.test.ts`; ops `scenario-7-deletion` covers commerce through `GDPR_REGISTRY` |
| Waiting lead who buys is reclassified (R2) | `order.paid` from P4 changes `v_person_status` (credits); booking R26 moves the queue |
| Payments monitoring (SLA Critical "payments not working") | P4 `expiry.test.ts` asserts the 15-minute alert fingerprint; platform PL-75 for webhook silence |
| Abandoned checkout recovery (R2) | P5 `checkouts.test.ts` (detection, V1), P8 `recovery.test.ts` and e2e |

### commerce-P1 (V1): schema, views and pure core
- Goal: every V1 table, enum, check, index and view of section 2 (including `pos_day_closes` and the order columns `terms_version_id`, `withdrawal_until_at`); the pure pricing, VAT, all state machines of section 3.1, refund and withdrawal plans, voucher code logic and the `CommerceSettings` schema.
- Files: edit `packages/db/src/schema/commerce.ts` (add columns and tables to the Wave 0 stubs; existing columns untouched); create `packages/db/src/schema/commerce.views.ts` (`v_product_current_prices`, `v_order_balances`, `v_payment_attention`); create `packages/core/src/commerce/{index.ts,schemas.ts,pricing.ts,vat.ts,state-machine.ts,refunds.ts,vouchers.ts,references.ts}`.
- Interfaces: `quote`, `vatOf`, `nextPaymentStatus`, `nextOrderStatus`, `nextRefundStatus`, `nextVoucherStatus`, `nextCheckoutStatus`, `refundPlan`, `withdrawalPlan`, `deriveVoucherCode`, `normaliseVoucherCode`, `newOrderReference(random): string`, Zod `CartItem` and `CommerceSettings`, types of 4.1.
- Depends on: Wave 0 (`_shared.ts` helpers, `APPEND_ONLY_TABLES` containing `price_versions` and `order_lines`, which Wave 0 already holds, so commerce makes no append-only request; cross-module D43), `crm:persons,companies`, `platform:users,files`, `booking:sessions,ticket_types`, `credits:credit_grants`, `finance:invoices`, `email:email_messages` and `site:page_versions` tables for foreign keys (all Wave 0 contract stubs except `ticket_types`, `companies` and `page_versions`, which exist after Wave 0 as stub tables of their owners' files; if one is missing the column is declared without the FK reference and the owner adds it in Wave 2).
- Tests: `packages/core/src/commerce/pricing.test.ts` (base by audience; member version beats member pct; person price wins; best single discount, no stacking; tie order of rule 9; fixed capped at unit price; vouchers and memberships excluded; each warning code; trace contents; historical `at` picks the older version; time-limited version falls back after `valid_to_at`); `vat.test.ts` (6, 12, 21 %, half-up at .5 cent, sum of lines); `state-machine.test.ts` (for each machine of section 3.1 every listed transition is accepted and every unlisted pair refused; the `local_timeout` exception; no state without an incoming transition except the initial one, so no dead state); `refunds.test.ts` (pro rata unused units, payment order credit-balance first, cap; `withdrawalPlan` full refund of unused package, used units deducted, membership pro rata by days, dated lines exempt, after 14 days refused); `vouchers.test.ts` (derivation stable, normalisation of O/I/L, format); `packages/db/src/schema/commerce.test.ts` on PGlite (each check constraint rejects bad rows; partial unique on promotion code; `orders_terms_chk`; `orders_renewal_uq` refuses a second live renewal order for one period; `order_lines_session_chk` refuses a session line with quantity 2; with `applyCustomSql(handle)` from `@beam/db/testing`, `order_lines` and `price_versions` reject update and delete; `v_product_current_prices`, `v_order_balances` and each `v_payment_attention` kind return the expected rows). Coverage of `commerce/pricing` above 90 %.
- Done: the above green; `createTestDb()` builds the schema.
- **Build order note (03-build-order.md, forward-call stubs):** this package also owns `apps/web/modules/commerce/api.ts` and declares in it every commerce function that another module calls (section 4 and section 10), with its final signature, as a typed stub that throws `NotImplementedError`. Later commerce packages replace the stub bodies; no signature changes without a cross-module decision.

### commerce-P2 (V1): payment provider adapters
- Goal: Mollie adapter, Stripe and Viva stubs, provider selection, fake extended with the added methods.
- Files: edit `packages/integrations/src/payments/provider.ts` (additive methods of section 6) and `fake.ts`; create `mollie.ts`, `stripe.ts`, `viva.ts`, `select.ts`, `index.ts` re-export edit.
- Interfaces: `PaymentProvider` (section 6), `createMollieProvider({apiKey, webhookBaseUrl, onCall, fetch?})`, `createStubProvider(name)`, `selectProvider(channel, settings, env)`, `FakePaymentProvider` with `settle`, `chargeback`, `failNext`.
- Depends on: Wave 0 `packages/integrations/src/payments/{provider.ts,fake.ts}`, `IntegrationError`.
- Tests: `mollie.test.ts` with an injected `fetch` returning recorded Mollie JSON (create payment with `Idempotency-Key`, get payment mapping every Mollie status, refunds, customers, mandates, terminal, 429 retryable, 422 permanent, Zod rejection of malformed bodies, `onCall` without bodies); `fake.test.ts`; `select.test.ts` (per channel; stub refused without key; `PAYMENTS_FAKE=1` selects the payments fake and leaves every other provider switch alone).
- Done: suites green; no network in tests; `PAYMENTS_FAKE=1` selects the payments fake only, and in production it makes platform's `/api/health` `config` check fail with 503 (PL-74, cross-module D49).

### commerce-P3 (V1): catalogue, prices and promotions in the back-office
- Goal: products, price versions, person prices, promotions with all rules 1-6 and 17-18; seed data.
- Files: create `apps/web/modules/commerce/server/catalogue.ts`, `server/promotions.ts`; edit `actions.ts`, `queries.ts`, `permissions.ts`, `nav.ts`, `seed.ts`, `config.ts` (declares the settings `commerce` and `payment_provider_by_channel` with their Zod schemas and defaults, Convention 3); create `packages/db/src/seed/commerce.ts` (products: day session walk-in €45, night €95, 5-day package €200 / 6 months, 10-day package €380 / 12 months, 2-night package €180, monthly membership €89 with 4 day credits and 10 % discount, event ticket €25, gift voucher custom €25-€500, merchandise item; settings keys of 2.4); create `app/(admin)/admin/products/{page.tsx,new/page.tsx,[id]/page.tsx,[id]/person-prices/page.tsx,promotions/page.tsx,promotions/new/page.tsx,promotions/[id]/page.tsx,loading.tsx,error.tsx}` and `apps/web/modules/commerce/ui/{product-form.tsx,price-history.tsx,promotion-form.tsx}`; edit `packages/core/src/i18n/messages/{nl-BE,fr-BE,en}/commerce.json`.
- Interfaces: actions `createProduct`, `updateProduct`, `setProductActive`, `addPriceVersion`, `setPersonPrice`, `revokePersonPrice`, `createPromotion`, `updatePromotion`; `api.getProductPrice`, `api.listPublicPrices`, `api.getProductCards`, `api.getQuote` (loads products, prices, person prices, member benefits and eligible promotions, then calls the pure `quote`); `server/promotions.ts` `loadEligiblePromotions(tx, {personId, channel, code, at}): Promise<Array<PromotionRow & {isEligible: boolean}>>`.
- Depends on: P1; `crm:isInSegment`, `crm:getPersonStatus`; `credits:getMembershipForPerson, canStartMembership`; `platform:action(), requirePermission, getSetting`.
- Tests: `apps/web/modules/commerce/server/catalogue.test.ts` (activation blocked by missing locale and by missing price; version numbering under concurrency; append-only enforced; `listPublicPrices` returns member amounts only when a member version exists; `getProductCards` per locale), `promotions.test.ts` (eligibility for each rule; locked fields after use; code upper-casing and uniqueness; per-person limit counts non-released redemptions), `quote.test.ts` (`getQuote` member detection uses `getMembershipForPerson.isMember`, not the status override; guest is `public`; a membership line returns `already_member` from `canStartMembership(personId, {startsOn})`), `permissions.test.ts` (each action refused without its permission).
- Done: suites green; admin pages render with seed data in `pnpm dev`.

### commerce-P4 (V1): order engine, payments, webhook and the paid transaction (split into commerce-P4a and commerce-P4b)
- Goal: `createOrder` (storing `items[].bookingIds` on the lines, no booking call, and the admin `expiresAt`), `startPayment`, provider sync, the paid transaction (rules 19-35), expiry and draft expiry, cancellation (rule 22b), renewal orders, recurring charges and pay links for credits (rule 22c), `recordBankTransferPaid`, `revokeMandatesForPerson`, privacy registration.
- Files: create `apps/web/modules/commerce/server/{orders.ts,payments.ts,paid.ts,expiry.ts,recurring.ts,bank-transfer.ts}`, `apps/web/modules/commerce/ui/receipt-pdf.tsx`, `app/api/webhooks/mollie/route.ts`, `packages/email/src/templates/commerce/{order-confirmation.tsx,payment-failed.tsx,portal-invitation.tsx,index.ts}` (keys `commerce.order_confirmation`, `commerce.payment_failed`, `commerce.portal_invitation`); edit `api.ts`, `jobs.ts` (`payments.create`, `payments.sync`, `payments.scan_expired`, `payments.charge_recurring`, `payments.cancel`, `commerce.render_receipt`, `commerce.revoke_mandate`, `commerce.erase_provider_customer`, the `mollieWebhook` handler), `schedules.ts`, `events.ts`, `privacy.ts`, `commerce.json` x3.
- Interfaces: `createOrder`, `startPayment`, `getOrderStatus`, `cancelOrder`, `createRecurringCharge`, `createRenewalLinkOrder`, `getPayLinkForOrder`, `cancelRenewalOrder`, `getActiveMandate`, `recordBankTransferPaid`, `revokeMandatesForPerson`, `getPersonCommerceSummary`, `listPersonOrders`; `syncPayment(ctx, providerPaymentId)`; `applyProviderStatus(tx, ctx, payment, reported): Promise<{changed: boolean; becamePaid: boolean}>`; `finalizePaidOrder(tx, ctx, orderId): Promise<{delivered: DeliveredLine[]; unavailableOrderLineIds: string[]}>`. `getPayLinkForOrder` lives in `server/payment-links.ts`, created here (P6 adds the pay page and `sendPaymentLink`). For unavailable seats `paid.ts` only enqueues `commerce.refund_unavailable_lines`; its handler and `refundOrderLine` land in P6.
- Depends on: P1, P2, P3; `booking:confirmBookingsForOrder, releaseBookingsForOrder`; `credits:grantCredits, activateMembership, applyRenewalPayment, applyRenewalFailure, consumeCredits, releaseCredits, getEuroBalance, getMembershipForPerson, canStartMembership`, R3 `onOrderPaidForReferrals` (mocked until P9); `finance:issueInvoice, issueCreditNote`; `email:sendTransactional`; `crm:findOrCreatePersonByEmail, createTask`; `platform:handleWebhook, defineWebhookHandler, runJobInline, storeFile`.
- Tests: `server/orders.test.ts` (client_key double submit; session line with quantity 2, or a non-POS session line without exactly one `bookingIds` element, refused; `bookingIds` stored in `order_lines.data.booking_ids` and `lineIds` returned in item order; `createOrder` makes no booking call; admin `expiresAt` kept, refused for other channels; promotion reservation and release; per-person limit; zero total paid inline without invoice; euro credit split; membership refused by `canStartMembership`), `server/paid.test.ts` (a package line of quantity 2 calls `grantCredits` twice with `lineUnitIndex` 1 and 2, keys `grant:order_line:<id>:<n>`, `units = products.credit_units`, `startsAt` = `data.start_on` 00:00 Brussels or `paid_at`, and `expiresAt = computeExpiresAt(startsAt, validity_days)`; membership line calls `activateMembership`; renewal order calls `applyRenewalPayment`; voucher lines call no credits function; `confirmBookingsForOrder` once; vouchers activated; `issueInvoice` called with `status: 'paid'` also when an open bank-transfer invoice exists; events and email keys; paid after local expiry moves `expired -> paid` and re-confirms the redemption; unavailable seat lines enqueue `commerce.refund_unavailable_lines` once), `server/expiry.test.ts` (30-minute expiry calls `releaseBookingsForOrder` with `payment_expired` and releases euro credit, redemption and pending vouchers; draft cancelled after 30 days; a payment pending 16 minutes raises `notifySlack` with fingerprint `commerce:payment_pending_15m`, one pending 14 minutes does not), `server/recurring.test.ts` (`createRecurringCharge` twice for one period reuses the order and creates two payments; `payments.charge_recurring` passes the job key as `Idempotency-Key`; failure calls `applyRenewalFailure`; `createRenewalLinkOrder` idempotent per period; `getPayLinkForOrder` returns the same URL until expiry; `cancelRenewalOrder` with an open recurring payment enqueues `payments.cancel`; a late paid on a cancelled renewal order is refunded and calls no credits function), `server/cancel.test.ts` (draft and pending cancelled with releases, `releaseBookingsForOrder` with `order_cancelled`, `{cancelled: true}`; a live provider payment or a paid order returns `{cancelled: false}` without throwing; open bank-transfer order calls `issueCreditNote({noRefund: true})` once, also when finance calls `cancelOrder` inside its own transaction), `server/bank-transfer.test.ts` (placement passes `dueOn` = payment `expires_at` date to `issueInvoice({status: 'open'})`; `recordBankTransferPaid({orderId, paidOn, reference})` twice settles once; a cancelled order ignores it), `server/mandates.test.ts` (`revokeMandatesForPerson` revokes every valid mandate, enqueues one job each, returns the count, second call returns 0), `receipt.test.ts` (PDF bytes produced per locale; VAT per rate; withdrawal notice on online orders; missing key is permanent), `webhook.test.ts` (bad token 401; duplicate delivery runs `syncPayment` once in effect; unknown id ignored; payment not yet committed retries), `jobs.test.ts` (double run of every job), `privacy.test.ts` (export contents; erase leaves no person reference except retained-legal rows; refusal with a live payment).
- Done: suites green with fakes; the paid transaction is one database transaction (asserted by a failing `grantCredits` mock rolling everything back).

**Split for the build (docs/plan/03-build-order.md).** commerce-P4 is too large for one agent pass, so it is built as two packages in consecutive waves. The text above stays the reference for rules, interfaces and test cases.

### commerce-P4a (V1): order engine, payment sync, Mollie webhook and the paid transaction
- Goal: `createOrder`, `startPayment`, `getOrderStatus`, provider sync through the Mollie webhook, the paid transaction (rules 19-35) as one database transaction, receipts and the order emails.
- Files: create `apps/web/modules/commerce/server/{orders.ts,payments.ts,paid.ts}` with `orders.test.ts` and `paid.test.ts`, `apps/web/modules/commerce/ui/receipt-pdf.tsx` and `receipt.test.ts`, `app/api/webhooks/mollie/route.ts` and `webhook.test.ts`, `packages/email/src/templates/commerce/{order-confirmation.tsx,payment-failed.tsx,portal-invitation.tsx,index.ts}`; edit `api.ts`, `jobs.ts` (`payments.create`, `payments.sync`, `commerce.render_receipt`, the `mollieWebhook` handler), `jobs.test.ts`, `events.ts`, `commerce.json` x3.
- Interfaces: `createOrder`, `startPayment`, `getOrderStatus`, `getPersonCommerceSummary`, `listPersonOrders`, `syncPayment`, `applyProviderStatus`, `finalizePaidOrder`.
- Depends on: P2, P3; cross-module calls through the stubs.
- Tests: `orders.test.ts`, `paid.test.ts`, `webhook.test.ts`, `receipt.test.ts`, `jobs.test.ts` (its jobs), with the cases listed under commerce-P4.
- Done: suites green with fakes; a failing `grantCredits` mock rolls the paid transaction back.

### commerce-P4b (V1): expiry, cancellation, recurring charges, bank transfer, mandates and privacy
- Goal: expiry and draft expiry with the 15-minute payment alert; `cancelOrder` (rule 22b); renewal orders, recurring charges and pay links for credits (rule 22c); `recordBankTransferPaid`; `revokeMandatesForPerson`; privacy registration.
- Files: create `apps/web/modules/commerce/server/{expiry.ts,cancel.ts,recurring.ts,payment-links.ts,bank-transfer.ts,mandates.ts}` with `expiry.test.ts`, `cancel.test.ts`, `recurring.test.ts`, `bank-transfer.test.ts`, `mandates.test.ts`; edit `api.ts`, `jobs.ts` (`payments.scan_expired`, `payments.charge_recurring`, `payments.cancel`, `commerce.revoke_mandate`, `commerce.erase_provider_customer`), `jobs.test.ts`, `schedules.ts`, `events.ts`, `privacy.ts` and `privacy.test.ts`, `commerce.json` x3. `cancelOrder` moves from `orders.ts` to its own `server/cancel.ts` so the two packages never share a logic file.
- Interfaces: `cancelOrder`, `createRecurringCharge`, `createRenewalLinkOrder`, `getPayLinkForOrder`, `cancelRenewalOrder`, `getActiveMandate`, `recordBankTransferPaid`, `revokeMandatesForPerson`.
- Depends on: P4a (sequential: shared `api.ts`, `jobs.ts`, `events.ts`, catalogues).
- Tests: `expiry.test.ts`, `cancel.test.ts`, `recurring.test.ts`, `bank-transfer.test.ts`, `mandates.test.ts`, `privacy.test.ts`, `jobs.test.ts` (its jobs), with the cases listed under commerce-P4.
- Done: suites green with fakes.

### commerce-P5 (V1): customer shop and checkout (portal and site), checkout tracking
- Goal: portal shop and product page, checkout, order payment page, return pages, orders list and order detail, site guest checkout and gift page; terms acceptance, company invoice details, membership guard (rules 26a-26c); `checkouts` lifecycle and `checkouts.mark_abandoned` (rules 48-50); WCAG checks (rule 56).
- Files: create `apps/web/modules/commerce/server/checkouts.ts`, `ui/{basket.tsx,quote-lines.tsx,promo-field.tsx,return-poller.tsx}`, `app/[locale]/(portal)/account/shop/page.tsx`, `account/shop/[sku]/page.tsx`, `account/checkout/page.tsx`, `account/checkout/[orderId]/page.tsx`, `account/checkout/return/[orderId]/page.tsx`, `account/orders/page.tsx`, `account/orders/[id]/page.tsx`, `app/[locale]/(site)/checkout/page.tsx`, `(site)/checkout/return/[orderId]/page.tsx`, `(site)/gift/page.tsx` with `loading.tsx` and `error.tsx` each; edit `actions.ts` (`startCheckout`, `updateCheckout`, `placeOrder`, `payOrder`, `retryPayment`), `queries.ts`, `jobs.ts` (`checkouts.mark_abandoned`), `schedules.ts`, `events.ts`, `commerce.json` x3; create `e2e/commerce.spec.ts` (uses `@axe-core/playwright`; if Wave 0 did not install it, the package adds a line to `docs/build/dependency-requests.md` and the axe step is skipped until the orchestrator installs it).
- Depends on: P4; `booking:getAvailability`; `credits:getEuroBalance, canStartMembership`; `finance:setOrderBillingDetails, BillingDetailsInput`; `site:getCurrentLegalVersion, recordTermsAcceptance`.
- Tests: `server/checkouts.test.ts` (re-quote and price-changed flag; abandoned after 60 min with each reason; event only with a person; `started -> completed` and `abandoned -> completed` with `checkout.completed`; expired after 30 days from both states; guest gets public price even with a member's email; terms version stored and acceptance recorded; `terms_unavailable` without a published version; `landingPath` stored from `from`; `?product=<id>` opens the product page and an unknown id shows the notice; billing details passed to finance; `payOrder` refuses an expired order); `e2e/commerce.spec.ts`: customer buys a 5-day package with the fake provider and sees "5 sessions remaining" (acceptance "customer can pay", "package balance updates"); member sees the member price automatically (acceptance "member discount works"); guest buys a voucher on the site; a booking-created order is paid on `/account/checkout/[orderId]`; axe finds no serious issue on shop, checkout and return pages.
- Done: unit suites green; e2e green against `beam_dev` with `PAYMENTS_FAKE=1` (payments fake only; the same flag in production fails the `/api/health` `config` check with 503, cross-module D49).

### commerce-P6 (V1): orders back-office, refunds, withdrawals, payment links, attention feed, vouchers
- Goal: rules 22a, 36-41, 45-47a, 54; staff orders and payment paths; admin order screens; pay page; voucher redemption in the portal; `refundOrderLine` for booking; the pay page used by credits' renewal links; dated gift-voucher emails (rule 45a).
- Files: create `apps/web/modules/commerce/server/{refunds.ts,withdrawals.ts,staff-orders.ts,payment-links.ts,vouchers.ts,attention.ts}`, `app/(admin)/admin/orders/{page.tsx,new/page.tsx,[id]/page.tsx,[id]/refund/page.tsx,attention/page.tsx,loading.tsx,error.tsx}`, `app/[locale]/(site)/pay/[token]/page.tsx`, `packages/email/src/templates/commerce/{payment-link.tsx,refund-confirmation.tsx,gift-voucher.tsx}` (keys `commerce.payment_link`, `commerce.refund_confirmation`, `commerce.gift_voucher`), `apps/web/modules/commerce/ui/voucher-pdf.tsx`; edit `templates/commerce/index.ts`, `actions.ts` (`createStaffOrder`, `choosePaymentPath`, `sendPaymentLink`, `cancelOrder`, `refundOrder`, `withdrawOrder`, `retryRefund`, `confirmManualRefund`, `redeemVoucher`, `resendVoucher`, `voidVoucher`, `emailReceipt`), `queries.ts`, `api.ts` (`listPaymentAttention`, `refundOrderLine`), `server/payment-links.ts` (P4 file, sequential), `jobs.ts` (`payments.refund`, `payments.create_link`, `commerce.issue_voucher_email`, `commerce.refund_unavailable_lines`, `commerce.expire_vouchers`), `schedules.ts`, `events.ts`, `account/orders/[id]/page.tsx` (withdraw button; P5 file, sequential), `account/orders/page.tsx` (voucher field), `nav.ts`, `commerce.json` x3.
- Depends on: P5; `finance:issueCreditNote, markCreditNoteSettled, getInvoiceForOrder`; `credits:getGrantUsage, revokeGrantRemainder, cancelMembershipForRefund, releaseCredits, grantCredits`, R3 `onOrderRefundedForReferrals` (mocked until P9); `booking:cancelBookingsForOrderLine`; `email:cancelScheduledMessage`; `crm:createTask`; `platform:rateLimit`.
- Tests: `server/refunds.test.ts` (partial package revokes only unused units; booking lines cancelled through `cancelBookingsForOrderLine` with `refunded`; `refundOrderLine` from booking does not call booking back and is idempotent; membership line calls `cancelMembershipForRefund` with a day-pro-rata default; voucher refund only unredeemed and cancels a scheduled voucher email; credit-balance first; full credit-balance refund calls `releaseCredits(reason 'refund')`, a partial one `grantCredits` with `source: 'manual'`, `refundId`, `vatRatePct: null`, `expiresAt: null`, `reason: 'partial_refund'` and key `grant:refund:<refund_id>`; above €500 needs `invoices.issue`; one credit note per refund; `markCreditNoteSettled` on `refunded`; provider failure -> `failed` -> retry -> `pending`; no credit note for a 0-total order), `withdrawals.test.ts` (rule 54 cases, deadline, POS excluded), `staff-orders.test.ts` (draft -> pending on each path; bank transfer refused with session lines; cancel refused with a live provider payment; cancel of a bank-transfer order credits the open invoice), `payment-links.test.ts` (token single order, expiry, paid state, terms required), `vouchers.test.ts` (redemption calls `grantCredits` with source `voucher` and key `grant:voucher:<id>` and stores `credit_grant_id`; `deliverOn` in the future sends with `sendAt`; redeem once under concurrency; rate limit by IP and person; expired voucher refused; `commerce.expire_vouchers` sets `expired` and emits `voucher.expiring` once), `attention.test.ts` (each feed kind appears and disappears), `jobs.test.ts` additions (double run of each new job).
- Done: suites green; e2e cases "staff refunds an unused package" and "customer withdraws an unused package within 14 days" added to `e2e/commerce.spec.ts`.

### commerce-P7 (V1): front-desk POS, receipts and day close
- Goal: POS screen, terminal, cash and bank-transfer payments, walk-in session bookings, receipts, day summary and day close (rules 42-44, 55).
- Files: create `apps/web/modules/commerce/server/{pos.ts,pos-day.ts}`, `ui/{pos-grid.tsx,pos-basket.tsx,terminal-dialog.tsx}`, `app/(admin)/admin/pos/{page.tsx,receipt/[orderId]/page.tsx,day/page.tsx,loading.tsx,error.tsx}`; create `packages/email/src/templates/commerce/pos-receipt.tsx` (key `commerce.pos_receipt`); edit `templates/commerce/index.ts`, `actions.ts` (`posSell`, `posPayOrder`, `posCancelTerminal`, `closePosDay`, `reopenPosDay`), `queries.ts` (`getPosDaySummary`, `getPosOrder` for the `?order=` deep link), `jobs.ts` (`payments.terminal`), `nav.ts`, `commerce.json` x3, `e2e/commerce.spec.ts`. The POS receipt email is `commerce.pos_receipt` with the PDF attached.
- Depends on: P6; `crm:searchPersons, createPersonWithoutEmail`; `booking:createBookingForPosLine, confirmBookingsForOrder, listBookableSessions`; `finance:setOrderBillingDetails`; `platform:storeFile`.
- Tests: `server/pos.test.ts` (anonymous only for items and vouchers; cash change; bank transfer invoice open, delivery deferred and refused for session lines; walk-in session line created without booking ids and booked through `createBookingForPosLine` in the `posSell` transaction, `session_full` rolls the sale back as `sold_out`, the booking is confirmed by the paid transaction's `confirmBookingsForOrder` and released through `releaseBookingsForOrder` (`payment_expired`) when a sale whose terminal payment failed expires unpaid; `/admin/pos?order=<id>` loads a pay-at-desk order and `posPayOrder` by cash confirms its booking; company toggle calls `setOrderBillingDetails` before the payment; terminal paid via fake webhook; cancel hanging terminal; voucher redemption at the counter; cash refused on a closed day), `pos-day.test.ts` (expected cash with float and cash refunds; difference note required; difference above €20 creates one task; reopen needs `commerce.refund`), e2e "reception sells a package by cash and prints the receipt" with an axe check on `/admin/pos`.
- Done: suites and e2e green.

### commerce-P8 (R2): abandoned checkout recovery and multi-ticket carts
- Goal: rules 51-52, resume links, `markCheckoutRecoveryMessage`, flag `ff_commerce_checkout_recovery`; carts with several ticket types of one event. The report screen is ops-P7.
- Files: create `apps/web/modules/commerce/server/recovery.ts`, `app/[locale]/(site)/checkout/resume/[token]/page.tsx`, `packages/email/src/templates/commerce/checkout-recovery.tsx` (key `commerce.checkout_recovery`, sent by automation as a marketing message); edit `templates/commerce/index.ts`, `api.ts` (`markCheckoutRecoveryMessage`, `getCheckoutRecoveryProps(tx, checkoutId): Promise<{resumeUrl, items, totalCents, locale}>`, which creates the resume token on first call), `jobs.ts` (attribution inside `checkouts.mark_abandoned`), `events.ts` (`checkout.recovered`), `queries.ts`, `commerce.json` x3; `packages/core/src/commerce/pricing.ts` ticket-type grouping.
- Depends on: P7; `automation:` seeded `abandoned-checkout` sequence (activated by automation-P8); `email:findLatestMessage`; `booking:ticket_types` with several types per session.
- Tests: `server/recovery.test.ts` (recovered within 7 days with a matching product; not recovered after 8 days or with other products; revenue; `markCheckoutRecoveryMessage` sets the id only once; a null id is filled from `email.findLatestMessage(db, {personId, templateSlug: 'commerce.checkout_recovery', after})`; resume token single checkout, re-quotes on open), `pricing.test.ts` additions (two ticket types, member price per type).
- Done: suites green; the e2e "abandon, receive email in sink, resume, pay, ops report shows 1 recovered" green with the flag on for testers.

### commerce-P9 (R3): Lightspeed import, referral codes, sales views
- Goal: rule 53, partner referral promotions, `v_sales_lines`, `v_lightspeed_daily`, `countOrdersByLanding` for site.
- Files: edit `packages/db/src/schema/commerce.ts` (add `lightspeed_imports`, `lightspeed_sales`, `promotions.partner_company_id`), `commerce.views.ts`; create `packages/core/src/commerce/lightspeed.ts`, `apps/web/modules/commerce/server/lightspeed.ts`, `app/(admin)/admin/pos/lightspeed/page.tsx`; edit `actions.ts` (`uploadLightspeedCsv`), `api.ts` (`countOrdersByLanding`), `jobs.ts` (`commerce.import_lightspeed`, `commerce.import_lightspeed_pending`), `schedules.ts`, `privacy.ts` (`NO_PII_TABLES` entries), `seed.ts`, `server/promotions.ts` (partner code eligibility), `ui/promotion-form.tsx`, `commerce.json` x3.
- Depends on: P8; `crm:companies` (`is_partner`); `platform:files`.
- Tests: `packages/core/src/commerce/lightspeed.test.ts` (semicolon and comma CSV, Belgian decimal commas, VAT parsing, bad rows), `server/lightspeed.test.ts` (idempotent re-import, chunk continuation), `views.test.ts` (`v_sales_lines` deferred vouchers, refunds netted, no person column), `landing.test.ts` (`countOrdersByLanding` returns `{landingPath, utmCampaign, orders, revenueCents}` grouped by `checkouts.landing_path` and `utm.campaign`, paid orders only, refunds not netted).
- Done: suites green.

Release 4 has no commerce package (section 1).

## 13. Decisions made

Additions to the architecture (tables, columns, enum values, interfaces):
1. New tables: `promotion_redemptions` (per-person limits need a per-person count), `vouchers` (gift voucher codes, recipients and redemption), `provider_customers` (Mollie recurring needs a customer object), `pos_day_closes` (drawer count per business day), `lightspeed_imports` and `lightspeed_sales` (R3 reporting import).
2. New `products` columns: `item_category`, `is_custom_amount`, `min_amount_cents`, `max_amount_cents`, `is_shop_visible`, `is_pos_visible`, `image_file_id`. New `price_versions.reason`, `person_prices.revoked_at`, `promotions.name` and `created_by_user_id`, `promotions.partner_company_id` (R3).
3. New `checkouts` columns: `channel`, `promo_code`, `total_cents`, `order_id`, `last_activity_at`, `abandoned_reason`, `resume_token_hash`, `recovered_at`, `completed_at`, `landing_path` (R3 site insights). New `vouchers` columns beyond the table itself: `deliver_on`, `email_message_id` (dated gift emails).
4. New `orders` columns: `reference`, `expires_at`, `terms_version_id`, `withdrawal_until_at`, `pay_token_hash`, `pay_token_expires_at`, `is_erased_subject`, `created_by_user_id`, `note`, `cancelled_at`, `renewal_membership_id`, `renewal_period_end_on` (one live renewal order per membership period). New `order_lines` columns: `line_no`, `product_kind`, `sku`, `data` (`start_on`, `voucher_id`); session, night and ticket lines have quantity 1. New `payments` columns: `sequence_type`, `refunded_cents`, `chargeback_cents`, `terminal_id`, `cash_received_cents`, `failed_reason`, `expires_at`, `created_by_user_id`. New `refunds` columns: `order_id`, `lines`, `credit_action`, `failed_reason`. New `mandates` columns: `provider_customer_id`, `details_summary`, `revoked_at`.
5. `payments_provider` gains `credit_balance`, so euro credit from vouchers pays orders through the same payments model.
6. `PaymentProvider` gains `createCustomer`, `getMandate`, `revokeMandate`, `deleteCustomer`, `cancelPayment` (recurring payments, dunning, renewal cancellation and erasure need them).
7. New env secret `VOUCHER_CODE_SECRET` (voucher codes and, under the separate `pay:` label, payment-link tokens are re-derivable, never stored in plain text).
8. New job kinds: `commerce.render_receipt`, `commerce.issue_voucher_email`, `commerce.refund_unavailable_lines`, `commerce.expire_vouchers` (daily 00:20), `commerce.erase_provider_customer`, `commerce.revoke_mandate`, `payments.charge_recurring`, `payments.cancel`, `commerce.import_lightspeed` and `commerce.import_lightspeed_pending`, with its schedule at 02:40 (R3). Credits' `memberships.charge_renewal` (architecture key `renewal:<membership_id>:<period_end>`) calls `commerce.createRecurringCharge`, which enqueues `payments.charge_recurring`; the provider call stays in a commerce job (credits' request, credits rule 48).
9. New settings keys `payment_provider_by_channel` (named in the architecture's integration table) and `commerce`.
10. Cross-module functions: every function in section 10 now exists in its owner's spec with the signature used here (`crm.searchPersons`, booking's four order hooks `confirmBookingsForOrder`, `releaseBookingsForOrder`, `cancelBookingsForOrderLine`, `createBookingForPosLine`, the credits functions of credits 10a, finance's `issueInvoice` shape, email's `cancelScheduledMessage` and `findLatestMessage`). Commerce calls only credits' own names (`grantCredits`, `consumeCredits`, `releaseCredits`, `revokeGrantRemainder`, `activateMembership`, `applyRenewalPayment`, `applyRenewalFailure`, `getMembershipForPerson`, `canStartMembership`, `getEuroBalance`, plus `getGrantUsage`, `cancelMembershipForRefund` and the R3 referral hooks); earlier requests for other names are withdrawn (cross-module D26).
11. The Mollie webhook follows the architecture and platform PL-39: `handleWebhook` inserts `webhook_events` and enqueues `webhook.process` (key `webhook:mollie:<id>:<ms>`); commerce's `defineWebhookHandler` runs `syncPayment()` inside that job. The `payments.sync` job remains for return-page polls and the expiry scan.
12. Promotions live at `/admin/products/promotions`, refunds at `/admin/orders/[id]/refund`, the attention list at `/admin/orders/attention`, so commerce stays inside its owned folders `products`, `orders`, `pos`. The abandoned-checkout report is ops' `/admin/reports/abandoned-checkouts`. Commerce also owns the public routes `(site)/checkout`, `(site)/pay` and `(site)/gift` and the portal routes `account/shop/[sku]`, `account/checkout/[orderId]` and `account/orders/[id]`; the site module must not create them.

Choices the inputs left open:
13. Lightspeed: food and drink stay on Lightspeed (GKS); everything else BEAM sells at the counter moves to the POS in V1. Proposal question 1 is answered this way by default.
14. Lightspeed data arrives as a CSV that staff export and upload; the nightly job processes uploads at 02:40, and an upload is also processed at once. No Lightspeed API client. Ships in R3 together with the management and finance dashboards that use it.
15. Gift vouchers ship in V1 (proposal question 4) as products of kind `voucher` with VAT 0 % at sale (multi-purpose voucher; VAT is charged when the euro credit buys a 6 % or 21 % service), 730 days minimum validity (the Belgian two-year minimum for gift vouchers), custom amounts from €5 to €1,000, one redemption per code into the redeemer's euro credit (1 unit = 1 cent).
16. Voucher sale lines are deferred revenue in `v_sales_lines` (`is_deferred`); revenue is recognised on orders paid with the euro credit.
17. Price resolution: highest version valid at the moment; time-limited prices are higher versions with an end; `member` and `b2b` fall back to `public` when they have no valid version.
18. Best single discount: lowest unit price among base, member version, person price, member percentage and promotions; tie order person price, member version, member percentage, automatic promotion, code promotion. Fixed promotions are per unit and capped. Vouchers and memberships get no member pricing.
19. B2B pricing applies when an order has a `company_id`; only staff create company orders (admin, payment link, POS), never the portal; B2B orders get no member pricing.
20. Promotion `value` is an integer: whole percent (1-100) or cents. `applies_to` empty means all kinds except vouchers and memberships.
21. Promotion uses are reserved at order creation and released on expiry or cancel, so `max_uses` can never be exceeded by pending orders; only a payment that settles after local expiry may overrun it, and the customer keeps the price they paid.
22. Pending orders and capacity reservations expire after 30 minutes; bank-transfer payments are excluded from that and are due in 14 days.
23. A payment marked expired by our own timeout may still become paid when Mollie says so; the customer's money always wins. A seat that is gone by then is refunded automatically (`seat_no_longer_available`), matching booking edge case 3.
24. Payment links are BEAM-hosted pages (`/[locale]/pay/<token>`, 14 days) that create a normal Mollie payment on click: one payment flow, metadata on every payment, works with Stripe and Viva. The adapter still implements `createPaymentLink`; the platform does not call it.
25. The webhook is authenticated by a secret query token (and Mollie's signature header where present); the fetch by id stays the real verification.
26. Every Mollie create call sends `Idempotency-Key` = the job key.
27. Refund allocation: credit-balance payments first (restored as euro credit), then provider payments largest first. Refund amounts default to pro rata unused units and can only be lowered. Refunds above €500 or on orders older than 365 days also need `invoices.issue` (a permission check, not a role check, so BEAM can re-assign it in the roles screen).
28. Bank transfers are settled by finance (staff `markInvoicePaid` or the Billit sync), which calls `recordBankTransferPaid`; commerce has no own "record bank transfer" action. Credits are delivered only after payment, and bank transfer is refused for orders with session, night or ticket lines.
29. Anonymous POS sales are allowed only for items and vouchers.
30. A chargeback creates a finance task and revokes nothing automatically.
31. Abandoned means 60 minutes without checkout activity with a known person or email; the scan runs every 10 minutes; checkouts expire after 30 days; recovery counts a paid order by the same person within 7 days containing one of the checkout's products. The recovery sequence uses purpose `newsletter` and runs only behind `ff_commerce_checkout_recovery` (R2).
32. Guest site checkout always quotes the `public` audience; member prices need a logged-in session.
33. Order references are `BO-` plus 8 random Crockford base32 characters, unique and retried on collision (no database sequence needed).
34. POS receipts are PDFs rendered with the PDF library Wave 0 installs (`@react-pdf/renderer`) from `ui/receipt-pdf.tsx`, plus an 80 mm print page.
35. Retention: checkouts 13 months; raw provider payloads 90 days; orders and payments 10 years (3653 days from 1 January after the fiscal year, the accounting horizon of cross-module D34, matching finance's invoices), then the person link is removed; Lightspeed sales 10 years; person prices 2 years after they end. Keys `commerce.checkouts`, `commerce.payments_raw`, `commerce.orders`, `commerce.person_prices`, `commerce.lightspeed_sales` (cross-module D37).
36. Default VAT rates: day sessions, day packages, memberships, tickets and items 21 %; nights and night packages 6 %; vouchers 0 %.
37. Stripe and Viva adapters ship in V1 as stubs that refuse to run without keys; the settings screen refuses to select them until keys exist.
38. Release 4 has no commerce package; `v_sales_lines` has no person columns so ops can expose it to the `ai` schema.
39. Booking decides capacity and owns the booking rows (cross-module D21): booking inserts its `reserved` rows first under its session lock, then calls `createOrder` with one quantity-1 item per seat carrying `bookingIds: [bookingId]`; commerce stores them in `order_lines.data.booking_ids`, returns `lineIds` in item order and never calls booking inside `createOrder` (booking R18 and its decision 38). POS walk-ins get their row from `booking.createBookingForPosLine` inside `posSell` and are confirmed by the paid transaction. `booking.reserveForOrderLine`, `confirmOrderBookings`, `releaseOrderBookings`, `CartItem.attendeePersonId` and `createOrder({ isPayAtDesk })` do not exist. The portal shop and the site checkout sell no dated services.
40. Commerce orchestrates the paid transaction (architecture section 6) with one credits call per line: `grantCredits` once per package unit (`lineUnitIndex`, key `grant:order_line:<order_line_id>:<n>`, `startsAt` and `expiresAt = computeExpiresAt(startsAt, validity_days)` computed by commerce, so two packages in one order are two grants with their own expiry; cross-module D24), `activateMembership` for membership lines, `applyRenewalPayment` for renewal orders (credits rules 1, 45, 49 and decision 10a).
41. Gift vouchers are code-based: the purchaser gets a code, the redeemer gets the euro credit through `credits.grantCredits` with source `voucher`, `voucherId` and key `grant:voucher:<voucher_id>` at redemption (credits rule 1a). The paid transaction makes no credits call for voucher lines.
42. Euro credit as a payment means is `payments_provider = credit_balance`, one value for vouchers, bonuses and refunded credit (credits asked for `voucher`; this spec decides `credit_balance`).
43. Staff orders start as `draft` (the architecture's `draft` status), so a draft holds no promotion use, no expiry and no invoice until a payment path is chosen; untouched drafts are cancelled after 30 days.
44. Terms acceptance is mandatory for portal, site and link orders and stored as `orders.terms_version_id` plus site's acceptance record; POS and admin orders are exempt.
45. Online purchases of packages, memberships and vouchers carry the 14-day right of withdrawal; dated sessions, nights and tickets are exempt; POS sales have none.
46. Reception closes the POS day with a counted cash amount; differences above €20 create a finance task; a closed day takes no more cash until reopened by `commerce.refund`.
47. Zero-total orders get no invoice (finance rule 3); orders paid fully with euro credit get a normal invoice.
48. Email template keys follow email decision 1: `<m>.<snake_name>`, where `<snake_name>` is the file basename with `-` replaced by `_` (cross-module D1 and D2): `commerce.order_confirmation`, `commerce.pos_receipt`, `commerce.payment_failed`, `commerce.payment_link`, `commerce.gift_voucher`, `commerce.refund_confirmation`, `commerce.portal_invitation`, R2 `commerce.checkout_recovery`. The single `receipt` template is split into `order-confirmation.tsx` and `pos-receipt.tsx` to match email's list. The files stay in `packages/email/src/templates/commerce/`, which the architecture's package table gives to commerce. Attachments are `{fileId, filename}[]`; dated gift vouchers use `sendAt` and are withdrawn with `cancelScheduledMessage` when refunded before delivery.
49. A failed payment sends `commerce.payment_failed` with a retry link, except for renewal orders (credits sends the dunning email) and POS payments.
50. Shop, checkout, pay page and POS meet WCAG 2.1 AA, checked with axe in Playwright.

Cross-module review items (applied, declined and conflicts):
51. Payment monitoring (platform PL-75a): commerce owns "payments pending above 15 minutes" (`commerce:payment_pending_15m`, rule 34) and dead `payments.*` jobs; "3 failed renewals a day" is credits' check (credits rule 50a) because the failure count is a renewal fact. Both alert through `notifySlack()`.
52. Segment eligibility calls `crm.isInSegment(db, segmentId, personId)`; no `matchesSegment` exists.
53. `countOrdersByLanding(db, {from, to})` returns `{landingPath, utmCampaign, orders, revenueCents}[]` (site's request); `checkouts.landing_path` is added because `utm` has no page path. Site's buy links carry `from=<page path>`.
54. Zero-total orders get no invoice (finance rule 3); edge case 10 says so.
55. The paid transaction always calls `finance.issueInvoice({orderId, status: 'paid', paymentId})`, also when an open bank-transfer invoice exists; finance settles it (rule 2a) and returns it with `status: 'existing'` (02-data-model DM-3). Commerce never skips the call.
56. Bank-transfer placement passes `dueOn` = the bank-transfer payment's `expires_at` date, so both modules show one due date.
57. `cancelOrder` on an unpaid bank-transfer order calls `finance.issueCreditNote({orderId, reason, noRefund: true})` in its transaction (rule 22b). `recordBankTransferPaid` takes finance's call shape `{orderId, paidOn, reference}` and stays idempotent on the order; the amount check moves to finance (finance rule 26), so the earlier `amountCents`/`source` inputs and the "short amount" branch are dropped.
58. The POS has the "Invoice to a company" toggle; `posSell` and `posPayOrder` call `finance.setOrderBillingDetails` before any payment. `payments.provider = credit_balance` is the one value finance maps to `payment_method` `voucher` (or `mixed`); commerce adds no `voucher` provider value.
59. `CartItem.bookingIds` (one `reserved` booking id per seat) replaces the earlier `attendeePersonId`, which does not exist (cross-module D21); session, night and ticket lines are quantity 1 with at most one booking id (Zod refinement and `order_lines_session_chk`), and `createOrder` requires exactly one except for channel `pos`.
60. `createOrder` accepts `expiresAt` for channel `admin` only (booking R63 pay-at-desk orders expire at the session's `ends_at`); other channels are refused with `validation`.
61. `refundOrderLine(tx, ctx, {orderLineId, reason})` and `cancelOrder(tx, ctx, {orderId, reason})` are in `api.ts`; `refundOrderLine` never calls booking back.
62. `/admin/pos?order=<orderId>` opens an existing pending order and pays it with `posPayOrder`. `booking.getAvailability` is called with the object input. The opening paragraph now says that booking inserts its `reserved` rows before `createOrder` (cross-module D21). Booking's hook names are used as booking publishes them: `confirmBookingsForOrder`, `releaseBookingsForOrder` (reasons `payment_expired`, `payment_failed`, `order_cancelled`), `cancelBookingsForOrderLine`, `createBookingForPosLine`; commerce's own `startPayment` (renamed from `startOrderPayment`) returns `redirectUrl`.
63. `/[locale]/account/shop?product=<productId>` opens that product (forms' result CTAs).
64. Credits' renewal api is adopted: `createRecurringCharge` (reuses the period's live renewal order on dunning retries through `orders_renewal_uq`), `createRenewalLinkOrder`, `getPayLinkForOrder`, `cancelRenewalOrder`; `createRenewalOrder` and `chargeMandate` are removed. Pay-link tokens are derived (HMAC with the `pay:` label) so `getPayLinkForOrder` can return the same URL while it is valid.
65. Credits calls are adopted as credits publishes them: `grantCredits` per package unit and for voucher redemption, `canStartMembership(personId, {startsOn})` at quote time, R3 `onOrderPaidForReferrals` and `onOrderRefundedForReferrals`, euro via `consumeCredits`/`releaseCredits` with ref `{type: 'order'}` and reasons `order_expired` (expiry and cancellation) and `refund`. A partial refund of euro credit is restored with `grantCredits` (source `manual`, `refundId`, `vatRatePct: null`, `expiresAt: null`, reason `partial_refund`, key `grant:refund:<refund_id>`) because `releaseCredits` has no `amountCents` and releases a whole ref (cross-module D25).
66. Email: `getProductCards(tx, productIds, locale)` exists; template keys are `commerce.<snake_name>` (cross-module D1); attachments are `{fileId, filename}[]`; dated gift vouchers use `sendAt` and `cancelScheduledMessage`; R2 recovery attribution falls back on `findLatestMessage`.
67. `checkout.abandoned` data carries `total_cents` (already in rule 49 and section 4.7).
68. `revokeMandatesForPerson(tx, ctx, personId): Promise<{revoked: number}>` is in `api.ts`; it marks valid mandates `revoked` and enqueues `commerce.revoke_mandate` per mandate (`PaymentProvider.revokeMandate`), for ops' first erasure step.
69. Declined: booking edge case 3's "open a `payment` task for customer service" when a late payment finds the seat gone. Commerce refunds such lines automatically (`seat_no_longer_available`, decision 23): the customer's money returns within seconds and nobody has to act; customer service can still rebook the person by hand. Booking's `unavailableOrderLineIds` return value is used as published (cross-module D21, D22).
70. Declined: renaming `order_lines.data.start_on` to credits' `order_lines.options.starts_on`, and an `options.credit_units` override. Commerce owns `order_lines`; the paid transaction passes the start as `startsAt` and the units from `products.credit_units` in the `grantCredits` call, so credits never needs to read the line's json. No per-line unit override exists (a different unit count is a different product).

Conflicts with other specs (all closed by the chief architect's cross-module decisions; nothing is open):
71. Closed (cross-module D22): booking edge case 3 and booking R18's `confirmBookingsForOrder` comment say that commerce refunds each line returned in `unavailableOrderLineIds` automatically through `refundOrderLine` with reason `seat_no_longer_available` (job `commerce.refund_unavailable_lines`); no customer-service task is opened (decision 69).
72. Closed (cross-module D24): credits reads nothing from `order_lines.data` or `options`; it takes `startsAt`, `expiresAt` and `units` from commerce's `grantCredits` call (decision 70; commerce's column is `order_lines.data.start_on`), and there is no per-line `credit_units` override.
73. Closed (cross-module D25): credits accepts the euro grant `grantCredits({..., source: 'manual', refundId, vatRatePct: null, expiresAt: null, key: 'grant:refund:<refund_id>', reason: 'partial_refund'})` for partial refunds of credit-balance payments (rule 38); `releaseCredits` gets no `amountCents`.
74. Closed (cross-module D1, D2): email section 10's registry lists commerce's 8 dotted keys `commerce.order_confirmation`, `commerce.pos_receipt`, `commerce.payment_failed`, `commerce.payment_link`, `commerce.gift_voucher`, `commerce.refund_confirmation`, `commerce.portal_invitation` and R2 `commerce.checkout_recovery`.
75. Closed (cross-module D32): finance rule 27 no longer mentions a commerce "Record bank transfer" button; commerce has none (rule 43a), and the order screen links to finance's invoice, where staff use `markInvoicePaid`.
76. Closed (cross-module D56): site's buy links (site rules 31 and 46) carry `from=<page path>` on `/[locale]/checkout?sku=`, so `checkouts.landing_path` is filled; without it commerce falls back to the same-origin `Referer`.
77. Closed (cross-module D55): ops' `v_abandoned_checkouts` takes the value from `checkouts.total_cents` (the quote total at the last save) and the product mix from `items[].productId` and `quantity`; `CartItem` carries no price.
78. Closed (cross-module D54): automation's `abandoned-checkout` seed sends both reminders (`remind_1h`, `remind_24h`) as marketing messages with template `commerce.checkout_recovery`, purpose `newsletter`, group `checkout`, behind `ff_commerce_checkout_recovery` (rule 52).
79. Closed (cross-module D21, D23): booking R44 and R63 use `/admin/pos?order=<orderId>` with `posPayOrder` for desk payments and pass `expiresAt` (the session's `ends_at`) with channel `admin` to `createOrder`; there is no `isPayAtDesk` argument (the pay-at-desk marker is booking's own).

Cross-module decisions applied (`_cross-module-decisions.md`, binding):
80. Cross-module decision 1 applied: transactional template keys are `<m>.<name>` with `<name>` the file basename with `-` replaced by `_` (one file, one key) in the opening paragraph, rules 26, 32, 33, 39, 45a and 51, the actions and jobs tables, sections 6 and 10, P4-P8 file lists and decisions 48, 49 and 66; email copy slots are `commerce.email.<name>.<slot>` (section 8).
81. Cross-module decision 2 applied: section 6 lists exactly the 8 commerce keys `commerce.order_confirmation`, `commerce.pos_receipt`, `commerce.payment_failed`, `commerce.payment_link`, `commerce.gift_voucher` (with `sendAt`), `commerce.refund_confirmation`, `commerce.portal_invitation`, R2 `commerce.checkout_recovery`, from the same files.
82. Cross-module decision 5 applied: sections 6 and 10 use `sendTransactional(ctx, {template, personId?, to?, locale, data, key, attachments?: {fileId, filename, inline?}[], context?, sendAt?, replyTo?, headers?})` returning `{emailMessageId, jobId}`; commerce stores `emailMessageId`, and the call returns no delivery status.
83. Cross-module decision 18 applied: checkout passes `acquisition.referral_code` from `site.readReferralCode()` when it creates the person (rule 26, sections 2.4 and 10).
84. Cross-module decision 21 applied: booking inserts its `reserved` rows first and calls `createOrder` with `items[].bookingIds` (stored in `order_lines.data.booking_ids`, `lineIds` returned in item order, no booking call inside `createOrder`); `CartItem.bookingIds` replaces `attendeePersonId`; `createOrder` has no `isPayAtDesk`; `order_lines_session_chk` keeps quantity 1 with one `booking_ids` element except for channel `pos`; the hooks are `confirmBookingsForOrder`, `releaseBookingsForOrder` (`payment_expired` at expiry, `order_cancelled` on cancellation), `cancelBookingsForOrderLine` and, at the POS, `createBookingForPosLine` (rules 21, 22, 22b, 32, 37, section 2.4, 4.1, 4.2, 4.8, 5.2, 10, edge cases 4, 33, 34, P4, P6, P7, decisions 39, 59, 62, 79).
85. Cross-module decision 22 applied: no change needed beyond names; lines in `unavailableOrderLineIds` are refunded automatically through `refundOrderLine` with `seat_no_longer_available` (job `commerce.refund_unavailable_lines`), no customer-service task (rule 32, edge case 4, decision 69); conflict 71 is closed.
86. Cross-module decision 23 applied: no change beyond decision 21; desk payments use `/admin/pos?order=<orderId>` with `posPayOrder`, and booking passes `expiresAt` with channel `admin` (decision 79 closed).
87. Cross-module decision 24 applied: rule 32 states the package grant input (`units: products.credit_units`, `startsAt` = `order_lines.data.start_on` 00:00 Europe/Brussels else `orders.paid_at`, `expiresAt = computeExpiresAt(startsAt, products.validity_days)` from `@beam/core/credits`, key `grant:order_line:<order_line_id>:<n>`); credits reads nothing from the line json (decisions 40, 72).
88. Cross-module decision 25 applied: rule 38 restores a partial euro refund with `grantCredits({personId, kind: 'euro', units, source: 'manual', refundId, vatRatePct: null, expiresAt: null, key: 'grant:refund:<refund_id>', reason: 'partial_refund'})`; `releaseCredits` has no `amountCents` (decisions 65, 73; P6 tests).
89. Cross-module decision 26 applied: P3, P5 and decisions 10, 40 and 41 name only credits' functions; decision 10 no longer names the retired functions; voucher redemption uses `source: 'voucher'` with key `grant:voucher:<voucher_id>`.
90. Cross-module decision 30 applied: section 10 uses `finance.issueInvoice(tx, ctx, {orderId, status?, dueOn?, paymentId?, paidAt?, settledVia?})` returning finance's `IssueInvoiceResult` (`status: 'issued'|'existing'|'skipped'`; rules 32, 43a, decision 55; 02-data-model DM-3) and `finance.getInvoiceForOrder(db, orderId)`.
91. Cross-module decision 31 applied: `cancelOrder` returns `{cancelled: boolean}`, returns `{cancelled: false}` for a non-cancellable order and never throws for its status; finance calls it inside its own transaction and the nested `issueCreditNote` is idempotent on (order, reason) (rule 22b, actions table, api, P4 tests).
92. Cross-module decision 32 applied: no change needed (rule 43a and decision 28 stand); the staff order screen offers the bank-transfer payment path and links to finance's invoice for settlement (conflict 75 closed).
93. Cross-module decision 34 applied: `commerce.orders` and `commerce.lightspeed_sales` keep 3653 days (10 years from 1 January after the fiscal year) instead of 2555 (section 9, decision 35).
94. Cross-module decision 37 applied: retention keys are `commerce.checkouts`, `commerce.payments_raw`, `commerce.orders`, `commerce.person_prices`, `commerce.lightspeed_sales`, seeded `on conflict (key) do nothing` (section 9, decision 35).
95. Cross-module decision 43 applied: `order_lines` is already in Wave 0's `APPEND_ONLY_TABLES`; commerce makes no append-only request (P1 depends-on).
96. Cross-module decision 49 applied: `PAYMENTS_FAKE=1` selects the payments fake only and in production makes `/api/health`'s `config` check fail with 503 (section 6 fake row, P2 and P5 done lines).
97. Cross-module decision 54 applied: rule 52 and section 10 describe `abandoned-checkout` as a marketing automation (purpose `newsletter`, group `checkout`, `requires_flag = ff_commerce_checkout_recovery`) whose two reminders send `commerce.checkout_recovery`; attribution falls back on `findLatestMessage(db, {personId, templateSlug: 'commerce.checkout_recovery', after})` (rule 51, P8; conflict 78 closed).
98. Cross-module decision 55 applied: `checkouts.total_cents` is "quote total at the last save" and `checkouts.items[]` are `CartItem` without prices (section 2; conflict 77 closed).
99. Conventions confirmed applied: event `data` keys are snake_case (`checkout_id`, `order_id`, `total_cents`, `amount_cents`, `promotion_id`, `discount_cents`, `voucher_id`) and the person-price event kind is `person_price.set` (Convention 2, section 4.7, rule 49); the settings `commerce` and `payment_provider_by_channel` are declared in `apps/web/modules/commerce/config.ts`, edited only through platform's `updateSetting`, and `business_hours` is read as booking's setting (Convention 3, section 2.4, P3); idempotency keys use snake_case nouns (`payment_create`, `payment_terminal`, `payment_sync`, `charge_recurring`, `payment_cancel`, `pay_link`, `voucher_email`, `mandate_revoke`, `refund_unavailable`, `refund_line`, `pos_close:<YYYY-MM-DD>`, `order:<order_id>:portal_invitation`), and the Mollie customer deletion job is keyed `mollie_customer:<provider_customer_id>:delete` because no erasure handler receives the privacy request id (Convention 5, cross-module D35 and D69).
