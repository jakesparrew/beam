# Database and data model

All BEAM data lives in **one PostgreSQL database on Neon**, in Frankfurt. Files such as invoice
PDFs and imports are stored in the same database, so one backup covers everything.

- **Every table, column, type, key, enum and view** is listed in the generated page
  [data-model.generated.md](data-model.generated.md). It is written from the code by
  `pnpm docs:schema` and checked by CI on `main` with `pnpm docs:schema --check`, so it cannot
  drift from the code.
- The reasoning behind each table is in [02-data-model.md](../plan/02-data-model.md) and in
  section 2 of each module spec in [docs/plan/modules/](../plan/modules/).

## The Neon project

| Item | Value |
| --- | --- |
| Provider and plan | Neon, Launch plan (pay per use) |
| Organisation | `org-fancy-meadow-65597173` (moves to, or is created in, BEAM's name; see [ownership-and-exit.md](ownership-and-exit.md)) |
| Project | `lingering-waterfall-91843473` |
| Region | `aws-eu-central-1` (Frankfurt) |
| PostgreSQL version | 18 |
| Production database | `neondb` on the default branch `production` (untouched until go-live) |
| Development database | `beam_dev`, used for the demo data and the end-to-end tests during the build |
| Compute | Autoscaling 0.25 to 2 compute units; production never suspends (`suspend_timeout = 0`) |

## Branches

A Neon **branch** is a full copy of the database that is ready in seconds and costs almost nothing
until it changes. The platform uses branches like this:

| Branch | Used for | Created by | Lifetime |
| --- | --- | --- | --- |
| `production` | Live data (`neondb`) | Neon (default branch) | Permanent |
| `staging` | The staging site; seed data until go-live, then an anonymised copy refreshed monthly | Sidestream, week 7 | Permanent, never suspended |
| `preview/pr-<n>` | One per pull request, for the preview deployment | `.github/workflows/preview-branch.yml` | Deleted when the pull request closes |
| `dev-<name>` | A developer's own copy (`neon checkout`) | Developer | Expires after 7 days (`neon.ts`) |
| `restore-drill-<date>` | The quarterly restore test | `.github/workflows/restore-drill.yml` | Deleted after the drill |
| Point-in-time branch | A restore to a moment before an incident | On-call founder, [docs/runbooks/restore.md](../runbooks/restore.md) | Becomes the new default after a restore |

## Pooled and direct connection strings

Each environment has two connection strings. Both require TLS (`sslmode=require`).

| Variable | Host | Used by | Why |
| --- | --- | --- | --- |
| `DATABASE_URL` | `...-pooler...neon.tech` (pooled) | The running application | Many short connections from Vercel functions share a small pool |
| `DATABASE_URL_UNPOOLED` | `...neon.tech` (direct) | Migrations, `pg_dump` backups, the restore drill, the exit export | These need one long, real session |

`DATABASE_DRIVER` picks how the code connects: `pg` (default, a normal Postgres pool on Vercel),
`neon-ws` (the same over WebSockets, for networks that block port 5432) or `pglite` (an in-memory
Postgres used by the automated tests). Tests never touch Neon.

## How the tables are organised

- **One file per module.** The tables of module `m` are in `packages/db/src/schema/m.ts`, its views
  in `m.views.ts`. The generated page groups everything by owning module.
- **Names.** Tables are plural snake case (`credit_entries`), views start with `v_`
  (`v_person_credits`), enums are named `<table>_<column>`.
- **Keys.** Every table has a `uuid` primary key. Customers also get a readable number
  (`C-000123`).
- **Money and time.** Amounts are integer cents in euro. Times are `timestamptz` in UTC.
- **Text in three languages** (product names, form labels, email blocks) is stored as JSON with
  one value per language.

### Append-only and immutable tables

Some tables hold facts that must never change. A database trigger refuses any update or delete
on them. Corrections are new rows, and totals and statuses are calculated in views.

- **Append-only (no update, no delete):** `activity_events`, `ai_requests`, `audit_log`,
  `automation_runs`, `automation_versions`, `consent_records`, `cookie_consents`, `credit_entries`,
  `email_events`, `imported_history`, `integration_calls`, `lightspeed_sales`, `membership_periods`,
  `order_lines`, `person_declarations`, `person_merges`, `price_versions`, `site_audit_reports`,
  `suppressions`, `terms_acceptances`, `watch_segments`, `webhook_events`, `webinar_interactions`,
  `webinar_moderation_actions` (list in `packages/db/src/schema/_shared.ts`, `APPEND_ONLY_TABLES`).
- **Immutable once published:** `automation_versions`, `consent_wordings`,
  `email_template_versions`, `form_versions`, `invoices`, `order_lines`, `page_versions`.
- The only way around the trigger is the GDPR erasure and retention jobs, which set
  `beam.allow_rewrite` for their own transaction.

Examples: a credit balance is `sum(quantity)` of `credit_entries` (view `v_person_credits`); the
current consent is the latest `consent_records` row per purpose (view `v_consent_current`); there
is no balance column and no consent flag to get out of step.

### Sensitive columns

Health-related data sits in exactly three places: `person_sensitive_fields`,
`form_sensitive_answers`, and `activity_events` rows marked `is_sensitive` (staff notes marked
sensitive). The values are encrypted with AES-256-GCM using the key `SENSITIVE_DATA_KEY_V<n>`
from the Vercel environment, so even someone reading the raw database sees only ciphertext. The
generated data model marks these columns as sensitive. Keys can be rotated
([docs/runbooks/rotate-keys.md](../runbooks/rotate-keys.md)).

## Migrations

The database shape is defined in TypeScript and turned into SQL migrations.

1. A developer changes `packages/db/src/schema/<module>.ts`.
2. `pnpm db:generate` writes a SQL migration into `packages/db/migrations/`. Views, the
   append-only triggers and the read-only AI role go into hand-written "custom" migrations in the
   same folder (`pnpm db:views`, `pnpm db:append-only` produce their SQL).
3. CI runs `pnpm db:check-migrations` (schema and migrations match) and `pnpm docs:schema --check`
   (the data model page is current).
4. On deploy, `.github/workflows/deploy.yml` runs `pnpm db:migrate` with `DATABASE_URL_UNPOOLED`
   before the new code goes live. Preview deployments migrate their own branch.

**Expand first, contract later.** A release only adds things: tables, nullable columns, indexes,
views. Dropping or renaming happens one release after the code stopped using the old shape. This
way the previous version of the app always works on the new database, and a code rollback never
needs a database rollback.

## Seeds

- `pnpm db:seed --profile defaults` writes the rows every environment needs (roles, settings,
  system templates, seeded automations). It is safe to run many times and runs after every deploy.
- `pnpm db:seed --profile demo` fills a fictitious demo centre for training and tests. It refuses to
  run when `APP_ENV = production`.

## Point-in-time restore and backups

Neon keeps a 7-day history of every change (the write-ahead log). Any moment in the last 7 days
can be opened as a new branch, with at most one minute of data lost. A daily encrypted dump is
also kept outside Neon. Details, retention and who does what are on [backup.md](backup.md); the
steps are in [docs/runbooks/restore.md](../runbooks/restore.md).

## Looking at the data safely

- For questions, prefer the back-office screens and the exports in `ops`; they apply permissions
  and never show sensitive values.
- For a technical look, use the Neon console's SQL editor **on a branch** (create one from
  `production`), never on production itself. Delete the branch afterwards.
- `pnpm db:check` runs a quick health check (connection, migrations applied) against the database
  in `DATABASE_URL`.
- Never paste personal data into a ticket, chat or AI tool. Use ids (`person_id`, `C-000123`).

## Size and growth

`platform.check_alerts` warns in Slack when the database grows past 8 GB, and when the files
stored in it pass 5 GB (a warning in the daily digest from 4 GB). The Neon Launch plan bills
storage per GB, so growth is visible early. Old data is removed by the retention rules
(`privacy.retention_sweep`, nightly at 01:00; see [business-rules.md](business-rules.md#privacy-and-retention)).
