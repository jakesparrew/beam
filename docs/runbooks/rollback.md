# Runbook: roll back a release

Owner: Sidestream. Source: architecture section 9.

## Code rollback (minutes)

1. Vercel, project BEAM, production: `vercel rollback` (or "Instant Rollback" on the previous
   production deployment). The previous build is live in under a minute.
2. The schema stays. Releases contain only expand steps (add table, nullable column, index,
   view), so the previous build runs on the new schema. Never run a down migration.
3. Check `/api/health` and `/admin/system` (tick age, dead jobs).
4. Revert the faulty commit on `main` with a PR (`git revert`), let CI pass, and deploy forward.
5. Note the rollback in the monthly report notes; open an incident when customers were affected.

## A feature, not a release

Switch its feature flag off on `/admin/settings/flags` (audited `flags.update`); flags resolve
within 60 seconds and no deploy is needed.

## Data mistakes

The database is never rolled back. A small, known mistake is repaired forward with a correcting
job or action (reviewed PR, audited). A large or unknown one follows `restore.md`.

## Jobs after a rollback

Jobs enqueued by the faulty release may be dead: handle them with `dead-jobs.md` after the fix is
deployed (retry, or discard with a reason).
