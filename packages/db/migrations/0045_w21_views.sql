create or replace view v_email_attribution as
with candidates as (
  select o.id as order_id, o.person_id, o.paid_at, o.total_cents,
    m.id as email_message_id, m.campaign_id, m.enrolment_id, m.clicked_at
  from orders o
  join email_messages m on m.person_id = o.person_id
    and m.kind in ('campaign', 'automation')
    and (m.campaign_id is not null or m.enrolment_id is not null)
    and m.clicked_at is not null
    and m.clicked_at <= o.paid_at
    and o.paid_at <= m.clicked_at + interval '7 days'
  where o.status in ('paid', 'partially_refunded') and o.paid_at is not null and o.person_id is not null
), last_click as (
  select distinct on (order_id) order_id, person_id, paid_at, total_cents, email_message_id, campaign_id, enrolment_id, clicked_at
  from candidates
  order by order_id, clicked_at desc, email_message_id
)
select lc.order_id, lc.person_id, lc.paid_at, lc.total_cents, lc.email_message_id, lc.clicked_at,
  lc.campaign_id, lc.enrolment_id, ae.automation_id,
  not exists (
    select 1 from orders po
    where po.person_id = lc.person_id and po.id <> lc.order_id
      and po.status in ('paid', 'partially_refunded') and po.paid_at is not null
      and (po.paid_at < lc.paid_at or (po.paid_at = lc.paid_at and po.id < lc.order_id))
  ) as is_first_purchase
from last_click lc
left join automation_enrolments ae on ae.id = lc.enrolment_id;
