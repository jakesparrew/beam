create or replace view v_consent_current as
select distinct on (person_id, purpose) person_id, purpose, status, lawful_basis, method, source,
       wording_version, recorded_at,
       case when status = 'granted' then recorded_at end as granted_at,
       case when status = 'withdrawn' then recorded_at end as withdrawn_at
from consent_records order by person_id, purpose, recorded_at desc, created_at desc, id desc;
--> statement-breakpoint
create or replace view v_declaration_current as
select distinct on (person_id, kind) person_id, kind, status, document_version_id, accepted_at, expires_at,
       (status = 'accepted' and (expires_at is null or expires_at > now())) as is_valid
from person_declarations order by person_id, kind, accepted_at desc, id desc;
--> statement-breakpoint
create or replace view v_open_tasks as
select t.*, (t.due_at < now()) as is_overdue,
       (t.due_at >= date_trunc('day', now() at time zone 'Europe/Brussels') at time zone 'Europe/Brussels'
        and t.due_at < (date_trunc('day', now() at time zone 'Europe/Brussels') + interval '1 day') at time zone 'Europe/Brussels') as is_due_today
from tasks t where t.status = 'open';
--> statement-breakpoint
create or replace view v_status_override_conflicts as
select p.id as person_id, p.status_override, s.derived_status, p.status_override_at, p.status_override_by_user_id
from persons p join v_person_status s on s.person_id = p.id
where p.status_override is not null and p.status_override::text <> s.derived_status::text
  and p.erased_at is null and p.merged_into_person_id is null;
--> statement-breakpoint
create or replace view v_suppression_status as
select p.id as person_id, pr.purpose,
  (exists (select 1 from suppressions s where s.email_hash = p.email_hash and (
      s.scope = 'all'
      or (s.scope::text = pr.purpose and not (s.reason = 'unsubscribe' and exists (
            select 1 from v_consent_current c where c.person_id = p.id and c.purpose::text = pr.purpose
              and c.status = 'granted' and c.method in ('form','portal','preference_centre')
              and c.recorded_at > s.created_at)))))
    or p.erased_at is not null or p.email is null or p.processing_restricted_at is not null) as is_suppressed
from persons p cross join (values ('newsletter'),('events'),('member_comms'),('b2b')) pr(purpose)
where p.merged_into_person_id is null;
