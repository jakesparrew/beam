create or replace view v_webinar_performance_daily as
with reg as (
  select f.webinar_id, (f.registered_at at time zone 'Europe/Brussels')::date as day_on, count(*)::int as registrations
  from v_webinar_registration_facts f join persons pe on pe.id = f.person_id
  where f.status <> 'cancelled' and pe.is_tester = false
  group by 1, 2),
wa as (
  select ww.webinar_id, (ww.first_watched_at at time zone 'Europe/Brussels')::date as day_on,
         count(*) filter (where ww.mode = 'live' and ww.is_attended)::int as live_attended,
         count(*) filter (where ww.mode = 'live')::int as live_watchers,
         coalesce(sum(ww.watched_sec) filter (where ww.mode = 'live'), 0)::int as live_watch_sec,
         count(*) filter (where ww.mode = 'replay' and ww.is_attended)::int as replay_attended,
         count(*) filter (where ww.mode = 'replay')::int as replay_watchers,
         coalesce(sum(ww.watched_sec) filter (where ww.mode = 'replay'), 0)::int as replay_watch_sec,
         count(*) filter (where ww.mode = 'on_demand' and ww.is_attended)::int as on_demand_attended,
         count(*) filter (where ww.mode = 'on_demand')::int as on_demand_watchers,
         coalesce(sum(ww.watched_sec) filter (where ww.mode = 'on_demand'), 0)::int as on_demand_watch_sec
  from v_webinar_watch ww join persons pe on pe.id = ww.person_id
  where pe.is_tester = false
  group by 1, 2),
ia as (
  select i.webinar_id, coalesce(p.merged_into_person_id, r.person_id) as person_id, i.kind, i.mode, i.poll_id, i.occurred_at
  from webinar_interactions i
  join webinar_registrations r on r.id = i.registration_id
  join persons p on p.id = r.person_id
  join persons pe on pe.id = coalesce(p.merged_into_person_id, r.person_id)
  where i.kind in ('poll_answer', 'cta_clicked') and pe.is_tester = false),
pa as (
  select webinar_id, (min(occurred_at) at time zone 'Europe/Brussels')::date as day_on
  from ia where kind = 'poll_answer'
  group by webinar_id, person_id, poll_id, mode),
pol as (select webinar_id, day_on, count(*)::int as poll_answers from pa group by 1, 2),
cta as (
  select webinar_id, (occurred_at at time zone 'Europe/Brussels')::date as day_on, count(*)::int as cta_clicks
  from ia where kind = 'cta_clicked' group by 1, 2),
conv as (
  select c.webinar_id, (c.anchor_at at time zone 'Europe/Brussels')::date as day_on, count(*)::int as conversions_30d
  from v_webinar_conversions c
  join webinar_registrations r on r.id = c.registration_id
  join persons pe on pe.id = c.person_id
  where r.status <> 'cancelled' and pe.is_tester = false
    and (c.first_booking_at <= c.anchor_at + interval '30 days'
         or c.first_paid_order_at <= c.anchor_at + interval '30 days')
  group by 1, 2),
k as (
  select webinar_id, day_on from reg union select webinar_id, day_on from wa
  union select webinar_id, day_on from pol union select webinar_id, day_on from cta
  union select webinar_id, day_on from conv)
select k.webinar_id, k.day_on,
       coalesce(reg.registrations, 0) as registrations,
       coalesce(wa.live_attended, 0) as live_attendees,
       coalesce(wa.replay_attended, 0) as replay_viewers,
       coalesce(wa.on_demand_attended, 0) as on_demand_viewers,
       coalesce(wa.live_watchers, 0) as live_watchers,
       coalesce(wa.live_watch_sec, 0) as live_watch_sec,
       case when wa.live_watchers > 0 then round(wa.live_watch_sec / 60.0 / wa.live_watchers, 1)::float8 end as avg_live_watch_min,
       coalesce(wa.replay_watchers, 0) as replay_watchers,
       coalesce(wa.replay_watch_sec, 0) as replay_watch_sec,
       case when wa.replay_watchers > 0 then round(wa.replay_watch_sec / 60.0 / wa.replay_watchers, 1)::float8 end as avg_replay_watch_min,
       coalesce(wa.on_demand_watchers, 0) as on_demand_watchers,
       coalesce(wa.on_demand_watch_sec, 0) as on_demand_watch_sec,
       case when wa.on_demand_watchers > 0 then round(wa.on_demand_watch_sec / 60.0 / wa.on_demand_watchers, 1)::float8 end as avg_on_demand_watch_min,
       coalesce(pol.poll_answers, 0) as poll_answers,
       coalesce(cta.cta_clicks, 0) as cta_clicks,
       coalesce(conv.conversions_30d, 0) as conversions_30d
from k
left join reg on reg.webinar_id = k.webinar_id and reg.day_on = k.day_on
left join wa on wa.webinar_id = k.webinar_id and wa.day_on = k.day_on
left join pol on pol.webinar_id = k.webinar_id and pol.day_on = k.day_on
left join cta on cta.webinar_id = k.webinar_id and cta.day_on = k.day_on
left join conv on conv.webinar_id = k.webinar_id and conv.day_on = k.day_on;
