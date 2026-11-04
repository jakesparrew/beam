# Runbook: backups

Owner: Sidestream (operations), BEAM technical_admin (review). Source: architecture section 10,
platform spec PL-78, blueprint 67.

## What protects the data

| Mechanism | Frequency | Retention | Restore point (RPO) | Restore time (RTO) | Runbook |
| --- | --- | --- | --- | --- | --- |
| Neon point-in-time restore (Launch plan) | continuous (WAL) | 7 days | 1 minute | 1 hour | `restore.md`, section A |
| Off-provider dump (`backup.yml`) | daily at 02:30 UTC | 35 daily dumps, plus the dump of the 1st of each month for 12 months | 24 hours | 8 hours | `restore.md`, section B |

Files (invoices, receipts, imports, exports, rendered emails) live in Postgres (`files.bytes`), so
both mechanisms cover them. There is no separate file backup.

## The daily dump (`.github/workflows/backup.yml`)

1. Runs at 02:30 UTC on GitHub Actions with `DATABASE_URL_UNPOOLED` (the direct, non-pooled URL).
2. `pg_dump --format=custom --no-owner` of the production database `neondb`.
3. Encrypts the dump with `age` to `BACKUP_AGE_PUBLIC_KEY`. The private key is held offline by
   BEAM (owner) and by Sidestream, never in CI or Vercel.
4. Uploads `beam-<YYYY-MM-DD>.dump.age` to the Scaleway Object Storage bucket in Paris (fr-par),
   which is in BEAM's name. Lifecycle rules delete daily objects after 35 days; objects of the
   1st of the month carry the `monthly` tag and are kept 12 months.
5. Last step, always (also on failure):
   `pnpm --filter @beam/web exec tsx scripts/record-backup.ts --kind backup --ok <true|false> --note "run <run id>"`.
   It writes `settings.security.last_backup_at` / `last_backup_ok` (shown on
   `/admin/system/security`) and the audit row `backup.completed` that the monthly report counts.
6. A failed run posts to Slack `#beam-alerts`.

## Daily check (2 minutes)

- `/admin/system/security`: "Last backup" is from today and shows OK.
- On a failure: open the workflow log, fix the cause (expired token, bucket quota, network), and
  re-run the workflow by hand ("Run workflow"). `record-backup.ts` records the new result.

## Monthly check

- The monthly report (`/admin/system/reports`) lists backups OK and failed for the month. Any
  failed day that was not re-run is noted in the report notes.
- Check in the Scaleway console that the monthly object of the 1st exists.

## Quarterly restore drill

`restore-drill.yml` runs on the first Monday of each quarter: it downloads the latest dump,
decrypts it, restores it into a fresh Neon branch `restore-drill-<date>`, runs `pnpm db:check`
and the integration suite against it, posts the result to Slack, records it with
`record-backup.ts --kind restore_drill --ok <true|false>` and deletes the branch. The result shows
on `/admin/system/security` and in the monthly report. A failed drill is a `high` incident
(`incident.md`).

## Never

- Never store the `age` private key in the repository, CI secrets or Vercel.
- Never restore a dump over the production branch; always into a new branch (`restore.md`).
