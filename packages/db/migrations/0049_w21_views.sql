create or replace view v_form_campaign_attribution as
with s as (
  select nullif(lower(trim(fs.utm->>'campaign')), '') as utm_campaign, (fs.completed_at at time zone 'Europe/Brussels')::date as day_on,
         count(*)::int as completions, count(distinct fs.person_id)::int as leads
  from form_submissions fs where fs.status = 'completed' and fs.completed_at is not null
  group by 1, 2),
cv as (
  select nullif(lower(trim(fs.utm->>'campaign')), '') as utm_campaign, (v.completed_at at time zone 'Europe/Brussels')::date as day_on,
         count(*) filter (where v.first_booking_at is not null)::int as bookings,
         coalesce(sum(v.revenue_30d_cents), 0)::bigint as revenue_30d_cents
  from v_form_conversions v join form_submissions fs on fs.id = v.submission_id
  group by 1, 2),
k as (select distinct utm_campaign from s where utm_campaign is not null),
a as (
  select k.utm_campaign, a.day_on, sum(a.spend_cents)::bigint as spend_cents
  from ad_spend_daily a
  join k on k.utm_campaign = lower(trim(a.campaign_external_id))
    or (k.utm_campaign = lower(trim(a.campaign_name))
        and not exists (select 1 from k k2 where k2.utm_campaign = lower(trim(a.campaign_external_id))))
  group by 1, 2),
d as (select utm_campaign, day_on from s union select utm_campaign, day_on from a)
select d.utm_campaign, d.day_on, coalesce(s.leads, 0) as leads, coalesce(s.completions, 0) as completions,
       coalesce(cv.bookings, 0) as bookings, coalesce(cv.revenue_30d_cents, 0)::bigint as revenue_30d_cents,
       coalesce(a.spend_cents, 0)::bigint as spend_cents,
       case when coalesce(s.leads, 0) > 0 and a.spend_cents is not null then round(a.spend_cents::numeric / s.leads)::bigint end as cost_per_lead_cents
from d
left join s on s.utm_campaign is not distinct from d.utm_campaign and s.day_on = d.day_on
left join cv on cv.utm_campaign is not distinct from d.utm_campaign and cv.day_on = d.day_on
left join a on a.utm_campaign is not distinct from d.utm_campaign and a.day_on = d.day_on;
--> statement-breakpoint
create or replace view v_form_kpis_daily as
with l as (
  select (case when p.acquisition->>'captured_at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' then (p.acquisition->>'captured_at')::timestamptz end at time zone 'Europe/Brussels')::date as day_on, count(*)::int as leads
  from persons p
  where p.merged_into_person_id is null and p.is_tester = false and jsonb_typeof(p.acquisition) = 'object'
    and coalesce(p.acquisition->>'form_slug', '') <> '' and case when p.acquisition->>'captured_at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' then (p.acquisition->>'captured_at')::timestamptz end is not null
    and not exists (select 1 from activity_events e where e.person_id = p.id and e.kind = 'person.acquisition_filled')
  group by 1),
c as (
  select (fs.completed_at at time zone 'Europe/Brussels')::date as day_on, count(*)::int as completions
  from form_submissions fs where fs.status = 'completed' and fs.completed_at is not null group by 1),
k as (
  select (e.occurred_at at time zone 'Europe/Brussels')::date as day_on, count(*)::int as cta_clicks
  from activity_events e where e.kind = 'assessment.cta_clicked' group by 1),
v as (
  select (v.completed_at at time zone 'Europe/Brussels')::date as day_on,
         count(*) filter (where v.first_booking_at is not null or v.first_paid_at is not null)::int as conversions,
         count(*) filter (where v.first_booking_at is not null)::int as bookings,
         count(*) filter (where v.first_paid_at is not null)::int as purchases,
         coalesce(sum(v.revenue_30d_cents), 0)::bigint as revenue_30d_cents
  from v_form_conversions v group by 1),
d as (select day_on from l union select day_on from c union select day_on from k union select day_on from v)
select d.day_on, coalesce(l.leads, 0) as leads, coalesce(c.completions, 0) as completions,
       coalesce(k.cta_clicks, 0) as cta_clicks, coalesce(v.conversions, 0) as conversions,
       coalesce(v.bookings, 0) as bookings, coalesce(v.purchases, 0) as purchases,
       coalesce(v.revenue_30d_cents, 0)::bigint as revenue_30d_cents
from d left join l on l.day_on = d.day_on left join c on c.day_on = d.day_on
  left join k on k.day_on = d.day_on left join v on v.day_on = d.day_on;
--> statement-breakpoint
create or replace view v_lightspeed_daily as
select business_day_on, category,
  sum(total_cents)::int as total_cents, sum(vat_cents)::int as vat_cents,
  count(distinct receipt_number)::int as receipts, count(*)::int as lines
from lightspeed_sales
group by business_day_on, category;
--> statement-breakpoint
create or replace view v_sales_lines as
select ol.id as order_line_id, o.id as order_id, o.paid_at,
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
  and coalesce(pe.is_tester, false) = false;
