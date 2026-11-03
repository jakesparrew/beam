create or replace view v_ai_usage_month as
select date_trunc('month', created_at at time zone 'Europe/Brussels') as month, feature, model,
       count(*)::int as calls, sum(cost_cents) as cost_cents,
       sum(input_tokens)::bigint as input_tokens, sum(output_tokens)::bigint as output_tokens
from ai_requests group by 1, 2, 3;
--> statement-breakpoint
create or replace view v_integration_health as
select provider, count(*)::int as calls_24h,
       count(*) filter (where not ok)::int as errors_24h,
       max(created_at) filter (where ok) as last_ok_at,
       max(created_at) filter (where not ok) as last_error_at
from integration_calls where created_at > now() - interval '24 hours' group by provider;
--> statement-breakpoint
create or replace view v_job_stats as
select lane, status, count(*)::int as jobs,
       min(run_at) filter (where status = 'pending') as oldest_pending_run_at,
       max(finished_at) as last_finished_at
from jobs group by lane, status;
--> statement-breakpoint
create or replace view v_support_sla as
select id, reference, severity, status, received_at, response_due_at, first_response_at, resolved_at,
       coalesce(first_response_at, now()) > response_due_at as is_breached,
       extract(epoch from (first_response_at - received_at))::int / 60 as first_response_minutes
from support_requests;
