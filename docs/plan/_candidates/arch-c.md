# Architecture candidate C: operational simplicity

Angle: a platform that three people can run, monitor and hand over. Few moving parts, cheap to run, one way to do each thing, and everything BEAM staff can change is data, not code. Everything here stays inside `docs/plan/00-decisions.md`; where that file is silent, this file decides.

The shape in one paragraph: one Next.js app, one Postgres database, one cron tick, one `jobs` table, one `action()` wrapper around every server action, one `activity_events` stream, one versioning rule. Every outbound call is a job. Every fact is a row that is never edited. A new developer learns five things on day one: `action()`, `enqueue()`, `recordEvent()`, the minute tick, and the rule "a published row is immutable; editing makes a new row".

## 1. Monorepo layout

```
beam/
  apps/web/                          the only deployable (Vercel, fra1)
    app/(site)/[locale]/...          public website at /nl, /fr, /en
    app/(portal)/[locale]/account/   customer portal, installable PWA (Serwist, network-first, no offline writes)
    app/(admin)/admin/...            staff back-office (no locale prefix; locale from the user row)
    app/api/cron/tick/route.ts       the only cron entry point
    app/api/webhooks/{mollie,resend}/route.ts
    app/api/public/{claim,unsubscribe,preferences,files,health}/...
    modules/<module>/                actions.ts, queries.ts, api.ts (public surface), components/, nav.ts, seed.ts
    jobs/                            runner.ts, schedules.ts, handlers/<module>.ts
    messages/<locale>/<module>.json  UI strings, one file per module per locale
    e2e/<module>.spec.ts             Playwright
  packages/db/                       schema/<module>.ts, migrations/*.sql, migrate.ts, views/*.sql, seed.ts, enqueue()
  packages/core/                     src/<module>/: pure domain logic, zod schemas, enums. No DB, no React, no Next
  packages/email/                    templates/<module>/*.tsx (react-email), blocks-to-MJML renderer, resend client
  packages/integrations/             payments/ (PaymentProvider + mollie), billit/, youtube/, ads/, ai/; each ships fake.ts
  packages/ui/                       shadcn components, tokens, DataTable, FormField, LocalizedInput
  packages/config/                   eslint, tsconfig, tailwind, prettier presets
```

Modules, same names in every folder: `people`, `consent`, `segments`, `booking`, `waitlist`, `commerce`, `credits`, `membership`, `forms`, `email`, `automation`, `tasks`, `dashboard`, `finance`, `privacy`, `imports`, `site`, `system`, then `webinar` (R2), `b2b` (R3), `inbox` (R3), `ads` (R3), `ai` (R4).

Import rules, enforced by eslint `no-restricted-imports` in `packages/config`:

| Package | May import | Never imports |
| --- | --- | --- |
| `config` | nothing | anything |
| `ui` | `config` | `db`, `core`, Next server code |
| `core` | `zod`, `date-fns` | `db`, `email`, `integrations`, React |
| `db` | `core` (enums, zod types), `drizzle-orm`, `pg` | `email`, `integrations`, `web` |
| `email` | `core`, `react-email`, `mjml`, `resend` | `db` |
| `integrations` | `core`, provider SDKs | `db`, `email` |
| `apps/web` | everything above | another module's internals: only `modules/<m>/api.ts` and `@beam/core/<m>` are importable across modules |

Generated barrels (`packages/db/src/schema/index.ts`, `apps/web/jobs/registry.ts`, `apps/web/modules/nav.ts`, the messages index) are built by `pnpm gen` in `predev`, `prebuild` and `pretest`, and are git-ignored. Nobody hand-edits a shared list.

## 2. Core domain model

Conventions: tables snake_case plural, `id uuid default gen_random_uuid()` (except `activity_events.id bigserial`, used as a cursor), `created_at`/`updated_at timestamptz`, money as `_cents integer`, enums as Postgres enums named `<table>_<column>`, i18n text as `jsonb {"nl-BE","fr-BE","en"}`. APPEND = insert only, no UPDATE or DELETE grants for the app role. IMMUTABLE = a published row is never edited; editing inserts a new row with `version + 1` and the same `slug`.

People
- `persons`: email citext unique, first_name, last_name, phone, locale, address jsonb, birth_date, tags text[], status_override (lead|customer|member, null), status_override_reason, source jsonb {channel, campaign, medium, utm, referrer_person_id}, company_id → companies, company_role, external_ids jsonb, is_test_user, deleted_at. The only place identity lives.
- `activity_events` APPEND: person_id, type ('booking.created'), occurred_at, mode (live|replay|on_demand|null), sensitive bool, data jsonb, actor_user_id, ref_table, ref_id. Timeline and automation trigger source.
- `consent_records` APPEND: person_id, purpose (newsletter|events|member_news|b2b|assessment_result|sensitive_processing), status (granted|withdrawn), source, method, wording_version, created_at. Current consent = latest row per purpose.
- `suppressions` APPEND: email_hash (sha256 of lower-cased email), scope (all|newsletter|events|member_news|b2b), reason (unsubscribe|hard_bounce|complaint|deleted|manual), source, created_at. Checked at every marketing send; never deleted; imports cannot touch it.
- `companies`: name, vat_number, address jsonb, industry, size, owner_user_id, status. Persons point at it via `company_id`; one person is both B2C customer and B2B contact in one row.
- `deals`: company_id, person_id, stage (target|prospect|contact|outreach|response|qualified|discovery|proposal|negotiation|won|lost|account|renewal), value_cents, probability, expected_close_on, owner_user_id, next_action, next_action_at.
- `tasks`: owner_user_id, person_id, company_id, title, due_at, priority (low|normal|high), status (open|done|cancelled), source (manual|automation|retention).
- `segments`: name, kind (dynamic|static), rule jsonb, exclude_segment_ids uuid[], static_person_ids uuid[], last_count.

Booking (day sessions, nights, events and webinars share one engine)
- `session_templates`: kind (day|night|event|webinar), name i18n, weekday, start_local, duration_min, capacity, credit_cost, product_id, active_from, active_to. Admin edits regenerate future sessions.
- `sessions`: template_id, kind, title i18n, starts_at, ends_at, capacity (seats for day sessions and events, beds for nights), holds jsonb {staff, partner, host, speaker, blocked}, status (open|closed|cancelled), credit_cost, lead_magnet jsonb, claim_window_minutes, webinar jsonb {youtube_id, mode, replay_until, replay_limit, polls, ctas}. An event is a session of kind event.
- `bookings`: session_id, person_id, status (confirmed|cancelled|late_cancelled|no_show|attended), host_booking_id (guest of), credit_entry_id, order_line_id, ticket_product_id, booked_by_user_id, price_cents, cancelled_at, cancel_reason. Unique (session_id, person_id) while confirmed.
- `waitlist_entries`: session_id, person_id, queue (lead|customer|public), state (waiting|offered|confirmed|released|expired), joined_at, offered_at, expires_at, claim_token unique. Unique (session_id, person_id) while waiting or offered.

Commerce
- `products`: kind (session|night|package|membership|ticket|item|voucher), name i18n, description i18n, vat_rate (6|12|21), credit_kind (day|night, null), credits_granted, validity_days, sharing_defaults jsonb, session_id (tickets), recurring_interval (month|year, null), active.
- `prices` IMMUTABLE: product_id, audience (public|member|b2b), amount_cents (VAT included), valid_from, valid_to, version. A price change is a new row.
- `promotions`: code (null = automatic), kind (percent|fixed), value, applies_to jsonb, eligibility jsonb (segment rule), starts_at, ends_at, max_uses, uses, stackable.
- `orders`: person_id, company_id, channel (online|pos|link|recurring|manual), status (draft|pending|paid|failed|cancelled|refunded|partially_refunded), subtotal_cents, vat_cents, total_cents, promotion_id, client_key unique, abandoned_at, recovery_sent_at, paid_at.
- `order_lines` IMMUTABLE: order_id, product_id, price_id, description (snapshot), qty, unit_cents, vat_rate, vat_cents, discount_cents, total_cents, session_id, membership_id. The price snapshot.
- `payments`: order_id, provider (mollie|stripe|viva|cash|terminal|transfer), provider_ref unique, method, amount_cents, status (open|pending|paid|failed|expired|refunded), mandate_ref, raw jsonb, paid_at. Status only moves forward.
- `invoices`: kind (invoice|credit_note), number unique, order_id, person_id (null after deletion), company_id, legal_name_snapshot, lines jsonb, subtotal_cents, vat_cents, total_cents, issued_on, pdf_file_id, billit_id, billit_status (pending|synced|failed), refunds_invoice_id.
- `packages`: person_id (owner), product_id, order_line_id, credit_kind, credits_granted, starts_at, expires_at, sharing jsonb {mode: none|guests|named, max_guest_uses_per_month, allowed_person_ids}. The wallet; its balance is derived.
- `credit_entries` APPEND: package_id, person_id (beneficiary), delta int, kind (purchase|use|guest_use|refund_use|expiry|extension|adjustment|bonus|import), booking_id, order_line_id, reason, actor_user_id, created_at. Balance = sum(delta).
- `memberships`: person_id, product_id, status (active|past_due|cancelled|expired), starts_at, current_period_end, cancel_at, mandate_ref, price_cents, discount_percent.

Forms and assessments
- `forms` IMMUTABLE: slug, version, kind (form|assessment), status (draft|published|archived), name i18n, definition jsonb (fields, logic, scoring, outcomes, i18n), locales text[], published_at.
- `form_submissions`: form_id (the version row), person_id, status (started|partial|abandoned|completed), answers jsonb (non-sensitive fields only), score jsonb, outcome_key, utm jsonb, source, locale, result_token, completed_at.
- `sensitive_answers`: submission_id, person_id, field_key, ciphertext bytea, key_id. AES-256-GCM, key in Vercel env. Only `readSensitive()` reads it.

Email
- `email_templates` IMMUTABLE: slug, version, category (transactional|marketing), purpose, status, subject i18n, preheader i18n, blocks jsonb per locale, published_at.
- `campaigns`: template_id, segment_id, exclude_segment_ids, scheduled_at, status (draft|scheduled|sending|paused|sent|cancelled), recipients_count, sent_count, created_by.
- `messages`: person_id, to_email, locale, category, purpose, template_id, campaign_id, enrolment_id, subject, resend_id, status (queued|blocked_missing_translation|suppressed|sent|delivered|bounced|complained|failed), rendered_file_id (non-production only), sent_at. One row per email, transactional or marketing.
- `email_events` APPEND: message_id, type (sent|delivered|delayed|bounced|complained|opened|clicked), occurred_at, data jsonb, resend_event_id unique.

Automation
- `automations` IMMUTABLE: slug, version, name, status (draft|published|paused|archived), definition jsonb, published_at.
- `automation_enrolments`: automation_id, person_id, anchor_at, status (active|completed|exited), next_step_key, next_due_at, entered_at, ended_at, end_reason. The mutable cursor; one active per (slug, person).
- `automation_runs` APPEND: enrolment_id, person_id, automation_id, step_key, outcome (entered|sent|skipped_late_entry|skipped_condition|skipped_unreachable|skipped_paused|branched|task_created|exited|completed), reason, message_id, at. The per-person log.

Webinar (R2)
- `webinar_events` APPEND: session_id, person_id, mode (live|replay|on_demand), type (registered|started|heartbeat|poll_answer|cta_shown|cta_click|chat|ended), data jsonb, occurred_at. Live, replay and on-demand never mix because `mode` is on every row.

Platform
- `users`: email, password_hash, kind (staff|customer), role_key → roles, person_id (customers), totp_secret, mfa_enrolled_at, locale, is_test_user, partner_company_id, failed_logins, locked_until. Auth.js adapter tables are prefixed `auth_` (`auth_accounts`, `auth_sessions`, `auth_verification_tokens`).
- `roles`: key, name, permissions text[], is_system. Seeded with the nine roles; the owner edits them in the UI.
- `settings`: key, value jsonb, updated_by. Keys: booking_rules, business_hours, retention_rules, retention_table, feature_flags, ai, email_footer, timezone, automation_cursor, last_tick_at, warmup_schedule.
- `jobs`: kind, payload jsonb, key unique, lane (fast|bulk), run_at, status (queued|running|done|failed|dead), attempts, max_attempts, locked_at, locked_by, last_error, finished_at.
- `audit_log` APPEND: actor_user_id, actor_kind (staff|customer|system|job), action, entity, entity_id, before jsonb, after jsonb, ip, at.
- `files`: kind (invoice_pdf|import|export|image|rendered_email), name, mime, size, bytes bytea (max 10 MB), sha256, is_public, expires_at, person_id. No file vendor: files live in Postgres, so backup, branching and deletion cover them. If total volume passes 5 GB, move `bytes` to Neon Object Storage (Frankfurt) behind the same `files` row.
- `privacy_requests`: person_id, kind (export|delete|restrict), status (received|running|done|failed), requested_by, report jsonb, file_id, completed_at.

Outside the top 40: `pages` (site content blocks per locale, IMMUTABLE), `ad_insights` (R3), `inbox_threads` and `inbox_messages` (R3), `schema_migrations`.

Derived views (`packages/db/views/*.sql`, plain SQL views, applied after every migration; a view whose p95 passes 500 ms becomes a materialized view refreshed by `stats.rollup`):
- `v_person_status`: lead|customer|member from paid orders and active memberships, `coalesce(status_override, derived)`. A manual correction is never overwritten.
- `v_person_stats`: revenue_cents, purchases, visits, avg_order_cents, first/last purchase, first/last visit, last_activity_at, b2c_stage.
- `v_person_profile`: persons + status + stats + current consent per purpose + package balance; the segment compiler targets this view only.
- `v_package_balances` and `v_person_credits`: remaining credits per package and per person per kind; `status` active|exhausted|expired derived from balance and `expires_at`.
- `v_session_availability`: capacity minus holds minus confirmed bookings, per queue, with the lead-window opening time.
- `v_marketing_reachability`: person_id, purpose, reachable (consent granted, not suppressed, not deleted, email present).
- `v_retention_candidates`: rule-based list with a reason and a score, thresholds read from `settings.retention_rules`.
- `v_webinar_watch`: minutes watched per person per session per mode, with the 15-min, 30-min, 50 % and end flags.

## 3. Request and job model

Three entry points, one rule: a request never calls an external service. It writes rows and enqueues jobs inside the same transaction (transactional outbox). Jobs call the outside world.

1. Server actions. Every action is `action({ name, audience, permission, input, audit }, handler)`. The wrapper loads the session, checks the permission, parses input with zod, opens a transaction, exposes `ctx = { tx, user, person, locale, now, enqueue, recordEvent, audit }`, writes an audit row for staff writes, maps errors to `{ ok: false, error: { code: unauthorized|forbidden|validation|not_found|conflict|rate_limited|internal } }` and reports `internal` to Sentry.
2. Route handlers, all under `app/api/`: `cron/tick`, `webhooks/mollie`, `webhooks/resend`, `public/claim/[token]`, `public/unsubscribe/[token]`, `public/preferences/[token]`, `public/files/[id]`, `public/health`. A webhook handler verifies the signature, enqueues one job with the raw body as payload and the provider event id as key, and returns 200 within a second. The `jobs` table is the webhook inbox; no extra table.
3. Jobs. `defineJob('email.send', { lane: 'bulk', maxAttempts: 5, timeoutMs: 30_000 }, async (payload, ctx) => {...})` in `jobs/handlers/<module>.ts`. `enqueue(tx, { kind, payload, key, runAt?, lane? })` lives in `packages/db` so it can join any transaction.

Three synchronous exceptions, documented in code: `PaymentProvider.createPayment()` during checkout (the customer waits for the redirect URL), `PaymentProvider.terminalPayment()` at the POS counter (the receptionist waits for the terminal), and the interactive Claude question in the admin. Everything else is a job.

Idempotency keys are deterministic strings with a unique index: `email:{message_id}`, `billit:invoice:{invoice_id}`, `mollie:{payment_id}:{webhook_event_id}`, `campaign:{campaign_id}:chunk:{n}`, `automation:{enrolment_id}:{step_key}`, `schedule:{kind}:{YYYY-MM-DDTHH:mm}`. `enqueue` uses `ON CONFLICT (key) DO NOTHING`. Handlers are idempotent by design: they move statuses forward only and never rely on "did I run before".

Retry policy: attempts 1 to 5 wait 1 min, 5 min, 30 min, 2 h, 12 h. After the fifth failure the job is `dead`, Sentry gets the error, `#beam-alerts` gets one Slack line, and the admin System page shows it with a Retry button. A handler throws `NonRetryableError` to go to `dead` at once (invalid payload, 4xx from a provider). Jobs `running` for longer than 10 minutes are re-queued by the tick (attempt counted).

The one-minute tick. `vercel.json` has one cron: `{"path": "/api/cron/tick", "schedule": "* * * * *"}`. The route checks `Authorization: Bearer $CRON_SECRET`, sets `maxDuration = 120`, and runs:
1. Enqueue every entry in `jobs/schedules.ts` whose cron matches this minute (key `schedule:{kind}:{minute}`, so overlapping ticks cannot double-enqueue).
2. Loop until 50 seconds have passed: claim up to 20 `fast` jobs, then up to 5 `bulk` jobs, with `UPDATE jobs SET status='running', locked_at=now(), locked_by=$tick WHERE id IN (SELECT id FROM jobs WHERE status='queued' AND run_at <= now() AND lane=$1 ORDER BY run_at LIMIT $2 FOR UPDATE SKIP LOCKED) RETURNING *`. Run fast jobs with concurrency 5, bulk with concurrency 2.
3. Write `settings.last_tick_at`. `/api/public/health` fails when that is older than 3 minutes, which is the single "is the platform alive" signal.

Schedules (Europe/Brussels, all defined in `jobs/schedules.ts`): `waitlist.expire_offers` and `automation.evaluate` every minute; `orders.mark_abandoned` every 10 min; `billit.sync_pending` every 15 min; `privacy.retention_sweep` 01:00; `files.purge_expired` 02:00; `sessions.materialise` 03:10 (90 days ahead); `stats.rollup` 04:00; `ads.pull` 05:30; `memberships.renew` 06:10; `packages.expire` 00:05; `system.daily_digest` 08:00 to Slack; `ai.weekly_summary` Monday 06:30 (R4). Done jobs are deleted after 7 days, dead jobs after 90.

Long work is chunked, never looped in one function:
- Campaign send. `campaign.start` resolves the segment against `v_person_profile`, inserts `messages` rows (status queued) in batches of 1,000, then enqueues `campaign.send_chunk {campaign_id, offset}` per 500 messages on the `bulk` lane. A chunk renders each message, re-checks `suppressions` and `v_marketing_reachability` at that moment, and calls Resend's batch endpoint 100 at a time at 2 calls per second. 50,000 contacts = 100 chunks, finished in about 15 minutes of ticks. Pausing a campaign sets `status = paused`; chunks see it and exit; unsent messages stay queued.
- Imports. The CSV goes into `files`; `imports.run {file_id}` parses 500 rows per job and enqueues itself with the next offset; a dry run writes the report and changes nothing. Rows carry `external_ids`, so re-running is safe.
- Exports, deletions, session materialisation and Billit backfills use the same self-continuation pattern.

## 4. Auth and permissions

One Auth.js v5 setup, database sessions, Drizzle adapter, `users.kind` separates the two audiences. Staff sign in with email, password (zxcvbn score 3 or more, 12 characters minimum) and TOTP (otplib, 10 recovery codes); a staff user without MFA is forced to `/admin/mfa/setup` before anything else. Ten failed logins lock the account for 15 minutes. Staff sessions last 12 hours. Customers use a magic link sent through `mail.beam.be` (5 per address per hour, counted from `activity_events` of type `auth.magic_link_sent`) and may set a password afterwards; customer sessions last 90 days. `middleware.ts` sends `/admin/*` through the staff check and `/account/*` through the customer check. A customer `users` row points at exactly one `persons` row, and every portal query filters on that `person_id`.

Permissions are strings `module.verb`: `persons.read`, `persons.write`, `persons.sensitive.read`, `persons.merge`, `persons.export`, `bookings.read`, `bookings.write`, `bookings.override`, `waitlist.manage`, `commerce.sell`, `commerce.refund`, `pricing.write`, `credits.adjust`, `memberships.write`, `forms.publish`, `email.write`, `email.send`, `campaigns.send`, `automations.publish`, `deals.write`, `tasks.write`, `finance.read`, `invoices.write`, `dashboards.management`, `settings.write`, `users.manage`, `system.jobs`, `privacy.run`, `ai.use`, `partner.own`.

Default role sets, seeded in `roles` and editable by the owner:
- owner: everything.
- management: everything except `users.manage`, `system.jobs`, `privacy.run`.
- customer_service: persons.read/write/sensitive.read/merge, bookings.read/write, waitlist.manage, credits.adjust, memberships.write, tasks.write, email.write.
- sales: persons.read/write, bookings.read, deals.write, tasks.write, commerce.sell, ai.use.
- marketing: persons.read, forms.publish, email.write, email.send, campaigns.send, automations.publish, tasks.write, ai.use.
- finance: persons.read, finance.read, invoices.write, commerce.refund, pricing.write, dashboards.management.
- reception: persons.read/write, bookings.read/write, waitlist.manage, commerce.sell, tasks.write.
- tech_admin: persons.read, settings.write, users.manage, system.jobs, privacy.run.
- partner: partner.own only, scoped by `users.partner_company_id` to their own holds, referrals and counts; no customer PII.

Sensitive data (health, sleep, stress, recovery, wellbeing) lives in exactly two places: `sensitive_answers` and `activity_events` rows with `sensitive = true` (notes). Form fields are marked `sensitive: true` in the definition and are routed to `sensitive_answers` at submit time. The one reader is `readSensitive(ctx, personId, purpose)`: it requires `persons.sensitive.read` (or the system actor with purpose `privacy_export`), decrypts, and writes `audit_log` action `sensitive.viewed`. The timeline, segments, exports, AI context and Sentry never call it. Ordinary columns on `persons` carry no health data by rule, and a unit test asserts that the AI context builder and the segment field catalogue contain no sensitive column.

Check in code: `action({ name: 'bookings.cancel', audience: 'staff', permission: 'bookings.write', input: CancelBooking }, async (ctx, input) => ...)`. The wrapper refuses before the handler runs; a handler that needs a second permission calls `ctx.require('bookings.override')`. Server components call `requirePermission()` from `modules/system/auth.ts` and hide navigation through the same list, so UI and server agree by construction.

## 5. Multi-language

- Person locale is `persons.locale`, required, set from the form or the browser's `Accept-Language` on first contact, default `nl-BE`. Every email and portal page uses it; the admin uses `users.locale`.
- UI strings: `apps/web/messages/<locale>/<module>.json`, `en` is the source of truth. `pnpm i18n:check` fails CI when any key is missing in `nl-BE` or `fr-BE`. The admin shows `[module.key]` for a missing key in development; production never ships with one.
- Content (products, sessions, forms, templates, pages, email blocks) uses `LocalizedText` jsonb columns edited with `LocalizedInput`, which shows three tabs and a completeness badge.
- `t(localized, locale)` has two modes. In admin previews it returns `⟦missing nl-BE⟧`. In send and render paths it throws `MissingTranslationError`.
- Publishing a form, template, automation or page checks completeness for its `locales` (default all three). A definition may declare fewer locales; recipients outside them are reported at recipient resolution and skipped with `skipped_unreachable` and reason `locale`.
- At send time `renderEmail(templateRow, locale)` either succeeds or marks the message `blocked_missing_translation`; nothing is sent in another language, and the daily digest lists blocked messages. Dates, times and amounts are formatted with `Intl` in `Europe/Brussels` and the person's locale. The legal footer for Vibrant Lifestyle Collective BV is one `settings.email_footer` entry per locale.

## 6. Money, credits and pricing

- Integer cents, EUR, VAT included in `prices.amount_cents`. VAT rate sits on the product (6, 12 or 21) and is copied to the line: `vat_cents = round(total_cents * rate / (100 + rate))`, half-up, per line. B2B invoices show the same lines excl. VAT.
- `quote(lines, ctx): Quote` in `core/commerce/pricing.ts` is pure: `ctx = { personStatus, isMember, membershipDiscountPercent, promotionCode, audience, at }`. It picks the price row valid at `at` for the audience, applies the member discount automatically (no code), then at most one promotion (`stackable` promotions add), and returns lines with `price_id`, discounts and a reason per discount. Checkout stores exactly what `quote()` returned. Historical orders never change because `prices` rows are immutable and `order_lines` carry the snapshot.
- Order flow: checkout action creates `orders (status pending, client_key)` plus lines, calls `createPayment` and redirects. `payments.sync {provider_ref}` runs from the Mollie webhook, fetches the payment from Mollie (that fetch is the verification) and, when paid, in one transaction: order `paid`, `credit_entries kind purchase`, membership `active`, bookings `confirmed`, invoice row with the next number, `activity_events order.paid`, jobs `billit.push_invoice`, `email.send` (receipt). The return page polls `getOrderStatus` every 2 s for 30 s and reads only the database. `client_key` makes a double submit harmless.
- Credits: two kinds, `day` and `night`, one unit per session by default (`sessions.credit_cost` can be 2 for a special session). A package is a wallet with `credits_granted` and `expires_at`; balance = `sum(delta)` of its entries. `allocateCredits(packages, kind, needed)` is pure: earliest expiry first, matching kind, sharing rules satisfied. Expiry is a job that inserts `kind expiry, delta = -remaining` at `expires_at`. An extension updates `packages.expires_at`, logs `kind extension, delta 0` and an audit row. Staff adjustments are `kind adjustment` with a mandatory reason. The customer sees "4 sessions remaining"; the word credit never appears in the portal.
- Package VAT: a package has one VAT rate, so night packages are separate products at 6 % and day packages at 21 %. Mixed packages do not exist in V1.
- Memberships: a membership product has `recurring_interval`; the first payment creates a Mollie mandate; `memberships.renew` creates the renewal order and a mandate payment 3 days before `current_period_end`; a failed payment sets `past_due` and enqueues the dunning automation; `v_person_status.is_member` drives member pricing and member-only sessions.
- Package sharing: `packages.sharing` from product defaults, editable per package by staff. A guest booking is its own `bookings` row with `host_booking_id`, and its credit entry has `person_id = guest`, `package_id = owner's`, `kind guest_use`, so the relationship stays visible on both timelines. Limits: `max_guest_uses_per_month` (default 2); a package with more than 3 distinct guests in 30 days appears on the action dashboard for review.
- Invoices and credit notes are rows in `invoices`, numbered from two never-resetting sequences: `INV-2026-000123`, `CN-2026-000045`. A refund creates the credit note, enqueues `payments.refund` and inserts `credit_entries kind refund_use` reversals. BEAM owns the numbers; Billit receives finished invoices and acts as accounting and Peppol layer.
- POS: `orders.channel = pos`, paid by `terminal` (Mollie Terminal API), `cash` or `transfer`; receipt PDF in `files`. Food and drink are not sold through the platform; merchandise is a product of kind `item` without stock tracking in V1.

## 7. Automation engine

A definition is JSON on a published, immutable `automations` row:

```json
{ "trigger": { "event": "webinar.registered", "where": { "session.kind": "webinar" } },
  "anchor": "session.starts_at", "audience": { "segment": "leads" }, "exclusion_group": "lead_nurture",
  "re_entry": "after_days:90", "exit_on": ["order.paid", "consent.withdrawn:newsletter", "booking.created"],
  "steps": [
    { "key": "confirm", "type": "email", "template": "webinar-confirm", "at": { "from": "enrolment", "minutes": 0 } },
    { "key": "d7", "type": "email", "template": "webinar-7d", "at": { "from": "anchor", "minutes": -10080 } },
    { "key": "d1", "type": "email", "template": "webinar-1d", "at": { "from": "anchor", "minutes": -1440 },
      "unless": { "has_future_booking": true } },
    { "key": "task", "type": "task", "title": "Call webinar lead", "owner_role": "sales", "at": { "from": "anchor", "minutes": 2880 } } ] }
```

Step types: `email`, `wait`, `condition` (branch), `task`, `tag`, `status_override`, `enrol`, `exit`, `notify_slack`, `set_field`, `webhook`. These are the building blocks of the R4 workflow builder; R4 adds the visual editor, not a new engine.

- Enrolment. `automation.evaluate` runs every minute, reads `activity_events` after `settings.automation_cursor`, and matches triggers of published automations. For each match it checks: audience segment, `re_entry`, no active enrolment in the same `exclusion_group` (otherwise `skipped` with reason `excluded_group`; the newer automation can declare `exclusion_policy: replace` to exit the older one). It then inserts the enrolment, computes `due_at` for every step from `enrolment` or `anchor`, and immediately logs `skipped_late_entry` for every step whose `due_at` is already more than 5 minutes in the past. A Friday registration for a Sunday webinar gets `confirm` and `d1` only, and the log says why.
- Exits. The same evaluator matches every new event against `exit_on` of active enrolments and ends them with `exited` and the reason (`order.paid`, `unsubscribed`, `manual`, `deleted`). A purchase ends lead nurture; a membership ends the newcomer sequence; unsubscribing ends every marketing enrolment.
- Send-time evaluation. When `next_due_at` is reached the evaluator re-checks, in order: enrolment active, automation not paused, step `unless` conditions, `v_marketing_reachability` for the template's purpose, translation available. It then inserts the `messages` row and enqueues `email.send` on the `fast` lane with key `automation:{enrolment_id}:{step_key}`. `email.send` checks `suppressions` once more just before calling Resend, so an unsubscribe stops marketing within one tick.
- Pause and resume. A paused automation evaluates nothing. On resume, steps overdue by more than 24 hours are logged `skipped_paused`; the rest are sent.
- Staff controls: exit a person (`manual`), enrol a person into any published automation, move between journeys (exit then enrol, one action, one audit row), preview the next steps per person. All appear on the timeline.
- Retention lists, package thresholds (50, 75, 80, 90 %, last session) and inactivity (30, 60, 90 days) are events too: `stats.rollup` emits `package.threshold_reached` and `person.inactive_days` events once per threshold, so they trigger automations like any other fact.

## 8. Integration boundaries

| Service | Where called | Package | Idempotency and verification | Failure surfaces as |
| --- | --- | --- | --- | --- |
| Mollie | Sync: `createPayment` in checkout and `terminalPayment` at the POS; jobs: `payments.sync`, `payments.refund`, `memberships.renew`, `payments.create_link` | `integrations/payments` (`PaymentProvider` interface, `mollie.ts`, `fake.ts`) | Webhook carries only an id; we fetch the payment by id; `payments.status` moves forward only; `orders.client_key` | Payment row stays `open`; return page says "payment pending, we email you"; dead job alert; failed renewals on the action dashboard |
| Billit | Jobs `billit.push_invoice`, `billit.push_customer`, `billit.sync_pending` (15 min, pulls paid status of transfer invoices) | `integrations/billit` | Key `billit:invoice:{id}`; Billit id stored on the row before any second push | `invoices.billit_status = failed`, Finance page backlog badge, High alert after 1 hour of failures; invoices stay valid without Billit |
| Resend | Job `email.send` (single) and `campaign.send_chunk` (batch); webhook `/api/webhooks/resend` (Svix signature) | `packages/email` | Key `email:{message_id}`; `resend_event_id` unique on events | Bounce and complaint insert `suppressions`; bounce rate above 3 % in 24 h alerts; blocked messages in the digest |
| YouTube | Browser only: IFrame Player API on the webinar page; heartbeats go to our own server action every 15 s | `integrations/youtube` (player wrapper, simulive offset `seekTo(now - starts_at)`) | No server calls, no API key | Player error shows a fallback link to the unlisted stream |
| Meta, Google Ads | Job `ads.pull` daily, read-only | `integrations/ads` | Upsert on (platform, campaign_id, date) | Dashboard shows "data as of"; Normal alert after 3 failed days |
| Claude | Jobs `ai.draft_email`, `ai.draft_reply`, `ai.classify`, `ai.weekly_summary`; sync for the admin NL question | `integrations/ai` (`@anthropic-ai/sdk`) | Every call logged in `audit_log` as `ai.call` with field names, tokens and cost; monthly budget in `settings.ai.monthly_budget_cents` (default 10000) | AI panels show "unavailable"; no operational flow depends on AI |
| Slack | Job `notify.slack` | `integrations/slack` (one incoming webhook) | Key per alert fingerprint per hour | Sentry remains the fallback channel |

Claude specifics: `claude-opus-5-5` for drafting and analysis, `claude-haiku-5-5` for classification; stable system prompts marked with `cache_control` so repeated calls are cheap; classification and the weekly summary use structured outputs (`output_config.format` with a zod-derived JSON schema) and the Message Batches API at night; `toAiContext(person)` is a whitelist of 18 fields (first_name, locale, status, is_member, b2c_stage, tags, source.channel, first_visit_at, last_visit_at, visits, purchases, revenue_cents, credits_remaining, package_expires_at, membership_period_end, next_booking_at, open_tasks, granted_purposes) and never touches `sensitive_answers`, sensitive events, notes, email addresses or phone numbers; the natural-language BI feature (R4) lets Claude write SQL that runs under a read-only Postgres role `beam_ai_ro` with `statement_timeout = 5s` against the `ai` schema, which exposes only the non-sensitive views of section 2. Humans approve every draft before anything is sent.

## 9. Environments and delivery

| Environment | App | Database | Data | Secrets |
| --- | --- | --- | --- | --- |
| local | `pnpm dev` | Neon branch `dev-<name>` via `neon checkout dev-<name> --create` (7-day TTL from `neon.ts`) | seed | `.env.local` from `neon env pull`; Mollie test key; `EMAIL_SINK=test@beam.be` |
| preview | Vercel preview per PR | Neon branch `preview/pr-<n>`, created from `staging` by a GitHub Action, deleted on PR close | seed | preview env group |
| staging | Vercel environment `staging`, branch `staging` | Neon branch `staging`, never suspended | seed before go-live; after go-live an anonymised copy refreshed monthly by `pnpm db:anonymise` | staging env group, Mollie test, Billit sandbox |
| production | `main` | Neon default branch `production`, 0.25 to 2 CU autoscaling, `suspend_timeout = 0` | real | production env group only |

Outside production, `EMAIL_SINK` rewrites every recipient to one mailbox and stores the rendered HTML in `files` for preview; `PaymentProvider` uses Mollie test mode; Billit uses the sandbox; AI calls run with a daily cap of 200.

Feature flags: `settings.feature_flags = { "webinars": "test_users" }` with states `off`, `test_users`, `on`; `users.is_test_user` and `persons.is_test_user` mark the testers. `flag('webinars', ctx)` is the one helper, cached for 60 seconds. BEAM switches a flag to `on` from the admin; no deploy needed.

Migrations: hand-written SQL in `packages/db/migrations/<YYYYMMDDHHmm>_<module>_<name>.sql`, applied in lexical order by `packages/db/migrate.ts` (recorded in `schema_migrations`), drafted with `drizzle-kit generate` and moved into the timestamped file. Views are re-applied after every migration run. Rules: expand/contract only (add nullable columns, backfill with a job, drop in a later release), no renames, and every migration must run against a fresh branch of `staging` in CI. The Vercel build command is `pnpm db:migrate && pnpm build` with the unpooled connection string, so a schema change is live before the code that needs it.

GitHub Actions, all in `.github/workflows/`: `ci.yml` (every PR), `preview-branch.yml` (creates and deletes the Neon preview branch), `backup.yml` (nightly dump), `restore-drill.yml` (quarterly), `anonymise-staging.yml` (monthly, after go-live). Five workflows, no other CI system.

Rollback: Vercel instant rollback to the previous deployment (one click, under a minute); the previous build still works because migrations are backward compatible. Data mistakes are repaired by a Neon point-in-time branch (section 10). Releases are tagged `v2026.11.07` and the changelog is the merged PR list.

## 10. Observability, backup, restore, security

What we watch, where, and who hears about it:

| Signal | Source | Threshold | Alert |
| --- | --- | --- | --- |
| Platform alive | Better Stack hits `/api/public/health` every minute (DB query + last tick age + dead job count) | tick older than 3 min or DB down | Slack `#beam-alerts` plus phone call to the on-call founder |
| Errors | Sentry (EU), server and client, release = git SHA, `beforeSend` strips emails and names | new issue or spike | Slack |
| Dead jobs | `jobs` | any dead job; queue depth above 500 for 10 min | Slack, admin System page |
| Email | `email_events` | bounce rate above 3 % or complaint rate above 0.1 % in 24 h | Slack |
| Billit backlog | `invoices.billit_status` | failed for 1 hour | Slack (High) |
| Payments | `payments` | 3 failed renewals in a day, or a Mollie webhook silence of 24 h while orders were created | Slack, action dashboard |
| Daily digest | `system.daily_digest` 08:00 | always | Slack summary: sends, bounces, dead jobs, blocked translations, backlog, DB size |

Logs are structured JSON (`logger.info({ job, id, ms })`) in Vercel logs; no log vendor in V1. The admin System page shows jobs by status, last tick, blocked messages, sync backlogs, ads data age and DB size, so BEAM's tech_admin sees the same picture Sidestream does.

Backup and restore:
- Neon point-in-time restore window: 7 days on the Launch plan. RPO 1 minute, RTO 1 hour. Procedure (`docs/runbooks/restore.md`): create a branch from the timestamp just before the incident, run the integration smoke test against it, point `DATABASE_URL` and `DATABASE_URL_UNPOOLED` at it in Vercel, redeploy, promote the branch to default.
- Off-provider dump: a GitHub Action at 02:30 UTC runs `pg_dump --format=custom`, encrypts with `age`, and uploads to a Scaleway Object Storage bucket in Paris (EU); daily dumps kept 35 days, the first of each month kept 12 months. If Neon is lost entirely: RPO 24 hours, RTO 8 hours (new Neon project, `pg_restore`, env switch). Cost about €1 per month.
- Restore drill: a GitHub Action on the first Monday of each quarter restores the latest dump into a fresh branch and runs the integration suite; the result goes to Slack and into the monthly report.
- Files live in Postgres, so both mechanisms cover invoices, imports and exports.

Security controls: TLS everywhere, HSTS, CSP and frame restrictions in `next.config` headers; TOTP for every staff account; password rules above; Vercel WAF rate limits on `/api/*`, `/login` and `/account/login` (60 requests per minute per IP); webhook signature checks; server actions protected by Next's origin check plus the `action()` permission gate; `sensitive_answers` encrypted with AES-256-GCM under `SENSITIVE_DATA_KEY` (key id stored with the ciphertext, rotation documented); the app connects as `beam_app`, which has no DELETE or UPDATE grant on APPEND tables; `beam_ai_ro` for AI SQL; secrets only in Vercel env groups, rotated yearly, listed by name in `.env.example`; Renovate weekly plus `pnpm audit` in CI; no PII in Sentry or logs (ids only); audit rows for every staff write and every sensitive read; Sidestream's periodic ethical-hacking test before go-live and every quarter after.

Monthly running cost at 2,000 active clients: Neon about $45 (production never suspends), Vercel $20, Resend $20, Sentry free tier until 5,000 events then $26, Better Stack free tier, Scaleway €1, Claude $30 to $60. Inside the proposal's $120 to $225 range.

## 11. How AI agents build this in parallel tonight

Hour 0 to 1, one scaffold agent, nobody else writes code yet. It produces: the monorepo with all seven packages and configs; `packages/db` with migration `202611032100_system_init.sql` creating the 40 tables of section 2 plus `pages`, the `auth_` tables and `schema_migrations`, with enums, indexes and views, plus `migrate.ts`, `enqueue()`, `seed.ts`; `action()`, `recordEvent()`, `audit()`, `readSensitive()`, `flag()`, `t()`; Auth.js with both audiences and TOTP; the jobs runner, tick route and `schedules.ts`; the three app shells with navigation generated from `modules/*/nav.ts`; i18n loader and `i18n:check`; `packages/integrations/*/fake.ts` for Mollie, Billit, Resend, Claude; test fixtures in `packages/db/test/fixtures.ts` (`createPerson`, `createSession`, `createProduct`, `createPackage`); CI (typecheck, lint, unit, integration on a fresh Neon branch, `i18n:check`, migrations check); `CONVENTIONS.md`; and a `modules/_template` folder that every module copies. The schema in migration 0001 is the contract: tonight's agents add columns through their own timestamped migrations and never rename or drop.

Hour 1 onward, nine module agents in parallel, each on branch `agent/<group>` and its own Neon branch `agent-<group>`, with a strict ownership map. An agent writes only inside its folders:

| Agent | Modules | Owns `core/src`, `modules/`, `jobs/handlers/`, `messages/*/`, `email/templates/`, `db/migrations/*_<module>_*`, `seed` for | Seed prefix |
| --- | --- | --- | --- |
| A | people, consent, segments | persons, timeline, consent, suppression, duplicates, merge, segment compiler, preference centre | 10 |
| B | booking, waitlist | templates, sessions, capacity, bookings, guests, cancellation rules, waitlist with claim links, portal booking pages | 30 |
| C | commerce | products, prices, promotions, `quote()`, checkout, Mollie adapter, POS, abandoned checkout | 20 |
| D | credits, membership | packages, ledger, allocation, expiry, sharing, memberships, renewals, portal balance pages | 25 |
| E | forms | builder, logic, scoring, result pages, sensitive routing, submissions, lead capture with UTM, site embed | 40 |
| F | email | block editor, MJML renderer, templates, transactional set, campaigns, chunked sending, Resend webhooks | 50 |
| G | automation, tasks, dashboard | evaluator, definitions, retention rules, action dashboard, tasks, management dashboard v1 | 60 |
| H | finance, privacy, imports | invoices, credit notes, Billit, exports, deletion workflow, retention sweep, CSV importers | 70 |
| I | site, system | public website pages, SEO, `pages` editor, admin System page, settings UI, roles UI, users UI | 80 |

Cross-module calls go only through `modules/<m>/api.ts` and `@beam/core/<m>`; data coupling prefers `recordEvent()` on the write side and the views on the read side over function calls. If an agent needs a column in another agent's table, it adds an additive migration named for its own module and posts the reason in the PR; the owner reviews. If two agents need the same new table, the later one uses the earlier migration.

Naming conventions, written in `CONVENTIONS.md`: events `noun.verb_past` (`booking.created`), job kinds `module.verb_noun` (`email.send`), permissions `module.verb`, server actions `verbNoun` in `actions.ts`, queries `getX`/`listX` in `queries.ts`, zod schemas `PascalCase` next to the action, files kebab-case, tests next to code as `*.test.ts`, migrations `<timestamp>_<module>_<name>.sql`, branches `agent/<group>`, commits and PR titles `<module>: <summary>`, template slugs kebab-case, settings keys snake_case.

Test strategy that keeps parallel work safe:
1. `pnpm check` (typecheck across the workspace, lint, unit) must pass before any PR; the workspace typecheck is the first seam test, because every module compiles against the same schema and `api.ts` surfaces.
2. Core logic is pure and unit-tested in `packages/core` without a database: pricing, allocation, step scheduling, late-entry skip, segment compilation, consent resolution. These run in seconds.
3. Integration tests use the shared fixtures and run against the agent's own Neon branch; each test wraps a transaction and rolls back; CI creates `ci-<sha>` from `staging` schema-only and drops it after.
4. External services are never mocked ad hoc: tests use the `fake.ts` adapters shipped by the scaffold, so Mollie, Billit, Resend and Claude behave the same in every module's tests.
5. A tenth integration agent runs last: merges in the order A, C, D, B, E, F, G, H, I, runs the full suite, writes the Playwright specs for the seven scenarios and the V1 acceptance list in `apps/web/e2e/`, and fixes seams. Nothing merges to `main` with a red suite.
6. `pnpm gen` barrels, `i18n:check` and the migrations check run in CI, so a missing translation, an unregistered job or a colliding migration fails the build, not a customer.

Tonight's clock: hour 0 to 1 scaffold; hours 1 to 7 the nine module agents; hours 7 to 9 the integration agent. Done tonight means: every table and view exists, each module's unit and integration tests are green on its branch, `main` builds and deploys to staging with seed data, a staff user can log in with TOTP, a customer can register, book with a credit, pay with the fake Mollie adapter, receive the confirmation email in the sink, and see the booking on the timeline. The seven scenario specs exist; the two that depend on R2 (lead-priority windows, replay separation) are marked skipped until R2.

## 12. Top 10 risks

| # | Risk | Mitigation |
| --- | --- | --- |
| 1 | The single tick cannot keep up (campaign plus claim expiries in the same minute) | Two lanes with the fast lane first; 50-second budget; chunked work; alert at queue depth 500; the escape hatch is a second cron route for the bulk lane, still no new vendor |
| 2 | Overlapping ticks or retried webhooks process a job twice | `FOR UPDATE SKIP LOCKED` claims, unique idempotency keys, handlers that only move statuses forward; a replay of any webhook is a no-op by design |
| 3 | Deliverability on new domains, or 50,000 sends in one go | `news.beam.be` warm-up schedule in `settings` (1,000 per day doubling over 4 weeks), DMARC from quarantine to reject, bounce and complaint suppression, one-click unsubscribe headers, separate transactional domain |
| 4 | Parallel agents collide on schema and shared files | Migration 0001 is the contract, additive timestamped migrations, generated barrels, ownership map, workspace typecheck as the gate |
| 5 | Sensitive data leaks into AI, exports or logs | Two storage places, one reader, audit on every read, whitelist context builder with a unit test, Sentry scrubbing, read-only AI role over non-sensitive views |
| 6 | Customer returns from Mollie before the webhook, or the webhook never comes | Status lives only in the database; return page polls; `payments.sync` can be enqueued by the return page too; a daily check flags orders pending for more than 24 hours |
| 7 | Billit API failures or limits block invoicing | Invoices are native and valid without Billit; outbox with retries; backlog visible; manual retry button; Billit remains the Peppol layer only |
| 8 | Neon cold starts or the 7-day restore window surprise us | Production compute never suspends; off-provider nightly dump with 35-day retention; quarterly restore drill |
| 9 | Data migration brings duplicates and lost unsubscribes | Import order: suppressions first, then persons by lower-cased email, then consents, then opening balances as `import` entries; dry-run report; `external_ids` make re-runs safe; duplicate flags for review |
| 10 | Knowledge sits with two founders | One way to do everything, `CONVENTIONS.md`, `docs/runbooks/` (restore, rotate keys, dead jobs, failed sync, add a role), the admin System page, George onboarded on the architecture in week 6 |
