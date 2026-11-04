create or replace view v_webinar_watch as
with r as (
  select r.id, r.webinar_id, coalesce(p.merged_into_person_id, r.person_id) as person_id
  from webinar_registrations r join persons p on p.id = r.person_id),
s as (
  select r.person_id, ws.webinar_id, ws.mode, ws.from_sec, ws.to_sec, ws.recorded_at,
         max(ws.to_sec) over (partition by r.person_id, ws.webinar_id, ws.mode order by ws.from_sec, ws.to_sec
                              rows between unbounded preceding and 1 preceding) as prev_max
  from watch_segments ws join r on r.id = ws.registration_id),
g as (select s.*, sum(case when prev_max is null or from_sec > prev_max then 1 else 0 end)
         over (partition by person_id, webinar_id, mode order by from_sec, to_sec) as grp from s),
islands as (select person_id, webinar_id, mode, grp, min(from_sec) f, max(to_sec) t,
                   min(recorded_at) first_at, max(recorded_at) last_at from g group by 1,2,3,4),
agg as (select person_id, webinar_id, mode, sum(t - f)::int as watched_sec, max(t) as max_position_sec,
               min(first_at) as first_watched_at, max(last_at) as last_watched_at from islands group by 1,2,3)
select own.id as registration_id, a.*, w.attended_min_sec,
       coalesce(w.duration_sec, w.planned_duration_minutes * 60) as duration_sec,
       a.watched_sec >= w.attended_min_sec as is_attended,
       a.watched_sec >= 900 as is_15m,
       a.watched_sec >= 1800 as is_30m,
       a.watched_sec * 2 >= coalesce(w.duration_sec, w.planned_duration_minutes * 60) as is_half,
       a.max_position_sec >= coalesce(w.duration_sec, w.planned_duration_minutes * 60) - 60 as is_end
from agg a join webinars w on w.id = a.webinar_id
left join webinar_registrations own on own.webinar_id = a.webinar_id and own.person_id = a.person_id;
--> statement-breakpoint
create or replace view v_webinar_registration_facts as
with rr as (
  select r.id, r.webinar_id, r.person_id, r.person_status, r.registered_mode, r.status, r.created_at,
         coalesce(p.merged_into_person_id, r.person_id) as resolved_person_id
  from webinar_registrations r join persons p on p.id = r.person_id),
o as (
  select distinct on (webinar_id, resolved_person_id) *
  from rr order by webinar_id, resolved_person_id, (person_id = resolved_person_id) desc, created_at, id),
ia as (
  select rr.webinar_id, rr.resolved_person_id,
         bool_or(i.kind = 'started' and i.mode = 'live') as live_started,
         bool_or(i.kind = 'started' and i.mode = 'replay') as replay_started,
         bool_or(i.kind = 'started' and i.mode = 'on_demand') as od_started,
         count(distinct i.poll_id) filter (where i.kind = 'poll_answer' and i.mode = 'live')::int as poll_answers_live,
         count(distinct i.poll_id) filter (where i.kind = 'poll_answer' and i.mode = 'replay')::int as poll_answers_replay,
         count(distinct i.poll_id) filter (where i.kind = 'poll_answer' and i.mode = 'on_demand')::int as poll_answers_od,
         count(*) filter (where i.kind = 'cta_clicked' and i.mode = 'live')::int as cta_clicks_live,
         count(*) filter (where i.kind = 'cta_clicked' and i.mode = 'replay')::int as cta_clicks_replay,
         count(*) filter (where i.kind = 'cta_clicked' and i.mode = 'on_demand')::int as cta_clicks_od,
         count(*) filter (where i.kind = 'question')::int as questions,
         count(*) filter (where i.kind = 'chat')::int as chats,
         min(i.occurred_at) filter (where i.kind = 'cta_clicked') as first_cta_click_at
  from webinar_interactions i join rr on rr.id = i.registration_id
  group by 1, 2)
select o.id as registration_id, o.webinar_id, o.resolved_person_id as person_id, o.person_status, o.registered_mode,
       o.status, o.created_at as registered_at,
       case when o.registered_mode = 'live' then coalesce(w.starts_at, o.created_at) else o.created_at end as anchor_at,
       coalesce(ia.live_started, false) as live_started,
       coalesce(wl.watched_sec, 0) as live_watched_sec,
       coalesce(wl.is_attended, false) as live_attended,
       coalesce(wl.is_15m, false) as live_is_15m,
       coalesce(wl.is_30m, false) as live_is_30m,
       coalesce(wl.is_half, false) as live_is_half,
       coalesce(wl.is_end, false) as live_is_end,
       coalesce(ia.replay_started, false) as replay_started,
       coalesce(wr.watched_sec, 0) as replay_watched_sec,
       coalesce(wr.is_attended, false) as replay_attended,
       coalesce(wr.is_15m, false) as replay_is_15m,
       coalesce(wr.is_30m, false) as replay_is_30m,
       coalesce(wr.is_half, false) as replay_is_half,
       coalesce(wr.is_end, false) as replay_is_end,
       coalesce(ia.od_started, false) as od_started,
       coalesce(wo.watched_sec, 0) as od_watched_sec,
       coalesce(wo.is_attended, false) as od_attended,
       coalesce(wo.is_15m, false) as od_is_15m,
       coalesce(wo.is_30m, false) as od_is_30m,
       coalesce(wo.is_half, false) as od_is_half,
       coalesce(wo.is_end, false) as od_is_end,
       coalesce(ia.poll_answers_live, 0) as poll_answers_live,
       coalesce(ia.poll_answers_replay, 0) as poll_answers_replay,
       coalesce(ia.poll_answers_od, 0) as poll_answers_od,
       coalesce(ia.cta_clicks_live, 0) as cta_clicks_live,
       coalesce(ia.cta_clicks_replay, 0) as cta_clicks_replay,
       coalesce(ia.cta_clicks_od, 0) as cta_clicks_od,
       coalesce(ia.questions, 0) as questions,
       coalesce(ia.chats, 0) as chats,
       ia.first_cta_click_at
from o join webinars w on w.id = o.webinar_id
left join ia on ia.webinar_id = o.webinar_id and ia.resolved_person_id = o.resolved_person_id
left join v_webinar_watch wl on wl.webinar_id = o.webinar_id and wl.person_id = o.resolved_person_id and wl.mode = 'live'
left join v_webinar_watch wr on wr.webinar_id = o.webinar_id and wr.person_id = o.resolved_person_id and wr.mode = 'replay'
left join v_webinar_watch wo on wo.webinar_id = o.webinar_id and wo.person_id = o.resolved_person_id and wo.mode = 'on_demand';
--> statement-breakpoint
create or replace view v_person_webinar_stats as
with nat as (
  select person_id,
         count(*) filter (where status <> 'cancelled')::int as webinars_registered,
         count(*) filter (where live_attended)::int as webinars_attended_live,
         count(*) filter (where replay_attended)::int as replays_watched,
         count(*) filter (where od_attended)::int as on_demand_watched,
         sum(live_watched_sec + replay_watched_sec + od_watched_sec)::int as watch_sec_total,
         sum(poll_answers_live + poll_answers_replay + poll_answers_od)::int as poll_answers,
         sum(cta_clicks_live + cta_clicks_replay + cta_clicks_od)::int as cta_clicks,
         max(registered_at) filter (where status <> 'cancelled') as last_registered_at
  from v_webinar_registration_facts group by person_id),
att as (select person_id, max(last_watched_at) as last_attended_at from v_webinar_watch where is_attended group by person_id),
imp as (
  select coalesce(p.merged_into_person_id, h.person_id) as person_id,
         count(*) filter (where h.kind = 'webinar_registration')::int as imported_registered,
         count(*) filter (where h.kind = 'webinar_attendance')::int as imported_attended,
         max(h.occurred_at) filter (where h.kind = 'webinar_registration') as imported_last_registered_at,
         max(h.occurred_at) filter (where h.kind = 'webinar_attendance') as imported_last_attended_at
  from imported_history h join persons p on p.id = h.person_id
  where h.kind in ('webinar_registration', 'webinar_attendance')
  group by 1),
ids as (select person_id from nat union select person_id from imp)
select ids.person_id,
       coalesce(nat.webinars_registered, 0) as webinars_registered,
       coalesce(nat.webinars_attended_live, 0) as webinars_attended_live,
       coalesce(nat.replays_watched, 0) as replays_watched,
       coalesce(nat.on_demand_watched, 0) as on_demand_watched,
       coalesce(nat.watch_sec_total, 0) as watch_sec_total,
       coalesce(nat.poll_answers, 0) as poll_answers,
       coalesce(nat.cta_clicks, 0) as cta_clicks,
       greatest(nat.last_registered_at, imp.imported_last_registered_at) as last_webinar_registered_at,
       greatest(att.last_attended_at, imp.imported_last_attended_at) as last_webinar_attended_at,
       coalesce(imp.imported_registered, 0) as imported_webinars_registered,
       coalesce(imp.imported_attended, 0) as imported_webinars_attended
from ids
left join nat on nat.person_id = ids.person_id
left join att on att.person_id = ids.person_id
left join imp on imp.person_id = ids.person_id;
--> statement-breakpoint
create or replace view v_webinar_conversions as
select f.registration_id, f.webinar_id, f.person_id, f.person_status, f.anchor_at,
       (select min(b.created_at) from bookings b
         where b.person_id = f.person_id and b.status in ('confirmed', 'attended') and b.created_at > f.anchor_at) as first_booking_at,
       fo.paid_at as first_paid_order_at,
       fo.total_cents as first_paid_order_cents,
       coalesce((select sum(o.total_cents) from orders o
         where o.person_id = f.person_id and o.status = 'paid' and o.paid_at > f.anchor_at
           and o.paid_at <= f.anchor_at + interval '365 days'), 0)::int as revenue_365d_cents
from v_webinar_registration_facts f
left join lateral (select o.paid_at, o.total_cents from orders o
                   where o.person_id = f.person_id and o.status = 'paid' and o.paid_at > f.anchor_at
                   order by o.paid_at, o.id limit 1) fo on true;
