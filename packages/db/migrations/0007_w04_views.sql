create or replace view v_person_bookings as
select b.*, s.kind, s.title, s.starts_at, s.ends_at, s.location, s.status as session_status,
  (b.guest_of_booking_id is not null) as is_guest, coalesce(owner.person_id, b.person_id) as owner_person_id
from bookings b
join sessions s on s.id = b.session_id
left join bookings owner on owner.id = b.guest_of_booking_id;
--> statement-breakpoint
create or replace view v_session_availability as
select s.id as session_id, s.kind, s.starts_at, s.ends_at, s.status, s.is_lead_magnet, s.published_at,
  coalesce(s.capacity_beds, s.capacity_seats) as capacity,
  coalesce(h.held, 0)::int as held,
  coalesce(b.booked, 0)::int as booked,
  coalesce(b.lead_booked, 0)::int as lead_booked,
  coalesce(o.live_offers, 0)::int as live_offers,
  coalesce(o.live_lead_offers, 0)::int as live_lead_offers,
  greatest(0, coalesce(s.capacity_beds, s.capacity_seats) - coalesce(h.held, 0) - coalesce(b.booked, 0) - coalesce(o.live_offers, 0))::int as available_total,
  (case when s.is_lead_magnet and (now() < s.lead_window_end_at or s.lead_release_rule = 'keep_for_leads')
       then greatest(0, s.lead_reserved_seats - coalesce(b.lead_booked, 0) - coalesce(o.live_lead_offers, 0)) else 0 end)::int as lead_reserved_remaining,
  case when not s.is_lead_magnet then 'none'
       when now() < s.lead_window_start_at then 'pre'
       when now() < s.lead_window_end_at then 'lead'
       when s.lead_release_rule = 'customers_then_public' and now() < coalesce(s.public_release_at, s.lead_window_end_at + make_interval(mins => s.claim_window_minutes)) then 'customer_release'
       else 'public' end as lead_phase,
  greatest(0, greatest(0, coalesce(s.capacity_beds, s.capacity_seats) - coalesce(h.held, 0) - coalesce(b.booked, 0) - coalesce(o.live_offers, 0)) - (case when s.is_lead_magnet and (now() < s.lead_window_end_at or s.lead_release_rule = 'keep_for_leads')
       then greatest(0, s.lead_reserved_seats - coalesce(b.lead_booked, 0) - coalesce(o.live_lead_offers, 0)) else 0 end))::int as available_general,
  case when s.is_lead_magnet then s.lead_window_end_at end as opens_for_customers_at,
  case when s.is_lead_magnet then coalesce(s.public_release_at, s.lead_window_end_at + make_interval(mins => s.claim_window_minutes)) end as opens_for_public_at,
  coalesce(w.waiting, 0)::int as waiting
from sessions s
left join (select session_id, sum(quantity) as held from capacity_holds group by 1) h on h.session_id = s.id
left join (select session_id, sum(capacity_units) as booked, sum(capacity_units) filter (where used_lead_seat) as lead_booked
           from bookings where capacity_hold_id is null
             and (status in ('confirmed', 'attended', 'no_show') or (status = 'reserved' and reserved_until > now()))
           group by 1) b on b.session_id = s.id
left join (select session_id, count(*) as live_offers, count(*) filter (where queue = 'lead') as live_lead_offers
           from waitlist_entries where state = 'offered' and offer_expires_at > now() and booking_id is null group by 1) o on o.session_id = s.id
left join (select session_id, count(*) as waiting from waitlist_entries where state = 'waiting' group by 1) w on w.session_id = s.id;
--> statement-breakpoint
create or replace view v_session_utilisation as
select s.id as session_id, s.template_id, s.kind,
  (s.starts_at at time zone 'Europe/Brussels')::date as day_on,
  extract(isodow from (s.starts_at at time zone 'Europe/Brussels'))::int as weekday,
  (s.starts_at at time zone 'Europe/Brussels')::time as local_start_time,
  coalesce(s.capacity_beds, s.capacity_seats) as capacity,
  coalesce(h.held, 0)::int as held,
  coalesce(b.booked_total, 0)::int as booked_total,
  coalesce(b.attended, 0)::int as attended,
  coalesce(b.no_shows, 0)::int as no_shows,
  coalesce(b.cancellations, 0)::int as cancellations,
  coalesce(b.late_cancellations, 0)::int as late_cancellations,
  coalesce(w.waitlist_peak, 0)::int as waitlist_peak,
  case when s.ends_at <= now()
       then round(100.0 * coalesce(b.used_units, 0) / nullif(coalesce(s.capacity_beds, s.capacity_seats), 0), 1)
       else round(100.0 * coalesce(b.booked_total, 0) / nullif(coalesce(s.capacity_beds, s.capacity_seats), 0), 1) end as utilisation_pct
from sessions s
left join (select session_id, sum(quantity) as held from capacity_holds group by 1) h on h.session_id = s.id
left join (select session_id,
             sum(capacity_units) filter (where status not in ('cancelled', 'late_cancelled')) as booked_total,
             sum(capacity_units) filter (where status in ('attended', 'no_show')) as used_units,
             count(*) filter (where status = 'attended') as attended,
             count(*) filter (where status = 'no_show') as no_shows,
             count(*) filter (where status = 'cancelled') as cancellations,
             count(*) filter (where status = 'late_cancelled') as late_cancellations
           from bookings group by 1) b on b.session_id = s.id
left join (select session_id, count(*) as waitlist_peak from waitlist_entries group by 1) w on w.session_id = s.id;
