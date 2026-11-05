create or replace view v_finance_cash_inflow_daily as
select (p.paid_at at time zone 'Europe/Brussels')::date as day, p.provider::text as provider, p.method,
  sum(p.amount_cents)::int as inflow_cents, 0 as outflow_cents, count(*)::int as movement_count
from payments p
where p.status in ('paid', 'refunded', 'partially_refunded') and p.paid_at is not null and p.provider <> 'credit_balance'
group by 1, 2, 3
union all
select (i.paid_at at time zone 'Europe/Brussels')::date as day, i.payment_provider as provider, i.payment_method as method,
  0 as inflow_cents, sum(-i.total_cents)::int as outflow_cents, count(*)::int as movement_count
from invoices i
where i.kind = 'credit_note' and i.status = 'paid' and i.paid_at is not null
group by 1, 2, 3;
--> statement-breakpoint
create or replace view v_finance_failed_payments as
select (coalesce(
    (select max((e ->> 'at')::timestamptz) from jsonb_array_elements(p.status_history) e where e ->> 'status' = p.status::text),
    p.updated_at) at time zone 'Europe/Brussels')::date as day,
  p.provider::text as provider, p.method,
  count(*)::int as failed_count,
  sum(p.amount_cents)::int as amount_cents,
  (select count(*) from memberships m where m.status = 'past_due')::int as past_due_memberships
from payments p
where p.status in ('failed', 'expired')
group by 1, 2, 3;
--> statement-breakpoint
create or replace view v_finance_recurring_monthly as
select date_trunc('month', i.issued_on)::date as month,
  (count(*) filter (where i.kind = 'invoice'))::int as invoice_count,
  sum(i.subtotal_cents)::int as net_cents,
  sum(i.total_cents)::int as gross_cents,
  (select count(*) from memberships m where m.status = 'active')::int as active_memberships
from invoices i
join orders o on o.id = i.order_id
where o.channel = 'recurring'
group by 1;
--> statement-breakpoint
create or replace view v_finance_revenue_daily as
select i.issued_on as day, i.kind, l.category,
  coalesce(i.payment_method, r.payment_method) as payment_method, l.vat_rate_pct,
  sum(l.net_cents)::int as net_cents,
  sum(l.vat_cents)::int as vat_cents,
  sum(l.line_total_cents)::int as gross_cents,
  count(distinct i.id)::int as document_count
from invoices i
left join invoices r on r.id = i.reverses_invoice_id
cross join lateral jsonb_to_recordset(i.lines) as l(category text, vat_rate_pct numeric, vat_cents int, net_cents int, line_total_cents int)
group by i.issued_on, i.kind, l.category, coalesce(i.payment_method, r.payment_method), l.vat_rate_pct;
--> statement-breakpoint
create or replace view v_opportunity_board as
select o.id, o.company_id, c.name as company_name, o.title, o.primary_contact_person_id,
       o.stage, o.stage_entered_at, o.value_cents, o.probability_pct, o.expected_close_on, o.owner_user_id,
       coalesce(u.name, u.email) as owner_name, o.next_action, o.next_action_at, o.won_at, o.lost_at, o.version,
       o.created_at, o.updated_at,
       lc.last_contact_at,
       o.stage_entered_at + make_interval(days => ps.deadline_days) as stage_deadline_at,
       coalesce(o.stage not in ('won', 'lost') and now() > o.stage_entered_at + make_interval(days => ps.deadline_days), false) as is_stalled
from opportunities o
join companies c on c.id = o.company_id
left join users u on u.id = o.owner_user_id
left join playbook_stages ps on ps.pipeline = 'b2b' and ps.stage_key = o.stage::text and ps.is_active
left join lateral (
  select max(e.occurred_at) as last_contact_at from activity_events e
  where (e.company_id = o.company_id or (o.primary_contact_person_id is not null and e.person_id = o.primary_contact_person_id))
    and e.kind in ('interaction.logged', 'email.sent', 'inbox.message_received', 'inbox.reply_sent', 'opportunity.stage_changed')
) lc on true;
--> statement-breakpoint
create or replace view v_partner_performance as
with a as (
  select id, partner_company_id, referred_person_id, attributed_at, first_paid_at, commission_until_at
  from referral_attributions where partner_company_id is not null and status <> 'rejected'),
windowed as (
  select a.partner_company_id, o.id as order_id, o.total_cents, o.paid_at
  from a join orders o on o.person_id = a.referred_person_id
  where o.paid_at is not null and o.paid_at >= a.attributed_at
    and (a.commission_until_at is null or o.paid_at < a.commission_until_at)),
facts as (
  select partner_company_id, date_trunc('month', attributed_at at time zone 'Europe/Brussels')::date as period_month,
         1 as referred, 0 as customers, 0::bigint as revenue, 0::bigint as accrued, 0::bigint as paid
  from a
  union all
  select partner_company_id, date_trunc('month', first_paid_at at time zone 'Europe/Brussels')::date, 0, 1, 0::bigint, 0::bigint, 0::bigint
  from a where first_paid_at is not null
  union all
  select partner_company_id, date_trunc('month', paid_at at time zone 'Europe/Brussels')::date, 0, 0, total_cents::bigint, 0::bigint, 0::bigint
  from windowed
  union all
  select w.partner_company_id, date_trunc('month', r.created_at at time zone 'Europe/Brussels')::date, 0, 0, (-r.amount_cents)::bigint, 0::bigint, 0::bigint
  from windowed w join refunds r on r.order_id = w.order_id
  where r.status in ('sent', 'refunded')
  union all
  select partner_company_id, period_month, 0, 0, 0::bigint,
         case when status in ('accrued', 'approved') then amount_cents else 0 end::bigint,
         case when status = 'paid' then amount_cents else 0 end::bigint
  from partner_commissions)
select partner_company_id, period_month,
       sum(referred)::int as referred_count, sum(customers)::int as customers_count,
       sum(revenue)::bigint as revenue_cents, sum(accrued)::bigint as commission_accrued_cents,
       sum(paid)::bigint as commission_paid_cents
from facts group by partner_company_id, period_month;
--> statement-breakpoint
create or replace view v_person_profile as
select p.id as person_id, p.locale, p.created_at, p.is_tester, p.partner_company_id,
       p.acquisition->>'source' as acquisition_source,
       p.acquisition->>'campaign' as acquisition_campaign,
       p.acquisition->>'medium' as acquisition_medium,
       p.address->>'postal_code' as postal_code, p.address->>'city' as city, p.address->>'country' as country,
       coalesce(st.status, 'lead') as status,
       coalesce(st.is_member, false) as is_member,
       coalesce(tg.keys, '{}'::text[]) as tags,
       coalesce(ps.revenue_cents, 0) as revenue_cents,
       coalesce(ps.purchases, 0) as purchases,
       coalesce(ps.visits, 0) as visits,
       coalesce(ps.events_attended, 0) as events_attended,
       coalesce(ps.no_shows, 0) as no_shows,
       coalesce(ps.avg_order_cents, 0) as avg_order_cents,
       ps.first_purchase_at, ps.last_purchase_at, ps.first_visit_at, ps.last_visit_at, ps.last_activity_at,
       nb.next_booking_at,
       (nb.next_booking_at is not null) as has_future_booking,
       coalesce(ps.b2c_stage, 'lead') as b2c_stage,
       case when ps.last_activity_at is null then null
            else greatest(0, floor(extract(epoch from (now() - ps.last_activity_at)) / 86400))::int end as days_since_activity,
       coalesce(ps.revenue_cents, 0) as lifetime_value_cents,
       (coalesce(ps.revenue_cents, 0) >= (c.cfg->>'high_value_revenue_cents')::int
          or coalesce(c.cfg->>'vip_tag_key' = any(tg.keys), false)) as is_high_value,
       coalesce(cr.day_remaining, 0) as credits_day_remaining,
       coalesce(cr.night_remaining, 0) as credits_night_remaining,
       coalesce(cr.euro_remaining, 0) as credits_euro_remaining,
       cr.next_expires_at as next_grant_expires_at,
       coalesce((select array_agg(distinct x order by x) from v_person_credits vc cross join lateral unnest(vc.product_ids) x
                 where vc.person_id = p.id and x is not null), '{}'::uuid[]) as package_product_ids,
       ms.status::text as membership_status,
       ms.current_period_end_at as membership_period_end_at,
       coalesce(cs.newsletter, false) as consent_newsletter,
       coalesce(cs.events, false) as consent_events,
       coalesce(cs.member_comms, false) as consent_member_comms,
       coalesce(cs.b2b, false) as consent_b2b,
       exists (select 1 from suppressions su where su.email_hash = p.email_hash and su.scope = 'all') as is_suppressed_all,
       exists (select 1 from company_contacts cc where cc.person_id = p.id and cc.ended_on is null) as is_company_contact,
       exists (select 1 from waitlist_entries w where w.person_id = p.id and w.state in ('waiting', 'offered')) as has_waitlist_waiting,
       la.slug as last_assessment_form_slug,
       la.outcome_key as last_assessment_outcome_key,
       coalesce(ws.imported_webinars_registered, 0) as imported_webinars_registered,
       coalesce(ws.imported_webinars_attended, 0) as imported_webinars_attended,
       coalesce(ws.webinars_registered, 0) as webinars_registered,
       coalesce(ws.webinars_attended_live, 0) as webinars_attended_live,
       ws.last_webinar_attended_at,
       coalesce(ws.replays_watched, 0) as webinars_watched_replay,
       coalesce(ws.on_demand_watched, 0) as webinars_watched_on_demand,
       coalesce(ws.poll_answers, 0) as webinar_poll_answers,
       coalesce(ws.cta_clicks, 0) as webinar_cta_clicks,
       (coalesce(ws.webinars_registered, 0) + coalesce(ws.imported_webinars_registered, 0))::int as webinars_registered_total,
       (coalesce(ws.webinars_attended_live, 0) + coalesce(ws.imported_webinars_attended, 0))::int as webinars_attended_total,
       case when exists (select 1 from dpia_records d where d.key = 'watch_time_profiling' and d.status in ('approved', 'not_required'))
            then coalesce(ws.watch_sec_total, 0) end as watch_sec_total
from persons p
cross join (select '{"visit_drop_ratio":0.5,"baseline_min_visits":3,"nearly_finished_pct":80,"expiry_days":30,"finished_no_repurchase_min_days":14,"finished_no_repurchase_max_days":120,"high_value_revenue_cents":100000,"vip_tag_key":"vip","high_value_inactive_days":60,"renewal_days":30,"never_booked_days":14,"unused_days":45,"weekly_list_size":25,"task_cooldown_days":14,"new_lead_followup_hours":48,"new_lead_window_days":14,"webinar_lead_window_days":14,"membership_expiring_days":14,"guest_abuse_distinct_guests":3,"guest_abuse_window_days":30,"stage_retention_days":90,"stage_lost_days":365,"stage_engaged_window_days":90,"no_show_pattern_count":3,"no_show_pattern_days":90,"dashboard_week_horizon_days":7}'::jsonb
    || coalesce((select s.value from settings s where s.key = 'retention_defaults' and jsonb_typeof(s.value) = 'object'), '{}'::jsonb) as cfg) c
left join v_person_status st on st.person_id = p.id
left join person_stats ps on ps.person_id = p.id
left join lateral (select array_agg(t.key order by t.key) as keys from person_tags pt join tags t on t.id = pt.tag_id
                   where pt.person_id = p.id) tg on true
left join lateral (select min(s.starts_at) as next_booking_at from bookings b join sessions s on s.id = b.session_id
                   where b.person_id = p.id and b.status in ('reserved', 'confirmed') and s.starts_at > now()) nb on true
left join lateral (select sum(vc.remaining_units) filter (where vc.credit_kind = 'day')::int as day_remaining,
                          sum(vc.remaining_units) filter (where vc.credit_kind = 'night')::int as night_remaining,
                          sum(vc.remaining_units) filter (where vc.credit_kind = 'euro')::int as euro_remaining,
                          min(vc.next_expires_at) as next_expires_at
                   from v_person_credits vc where vc.person_id = p.id) cr on true
left join lateral (select m.status, m.current_period_end_at from memberships m where m.person_id = p.id
                   order by m.started_at desc, m.created_at desc, m.id desc limit 1) ms on true
left join lateral (select bool_or(cc.status = 'granted') filter (where cc.purpose = 'newsletter') as newsletter,
                          bool_or(cc.status = 'granted') filter (where cc.purpose = 'events') as events,
                          bool_or(cc.status = 'granted') filter (where cc.purpose = 'member_comms') as member_comms,
                          bool_or(cc.status = 'granted') filter (where cc.purpose = 'b2b') as b2b
                   from v_consent_current cc where cc.person_id = p.id) cs on true
left join lateral (select f.slug, fs.outcome_key from form_submissions fs join forms f on f.id = fs.form_id
                   where fs.person_id = p.id and fs.status = 'completed' and f.kind = 'assessment'
                   order by fs.completed_at desc nulls last, fs.id desc limit 1) la on true
left join v_person_webinar_stats ws on ws.person_id = p.id
where p.erased_at is null and p.merged_into_person_id is null and p.processing_restricted_at is null;
