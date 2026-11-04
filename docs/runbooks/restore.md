# Runbook: restore the database

Owner: Sidestream (executes), BEAM owner (decides and is informed). Source: architecture section
10, platform spec PL-78. Targets: point-in-time restore RPO 1 minute, RTO 1 hour; full provider
loss RPO 24 hours, RTO 8 hours.

The database is never rolled back in place. A code problem is a `vercel rollback`
(`rollback.md`); a data mistake is repaired forward with a correcting job when it is small, and
restored from a branch only when it is large or unknown.

## Before you start

1. Open a security incident on `/admin/system/incidents` when personal data may be affected
   (`incident.md`), and note the time you start.
2. Decide the restore timestamp `T`: the last moment before the incident (UTC). Use the audit log
   (`/admin/system/audit`), Sentry and `webhook_events` to find it.
3. Tell BEAM (owner) what will happen and that writes after `T` will be lost until replayed.

## A. Neon point-in-time restore (within 7 days)

1. Neon console, project BEAM: create a branch `restore-<YYYYMMDD-HHmm>` from `production` at
   timestamp `T` (or `neon branches create --parent production@<T>`).
2. Run the smoke checks against the branch with its connection strings:
   `DATABASE_URL=<branch pooled> DATABASE_URL_UNPOOLED=<branch direct> pnpm db:check` and
   `pnpm --filter @beam/web exec vitest run test/smoke` (or the health check against a preview).
3. Put the maintenance message up (Vercel: promote the maintenance deployment, or set the flag
   your release uses) so no new writes reach the old branch.
4. In Vercel, production environment group: set `DATABASE_URL` and `DATABASE_URL_UNPOOLED` to the
   branch, then redeploy production (`vercel deploy --prebuilt --prod` or "Redeploy").
5. In Neon, set the restored branch as the default branch (keep the old one, renamed
   `production-pre-restore-<date>`, for 7 days for investigation).
6. Check `/api/health` (200, tick fresh within 3 minutes) and `/admin/system`.
7. Replay what arrived after `T`:
   - Mollie and Resend: in the provider dashboards, resend the webhooks received after `T`;
     `webhook_events` deduplicates on `(provider, external_event_id)`, so resending is safe.
   - Payments and orders created after `T`: compare the Mollie dashboard with `payments`; create
     missing rows through the normal flows, never by SQL.
   - Billit: compare invoices issued after `T` with `invoices`; finance's sync job reconciles.
8. Record the timeline and the result in the incident, and in the monthly report notes.

## B. Full Neon loss (restore from the daily dump)

1. Create a new Neon project in AWS eu-central-1 (Frankfurt), database `neondb`, the roles of
   `docs/plan/02-data-model.md` (including `beam_ai_ro` from R4).
2. Download the latest `beam-<date>.dump.age` from the Scaleway bucket (Paris).
3. Decrypt with the offline key: `age --decrypt -i <key file> beam-<date>.dump.age > beam.dump`.
4. `pg_restore --no-owner --dbname "$DATABASE_URL_UNPOOLED" beam.dump`.
5. `pnpm db:migrate` (no-op when the dump is current) and `pnpm db:check-migrations`.
6. Continue with steps A.2 to A.8 (smoke checks, env switch, redeploy, replay). Writes since the
   dump (up to 24 hours) are replayed from the provider dashboards.
7. Delete `beam.dump` and the decrypted copy from the machine you used.

## After the restore

- Rotate `DATABASE_URL` credentials if the incident involved credential exposure (`rotate-keys.md`).
- Run the restore drill checklist in `backup.md` once more within a week.
