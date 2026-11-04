create or replace view v_abandoned_checkouts as
select c.id as checkout_id, c.person_id, c.email, c.status, c.created_at, c.abandoned_at, c.abandoned_reason,
       c.locale, c.utm,
       coalesce((select sum(case when jsonb_typeof(i->'quantity') = 'number' then (i->>'quantity')::int else 0 end)
                 from jsonb_array_elements(case when jsonb_typeof(c.items) = 'array' then c.items else '[]'::jsonb end) i), 0)::int as item_count,
       c.total_cents as value_cents,
       coalesce((select array_agg(distinct (i->>'productId')::uuid order by (i->>'productId')::uuid)
                 from jsonb_array_elements(case when jsonb_typeof(c.items) = 'array' then c.items else '[]'::jsonb end) i
                 where i->>'productId' ~ '^[0-9a-fA-F-]{36}$'), '{}'::uuid[]) as product_ids,
       coalesce(c.abandoned_reason in ('payment_failed', 'payment_expired'), false) as had_payment_failure,
       c.recovery_message_id, c.recovered_order_id,
       case when o.status in ('paid', 'partially_refunded', 'refunded') then o.total_cents end as recovered_revenue_cents,
       c.recovered_at
from checkouts c left join orders o on o.id = c.recovered_order_id
where c.abandoned_at is not null;
--> statement-breakpoint
create or replace view v_no_show_report as
select b.id as booking_id, b.person_id, b.session_id, s.template_id, s.kind as session_kind, s.starts_at,
       extract(isodow from (s.starts_at at time zone 'Europe/Brussels'))::int as weekday,
       extract(hour from (s.starts_at at time zone 'Europe/Brussels'))::int as hour,
       b.status, b.paid_with, b.cancelled_at, b.cancel_reason_code,
       (s.status = 'cancelled') as is_session_cancelled,
       case when b.cancelled_at is null then null
            else round((extract(epoch from (s.starts_at - b.cancelled_at)) / 3600)::numeric, 1) end as notice_hours,
       (case b.paid_with
          when 'credit' then coalesce(ce.consumed_value_cents, 0)
          when 'order' then coalesce(round(ol.line_total_cents::numeric / nullif(ol.quantity, 0)), 0)
          else 0 end)::int as value_cents,
       greatest(0, coalesce(ce.forfeited_units, 0))::int as credit_units_forfeited
from bookings b join sessions s on s.id = b.session_id
left join order_lines ol on ol.id = b.order_line_id
left join lateral (select coalesce(-sum(e.quantity * g.unit_value_cents) filter (where e.kind = 'consume'), 0) as consumed_value_cents,
                          coalesce(-sum(e.quantity), 0) as forfeited_units
                   from credit_entries e join credit_grants g on g.id = e.grant_id
                   where e.ref_type = 'booking' and e.ref_id = b.id and e.kind in ('consume', 'release')) ce on true
where b.status in ('cancelled', 'late_cancelled', 'no_show');
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
       coalesce(ih.webinars_registered, 0) as imported_webinars_registered,
       coalesce(ih.webinars_attended, 0) as imported_webinars_attended
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
left join lateral (select count(*) filter (where h.kind = 'webinar_registration')::int as webinars_registered,
                          count(*) filter (where h.kind = 'webinar_attendance')::int as webinars_attended
                   from imported_history h where h.person_id = p.id) ih on true
where p.erased_at is null and p.merged_into_person_id is null and p.processing_restricted_at is null;
--> statement-breakpoint
create or replace view v_retention_candidates as
with pp as (select * from v_person_profile where is_tester = false)
select pp.person_id, 'visiting_less'::text as reason,
       (30 + least(30, pp.revenue_cents / 20000) + least(20, coalesce(pp.days_since_activity, 0) / 10))::int as score, 'person'::text as ref_type, pp.person_id as ref_id,
       jsonb_build_object('visits_last_60d', ps.visits_last_60d, 'visits_prev_180d', ps.visits_prev_180d,
         'days_since_activity', pp.days_since_activity) as detail
from pp join person_stats ps on ps.person_id = pp.person_id cross join (select '{"visit_drop_ratio":0.5,"baseline_min_visits":3,"nearly_finished_pct":80,"expiry_days":30,"finished_no_repurchase_min_days":14,"finished_no_repurchase_max_days":120,"high_value_revenue_cents":100000,"vip_tag_key":"vip","high_value_inactive_days":60,"renewal_days":30,"never_booked_days":14,"unused_days":45,"weekly_list_size":25,"task_cooldown_days":14,"new_lead_followup_hours":48,"new_lead_window_days":14,"webinar_lead_window_days":14,"membership_expiring_days":14,"guest_abuse_distinct_guests":3,"guest_abuse_window_days":30,"stage_retention_days":90,"stage_lost_days":365,"stage_engaged_window_days":90,"no_show_pattern_count":3,"no_show_pattern_days":90,"dashboard_week_horizon_days":7}'::jsonb
    || coalesce((select s.value from settings s where s.key = 'retention_defaults' and jsonb_typeof(s.value) = 'object'), '{}'::jsonb) as cfg) c
where ps.visits_prev_180d >= (c.cfg->>'baseline_min_visits')::int
  and ps.visits_last_60d / 60.0 < (c.cfg->>'visit_drop_ratio')::numeric * ps.visits_prev_180d / 180.0
  and not pp.has_future_booking
union all
select pp.person_id, 'package_nearly_finished', (35 + least(30, pp.revenue_cents / 20000))::int, 'grant', b.grant_id, jsonb_build_object('grant_id', b.grant_id, 'remaining', b.remaining_units, 'units_granted', b.base_units,
         'expires_at', b.expires_at, 'product_name', coalesce(pr.name->>pp.locale::text, pr.name->>'en'))
from pp join v_credit_grant_balances b on b.person_id = pp.person_id left join products pr on pr.id = b.product_id cross join (select '{"visit_drop_ratio":0.5,"baseline_min_visits":3,"nearly_finished_pct":80,"expiry_days":30,"finished_no_repurchase_min_days":14,"finished_no_repurchase_max_days":120,"high_value_revenue_cents":100000,"vip_tag_key":"vip","high_value_inactive_days":60,"renewal_days":30,"never_booked_days":14,"unused_days":45,"weekly_list_size":25,"task_cooldown_days":14,"new_lead_followup_hours":48,"new_lead_window_days":14,"webinar_lead_window_days":14,"membership_expiring_days":14,"guest_abuse_distinct_guests":3,"guest_abuse_window_days":30,"stage_retention_days":90,"stage_lost_days":365,"stage_engaged_window_days":90,"no_show_pattern_count":3,"no_show_pattern_days":90,"dashboard_week_horizon_days":7}'::jsonb
    || coalesce((select s.value from settings s where s.key = 'retention_defaults' and jsonb_typeof(s.value) = 'object'), '{}'::jsonb) as cfg) c
where b.status = 'active' and b.base_units > 0 and b.remaining_units >= 1
  and (b.base_units - b.remaining_units) * 100 / b.base_units >= (c.cfg->>'nearly_finished_pct')::int
union all
select pp.person_id, 'package_finished_no_repurchase', (40 + least(30, pp.revenue_cents / 20000))::int, 'grant', b.grant_id, jsonb_build_object('grant_id', b.grant_id, 'remaining', b.remaining_units, 'units_granted', b.base_units,
         'expires_at', b.expires_at, 'product_name', coalesce(pr.name->>pp.locale::text, pr.name->>'en'))
from pp join v_credit_grant_balances b on b.person_id = pp.person_id left join products pr on pr.id = b.product_id cross join (select '{"visit_drop_ratio":0.5,"baseline_min_visits":3,"nearly_finished_pct":80,"expiry_days":30,"finished_no_repurchase_min_days":14,"finished_no_repurchase_max_days":120,"high_value_revenue_cents":100000,"vip_tag_key":"vip","high_value_inactive_days":60,"renewal_days":30,"never_booked_days":14,"unused_days":45,"weekly_list_size":25,"task_cooldown_days":14,"new_lead_followup_hours":48,"new_lead_window_days":14,"webinar_lead_window_days":14,"membership_expiring_days":14,"guest_abuse_distinct_guests":3,"guest_abuse_window_days":30,"stage_retention_days":90,"stage_lost_days":365,"stage_engaged_window_days":90,"no_show_pattern_count":3,"no_show_pattern_days":90,"dashboard_week_horizon_days":7}'::jsonb
    || coalesce((select s.value from settings s where s.key = 'retention_defaults' and jsonb_typeof(s.value) = 'object'), '{}'::jsonb) as cfg) c
where b.status = 'exhausted' and b.last_used_at is not null
  and b.last_used_at <= now() - make_interval(days => (c.cfg->>'finished_no_repurchase_min_days')::int)
  and b.last_used_at >= now() - make_interval(days => (c.cfg->>'finished_no_repurchase_max_days')::int)
  and not exists (select 1 from credit_grants g2 where g2.person_id = b.person_id and g2.credit_kind = b.credit_kind
                  and g2.id <> b.grant_id and g2.created_at > b.last_used_at)
  and not exists (select 1 from memberships m where m.person_id = pp.person_id and m.status in ('active', 'past_due'))
union all
select pp.person_id, 'package_expiring', (45 + least(30, pp.revenue_cents / 20000) + greatest(0, 20 - floor(extract(epoch from (b.expires_at - now())) / 86400)::int))::int, 'grant', b.grant_id, jsonb_build_object('grant_id', b.grant_id, 'remaining', b.remaining_units, 'units_granted', b.base_units,
         'expires_at', b.expires_at, 'product_name', coalesce(pr.name->>pp.locale::text, pr.name->>'en'))
from pp join v_credit_grant_balances b on b.person_id = pp.person_id left join products pr on pr.id = b.product_id cross join (select '{"visit_drop_ratio":0.5,"baseline_min_visits":3,"nearly_finished_pct":80,"expiry_days":30,"finished_no_repurchase_min_days":14,"finished_no_repurchase_max_days":120,"high_value_revenue_cents":100000,"vip_tag_key":"vip","high_value_inactive_days":60,"renewal_days":30,"never_booked_days":14,"unused_days":45,"weekly_list_size":25,"task_cooldown_days":14,"new_lead_followup_hours":48,"new_lead_window_days":14,"webinar_lead_window_days":14,"membership_expiring_days":14,"guest_abuse_distinct_guests":3,"guest_abuse_window_days":30,"stage_retention_days":90,"stage_lost_days":365,"stage_engaged_window_days":90,"no_show_pattern_count":3,"no_show_pattern_days":90,"dashboard_week_horizon_days":7}'::jsonb
    || coalesce((select s.value from settings s where s.key = 'retention_defaults' and jsonb_typeof(s.value) = 'object'), '{}'::jsonb) as cfg) c
where b.status = 'active' and b.remaining_units > 0 and b.expires_at is not null
  and b.expires_at > now() and b.expires_at <= now() + make_interval(days => (c.cfg->>'expiry_days')::int)
union all
select pp.person_id, 'high_value_inactive', (50 + least(30, pp.revenue_cents / 20000) + least(20, coalesce(pp.days_since_activity, 0) / 10))::int, 'person', pp.person_id,
       jsonb_build_object('visits_last_60d', coalesce(ps.visits_last_60d, 0), 'visits_prev_180d', coalesce(ps.visits_prev_180d, 0),
         'days_since_activity', pp.days_since_activity)
from pp left join person_stats ps on ps.person_id = pp.person_id cross join (select '{"visit_drop_ratio":0.5,"baseline_min_visits":3,"nearly_finished_pct":80,"expiry_days":30,"finished_no_repurchase_min_days":14,"finished_no_repurchase_max_days":120,"high_value_revenue_cents":100000,"vip_tag_key":"vip","high_value_inactive_days":60,"renewal_days":30,"never_booked_days":14,"unused_days":45,"weekly_list_size":25,"task_cooldown_days":14,"new_lead_followup_hours":48,"new_lead_window_days":14,"webinar_lead_window_days":14,"membership_expiring_days":14,"guest_abuse_distinct_guests":3,"guest_abuse_window_days":30,"stage_retention_days":90,"stage_lost_days":365,"stage_engaged_window_days":90,"no_show_pattern_count":3,"no_show_pattern_days":90,"dashboard_week_horizon_days":7}'::jsonb
    || coalesce((select s.value from settings s where s.key = 'retention_defaults' and jsonb_typeof(s.value) = 'object'), '{}'::jsonb) as cfg) c
where pp.is_high_value and pp.days_since_activity >= (c.cfg->>'high_value_inactive_days')::int and not pp.has_future_booking
union all
select pp.person_id, 'membership_renewal_due',
       (40 + least(30, pp.revenue_cents / 20000) + greatest(0, 20 - floor(extract(epoch from (m.current_period_end_at - now())) / 86400)::int) + case when m.cancel_at is not null then 10 else 0 end)::int,
       'membership', m.id,
       jsonb_build_object('membership_id', m.id, 'period_end_at', m.current_period_end_at, 'cancel_at', m.cancel_at)
from pp join memberships m on m.person_id = pp.person_id cross join (select '{"visit_drop_ratio":0.5,"baseline_min_visits":3,"nearly_finished_pct":80,"expiry_days":30,"finished_no_repurchase_min_days":14,"finished_no_repurchase_max_days":120,"high_value_revenue_cents":100000,"vip_tag_key":"vip","high_value_inactive_days":60,"renewal_days":30,"never_booked_days":14,"unused_days":45,"weekly_list_size":25,"task_cooldown_days":14,"new_lead_followup_hours":48,"new_lead_window_days":14,"webinar_lead_window_days":14,"membership_expiring_days":14,"guest_abuse_distinct_guests":3,"guest_abuse_window_days":30,"stage_retention_days":90,"stage_lost_days":365,"stage_engaged_window_days":90,"no_show_pattern_count":3,"no_show_pattern_days":90,"dashboard_week_horizon_days":7}'::jsonb
    || coalesce((select s.value from settings s where s.key = 'retention_defaults' and jsonb_typeof(s.value) = 'object'), '{}'::jsonb) as cfg) c
where m.status in ('active', 'past_due') and m.current_period_end_at <= now() + make_interval(days => (c.cfg->>'renewal_days')::int)
union all
select pp.person_id, 'purchased_never_booked', (30 + least(30, pp.revenue_cents / 20000))::int, 'grant', b.grant_id, jsonb_build_object('grant_id', b.grant_id, 'remaining', b.remaining_units, 'units_granted', b.base_units,
         'expires_at', b.expires_at, 'product_name', coalesce(pr.name->>pp.locale::text, pr.name->>'en'))
from pp join v_credit_grant_balances b on b.person_id = pp.person_id join credit_grants g on g.id = b.grant_id
left join products pr on pr.id = b.product_id cross join (select '{"visit_drop_ratio":0.5,"baseline_min_visits":3,"nearly_finished_pct":80,"expiry_days":30,"finished_no_repurchase_min_days":14,"finished_no_repurchase_max_days":120,"high_value_revenue_cents":100000,"vip_tag_key":"vip","high_value_inactive_days":60,"renewal_days":30,"never_booked_days":14,"unused_days":45,"weekly_list_size":25,"task_cooldown_days":14,"new_lead_followup_hours":48,"new_lead_window_days":14,"webinar_lead_window_days":14,"membership_expiring_days":14,"guest_abuse_distinct_guests":3,"guest_abuse_window_days":30,"stage_retention_days":90,"stage_lost_days":365,"stage_engaged_window_days":90,"no_show_pattern_count":3,"no_show_pattern_days":90,"dashboard_week_horizon_days":7}'::jsonb
    || coalesce((select s.value from settings s where s.key = 'retention_defaults' and jsonb_typeof(s.value) = 'object'), '{}'::jsonb) as cfg) c
where b.source = 'purchase' and g.created_at < now() - make_interval(days => (c.cfg->>'never_booked_days')::int)
  and not exists (select 1 from bookings bk where bk.person_id = pp.person_id)
union all
select pp.person_id, 'unused_sessions', (25 + least(30, pp.revenue_cents / 20000) + least(20, coalesce(pp.days_since_activity, 0) / 10))::int, 'grant', b.grant_id, jsonb_build_object('grant_id', b.grant_id, 'remaining', b.remaining_units, 'units_granted', b.base_units,
         'expires_at', b.expires_at, 'product_name', coalesce(pr.name->>pp.locale::text, pr.name->>'en'))
from pp join v_credit_grant_balances b on b.person_id = pp.person_id join credit_grants g on g.id = b.grant_id
left join products pr on pr.id = b.product_id cross join (select '{"visit_drop_ratio":0.5,"baseline_min_visits":3,"nearly_finished_pct":80,"expiry_days":30,"finished_no_repurchase_min_days":14,"finished_no_repurchase_max_days":120,"high_value_revenue_cents":100000,"vip_tag_key":"vip","high_value_inactive_days":60,"renewal_days":30,"never_booked_days":14,"unused_days":45,"weekly_list_size":25,"task_cooldown_days":14,"new_lead_followup_hours":48,"new_lead_window_days":14,"webinar_lead_window_days":14,"membership_expiring_days":14,"guest_abuse_distinct_guests":3,"guest_abuse_window_days":30,"stage_retention_days":90,"stage_lost_days":365,"stage_engaged_window_days":90,"no_show_pattern_count":3,"no_show_pattern_days":90,"dashboard_week_horizon_days":7}'::jsonb
    || coalesce((select s.value from settings s where s.key = 'retention_defaults' and jsonb_typeof(s.value) = 'object'), '{}'::jsonb) as cfg) c
where b.status = 'active' and b.remaining_units > 0 and not pp.has_future_booking
  and g.created_at < now() - make_interval(days => (c.cfg->>'unused_days')::int)
  and not exists (select 1 from credit_entries e where e.grant_id = b.grant_id and e.kind = 'consume'
                  and e.created_at >= now() - make_interval(days => (c.cfg->>'unused_days')::int));
--> statement-breakpoint
create or replace view v_revenue_daily as
select (o.paid_at at time zone 'Europe/Brussels')::date as day_on, o.channel, p.kind::text as product_kind,
       count(distinct o.id)::int as orders, sum(ol.line_total_cents)::int as gross_cents,
       sum(ol.vat_cents)::int as vat_cents, 0 as refunds_cents, 0 as refunds_vat_cents
from orders o join order_lines ol on ol.order_id = o.id join products p on p.id = ol.product_id
left join persons pe on pe.id = o.person_id
where o.paid_at is not null and o.status in ('paid', 'partially_refunded', 'refunded')
  and coalesce(pe.is_tester, false) = false
group by 1, 2, 3
union all
select (r.created_at at time zone 'Europe/Brussels')::date, o.channel, 'refund', 0, 0, 0,
       sum(r.amount_cents)::int, (-coalesce(sum(cn.vat_cents), 0))::int
from refunds r join payments pm on pm.id = r.payment_id join orders o on o.id = pm.order_id
left join persons pe on pe.id = o.person_id
left join invoices cn on cn.id = r.credit_note_id
where r.status = 'refunded' and coalesce(pe.is_tester, false) = false
group by 1, 2;
