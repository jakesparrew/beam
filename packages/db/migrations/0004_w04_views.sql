create or replace view v_credit_grant_balances as
select g.id as grant_id, g.person_id, g.credit_kind, g.source, g.status, g.product_id, g.membership_id,
       g.starts_at, g.expires_at, g.units_granted, g.unit_value_cents, g.vat_treatment, g.sharing,
       coalesce((g.data->>'original_units')::int, g.units_granted) as base_units,
       coalesce(sum(e.quantity), 0)::int as remaining_units,
       coalesce(-sum(e.quantity) filter (where e.kind in ('consume', 'release')), 0)::int as used_units,
       coalesce(-sum(e.quantity) filter (where e.kind in ('consume', 'release')
                 and e.beneficiary_person_id is not null
                 and e.beneficiary_person_id <> e.person_id), 0)::int as guest_units,
       coalesce(-sum(e.quantity) filter (where e.kind = 'expire'), 0)::int as expired_units,
       coalesce(sum(e.quantity) filter (where e.kind = 'adjust'), 0)::int as adjusted_units,
       max(e.created_at) filter (where e.kind = 'consume') as last_used_at,
       (g.status = 'active' and g.starts_at <= now()
          and (g.expires_at is null or g.expires_at > now())
          and coalesce(sum(e.quantity), 0) > 0) as is_usable
from credit_grants g
left join credit_entries e on e.grant_id = g.id
group by g.id;
--> statement-breakpoint
create or replace view v_credit_liability as
select b.credit_kind, b.vat_treatment, g.vat_rate_pct,
       sum(b.remaining_units)::bigint as remaining_units,
       sum(b.remaining_units * b.unit_value_cents)::bigint as remaining_value_cents,
       count(*)::int as grants
from v_credit_grant_balances b join credit_grants g on g.id = b.grant_id
where b.status = 'active' and b.remaining_units > 0
group by b.credit_kind, b.vat_treatment, g.vat_rate_pct;
--> statement-breakpoint
create or replace view v_credit_movements_monthly as
select date_trunc('month', e.created_at at time zone 'Europe/Brussels')::date as month_on,
       g.credit_kind, g.vat_treatment, g.vat_rate_pct, e.kind as entry_kind,
       sum(e.quantity)::bigint as units,
       sum(e.quantity * g.unit_value_cents)::bigint as value_cents
from credit_entries e join credit_grants g on g.id = e.grant_id
group by 1, 2, 3, 4, 5;
--> statement-breakpoint
create or replace view v_euro_voucher_redemptions as
select e.id as entry_id, e.grant_id, e.person_id, e.ref_id as order_id,
       (-e.quantity)::int as amount_cents, e.created_at as redeemed_at,
       exists (select 1 from credit_entries r where r.reverses_entry_id = e.id) as is_reversed
from credit_entries e join credit_grants g on g.id = e.grant_id
where g.credit_kind = 'euro' and e.kind = 'consume' and e.ref_type = 'order';
--> statement-breakpoint
create or replace view v_person_credits as
select b.person_id, b.credit_kind,
       sum(b.remaining_units)::int as remaining_units,
       sum(b.remaining_units * b.unit_value_cents)::bigint as remaining_value_cents,
       count(*)::int as usable_grants,
       min(b.expires_at) as next_expires_at,
       array_agg(distinct b.product_id) filter (where b.product_id is not null) as product_ids
from v_credit_grant_balances b
where b.is_usable
group by b.person_id, b.credit_kind;
--> statement-breakpoint
create or replace view v_person_status as
with paid as (
  select o.person_id, min(o.paid_at) as first_paid_at from orders o
  where o.person_id is not null and o.paid_at is not null and o.total_cents > 0
    and o.status in ('paid', 'partially_refunded', 'refunded')
    and exists (select 1 from order_lines l where l.order_id = o.id
                and l.product_kind in ('session', 'night', 'package', 'membership', 'ticket'))
  group by o.person_id),
legacy as (
  select person_id, min(starts_at) as first_at from credit_grants
  where source in ('purchase', 'import') and credit_kind in ('day', 'night') group by person_id),
ever_member as (
  select person_id, min(started_at) as member_since_at from memberships
  where status in ('active', 'past_due')
     or (status in ('cancelled', 'expired') and ended_at > started_at)
  group by person_id),
cur as (
  select distinct on (person_id) person_id, id as membership_id, status, current_period_end_at, discount_pct
  from memberships
  where status in ('active', 'past_due') and started_at <= now()
  order by person_id, started_at desc)
select p.id as person_id,
       case when cur.membership_id is not null then 'member'
            when paid.person_id is not null or legacy.person_id is not null then 'customer'
            else 'lead' end as derived_status,
       p.status_override,
       coalesce(p.status_override::text,
         case when cur.membership_id is not null then 'member'
              when paid.person_id is not null or legacy.person_id is not null then 'customer'
              else 'lead' end) as status,
       (cur.membership_id is not null) as is_member,
       cur.membership_id, cur.status as membership_status, cur.current_period_end_at as membership_period_end_at,
       coalesce(cur.discount_pct, 0) as member_discount_pct,
       ever_member.member_since_at,
       least(paid.first_paid_at, legacy.first_at) as first_paid_at
from persons p
left join paid on paid.person_id = p.id
left join legacy on legacy.person_id = p.id
left join ever_member on ever_member.person_id = p.id
left join cur on cur.person_id = p.id
where p.erased_at is null and p.merged_into_person_id is null;
