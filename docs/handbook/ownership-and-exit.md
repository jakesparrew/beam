# Ownership and exit

**BEAM owns its data, its database, its code and every service account. BEAM is never locked in.**
This page lists what BEAM owns, every account with its owner and Sidestream's access, and the steps
to hand the platform over to BEAM or to another developer. It covers blueprints 68 to 70 and
section 10 of the [proposal](../requirements/proposal.md) (rule PL-92 in
[platform.md](../plan/modules/platform.md)).

## What BEAM owns

| Topic | Commitment |
| --- | --- |
| Data and database | Always BEAM's: customer, company, transaction, content and reporting data. Exportable at any time |
| Source code | BEAM's property after delivery and payment of each milestone |
| Repository | BEAM has access from the start. At delivery it moves to a GitHub organisation owned by BEAM |
| Sidestream's reusable building blocks | Stay Sidestream's; BEAM receives a permanent, free licence to use and change them, also by another developer |
| BEAM-specific work | BEAM's code, configuration, data and branding are never reused for anyone else |
| Hosting and service accounts | In BEAM's name from day one, paid directly by BEAM; Sidestream has administrator access to manage them |
| Another developer | Possible at any time: standard technology, documented in this handbook |

## Every account

The owner of every account is **BEAM** (Vibrant Lifestyle Collective BV). "Sidestream's access" is
what Sidestream needs to run and support the platform; it is removed at handover.

| Account | What it holds | Owner | Sidestream's access | Secrets it provides |
| --- | --- | --- | --- | --- |
| GitHub organisation | The code repository, CI workflows, GitHub secrets | BEAM | Members with write access; branch protection on `main` and `staging` | `NEON_API_KEY`, `VERCEL_TOKEN`, backup and deploy secrets |
| Vercel team (Pro) | The application, its deployments, environment groups, cron, firewall | BEAM | Team members (developer seats) | Environment groups for preview, staging, production |
| Neon organisation | The database project `lingering-waterfall-91843473` (Frankfurt), branches, point-in-time history | BEAM | Organisation admin | `DATABASE_URL`, `DATABASE_URL_UNPOOLED` |
| Resend | Email sending for `mail.beam.be` and `news.beam.be` | BEAM | Admin | `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET` |
| Mollie | Payments, terminal, membership mandates | BEAM (BEAM's own contract and IBAN) | Developer access (API keys, dashboard) | `MOLLIE_API_KEY`, `MOLLIE_WEBHOOK_SECRET` |
| Billit | Accounting, invoices, Peppol | BEAM (BEAM's subscription) | API user | `BILLIT_API_KEY`, `BILLIT_BASE_URL`, `BILLIT_PARTY_ID` |
| Anthropic | Claude API (organisation in BEAM's name, no training) | BEAM | Developer | `ANTHROPIC_API_KEY` |
| Sentry (EU) | Error tracking, project `beam-web` | BEAM | Admin | `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_AUTH_TOKEN` |
| Better Stack (EU) | Uptime monitors, heartbeat, on-call phone alerts | BEAM | Admin; the on-call founder's phone is on the escalation | `BETTERSTACK_HEARTBEAT_URL`, `BETTERSTACK_API_TOKEN`, `BETTERSTACK_MONITOR_ID` |
| Slack | BEAM's workspace and the `#beam-alerts` channel | BEAM | Members of the channel | `SLACK_WEBHOOK_URL` |
| Scaleway | The backup bucket in Paris (`fr-par`) | BEAM | Upload-only access key for the backup workflow | Scaleway keys (GitHub secrets) |
| Google (Cloud project, YouTube channel, Workspace) | Webinar streams and Meet (Release 2), Google Ads (Release 3) | BEAM | Project editor | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REFRESH_TOKEN`, `GOOGLE_ADS_TOKEN` |
| Meta Business Manager (Release 3) | Ad accounts (read-only) and the Messenger/Instagram inbox | BEAM | System user with read access | `META_ADS_TOKEN`, `META_APP_SECRET`, `META_VERIFY_TOKEN` |
| DNS for `beam.be` | Website and email domain records | BEAM (its DNS host) | Edit access to add records | none |

Also in BEAM's hands, outside any account:

- **The backup decryption key** (`age` private key): kept offline by BEAM's owner (and a copy by
  Sidestream while it supports the platform). Without it the backups cannot be read.
- **Platform secrets** generated for the app (`AUTH_SECRET`, `CRON_SECRET`,
  `SENSITIVE_DATA_KEY_V<n>`, `VOUCHER_CODE_SECRET`, `AUTOMATION_WEBHOOK_SECRET`): stored in the
  Vercel environment groups. The sensitive-data key is needed to read encrypted health fields; it
  must be kept with the database.
- **Staff accounts on the platform**: BEAM's owner holds the `owner` role and decides every other
  role ([roles.md](roles.md)).

How each account was set up, and in which week, is listed in section 7.2 of
[04-build-session.md](../plan/04-build-session.md#72-what-needs-real-credentials-and-a-human).

## What BEAM receives if the cooperation ends

1. A complete database export: the full database plus readable CSV files per table.
2. The full source code and repository (already in BEAM's GitHub organisation).
3. The technical documentation (this handbook, the runbooks, the plan) and the staff training
   guides.
4. All credentials and integration keys (already in BEAM's accounts).
5. Transfer of any account not yet in BEAM's name, to BEAM or to a party BEAM chooses.
6. Transition support to hand over to BEAM or the new developer.

The notice period is 3 months. Sidestream keeps the platform running and supported until the
handover is complete.

## The exit export

`pnpm exit:export` (script `apps/web/scripts/exit-export.ts`) makes the full export in one step. It
needs `DATABASE_URL_UNPOOLED` and an `age` public key of the receiver, and writes one encrypted
archive with:

- a `pg_dump --format=custom` of the whole database (restorable with `pg_restore` into any
  PostgreSQL 18);
- one CSV with a header row per table;
- sensitive columns still encrypted, with a note on which key (`SENSITIVE_DATA_KEY_V<n>`) opens them;
- a manifest of the tables and row counts.

BEAM can run it at any time, not only at exit. The daily backup is another full copy
([backup.md](backup.md)).

## Handover steps

Do these in order. Each step is done by BEAM's owner or technical_admin, with Sidestream's help
during the notice period.

1. **Agree the date** and who takes over (BEAM itself or a new developer). Keep the platform on the
   support terms until that date.
2. **Make the exit export** (`pnpm exit:export`) for the new party's public key, and check it can be
   restored into a fresh Neon branch.
3. **GitHub:** confirm the repository is in BEAM's organisation; add the new developer; remove
   Sidestream members; update `.github/CODEOWNERS`.
4. **Vercel:** add the new developer to the team; remove Sidestream's seats.
5. **Neon:** add the new developer as admin; remove Sidestream; create a new `NEON_API_KEY` for the
   preview workflow and replace the GitHub secret.
6. **Rotate every secret Sidestream could see**, following
   [docs/runbooks/rotate-keys.md](../runbooks/rotate-keys.md): database passwords, `AUTH_SECRET`,
   `CRON_SECRET`, provider API keys (Mollie, Resend, Billit, Anthropic, Slack webhook, Sentry,
   Better Stack, Google, Meta). Re-encrypt sensitive data with a new `SENSITIVE_DATA_KEY_V<n>` when
   needed (`security.rekey`).
7. **Backups:** generate a new `age` key pair for the new owner of the backups, put the new public key
   in GitHub (`BACKUP_AGE_PUBLIC_KEY`), and ask Sidestream to destroy its copy of the old private
   key. Keep the old private key at BEAM to read older dumps.
8. **Provider accounts** (Resend, Mollie, Billit, Anthropic, Sentry, Better Stack, Slack, Scaleway,
   Google, Meta, DNS): remove Sidestream users; add the new developer where needed.
9. **Monitoring:** move the Better Stack on-call phone escalation from Sidestream's founder to the
   new party.
10. **Platform users:** disable Sidestream's staff accounts on `/admin/settings/users` (audited).
11. **Knowledge:** walk the new party through this handbook, starting at [README.md](README.md), and
    through the open support requests on `/admin/system/support`.
12. **Close:** record the handover in the monthly report notes; check `/api/health` and
    `/admin/system` are green with the new keys.
