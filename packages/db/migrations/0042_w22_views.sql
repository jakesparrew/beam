create or replace view v_package_cycles as
select g.id as grant_id, g.person_id, g.product_id, g.credit_kind,
       g.status_changed_at as closed_at, n.next_purchase_at,
       case when n.next_purchase_at is null then null
            else greatest(0, (n.next_purchase_at at time zone 'Europe/Brussels')::date
                             - (g.status_changed_at at time zone 'Europe/Brussels')::date) end::int as days_to_repurchase,
       (n.next_purchase_at is not null) as repurchased
from credit_grants g
left join lateral (
  select min(l.starts_at) as next_purchase_at
  from credit_grants l
  where l.person_id = g.person_id and l.credit_kind = g.credit_kind and l.source = 'purchase'
    and l.status <> 'revoked' and l.starts_at > g.starts_at) n on true
where g.source = 'purchase' and g.status in ('exhausted', 'expired');
