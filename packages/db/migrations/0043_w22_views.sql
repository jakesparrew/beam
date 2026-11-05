create or replace view v_marketing_touches as
select t.person_id, t.touched_at, t.source, t.medium, t.campaign, t.touch_kind,
       t.source || '|' || t.campaign as campaign_key
from (
  select p.id as person_id, p.created_at as touched_at,
         coalesce(case when lower(trim(p.acquisition->>'source')) in ('paid_meta', 'meta', 'facebook', 'fb', 'instagram', 'ig') then 'meta'
            when lower(trim(p.acquisition->>'source')) in ('paid_google', 'google', 'adwords') then 'google'
            else nullif(lower(trim(p.acquisition->>'source')), '') end, 'direct') as source,
         nullif(lower(trim(coalesce(p.acquisition->>'medium', p.acquisition->'utm'->>'medium'))), '') as medium,
         nullif(lower(trim(coalesce(nullif(trim(p.acquisition->>'campaign'), ''), p.acquisition->'utm'->>'campaign'))), '') as campaign,
         'acquisition' as touch_kind
  from persons p
  where p.merged_into_person_id is null and jsonb_typeof(p.acquisition) = 'object'
  union all
  select fs.person_id, fs.completed_at,
         coalesce(case when lower(trim(fs.source)) in ('paid_meta', 'meta', 'facebook', 'fb', 'instagram', 'ig') then 'meta'
            when lower(trim(fs.source)) in ('paid_google', 'google', 'adwords') then 'google'
            else nullif(lower(trim(fs.source)), '') end, 'direct'),
         nullif(lower(trim(fs.utm->>'medium')), ''),
         nullif(lower(trim(coalesce(nullif(trim(fs.campaign), ''), fs.utm->>'campaign'))), ''),
         'form'
  from form_submissions fs
  where fs.person_id is not null and fs.status = 'completed' and fs.completed_at is not null
  union all
  select c.person_id, c.created_at,
         coalesce(case when lower(trim(c.utm->>'source')) in ('paid_meta', 'meta', 'facebook', 'fb', 'instagram', 'ig') then 'meta'
            when lower(trim(c.utm->>'source')) in ('paid_google', 'google', 'adwords') then 'google'
            else nullif(lower(trim(c.utm->>'source')), '') end, 'direct'),
         nullif(lower(trim(c.utm->>'medium')), ''),
         nullif(lower(trim(c.utm->>'campaign')), ''),
         'checkout'
  from checkouts c
  where c.person_id is not null and jsonb_typeof(c.utm) = 'object'
) t
where t.campaign is not null;
--> statement-breakpoint
create or replace view v_person_first_touch as
select p.id as person_id, p.created_at, p.is_tester, p.erased_at is not null as is_erased,
       p.acquisition->>'source' as acquisition_source,
       coalesce(case when lower(trim(p.acquisition->>'source')) in ('paid_meta', 'meta', 'facebook', 'fb', 'instagram', 'ig') then 'meta'
            when lower(trim(p.acquisition->>'source')) in ('paid_google', 'google', 'adwords') then 'google'
            else nullif(lower(trim(p.acquisition->>'source')), '') end, 'direct') as source,
       nullif(lower(trim(coalesce(p.acquisition->>'medium', p.acquisition->'utm'->>'medium'))), '') as medium,
       nullif(lower(trim(coalesce(nullif(trim(p.acquisition->>'campaign'), ''), p.acquisition->'utm'->>'campaign'))), '') as campaign,
       case when nullif(lower(trim(coalesce(nullif(trim(p.acquisition->>'campaign'), ''), p.acquisition->'utm'->>'campaign'))), '') is null then 'direct|none'
            else coalesce(case when lower(trim(p.acquisition->>'source')) in ('paid_meta', 'meta', 'facebook', 'fb', 'instagram', 'ig') then 'meta'
            when lower(trim(p.acquisition->>'source')) in ('paid_google', 'google', 'adwords') then 'google'
            else nullif(lower(trim(p.acquisition->>'source')), '') end, 'direct') || '|' || nullif(lower(trim(coalesce(nullif(trim(p.acquisition->>'campaign'), ''), p.acquisition->'utm'->>'campaign'))), '') end as campaign_key
from persons p
where p.merged_into_person_id is null;
