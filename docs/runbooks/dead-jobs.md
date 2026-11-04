# Runbook: dead jobs

Owner: Sidestream; BEAM technical_admin can do the same on `/admin/system/jobs`. Source: platform
spec PL-26 to PL-29a.

A job is `dead` after its 6th failed attempt, or at once on a `PermanentError`, an input that fails
its schema or an unknown kind. Every dead transition sends one Sentry event and one Slack line per
kind per hour (`slack:dead:<kind>:<hour>`). The nav entry "Jobs" shows the dead count.

## Triage

1. Open `/admin/system/jobs` (default filter: dead). Open the job: payload (secret keys redacted),
   result, last error and the attempt timeline from `integration_calls`.
2. Classify the cause:
   - **Transient provider failure** (timeout, 5xx, rate limit) that is over now: retry.
   - **Bug** in the handler: fix it, deploy, then retry.
   - **Bad data** (a deleted person, an input that will never be valid): discard with a reason, and
     repair the data forward if needed.
   - **Budget** (`budget` reason on AI jobs): raise `settings.ai` on `/admin/settings/ai` if BEAM
     agrees, then retry; otherwise discard.

## Retry

"Retry" (`retryJob`, permission `system.jobs`, audited `jobs.retry`) sets the job back to
`pending` with `run_at = now()`, gives it 3 more attempts and clears `on_dead_at`, so the owner's
`onDead` hook runs again if it dies again. The handler is idempotent: a retry never sends an email
or a payment twice (idempotency keys).

## Discard

"Discard" (`discardJob`) deletes the dead job after you type a reason; the audit row
`jobs.discard` keeps the kind, key and last error. Discard only when nothing should happen any
more.

## Many dead jobs of one kind

- Do not retry them one by one before the cause is fixed.
- After the fix, retry a single job first and watch it succeed, then the rest.
- If a provider was down, check `/admin/system/integrations` until calls succeed again.

Dead jobs are pruned after 90 days and succeeded jobs after 7 days (`jobs.prune`). The monthly
report counts dead jobs per month.
