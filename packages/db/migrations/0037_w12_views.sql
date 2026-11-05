create or replace view v_sharing_review as
with guest_use as (
  select e.grant_id, e.person_id as owner_person_id, e.beneficiary_person_id as guest_person_id, e.created_at
  from credit_entries e
  where e.kind = 'consume' and e.beneficiary_person_id is not null
    and e.beneficiary_person_id <> e.person_id and e.created_at > now() - interval '30 days'
    and not exists (select 1 from credit_entries r where r.reverses_entry_id = e.id)),
many as (
  select 'many_guests'::text as rule, grant_id, null::uuid as guest_person_id,
         array_agg(distinct guest_person_id) as person_ids, count(distinct guest_person_id)::int as distinct_count,
         max(created_at) as last_at
  from guest_use group by grant_id
  having count(distinct guest_person_id) > coalesce((select (value->'guest_abuse'->>'distinct_guests_per_30_days')::int
                                                   from settings where key = 'booking_rules'), 3)),
hop as (
  select 'guest_hopping'::text, null::uuid, guest_person_id,
         array_agg(distinct owner_person_id), count(distinct owner_person_id)::int, max(created_at)
  from guest_use group by guest_person_id having count(distinct owner_person_id) >= 3),
cand as (select * from many union all select * from hop)
select c.* from cand c
where not exists (
  select 1 from credit_sharing_reviews r
  where r.rule::text = c.rule
    and (r.grant_id = c.grant_id or r.guest_person_id = c.guest_person_id)
    and c.person_ids <@ r.guest_person_ids);
