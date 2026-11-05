-- R4 (platform-P10, PL-23b, cross-module decision 46): the read-only role and schema of the
-- AI SQL runner `runAiReadOnlyQuery` (apps/web/modules/platform/ai-sql.ts).
--
-- This file creates only the role and the schema. It defines no view: every `ai.*` view
-- (including `ai.webinar_performance_daily`) is ops' `0101_ai_views_ops.sql`, applied after
-- this file, which also grants `select` on each view to `beam_ai_ro`. The role gets no grant
-- on any `public` table or view, so a statement that slips past the guards is refused by
-- Postgres. The runner switches to it with `set local role beam_ai_ro` inside a read-only
-- transaction on the normal pooled connection; the role cannot log in.
--
-- Idempotent: `applyCustomSql` and the custom migration may both run it.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'beam_ai_ro') then
    create role beam_ai_ro nologin noinherit nocreatedb nocreaterole;
  end if;
end
$$;

-- The application role must be a member to `set role` to it.
grant beam_ai_ro to current_user;

create schema if not exists ai;
grant usage on schema ai to beam_ai_ro;

-- The role reads only what ops grants it in `ai`; nothing it could create or run elsewhere.
revoke create on schema ai from beam_ai_ro;
revoke all on all tables in schema public from beam_ai_ro;

-- R4 (ops-P10, ops spec 2.4 and rule 77, cross-module decision 46): every view of the `ai`
-- schema that natural-language questions read as `beam_ai_ro` through platform's
-- `runAiReadOnlyQuery`, applied after platform's `0100_ai_readonly.sql` (role and schema).
--
-- Rules for every view here:
-- - nothing exposes email, phone, last name, address, notes, form answers or any
--   `SENSITIVE_COLUMNS` member; `first_name` (in `AI_ALLOWED_FIELDS`) is the only name field;
-- - tester persons are left out; a person who is erased, merged or under a processing
--   restriction keeps only aggregate value: their `person_id` reads as null (decision 66);
-- - enum columns are cast to text, so the role needs no privilege on a `public` type;
-- - the column list of each view is what `packages/core/src/ops/ai-schema-doc.ts` describes.
--
-- Idempotent (`applyCustomSql` and the custom migration may both run it): the schema and the
-- role are created only when missing (forms' Drizzle migration may create schema `ai` first, for
-- `ai.form_funnel_daily` and `ai.form_outcomes`), and each view is `create or replace`.

create schema if not exists ai;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'beam_ai_ro') then
    create role beam_ai_ro nologin noinherit nocreatedb nocreaterole;
  end if;
end
$$;

grant usage on schema ai to beam_ai_ro;

-- ai.customers: one row per active, non-tester person (`v_person_profile` already leaves out
-- erased, merged and restricted people) with the first name and the rule-76 indicators.
create or replace view ai.customers as
select pp.person_id, p.first_name, pp.locale::text as locale, pp.status::text as status, pp.is_member,
       pp.b2c_stage::text as b2c_stage, pp.acquisition_source, pp.acquisition_campaign, pp.tags, pp.created_at,
       pp.visits, pp.purchases, pp.revenue_cents, pp.avg_order_cents, pp.lifetime_value_cents, pp.is_high_value,
       pp.events_attended, pp.no_shows, pp.first_visit_at, pp.last_visit_at, pp.first_purchase_at, pp.last_purchase_at,
       pp.last_activity_at, pp.days_since_activity, pp.next_booking_at, pp.has_future_booking,
       pp.credits_day_remaining, pp.credits_night_remaining, pp.credits_euro_remaining, pp.next_grant_expires_at,
       pp.membership_status::text as membership_status, pp.membership_period_end_at,
       ps.predicted_value_cents, ps.churn_probability::float8 as churn_probability,
       ps.repurchase_probability::float8 as repurchase_probability
from public.v_person_profile pp
join public.persons p on p.id = pp.person_id
left join public.person_stats ps on ps.person_id = pp.person_id
where pp.is_tester = false;

-- ai.products: the catalogue (no person data).
create or replace view ai.products as
select pr.id as product_id, pr.sku, pr.kind::text as kind, coalesce(pr.name->>'en', pr.name->>'nl-BE') as name_en,
       pr.credit_kind::text as credit_kind, pr.credit_units, pr.validity_days,
       pr.recurring_interval::text as recurring_interval, pr.is_active
from public.products pr;

-- ai.orders: every order of a non-tester (company orders included).
create or replace view ai.orders as
select o.id as order_id,
       case when pe.id is null or (pe.erased_at is null and pe.merged_into_person_id is null and pe.processing_restricted_at is null)
            then o.person_id end as person_id,
       o.company_id, o.channel::text as channel, o.status::text as status, o.created_at, o.paid_at,
       o.subtotal_cents, o.discount_cents, o.vat_cents, o.total_cents
from public.orders o
left join public.persons pe on pe.id = o.person_id
where coalesce(pe.is_tester, false) = false;

-- ai.order_lines: the lines of those orders.
create or replace view ai.order_lines as
select ol.order_id, ol.line_no, ol.product_id, ol.product_kind::text as product_kind, ol.sku as product_sku,
       coalesce(pr.name->>'en', pr.name->>'nl-BE') as product_name_en, ol.quantity, ol.unit_amount_cents,
       ol.discount_cents, ol.line_total_cents, ol.vat_rate_pct::float8 as vat_rate_pct, ol.vat_cents
from public.order_lines ol
join public.orders o on o.id = ol.order_id
left join public.products pr on pr.id = ol.product_id
left join public.persons pe on pe.id = o.person_id
where coalesce(pe.is_tester, false) = false;

-- ai.revenue: `v_revenue_daily` (sales per Brussels day, channel and product kind; refunds as
-- product kind `refund`; testers already left out).
create or replace view ai.revenue as
select r.day_on, r.channel::text as channel, r.product_kind, r.orders, r.gross_cents, r.vat_cents,
       r.refunds_cents, r.refunds_vat_cents
from public.v_revenue_daily r;

-- ai.bookings: bookings of non-testers (guests' bookings included).
create or replace view ai.bookings as
select b.id as booking_id,
       case when pe.erased_at is null and pe.merged_into_person_id is null and pe.processing_restricted_at is null
            then b.person_id end as person_id,
       b.session_id, s.kind::text as session_kind, s.starts_at, b.status::text as status, b.paid_with::text as paid_with,
       b.source::text as source, b.created_at as booked_at, b.cancelled_at, b.attended_at,
       (b.guest_of_booking_id is not null) as is_guest
from public.bookings b
join public.sessions s on s.id = b.session_id
join public.persons pe on pe.id = b.person_id
where pe.is_tester = false;

-- ai.grants: credit grants with their balance (`v_credit_grant_balances`).
create or replace view ai.grants as
select g.grant_id,
       case when pe.erased_at is null and pe.merged_into_person_id is null and pe.processing_restricted_at is null
            then g.person_id end as person_id,
       g.product_id, pr.sku as product_sku, g.credit_kind::text as credit_kind, g.source::text as source,
       g.status::text as status, g.starts_at, g.expires_at, g.base_units, g.remaining_units, g.used_units,
       g.expired_units, g.last_used_at
from public.v_credit_grant_balances g
join public.persons pe on pe.id = g.person_id
left join public.products pr on pr.id = g.product_id
where pe.is_tester = false;

-- ai.package_cycles: credits' `v_package_cycles` (credits-P10 request): one row per closed
-- purchased grant, and whether and when the person bought again.
create or replace view ai.package_cycles as
select c.grant_id,
       case when pe.erased_at is null and pe.merged_into_person_id is null and pe.processing_restricted_at is null
            then c.person_id end as person_id,
       c.product_id, pr.sku as product_sku, c.credit_kind::text as credit_kind, c.closed_at, c.next_purchase_at,
       c.days_to_repurchase, c.repurchased
from public.v_package_cycles c
join public.persons pe on pe.id = c.person_id
left join public.products pr on pr.id = c.product_id
where pe.is_tester = false;

-- ai.memberships.
create or replace view ai.memberships as
select m.id as membership_id,
       case when pe.erased_at is null and pe.merged_into_person_id is null and pe.processing_restricted_at is null
            then m.person_id end as person_id,
       m.product_id, pr.sku as product_sku, m.status::text as status, m.interval::text as interval,
       m.source::text as source, m.started_at, m.current_period_start_at, m.current_period_end_at, m.cancel_at,
       m.ended_at, m.end_reason::text as end_reason, m.past_due_since_at
from public.memberships m
join public.persons pe on pe.id = m.person_id
left join public.products pr on pr.id = m.product_id
where pe.is_tester = false;

-- ai.retention_candidates: `v_retention_candidates` (DPIA `ai_customer_ranking` gates questions
-- that read it, `validateAiSql`).
create or replace view ai.retention_candidates as
select rc.person_id, rc.reason, rc.score, rc.ref_type, rc.ref_id, rc.detail
from public.v_retention_candidates rc;

-- ai.campaign_attribution: ops' `attribution_credits` (first-touch and linear credits per order).
create or replace view ai.campaign_attribution as
select ac.order_id,
       case when pe.erased_at is null and pe.merged_into_person_id is null and pe.processing_restricted_at is null
            then ac.person_id end as person_id,
       ac.model::text as model, ac.campaign_key, ac.source, ac.medium, ac.campaign, ac.weight::float8 as weight,
       ac.revenue_cents, ac.paid_at
from public.attribution_credits ac
join public.persons pe on pe.id = ac.person_id
where pe.is_tester = false;

-- ai.ad_spend_daily: the pulled Meta and Google Ads figures (no account ids, no raw payload).
create or replace view ai.ad_spend_daily as
select a.platform::text as platform, a.campaign_external_id, a.campaign_name, a.day_on, a.spend_cents,
       a.impressions, a.clicks, a.leads
from public.ad_spend_daily a;

-- ai.opportunities: B2B opportunities with the company name (no contact person, notes or titles).
create or replace view ai.opportunities as
select o.id as opportunity_id, o.company_id, c.name as company_name, c.status::text as company_status,
       o.stage::text as stage, o.stage_entered_at, o.value_cents, o.probability_pct, o.expected_close_on,
       o.next_action_at, o.won_at, o.lost_at, o.created_at, o.updated_at
from public.opportunities o
join public.companies c on c.id = o.company_id;

-- ai.webinar_performance_daily: webinar's `v_webinar_performance_daily` (webinar-P8).
create or replace view ai.webinar_performance_daily as
select * from public.v_webinar_performance_daily;

-- finance's `FINANCE_AI_VIEWS` (finance-P10): aggregates per day or month, no person columns.
create or replace view ai.finance_revenue_daily as
select * from public.v_finance_revenue_daily;

create or replace view ai.finance_vat_summary as
select * from public.v_finance_vat_summary;

create or replace view ai.finance_failed_payments as
select * from public.v_finance_failed_payments;

create or replace view ai.finance_recurring_monthly as
select * from public.v_finance_recurring_monthly;

-- The role reads every view of `ai` (ops' above and forms' `ai.form_funnel_daily` and
-- `ai.form_outcomes`), and nothing else.
grant select on all tables in schema ai to beam_ai_ro;
revoke create on schema ai from beam_ai_ro;
revoke all on all tables in schema public from beam_ai_ro;
