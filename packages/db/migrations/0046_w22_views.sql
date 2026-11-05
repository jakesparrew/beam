create or replace view v_opportunity_candidates as
with pp as (select pr.person_id, pr.is_member, pr.b2c_stage from v_person_profile pr
            where pr.is_tester = false
              and exists (select 1 from dpia_records d where d.key = 'behavioural_scoring' and d.status in ('approved', 'not_required'))),
  mp as (select min(case when pd.recurring_interval = 'year' then cp.amount_cents / 12.0 else cp.amount_cents end) as monthly_cents
         from products pd join v_product_current_prices cp on cp.product_id = pd.id and cp.audience = 'public'
         where pd.kind = 'membership' and pd.is_active)
select pp.person_id, 'membership_fit'::text as reason,
       (60 + least(30, ps.visits_last_60d))::int as score,
       jsonb_build_object('visits_last_60d', ps.visits_last_60d, 'spend_60d_cents', sp.cents,
         'member_month_cents', round(mp.monthly_cents)::int) as detail
from pp join person_stats ps on ps.person_id = pp.person_id cross join mp
cross join lateral (select coalesce(sum(o.total_cents), 0)::int as cents from orders o
                    where o.person_id = pp.person_id and o.company_id is null and o.paid_at >= now() - interval '60 days'
                      and o.status in ('paid', 'partially_refunded', 'refunded')) sp
where not pp.is_member and ps.visits_last_60d >= 6 and mp.monthly_cents is not null and sp.cents >= 2 * mp.monthly_cents
union all
select pp.person_id, 'package_upgrade', (50 + least(30, 10 * (gp.grants - 2)))::int,
       jsonb_build_object('product_id', gp.product_id, 'grants_180d', gp.grants, 'larger_product_id', lg.id, 'units', pd.credit_units,
         'larger_units', lg.credit_units)
from pp join (select g.person_id, g.product_id, count(*)::int as grants from credit_grants g
              where g.product_id is not null and g.created_at >= now() - interval '180 days' group by g.person_id, g.product_id
              having count(*) >= 2) gp on gp.person_id = pp.person_id
join products pd on pd.id = gp.product_id and pd.kind = 'package'
cross join lateral (select p2.id, p2.credit_units from products p2
                    where p2.kind = 'package' and p2.is_active and p2.credit_kind = pd.credit_kind and p2.credit_units > pd.credit_units
                    order by p2.credit_units, p2.id limit 1) lg
union all
select pp.person_id, 'repurchase_likely', round(ps.repurchase_probability * 100)::int,
       jsonb_build_object('repurchase_probability', ps.repurchase_probability, 'grant_id', lw.grant_id, 'remaining', lw.remaining_units)
from pp join person_stats ps on ps.person_id = pp.person_id
cross join lateral (select b.grant_id, b.remaining_units from v_credit_grant_balances b
                    where b.person_id = pp.person_id and b.status = 'active' and b.remaining_units <= 2
                    order by b.remaining_units, b.grant_id limit 1) lw
where ps.repurchase_probability >= 0.6
union all
select pp.person_id, 'reactivation_likely', round((1 - ps.churn_probability) * 100)::int,
       jsonb_build_object('churn_probability', ps.churn_probability, 'predicted_value_cents', ps.predicted_value_cents)
from pp join person_stats ps on ps.person_id = pp.person_id
where pp.b2c_stage = 'retention' and ps.churn_probability < 0.5
union all
select pp.person_id, 'b2b_link', 40,
       jsonb_build_object('company_id', cl.company_id, 'company_contact_id', cl.id)
from pp cross join lateral (select cc.id, cc.company_id from company_contacts cc
                            where cc.person_id = pp.person_id and cc.ended_on is null
                              and not exists (select 1 from opportunities o where o.company_id = cc.company_id and o.stage not in ('won', 'lost'))
                            order by cc.created_at, cc.id limit 1) cl;
