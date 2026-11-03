# BEAM architecture, candidate B: data integrity and auditability

Angle: every fact is written once and never edited; every state is derived or versioned; every side effect is a row in `jobs`; every webhook and job is idempotent; deletion and export are driven by a registry that a test proves complete. Everything here stays inside `docs/plan/00-decisions.md`.

## 1. Monorepo layout

```
apps/web                 Next.js 15. Route groups (site) (portal) (admin). Route handlers under src/app/api.
packages/config          eslint, tsconfig, tailwind presets. Depends on nothing.
packages/i18n            Message catalogues messages/{nl-BE,fr-BE,en}/<module>.json, typed keys, LocalizedText zod type.
packages/db              Drizzle schema (one file per module), SQL migrations, seed, test harness (pglite), query helpers.
packages/core            Domain logic per module. Every function takes (tx, ctx, input). No Next.js, no fetch to providers.
packages/email           react-email transactional templates, block document -> MJML -> HTML renderer, Resend client wrapper.
packages/integrations    mollie/, billit/, resend/, youtube/, ads/, anthropic/. Thin typed clients + integration_calls logging.
packages/workers         Job handlers (kind -> handler), schedulers, GDPR runner, import/export runners. The only place that calls integrations.
packages/ui              shadcn/ui components, design tokens, form primitives. Depends on config only.
```

Import rules, enforced by eslint `no-restricted-imports` and `turbo` task graph:

| Package | May import |
| --- | --- |
| config, i18n, ui | nothing from the repo (ui -> config) |
| db | config |
| core | db, i18n |
| email | core, db, i18n, ui (react-email only) |
| integrations | db (to write `integration_calls`), config |
| workers | core, db, email, integrations, i18n |
| apps/web | all packages; never `packages/*/src/<module>/internal/*` |

Each module inside `core` and `workers` exposes one `index.ts`. Deep imports across modules are a lint error. Modules: `persons`, `consent`, `booking`, `waitlist`, `commerce`, `credits`, `membership`, `email`, `campaigns`, `automation`, `forms`, `webinar`, `crm_b2b`, `tasks`, `reporting`, `ai`, `gdpr`, `platform`, `website`.

## 2. Core domain model overview

Conventions: tables snake_case plural; `id uuid` (UUIDv7 generated in app); `created_at`, `updated_at timestamptz`; every mutable business table has `version integer` for optimistic locking; enums are `pgEnum('<table>_<column>')`; all money is `integer` cents; VAT rate is basis points (`2100`, `600`, `0`). Append-only tables have no `updated_at`, a trigger `reject_update_delete()` and the app role has no UPDATE/DELETE grant on them. Derived views are plain SQL views unless marked `MV`.

**Persons and consent**
- `persons` — the one identity. `email citext` (partial unique where `erased_at is null`), `locale`, `commercial_status` (`lead|customer|member`), `commercial_status_override boolean`, `acquisition jsonb` written once at creation, `erased_at`.
- `person_merges` (append-only) — `winner_id`, `loser_id`, `loser_snapshot jsonb`, `merged_by`. The loser row stays with `merged_into_id` set.
- `consent_records` (append-only) — `person_id`, `purpose` (`newsletter|events|member_comms|b2b|assessment_result|sensitive_processing|ai_processing`), `status` (`granted|withdrawn`), `source`, `method`, `wording_version_id`, `recorded_at`. Current consent = latest row per purpose (view `consent_current`).
- `suppressions` — `email_hash` (sha256, unique with `scope`), `email` (nulled on erasure), `reason` (`unsubscribe|hard_bounce|complaint|manual|erased`), `scope` (`all|newsletter|events|member_comms|b2b`). Never deleted, never imported over.
- `activity_events` (append-only) — `person_id`, `kind` (registry string such as `booking.confirmed`), `occurred_at`, `actor jsonb`, `ref_type`, `ref_id`, `data jsonb`, `dedupe_key` unique. The timeline.
- `tags`, `person_tags`; `companies`, `company_contacts` (`person_id`, `company_id`, `position`, `decision_role`); `opportunities` (B2B pipeline, `stage`, `value_cents`, `probability_bp`, `owner_id`); `tasks` (`owner_id`, `due_at`, `priority`, `person_id`, `company_id`, `status`).

**Booking and waitlist**
- `session_templates` — `kind` (`day|night|event`), weekday rules, default `capacity_seats`, `capacity_beds`, `product_id`.
- `sessions` — one occurrence: `starts_at`, `ends_at`, `capacity_seats`, `capacity_beds`, `status` (`open|closed|cancelled`), `lead_magnet boolean`, `lead_reserved_seats`, `lead_window_start`, `lead_window_end`, `claim_window_minutes`.
- `capacity_holds` — `session_id`, `kind` (`staff|partner|host|speaker|blocked`), `quantity`, `partner_id`.
- `bookings` — `session_id`, `person_id`, `status` (`reserved|confirmed|cancelled|late_cancelled|no_show|attended`), `order_line_id`, `credit_entry_id`, `guest_of_booking_id`, `cancelled_at`, `cancel_reason`, `version`. Unique `(session_id, person_id)` where status in (reserved, confirmed).
- `waitlist_entries` — `session_id`, `person_id`, `queue` (`lead|customer|public`), `state` (`waiting|offered|confirmed|released|expired`), `offered_at`, `offer_expires_at`, `claim_token_hash`, `booking_id`, `flagged_duplicate boolean`. Unique `(session_id, person_id)`.
- `ticket_types` — `session_id`, `product_id`, `capacity`, `member_only`.

**Commerce, credits, membership**
- `products` — `kind` (`session|night|package|membership|ticket|item|voucher`), `names jsonb` localized, `vat_rate_bp`, `credit_kind` (`session|night|null`), `credit_units`, `validity_days`, `sharing_allowed`, `member_discount_bp`, `active`.
- `price_versions` (append-only) — `product_id`, `version`, `amount_cents` (incl. VAT), `valid_from`, `created_by`. Current price = latest `valid_from <= now()`.
- `promotions` — `code`, `kind` (`percent|fixed`), `value`, `rules jsonb`, `valid_from`, `valid_to`, `max_uses`, `max_uses_per_person`.
- `checkouts` — `person_id` nullable, `items jsonb`, `status` (`started|abandoned|completed`), `expires_at`; feeds abandoned-checkout recovery.
- `orders` — `person_id`, `channel` (`online|pos|manual|link`), `status` (`draft|pending_payment|paid|cancelled|refunded|partially_refunded`), `subtotal_cents`, `vat_cents`, `total_cents`, `version`.
- `order_lines` — `order_id`, `product_id`, `price_version_id`, `quantity`, `unit_amount_cents`, `vat_rate_bp`, `vat_cents`, `discount_cents`, `promotion_id`, `pricing_trace jsonb`. Prices here are snapshots and never change.
- `payments` — `order_id`, `provider` (`mollie|stripe|viva|cash|terminal|bank_transfer`), `provider_payment_id` unique, `method`, `status` (`open|pending|authorized|paid|failed|expired|canceled|refunded`), `amount_cents`, `raw jsonb`, `status_history jsonb`.
- `refunds` — `payment_id`, `amount_cents`, `reason`, `provider_refund_id` unique, `credit_note_id`, `created_by`.
- `invoices` — `number` unique (`BEAM-2026-00001`, sequence per year), `kind` (`invoice|credit_note`), `reverses_invoice_id`, `order_id`, `customer_snapshot jsonb`, `lines jsonb`, totals, `billit_id`, `sync_status` (`pending|synced|failed`). Immutable after issue; corrections are credit notes.
- `credit_grants` — `person_id`, `product_id`, `order_line_id`, `credit_kind`, `units_granted`, `unit_value_cents`, `starts_at`, `expires_at`, `status` (`active|exhausted|expired|revoked`).
- `credit_entries` (append-only) — the ledger, see section 6.
- `package_shares` — `grant_id`, `shared_with_person_id`, `max_units`, `status` (`active|revoked`).
- `memberships` — `person_id`, `product_id`, `status` (`active|past_due|cancelled|expired`), `started_at`, `renews_at`, `mandate_id`, `cancel_at`.
- `mandates` — `person_id`, `provider`, `provider_mandate_id` unique, `status`.

**Email, campaigns, automation**
- `email_templates`, `email_template_versions` — `kind` (`transactional|marketing`), `subject jsonb` localized, `document jsonb` (block editor), `html_by_locale jsonb`, `status` (`draft|published`). History always points at a version id.
- `segments` — `definition jsonb` (rule tree), `kind` (`dynamic|static`); `segment_members` (MV cache, refreshed hourly and on demand).
- `campaigns` — `template_version_id`, `segment_id`, `status` (`draft|scheduled|planning|sending|sent|stopped`), `scheduled_at`, `audience_snapshot_at`.
- `campaign_recipients` — `campaign_id`, `person_id`, `locale`, `status` (`planned|sent|skipped_suppressed|skipped_consent|skipped_translation|removed|failed`), `email_message_id`. Unique `(campaign_id, person_id)`.
- `email_messages` — `person_id`, `kind`, `template_version_id`, `locale`, `idempotency_key` unique, `resend_id` unique, `status` (`queued|sent|delivered|bounced|complained|failed`).
- `email_events` (append-only) — `email_message_id`, `type` (`sent|delivered|delivery_delayed|bounced|complained|opened|clicked`), `resend_event_id` unique, `payload jsonb`.
- `automations`, `automation_versions` — `trigger jsonb`, `steps jsonb`, `exit_rules jsonb`, `group_id`, `status` (`draft|active|paused|archived`).
- `automation_groups` — `exclusive boolean`, `priority`.
- `automation_enrolments` — `person_id`, `automation_version_id`, `status` (`active|completed|exited|stopped`), `anchor_at`, `next_step_key`, `next_step_at`. `status` is a cache recomputable from `automation_runs`.
- `automation_runs` (append-only) — `enrolment_id`, `step_key`, `outcome` (`entered|scheduled|sent|skipped_late_entry|skipped_condition|skipped_suppressed|skipped_consent|skipped_exclusive|branched|exited|stopped_manual|completed|failed`), `reason`, `details jsonb`, `occurred_at`.

**Forms, assessments, webinars**
- `forms`, `form_versions` — `schema jsonb` (fields, logic, endings), `scoring jsonb`, `sensitive_field_keys text[]`, `published_locales text[]`.
- `form_submissions` — `form_version_id`, `person_id`, `status` (`started|partial|abandoned|completed`), `answers jsonb` (non-sensitive), `answers_sensitive bytea` (AES-256-GCM), `score jsonb`, `outcome_key`, `utm jsonb`, `source`.
- `webinars` — `title jsonb`, `mode` (`live|simulive|on_demand`), `youtube_video_id`, `starts_at`, `replay_until`, `host_meet_url`.
- `webinar_registrations` — `webinar_id`, `person_id`, `access_token_hash`, `registered_mode`.
- `watch_segments` (append-only) — `registration_id`, `mode` (`live|replay|on_demand`), `from_sec`, `to_sec`, `recorded_at`. Watch time = merged interval length per mode (view `webinar_watch_time`).
- `webinar_interactions` (append-only) — `registration_id`, `mode`, `kind` (`poll_answer|cta_shown|cta_clicked|chat|question`), `poll_id`, `cta_id`, `payload jsonb`, `at_sec`.

**Platform**
- `staff_users` — `email`, `password_hash` (argon2id), `totp_secret_enc`, `role`, `status`, `locale`. `role_permissions` — `role`, `permission`, seeded, editable by owner.
- Auth.js tables `auth_accounts`, `auth_sessions` (with `audience` `staff|customer`), `auth_verification_tokens`.
- `jobs`, `webhook_events` (append-only), `integration_calls` (append-only), `ai_requests` (append-only): section 3 and 8.
- `audit_log` (append-only) — `actor jsonb`, `action`, `entity_type`, `entity_id`, `person_id`, `old_value jsonb`, `new_value jsonb`, `request_id`, `redacted boolean`.
- `feature_flags`, `settings` (`key`, `value jsonb`, `version`, `updated_by`), `gdpr_requests`, `data_exports`, `imports`, `import_rows`, `retention_policies`.

Derived views: `consent_current`, `credit_grant_balances`, `credit_balances` (per person and credit_kind), `person_commercial_status_computed`, `person_stats` (MV, nightly: lifetime revenue, purchases, visits, first/last visit), `retention_candidates` (MV, nightly), `session_availability` (capacity minus holds minus active bookings minus active offers), `webinar_watch_time`, `campaign_stats`.

## 3. Request and job model

**Four entry points, one context.** `Ctx = { actor, tx, requestId, now, locale }` where `actor` is `{kind:'staff', staffUserId, role} | {kind:'customer', personId} | {kind:'system', jobId} | {kind:'webhook', provider}`.

- Server actions are declared with `action({ permission, input: ZodSchema }, handler)` in `apps/web/src/app/(admin|portal|site)/<module>/actions.ts`. The wrapper: resolves the session, checks the permission, parses input, opens one transaction, runs the handler, writes `audit_log`, inserts jobs in the same transaction (transactional outbox), commits, then calls `after(kickJobs)`.
- Route handlers exist only for: webhooks (`/api/webhooks/{mollie,resend}`), cron (`/api/cron/tick`, `/api/cron/daily`), public form submit (`/api/forms/[slug]/submit`), webinar heartbeat (`/api/webinar/heartbeat`), file-free CSV import upload (`/api/imports/[id]/rows`), iCal feeds, health (`/api/health`).
- Webhook handler: verify signature -> `insert into webhook_events (provider, external_event_id, payload) on conflict do nothing` -> if inserted, enqueue job `webhook.process` with `idempotency_key = 'webhook:'+provider+':'+external_event_id` -> return 200 within 2 seconds. Mollie sends only a payment id, so `external_event_id = paymentId + ':' + receivedAt(ms)`; idempotency there lives in the payment state machine (`applyProviderStatus` ignores transitions already applied, and side effects such as "grant credits" carry key `payment:<id>:paid`).
- Nothing outside `packages/workers` calls a provider. The one latency-sensitive exception, creating a Mollie checkout, uses `runJobInline(tx, kind, payload)`: the job row is inserted and executed in the request, so the ledger of side effects stays complete.

**`jobs` table**: `id`, `kind`, `payload jsonb`, `idempotency_key` unique, `status` (`pending|running|succeeded|failed|dead`), `priority smallint` (1 high, 5 default, 9 bulk), `run_at`, `attempts`, `max_attempts` (default 6), `locked_at`, `locked_by`, `last_error`, `result jsonb`, `started_at`, `finished_at`. Index `(status, run_at, priority) where status='pending'`. Enqueue is `insert ... on conflict (idempotency_key) do nothing`, so re-enqueuing is a no-op.

**Handler contract** (`packages/workers/src/<module>/jobs.ts`):
```ts
defineJob({ kind: 'credits.expire_grant', input: z.object({ grantId: z.string() }),
  retry: { backoffSeconds: [60, 300, 900, 3600, 21600], maxAttempts: 6 },
  run: async (ctx, input) => { /* idempotent: re-running yields the same state */ } })
```
Errors are `RetryableError` (default) or `PermanentError` (missing translation, invalid signature, validation): permanent goes straight to `dead`. `dead` raises a Slack alert, a Sentry event and shows in `(admin)/system/jobs` with a Retry button (permission `jobs.manage`). Every run is wrapped in a transaction; a thrown error rolls back the handler's writes and only the job row is updated.

**Tick loop.** `vercel.json` cron `* * * * *` -> `GET /api/cron/tick` (header `Authorization: Bearer $CRON_SECRET`, `maxDuration = 60`). The tick:
1. Enqueues the minute schedulers with key `scan:<name>:<yyyy-mm-ddThh:mm>`: `automation.scan_due`, `waitlist.scan_expiry`, `payments.scan_expired`, `checkouts.scan_abandoned`, `memberships.scan_renewals`.
2. Claims work: `update jobs set status='running', locked_at=now(), locked_by=$worker, attempts=attempts+1 where id in (select id from jobs where status='pending' and run_at<=now() order by priority, run_at limit 25 for update skip locked) returning *`.
3. Runs claimed jobs with concurrency 5, repeats until no work or 45 s elapsed, pings the Better Stack heartbeat.
4. Reclaims stale locks (`running` and `locked_at < now() - 10 min`) as `pending` with `last_error='stale lock'`.
Overlapping ticks are safe because of `skip locked`. `kickJobs()` after a server action calls the tick immediately, so user-triggered emails leave in seconds, not minutes.

**Daily cron** `/api/cron/daily` at `10 1 * * *` UTC enqueues: `backup.logical_dump`, `credits.expire_grants`, `retention.purge`, `reporting.refresh_person_stats`, `reporting.refresh_retention`, `ads.pull_yesterday`, `billit.reconcile`, `jobs.prune_succeeded`. Hourly `10 * * * *`: `segments.refresh`.

**Chunking.** A campaign to 50,000 contacts: `campaign.plan` inserts `campaign_recipients` with one `insert ... select` from the segment (status `planned`, `audience_snapshot_at` set), then enqueues `campaign.send_chunk` per 500 recipients ordered by id (100 jobs, priority 9). Each chunk re-checks suppression, consent and locale at send time, renders per locale, calls Resend batch (100 per call), writes `email_messages` with key `campaign:<id>:person:<id>`. A stopped campaign makes remaining chunks exit at once. 100 chunks at concurrency 5 finish in under 10 minutes. Imports: the route handler streams the CSV into `import_rows` (1,000-row inserts), the file itself is never stored; `import.process_chunk` jobs of 500 rows match on email then phone, upsert, write `activity_events`, and never create consent unless the row has an explicit `consent_<purpose>_at` plus `consent_source`; a suppressed email is always skipped and reported.

## 4. Auth and permissions

- Auth.js v5, Drizzle adapter, one instance, two audiences. Staff: Credentials (email + argon2id password) followed by a TOTP step; the session carries `audience='staff'` and `mfaAt`; no admin page renders before `mfaAt` is set. Idle timeout 12 h, absolute 7 days. Customers: Resend magic link (`mail.beam.be`), optional password; session 30 days. Sessions are rows in `auth_sessions`; logout deletes the row. Middleware maps `(admin)` -> staff, `(portal)` -> customer, `(site)` -> public.
- Roles (`staff_users.role`): `owner`, `management`, `customer_service`, `sales`, `marketing`, `finance`, `reception`, `technical_admin`, `external_partner`.
- Permissions are strings `<module>.<action>`: `persons.read`, `persons.write`, `persons.merge`, `persons.sensitive_read`, `persons.export`, `persons.erase`, `bookings.read`, `bookings.write`, `bookings.override`, `waitlist.manage`, `credits.read`, `credits.adjust`, `orders.read`, `orders.refund`, `pos.sell`, `invoices.read`, `invoices.issue`, `campaigns.read`, `campaigns.write`, `campaigns.send`, `automations.write`, `automations.move_person`, `forms.write`, `webinars.host`, `crm.b2b`, `tasks.all`, `reports.read`, `reports.finance`, `settings.write`, `staff.manage`, `flags.manage`, `jobs.manage`, `partners.own_only`.
- Defaults in `role_permissions` (owner edits in `(admin)/settings/roles`; every change is audited): owner and technical_admin: all; management: all except `staff.manage`, `persons.erase`; customer_service: persons read/write, bookings read/write, credits read, orders read, tasks; sales: persons, bookings read, crm.b2b, tasks, reports.read; marketing: persons read, campaigns all, automations.write, forms.write, webinars.host, reports.read; finance: orders, invoices, refunds, reports.finance, persons read; reception: persons read/write, bookings all, pos.sell, credits read; external_partner: `partners.own_only` (their holds, referrals and ticket scans, nothing else). Nobody gets `persons.sensitive_read` by default except owner; management may grant it per role.
- Check in code: `action({ permission: 'credits.adjust' }, ...)`; inside core, `ctx.require('credits.adjust')` throws `ForbiddenError` (logged, never silent). Row scope: customer actions always filter by `ctx.actor.personId`; partner actions by `partner_id`.
- Field-level restriction: sensitive data never sits in `persons`. It lives in `person_sensitive_fields` (`person_id`, `key`, `value_enc bytea`, `key_version`) and `form_submissions.answers_sensitive`. Columns are declared with `sensitive(bytea('value_enc'))`, which registers them in `SENSITIVE_FIELDS`. Reading requires `persons.sensitive_read`, goes through `readSensitive(ctx, ...)` and writes `audit_log` action `sensitive.read`. Staff CSV exports, AI context and segment rules cannot reference them (the rule builder only offers `AI_AND_SEGMENT_ALLOWED_FIELDS`). The subject's own GDPR export includes them.
- Encryption: AES-256-GCM with `DATA_KEY_V1` from Vercel env; `key_version` on each row allows rotation by a `security.rekey` job.

## 5. Multi-language

- Locales `nl-BE`, `fr-BE`, `en`. `persons.locale` drives every customer-facing message; `staff_users.locale` drives the back-office; the public site uses the URL prefix (`/nl`, `/fr`, `/en`).
- UI strings: `packages/i18n/messages/<locale>/<module>.json`, loaded by next-intl per route group. A CI test fails when the three files of a module do not have identical key sets. In development and in the admin UI a missing key renders as `⟦module.key⟧`, never as another language.
- Content fields (product names, email subjects, form labels, CTA text, website blocks) are `LocalizedText = { 'nl-BE': string, 'fr-BE': string, 'en': string }` stored as jsonb. Drafts use `Partial<LocalizedText>`. Publishing an email template version, a form version or a product calls `assertComplete(text)`; it returns the list of missing locales and the publish action fails with that list.
- Sending: `renderEmail(templateVersion, locale)` throws `MissingTranslationError` (a `PermanentError`). The job dies, the recipient row gets `skipped_translation`, an alert fires. No fallback language, ever. Campaigns cannot be scheduled while any recipient locale is missing in the template.
- Forms and website pages publish per locale (`published_locales`); an unpublished locale shows a "not available in your language" page with a locale switch, not a mixed-language page.
- Dates, money and plurals use `Intl` with the locale and `Europe/Brussels`.

## 6. Money, credits and pricing

- Prices are stored including VAT in `price_versions`. VAT per line: `vat_cents = round(unit_amount_cents * qty * rate_bp / (10000 + rate_bp))`, round half up at line level; order totals are sums of lines. B2B invoices show excl. VAT by reversing the same line math; nothing is recomputed from totals.
- `quote(tx, ctx, { personId, items, promoCode, channel })` returns `Quote { lines: QuoteLine[], trace: PricingRule[] }`. Rules in order: current price version; member discount from `products.member_discount_bp` when `memberships.status='active'` (no code needed); promotion by code or automatic eligibility; customer-specific price from `person_prices`. The best single discount wins; discounts never stack. The trace is stored in `order_lines.pricing_trace` so a staff member can see why a price was charged.
- A paid order creates one `credit_grants` row per package line, VAT recognised at sale as a single-purpose voucher: a package covers exactly one `credit_kind` with one VAT rate (a check constraint on `products` forbids mixing).
- Ledger `credit_entries`: `id`, `grant_id`, `person_id` (owner), `beneficiary_person_id` (owner or guest), `kind` (`grant|consume|release|expire|extend|adjust|revoke|transfer_out|transfer_in`), `quantity integer` signed in units, `unit_value_cents` snapshot, `reason text` (mandatory for `adjust`), `ref_type`, `ref_id` (booking, order, share), `created_by jsonb` actor, `idempotency_key` unique, `created_at`. Constraints: `grant` positive, `consume` and `expire` negative, `extend` has quantity 0 and `details.new_expires_at`.
- Balance = `sum(quantity)` per grant (view `credit_grant_balances`); person balance = sum over grants with `status='active'` and `expires_at > now()`, grouped by `credit_kind`. The portal shows "4 sessions remaining"; nobody edits a balance.
- `consumeCredits(tx, ctx, { personId, beneficiaryPersonId, kind, units, ref })` locks the person's active grants `for update` ordered by `expires_at asc`, writes consume entries split across grants, and returns entry ids stored on the booking. Cancelling inside the policy window writes `release` entries that reference the consume entries. The daily `credits.expire_grants` job writes `expire = -remaining` for grants past expiry with key `expire:<grant_id>`.
- Package thresholds (50, 75, 90 %, last unit) are computed from the ledger when a consume entry is written and emitted as `activity_events` (`credits.threshold_reached`, `dedupe_key = grant:<id>:threshold:<pct>`), which the automation engine consumes.
- Sharing: the owner creates `package_shares`; a guest booking through a share consumes from the owner's grant with `beneficiary_person_id` = guest and `ref_type='booking'`. `max_units` and `products.sharing_allowed` are checked at consume time; abuse is visible because every guest use is a ledger row.
- Memberships: `memberships` plus a Mollie recurring mandate. Renewal is a job `memberships.charge_renewal` with key `renewal:<membership_id>:<renews_at date>`; failure sets `past_due`, emits an event, and a rule-based retry after 3 and 7 days precedes expiry.

## 7. Automation engine design

- Definition: `automation_versions.trigger` (`{ kind: 'event', event: 'webinar.registered' }` or `{ kind: 'segment_enter', segmentId }` or `{ kind: 'manual' }`), `steps` (ordered list; kinds `send_email`, `wait`, `condition`, `branch`, `add_tag`, `remove_tag`, `create_task`, `set_field`, `webhook`, `exit`), `exit_rules` (list of events and conditions, e.g. `order.paid`, `suppression.added`, `membership.activated`), `anchor` (`enrolment` or an event timestamp path such as `webinar.starts_at`), `purpose` (consent purpose a marketing automation requires), `group_id`.
- Enrolment: every `activity_events` insert enqueues `automation.evaluate_event` (key `evt:<event_id>`). The handler matches triggers and exit rules for that person in one pass. On enrol it writes `automation_enrolments` (unique `(person_id, automation_id)` where active unless the automation allows re-entry) and computes `scheduled_at` for every step relative to the anchor. Steps whose moment is already past get an `automation_runs` row `skipped_late_entry` immediately and are never sent (scenario 1). The first due step sets `next_step_at`.
- Exclusion groups: `automation_groups.exclusive=true` allows one active enrolment per person per group. If a new automation has a lower `priority` number than the running one, the running one gets `exited` with reason `superseded`; otherwise the new one logs `skipped_exclusive` and does not enrol. Staff can override from the timeline (`automations.move_person`, audited).
- Send-time evaluation: `automation.scan_due` enqueues `automation.step` (key `step:<enrolment_id>:<step_key>`) for enrolments with `next_step_at <= now()`. The step handler checks, in order: enrolment still active; person not erased; suppression for `all` or the automation's purpose scope; current consent for the purpose when the automation is marketing; exit rules; the step's own condition (for example "no future booking" for inactivity steps); exclusive group still holds. Each check that fails writes one `automation_runs` row with the matching outcome and moves on or exits. Only then is the email job enqueued, and the email job checks suppression once more at the moment of sending.
- Fast unsubscribe (scenario 2): one-click link, preference centre, staff action and Resend complaint all insert `suppressions` in a transaction that also enqueues `automation.exit_for_suppression` (key `supp:<suppression_id>`) and the server action calls `kickJobs()`. Running sequences end with reason `unsubscribed` within seconds; the 15-minute target is met even if the kick fails because the next tick picks it up.
- Per-person log: `automation_runs` is shown on the person timeline as entered, scheduled, sent, skipped (with reason), branched, exited (with reason), stopped by staff. Nothing about a journey is stored anywhere else.
- Versioning: editing an active automation creates a new version; existing enrolments keep their version. Staff choose "migrate active enrolments" explicitly, which writes `exited:migrated` and `entered` rows.

## 8. Integration boundaries

All providers live in `packages/integrations/<provider>` as typed clients. Each call writes `integration_calls` (`provider`, `operation`, `request_digest`, `status_code`, `duration_ms`, `error`, `job_id`), never request bodies. Only `packages/workers` imports them.

| Provider | Called from | How | Failure surfacing |
| --- | --- | --- | --- |
| Mollie | `payments.create_checkout` (inline job), `payments.refund`, `memberships.charge_renewal`, `payments.fetch_status`; webhook `/api/webhooks/mollie` | `PaymentProvider` interface (`createPayment`, `getPayment`, `refund`, `createMandate`, `createTerminalPayment`). Stripe and Viva adapters implement the same interface and are selected per `orders.channel` in `settings.payment_provider_by_channel`. | Checkout creation error returns a typed error to the user; webhook failures retry; `payments.scan_expired` marks open payments expired after 30 min; dashboard tile "payments with unknown status > 15 min". |
| Billit | `billit.sync_customer`, `billit.sync_invoice`, `billit.sync_credit_note`, daily `billit.reconcile` (pulls paid status, compares to `invoices`) | REST client; invoice numbers are ours, Billit stores them as external reference; `invoices.billit_id` written on success. | Dead job -> alert "High" per SLA; `invoices.sync_status='failed'` visible in finance screen with Retry. Invoices are still legally issued locally. |
| Resend | `email.send` (transactional, priority 1), `campaign.send_chunk` (priority 9); webhook `/api/webhooks/resend` (svix signature) | `mail.beam.be` transactional, `news.beam.be` marketing; `email_messages.resend_id` from the response; events -> `email_events`; `bounced`/`complained` -> `suppressions`. | Dead send jobs alert; bounce rate above 2 % on a campaign pauses it automatically and alerts marketing. |
| YouTube | `webinar.create_broadcast` (Data API v3 with BEAM's Google account refresh token), `webinar.fetch_recording` | Unlisted live stream embedded in `(portal)/webinars/[id]`; watch time measured natively by a 15 s heartbeat writing `watch_segments`. | Broadcast creation failure blocks publishing the webinar with a clear message; heartbeat loss is only lost telemetry, never lost registrations. |
| Meta and Google Ads | `ads.pull_yesterday` daily | Read-only Marketing API and Google Ads API into `ad_spend_daily` (`platform`, `campaign_external_id`, `date`, `spend_cents`, `clicks`, `leads`). UTM on forms links leads to campaigns. | Missing day shows "no data" in dashboards, job retries, alert after 3 failures. |
| Claude (Anthropic SDK) | `ai.draft_email`, `ai.draft_reply`, `ai.answer_question`, `ai.weekly_summary`, `ai.classify_inbox` (Haiku) | `aiContext(person)` built only from `AI_ALLOWED_FIELDS` (allowlist, not blocklist); `ai_requests` logs feature, model, `fields_sent text[]`, tokens, cost cents, prompt and output (purged after 30 days). `settings.ai_sensitive_enabled` defaults false; enabling requires owner, a `purpose` text and is audited (scenario 6). Output is always a draft a person approves. | Timeouts fall back to "draft unavailable"; cost cap per day in settings stops jobs with `dead:budget`. |

Website editing through Claude writes proposed `content_blocks` versions; a staff member publishes them.

## 9. Environments and delivery

| Environment | Database | App | Data | Purpose |
| --- | --- | --- | --- | --- |
| local | Docker Postgres 17 or a personal Neon branch | `pnpm dev` | seed (fictitious) | development |
| preview | Neon branch per pull request (Vercel Neon integration), deleted on PR close | Vercel preview | seed | review |
| staging | Neon branch `staging`, reset from seed weekly | Vercel env `staging`, deployed from `main` | fictitious until go-live, then anonymised copy | BEAM testing |
| production | Neon `main`, Frankfurt | Vercel production, deployed from tags `v*` | real, after the go-live gate | live |

- Migrations: `drizzle-kit generate` produces SQL in `packages/db/drizzle`; the journal is committed. CI job `migrate` runs `pnpm db:migrate` against the target branch before `vercel deploy --prebuilt --prod`; previews run it in the build command. `drizzle-kit check` in CI fails when schema and migrations drift. Rule: a release contains only expand steps (add table, add nullable column, add index concurrently). Contract steps (drop, rename, not-null backfill) ship one release after the code stopped using the old shape. So old code always runs against the new schema.
- Rollback: `vercel rollback` promotes the previous deployment in under a minute; the schema stays. A bad data change is repaired forward with a correcting job or a Neon PITR branch (section 10); the database is never rolled back.
- Feature flags: `feature_flags` (`key`, `enabled_globally`, `roles text[]`, `staff_user_ids uuid[]`, `person_ids uuid[]`, `percent smallint`). `isEnabled(key, actor)` is read from a 60 s in-memory cache; flags are managed by `flags.manage` and audited. Keys are `ff_<module>_<name>`. Code paths behind a flag are removed within two sprints after full rollout.
- Secrets live in Vercel environment variables per environment; `CRON_SECRET`, `DATA_KEY_V1`, provider keys. Provider accounts are BEAM's; test keys only outside production.

## 10. Observability, backup, restore, security

- Errors: Sentry EU with `beforeSend` scrubbing email, phone and names; every error carries `requestId`, `jobId`, `actor.kind`. Logs: pino JSON on Vercel, drained to Better Stack (EU); 30-day retention; no personal data in log lines (ids only).
- Alerts to Slack `#beam-alerts`: job `dead` (with kind and id); tick heartbeat missing for 3 minutes; webhook signature failures above 5 in 10 minutes; payment in `pending` above 15 minutes; Billit sync failed; campaign bounce rate above 2 %; error rate above 1 % over 5 minutes; Better Stack uptime on `/api/health` (checks DB and a jobs backlog under 500).
- Admin `(admin)/system`: jobs, webhook events, integration calls, flags, audit log search, GDPR requests. Nothing fails silently: every failure is a row with a status someone can see.
- Backup: Neon point-in-time restore, 7-day window (Launch plan). Plus `backup.logical_dump` nightly at 01:10 UTC: `pg_dump` custom format, AES-256 encrypted, uploaded to Scaleway Object Storage (Paris, EU), 90-day retention, bucket in BEAM's name. RPO: 1 minute via PITR, 24 hours via dump. RTO: 2 hours target, 8 hours contractual. Procedure: create a Neon branch at the chosen timestamp, run smoke tests, switch `DATABASE_URL`, redeploy, replay webhook events received since the timestamp from provider dashboards. Restore drill every quarter, logged in `docs/ops/restore-drills.md`.
- Security controls: HTTPS and HSTS; CSP with nonces; argon2id; TOTP mandatory for staff; password policy 12+ characters, breached-password check; Vercel WAF rate limits on `/api/auth/*`, `/api/forms/*`, `/api/webhooks/*`; per-account rate limits in table `rate_limits` (token bucket); CSRF through Server Actions origin checks; signed single-use tokens for magic links, claim links and replay access (sha256 hashes stored, 15-minute TTL for login, configurable for claims); app-level encryption of sensitive fields; least-privilege DB roles (`beam_app` without UPDATE/DELETE on append-only tables, `beam_migrate` for CI); Dependabot plus `pnpm audit` in CI; secrets never in the repo (gitleaks in CI); access to sensitive data logged; quarterly Sidestream penetration test.
- GDPR workflows: `gdpr_requests` (`person_id`, `kind` `export|erase|restrict`, `status` `requested|verified|running|done|failed`, `report jsonb`). Each module registers `gdpr: { tables, export(tx, personId), erase(tx, personId) }` in `GDPR_REGISTRY`. `gdpr.erase` runs handlers in dependency order, records per table `rows` and `action` (`deleted|anonymised|retained_legal`), anonymises `persons` (name "Deleted person", email null, `erased_at`), keeps `suppressions.email_hash` with reason `erased`, keeps invoices with `customer_snapshot` reduced to legal name and address, redacts `audit_log` values to digests with `redacted=true`, deletes `ai_requests`, calls Billit (anonymise customer) and Resend (delete contact), notes that Mollie retains payment data under its own obligations, and stores the report without personal data (scenario 7). `gdpr.export` produces a zip of JSON and CSV per module stored in `data_exports` (bytea, 7-day expiry). Test `gdpr-coverage.test.ts` lists every column that references `persons.id` from `information_schema` and fails if a table is neither in the registry nor in the explicit `NO_PII_TABLES` list.
- Retention (`retention_policies`, editable, enforced by `retention.purge`): marketing profile with no activity 3 years -> anonymise; invoices 7 years; audit_log 5 years; ai_requests 30 days; webhook_events and integration_calls 90 days; succeeded jobs 30 days; import_rows 30 days; data_exports 7 days; watch_segments and webinar_interactions 2 years; email_events 2 years.

## 11. How AI agents build this in parallel tonight

**Wave 0, the scaffold (one agent, first 2 hours, nothing else starts before it is merged):**
1. Repo: pnpm workspace, Turborepo, `packages/config`, CI (`lint`, `typecheck`, `test`, `db:check`, `i18n:check`, `gdpr:coverage`), `.github/workflows/{ci,migrate,deploy,backup}.yml`.
2. `packages/db`: `schema/_shared.ts` (id helper, timestamps, `localized()`, `sensitive()`, locale and currency enums), contract tables with their final names and minimal columns: `persons`, `staff_users`, `role_permissions`, auth tables, `products`, `sessions`, `orders`, `order_lines`, `credit_grants`, `jobs`, `webhook_events`, `integration_calls`, `audit_log`, `activity_events`, `feature_flags`, `settings`; `test/harness.ts` (pglite per test file, `withTx`), `test/factories.ts`; first migration.
3. `packages/core`: `ctx.ts`, errors, `audit()`, `emitEvent()`, `enqueue()`, permission list, `persons` module.
4. `packages/workers`: job runner, `defineJob`, registry loader, tick and daily handlers; `apps/web`: Auth.js for both audiences, middleware, `action()` wrapper, route groups with an empty shell page each, `(admin)/system/jobs`.
5. `packages/i18n` with the three catalogues and the parity test; `packages/ui` with the shadcn base set and layout shells.
6. `docs/plan/conventions.md` (the naming rules below) and `CLAUDE.md` pointing at it.

**Waves 1 and 2, parallel module agents.** Each agent owns exactly these paths and no others:

| Agent | Owns |
| --- | --- |
| booking | `db/schema/booking.ts`, `core/booking`, `core/waitlist`, `workers/booking`, `web/(admin)/bookings`, `web/(portal)/bookings`, `i18n/*/booking.json`, `email/templates/booking` |
| commerce | `db/schema/commerce.ts`, `core/commerce`, `workers/commerce`, `integrations/mollie`, `web/(admin)/orders`, `web/(portal)/checkout`, `web/(admin)/pos`, `i18n/*/commerce.json` |
| credits | `db/schema/credits.ts`, `core/credits`, `core/membership`, `workers/credits`, `web/(admin)/credits`, `web/(portal)/packages` |
| invoicing | `db/schema/invoicing.ts`, `core/invoicing`, `workers/invoicing`, `integrations/billit`, `web/(admin)/finance` |
| email | `db/schema/email.ts`, `core/email`, `core/campaigns`, `email/*` renderer, `integrations/resend`, `workers/email`, `web/(admin)/campaigns`, preference centre |
| automation | `db/schema/automation.ts`, `core/automation`, `workers/automation`, `web/(admin)/automations` |
| forms | `db/schema/forms.ts`, `core/forms`, `web/(admin)/forms`, `web/(site)/f/[slug]`, `web/api/forms` |
| crm | `db/schema/crm.ts` (tags, companies, opportunities, tasks, segments), `core/crm_b2b`, `core/tasks`, `core/segments`, `web/(admin)/persons`, `web/(admin)/companies`, `web/(admin)/tasks` |
| webinar | `db/schema/webinar.ts`, `core/webinar`, `integrations/youtube`, `workers/webinar`, `web/(portal)/webinars` |
| platform | `core/gdpr`, `workers/gdpr`, imports and exports, `core/reporting`, `integrations/ads`, `integrations/anthropic`, `web/(admin)/system`, `web/(admin)/settings`, `web/(admin)/dashboard` |
| website | `web/(site)/*` except forms, `db/schema/website.ts`, `core/website` |

Rules that prevent collisions:
- Agents never edit `_shared.ts`, contract tables' existing columns, `package.json` of another package, or the migration journal. Adding a column to a contract table is done in the owning agent's schema file through `extendTable()` only in wave 2, and is additive.
- Registries (jobs, GDPR handlers, permissions, activity kinds, automation step kinds) are per-module `index.ts` exports collected by `pnpm gen:registry` into a git-ignored `registry.generated.ts` run by Turborepo before build and test. No agent touches a central list.
- Migrations: agents edit schema files and run `pnpm db:check`; only the integrator agent runs `pnpm db:generate` once per merge wave and resolves the journal. Each agent's PR must pass `db:check` against its own schema.
- Cross-module calls go through the other module's `index.ts` public functions, which wave 0 stubs with the final signatures for: `persons.findOrCreateByEmail`, `credits.consumeCredits`, `credits.releaseCredits`, `commerce.quote`, `commerce.createOrder`, `email.sendTransactional`, `activity.emit`, `audit.record`, `jobs.enqueue`. Stubs throw `NotImplemented` until the owner lands them, and unit tests of callers mock them.

Naming conventions (also in `docs/plan/conventions.md`): tables snake_case plural; PK `id`; FK `<singular>_id`; enums `pgEnum('<table>_<column>')`; job kinds `<module>.<verb_noun>`; permissions `<module>.<action>`; activity kinds `<module>.<past_tense_event>`; i18n keys `<module>.<screen>.<element>`; server actions `<verb><Noun>Action` in `actions.ts`; zod schemas `<Noun>Input` next to the action; routes `/api/<area>/<resource>`; flags `ff_<module>_<name>`; idempotency keys `<noun>:<id>:<qualifier>`; tests `*.test.ts` beside the code; Playwright specs `e2e/<scenario>.spec.ts`.

Test strategy that makes parallel work safe:
1. Core unit tests on pglite (fresh schema per file, factories from wave 0), run in under a minute per module; required per module: `gdpr.test.ts` (export and erase leave no rows referencing the person), `permissions.test.ts` (each action denies without its permission), `jobs.test.ts` (every handler run twice with the same payload yields the same database state), `i18n` parity.
2. Integration tests against a Neon branch nightly and on `main`: webhooks with recorded provider payloads, migrations applied from zero, `gdpr-coverage`.
3. Playwright on staging for the seven scenarios and the V1 acceptance list, one spec per scenario, run before every production tag.
4. CI blocks a PR on: lint, typecheck, unit, `db:check`, `i18n:check`, registry generation, no file outside the agent's owned paths (a script compares the diff with `CODEOWNERS`).

## 12. Top 10 risks and mitigations

1. Cron-driven jobs are too slow for user-facing effects. Mitigation: `kickJobs()` after every enqueueing action, priority 1 for transactional email and payments, tick overlap allowed with `skip locked`, backlog alert at 500.
2. Duplicate side effects from webhook retries or overlapping ticks. Mitigation: `webhook_events` unique key, `jobs.idempotency_key` unique, payment state machine, side-effect keys such as `payment:<id>:paid`, mandatory `jobs.test.ts` double-run test.
3. Credit balance drift. Mitigation: ledger only, `for update` on grants, daily `credits.audit_balances` job comparing view totals with grant units and alerting on any negative or over-consumed grant.
4. Schema merge conflicts between agents. Mitigation: one schema file per module, contract tables frozen in wave 0, generated registries, a single integrator producing migrations.
5. A missing translation blocks an operational email at the wrong moment. Mitigation: publishing requires all three locales, catalogue parity in CI, dead-job alert names the template and locale, staff can publish a fix without a deploy.
6. Billit API behaviour differs from assumptions. Mitigation: invoices are legally complete locally, sync is asynchronous with retries and a finance screen; the adapter is isolated in `integrations/billit`; reconciliation daily.
7. Mollie terminal flow unavailable or unsuitable on day one. Mitigation: `PaymentProvider.createTerminalPayment` is optional; POS falls back to payment link, QR or cash with the same `payments` rows; Viva adapter planned behind the same interface.
8. GDPR erasure misses a new table. Mitigation: `gdpr-coverage` test driven by `information_schema`, required per-module `gdpr.test.ts`, erasure report shows every table touched.
9. Neon compute cold starts and Vercel function limits during campaign sends. Mitigation: Neon autosuspend disabled in production, chunk size 500, 45 s tick budget, batch Resend API, nightly load test of a 50,000-recipient send on staging.
10. Sensitive data leaks through a convenient path (export, segment, AI, logs). Mitigation: separate encrypted tables, allowlists instead of blocklists for AI and segments, Sentry scrubbing, access logging, penetration test before go-live.
