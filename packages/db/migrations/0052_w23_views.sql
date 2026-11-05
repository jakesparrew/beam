create or replace view ai.form_funnel_daily as
select f.id as form_id, f.slug as form_slug, f.kind::text as form_kind, d.day_on,
       d.views, d.started, d.engaged, d.completed, d.abandoned
from v_form_funnel_daily d join forms f on f.id = d.form_id;
--> statement-breakpoint
create or replace view ai.form_outcomes as
with c as (
  select fs.form_id, fs.form_version_id, (fs.started_at at time zone 'Europe/Brussels')::date as day_on, fs.outcome_key, count(*)::int as n
  from form_submissions fs where fs.status = 'completed'
  group by 1, 2, 3, 4)
select c.form_id, f.slug as form_slug, fv.version as form_version, c.day_on,
       case when c.n < 5 then 'other' else c.outcome_key end as outcome_key,
       sum(c.n)::int as completions
from c join forms f on f.id = c.form_id join form_versions fv on fv.id = c.form_version_id
group by 1, 2, 3, 4, 5;
