create or replace view v_ticket_type_availability as
select t.id as ticket_type_id, t.session_id, t.capacity,
  coalesce(b.sold, 0)::int as sold,
  case when t.capacity is null then null else greatest(0, t.capacity - coalesce(b.sold, 0))::int end as available,
  (t.is_active and now() >= coalesce(t.sales_start_at, '-infinity'::timestamptz)
     and now() < coalesce(t.sales_end_at, s.starts_at)) as is_on_sale
from ticket_types t
join sessions s on s.id = t.session_id
left join (select ticket_type_id, count(*) as sold
           from bookings where ticket_type_id is not null
             and (status in ('confirmed', 'attended', 'no_show') or (status = 'reserved' and reserved_until > now()))
           group by 1) b on b.ticket_type_id = t.id;
