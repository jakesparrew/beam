# Backup and recovery

This page answers the six backup questions of blueprint 67 (rule PL-78 in
[platform.md](../plan/modules/platform.md)). The day-to-day checks are in
[docs/runbooks/backup.md](../runbooks/backup.md); the restore steps are in
[docs/runbooks/restore.md](../runbooks/restore.md).

## What is backed up

Everything: the whole PostgreSQL database. Files (invoice PDFs, receipts, imports, exports,
rendered emails) are stored inside the database, so they are in every backup too. There is no
separate file store to forget.

## The two protections

| | Neon point-in-time restore | Daily encrypted dump |
| --- | --- | --- |
| **Frequency** | Continuous: every change is kept (the database's write-ahead log) | Once a day at 02:30 UTC (`.github/workflows/backup.yml`) |
| **Retention** | 7 days (Neon Launch plan; 30 days on the Scale plan) | 35 daily dumps, plus the dump of the 1st of each month for 12 months |
| **Location** | Neon, `aws-eu-central-1` (Frankfurt), in BEAM's Neon account | Scaleway Object Storage, `fr-par` (Paris), bucket in BEAM's name |
| **Protects against** | Mistakes and incidents in the last 7 days (wrong import, bad release, deleted data) | Losing Neon entirely, or a problem noticed after more than 7 days |
| **Data lost at most (RPO)** | 1 minute | 24 hours |
| **Time to recover (RTO)** | 1 hour | 8 hours |
| **Restore procedure** | [restore.md, section A](../runbooks/restore.md#a-neon-point-in-time-restore-within-7-days) | [restore.md, section B](../runbooks/restore.md#b-full-neon-loss-restore-from-the-daily-dump) |

The daily dump is made with `pg_dump --format=custom` over the direct connection
(`DATABASE_URL_UNPOOLED`) and encrypted with `age` before it leaves GitHub Actions. The public key
is in GitHub (`BACKUP_AGE_PUBLIC_KEY`). The private key is kept **offline** by BEAM's owner and by
Sidestream, never in the repository, CI or Vercel. Without the private key the dump cannot be read.

## Recovery responsibility

| Who | Does what |
| --- | --- |
| Sidestream's on-call founder | Decides a restore is needed, carries it out, and informs BEAM's product owner and technical_admin within 1 hour of the decision |
| BEAM's owner | Approves any restore that throws away data entered after the restore point |
| BEAM's technical_admin (George) | Checks the backup status on `/admin/system/security` and the monthly report; is informed of every restore |

## How a restore works, in short

1. Pick the moment just before the problem.
2. Create a **new** Neon branch at that moment (or, after a full loss, restore the latest dump into
   a new Neon project). Never restore over the live database.
3. Run the smoke checks against the new branch.
4. Point `DATABASE_URL` and `DATABASE_URL_UNPOOLED` in Vercel at the new branch and redeploy.
5. Make the new branch the default.
6. Replay payment and email webhooks received after the restore point from the provider
   dashboards, so no payment is missed.

The full checklist is [docs/runbooks/restore.md](../runbooks/restore.md). A code problem alone does
not need a restore: roll the code back instead ([deployment.md](deployment.md#rollback)).

## How we know backups work

- Every backup run records its result (`apps/web/scripts/record-backup.ts`). `/admin/system/security`
  shows "Last backup" and whether it was OK. A failed run posts to Slack.
- **Quarterly restore drill:** on the first Monday of each quarter, `.github/workflows/restore-drill.yml`
  restores the latest dump into a fresh branch, runs the checks and the integration tests against
  it, posts the result to Slack and deletes the branch. A failed drill is a `high` incident.
- The monthly report counts the backup runs (OK and failed) and shows the last restore drill.

## Never

- Never store the `age` private key in the repository, CI, Vercel or a chat.
- Never restore a dump over the production branch.
- Never roll the database back to undo a code release; the schema only grows, so the previous code
  runs on the new database.
