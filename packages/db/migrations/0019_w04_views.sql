create or replace view v_automation_due as
select en.id as enrolment_id, en.automation_id, en.person_id, en.next_step_key, en.next_step_at
from automation_enrolments en join automations a on a.id = en.automation_id
where en.status = 'active' and a.status = 'active' and en.next_step_at <= now();
--> statement-breakpoint
create or replace view v_automation_stats as
with e as (select automation_id,
         count(*) filter (where status = 'active') as active_count,
         count(*) filter (where status = 'completed') as completed_count,
         count(*) filter (where status = 'exited') as exited_count,
         count(*) filter (where entered_at > now() - interval '7 days') as entered_7d
       from automation_enrolments group by automation_id),
     r as (select automation_id,
         count(*) filter (where outcome = 'sent') as sent_7d,
         count(*) filter (where outcome::text like 'skipped_%') as skipped_7d,
         count(*) filter (where outcome = 'failed') as failed_7d,
         max(occurred_at) as last_run_at
       from automation_runs where occurred_at > now() - interval '7 days' group by automation_id)
select a.id as automation_id, a.slug, a.status,
       coalesce(e.active_count, 0)::int as active_count, coalesce(e.completed_count, 0)::int as completed_count,
       coalesce(e.exited_count, 0)::int as exited_count, coalesce(e.entered_7d, 0)::int as entered_7d,
       coalesce(r.sent_7d, 0)::int as sent_7d, coalesce(r.skipped_7d, 0)::int as skipped_7d,
       coalesce(r.failed_7d, 0)::int as failed_7d, r.last_run_at
from automations a left join e on e.automation_id = a.id left join r on r.automation_id = a.id;
--> statement-breakpoint
create or replace view v_person_automation_timeline as
select r.id, r.person_id, r.occurred_at, r.outcome, r.step_key, r.reason, r.enrolment_id,
       a.slug as automation_slug, a.name as automation_name, en.end_reason,
       r.email_message_id, m.status::text as email_status, r.task_id
from automation_runs r join automations a on a.id = r.automation_id
left join automation_enrolments en on en.id = r.enrolment_id
left join email_messages m on m.id = r.email_message_id;
