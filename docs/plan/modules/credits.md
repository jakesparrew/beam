# Module spec: credits (Credits ledger, packages, sharing and memberships)

Owner paths: `packages/db/src/schema/credits.ts`, `packages/db/src/schema/credits.views.ts`, `packages/core/src/credits/`, `apps/web/modules/credits/`, `apps/web/app/(admin)/admin/{credits,memberships,referrals,partner}/`, `apps/web/app/[locale]/(portal)/account/{packages,membership,referrals}/`, `packages/email/src/templates/credits/`, `packages/core/src/i18n/messages/*/credits.json`, `packages/db/src/seed/credits.ts`.

Blueprint sections: 11 (packages and credits), 12 (membership), 44 (referral and partner), 49 (guest and package sharing). Requirements also taken from 3 (commercial status), 6 (segmentation fields), 7 and 8 (guest bookings, packages with nights), 10 (portal), 21 (package usage thresholds), 22 and 38 (retention and action dashboard lists), 31 (renewal reminders), 45 and 46 (member pricing), 53 (migration of balances and memberships), 56 (audit of package adjustments and membership changes), 62 and 63 (erasure and retention), 76 (acceptance: package balance updates, member discount works).

## 1. Purpose and release mapping

The credits module is the single source of truth for what a customer has prepaid and what membership they hold. Every package purchase, use, release, expiry, extension, adjustment, guest use and membership period is a separate ledger fact with who and why. Balances are never stored; they are `sum(quantity)` over the ledger. The customer sees "4 sessions remaining" or "2 nights remaining", never the word "credits".

| Release | Weeks | What ships in this module |
| --- | --- | --- |
| **V1** | 1–6 | `credit_grants`, `credit_entries`, `memberships`, `membership_periods`, `credit_reconciliation_runs`; views `v_credit_grant_balances`, `v_person_credits`, `v_person_status`, `v_credit_liability`, `v_euro_voucher_redemptions`. Grants from purchases, membership inclusions, bonuses, imports, manual grants and transfers. `allocateCredits`, `consumeCredits`, `releaseCredits`, `revokeForRefund`, `redeemEuroCredits`. Threshold events (50, 75, 80, 90 %, last unit, exhausted). Expiry job with 30- and 7-day warnings. Extensions, adjustments, revocations, transfers (all audited). Customer and staff balances, package history, usage history. Guest use on the owner's grant (product default sharing mode `guests`, monthly guest limit enforced). Memberships: start, period, included sessions and nights, discount snapshot driving automatic member pricing, member-only eligibility, renewal by Mollie mandate 3 days before period end, dunning on day 3, 7 and 10, `past_due` and `expired`, cancel at period end, history, renewal reminders at 30 and 7 days. Nightly `ledger.reconcile`. Portal: packages, package detail with usage, membership. Admin: grants, grant detail with adjustments, new grant, memberships, reconciliation. Imports of opening balances and memberships through `api.ts` for `ops`. |
| **Release 2** | 9–10 | "Guest and package-sharing controls" (proposal section 2): named sharing with `package_shares` (owner invites a named person who books on their own account against the owner's grant, with `max_units`), staff edit of `credit_grants.sharing` per grant, the portal sharing page, the fraud and abuse review list (`v_sharing_review`, `credit_sharing_reviews`: more than 3 distinct guests on one grant in 30 days; one guest on 3 or more owners' grants in 30 days). Shared-with-me section in the portal. Share invitation email. |
| **Release 3** | 11–12 | "Referral and partner management": `referral_codes`, `referral_attributions`, `partner_commissions`, view `v_partner_performance`; referral codes per person and per partner company, rewards as `referral` grants after a 14-day qualification, partner commission accrual on paid orders for 12 months, partner performance figures, `/admin/referrals`, the external partner's own view `/admin/partner`, portal `/account/referrals`. Credits figures for the management and finance dashboards (`ops`, `finance`) read `v_credit_liability`. |
| **Release 4** | 13–14 | "Churn and repurchase indicators" input: view `v_package_cycles` (per person: package completed at, days to repurchase, repurchased or not) consumed by `ops` for churn and repurchase indicators and custom dashboards. No new write paths. |
| **Later** (out of scope) | — | Gamification credits and rewards (blueprint 52), B2B company accounts buying packages for employees with employee usage reporting (proposal question 5, quoted separately), partial-value top-ups of day/night grants, cross-service credits with mixed VAT, native mobile wallet, automated payouts of partner commissions. |

## 2. Domain model

All tables live in `packages/db/src/schema/credits.ts`; views in `packages/db/src/schema/credits.views.ts`. Conventions from architecture section 2 apply: `id uuid primary key default gen_random_uuid()`, `created_at timestamptz not null default now()`, `updated_at timestamptz not null default now()` on mutable tables, enums named `<table>_<column>`, money in integer cents, `LocalizedText` jsonb.

No column in this module is a **sensitive** column in the architecture's sense (health, sleep, stress, recovery, wellbeing, medical); nothing here is declared with `sensitive()`. Free-text staff columns (`credit_grants.note`, `credit_entries.reason`, `memberships.notes`, `credit_sharing_reviews.note`, `partner_commissions.note`) are marked **PII-risk**: excluded from `AI_ALLOWED_FIELDS`, `SEGMENT_ALLOWED_FIELDS` and staff CSV exports, redacted on erasure.

### Enums

| Enum | Values |
| --- | --- |
| `credit_grants_credit_kind` | `day`, `night`, `euro` |
| `credit_grants_status` | `active`, `exhausted`, `expired`, `revoked` |
| `credit_grants_source` | `purchase`, `membership`, `bonus`, `import`, `manual`, `referral`, `transfer` |
| `credit_grants_validity_rule` | `from_purchase`, `fixed` |
| `credit_grants_vat_treatment` | `single_purpose`, `multi_purpose`, `not_applicable` |
| `credit_entries_kind` | `grant`, `consume`, `release`, `expire`, `extend`, `adjust`, `revoke`, `transfer_out`, `transfer_in` |
| `package_shares_status` | `active`, `revoked` |
| `memberships_status` | `pending`, `active`, `past_due`, `cancelled`, `expired` |
| `memberships_interval` | `month`, `year` |
| `memberships_source` | `purchase`, `import`, `staff` |
| `memberships_end_reason` | `cancelled_by_customer`, `cancelled_by_staff`, `payment_failed`, `not_renewed`, `erased` |
| `membership_periods_source` | `purchase`, `renewal`, `late_payment`, `import`, `staff_extension` |
| `credit_sharing_reviews_rule` | `many_guests`, `guest_hopping` |
| `credit_sharing_reviews_decision` | `ok`, `warned`, `sharing_disabled` |
| `credit_reconciliation_runs_status` | `ok`, `mismatch`, `error` |
| `referral_attributions_source` (R3) | `code`, `link`, `staff`, `import` |
| `referral_attributions_status` (R3) | `pending`, `qualified`, `rewarded`, `rejected` |
| `partner_commissions_status` (R3) | `accrued`, `approved`, `paid`, `void` |

### `credit_grants` (mutable; a package is a grant)

| Column | Type | Null | Default / check |
| --- | --- | --- | --- |
| `id` | uuid | no | `gen_random_uuid()` |
| `person_id` | uuid FK `persons.id` | no | owner |
| `product_id` | uuid FK `products.id` | yes | the package, voucher or membership product |
| `order_line_id` | uuid FK `order_lines.id` | yes | set for `purchase` |
| `membership_id` | uuid FK `memberships.id` | yes | set for `membership` |
| `referral_attribution_id` | uuid FK `referral_attributions.id` | yes | set for `referral`; nullable column added by credits-P8 (R3, expand-only) |
| `credit_kind` | `credit_grants_credit_kind` | no | |
| `units_granted` | integer | no | check `> 0`. For `euro` the unit is one cent |
| `unit_value_cents` | integer | no | `0`; check `>= 0`; for `euro` check `= 1` |
| `vat_rate_pct` | numeric(4,2) | yes | snapshot of the product's rate; check in (0, 6, 12, 21) |
| `vat_treatment` | `credit_grants_vat_treatment` | no | `single_purpose` for day/night purchases, `multi_purpose` for euro, `not_applicable` for bonus, referral, manual, membership |
| `starts_at` | timestamptz | no | `now()` |
| `expires_at` | timestamptz | yes | null = never expires; check `expires_at is null or expires_at > starts_at` |
| `validity_rule` | `credit_grants_validity_rule` | no | `from_purchase` |
| `status` | `credit_grants_status` | no | `active` |
| `status_changed_at` | timestamptz | no | `now()` |
| `source` | `credit_grants_source` | no | |
| `sharing` | jsonb | no | `{"mode":"none","max_guest_uses_per_month":0,"allowed_person_ids":[]}`; Zod `GrantSharing = { mode: 'none'\|'guests'\|'named', max_guest_uses_per_month: int 0..31, allowed_person_ids: uuid[] }` |
| `label` | jsonb `LocalizedText` | yes | display name for manual, bonus, import and referral grants; purchases show the product name |
| `note` | text | yes | staff note, PII-risk, max 1000 chars |
| `data` | jsonb | no | `{}`; `{ original_units?, legacy_source?, legacy_id?, import_id?, transfer_from_grant_id? }` |
| `created_by_user_id` | uuid FK `users.id` | yes | |
| `created_at`, `updated_at` | timestamptz | no | `now()` |

Checks: `source <> 'purchase' or order_line_id is not null`; `source <> 'membership' or membership_id is not null`; `credit_kind <> 'euro' or (unit_value_cents = 1 and vat_treatment = 'multi_purpose')`.
Indexes: `(person_id, credit_kind, status, expires_at)`; partial `(expires_at) where status = 'active'`; partial unique `(order_line_id) where order_line_id is not null`; partial unique `(membership_id, credit_kind, starts_at) where source = 'membership'`; `(product_id)`.
Invariants: `status` changes only inside a transaction that holds the row lock (`FOR UPDATE`) and writes the matching ledger entry; `units_granted` is never edited after insert (corrections are `adjust` entries); `sharing.allowed_person_ids` is a cache of active `package_shares.shared_with_person_id` written in the same transaction (R2).

### `credit_entries` APPEND (the ledger)

| Column | Type | Null | Default / check |
| --- | --- | --- | --- |
| `id` | uuid | no | |
| `grant_id` | uuid FK `credit_grants.id` | no | |
| `person_id` | uuid FK `persons.id` | no | grant owner at write time |
| `beneficiary_person_id` | uuid FK `persons.id` | yes | who used the unit; set only on `consume` and `release` |
| `kind` | `credit_entries_kind` | no | |
| `quantity` | integer | no | signed |
| `reason` | text | yes | PII-risk; mandatory for `adjust`, `revoke`, `transfer_out`, `extend` by staff |
| `ref_type` | text | yes | one of `booking`, `order`, `order_line`, `refund`, `membership`, `import`, `referral`, `transfer`, `privacy_request` |
| `ref_id` | uuid | yes | |
| `reverses_entry_id` | uuid FK `credit_entries.id` | yes | the `consume` a `release` gives back |
| `data` | jsonb | no | `{}`; `extend`: `{ old_expires_at, new_expires_at }`; euro `consume`: `{ vat_at_redemption: true }`; threshold bookkeeping never stored here |
| `actor` | jsonb | no | `{ kind: staff\|customer\|system\|job\|webhook, id }` |
| `idempotency_key` | text | no | unique |
| `created_at` | timestamptz | no | `now()` |

Checks: `kind in ('grant','transfer_in','release') → quantity > 0`; `kind in ('consume','expire','revoke','transfer_out') → quantity < 0`; `kind = 'extend' → quantity = 0 and data ? 'new_expires_at'`; `kind = 'adjust' → quantity <> 0 and length(btrim(reason)) >= 3`; `kind = 'release' → reverses_entry_id is not null`; `beneficiary_person_id is null or kind in ('consume','release')`.
Indexes: `(grant_id, created_at)`; `(person_id, created_at desc)`; partial `(beneficiary_person_id, created_at) where beneficiary_person_id is not null`; `(ref_type, ref_id)`; partial unique `(reverses_entry_id) where kind = 'release'` (one release per consume).
Invariants: `sum(quantity) >= 0` per grant at every commit (checked in code under the lock and nightly by `ledger.reconcile`); every insert holds the `FOR UPDATE` lock on its grant row; rows are never updated or deleted except by the erasure and retention handlers under `SET LOCAL beam.allow_rewrite = 'on'`. Listed in `APPEND_ONLY_TABLES`.

Idempotency key formats: `grant:order_line:<order_line_id>`, `grant:membership:<membership_id>:<period_start YYYY-MM-DD>:<kind>`, `grant:import:<import_id>:<row_number>`, `grant:staff:<client_key>`, `grant:referral:<attribution_id>:<referrer|referee>`, `consume:<booking_id>:<grant_id>`, `consume:order:<order_id>:<grant_id>` (euro), `release:<consume_entry_id>`, `expire:<grant_id>:<expires_at YYYY-MM-DD>`, `expire:<grant_id>:after_release:<release_entry_id>`, `extend:<client_key>`, `adjust:<client_key>`, `revoke:refund:<refund_id>:<grant_id>`, `revoke:<client_key>`, `revoke:erase:<privacy_request_id>:<grant_id>`, `transfer:<client_key>:out` and `transfer:<client_key>:in`. `client_key` is a uuid v4 the staff form generates once per open form.

### `package_shares` (mutable, rows used from R2)

`id`; `grant_id` uuid FK `credit_grants.id` not null; `shared_with_person_id` uuid FK `persons.id` not null; `max_units` integer null (null = up to the balance), check `> 0`; `status` `package_shares_status` not null default `active`; `created_by_user_id` uuid FK `users.id` null; `created_by_person_id` uuid FK `persons.id` null (owner through the portal); check `num_nonnulls(created_by_user_id, created_by_person_id) = 1`; `revoked_at` timestamptz null; `revoked_reason` text null; `created_at`, `updated_at`. Partial unique `(grant_id, shared_with_person_id) where status = 'active'`; index `(shared_with_person_id) where status = 'active'`. Invariant: `shared_with_person_id` is never the grant owner (checked in the action).

### `memberships` (mutable)

| Column | Type | Null | Default / check |
| --- | --- | --- | --- |
| `id` | uuid | no | |
| `person_id` | uuid FK `persons.id` | no | |
| `product_id` | uuid FK `products.id` | no | product of kind `membership` (the plan) |
| `status` | `memberships_status` | no | `pending` |
| `interval` | `memberships_interval` | no | snapshot of `products.recurring_interval` |
| `source` | `memberships_source` | no | `purchase` |
| `started_at` | timestamptz | no | |
| `current_period_start_at` | timestamptz | no | |
| `current_period_end_at` | timestamptz | no | check `> current_period_start_at`; exclusive end |
| `cancel_at` | timestamptz | yes | set = `current_period_end_at` when cancelled at period end |
| `cancel_requested_at` | timestamptz | yes | |
| `ended_at` | timestamptz | yes | set when `cancelled` or `expired` |
| `end_reason` | `memberships_end_reason` | yes | check: not null iff status in (`cancelled`, `expired`) |
| `mandate_id` | uuid FK `mandates.id` | yes | null = manual renewal by payment link |
| `price_version_id` | uuid FK `price_versions.id` | yes | price of the last paid period |
| `first_order_id` | uuid FK `orders.id` | yes | |
| `renewal_order_id` | uuid FK `orders.id` | yes | open renewal order of the coming period; cleared when paid |
| `discount_pct` | numeric(5,2) | no | `0`; snapshot of the plan's `products.member_discount_pct`, check 0..100 |
| `next_charge_at` | timestamptz | yes | next automatic charge attempt |
| `dunning_attempt` | smallint | no | `0`; 0 = none, 1 = first charge failed, 2 = day-3 retry failed, 3 = day-7 retry failed |
| `past_due_since_at` | timestamptz | yes | |
| `notes` | text | yes | staff, PII-risk |
| `version` | integer | no | `1`; optimistic lock for staff edits |
| `created_at`, `updated_at` | timestamptz | no | |

Partial unique `(person_id) where status in ('active','past_due')` (architecture); partial unique `(person_id) where status = 'pending'`; indexes `(status, current_period_end_at)`, `(next_charge_at) where status in ('active','past_due')`, `(renewal_order_id)`.

### `membership_plan_inclusions` (mutable; addition)

Extra included credit kinds per membership plan beyond the product's primary `included_credit_kind/included_credit_units` (blueprint 12 lists both included sessions and included nights). `id`; `product_id` uuid FK `products.id` not null; `credit_kind` `credit_grants_credit_kind` not null, check `<> 'euro'`; `units_per_period` integer not null check `> 0`; `is_active` boolean not null default true; `created_at`, `updated_at`. Unique `(product_id, credit_kind)`. Invariant: a row with the same kind as the product's primary inclusion is rejected by the action.

### `membership_periods` APPEND (membership history; addition)

`id`; `membership_id` uuid FK not null; `person_id` uuid FK `persons.id` not null; `period_start_at`, `period_end_at` timestamptz not null; `source` `membership_periods_source` not null; `order_id` uuid FK `orders.id` null; `amount_cents` integer not null default 0; `created_by_user_id` uuid null; `created_at`. Unique `(membership_id, period_start_at)`. Listed in `APPEND_ONLY_TABLES`.

### `credit_sharing_reviews` (R2, mutable; addition)

`id`; `rule` `credit_sharing_reviews_rule` not null; `grant_id` uuid FK null (rule `many_guests`); `guest_person_id` uuid FK `persons.id` null (rule `guest_hopping`); check exactly one of the two by rule; `guest_person_ids` uuid[] not null (the set seen when reviewed); `decision` `credit_sharing_reviews_decision` not null; `note` text null (PII-risk); `reviewed_by_user_id` uuid FK `users.id` not null; `created_at`. Index `(grant_id)`, `(guest_person_id)`.

### `credit_reconciliation_runs` (mutable while running; addition, NO_PII)

`id`; `job_id` uuid null; `started_at` timestamptz not null; `finished_at` timestamptz null; `status` `credit_reconciliation_runs_status` null until finished; `checked_grants` integer not null default 0; `checked_bookings` integer not null default 0; `findings` jsonb not null default `[]` (`{ check, grant_id?, booking_id?, membership_id?, expected, actual }[]`, ids only); `fixed` jsonb not null default `[]` (status drift corrected); `created_at`. Index `(started_at desc)`.

### R3 tables

**`referral_codes`**: `id`; `code` text not null, unique on `upper(code)`, check `code ~ '^[A-Z0-9]{6,12}$'`; `person_id` uuid FK `persons.id` null; `partner_company_id` uuid FK `companies.id` null; check `num_nonnulls(person_id, partner_company_id) = 1`; `referrer_reward` jsonb null `{ credit_kind: day|night, units: int, validity_days: int }` (null = settings default); `referee_reward` jsonb null (same shape; null = none); `max_uses` integer null; `is_active` boolean not null default true; `created_by_user_id` uuid null; `created_at`, `updated_at`. Partial unique `(person_id) where is_active and person_id is not null`.

**`referral_attributions`**: `id`; `referred_person_id` uuid FK `persons.id` not null unique; `code_id` uuid FK `referral_codes.id` null; `referrer_person_id` uuid FK `persons.id` null; `partner_company_id` uuid FK `companies.id` null; check `num_nonnulls(referrer_person_id, partner_company_id) >= 1` and `referrer_person_id is distinct from referred_person_id`; `source` enum; `status` enum default `pending`; `attributed_at` timestamptz not null; `first_paid_order_id` uuid FK `orders.id` null; `first_paid_at` timestamptz null; `qualifies_at` timestamptz null (= `first_paid_at + 14 days`); `commission_until_at` timestamptz null (= `attributed_at + 12 months`); `rejected_reason` text null; `referrer_reward_grant_id`, `referee_reward_grant_id` uuid FK `credit_grants.id` null; `created_by_user_id` uuid null; `created_at`, `updated_at`. Indexes `(referrer_person_id)`, `(partner_company_id)`, `(status, qualifies_at)`.

**`partner_commissions`**: `id`; `partner_company_id` uuid FK `companies.id` not null; `attribution_id` uuid FK `referral_attributions.id` null (on delete set null); `order_id` uuid FK `orders.id` not null; `refund_id` uuid FK `refunds.id` null; `base_cents` integer not null (order total excluding VAT, negative for a refund); `commission_pct` numeric(5,2) not null (snapshot of `companies.partner_commission_pct`); `amount_cents` integer not null (`round_half_up(base_cents * pct / 100)`); `status` enum default `accrued`; `period_month` date not null (first day of the Brussels month of payment); `approved_by_user_id` uuid null; `paid_at` timestamptz null; `note` text null (PII-risk); `idempotency_key` text not null unique (`commission:<order_id>` or `commission:refund:<refund_id>`); `created_at`, `updated_at`. Index `(partner_company_id, period_month)`.

### Tables of other modules this module reads or writes

| Table (module) | Access |
| --- | --- |
| `persons` (crm) | read (`status_override`, `locale`, `first_name`, `last_name`, `erased_at`, `merged_into_person_id`, `acquisition`); written only through `crm` api |
| `activity_events` (crm) | insert via `ctx.recordEvent` |
| `audit_log` (platform) | insert via `ctx.audit` |
| `jobs` (platform) | insert via `ctx.enqueue` |
| `users` (platform) | read for display names |
| `products`, `price_versions`, `orders`, `order_lines`, `mandates`, `refunds` (commerce) | read |
| `bookings`, `sessions` (booking) | read (usage history, reconcile) |
| `companies` (crm) | read (`is_partner`, `partner_commission_pct`) R3 |
| `imports` (ops) | read id only (via `data.import_id`) |

### Views (`credits.views.ts`, Drizzle `pgView(...).as(sql...)`)

```sql
-- Balance per grant. The only place a balance is computed.
create view v_credit_grant_balances as
select g.id as grant_id, g.person_id, g.credit_kind, g.source, g.status, g.product_id, g.membership_id,
       g.starts_at, g.expires_at, g.units_granted, g.unit_value_cents, g.vat_treatment, g.sharing,
       coalesce((g.data->>'original_units')::int, g.units_granted)                          as base_units,
       coalesce(sum(e.quantity), 0)::int                                                   as remaining_units,
       coalesce(-sum(e.quantity) filter (where e.kind in ('consume','release')), 0)::int   as used_units,
       coalesce(-sum(e.quantity) filter (where e.kind in ('consume','release')
                 and e.beneficiary_person_id is not null
                 and e.beneficiary_person_id <> e.person_id), 0)::int                      as guest_units,
       coalesce(-sum(e.quantity) filter (where e.kind = 'expire'), 0)::int                 as expired_units,
       coalesce(sum(e.quantity) filter (where e.kind = 'adjust'), 0)::int                  as adjusted_units,
       max(e.created_at) filter (where e.kind = 'consume')                                 as last_used_at,
       (g.status = 'active' and g.starts_at <= now()
          and (g.expires_at is null or g.expires_at > now())
          and coalesce(sum(e.quantity), 0) > 0)                                            as is_usable
from credit_grants g
left join credit_entries e on e.grant_id = g.id
group by g.id;

-- Customer-facing totals: owner's usable grants only (shared grants are listed separately).
create view v_person_credits as
select b.person_id, b.credit_kind,
       sum(b.remaining_units)::int                              as remaining_units,
       sum(b.remaining_units * b.unit_value_cents)::bigint       as remaining_value_cents,
       count(*)::int                                            as usable_grants,
       min(b.expires_at)                                        as next_expires_at
from v_credit_grant_balances b
where b.is_usable
group by b.person_id, b.credit_kind;

-- Commercial status (blueprint 3, scenario 3). A manual override always wins for the classification.
create view v_person_status as
with paid as (
  select person_id, min(paid_at) as first_paid_at from orders
  where person_id is not null and paid_at is not null and total_cents > 0
    and status in ('paid','partially_refunded','refunded')
  group by person_id),
legacy as (
  select person_id, min(starts_at) as first_at from credit_grants
  where source in ('purchase','import') group by person_id),
ever_member as (
  select person_id, min(started_at) as member_since_at from memberships
  where status <> 'pending' group by person_id),
cur as (
  select distinct on (person_id) person_id, id as membership_id, status, current_period_end_at, discount_pct
  from memberships
  where status in ('active','past_due') and started_at <= now()
  order by person_id, started_at desc)
select p.id as person_id,
       case when cur.membership_id is not null then 'member'
            when paid.person_id is not null or legacy.person_id is not null or ever_member.person_id is not null then 'customer'
            else 'lead' end                                         as derived_status,
       p.status_override,
       coalesce(p.status_override::text,
         case when cur.membership_id is not null then 'member'
              when paid.person_id is not null or legacy.person_id is not null or ever_member.person_id is not null then 'customer'
              else 'lead' end)                                      as status,
       (cur.membership_id is not null)                              as is_member,
       cur.membership_id, cur.status as membership_status, cur.current_period_end_at as membership_period_end_at,
       coalesce(cur.discount_pct, 0)                                as member_discount_pct,
       ever_member.member_since_at,
       least(paid.first_paid_at, legacy.first_at)                   as first_paid_at
from persons p
left join paid on paid.person_id = p.id
left join legacy on legacy.person_id = p.id
left join ever_member on ever_member.person_id = p.id
left join cur on cur.person_id = p.id
where p.erased_at is null and p.merged_into_person_id is null;

-- Outstanding prepaid value for finance (V1; dashboards in R3).
create view v_credit_liability as
select b.credit_kind, b.vat_treatment, g.vat_rate_pct,
       sum(b.remaining_units)::bigint                        as remaining_units,
       sum(b.remaining_units * b.unit_value_cents)::bigint    as remaining_value_cents,
       count(*)::int                                         as grants
from v_credit_grant_balances b join credit_grants g on g.id = b.grant_id
where b.status = 'active' and b.remaining_units > 0
group by b.credit_kind, b.vat_treatment, g.vat_rate_pct;

-- Multi-purpose voucher redemptions: VAT is due on the goods at redemption; flagged for the accountant.
create view v_euro_voucher_redemptions as
select e.id as entry_id, e.grant_id, e.person_id, e.ref_id as order_id,
       (-e.quantity)::int as amount_cents, e.created_at as redeemed_at,
       exists (select 1 from credit_entries r where r.reverses_entry_id = e.id) as is_reversed
from credit_entries e join credit_grants g on g.id = e.grant_id
where g.credit_kind = 'euro' and e.kind = 'consume' and e.ref_type = 'order';
```

R2 view `v_sharing_review` (rows needing a human look, minus those already reviewed with the same or a larger guest set):

```sql
create view v_sharing_review as
with guest_use as (
  select e.grant_id, e.person_id as owner_person_id, e.beneficiary_person_id as guest_person_id, e.created_at
  from credit_entries e
  where e.kind = 'consume' and e.beneficiary_person_id is not null
    and e.beneficiary_person_id <> e.person_id and e.created_at > now() - interval '30 days'
    and not exists (select 1 from credit_entries r where r.reverses_entry_id = e.id)),
many as (
  select 'many_guests'::text as rule, grant_id, null::uuid as guest_person_id,
         array_agg(distinct guest_person_id) as person_ids, count(distinct guest_person_id)::int as distinct_count,
         max(created_at) as last_at
  from guest_use group by grant_id having count(distinct guest_person_id) > 3),
hop as (
  select 'guest_hopping'::text, null::uuid, guest_person_id,
         array_agg(distinct owner_person_id), count(distinct owner_person_id)::int, max(created_at)
  from guest_use group by guest_person_id having count(distinct owner_person_id) >= 3),
cand as (select * from many union all select * from hop)
select c.* from cand c
where not exists (
  select 1 from credit_sharing_reviews r
  where r.rule::text = c.rule
    and (r.grant_id = c.grant_id or r.guest_person_id = c.guest_person_id)
    and c.person_ids <@ r.guest_person_ids);
```

R3 view `v_partner_performance` (per partner company per month): `partner_company_id`, `period_month`, `referred_count` (attributions with `attributed_at` in month), `customers_count` (attributions with `first_paid_at` in month), `revenue_cents` (sum of `orders.total_cents` paid in month by attributed persons within `commission_until_at`, minus refunds), `commission_accrued_cents` (sum `amount_cents` where status in `accrued`, `approved`), `commission_paid_cents` (status `paid`). Built from `referral_attributions` left join `orders` and `partner_commissions` grouped by `partner_company_id, date_trunc('month', ... at time zone 'Europe/Brussels')`.

R4 view `v_package_cycles`: one row per closed grant of source `purchase` (status `exhausted` or `expired`): `person_id`, `grant_id`, `product_id`, `closed_at` (`status_changed_at`), `next_purchase_at` (min `starts_at` of a later `purchase` grant of the same `credit_kind` for the person), `days_to_repurchase`, `repurchased` boolean.

## 3. Business rules

**Grants**
1. A paid order line for a product with `credit_kind` set creates exactly one grant: `units_granted = products.credit_units × order_lines.quantity`, `unit_value_cents = round_half_up(line_total_cents / units_granted)` (euro: 1), `vat_rate_pct` = line rate, `starts_at = orders.paid_at`, `expires_at` = end of day (23:59:59.999 Europe/Brussels) of `paid_at + products.validity_days`, null when `validity_days` is null. A second fulfilment of the same line writes nothing (key `grant:order_line:<id>`).
2. `sharing` of a purchased grant is copied from the product: `is_sharing_allowed = false` → mode `none`; true → mode `guests` with `max_guest_uses_per_month = products.max_guest_uses_per_month` (default 2).
3. Every grant is born with exactly one positive first entry: `grant` (or `transfer_in` for source `transfer`) with `quantity = units_granted`, in the same transaction as the grant row.
4. Staff grants (`manual`, `bonus`) require `credits.adjust`, a kind, units 1–100 (euro 1–100 000 cents), a localized label, a validity (days or explicit `expires_at`) and a reason; they get `vat_treatment = not_applicable` and `unit_value_cents = 0`.
5. A grant with `starts_at` in the future is visible ("starts on 1 December") but not usable until `starts_at`.
6. Imported grants (`ops` import kind `packages`) are created with `units_granted` = remaining legacy balance, `data.original_units` = original package size, `validity_rule = fixed`, source `import`; the import key `grant:import:<import_id>:<row_number>` makes re-running an import harmless.

**Ledger and balance**
7. No table stores a balance. The balance of a grant is `sum(credit_entries.quantity)` (`v_credit_grant_balances.remaining_units`); the balance of a person per kind is `v_person_credits.remaining_units`.
8. Every write to `credit_entries` for a grant happens in a transaction that first locks that grant with `SELECT ... FOR UPDATE`. Locks on several grants are taken in ascending `id` order.
9. After any write, `remaining_units >= 0` for the grant; a write that would make it negative throws `InsufficientCreditsError` and rolls back.
10. A duplicate `idempotency_key` is not an error: the function returns the existing entries and writes nothing new.
11. `credit_entries` rows are never updated or deleted (trigger), except by erasure and retention handlers under `beam.allow_rewrite`.
12. Grant status follows the balance: `active → exhausted` when a write brings `remaining_units` to 0 through `consume`; `exhausted → active` when a `release` or positive `adjust` makes it positive again and the grant has not expired; `active → expired` only by the expiry job; any → `revoked` only by `revoke` bringing the balance to 0. Every change sets `status_changed_at`.

**Allocation and consumption**
13. `allocateCredits` considers only grants that are `active`, of the requested kind, with `starts_at <= validAt < expires_at` (or no expiry) and `remaining_units > 0`, where `validAt` is the session start (booking) or `now` (euro redemption).
14. Order: the payer's own grants first, then grants named-shared with the beneficiary (R2); within each group earliest `expires_at` first (null last), then oldest `starts_at`, then `id`.
15. A booking of `credit_cost = n` may split across grants; one `consume` entry per grant used, key `consume:<booking_id>:<grant_id>`.
16. If the eligible total is below `n`, nothing is consumed and the booking action receives `InsufficientCreditsError { kind, needed, available }`.
17. Guest use (beneficiary ≠ owner, booked by the owner): only grants with `sharing.mode` in (`guests`, `named`) qualify, and only while the grant's guest uses in the current Brussels calendar month (distinct `ref_id` of unreleased guest `consume` entries) are below `max_guest_uses_per_month`. A limit of 0 forbids guests.
18. Named use (R2; beneficiary books on their own account against a shared grant): requires an active `package_shares` row for (grant, beneficiary) and the beneficiary's net used units on that grant plus `n` must not exceed `max_units` when set. Named uses do not count towards the monthly guest limit.
19. Each `consume` records `credits.consumed` on the owner's timeline; a guest or named use also records `credits.guest_used` on the beneficiary's timeline with `data.owner_person_id`, so owner and guest both see the use.
20. Euro grants are never consumed by bookings (sessions cost `day` or `night`); they are redeemed at checkout through `redeemEuroCredits` with `ref_type = 'order'` and `data.vat_at_redemption = true`.

**Thresholds**
21. After a consume, for each threshold in 50, 75, 80, 90 % of `base_units` crossed by `used_units` (floor of `used × 100 / base`), record `credits.threshold_reached { grant_id, pct, remaining_units, kind }` with `dedupe_key = grant:<id>:threshold:<pct>`. Several thresholds crossed at once each fire once.
22. When `remaining_units` becomes exactly 1, record `credits.threshold_reached { pct: 'last_unit' }` (dedupe `grant:<id>:threshold:last_unit`); when it becomes 0, record `credits.grant_exhausted` (dedupe `grant:<id>:exhausted`). A release never un-fires a threshold.
23. Threshold events are emitted for `purchase`, `import` and `transfer` grants only; membership inclusions, bonuses and referral rewards do not trigger package sequences.

**Release, cancellation and refunds**
24. `releaseCredits` for a booking writes one `release` per unreleased `consume` of that booking with `quantity = -consume.quantity`, `reverses_entry_id` = the consume, key `release:<consume_id>`. Calling it twice releases nothing more.
25. Booking decides policy: inside the window (`settings.booking_rules`) it calls `releaseCredits`; a late cancellation or no-show does not call it and the credit stays consumed.
26. A release to a grant that has expired writes the `release` and, in the same transaction, an `expire` for the released amount (key `expire:<grant_id>:after_release:<release_id>`); the customer sees "returned to an expired package". Staff can extend the grant to recover it.
27. A refunded order line calls `revokeForRefund`: unused units of the line's grant are revoked (`revoke`, reason `refund`, key `revoke:refund:<refund_id>:<grant_id>`); a partial refund of `k` package units revokes `min(k, remaining)`. Used units are never revoked by a refund.
28. Staff revoke (`credits.adjust`) takes a reason and revokes all remaining units; the grant becomes `revoked`.

**Expiry and extension**
29. `credits.expire_grants` (daily 00:05 Brussels) writes `expire` with `quantity = -remaining_units` for every `active` grant with `expires_at <= now()`, sets `expired`, records `credits.grant_expired`. A grant with balance 0 at expiry is set `expired` without an entry.
30. The same job records `credits.expiry_approaching { grant_id, days: 30|7, remaining_units }` once per grant per threshold (dedupe `grant:<id>:expiry:<days>:<expires_on>`) for usable grants with `remaining_units > 0`.
31. An extension (`credits.adjust`) writes `extend` (quantity 0, `data.old_expires_at`, `data.new_expires_at`), updates `credit_grants.expires_at` and writes `audit_log` `credits.grant_extended`. The new date must be later than the old one and at most 5 years after `now`.
32. Extending an expired grant whose expiry entry is at most 365 days old also writes `adjust` with `quantity = expired_units`, reason `reinstated on extension`, and sets `active`. Older grants cannot be extended; staff create a manual grant instead.

**Adjustments and transfers**
33. An adjustment (`credits.adjust`) is `adjust` with a non-zero quantity, a reason of at least 3 characters, an audit row `credits.adjusted` with old and new balance. A negative adjustment cannot exceed the balance.
34. A transfer (`credits.adjust`) moves `k` units from one grant to another person: `transfer_out` on the source and a new grant (source `transfer`, same kind, expiry and `unit_value_cents`, `data.transfer_from_grant_id`) with a `transfer_in`, both in one transaction, one audit row.
35. When `crm` merges persons, `onPersonsMerged` moves `credit_grants.person_id`, `memberships.person_id`, `package_shares.shared_with_person_id` and referral rows to the winner. Ledger rows keep the historical `person_id`; balances follow the grant. If both had an active membership, the later-ending one stays active and the other is `cancelled` with `end_reason = cancelled_by_staff` and an audit row.

**Visibility**
36. The portal shows units in words from the catalogue, never "credits": `credits.units.day` "{count, plural, one {# session} other {# sessions}} remaining", `credits.units.night` "{count, plural, one {# night} other {# nights}} remaining", euro as money "€ 35,00 remaining". BEAM changes wording in the catalogue only.
37. The customer sees: own usable and future grants with remaining, expiry date and product name; history of closed grants; per-grant usage (date, session title, who used it); grants shared with them (R2). Unit values, VAT, staff notes and reasons of adjustments are staff-only; the customer sees a generic line "Adjusted by BEAM".
38. The owner sees a guest as first name plus last initial; staff see the full name with a link.
39. Staff with `credits.read` see every grant, entry, actor and reason; the person page shows totals per kind and the next expiry.

**Sharing (R2 additions)**
40. Staff (`credits.adjust`) may set `sharing.mode` and `max_guest_uses_per_month` (0–31) per grant; every change is audited `credits.sharing_changed`.
41. An owner may add up to 5 active named shares per grant from the portal when `sharing.mode = 'named'`; staff may add shares whatever the mode and switch mode to `named`. The invited person is found or created by email through `crm.findOrCreatePersonByEmail` and receives the `share-invitation` email.
42. Revoking a share (owner or staff) stops future use; past entries stay. Bookings already made against the share stay valid.
43. The review list shows grants with more than 3 distinct guests in 30 days and guests used on 3 or more owners' grants in 30 days. Reviewing writes `credit_sharing_reviews`; the item disappears until a new guest appears. Decision `sharing_disabled` sets `sharing.mode = 'none'` in the same transaction.

**Memberships**
44. A membership plan is a commerce product of kind `membership` with `recurring_interval`, primary inclusion (`included_credit_kind`, `included_credit_units`), extra rows in `membership_plan_inclusions`, and `member_discount_pct`.
45. Paying the first order creates the membership `active` (or `pending` when the order line's `data.start_on` is in the future): `started_at = current_period_start_at = paid_at` (or start date 00:00 Brussels), `current_period_end_at = start + 1 interval` (calendar month or year in Brussels; the 29th–31st clamp to the month's last day), `discount_pct` snapshot, `mandate_id` from the order's payment when Mollie created one, a `membership_periods` row, and `membership.started`.
46. Each started period grants every inclusion as a separate grant: source `membership`, `starts_at = period start`, `expires_at = period end` (no rollover), `unit_value_cents = 0`, `vat_treatment = not_applicable`, `sharing.mode = none`, key `grant:membership:<id>:<period start date>:<kind>`.
47. A person has at most one membership in (`active`, `past_due`) and at most one `pending`. Buying a second plan while active is refused by checkout via `canStartMembership`.
48. Renewal: `memberships.scan_renewals` (06:10) enqueues `memberships.charge_renewal` for every `active` membership with a valid mandate, no `cancel_at`, and `current_period_end_at - 3 days <= now`. The charge creates one renewal order through `commerce.createRenewalOrder` (price: the plan's `public` price version valid when the order is created, so a price change applies from the next renewal; key `renewal:<membership_id>:<period_end date>`) and charges the mandate through `commerce.chargeMandate`.
49. A paid renewal (via `fulfilOrderLines` with the order equal to `renewal_order_id`) moves the period forward continuously (`new start = old end`), writes `membership_periods` (source `renewal`), grants the inclusions, resets `dunning_attempt = 0`, clears `past_due_since_at` and `renewal_order_id`, sets `active`, records `membership.renewed`.
50. Dunning: a failed charge sets `past_due` (from the first failure), `dunning_attempt = 1`, `past_due_since_at = now`, records `membership.past_due`, sends `membership-payment-failed` with a payment link to the same renewal order (`commerce.createPaymentLinkForOrder`). Retries run 3 and 7 days after the first failure (`dunning_attempt` 2 and 3), each failure sending the reminder again. On day 10 after the first failure an unpaid membership becomes `expired` (`end_reason = payment_failed`), the renewal order is cancelled through `commerce.cancelOrder`, `membership.expired` is recorded and `membership-expired` is sent.
51. A `past_due` member keeps member status, member pricing and member-only booking (grace) until expiry; the new period's included credits are granted only when paid.
52. Without a valid mandate (paid by link, cash or bank transfer, or mandate revoked), the scan creates the renewal order 7 days before period end, emails `membership-renewal-reminder` with a payment link, and applies the same day-0 (= period end − 3 days), 3, 7, 10 schedule with link reminders instead of charges.
53. Cancel at period end (customer in portal or staff with `memberships.write`): sets `cancel_at = current_period_end_at`, `cancel_requested_at`, no further charges, records `membership.cancel_requested`. Resume before `cancel_at` clears both. At `cancel_at` the scan sets `cancelled`, `end_reason = cancelled_by_customer|cancelled_by_staff`, `ended_at`, records `membership.cancelled`.
54. Staff immediate cancel (`memberships.write`, reason required) sets `cancelled` now; included grants of the current period stay usable until their expiry; refunds go through `commerce`.
55. Staff period extension (`memberships.write`, reason, 1–90 days) moves `current_period_end_at`, writes `membership_periods` (source `staff_extension`) and an audit row; it does not grant extra inclusions.
56. Renewal reminders: `membership.renewal_due { days: 30 }` and `{ days: 7 }` for yearly plans; `{ days: 7 }` for monthly plans only without a valid mandate or with `cancel_at` set (as "your membership ends"). Dedupe `membership:<id>:renewal_due:<days>:<period_end date>`.
57. A plan change is not an edit: the member cancels at period end and buys the new plan, which starts as `pending` on the old period's end date.

**Status**
58. `v_person_status.status` = `persons.status_override` when set, else derived: `member` with an `active` or `past_due` membership that started, `customer` with any paid order above € 0, a `purchase` or `import` grant, or any non-pending membership ever, else `lead`. A derived change never writes `status_override`.
59. Member pricing and member-only access use `is_member` (a real membership), not the override; the override drives classification, segments, content blocks and lead windows.

**Referrals and partners (R3)**
60. Each person may have one active personal code (generated on first visit to `/account/referrals`, 8 characters from `A-HJ-NP-Z2-9`); staff create partner codes for companies with `is_partner = true`.
61. Attribution is first-touch and written once per referred person: from `persons.acquisition.referral_code` (or `referrer_person_id`/`partner_company_id`) by `referrals.attribute_new`, or by staff. Self-referral (same person, same lower-case email or same phone as the referrer) is `rejected`.
62. The referrer reward (default `settings` key `referrals` = `{ referrer: { credit_kind: 'day', units: 1, validity_days: 180 }, referee: null }`) is granted 14 days after the referred person's first paid order above € 0 if that order is not refunded by then; key `grant:referral:<attribution_id>:referrer`. At most 10 rewarded referrals per referrer per calendar year.
63. Partner commission accrues on every paid order of an attributed person until `commission_until_at`: `base_cents = total_cents - vat_cents`, rate snapshot from `companies.partner_commission_pct`; refunds accrue a negative row. Finance approves and marks paid (`referrals.manage`).

**VAT**
64. A day or night package is a single-purpose voucher: VAT at sale, one kind and one rate per product (commerce check); consumption creates no VAT line.
65. A euro voucher is multi-purpose: sold at VAT 0 (`vat_treatment = multi_purpose`), VAT charged on the goods at redemption; every redemption appears in `v_euro_voucher_redemptions` for the accountant export.

## 4. Server surface

Pure logic lives in `packages/core/src/credits/` (no database): `allocate.ts` (`allocateCredits`), `thresholds.ts` (`crossedThresholds`), `expiry.ts` (`computeExpiresAt`, `expiryWarningsDue`), `periods.ts` (`nextPeriod`, `dunningSchedule`), `status.ts` (`deriveStatus`), `wording.ts` (`unitsLabelKey`), `vat.ts` (`vatTreatmentFor`), `referrals.ts` (R3: `generateReferralCode`, `isSelfReferral`, `commissionFor`), `schemas.ts` (all Zod inputs). Database code lives in `apps/web/modules/credits/server/{ledger,memberships,sharing,reconcile,referrals}.ts` and is reached only through `actions.ts`, `queries.ts`, `jobs.ts` and `api.ts`.

### Core signatures (`@beam/core/credits`)

```ts
export type CreditKind = 'day' | 'night' | 'euro';
export type GrantSharing = { mode: 'none' | 'guests' | 'named'; max_guest_uses_per_month: number; allowed_person_ids: string[] };
export type AllocGrant = { id: string; ownerPersonId: string; kind: CreditKind; status: 'active'|'exhausted'|'expired'|'revoked';
  startsAt: Date; expiresAt: Date | null; remaining: number; sharing: GrantSharing;
  guestUsesThisMonth: number; share?: { maxUnits: number | null; usedByBeneficiary: number } };
export type AllocationResult =
  | { ok: true; parts: { grantId: string; units: number }[] }
  | { ok: false; reason: 'insufficient' | 'guest_limit' | 'not_shareable' | 'share_limit'; available: number };
export function allocateCredits(grants: AllocGrant[], kind: CreditKind, units: number,
  ctx: { payerPersonId: string; beneficiaryPersonId: string; validAt: Date }): AllocationResult;
export function crossedThresholds(i: { base: number; usedBefore: number; usedAfter: number; remainingAfter: number }):
  Array<50 | 75 | 80 | 90 | 'last_unit' | 'exhausted'>;
export function computeExpiresAt(from: Date, validityDays: number | null, tz?: 'Europe/Brussels'): Date | null;
export function nextPeriod(start: Date, interval: 'month' | 'year', anchorDay: number): { start: Date; end: Date };
export function dunningSchedule(firstFailureAt: Date): { retry2At: Date; retry3At: Date; expireAt: Date }; // +3d, +7d, +10d
export function deriveStatus(i: { override: 'lead'|'customer'|'member'|null; hasCurrentMembership: boolean; hasPaid: boolean }):
  { derived: 'lead'|'customer'|'member'; status: 'lead'|'customer'|'member' };
```

### Cross-module `api.ts` (`apps/web/modules/credits/api.ts`)

```ts
import type { Tx, DbOrTx } from '@beam/db';
import type { Ctx } from '@/lib/ctx';

export class InsufficientCreditsError extends ConflictError { kind: CreditKind; needed: number; available: number;
  reason: 'insufficient' | 'guest_limit' | 'not_shareable' | 'share_limit' }

// booking: called inside the booking transaction
export function consumeCredits(tx: Tx, ctx: Ctx, input: { personId: string; beneficiaryPersonId: string;
  kind: 'day' | 'night'; units: number; ref: { type: 'booking'; id: string }; validAt?: Date }):
  Promise<{ entries: { entryId: string; grantId: string; quantity: number }[]; remainingUnits: number }>;
export function releaseCredits(tx: Tx, ctx: Ctx, input: { ref: { type: 'booking'; id: string };
  reason: 'cancelled_in_policy' | 'session_cancelled' | 'staff_override' }): Promise<{ releasedUnits: number }>;
export function checkCredits(db: DbOrTx, input: { personId: string; beneficiaryPersonId: string; kind: 'day' | 'night';
  units: number; validAt: Date }): Promise<AllocationResult>;   // no locks; for UI pre-checks only

// commerce: inside payments.sync and refund transactions
export function fulfilOrderLines(tx: Tx, ctx: Ctx, input: { orderId: string }):
  Promise<{ grantIds: string[]; membershipId: string | null }>;
export function onOrderPaymentFailed(tx: Tx, ctx: Ctx, input: { orderId: string }): Promise<void>; // no-op unless renewal order
export function revokeForRefund(tx: Tx, ctx: Ctx, input: { refundId: string; orderLineId: string; units?: number }):
  Promise<{ revokedUnits: number }>;
export function redeemEuroCredits(tx: Tx, ctx: Ctx, input: { personId: string; orderId: string; amountCents: number }):
  Promise<{ redeemedCents: number }>;
export function releaseEuroRedemption(tx: Tx, ctx: Ctx, input: { orderId: string }): Promise<{ releasedCents: number }>;
export function getMemberBenefits(db: DbOrTx, personId: string): Promise<{ isMember: boolean; membershipId: string | null;
  planProductId: string | null; discountPct: number; status: 'active' | 'past_due' | null }>;
export function canStartMembership(db: DbOrTx, personId: string):
  Promise<{ ok: true } | { ok: false; reason: 'already_member' | 'pending_exists' }>;

// ops (imports, dashboards, AI context) and crm (person page, merge)
export function grantCredits(tx: Tx, ctx: Ctx, input: GrantCreditsInput): Promise<{ grantId: string; created: boolean }>;
export type GrantCreditsInput = { personId: string; kind: CreditKind; units: number; source: 'bonus' | 'manual' | 'import' | 'referral';
  label: LocalizedText; startsAt?: Date; expiresAt: Date | null; reason: string; idempotencyKey: string;
  data?: { original_units?: number; legacy_source?: string; legacy_id?: string; import_id?: string } };
export function importMembership(tx: Tx, ctx: Ctx, input: { personId: string; productId: string; startedAt: Date;
  currentPeriodEndAt: Date; status: 'active' | 'cancelled' | 'expired'; importId: string; rowNumber: number }):
  Promise<{ membershipId: string; created: boolean }>;
export function getPersonCreditSummary(db: DbOrTx, personId: string): Promise<{
  byKind: { kind: CreditKind; remainingUnits: number; nextExpiresAt: Date | null }[];
  membership: { id: string; status: string; periodEndAt: Date; planName: LocalizedText } | null;
  status: 'lead' | 'customer' | 'member'; derivedStatus: 'lead' | 'customer' | 'member' }>;
export function onPersonsMerged(tx: Tx, ctx: Ctx, input: { winnerPersonId: string; loserPersonId: string }): Promise<void>;
export function countSharingReviewItems(db: DbOrTx): Promise<number>;                       // R2, ops action dashboard
export function resolveReferralCode(db: DbOrTx, code: string):                               // R3, crm person creation
  Promise<{ codeId: string; referrerPersonId: string | null; partnerCompanyId: string | null } | null>;
```

`fulfilOrderLines` reads the order and its lines, and per line: package or voucher product → grant (rule 1); membership product → start (rule 45) or, when `orders.id = memberships.renewal_order_id`, renewal (rule 49); R3: first paid order of an attributed person → `qualifies_at`, and partner commission accrual (rule 63). It is idempotent per line.

### Server actions (`actions.ts`, all via `action()`)

| Action (`name`) | Audience, permission | Input (Zod summary) | Writes |
| --- | --- | --- | --- |
| `createGrant` (`credits.create_grant`) | staff, `credits.adjust` | `{ personId, kind, units int 1..100 (euro 1..100000), source: 'manual'\|'bonus', label: LocalizedText (complete), validityDays int 1..1825 \| expiresAt, reason min 3, sharingMode?, clientKey uuid }` | grant + `grant` entry; event `credits.granted`; audit `credits.grant_created` |
| `adjustGrant` (`credits.adjust_grant`) | staff, `credits.adjust` | `{ grantId, quantity int ≠ 0, reason min 3 max 500, clientKey }` | `adjust`; event `credits.adjusted`; audit `credits.adjusted` (old/new balance) |
| `extendGrant` (`credits.extend_grant`) | staff, `credits.adjust` | `{ grantId, newExpiresAt, reason, clientKey }` | `extend` (+ reinstating `adjust`); event `credits.extended`; audit `credits.grant_extended` |
| `revokeGrant` (`credits.revoke_grant`) | staff, `credits.adjust` | `{ grantId, reason, clientKey }` | `revoke`; event `credits.revoked`; audit `credits.grant_revoked` |
| `transferCredits` (`credits.transfer`) | staff, `credits.adjust` | `{ grantId, toPersonId, units, reason, clientKey }` | `transfer_out`, new grant, `transfer_in`; events `credits.transferred_out`/`_in`; audit `credits.transferred` |
| `updateGrantNote` (`credits.update_note`) | staff, `credits.adjust` | `{ grantId, note max 1000 }` | audit `credits.note_changed` |
| `requestReconcile` (`credits.request_reconcile`) | staff, `credits.adjust` | `{}` | job `ledger.reconcile` key `ledger.reconcile:manual:<requestId>`; audit `credits.reconcile_requested` |
| `updateGrantSharing` R2 (`credits.update_sharing`) | staff, `credits.adjust` | `{ grantId, mode, maxGuestUsesPerMonth int 0..31 }` | audit `credits.sharing_changed` |
| `addPackageShare` R2 (`credits.add_share`) | staff `credits.adjust`; customer variant `addMyPackageShare` (`credits.portal_add_share`) owner only | `{ grantId, email, firstName, lastName?, maxUnits? int 1..100 }` | `package_shares`, sharing cache; event `credits.share_added` (owner and invitee); email `share-invitation`; audit `credits.share_added` |
| `revokePackageShare` R2 (`credits.revoke_share`), `revokeMyPackageShare` | staff `credits.adjust`; customer owner | `{ shareId, reason? }` | event `credits.share_revoked`; audit `credits.share_revoked` |
| `reviewSharing` R2 (`credits.review_sharing`) | staff, `credits.adjust` | `{ rule, grantId?, guestPersonId?, decision, note? }` | `credit_sharing_reviews`; audit `credits.sharing_reviewed` |
| `setPlanInclusion` (`memberships.set_inclusion`) | staff, `memberships.write` | `{ productId, kind: 'day'\|'night', unitsPerPeriod int 1..62, isActive }` | audit `memberships.inclusion_changed` |
| `cancelMembership` (`memberships.cancel`) | staff, `memberships.write` | `{ membershipId, mode: 'period_end'\|'now', reason, version }` | events `membership.cancel_requested` or `membership.cancelled`; audit `memberships.cancel_requested`/`memberships.cancelled_now` |
| `resumeMembership` (`memberships.resume`) | staff, `memberships.write` | `{ membershipId, version }` | event `membership.resumed`; audit `memberships.resumed` |
| `extendMembershipPeriod` (`memberships.extend_period`) | staff, `memberships.write` | `{ membershipId, days int 1..90, reason, version }` | `membership_periods`; event `membership.period_extended`; audit `memberships.period_extended` |
| `retryRenewalCharge` (`memberships.retry_charge`) | staff, `memberships.write` | `{ membershipId }` (only `past_due` with a valid mandate) | job `memberships.charge_renewal` key `renewal:<id>:<period_end>:manual:<requestId>`; audit `memberships.charge_retried` |
| `updateMembershipNotes` (`memberships.update_notes`) | staff, `memberships.write` | `{ membershipId, notes max 2000, version }` | audit `memberships.notes_changed` |
| `cancelMyMembership` / `resumeMyMembership` (`memberships.portal_cancel` / `_resume`) | customer, own membership | `{ membershipId }` | as staff, `end_reason = cancelled_by_customer`; audit with customer actor |
| `payMyRenewal` (`memberships.portal_pay`) | customer, own `past_due` or link renewal | `{ membershipId }` → `{ checkoutUrl }` | `commerce.startOrderPayment` (inline `payments.create`) |
| `createReferralCode` R3 (`referrals.create_code`) | staff, `referrals.manage` | `{ partnerCompanyId \| personId, code?, referrerReward?, refereeReward?, maxUses? }` | audit `referrals.code_created` |
| `updateReferralCode` R3 (`referrals.update_code`) | staff, `referrals.manage` | `{ codeId, isActive?, rewards?, maxUses? }` | audit `referrals.code_changed` |
| `getOrCreateMyReferralCode` R3 (`referrals.portal_code`) | customer | `{}` → `{ code, shareUrl }` | `referral_codes` |
| `attributeReferral` / `rejectAttribution` R3 | staff, `referrals.manage` | `{ referredPersonId, codeId? \| referrerPersonId? \| partnerCompanyId? }` / `{ attributionId, reason }` | events `referral.attributed`/`referral.rejected`; audits `referrals.attributed`/`referrals.attribution_rejected` |
| `setCommissionStatus` R3 (`referrals.commission_status`) | staff, `referrals.manage` | `{ commissionIds uuid[] max 500, status: 'approved'\|'paid'\|'void', note? }` | audit `referrals.commission_status_changed` per row |

Every staff action that changes a ledger row runs `ctx.audit({ action, entityType: 'credit_grant', entityId, personId, oldValue, newValue })`; `oldValue`/`newValue` carry balances and dates, never other personal data. Errors: `InsufficientCreditsError` and stale `version` map to `conflict`; a missing or foreign grant maps to `not_found`.

### Queries (`queries.ts`)

Staff (`credits.read`): `listGrants({ q?, kind?, status?, source?, expiringWithinDays?, cursor, limit≤100 })`, `getGrant(grantId)` (grant, balance row, entries with actor names, booking and session titles, shares), `getPersonCredits(personId)`, `listReconciliationRuns({ limit })`, `listSharingReview()` (R2). Staff (`memberships.write` or `credits.read`): `listMemberships({ status?, plan?, renewingWithinDays?, cursor })`, `getMembership(id)` (with periods, orders, events). Customer (own `personId` only): `getMyPackages()` → `{ active, upcoming, history, sharedWithMe }`, `getMyPackage(grantId)` (owner or active sharee), `getMyMembership()`, `getMyShares()` (R2), `getMyReferrals()` (R3). Partner (`partner.own`): `getMyPartnerPerformance()` (R3, aggregates only, no names). R3 staff (`referrals.manage` or `reports.read`): `listAttributions`, `listCommissions`, `getPartnerPerformance(companyId)`.

### Jobs (`jobs.ts`, `defineJob`)

| Kind | Lane, priority | Payload | Idempotency key | Behaviour and retries |
| --- | --- | --- | --- | --- |
| `credits.expire_grants` | bulk, 5 | `{ afterId?: uuid }` | `schedule:credits.expire_grants:<minute>` | Selects active grants with `expires_at <= now()` (limit 500, self-continuing with `{ afterId }`), enqueues `credits.expire_grant` each; records expiry warnings (rule 30). maxAttempts 6, default backoff |
| `credits.expire_grant` | fast, 5 | `{ grantId }` | `expire:<grant_id>:<expires_at date>` | Locks grant; if still active and expired, writes `expire` and sets `expired`; else no-op. Double run = same state |
| `memberships.scan_renewals` | bulk, 5 | `{}` | `schedule:memberships.scan_renewals:<minute>` | Activates due `pending`; enqueues charges (T−3 d) and link renewals (T−7 d); dunning retries at +3 d/+7 d; expiry at +10 d; ends `cancel_at` memberships; renewal reminders. Each transition in its own transaction per membership |
| `memberships.charge_renewal` | fast, 3 | `{ membershipId, periodEndOn, attempt: 1\|2\|3 }` | `renewal:<membership_id>:<period_end>` (attempt 1), `renewal:<id>:<period_end>:attempt:<n>` | Re-checks state (active/past_due, no cancel_at, mandate valid); `commerce.createRenewalOrder` (reuses `renewal_order_id`), then `commerce.chargeMandate` with the job key as Mollie idempotency key. `IntegrationError{retryable}` → retry 60 s…6 h; invalid mandate → `PermanentError`, falls back to link path. maxAttempts 6 |
| `ledger.reconcile` | bulk, 9 | `{ manual?: boolean }` | `schedule:ledger.reconcile:<minute>` | Writes `credit_reconciliation_runs`; checks in section 11; on findings enqueues `notify.slack` key `slack:ledger:<run_id>`. maxAttempts 3, timeoutMs 110 000 |
| `referrals.attribute_new` R3 | bulk, 9 | `{ since }` | `schedule:referrals.attribute_new:<minute>` | Creates attributions from `persons.acquisition` for persons created since the last run |
| `referrals.qualify_rewards` R3 | bulk, 5 | `{}` | `schedule:referrals.qualify_rewards:<minute>` | Grants rewards whose `qualifies_at <= now()` and first order not refunded |

### Schedules (`schedules.ts`, cron in Europe/Brussels)

`credits.expire_grants` `5 0 * * *`; `ledger.reconcile` `30 4 * * *`; `memberships.scan_renewals` `10 6 * * *` (all three from the architecture); R3 `referrals.attribute_new` `*/10 * * * *`; R3 `referrals.qualify_rewards` `10 5 * * *`.

### Activity events (`events.ts`, `defineEvent`)

`credits.granted`, `credits.consumed`, `credits.guest_used`, `credits.released`, `credits.threshold_reached { pct }`, `credits.grant_exhausted`, `credits.expiry_approaching { days }`, `credits.grant_expired`, `credits.extended`, `credits.adjusted`, `credits.revoked`, `credits.transferred_out`, `credits.transferred_in`, `credits.share_added`, `credits.share_revoked` (R2), `membership.started`, `membership.renewed`, `membership.renewal_due { days }`, `membership.past_due`, `membership.payment_retry_failed { attempt }`, `membership.cancel_requested`, `membership.resumed`, `membership.cancelled`, `membership.expired`, `membership.period_extended`, `referral.attributed`, `referral.rewarded`, `referral.rejected` (R3). Every event carries `ref_type`/`ref_id` (grant, membership or attribution) and ids-only `data`.

### Routes and webhooks

None. Mollie webhooks are handled by `commerce` (`/api/webhooks/mollie` → `payments.sync`), which calls `fulfilOrderLines` and `onOrderPaymentFailed`.

## 5. Screens

All screens use `@beam/ui` (`DataTable`, `FormField`, `LocalizedInput`). Loading states are route-level `loading.tsx` skeletons; errors use the route `error.tsx` with "Something went wrong, try again" and the request id; mutations show the action error message inline and keep form input. Every staff form posts a `clientKey` generated when the form opens.

### Staff back-office (`app/(admin)/admin/...`)

| Route | Permission | Shows | Actions | Empty state |
| --- | --- | --- | --- | --- |
| `/admin/credits` | `credits.read` | Grants table: person, product or label, kind, remaining / base, status, source, starts, expires, last used. Filters: kind, status, source, "expiring in 30 days", search by name or email. Top tiles: active grants, units outstanding per kind, expiring in 30 days, value outstanding (`v_credit_liability`) | Open grant; "New grant" (needs `credits.adjust`) | "No packages yet. Packages appear here when customers buy them or you add one." |
| `/admin/credits/new?personId=` | `credits.adjust` | Form: person picker, kind, units, label (three locales), validity days or date, source manual or bonus, reason | `createGrant` | — |
| `/admin/credits/grants/[grantId]` | `credits.read` | Header with owner, product, kind, balance, status, dates, VAT treatment, unit value, sharing; ledger table (date, kind, quantity, running balance, beneficiary, booking/session link, actor, reason); shares (R2); guest uses this month | `adjustGrant`, `extendGrant`, `revokeGrant`, `transferCredits`, `updateGrantNote`; R2 `updateGrantSharing`, `addPackageShare`, `revokePackageShare` (each needs `credits.adjust`, buttons hidden otherwise) | Ledger never empty (first `grant` entry) |
| `/admin/credits/sharing-review` (R2) | `credits.read`; decisions need `credits.adjust` | `v_sharing_review` rows: rule, grant or guest, distinct count, people (names), last use | `reviewSharing` (ok, warned, disable sharing) | "No sharing patterns need review." |
| `/admin/credits/reconciliation` | `credits.read` | Last 30 runs with status, counts and findings (links to grants and bookings) | `requestReconcile` | "No run yet. The first run happens tonight at 04:30." |
| `/admin/memberships` | `credits.read` or `memberships.write` | Table: person, plan, status, period end, next charge, dunning attempt, cancel at. Filters: status, plan, "renewing in 30 days", "past due" | open | "No memberships yet." |
| `/admin/memberships/[membershipId]` | `credits.read` or `memberships.write` | Plan, status timeline, current period, included grants for this period with balances, `membership_periods` history, renewal orders and payment statuses (commerce links), mandate status, notes | `cancelMembership` (period end or now), `resumeMembership`, `extendMembershipPeriod`, `retryRenewalCharge`, `updateMembershipNotes` (`memberships.write`) | — |
| `/admin/memberships/plans` | `memberships.write` | Membership products (read from commerce) with primary inclusion, extra inclusions, discount, interval; warning when inclusions mix day and night ("mixed VAT services: confirm with the accountant") | `setPlanInclusion` | "Create a product of kind membership in Products first." |
| `/admin/referrals` (R3) | `referrals.manage` or `reports.read` | Tabs: Codes, Attributions (status, referrer or partner, first paid, reward grant), Commissions (month, partner, order, amount, status), Partners (`v_partner_performance` per company and month) | `createReferralCode`, `updateReferralCode`, `attributeReferral`, `rejectAttribution`, `setCommissionStatus` (`referrals.manage`) | "No referrals yet." |
| `/admin/partner` (R3) | `partner.own` | The external partner's own figures: referred count, customers, revenue, commission accrued and paid per month, their codes. Aggregates only, no customer names | — | "No referred customers yet." |

Panels exported from `apps/web/modules/credits/ui/` for other modules' pages: `PersonCreditsPanel` (crm person page: totals per kind, next expiry, active grants with quick links, membership badge; needs `credits.read`), `PersonMembershipPanel`, `CreditsDashboardTiles` (ops action dashboard: expiring in 30 days, nearly finished at ≥ 80 %, memberships renewing in 30 days, past-due memberships, sharing reviews).

### Customer portal (`app/[locale]/(portal)/account/...`, audience customer, own data only)

| Route | Shows | Actions | Empty state |
| --- | --- | --- | --- |
| `/[locale]/account/packages` | Cards per usable grant: product name, "4 sessions remaining", expiry date, progress bar; upcoming grants ("Starts on …"); "Shared with me" (R2); collapsed history of closed grants (exhausted, expired, revoked) | Book (link to `/account/book`), Buy a package (link to `/account/shop`) | "You have no packages yet." with a link to the shop |
| `/[locale]/account/packages/[grantId]` | Usage history: date, session title, used by ("You" or guest's first name + initial), returned on cancellation, expired, "Adjusted by BEAM"; guest uses left this month | R2: Sharing section (when `sharing.mode = named`): invite by email (`addMyPackageShare`), list and revoke shares | "Not used yet." |
| `/[locale]/account/membership` | Plan, status, member since, current period, next renewal date and amount, payment method state, included sessions and nights this period with remaining, member discount, history of periods | `cancelMyMembership` (confirm dialog shows the end date), `resumeMyMembership`, `payMyRenewal` when past due or link renewal | "You are not a member yet." with link to membership plans in the shop |
| `/[locale]/account/referrals` (R3) | Personal code and share link `https://beam.be/<locale>?ref=<CODE>`, referred friends count, rewards received | Copy link (`getOrCreateMyReferralCode`) | "Invite a friend and get a session when they make their first purchase." |

Portal error state for a grant or membership not owned by the actor is the standard 404. The portal home (owned by `crm`) embeds `CreditsSummaryCard` (totals per kind and membership status).

### Public

None. The `?ref=` capture on the site is `site`'s responsibility (cookie `beam_ref`, 30 days, passed to `crm` at person creation).

## 6. Integrations

The module calls no provider client directly.

| Service | Path | Calls | Failure handling | Idempotency |
| --- | --- | --- | --- | --- |
| Mollie (through `commerce`) | job `memberships.charge_renewal` → `commerce.chargeMandate(ctx, { orderId, mandateId, idempotencyKey })`, which calls `PaymentProvider.createRecurringPayment`; `payMyRenewal` → `commerce.startOrderPayment` (inline `payments.create`) | recurring payment on a mandate; one-off payment link | Retryable provider errors retry with the job backoff; a declined payment arrives later as a failed payment via `payments.sync` → `onOrderPaymentFailed` → dunning; an invalid or revoked mandate is a `PermanentError` and the membership falls back to the link path (rule 52). Tests use `packages/integrations/src/payments/fake.ts` with scripted outcomes `paid`, `failed`, `expired` | Job key passed as the Mollie `Idempotency-Key`; one renewal order per period (`renewal_order_id`) |
| Resend (through `email`) | `email.sendTransactional(tx, ctx, { personId, template, data, idempotencyKey })` | templates in section 8 | Handled by `email` (`blocked_translation`, suppressions do not apply to transactional) | `credits:<template>:<entity_id>:<qualifier>` e.g. `credits:membership-payment-failed:<membership_id>:<period_end>:<attempt>` |
| Slack (through `platform`) | `ctx.enqueue({ kind: 'notify.slack' })` from `ledger.reconcile` | one message with counts and a link to `/admin/credits/reconciliation` | Platform job retries | `slack:ledger:<run_id>` |

## 7. Permissions and audit

`modules/credits/permissions.ts` declares the architecture's `credits.read`, `credits.adjust`, `memberships.write`, `partner.own`, and one addition for R3: `referrals.manage` (manage codes, attributions and commission statuses).

| Role (seeded) | credits.read | credits.adjust | memberships.write | referrals.manage (R3) | partner.own |
| --- | --- | --- | --- | --- | --- |
| owner, technical_admin | yes | yes | yes | yes | — |
| management | yes | yes | yes | yes | — |
| customer_service | yes | yes | yes | — | — |
| finance | yes | — | — | yes | — |
| reception | yes | — | — | — | — |
| sales | — | — | — | yes | — |
| marketing | — | — | — | — | — |
| external_partner | — | — | — | — | yes |

Reception sees balances at the desk but cannot change them; booking with a credit at the desk goes through `bookings.write`, which calls `consumeCredits` as part of the booking (the ledger records the staff actor). Customers act only on their own grants, shares and memberships; `getMyPackage` also admits an active sharee read-only. `partner.own` sees only aggregates of attributions where `partner_company_id = persons.partner_company_id` of the partner user's person.

Audited (`audit_log`, actor, old and new value): `credits.grant_created`, `credits.adjusted`, `credits.grant_extended`, `credits.grant_revoked`, `credits.transferred`, `credits.note_changed`, `credits.reconcile_requested`, `credits.sharing_changed`, `credits.share_added`, `credits.share_revoked`, `credits.sharing_reviewed`, `memberships.inclusion_changed`, `memberships.cancel_requested`, `memberships.cancelled_now`, `memberships.resumed`, `memberships.period_extended`, `memberships.charge_retried`, `memberships.notes_changed`, `memberships.ended` (system: cancelled at period end or expired), `memberships.merged`, `referrals.code_created`, `referrals.code_changed`, `referrals.attributed`, `referrals.attribution_rejected`, `referrals.commission_status_changed`. Customer-initiated membership cancel and resume and share changes are audited with the customer actor (blueprint 56 "membership changed"). Automatic ledger writes (consume, release, expire, purchase grants) are not audited separately: the ledger row with its `actor` is the record.

## 8. Multi-language and content

Catalogue namespace `credits` in `packages/core/src/i18n/messages/{en,nl-BE,fr-BE}/credits.json`; `en` is the source. Key groups:

- `credits.units.day`, `credits.units.night` (ICU plurals, rule 36), `credits.units.euro` ("{amount} remaining"), `credits.units.starts_on`, `credits.units.expires_on`, `credits.units.no_expiry`.
- `credits.portal.packages.*` (title, active, upcoming, shared_with_me, history, empty, buy, book), `credits.portal.package.*` (usage table headings, `used_by_you`, `used_by_guest`, `returned`, `expired`, `adjusted_by_beam`, `guest_uses_left`), `credits.portal.sharing.*` (R2), `credits.portal.membership.*` (status labels for all five statuses, renewal, cancel dialog, resume, pay now, included, discount, history), `credits.portal.referrals.*` (R3).
- `credits.admin.*` for every admin screen, field, filter, button, confirmation and empty state; `credits.errors.*` (`insufficient`, `guest_limit`, `not_shareable`, `share_limit`, `expired`, `stale_version`, `already_member`).
- Status and enum labels: `credits.enum.kind.*`, `credits.enum.grant_status.*`, `credits.enum.source.*`, `credits.enum.entry_kind.*`, `credits.enum.membership_status.*`, `credits.enum.end_reason.*`.

`LocalizedText` fields: `credit_grants.label` (manual, bonus, import and referral grants). `createGrant` calls `assertComplete(label, ['nl-BE','fr-BE','en'])`; imports and referral rewards fill all three from catalogue keys `credits.labels.import` ("Package from previous system"), `credits.labels.referral_reward` ("Thank-you session"), `credits.labels.transfer` ("Received from {name}" rendered at display time). Product names come from `products.name` (commerce, already complete at publish).

Transactional templates in `packages/email/src/templates/credits/` (react-email, three locales each, subjects in the catalogue under `credits.email.<template>.*`): `membership-started`, `membership-renewal-reminder` (30 and 7 days, variant "ends" when `cancel_at` is set), `membership-renewed`, `membership-payment-failed` (day 0, 3, 7, with pay link), `membership-expired`, `membership-cancel-confirmed`, `share-invitation` (R2), `referral-reward` (R3). Package usage, expiry and renewal marketing follow-ups are `automation` sequences triggered by this module's events, not templates here. A template missing a locale is blocked by `email` (`blocked_translation`); `pnpm i18n:check` covers the catalogue.

## 9. Privacy

`modules/credits/privacy.ts` registers:

```ts
export const privacy = {
  tables: ['credit_grants','credit_entries','package_shares','memberships','membership_periods',
           'credit_sharing_reviews','referral_codes','referral_attributions','partner_commissions'],
  export: async (tx, personId) => ({ /* see below */ }),
  erase: async (tx, personId, ctx) => ({ /* per table: rows and action */ }),
};
```
`credit_reconciliation_runs` and `membership_plan_inclusions` are in `NO_PII_TABLES`.

**Export** (subject's own data, JSON and CSV): grants owned (all statuses, with product name, dates, kind, units, status, label), all ledger entries on those grants (kind, quantity, date, session title, beneficiary first name and initial for guests, the reason text of adjustments), entries where the person was the beneficiary on someone else's grant (date, session, owner first name and initial), shares given and received, memberships with periods, plan, discount and statuses, referral code, attributions where they are the referrer (referred friends as count only) or the referred person, partner commissions only for a person-linked partner (none by default). Staff notes are included (Art. 15 covers them); actor user ids are replaced by "BEAM staff".

**Erase** (runs under `SET LOCAL beam.allow_rewrite = 'on'`, after `commerce` and before `crm` anonymises `persons`):

| Table | Action | Why |
| --- | --- | --- |
| `credit_grants` (source `purchase`, `import`, `membership`, `transfer`) | remaining units revoked (`revoke`, key `revoke:erase:<request_id>:<grant_id>`, reason `erased`); grant `revoked`; `note` and `label` nulled; row **retained_legal** pointing at the anonymised person | Prepaid sales back invoices kept 7 years (Belgian accounting); the ledger proves the revenue and liability |
| `credit_grants` (source `bonus`, `manual`, `referral`) and their entries | **deleted** | No legal basis to keep |
| `credit_entries` on retained grants | **anonymised**: `reason` → `redacted`, `data` stripped to `{}` except `old_expires_at`/`new_expires_at`; rows retained | Same as grants |
| `credit_entries` where the person is only the beneficiary on another owner's grant | **anonymised**: `beneficiary_person_id` kept (points at the anonymised person, so the owner's history stays consistent) | The owner's package history must remain correct |
| `package_shares` (given or received) | **deleted** | |
| `memberships` | status set `expired` with `end_reason = erased` if active (commerce revokes the mandate), `notes` nulled, row **retained_legal** | Linked to paid orders and invoices |
| `membership_periods` | **retained_legal** | Same |
| `credit_sharing_reviews` mentioning the person | `note` nulled; the person id removed from `guest_person_ids`; row deleted when it becomes empty | |
| `referral_codes` owned by the person | **deleted** | |
| `referral_attributions` (as referred or referrer) | **deleted**; `partner_commissions.attribution_id` set null | |
| `partner_commissions` | **retained_legal** (no person column) | Partner's financial record |

The staff erasure confirmation screen (`ops`) shows the remaining balance per kind from `getPersonCreditSummary` so staff can tell the customer that remaining sessions are forfeited.

**Retention** (rows in `retention_policies` seeded by `packages/db/src/seed/credits.ts`, enforced by `ops`' `privacy.retention_sweep`): `credits.ledger` — grants with status not `active` whose `status_changed_at` is older than 7 years are deleted with their entries (`delete`, 2555 days); `credits.sharing_reviews` — 2 years (`delete`, 730 days); `credits.reconciliation_runs` — 1 year (`delete`, 365 days); `referrals.attributions` — 3 years after `attributed_at` when not linked to a commission (`delete`, 1095 days). Memberships and periods follow the invoice horizon: 7 years after `ended_at` (`delete`, 2555 days).

## 10. Dependencies

**Needs from other modules**

| Module | What | Release |
| --- | --- | --- |
| platform | `action()`, `Ctx`, `defineJob`, `defineSchedule`, `defineEvent`, `ctx.enqueue`, `ctx.recordEvent`, `ctx.audit`, `requirePermission()`, `runJobInline`; tables `users`, `audit_log`, `jobs`; job `notify.slack`; `settings` key `referrals` (R3, added through platform's settings registry request) | V1 |
| crm | table `persons` (`status_override`, `acquisition`, `erased_at`, `merged_into_person_id`, `partner_company_id`); `crm.findOrCreatePersonByEmail(tx, ctx, { email, firstName, lastName?, locale, source })` for share invitations; `crm.recordEvent` via `ctx.recordEvent`; table `companies` (`is_partner`, `partner_commission_pct`) R3; crm calls `credits.onPersonsMerged` inside its merge transaction; crm stores `acquisition.referral_code` (R3 request) | V1, R2, R3 |
| commerce | tables `products` (`kind`, `credit_kind`, `credit_units`, `validity_days`, `is_sharing_allowed`, `max_guest_uses_per_month`, `member_discount_pct`, `recurring_interval`, `included_credit_kind`, `included_credit_units`, `vat_rate_pct`, `name`), `orders`, `order_lines` (`data.start_on` for future-dated memberships), `price_versions`, `mandates`, `refunds`; functions `commerce.createRenewalOrder(tx, ctx, { membershipId, personId, productId, periodStartAt }): Promise<{ orderId: string }>`, `commerce.chargeMandate(ctx, { orderId, mandateId, idempotencyKey }): Promise<{ providerPaymentId: string; status: string }>`, `commerce.createPaymentLinkForOrder(tx, ctx, { orderId }): Promise<{ url: string }>`, `commerce.startOrderPayment(tx, ctx, { orderId }): Promise<{ checkoutUrl: string }>`, `commerce.cancelOrder(tx, ctx, { orderId, reason })`; commerce calls `fulfilOrderLines` and `onOrderPaymentFailed` from `payments.sync`, `revokeForRefund` from the refund action, `redeemEuroCredits`/`releaseEuroRedemption` at checkout, `getMemberBenefits` and `canStartMembership` in `quote` and checkout. Request: add `voucher` to `payments_provider` so euro redemptions appear as a payment means | V1 |
| booking | tables `bookings`, `sessions` (read); booking calls `consumeCredits`, `releaseCredits`, `checkCredits`, `getMemberBenefits` (member-only sessions) | V1 |
| email | `email.sendTransactional(tx, ctx, { personId, template, data, idempotencyKey })` | V1 |
| ops | calls `grantCredits` (import kind `packages`) and `importMembership` (import kind `memberships`); runs the retention sweep over this module's policies; erasure orchestration calls `privacy.erase` | V1 |
| automation | consumes events `credits.threshold_reached`, `credits.grant_exhausted`, `credits.expiry_approaching`, `membership.renewal_due`, `membership.started`, `membership.past_due`, `membership.expired`; seeded sequences `package-usage` and `membership-renewal` | V1 |
| site | `?ref=` cookie capture (R3) | R3 |

**Provides to other modules**: every `api.ts` function in section 4; views `v_person_status` (crm `getPersonStatus`, ops `v_person_profile`, booking lead windows, email content blocks for lead/customer/member), `v_person_credits` and `v_credit_grant_balances` (ops retention lists "packages nearly finished", "finished without repurchase", "approaching expiry", "unused sessions", AI fields `credits_remaining`, `grant_expires_at`, `membership_period_end_at`), `v_credit_liability` and `v_euro_voucher_redemptions` (finance), `v_sharing_review` (ops action dashboard, R2), `v_partner_performance` (ops dashboards, R3), `v_package_cycles` (ops churn and repurchase, R4); UI panels `PersonCreditsPanel`, `PersonMembershipPanel`, `CreditsSummaryCard`, `CreditsDashboardTiles`.

## 11. Edge cases and failure modes

1. **Two bookings race for the last unit.** Both `consumeCredits` calls lock the owner's grants `FOR UPDATE`; the second sees `remaining = 0` and throws `InsufficientCreditsError`; its booking transaction rolls back and the customer sees "No sessions left on your packages".
2. **Double submit or retried booking request.** The second `consume` hits key `consume:<booking_id>:<grant_id>` and returns the existing entries; no double deduction.
3. **Deadlock between a booking and the expiry job on two grants.** Locks are always taken in ascending grant `id`; the expiry job locks one grant per transaction. If Postgres still reports a deadlock (40P01), `action()` maps it to `conflict` and the UI retries once automatically.
4. **Session booked before the package expires but held after.** Validity is checked at the session start (`validAt`), so a grant expiring before the session cannot pay for it; the customer is told which date the package expires.
5. **Cancellation after the grant expired.** Rule 26: release plus immediate expire; staff can extend to give the unit back.
6. **Cancellation of a session by BEAM** (`sessions.status = cancelled`): booking calls `releaseCredits` with reason `session_cancelled` for every booking, whatever the policy; expired grants follow rule 26 and staff see them on the session cancel report.
7. **Refund of a package that has been partly used.** Only unused units are revoked (rule 27); commerce computes the refund amount; a refund request larger than the unused value is commerce's validation.
8. **Mollie webhook for a renewal arrives twice or out of order.** `payments.sync` is idempotent; `fulfilOrderLines` checks `renewal_order_id` and the `membership_periods` unique `(membership_id, period_start_at)`, so the period moves forward once.
9. **Renewal paid after the membership expired** (late bank payment on a cancelled renewal order that commerce still marks paid): `fulfilOrderLines` reactivates the membership with a new period starting at `paid_at` (source `late_payment`), grants inclusions, records `membership.renewed { late: true }`, and creates a task for customer service through `crm` to confirm.
10. **Mandate revoked between scan and charge.** `charge_renewal` re-reads the mandate; invalid → `PermanentError` path switches to the payment-link flow (rule 52) the same day.
11. **Customer cancels at period end after the T−3 charge was already created.** If the renewal payment is still open, `cancelMyMembership` asks commerce to cancel the renewal order; if it already succeeded, the cancel applies to the end of the newly paid period and the portal says so.
12. **Two active memberships after a person merge.** Rule 35: keep the later-ending one, cancel the other, audit, and create a task for refund review.
13. **Month-end anchors.** A membership started 31 January renews 28 February (29 in leap years) then 31 March: periods are computed from the anchor day, not from the previous end.
14. **DST change.** Expiry is end of day in Europe/Brussels computed with the zone, so a 30-day package bought at 10:00 on 20 October expires at 23:59:59.999 Brussels on 19 November regardless of the clock change.
15. **Threshold crossing by a 2-unit booking** (night costs 2): 50 % and 75 % fire in the same transaction, each once.
16. **Release and re-book within a package.** The release does not un-fire thresholds; the re-booking does not re-fire them (dedupe keys); automation uses the latest balance in its `unless` checks.
17. **Guest limit reached mid-month.** `checkCredits` returns `guest_limit`; the booking UI says "You have used your 2 guest visits this month on this package" and offers payment for the guest instead.
18. **Owner's grant is revoked while a named sharee has future bookings.** Existing bookings stay confirmed (already consumed); revocation affects only remaining units.
19. **Guest is the owner** (owner enters their own email as guest): rejected with `validation` ("You cannot be your own guest").
20. **Negative balance found by reconcile** (only possible through a bug or manual SQL). Reconcile reports it, never writes a correction; staff fix it with an adjustment after investigation.
21. **Booking paid with credit but no consume entry** (or the reverse: consume without a live booking). Reconcile reports `booking_without_consume` or `orphan_consume`; consume entries of `cancelled` bookings without a release are reported as `missing_release`.
22. **Status drift** (grant `active` with balance 0, or `exhausted` with balance > 0). Reconcile corrects the status (allowed: status is derived bookkeeping) and lists it under `fixed`.
23. **Expiry job misses a night** (tick down). The next run expires everything with `expires_at <= now()`; warnings use `expiryWarningsDue` windows (`30 ± 1 day`, `7 ± 1 day`) so one missed day still emits them once.
24. **Import contains a balance for an unknown product.** Grant created without `product_id`, `label` from `credits.labels.import`, kind from the row; a row without kind or units is `error` in the import report.
25. **Import re-run with corrected balances.** Same `(import_id, row_number)` key → no change; a new import with a different id creates a second grant, so the import tool shows a "possible duplicate: person already has an import grant" warning in the dry run.
26. **Erasure of a guest.** The owner's history keeps the use with "Deleted person" as beneficiary; the owner's balance is unchanged.
27. **Price change of the plan between periods.** The renewal order uses the price version valid at order creation; yearly members are told in the 30-day reminder, which shows the renewal amount.
28. **Referral loop** (A refers B, B refers A): attribution is first-touch and one per referred person, and a person who already had a paid order before attribution cannot be attributed (rejected `already_customer`).

## 12. Build packages

Order and file ownership: **P1 and P2 run in parallel** (disjoint files). **P3 → P4 → P5 → P6 → P7 are strictly sequential** because they share `apps/web/modules/credits/{api,jobs,schedules,events,actions,queries}.ts` and the `credits.json` catalogues. **P8 (R2) → P9 (R3) → P10 (R4)** follow, also sequential, and edit `credits.ts`, `credits.views.ts`, `api.ts`, `actions.ts`, `queries.ts`, `events.ts` after P7. No package edits `package.json`, the lockfile, `packages/db/migrations/*`, `registry/*.generated.ts`, `packages/db/src/schema/index.ts` or any frozen Wave 0 file. Every package's done-definition includes: `pnpm typecheck` and `pnpm lint` clean, its listed Vitest suites green on `createTestDb()` (fresh PGlite per file, fakes from `packages/integrations/src/*/fake.ts`), and new keys present in all three catalogues (`pnpm i18n:check`).

### credits-P1 (V1): schema and views
- **Goal**: final V1 tables and views of section 2 (without the R2 review table and the R3/R4 objects).
- **Files**: edit `packages/db/src/schema/credits.ts` (complete the Wave 0 stubs of `credit_grants`, `credit_entries` keeping every existing column; add `package_shares`, `memberships`, `membership_plan_inclusions`, `membership_periods`, `credit_reconciliation_runs`, all enums, checks, indexes); create `packages/db/src/schema/credits.views.ts` (`v_credit_grant_balances`, `v_person_credits`, `v_person_status`, `v_credit_liability`, `v_euro_voucher_redemptions`); create `packages/db/src/seed/credits.ts` (demo grants, one active monthly membership, one past-due membership, retention policy rows); create `packages/db/src/testing/credits-factories.ts` (`makeCreditGrant`, `makeMembership`, `makeEntry`).
- **Exposes**: Drizzle tables `creditGrants`, `creditEntries`, `packageShares`, `memberships`, `membershipPlanInclusions`, `membershipPeriods`, `creditReconciliationRuns`; views `vCreditGrantBalances`, `vPersonCredits`, `vPersonStatus`, `vCreditLiability`, `vEuroVoucherRedemptions`; `export const CREDITS_APPEND_ONLY = ['credit_entries', 'membership_periods'] as const`.
- **Depends on**: Wave 0 (`_shared.ts` helpers, `crm:persons`, `commerce:products/orders/order_lines/price_versions/mandates/refunds` stubs, `platform:users`).
- **Tests**: `packages/db/src/schema/credits.test.ts`: every check constraint rejects a bad row (negative consume, `adjust` without reason, `extend` with quantity ≠ 0, `release` without `reverses_entry_id`, euro grant with unit value ≠ 1, `purchase` without order line); partial uniques (two active memberships, two releases of one consume, duplicate idempotency key); `credits.views.test.ts`: balance = sum, `is_usable` false for future and expired grants, `v_person_credits` excludes non-usable, `v_person_status` lead/customer/member and override precedence, erased and merged persons excluded, €0 order does not make a customer, past_due counts as member.
- **Done**: base checks; `createTestDb()` builds the schema; both suites green.

### credits-P2 (V1): pure core logic
- **Goal**: all deterministic rules without a database.
- **Files**: create `packages/core/src/credits/{index,allocate,thresholds,expiry,periods,status,wording,vat,schemas}.ts` and `packages/core/src/credits/*.test.ts`.
- **Exposes**: signatures in section 4 "Core signatures"; Zod schemas `CreateGrantInput`, `AdjustGrantInput`, `ExtendGrantInput`, `RevokeGrantInput`, `TransferCreditsInput`, `CancelMembershipInput`, `ExtendMembershipPeriodInput`, `GrantSharingSchema`, `GrantCreditsInputSchema`.
- **Depends on**: Wave 0 `packages/core` (`LocalizedText`, `errors.ts`).
- **Tests**: `allocate.test.ts` (earliest expiry first, null expiry last, split across grants, future grant skipped, expired at `validAt` skipped, insufficient returns available, guest on `none` → `not_shareable`, monthly guest limit, share `max_units`, own grants before shared); `thresholds.test.ts` (single and multi crossing, last unit, exhausted, `original_units` base, no fire on release); `expiry.test.ts` (end of day Brussels, DST October and March, null validity); `periods.test.ts` (31 Jan → 28/29 Feb → 31 Mar, yearly on 29 Feb, dunning +3/+7/+10); `status.test.ts`; `vat.test.ts`. Coverage ≥ 90 % for `packages/core/src/credits`.
- **Done**: base checks; core suites green with coverage threshold.

### credits-P3 (V1): ledger service and booking/commerce API
- **Goal**: every ledger write path with locks, idempotency, thresholds and events; the expiry job.
- **Files**: create `apps/web/modules/credits/server/ledger.ts`; edit (replace Wave 0 stubs) `apps/web/modules/credits/{api,events,permissions,jobs,schedules}.ts`; create `apps/web/modules/credits/server/ledger.test.ts`, `apps/web/modules/credits/api.test.ts`, `apps/web/modules/credits/jobs.test.ts`.
- **Exposes**: `consumeCredits`, `releaseCredits`, `checkCredits`, `fulfilOrderLines` (package and voucher lines only), `revokeForRefund`, `redeemEuroCredits`, `releaseEuroRedemption`, `grantCredits`, `getPersonCreditSummary`, `InsufficientCreditsError`; internal `lockGrants(tx, ids)`, `writeEntry(tx, ctx, entry)`, `adjust`, `extend`, `revoke`, `transfer`; jobs `credits.expire_grants`, `credits.expire_grant`; schedule `credits.expire_grants`; events of section 4 prefixed `credits.`; permissions `credits.read`, `credits.adjust`, `memberships.write`, `partner.own`.
- **Depends on**: P1, P2; `platform:action/defineJob/ctx.recordEvent/ctx.audit`; `commerce:orders, order_lines, products` tables.
- **Tests**: ledger — concurrent consumes on one grant (two transactions, second fails), idempotent consume and release, release of an expired grant writes release + expire, negative balance refused, status transitions, threshold events with dedupe keys, guest use writes events on both timelines, euro redemption and release, refund revocation of unused units only, transfer creates grant and both entries, extension with reinstatement within 365 days and refusal after; api — `fulfilOrderLines` twice yields one grant with correct units, expiry, VAT treatment and sharing defaults; jobs — `credits.expire_grant` and `credits.expire_grants` run twice give the same state; expiry warnings once per window.
- **Done**: base checks; three suites green.

### credits-P4 (V1): memberships and renewals
- **Goal**: membership lifecycle, inclusions, renewal charging, dunning, reminders, member benefits.
- **Files**: create `apps/web/modules/credits/server/memberships.ts`, `apps/web/modules/credits/server/memberships.test.ts`; edit `apps/web/modules/credits/{api,jobs,schedules,events}.ts`; create `packages/email/src/templates/credits/{membership-started,membership-renewal-reminder,membership-renewed,membership-payment-failed,membership-expired,membership-cancel-confirmed}.tsx`; edit `packages/core/src/i18n/messages/{en,nl-BE,fr-BE}/credits.json` (email subjects and bodies).
- **Exposes**: `fulfilOrderLines` membership branch, `onOrderPaymentFailed`, `getMemberBenefits`, `canStartMembership`, `importMembership`; internal `startMembership`, `renewMembership`, `markPastDue`, `expireMembership`, `requestCancel`, `resume`, `cancelNow`, `extendPeriod`; jobs `memberships.scan_renewals`, `memberships.charge_renewal`; schedule `memberships.scan_renewals`; `membership.*` events.
- **Depends on**: P3; `commerce:createRenewalOrder, chargeMandate, createPaymentLinkForOrder, cancelOrder` (mocked through their Wave 0 stubs plus the payments `fake.ts`); `email:sendTransactional`.
- **Tests**: first payment starts membership with period, inclusions (primary + extra), discount snapshot, period row; future start → `pending` then activated by the scan; scan at T−3 enqueues one charge; paid renewal moves period continuously and grants once (webhook twice); failure → `past_due`, retries at +3/+7, expiry at +10 with order cancel; no-mandate path at T−7; cancel at period end and resume; staff cancel now keeps grants; reminders 30/7 for yearly and the monthly rule; late payment reactivation; `getMemberBenefits` for active, past_due, cancelled; double-run of both jobs; templates render in three locales.
- **Done**: base checks; suites green.

### credits-P5 (V1): reconciliation, privacy and merge
- **Goal**: nightly `ledger.reconcile`, `privacy.ts`, `onPersonsMerged`.
- **Files**: create `apps/web/modules/credits/server/reconcile.ts`, `apps/web/modules/credits/server/reconcile.test.ts`, `apps/web/modules/credits/privacy.test.ts`; edit `apps/web/modules/credits/{privacy,api,jobs,schedules}.ts`.
- **Exposes**: job `ledger.reconcile`, schedule `ledger.reconcile`, `privacy` registration (section 9), `onPersonsMerged`.
- **Depends on**: P4; `booking:bookings, sessions` tables; `platform:notify.slack`.
- **Tests**: reconcile finds `booking_without_consume`, `orphan_consume`, `missing_release`, `negative_balance`, `stale_membership_period`, fixes status drift only, writes one run, alerts once (double run); privacy — export contains owned grants, beneficiary uses and memberships; erase revokes balances, deletes bonus grants, shares, codes, redacts reasons, retains purchase grants and memberships; no row outside the retained set references the person; merge moves grants and memberships and resolves two active memberships.
- **Done**: base checks; suites green; `gdpr-coverage` passes for credits tables.

### credits-P6 (V1): staff back-office
- **Goal**: admin screens and staff actions of sections 4 and 5 for V1.
- **Files**: edit `apps/web/modules/credits/{actions,queries,nav}.ts`; create `apps/web/modules/credits/ui/{grants-table,grant-ledger,adjust-dialog,extend-dialog,revoke-dialog,transfer-dialog,new-grant-form,membership-detail,plan-inclusions,reconciliation-list,person-credits-panel,person-membership-panel,credits-dashboard-tiles}.tsx`; create routes `apps/web/app/(admin)/admin/credits/{page,loading,error}.tsx`, `.../credits/new/page.tsx`, `.../credits/grants/[grantId]/page.tsx`, `.../credits/reconciliation/page.tsx`, `apps/web/app/(admin)/admin/memberships/{page,loading,error}.tsx`, `.../memberships/[membershipId]/page.tsx`, `.../memberships/plans/page.tsx`; edit `packages/core/src/i18n/messages/{en,nl-BE,fr-BE}/credits.json` (`credits.admin.*`, `credits.enum.*`, `credits.errors.*`).
- **Exposes**: actions `createGrant`, `adjustGrant`, `extendGrant`, `revokeGrant`, `transferCredits`, `updateGrantNote`, `requestReconcile`, `setPlanInclusion`, `cancelMembership`, `resumeMembership`, `extendMembershipPeriod`, `retryRenewalCharge`, `updateMembershipNotes`; queries `listGrants`, `getGrant`, `getPersonCredits`, `listMemberships`, `getMembership`, `listReconciliationRuns`; components `PersonCreditsPanel`, `PersonMembershipPanel`, `CreditsDashboardTiles`; nav entries "Packages" and "Memberships" under Customers.
- **Depends on**: P5; `platform:requirePermission`, `@beam/ui` `DataTable`, `LocalizedInput`.
- **Tests**: `apps/web/modules/credits/permissions.test.ts` (each staff action refused without its permission; reception can read but not adjust; customer audience refused); `apps/web/modules/credits/actions.test.ts` (each action writes the right entry, event and audit row with old/new value; same `clientKey` twice writes once; stale `version` → conflict; adjustment without reason → validation).
- **Done**: base checks; suites green; `pnpm build` renders the admin routes.

### credits-P7 (V1): customer portal and V1 end-to-end
- **Goal**: portal pages and customer actions; e2e proof of the V1 flow.
- **Files**: edit `apps/web/modules/credits/{actions,queries}.ts`; create `apps/web/modules/credits/ui/{credits-summary-card,package-card,usage-history,membership-card,cancel-membership-dialog}.tsx`; create routes `apps/web/app/[locale]/(portal)/account/packages/{page,loading,error}.tsx`, `.../account/packages/[grantId]/page.tsx`, `.../account/membership/{page,loading,error}.tsx`; edit the three `credits.json` (`credits.units.*`, `credits.portal.*`, `credits.labels.*`); create `e2e/credits.spec.ts`.
- **Exposes**: actions `cancelMyMembership`, `resumeMyMembership`, `payMyRenewal`; queries `getMyPackages`, `getMyPackage`, `getMyMembership`; component `CreditsSummaryCard`.
- **Depends on**: P6; `commerce:startOrderPayment`; `booking` portal booking flow for the e2e.
- **Tests**: `apps/web/modules/credits/portal.test.ts` (customer sees only own and shared grants; foreign grant → not_found; guest shown as first name + initial; wording never contains "credit" in any locale: scan rendered strings of `credits.units.*` and `credits.portal.*`); `e2e/credits.spec.ts` on `beam_dev`: buy a 10-session package with the fake Mollie adapter → "10 sessions remaining"; book a day session → 9; cancel inside the window → 10; staff adjusts −1 with reason → portal 9 and audit row visible; buy a monthly membership → member price shown at checkout and "Member" badge; cancel at period end shows end date.
- **Done**: base checks; suites green; e2e green against `beam_dev` via `neon-ws`.

### credits-P8 (R2): guest and package-sharing controls
- **Goal**: named sharing, per-grant sharing settings, review list, portal sharing.
- **Files**: edit `packages/db/src/schema/credits.ts` (add `credit_sharing_reviews` and its enums), `packages/db/src/schema/credits.views.ts` (add `v_sharing_review`); create `apps/web/modules/credits/server/sharing.ts`, `apps/web/modules/credits/server/sharing.test.ts`; edit `apps/web/modules/credits/{api,actions,queries,events,privacy}.ts` and `server/ledger.ts` (shared-grant candidates in `consumeCredits`/`checkCredits`); create `apps/web/modules/credits/ui/{sharing-panel,sharing-review-table,share-invite-form}.tsx`, route `apps/web/app/(admin)/admin/credits/sharing-review/page.tsx`; edit `apps/web/app/[locale]/(portal)/account/packages/[grantId]/page.tsx` and `.../packages/page.tsx` (shared-with-me); create `packages/email/src/templates/credits/share-invitation.tsx`; edit the three `credits.json`.
- **Exposes**: actions `updateGrantSharing`, `addPackageShare`, `addMyPackageShare`, `revokePackageShare`, `revokeMyPackageShare`, `reviewSharing`; query `listSharingReview`, `getMyShares`; `countSharingReviewItems`.
- **Depends on**: P7; `crm:findOrCreatePersonByEmail`; `email:sendTransactional`.
- **Tests**: named sharee can book on own account within `max_units`; owner's own grants used before shared; revoked share stops use, keeps history; max 5 shares per grant from portal; cache `allowed_person_ids` equals active shares; review view shows 4 distinct guests in 30 days and a guest on 3 owners, hides after review until a new guest; `sharing_disabled` sets mode none; permission cases added to `permissions.test.ts`.
- **Done**: base checks; suites green; orchestrator generates the R2 migration.

### credits-P9 (R3): referral and partner management
- **Goal**: codes, attribution, rewards, commissions, partner performance.
- **Files**: edit `packages/db/src/schema/credits.ts` (add `referral_codes`, `referral_attributions`, `partner_commissions`, their enums, nullable `credit_grants.referral_attribution_id`), `credits.views.ts` (add `v_partner_performance`); create `packages/core/src/credits/referrals.ts` and `referrals.test.ts`; create `apps/web/modules/credits/server/referrals.ts`, `server/referrals.test.ts`; edit `apps/web/modules/credits/{api,actions,queries,events,jobs,schedules,permissions,nav,privacy}.ts` (in `api.ts`, `fulfilOrderLines` gains first-paid-order and commission accrual); create `apps/web/modules/credits/ui/{referral-tabs,partner-figures,my-referral-card}.tsx`; routes `apps/web/app/(admin)/admin/referrals/page.tsx`, `apps/web/app/(admin)/admin/partner/page.tsx`, `apps/web/app/[locale]/(portal)/account/referrals/page.tsx`; create `packages/email/src/templates/credits/referral-reward.tsx`; edit the three `credits.json`.
- **Exposes**: permission `referrals.manage`; actions of section 4 marked R3; `resolveReferralCode`; jobs `referrals.attribute_new`, `referrals.qualify_rewards` and their schedules; view `v_partner_performance`.
- **Depends on**: P8; `crm:companies` (`is_partner`, `partner_commission_pct`), `crm:persons.acquisition.referral_code`; `commerce:orders, refunds`; `platform:settings` key `referrals`.
- **Tests**: code format and uniqueness; self-referral rejected; already-customer rejected; reward after 14 days only if not refunded, once (double-run); yearly cap of 10; commission accrual and negative on refund, stops after 12 months; partner user sees only own aggregates; erasure deletes codes and attributions and nulls commission links.
- **Done**: base checks; suites green.

### credits-P10 (R4): repurchase indicators
- **Goal**: data for `ops` churn and repurchase indicators and custom dashboards.
- **Files**: edit `packages/db/src/schema/credits.views.ts` (add `v_package_cycles`); edit `apps/web/modules/credits/{api,queries}.ts` (`listPackageCycles(db, { from, to })`); create `apps/web/modules/credits/package-cycles.test.ts`.
- **Exposes**: `listPackageCycles(db: DbOrTx, input: { from: Date; to: Date }): Promise<{ personId: string; grantId: string; closedAt: Date; repurchased: boolean; daysToRepurchase: number | null }[]>`; view `v_package_cycles` exposed to the `ai` schema as non-sensitive.
- **Depends on**: P9.
- **Tests**: exhausted and expired grants appear; repurchase of the same kind counts, a different kind does not; open grants excluded.
- **Done**: base checks; suite green.

## 13. Decisions made

**Additions to the architecture**
1. Tables added: `membership_plan_inclusions` (blueprint 12 needs included sessions and nights on one plan; the product's primary inclusion stays the first one), `membership_periods` APPEND (membership history), `credit_sharing_reviews` (R2 review decisions), `credit_reconciliation_runs` (reconcile results on a screen, not only in Slack), R3 `referral_codes`, `referral_attributions`, `partner_commissions`.
2. Columns added to `credit_grants`: `membership_id`, `referral_attribution_id` (R3), `vat_rate_pct`, `vat_treatment`, `validity_rule`, `status_changed_at`, `label`, `note`, `data`, `created_by_user_id`, `updated_at`. Enum value `transfer` added to `credit_grants_source`.
3. Columns added to `credit_entries`: `reverses_entry_id` (explicit link from release to consume, one release per consume).
4. Columns added to `memberships`: `interval`, `source`, `cancel_requested_at`, `ended_at`, `end_reason`, `renewal_order_id`, `next_charge_at`, `dunning_attempt`, `past_due_since_at`, `notes`, `version`, `updated_at`; `package_shares` gains `created_by_person_id`, `revoked_at`, `revoked_reason`, `updated_at`.
5. Views added: `v_credit_liability`, `v_euro_voucher_redemptions`, `v_sharing_review` (R2), `v_partner_performance` (R3), `v_package_cycles` (R4).
6. Permission added: `referrals.manage` (R3) for owner, technical_admin, management, finance and sales. The platform role seed gets this through an orchestrator request in credits-P9's PR.
7. Schedules added (R3): `referrals.attribute_new` every 10 minutes, `referrals.qualify_rewards` 05:10. Expiry warnings are folded into `credits.expire_grants` instead of a new schedule.
8. Expiry idempotency key extended to `expire:<grant_id>:<expires_at date>` (the architecture's `expire:<grant_id>` plus a date) so a grant that is extended and expires again can expire a second time.
9. `CREDITS_APPEND_ONLY = ['credit_entries', 'membership_periods']` is exported from `credits.ts`; because `_shared.ts` and the append-only migration are frozen, the orchestrator adds `membership_periods` to the trigger list in the wave's custom migration (requested in credits-P1's PR).
10. Requests to other modules: commerce adds `voucher` to `payments_provider` and the functions `createRenewalOrder`, `chargeMandate`, `createPaymentLinkForOrder`, `startOrderPayment`, `cancelOrder`; crm stores `acquisition.referral_code` (R3) and calls `onPersonsMerged`; platform adds settings key `referrals` (R3).

**Release placement**
11. V1 includes guest use on the owner's grant with the product's monthly limit, because day booking "for additional guests" is V1 (blueprint 7). The R2 item "guest and package-sharing controls" is named sharing, per-grant staff control, the review list and the portal sharing page.
12. Referral and partner management is R3 (proposal), although the blueprint lists referral rewards under credits; the `referral` grant source exists from V1 so staff can grant referral rewards manually before R3.
13. R4 contributes only `v_package_cycles`; churn and repurchase logic belongs to `ops`.

**Ledger**
14. One grant per order line; `units_granted = credit_units × quantity`.
15. Euro vouchers count units in cents with `unit_value_cents = 1`; they are redeemed only at checkout, never by bookings.
16. Validity is checked at the session start, not at booking time; a release to an expired grant is immediately re-expired.
17. Expiry is end of day Europe/Brussels; null `validity_days` means no expiry.
18. Locks are taken in ascending grant id; allocation order is computed in memory after locking.
19. Thresholds use `base_units` (`data.original_units` for imports, else `units_granted`); positive adjustments do not change the base. Thresholds fire only for purchased, imported and transferred grants. `last_unit` = one unit left; `credits.grant_exhausted` = zero left.
20. Extension of an expired grant is allowed up to 365 days after expiry and reinstates the expired units with an `adjust` entry.
21. Staff forms send a `clientKey` uuid used in idempotency keys of manual writes.
22. Imports create grants with the remaining legacy balance and keep the original size in `data.original_units`.
23. Merges move grants and memberships to the winner; ledger rows keep their historical `person_id`.
24. `ledger.reconcile` corrects grant status drift but never quantities.

**Customer and staff visibility**
25. The unit noun comes from the catalogue ("sessions", "nights"); the word "credits" appears nowhere in portal strings and a test enforces it. BEAM changes wording through the catalogue.
26. Owners see guests as first name and last initial; staff see full names.
27. Adjustment reasons are staff-only; the customer sees "Adjusted by BEAM".

**Sharing**
28. Guest uses count per Brussels calendar month and per grant; named uses count against `max_units` only. Max 5 active named shares per grant from the portal; staff are not limited.
29. `sharing.allowed_person_ids` is a cache of active `package_shares`, written in the same transaction and checked by reconcile.
30. A second abuse rule (`guest_hopping`: one guest on 3 or more owners' grants in 30 days) complements the required "more than 3 distinct guests in 30 days".

**Memberships**
31. Included credits do not roll over: they expire at the period end, carry `unit_value_cents = 0` and `vat_treatment = not_applicable`, and cannot be shared.
32. Dunning: first charge at period end − 3 days (day 0); retries on day 3 and day 7; expiry on day 10; a reminder email at each failure and the expiry email on day 10. `past_due` keeps member benefits (grace), but the new period's inclusions wait for payment.
33. Renewal price is the plan's `public` price version valid when the renewal order is created.
34. Memberships without a valid mandate get the renewal order and payment link 7 days before period end and follow the same dunning dates.
35. Reminders: 30 and 7 days for yearly plans; for monthly plans 7 days only when there is no valid mandate or `cancel_at` is set.
36. A plan change is cancel-at-period-end plus a new purchase starting `pending` on the old end date.
37. A late payment after expiry reactivates with a new period from the payment date and creates a customer service task.
38. Member pricing and member-only access use the real membership (`is_member`); the manual status override changes only classification.
39. `v_person_status` counts a person as customer after a paid order above € 0, a purchased or imported grant, or any non-pending membership; bonus, manual and referral grants do not make a customer.

**Privacy and VAT**
40. Erasure forfeits remaining balances (`revoke`, reason `erased`) and retains purchase-backed grants, entries, memberships and periods for 7 years against the anonymised person; bonus, manual and referral grants are deleted.
41. A membership plan that includes both day and night units is allowed, with an admin warning to confirm VAT with the accountant; the membership fee carries the product's single VAT rate.
42. Euro vouchers are multi-purpose vouchers sold at 0 % VAT; every redemption is listed in `v_euro_voucher_redemptions` for the accountant.

**Referrals (R3)**
43. Attribution is first-touch and written once per referred person; rewards are granted 14 days after the first paid order if it has not been refunded, capped at 10 per referrer per year; the default reward is 1 day session valid 180 days, with no referee reward.
44. Partner commission is computed on the order total excluding VAT, at the company rate snapshot, for 12 months after attribution; refunds create negative rows; finance approves and marks payouts by hand (no automated payouts).
