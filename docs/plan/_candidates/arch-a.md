# Architecture candidate A: speed to MVP

Angle: the smallest set of abstractions that lets 8 AI agents build V1 in parallel in 3 weeks without blocking each other. Everything here stays inside `docs/plan/00-decisions.md`. Where that file is silent, this file decides.

Five abstractions carry the whole platform: the `persons` row, the `activity_events` stream, the `jobs` table, the `action()` wrapper, and the module folder. Every module is built from these five and nothing else.

## 1. Monorepo layout

```
beam/
  apps/web/                       Next.js 15, one app, three route groups
    src/app/[locale]/(site)/      public website, locale in URL (/nl, /fr, /en)
    src/app/[locale]/(portal)/    customer portal (PWA), /portal/...
    src/app/[locale]/(admin)/     staff back-office, /admin/...
    src/app/api/cron/tick/        the one-minute job runner
    src/app/api/webhooks/{mollie,resend,billit}/
    src/app/api/{forms,track,health,webinar}/
    src/modules/<module>/         actions.ts queries.ts jobs.ts schemas.ts nav.ts permissions.ts events.ts
    src/modules/<module>/ui/      module-only React components
    src/jobs/index.ts             imports every modules/*/jobs.ts (frozen, created by scaffold)
    src/lib/{action,auth,flags,logger,i18n}.ts   shared runtime helpers (frozen after scaffold)
  packages/db/                    Drizzle schema (src/schema/<module>.ts), migrations/, seed/, src/test/
  packages/core/                  pure domain logic per module (src/<module>/), no IO, no framework
  packages/email/                 react-email templates (src/templates/<module>/), MJML renderer, Resend client
  packages/integrations/          src/{mollie,billit,resend,youtube,meta,google-ads,anthropic}/client.ts
  packages/i18n/                  messages/<locale>/<module>.json + t() for non-React code
  packages/ui/                    shadcn components, design tokens, DataTable, Form primitives
  packages/config/                eslint, tsconfig, tailwind presets
```

Modules (one agent each): `crm`, `commerce`, `booking`, `forms`, `email`, `automation`, `ops` (dashboards, tasks, settings, imports, exports), `site`. Release 2+ modules (`webinar`, `b2b`, `ai`) follow the same shape later.

Import rules, enforced by eslint `no-restricted-imports` and `import/no-cycle`:

| Package | May import |
| --- | --- |
| `config` | nothing |
| `ui` | `config` |
| `db` | `config` |
| `core` | `db` types only (`import type`), `zod`. Never the db client, never `next`. |
| `i18n` | nothing |
| `email` | `core`, `i18n`, `ui` tokens |
| `integrations` | `zod` only. No db, no core. |
| `web` | everything. `modules/<a>` never imports `modules/<b>` except through `packages/core` types or `activity_events`. |

Rule of thumb: `core` computes, `db` stores, `integrations` talks to the outside, `web` wires them together inside `action()` and job handlers.

## 2. Core domain model

42 tables for V1 and Release 2. Ids are UUID v7 generated in the app (`uuidv7` npm). Every table has `id`, `created_at`, `updated_at` (except append-only tables, which have no `updated_at`). Localised text is `jsonb` of shape `{ "nl-BE": "", "fr-BE": "", "en": "" }`.

**CRM** (`packages/db/src/schema/crm.ts`)
- `persons`: the one identity record. email (citext, unique where not null), phone, names, locale, status_override (`lead|customer|member|null`), source, source_campaign, utm jsonb, tags text[], referred_by_person_id, partner_id, deleted_at. Everything else points here.
- `companies`: B2B company, vat_number, owner_user_id. `company_contacts`: person_id + company_id + position + role. One person can be both B2C and B2B.
- `activity_events` (append-only): person_id, kind, occurred_at, actor (`system|user:<id>|person`), payload jsonb, ref_table, ref_id. The timeline and the automation trigger bus.
- `consent_records` (append-only): person_id, purpose (`newsletter|events|member_comms|b2b|assessment_result|transactional`), status (`granted|withdrawn`), source, method, wording_version.
- `suppressions`: email (citext, unique), reason (`unsubscribe|hard_bounce|complaint|manual|deleted`), purpose or `all`. Never deleted by imports.
- `tasks`: owner_user_id, person_id, company_id, due_at, priority, status (`open|done|cancelled`), kind.
- `segments`: name, filter jsonb (rule tree), is_dynamic, cached_count. Membership computed by `core/crm/segment.ts` into SQL.
- `audit_log` (append-only): user_id, action, table, row_id, old jsonb, new jsonb, request_id.
- `deletion_requests`: person_id, status (`requested|running|done`), report jsonb. Drives scenario 7.

**Auth** (`auth.ts`)
- `users`: audience (`staff|customer`), email, password_hash, role (staff only), person_id (customer only), totp_secret_enc, is_tester, locale, last_login_at.
- `auth_sessions`, `auth_accounts`, `auth_verification_tokens`: Auth.js adapter tables, untouched.
- `role_permissions`: role, permission, allowed. Overrides the default matrix in code.

**Commerce** (`commerce.ts`)
- `products`: kind (`day_session|night|package|membership|event_ticket|retail|gift_voucher`), name jsonb, config jsonb (units, unit_type, validity_days, discount_pct, renewal_period), is_active.
- `prices` (versioned, never edited): product_id, version, amount_cents, vat_rate_pct, audience (`public|member|b2b`), valid_from, valid_to.
- `promotions`: code, kind (`percent|fixed`), value, applies_to product ids, audience, starts_at, ends_at, max_uses, auto_apply.
- `orders`: person_id, company_id, channel (`portal|site|admin|pos|link`), status (`draft|pending_payment|paid|cancelled|refunded|abandoned`), currency `EUR`, total_cents, vat_cents, locale, promotion_id.
- `order_lines`: snapshot of product_id, price_id, description jsonb, qty, unit_cents, vat_rate_pct, discount_cents, line_total_cents, vat_cents.
- `payments`: order_id, provider (`mollie|stripe|viva|cash|terminal|bank_transfer`), provider_id, method, status (`created|open|paid|failed|expired|refunded`), amount_cents, raw jsonb.
- `invoices`: kind (`invoice|credit_note`), number (gapless per year), order_id, person_id, company_id, lines jsonb snapshot, totals, issued_at, pdf_key, billit_id, billit_status (`pending|synced|failed`).
- `credit_entries` (append-only, the ledger): person_id, customer_package_id, kind (`purchase|consume|guest_use|refund|expire|extend|adjust|bonus|migration`), units int signed, unit_type (`session|night|euro_cent`), booking_id, order_line_id, beneficiary_person_id, actor_user_id, reason.
- `customer_packages`: person_id, product_id, order_line_id, unit_type, starts_at, expires_at, renews_at (membership), mandate_id, sharing jsonb `{allowed, max_guests, person_ids[]}`, status (`active|expired|cancelled`). A membership is a customer_package whose product.kind = `membership`.

**Booking** (`booking.ts`)
- `session_templates`: kind (`day|night|event|webinar`), weekday mask, start_time, end_time, capacity, product_ids, locale names, valid_from, valid_to. Instances are generated 90 days ahead by a daily job.
- `sessions`: template_id, kind, starts_at, ends_at, capacity, reserved_staff, reserved_partner, reserved_leads, is_lead_magnet, lead_window_from, lead_window_to, claim_window_minutes, status (`scheduled|closed|cancelled`), webinar jsonb (youtube ids, replay_until).
- `bookings`: session_id, person_id, order_line_id, credit_entry_id, booked_by_person_id (guest bookings), status (`confirmed|cancelled|late_cancelled|no_show|attended`), guests int, source (`portal|admin|waitlist|import`).
- `waitlist_entries`: session_id, person_id, queue (`lead|customer`), status (`waiting|offered|confirmed|released|expired`), offered_at, offer_expires_at, claim_token (unique), position_at. Unique (session_id, person_id).

**Forms** (`forms.ts`)
- `forms`: key, kind (`lead|intake|survey|assessment`), current_version, status.
- `form_versions`: form_id, version, definition jsonb (fields, logic, scoring, outcomes, sensitive flags), published_at.
- `form_submissions`: form_version_id, person_id, status (`started|partial|abandoned|completed`), answers jsonb, answers_sensitive_enc text, score jsonb, outcome_key, utm jsonb, locale.

**Email and automation** (`email.ts`, `automation.ts`)
- `email_templates` (versioned by rows): key, version, kind (`transactional|marketing`), subject jsonb, document jsonb (block editor) or react_component, status.
- `campaigns`: template_id, segment_id, status (`draft|scheduled|sending|sent|paused|cancelled`), scheduled_at, stats jsonb.
- `email_messages`: person_id, to_email, kind, template_id, campaign_id, automation_run_id, locale, status (`queued|sent|delivered|bounced|complained|failed|suppressed`), provider_message_id, sent_at.
- `email_events` (append-only): message_id, type (`delivered|opened|clicked|bounced|complained`), url, raw jsonb.
- `automations`: key, name, version, status (`draft|active|paused|archived`), trigger jsonb, entry_conditions jsonb, exit_rules jsonb, exclusion_group, is_marketing, allow_reentry, steps jsonb.
- `automation_enrolments`: automation_id, automation_version, person_id, anchor_at, status (`active|completed|exited`), exit_reason, next_step_index, next_run_at, context jsonb. Partial unique index on (automation_id, person_id) where status = `active`.
- `automation_runs` (append-only): enrolment_id, step_index, outcome (`sent|task_created|tag_applied|skipped_late_entry|skipped_condition|skipped_suppressed|skipped_exclusion|exited|error`), detail jsonb.

**Webinar, Release 2** (`webinar.ts`)
- `webinar_interactions` (append-only): session_id, person_id, mode (`live|replay|on_demand`), kind (`joined|heartbeat|poll_answer|cta_shown|cta_clicked|chat|left`), payload jsonb, occurred_at. Watch time is the sum of heartbeats per mode.

**Platform** (`platform.ts`)
- `jobs`: see section 3.
- `feature_flags`: key, enabled_for (`nobody|testers|everyone`), user_ids uuid[], person_ids uuid[].
- `settings`: key, value jsonb. Holds cursors, counters (invoice numbers), business config.

Append-only tables carry a Postgres trigger `raise_append_only()` that rejects UPDATE and DELETE. The GDPR deletion job is the one exception: it runs `SET LOCAL beam.allow_rewrite = on`, which the trigger honours, and anonymises rows in place.

Derived views (SQL views in `packages/db/migrations`, read through `queries.ts`): `package_balances` (sum of `credit_entries` per customer_package), `person_balances` (per person, active packages only), `person_status` (`member` if an active membership, else `customer` if any paid order, else `lead`; `status_override` wins), `session_availability` (capacity minus confirmed bookings and guests minus reserves, per queue), `person_ltv` (revenue, purchases, visits, first and last dates), `retention_candidates` (the eight rule-based lists from blueprint section 22).

## 3. Request and job model

**Server actions.** Every mutation is a server action in `modules/<m>/actions.ts`, defined through one helper:

```ts
export const cancelBooking = action(CancelBookingInput, { permission: 'bookings.write' },
  async (input, ctx) => { /* ctx.db, ctx.actor, ctx.locale, ctx.requestId, ctx.can() */ });
```

`action()` validates with Zod, loads the actor, checks the permission, opens a transaction, runs the handler, writes `audit_log` for the tables the handler touched, and returns `{ ok, data } | { ok: false, error }`. Side effects are never performed in the handler. The handler calls `enqueue(ctx.tx, 'email.send', payload, { idempotencyKey, runAt })` inside the same transaction. If the transaction rolls back, the job never exists. This is the transactional outbox; it is the only async mechanism.

**Route handlers** exist for four things only: webhooks, the cron tick, public form submission and tracking pixels, and the health check. A webhook handler verifies the signature, inserts a job (`webhook.mollie`, `webhook.resend`, `webhook.billit`) with the provider event id as idempotency key, and returns 200 within 500 ms. No business logic in route handlers.

**Jobs table.** `jobs(id, kind, payload jsonb, idempotency_key text unique, status, run_at, attempts, max_attempts default 8, locked_at, locked_by, last_error, result jsonb, created_at, updated_at)`. Status enum: `pending|running|succeeded|failed|dead`. Index on `(status, run_at)`. `enqueue()` does `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING`. Handlers are registered in `modules/<m>/jobs.ts` as `defineJob('booking.send_reminder', PayloadSchema, handler)`; `src/jobs/index.ts` collects them.

**The one-minute loop.** Vercel Cron `* * * * *` calls `GET /api/cron/tick` with `Authorization: Bearer ${CRON_SECRET}`. `maxDuration = 300`. The runner (a) enqueues due schedules, (b) claims jobs in batches of 50 with `UPDATE jobs SET status='running', locked_at=now(), locked_by=$1 WHERE id IN (SELECT id FROM jobs WHERE status='pending' AND run_at <= now() ORDER BY run_at LIMIT 50 FOR UPDATE SKIP LOCKED) RETURNING *`, (c) runs them with concurrency 5, (d) repeats until 250 seconds are spent. Jobs locked for more than 10 minutes are reclaimed. Two ticks overlapping is safe because of `SKIP LOCKED`.

Schedules are plain jobs with bucketed idempotency keys, so no cron state table exists: `automation.tick:<minute>`, `waitlist.expire:<minute>`, `billit.poll:<5-minute bucket>`, `sessions.generate:<day>`, `packages.expire:<day>` (00:10 Brussels), `retention.compute:<day>` (05:00), `ads.pull:<day>` (06:00), `checkout.abandon_scan:<15-minute bucket>`, `backup.verify:<day>`.

**Inline kick.** After a server action commits, `after()` calls `runJobs({ ids: justEnqueued, budgetMs: 8000 })`. Confirmation emails, Mollie payment creation and unsubscribes therefore run within seconds; the cron tick is the safety net, not the primary path.

**Retries.** Failure sets `attempts += 1`, `run_at = now() + min(30s * 2^attempts, 6h)` plus 0 to 20 percent jitter. After `max_attempts` the job is `dead`: Sentry event, Slack alert, and a `tasks` row for the owning role. Handlers must be idempotent; they check their own markers (`email_messages.provider_message_id`, `invoices.billit_id`) before acting.

**Chunking.** A campaign to 50,000 contacts: `campaign.prepare` resolves the segment, inserts `email_messages` rows with status `queued` in batches of 1,000, then enqueues one `campaign.batch` job per 100 messages (Resend batch limit), 500 jobs with keys `campaign.batch:<campaign_id>:<n>`. Each batch re-checks `suppressions` and consent at send time, renders per locale, and sends. 50,000 emails complete in 3 to 5 minutes. Pausing a campaign sets status `paused`; batches check it and requeue themselves. Imports: the server action parses the CSV, validates each row with Zod, stores the rows in chunks of 500 in `import.chunk` job payloads, and a final `import.finish` job writes the summary. No file storage is needed, and customer data never leaves Neon.

## 4. Auth and permissions

One Auth.js v5 instance, one `users` table with `audience`. Providers: Credentials (staff email + password, then a second step verifying TOTP via `otpauth`; customers with optional password), Email magic link via Resend for customers. Sessions live in `auth_sessions`; staff sessions expire after 12 hours idle, customer sessions after 30 days. Middleware: `(admin)` requires `audience = staff`, `(portal)` requires `audience = customer`, `(site)` is public. Staff MFA is mandatory; a staff user without TOTP enrolled is redirected to `/admin/setup-mfa`. Passwords need 12+ characters and zxcvbn score 3. Rate limiting on `/login`, `/magic-link`, `/api/forms/*` is a Vercel WAF rule (20 requests per minute per IP), config not code.

Roles enum `user_role`: `owner|management|customer_service|sales|marketing|finance|reception|technical_admin|external_partner`. Permissions are strings `module.action`. Full list in `packages/core/src/auth/permissions.ts`: `persons.read`, `persons.write`, `persons.read_sensitive`, `persons.merge`, `persons.export`, `persons.delete`, `bookings.read`, `bookings.write`, `orders.read`, `orders.write`, `orders.refund`, `pos.sell`, `credits.adjust`, `invoices.read`, `invoices.write`, `campaigns.read`, `campaigns.write`, `campaigns.send`, `automations.write`, `forms.write`, `reports.read`, `reports.finance`, `tasks.write`, `settings.write`, `users.manage`, `system.jobs`, `partner.own_stats`.

Default matrix (overridable per role in `role_permissions`, edited at `/admin/settings/roles`):

| Role | Has |
| --- | --- |
| owner, technical_admin | everything |
| management | everything except `users.manage`, `settings.write`, `system.jobs` |
| customer_service | persons.read/write, bookings.*, orders.read/write, credits.adjust, tasks.write, reports.read |
| sales | persons.read/write, bookings.read, orders.read, tasks.write, reports.read |
| marketing | persons.read, campaigns.*, automations.write, forms.write, reports.read |
| finance | persons.read, orders.*, invoices.*, reports.read, reports.finance |
| reception | persons.read, bookings.*, pos.sell, orders.read |
| external_partner | partner.own_stats only, no PII |

`persons.read_sensitive` is granted by default to nobody except owner; management gets it only through an explicit `role_permissions` override. Check in code: `action()` refuses before the handler runs; queries that return persons pass rows through `redact(rows, ctx.actor)`.

Sensitive data: Drizzle columns are declared with `sensitive(text('answers_sensitive_enc'))`, which registers them in `SENSITIVE_COLUMNS`. Values are encrypted with AES-256-GCM (`core/crypto.ts`, key `SENSITIVE_DATA_KEY` in Vercel env) before insert. Form fields flagged `sensitive: true` in the form definition are split into `answers_sensitive_enc` at submission time. Reading a sensitive column writes `audit_log` action `sensitive.read`. `toAiContext(person)` in `core/ai/context.ts` builds AI input from an allow-list of 14 fields and can never include a `SENSITIVE_COLUMNS` member; a unit test asserts this. Exports exclude sensitive columns unless the request carries `includeSensitive: true` and the actor has `persons.read_sensitive`.

Customers: a portal query always filters on `ctx.actor.personId`. A customer sees bookings they made for guests, and packages shared with them, through `bookings.booked_by_person_id` and `customer_packages.sharing.person_ids`.

## 5. Multi-language

Locales: `nl-BE` (default), `fr-BE`, `en`. UI strings: `packages/i18n/messages/<locale>/<module>.json`, keys `module.screen.key`, loaded by `next-intl` `getRequestConfig` and merged per request. Locale resolution: `(site)` from the URL segment; `(portal)` from `persons.locale`; `(admin)` from `users.locale`; emails from `persons.locale`; forms from `?lang=` then browser `Accept-Language`, and the submission sets `persons.locale` if empty.

Content (product names, session names, email templates, form labels, site pages) is `LocalizedText` jsonb validated by `zLocalizedText` (nl-BE required, others optional while draft). `assertTranslated(doc, locales)` runs at publish time and at send time. A campaign to a segment containing French contacts cannot be sent while any French field is empty; the UI lists the missing keys. A transactional email job whose template lacks the recipient locale fails hard: job `dead`, Slack alert, task for marketing. Nothing is ever sent in the wrong language.

UI strings cannot be missing in production: `pnpm i18n:check` compares every locale file against `nl-BE` and fails CI on a missing key. If a key is nevertheless missing at runtime, `next-intl` `onError` reports to Sentry and `getMessageFallback` renders the key itself (`crm.person.title`) in admin and in portal. Emails use `t(locale, key)` from `packages/i18n` (no React context).

## 6. Money, credits and pricing

All amounts are integer cents in EUR. VAT rates allowed: 0, 6, 12, 21 percent, stored as `vat_rate_pct numeric(4,2)` on `prices` and snapshotted on every order line. `core/commerce/pricing.ts`:

```ts
resolvePrice({ product, person, status, at, promoCode }): { priceId, unitCents, vatRatePct, discountCents, promotionId }
priceOrder(lines): { lines, totalCents, vatCents }   // VAT per line = round-half-up(lineNet * rate)
```

Member discount is automatic: `person_status = member` selects the `member` price if one exists, else applies `product.config.discount_pct` of the membership product. Promotions apply after audience pricing and never stack (highest discount wins). `order_lines` snapshot everything; `prices` rows are never edited (a price change inserts version + 1). Invoice numbers are gapless per year: `BEAM-2026-000123`, allocated by `UPDATE settings ... FOR UPDATE` on key `invoice_counter_2026`; credit notes use `CN-2026-000045`.

Credits ledger: a purchase of a 10-session package inserts one `credit_entries` row (`purchase`, +10, `session`). A booking inserts `consume` (-1) in the same transaction as the booking. Cancellation inside the rules inserts `refund` (+1). The daily `packages.expire` job inserts `expire` (-remaining) for packages past `expires_at`. Extension inserts `extend` (+n) with a reason. Balance is always `SUM(units)`; no stored balance column exists. Consumption picks the active package with the earliest `expires_at` that matches the session's unit type. The customer sees "4 sessions remaining"; the word credits is internal.

Package sharing: `customer_packages.sharing` lists allowed person ids and `max_guests` per booking. A guest booking inserts `guest_use` (-1) on the owner's package with `beneficiary_person_id` = guest, and a `bookings` row for the guest with `booked_by_person_id` = owner. The owner's timeline shows the guest use; the guest's timeline shows the visit. Abuse control: `max_guests` default 1, and the booking action refuses more than 4 guest uses per package per 30 days (config in `settings`).

Memberships: product kind `membership`, `config = { discount_pct, included_units, unit_type, renewal_period: 'month'|'year', price_product_ids }`. Purchase creates the customer_package with `renews_at` and a Mollie mandate. `membership.renew` runs daily and creates a recurring payment for packages where `renews_at <= today`; included units are granted as `bonus` entries on successful payment. A failed renewal gets 7 days grace then status `expired`. Gift vouchers are packages with `unit_type = euro_cent`.

Refunds create a credit note (invoice kind `credit_note`, negative line snapshot) and a `PaymentProvider.refund` job. VAT on mixed-rate packages: a package is sold at the VAT rate of its product; a session consumed from it carries no new VAT line.

## 7. Automation engine

Trigger bus: `activity_events`. `automation.tick` (every minute) reads events with `id > settings.automation.cursor` in batches of 1,000, matches each against active automations' `trigger` (`{ kind: 'booking.confirmed', filter: {...} }`), and calls `enrol()`. Event kinds are typed in `modules/<m>/events.ts` (`defineEvent('booking.confirmed', PayloadSchema)`). The `inactivity` trigger is emitted by `retention.compute` as `person.inactive { days: 30|60|90 }`. Package thresholds are emitted by the ledger write as `package.threshold { pct: 50|75|80|90|100 }`.

`enrol(automation, person, anchorAt)` in `core/automation/enrol.ts` runs inside `SELECT ... FROM persons WHERE id = $1 FOR UPDATE`:
1. Refuse if an active enrolment exists for this automation (unless `allow_reentry`) or any active enrolment shares its `exclusion_group` (log `skipped_exclusion`). Exclusion groups in V1: `lead_nurture`, `customer_journey`, `package`, `inactivity`, `webinar`, `waitlist`.
2. Refuse if `entry_conditions` fail (segment rule tree evaluated in SQL) or, for `is_marketing`, if the person is suppressed or lacks `newsletter` consent.
3. Compute `scheduled_at = anchor_at + step.offset` for every step. Steps whose `scheduled_at < now()` get an `automation_runs` row `skipped_late_entry` immediately. `next_step_index` is the first future step, `next_run_at` its time. Scenario 1: a Friday registrant for a Sunday webinar gets only the confirmation and the day-of reminder.
4. Write `activity_events` kind `automation.entered`.

Step types in V1: `send_email`, `wait`, `create_task`, `add_tag`, `remove_tag`, `notify_staff`, `exit_if`. Each step has `offset`, `condition` (same rule tree) and `skip_if`. Branches and webhooks arrive with the workflow builder in Release 4; the `steps` jsonb already allows nested arrays so no migration is needed.

Send-time evaluation: each minute, `automation.tick` also loads enrolments with `next_run_at <= now()` (limit 500) and for each: re-evaluate `exit_rules` (e.g. `order.paid` exits lead nurture; `status = member` exits newcomer), re-check suppression and consent for marketing, evaluate the step `skip_if` (e.g. `has_future_booking`), then act. Every outcome writes exactly one `automation_runs` row. `send_email` enqueues `email.send` with key `auto:<enrolment_id>:<step_index>`; the email itself re-checks suppression once more at send time.

Exits: `exit_rules` are evaluated on every matching trigger event (so a purchase exits lead nurture within one minute) and at every step. Staff can call `exitEnrolment(id, reason)` and `moveToAutomation(personId, key)` from the person page; both are audited. Unsubscribe inserts the suppression and runs `automation.exit_marketing(person_id)` inline, so all marketing enrolments end with reason `unsubscribed` within seconds.

Per-person log: the person timeline renders `automation_enrolments` with their `automation_runs` (entered, trigger, step, skipped step with reason, exit, exit reason). Campaign and automation emails appear as `email_messages` rows with their `email_events`.

## 8. Integration boundaries

Every client lives in `packages/integrations/src/<provider>/client.ts`, takes credentials in its constructor, validates responses with Zod, and throws `IntegrationError { provider, retryable }`. Clients are called only from job handlers. When a user must wait for a result (a Mollie checkout URL), the server action enqueues the job and runs it inline with `runJobInline(ctx.tx, jobId)`, so even synchronous calls get logging, retries and alerts.

| Provider | Interface and where it is called | Failure surface |
| --- | --- | --- |
| Mollie | `PaymentProvider`: `createPayment`, `getPayment`, `refund`, `createMandate`, `createRecurringPayment`, `createPaymentLink`, `createTerminalPayment`, `verifyWebhook`. Jobs `payment.create`, `payment.sync`, `payment.refund`, `membership.renew`. Webhook posts only an id; the handler enqueues `payment.sync:<id>:<second>`. | Order stays `pending_payment`; customer sees "payment not confirmed yet"; dead job pages finance. |
| Billit | `billit.sync_customer`, `billit.sync_invoice` after `invoices.issued_at` is set; `billit.poll` every 5 minutes fetches payment status for bank-transfer invoices. | `invoices.billit_status = failed` badge on the invoice, task for finance, Slack alert. Invoices are valid locally regardless. |
| Resend | `email.send` (single), `campaign.batch` (100 per call), from `mail.beam.be` or `news.beam.be` by template kind. Webhook (svix signature) writes `email_events`; `bounced` hard and `complained` insert `suppressions`. | `email_messages.status = failed`; dead job alerts; campaign stats show failures. |
| YouTube (R2) | `youtube.create_broadcast`, `youtube.get_stream_status` via OAuth on BEAM's Google account; player embedded in the portal; `POST /api/webinar/heartbeat` every 30 s writes `webinar_interactions`. | Webinar page shows "stream starting"; staff see broadcast status on the session. |
| Meta and Google Ads (R3) | `ads.pull` daily into `ad_spend_daily` (added in R3). Read-only. | Dashboard shows "last synced at"; stale over 48 h triggers alert. |
| Claude (R4, plus website editing in V1) | `anthropic.draft(kind, context)` with `claude-opus-5-5`, `anthropic.classify()` with `claude-haiku-5-5`. Jobs `ai.draft`, `ai.classify`. Input always built by `toAiContext()`. Prompt and output stored in `ai_requests` (R4 table) for 90 days. | 3 attempts, then the UI shows "AI unavailable, write manually". Never blocks a human path. |

Secrets: Vercel environment variables per environment; Neon connection strings in Vercel via the Neon integration. No secret in the repo; `pnpm check:secrets` (gitleaks) runs in CI.

## 9. Environments and delivery

| Environment | App | Database | Data |
| --- | --- | --- | --- |
| local | `pnpm dev` | personal Neon branch from `staging` | seed |
| preview | Vercel preview per PR | Neon branch `preview/<pr>` created by GitHub Action on PR open, deleted on close | seed |
| staging | Vercel branch `staging` | Neon branch `staging` | synthetic seed before go-live; anonymised copy of production weekly after go-live (`pnpm db:anonymise`) |
| production | Vercel `main`, `fra1` | Neon `main`, Frankfurt | real |

Migrations: `drizzle-kit generate` writes SQL to `packages/db/migrations`. `deploy.yml` on push to `main` runs `pnpm db:migrate` against production, then `vercel deploy --prod`. Migrations are expand-only: add tables, add nullable columns, add views. Drops and renames ship one release later, after the code no longer references the old shape. Because of this rule, rollback is Vercel's instant rollback to the previous deployment with no database change. Data rollback is a Neon point-in-time restore to a new branch, verified, then promoted; runbook in `docs/runbooks/restore.md`.

Feature flags: `flag('webinars', ctx)` reads `feature_flags` (cached 30 s). `enabled_for = testers` means `users.is_tester` or listed `person_ids`. Flags are declared in `src/lib/flags.ts` as a typed constant so a typo fails typecheck. A flag is removed from code within two sprints of reaching `everyone`.

CI (`ci.yml` on every PR): typecheck, lint, `i18n:check`, unit tests, integration tests against a fresh Neon branch, Playwright on the preview URL for 5 critical flows (register, book and pay, cancel, unsubscribe, admin edits booking). Merge requires green CI and one review.

## 10. Observability, backup, restore, security

Observability: Sentry EU with `requestId` and `jobId` tags; structured JSON logs (`src/lib/logger.ts`) to Vercel logs; `GET /api/health` returns 200 only if the database answers and the last cron tick is under 3 minutes old; Better Stack checks it every 30 s and alerts Slack `#beam-alerts`. Alert rules (jobs `alert.evaluate` every 15 min): any `dead` job, more than 20 `failed` jobs in 15 min, bounce rate over 3 percent on the last 1,000 emails, more than 5 failed payments in an hour, Billit sync failures, no cron tick for 5 minutes. `/admin/system` shows job queues, dead jobs with a retry button, email health and integration status.

Backup and restore: Neon point-in-time recovery, 7-day window on Launch (30 on Scale). Nightly `backup.yml` runs `pg_dump` and uploads an `age`-encrypted dump to Scaleway Object Storage (Paris, EU company), 90-day retention; the key is held by BEAM and Sidestream. RPO: 5 minutes (PITR). RTO: 2 hours, inside the 8-hour promise. `backup.verify` restores last night's dump into a throwaway Neon branch weekly and counts rows; a quarterly full restore drill is logged in `docs/runbooks/restore-log.md`.

Security controls: TLS and HSTS; strict CSP with nonces; TOTP for all staff; password policy above; Postgres sessions revocable from `/admin/settings/users`; permission checks in `action()`; `redact()` on every persons query; AES-256-GCM on sensitive columns; audit log on writes and sensitive reads; webhook signature verification; Vercel WAF rate limits; Zod on every boundary; Drizzle parameterised SQL; Renovate plus `pnpm audit` weekly; gitleaks in CI; export job (`persons.export`, zip of JSON and CSV per table) and deletion job (anonymise `persons`, `form_submissions`, `webinar_interactions`, `email_messages`; drop `waitlist_entries` and `automation_enrolments`; unlink invoices; keep `suppressions` row with hashed email; call Resend contact delete and Billit customer anonymise; produce a report without personal data). Retention is a `settings` table (`retention.<table>` in days) enforced by `retention.enforce` weekly.

## 11. How AI agents build this in parallel tonight

**Hour 0 to 3, one agent, sequential: the scaffold.** Nothing else starts before it merges.
1. Turborepo workspace, all packages with `package.json`, tsconfig, eslint boundaries, Tailwind, shadcn init, Vitest, Playwright, CI.
2. `packages/db`: client, `platform.ts`, `auth.ts`, `crm.ts` with `persons`, `activity_events`, `audit_log`, `consent_records`, `suppressions`; the append-only trigger; `src/test/db.ts` (transaction-per-test) and `factories.ts` (`makePerson`, `makeUser`).
3. `src/lib/action.ts`, `auth.ts` for both audiences, `flags.ts`, `logger.ts`, `i18n` wiring, `enqueue`, the job runner and `/api/cron/tick`, `defineJob`, `defineEvent`.
4. Layout shells for the three route groups with navigation reading `modules/*/nav.ts`.
5. `packages/email`: base layout, `sendEmail()` job, one working transactional template.
6. Empty but importing stub files for every module: `actions.ts`, `queries.ts`, `jobs.ts`, `schemas.ts`, `nav.ts`, `permissions.ts`, `events.ts`, `packages/db/src/schema/<module>.ts`, `packages/core/src/<module>/index.ts`, `packages/i18n/messages/<locale>/<module>.json`, `apps/web/src/app/[locale]/(admin)/admin/<module>/page.tsx`. All index and barrel files already import every module stub.

**Frozen files** after the scaffold: everything in `src/lib`, `src/jobs/index.ts`, `packages/db/src/schema/index.ts`, `packages/db/src/schema/{platform,auth}.ts`, `packages/core/src/auth`, `packages/config`, root configs. A change to a frozen file is a separate tiny PR by the integrator, never part of a module branch.

**Ownership.** An agent edits only its own folders and never another module's files. Cross-module needs are expressed through `activity_events` kinds or `core` types, never direct imports.

| Agent | Module | Owns |
| --- | --- | --- |
| A1 | crm | persons, companies, timeline, consent, suppression, segments, merge, tasks, export, deletion |
| A2 | commerce | products, prices, promotions, orders, checkout, Mollie, invoices, Billit, ledger, packages, memberships, POS |
| A3 | booking | session templates, sessions, bookings, cancellation rules, waitlist and claim links, portal booking UI |
| A4 | forms | builder, versions, logic, scoring, result pages, lead capture, UTM, embed script |
| A5 | email | templates, block editor, MJML, campaigns, sending, events, preference centre, unsubscribe |
| A6 | automation | engine, enrolments, tick, the six V1 sequences as seed data |
| A7 | ops | action dashboard, reports, roles UI, settings, audit UI, imports, system page |
| A8 | site | public website, Claude-assisted page editing, SEO, booking entry points |

`crm` ships `persons` in the scaffold, so no agent waits on A1. A2 and A3 share `bookings.order_line_id`: A3 owns `bookings`, A2 owns `order_lines`, and the FK is declared in `booking.ts` against the scaffolded stub column list in `commerce.ts` (the scaffold pre-declares `order_lines.id`).

**Naming conventions.** Tables snake_case plural; columns snake_case; `*_at` timestamps; `*_cents` money; `is_*` booleans; pg enums named `<table>_<column>`; job kinds `module.verb_noun`; event kinds `entity.past_tense`; permissions `module.action`; message keys `module.screen.key`; routes `/admin/<module>/<entity>/[id]`, `/portal/<entity>`, `/api/<purpose>`; server actions `verbNoun`; files kebab-case; React components PascalCase; Zod schemas `XInput` and `XOutput`; core functions pure and named by what they return (`resolvePrice`, `computeBalance`, `planSteps`).

**Migrations during the overnight build.** Agents edit schema files only and never run `drizzle-kit generate`. After all module branches merge, the integrator generates one migration `0001_init.sql`. From the next day on, one migration per PR, generated after rebase on `main`.

**Test strategy that makes parallel work safe.**
- `packages/core`: pure functions, Vitest, no database, must stay above 90 percent coverage for `pricing`, `ledger`, `automation`, `waitlist`. These run in under 10 seconds.
- Module integration tests in `modules/<m>/__tests__`, Vitest against a Neon branch, each test inside a rolled-back transaction, fixtures only from `factories.ts`. No test touches another module's tables except through factories.
- Registry tests in the scaffold: unique job kinds, unique event kinds, unique permissions, every message key present in all three locales, every `sensitive()` column absent from `toAiContext()`.
- Playwright on preview for the five critical flows, owned by A7, written against stable `data-testid` names agreed in the scaffold.
- The seven proposal scenarios each get one named test file: `scenario-1-late-entry.test.ts` (automation), `scenario-2-fast-unsubscribe.test.ts` (email), `scenario-3-lead-access.test.ts` and `scenario-4-seat-claim.test.ts` (booking), `scenario-5-replay-separation.test.ts` (webinar, R2), `scenario-6-sensitive-ai.test.ts` (crm), `scenario-7-deletion.test.ts` (crm). These are the acceptance checklist in code.

**Branch and merge.** Branch `agent/<module>`, rebase on `main` every 2 hours, one PR per module per night. Merge order: ops shell, crm, commerce, booking, forms, email, automation, site. CI green and typecheck across the whole workspace are the merge gate; the integrator resolves the rare conflict in a barrel file.

## 12. Top 10 risks

| # | Risk | Mitigation |
| --- | --- | --- |
| 1 | Agents collide on shared files and block each other | Scaffold pre-creates every module file and barrel; frozen-file list; one agent per module; no cross-module imports; one migration generated by the integrator. |
| 2 | The one-minute cron is too slow or too coarse for user-facing side effects | Inline kick with `after()` right after commit; cron is the safety net; `SKIP LOCKED` lets ticks overlap; `maxDuration 300`. |
| 3 | Double sends or double charges from retries | Unique `idempotency_key` on every job; handlers check their own markers; Mollie payments created once per order with key `payment.create:<order_id>`. |
| 4 | Ledger drift between bookings and credits | Booking and `consume` entry in one transaction; balances are a view, never a column; nightly `ledger.reconcile` job compares bookings to entries and alerts on mismatch. |
| 5 | Wrong-language or untranslated email reaches a customer | `assertTranslated` at publish and at send; CI `i18n:check`; dead job plus alert instead of fallback. |
| 6 | Sensitive data leaks to AI or exports | `sensitive()` column registry; `toAiContext()` allow-list with a test; exports strip by default; audit on reads. |
| 7 | Marketing continues after unsubscribe | Suppression checked at enqueue, at batch send and in automation evaluation; inline `exit_marketing`; imports never write `suppressions`. |
| 8 | Waitlist race gives two people one seat | `waitlist.expire` and claim both take `SELECT ... FOR UPDATE` on the session row; unique (session_id, person_id); confirmed seats are never touched by automation (guarded in `core/waitlist`). |
| 9 | Migration breaks production or cannot be rolled back | Expand-only migrations; migrate before deploy; instant Vercel rollback; PITR drill before go-live. |
| 10 | Mollie, Billit or Resend outage stalls operations | All calls are jobs with backoff up to 6 h; invoices valid locally; POS can record `cash` and `bank_transfer`; dashboard shows integration status; alerts within 15 minutes. |
