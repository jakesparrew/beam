# Module spec: platform (Platform foundation)

Owner module id: `platform`. Blueprint sections 55, 56, 61, 64, 65, 67, 71, 72, 78, 80, plus the platform-facing parts of 2, 4 (language as an operational field), 50, 57–60, 62–63, 66, 68–70, 73–77, 79, 82 and 88. This spec obeys `docs/plan/00-decisions.md` and `docs/plan/01-architecture.md`. Where they are silent, this spec decides, and section 13 lists each decision.

## 1. Purpose and release mapping

The platform module is the floor every other module stands on. It owns identity of staff and customer *accounts* (not persons), permissions, the request model (`action()`, `ctx`), the job system and the one-minute tick, settings, feature flags, files, the webhook inbox, the integration log, the AI gateway, the audit log, i18n infrastructure, the shared UI kit, observability, security controls, the seed framework, CI and the runbooks. It also runs Wave 0: the workspace, generators, every module's skeleton files and the cross-module `api.ts` stubs.

| Release | What platform ships |
| --- | --- |
| **V1 (weeks 1–6)** | Everything in this spec except the R3 and R4 rows below. Wave 0 (packages platform-P1 to platform-P7) lands in the first overnight session, including a working transactional email path (`email.sendTransactional` and `email.send`, written on behalf of the email module) so magic links work from night one. platform-P8 (`platform-admin`) lands in Wave 1. platform-P11 (handbook, training material, load tests, exit export) is a week-5 sprint package after Waves 1 and 2 have merged, finished by week 6, before training in week 7. That covers "roles and permissions", "audit log", "NL/FR/EN everywhere", secure hosting, backup, export plumbing, documentation (blueprint 80), training material (blueprint 79), the support register and monthly SLA report (proposal section 7, blueprint 73), monitoring (blueprint 72), the security safeguards (blueprint 64), staging (blueprint 78) and the go-live gate (blueprint 77). |
| **Release 2 (weeks 9–10)** | No new platform tables or screens. R2 features (webinar portal, lead-priority windows, abandoned checkout) ship behind flags (`ff_webinar_portal`, `ff_booking_lead_priority`, `ff_commerce_abandoned_checkout`) that their owning modules declare. V1 already includes the YouTube `frame-src` in the CSP and the heartbeat rate-limit bucket, so R2 needs no platform change. |
| **Release 3 (weeks 11–12)** | platform-P9: the `external_partner` access scope (`partner.own`) and partner sign-in for referral and partner management; the `meta` webhook provider for the unified inbox; integration health rows for Meta and Google Ads; ads tokens on the System integrations screen. |
| **Release 4 (weeks 13–14)** | platform-P10: the read-only AI SQL role `beam_ai_ro` and the `ai` schema of non-sensitive views; `runAiReadOnlyQuery()`; Message Batches support in the Claude client for `ai.weekly_summary`; daily usage charts and the read-only SQL log on `/admin/system/ai` (the feature register of blueprint 61 and per-feature cost are already V1, because `site.propose_page` uses Claude in V1). |
| **Later (out of scope)** | Passkeys/WebAuthn for staff, SSO with Google Workspace, SMS second factor, a native mobile app shell, multi-tenant configuration for a BRANDEPIC offering (blueprint 82; one deployment per client stays the rule), voice-AI telephony credentials, a second cron route for the bulk lane (only if risk 1 materialises). |

## 2. Domain model

All tables live in `packages/db/src/schema/platform.ts`; views in `packages/db/src/schema/platform.views.ts`. Shared helpers come from `packages/db/src/schema/_shared.ts` (written by platform-P2): `id()` = `uuid('id').primaryKey().defaultRandom()`, `createdAt()`, `timestamps()` (`created_at`, `updated_at timestamptz not null default now()`, `$onUpdate(() => new Date())`), `localized(name)` (jsonb typed `LocalizedText`), `sensitive(column, { table, key })` (registers in `SENSITIVE_COLUMNS`), `bytea(name)` (Drizzle `customType` mapping to `Uint8Array`), the enum `locale` (`nl-BE|fr-BE|en`), `APPEND_ONLY_TABLES` (string list read by the append-only SQL) and the `ActorJson` type.

`ActorJson = { kind: 'staff'|'customer'|'system'|'job'|'webhook'; id: string | null; roleKey?: string; provider?: string }`.

### Enums

| pgEnum name | Values |
| --- | --- |
| `locale` (shared) | `nl-BE`, `fr-BE`, `en` |
| `users_audience` | `staff`, `customer` |
| `users_status` | `active`, `disabled` |
| `roles_key` | `owner`, `management`, `customer_service`, `sales`, `marketing`, `finance`, `reception`, `technical_admin`, `external_partner` |
| `jobs_lane` | `fast`, `bulk` |
| `jobs_status` | `pending`, `running`, `succeeded`, `failed`, `dead` |
| `webhook_events_provider` | `mollie`, `resend`, `billit` (R3 adds `meta`) |
| `integration_calls_provider` | `mollie`, `stripe`, `viva`, `billit`, `resend`, `youtube`, `meta_ads`, `google_ads`, `anthropic`, `slack`, `betterstack` (R3 adds `meta`) |
| `feature_flags_state` | `off`, `testers`, `on` |
| `files_kind` | `invoice_pdf`, `import`, `export`, `image`, `rendered_email`, `receipt` |
| `ai_requests_status` | `ok`, `error`, `budget_exceeded` |
| `security_incidents_severity` | `critical`, `high`, `normal` |
| `security_incidents_status` | `open`, `contained`, `resolved` |
| `support_requests_severity` | `critical`, `high`, `normal`, `improvement` (the four levels of proposal section 7) |
| `support_requests_channel` | `email`, `slack`, `whatsapp`, `phone`, `in_app` |
| `support_requests_status` | `open`, `responded`, `resolved`, `closed` |
| `monthly_reports_status` | `draft`, `sent` |

`jobs_status = failed` is reserved. The runner never writes it: a failed attempt goes back to `pending` with `last_error` and a later `run_at`, or to `dead` (rule PL-27). It stays in the enum because the architecture lists it.

### `users`
| Column | Type | Null | Default / check |
| --- | --- | --- | --- |
| id | uuid | no | `gen_random_uuid()` |
| audience | users_audience | no | |
| email | text | no | check `email = lower(email)` and `position('@' in email) > 1` |
| email_verified_at | timestamptz | yes | Drizzle property `emailVerified` (Auth.js adapter) |
| name | text | yes | |
| image | text | yes | required by the Auth.js adapter, unused |
| password_hash | text | yes | argon2id PHC string; check `password_hash is null or password_hash like '$argon2id$%'` |
| password_changed_at | timestamptz | yes | |
| locale | locale | no | `'nl-BE'` |
| role_key | roles_key | yes | FK `roles.key` on update cascade, on delete restrict |
| person_id | uuid | yes | FK `persons.id` (crm) on delete restrict |
| totp_secret_enc | bytea | yes | AES-256-GCM, AAD `users.totp_secret:<id>` |
| recovery_codes_enc | bytea | yes | AES-256-GCM of JSON `[{hash, used_at}]`, hash = sha256 hex of the code |
| secret_key_version | smallint | yes | key version of the two columns above |
| mfa_enrolled_at | timestamptz | yes | |
| is_tester | boolean | no | `false` |
| failed_logins | integer | no | `0`, check `>= 0` |
| locked_until | timestamptz | yes | |
| last_login_at | timestamptz | yes | |
| status | users_status | no | `'active'` |
| created_by_user_id | uuid | yes | FK `users.id` |
| created_at, updated_at | timestamptz | no | `now()` |

Constraints and indexes: unique index `users_email_lower_uq` on `lower(email)`; check `users_audience_shape_ck`: `(audience = 'staff' and role_key is not null) or (audience = 'customer' and role_key is null and person_id is not null)`; check `users_partner_person_ck`: `role_key <> 'external_partner' or person_id is not null`; partial unique `users_customer_person_uq` on `(person_id) where audience = 'customer'` (one portal account per person); index `users_role_idx (role_key) where audience = 'staff'`. Invariant: a staff user cannot open an admin page until `mfa_enrolled_at` is set and the session carries `mfa_at`.

### `auth_accounts` (Auth.js adapter)
`user_id uuid not null` FK `users.id` on delete cascade, `type text not null`, `provider text not null`, `provider_account_id text not null`, `refresh_token text`, `access_token text`, `expires_at integer`, `token_type text`, `scope text`, `id_token text`, `session_state text`. Primary key `(provider, provider_account_id)`. Stays empty in V1 (Credentials and Email providers do not link accounts); kept so the adapter type-checks.

### `auth_sessions` (Auth.js adapter)
| Column | Type | Null | Default |
| --- | --- | --- | --- |
| id | uuid | no | `gen_random_uuid()` |
| session_token | text | no | unique; Drizzle property `sessionToken` |
| user_id | uuid | no | FK `users.id` on delete cascade; property `userId` |
| audience | users_audience | no | |
| expires_at | timestamptz | no | property `expires`; idle expiry (staff now + 12 h, customer now + 90 d), slid forward on use |
| absolute_expires_at | timestamptz | no | staff created_at + 7 d, customer created_at + 90 d |
| mfa_at | timestamptz | yes | set after the TOTP step |
| last_seen_at | timestamptz | no | `now()`; written at most once per 5 minutes |
| ip | text | yes | first IP |
| user_agent | text | yes | truncated to 300 chars |
| created_at | timestamptz | no | `now()` |

Indexes: `auth_sessions_user_idx (user_id)`, `auth_sessions_expires_idx (expires_at)`. Check `absolute_expires_at >= created_at`.

### `auth_verification_tokens` (Auth.js adapter)
`identifier text not null`, `token text not null` (Auth.js stores sha256(token + AUTH_SECRET)), `expires_at timestamptz not null` (property `expires`), `created_at timestamptz not null default now()`. Primary key `(identifier, token)`. Identifiers: plain lower-cased email for customer magic links (15 min), `staff-invite:<user_id>` (72 h), `password-reset:<user_id>` (1 h). Index on `expires_at`.

### `roles`
`id uuid pk`, `key roles_key not null unique`, `name jsonb not null` (LocalizedText), `description jsonb not null default '{}'`, `permissions text[] not null default '{}'`, `seeded_permissions text[] not null default '{}'` (every permission a seed has ever granted, so a seed never re-grants one the owner removed), `is_system boolean not null default true`, `updated_by_user_id uuid` FK `users.id`, `created_at`, `updated_at`. Check `roles_owner_all_ck`: `key <> 'owner' or permissions = '{*}'`. Invariant: `'*'` appears only on `owner` and means every permission in `registry/permissions.generated.ts`, including ones added later. All nine rows are seeded; roles are not created or deleted in V1.

### `jobs`
| Column | Type | Null | Default / check |
| --- | --- | --- | --- |
| id | uuid | no | `gen_random_uuid()` (callers may pass an id) |
| kind | text | no | check `kind ~ '^[a-z_]+\.[a-z_]+$'` |
| payload | jsonb | no | `'{}'` |
| idempotency_key | text | no | unique |
| lane | jobs_lane | no | `'fast'` |
| priority | smallint | no | `5`, check `between 1 and 9` |
| status | jobs_status | no | `'pending'` |
| run_at | timestamptz | no | `now()` |
| attempts | integer | no | `0`, check `>= 0` |
| max_attempts | integer | no | `6`, check `>= 1` |
| locked_at | timestamptz | yes | |
| locked_by | text | yes | tick id `tick:<uuid>` or `inline:<request_id>` |
| last_error | text | yes | first 2,000 chars, scrubbed |
| result | jsonb | yes | |
| request_id | text | yes | request that enqueued it (tracing) |
| started_at, finished_at | timestamptz | yes | |
| created_at, updated_at | timestamptz | no | `now()` |

Indexes: `jobs_pending_idx (lane, priority, run_at) where status = 'pending'`; `jobs_running_idx (locked_at) where status = 'running'`; `jobs_done_idx (status, finished_at) where status in ('succeeded','dead')`; `jobs_kind_idx (kind, status, created_at desc)`. Check `jobs_running_lock_ck`: `status <> 'running' or locked_at is not null`.

### `webhook_events` APPEND
`id uuid pk`, `provider webhook_events_provider not null`, `external_event_id text not null`, `payload jsonb not null`, `received_at timestamptz not null default now()`, `job_id uuid not null` (the id of the `webhook.process` job created in the same transaction; no FK because jobs are pruned), `created_at`. Unique `(provider, external_event_id)`; index `(provider, received_at desc)`.

### `integration_calls` APPEND
`id uuid pk`, `provider integration_calls_provider not null`, `operation text not null` (e.g. `payments.get`, `webhook.signature_failed`), `request_digest text not null` (sha256 hex of the canonical request: method, path, sorted non-secret params; never bodies), `status_code integer`, `ok boolean not null`, `duration_ms integer not null check >= 0`, `error text` (first 1,000 chars, scrubbed), `job_id uuid`, `created_at`. Indexes: `(provider, created_at desc)`, `(created_at)`, `(job_id)`.

### `audit_log` APPEND
`id uuid pk`, `actor jsonb not null` (ActorJson), `action text not null` (check `~ '^[a-z_]+\.[a-z_]+$'`), `entity_type text not null`, `entity_id text`, `person_id uuid` FK `persons.id`, `old_value jsonb`, `new_value jsonb`, `request_id text`, `ip text`, `is_redacted boolean not null default false`, `created_at`. Indexes: `(entity_type, entity_id, created_at desc)`, `(person_id, created_at desc)`, `(action, created_at desc)`, `(created_at desc)`, expression index `((actor->>'id'), created_at desc)`. Invariant: values never contain a `SENSITIVE_COLUMNS` member or a password, token or secret (the writer replaces them with `"[redacted]"`).

### `settings`
`id uuid pk`, `key text not null unique` (check `~ '^[a-z_]+$'`), `value jsonb not null`, `version integer not null default 1 check >= 1`, `updated_by_user_id uuid` FK `users.id`, `created_at`, `updated_at`. Keys and owners (each declared with a Zod schema and default in `apps/web/modules/<m>/config.ts`): platform `ai`, `last_tick_at`, `company`, `go_live_gate`, `security`, `support`; booking `booking_rules`, `business_hours`; email `email_footer`, `warmup_schedule`; automation `automation_cursor`; ops `retention_defaults`; commerce `payment_provider_by_channel`. System keys (`last_tick_at`, `automation_cursor`) are written without a version bump or audit row.

Platform keys:
- `ai`: `{ sensitive_enabled: false, purpose: null, dpia_reference: null, enabled_by_user_id: null, enabled_at: null, monthly_budget_cents: 10000, daily_cap_calls: 500, pricing: { 'claude-opus-5-5': { in_cents_per_mtok: 400, out_cents_per_mtok: 2000, cache_read_cents_per_mtok: 20 }, 'claude-haiku-5-5': { in_cents_per_mtok: 10, out_cents_per_mtok: 50, cache_read_cents_per_mtok: 1 } } }`.
- `company`: `{ legal_name: 'Vibrant Lifestyle Collective BV', trade_name: 'BEAM Vitality Center', vat_number: string (BE + 10 digits), enterprise_number: string, address: { street, postal_code, city, country: 'BE' }, support_email, phone, website }`. Finance (issuer details such as IBAN and register court) and site (contact block) read it; finance's company form writes it through `setSetting()`.
- `go_live_gate`: `{ items: Record<GateItemKey, { confirmed_by_user_id, confirmed_at, note }> }` with the 13 keys of blueprint 77: `dpa_signed`, `subprocessors_confirmed`, `region_confirmed`, `transfers_documented`, `ai_no_training_confirmed`, `retention_agreed`, `export_tested`, `deletion_tested`, `security_confirmed`, `backup_confirmed`, `recovery_confirmed`, `permissions_configured`, `acceptance_passed`.
- `security`: `{ current_key_version: 1, staff_idle_hours: 12, staff_idle_hours_by_role: { reception: 4 }, staff_absolute_days: 7, customer_session_days: 90, lockout_threshold: 10, lockout_minutes: 15, last_backup_at: null, last_backup_ok: null, last_restore_drill_at: null, last_restore_drill_ok: null, last_pentest_on: null, next_pentest_due_on: null }`. `staff_idle_hours_by_role` overrides the idle timeout for roles that work on shared devices (the reception desk tablet signs out after 4 idle hours).
- `support` (platform): `{ business_hours: { weekday: ['09:00','18:00'], weekend_critical: ['10:00','18:00'] }, response_minutes: { critical_business: 120, critical_weekend: 240, high: 240, normal: 540, improvement: 1080 }, emergency_phone: string, support_email: string, report_recipients: string[] }`. Response targets are counted in support minutes (rule PL-88); `normal` = 1 business day (9 support hours), `improvement` = 2 business days. This key is distinct from booking's `business_hours` (the centre's opening hours).

### `feature_flags`
`id uuid pk`, `key text not null unique` (check `~ '^ff_[a-z]+_[a-z0-9_]+$'`), `state feature_flags_state not null default 'off'`, `user_ids uuid[] not null default '{}'`, `person_ids uuid[] not null default '{}'`, `description text not null default ''`, `updated_by_user_id uuid` FK `users.id`, `created_at`, `updated_at`. A flag is on for an actor when `state = 'on'`, or `state = 'testers'` and (the actor's user `is_tester`, or its person `is_tester`, or its id is in `user_ids` / `person_ids`).

### `files`
`id uuid pk`, `kind files_kind not null`, `name text not null` (check length 1–200, no `/` or `\`), `mime text not null`, `size_bytes integer not null` (check `between 0 and 10485760`), `bytes bytea not null`, `sha256 text not null` (check `~ '^[0-9a-f]{64}$'`), `is_public boolean not null default false`, `expires_at timestamptz`, `person_id uuid` FK `persons.id`, `created_by_user_id uuid` FK `users.id`, `created_at`. Checks: `files_public_kind_ck`: `not is_public or kind = 'image'`; `files_mime_ck`: `kind <> 'image' or mime in ('image/png','image/jpeg','image/webp','image/gif')`. Indexes: `(person_id)`, `(expires_at) where expires_at is not null`, `(kind, created_at desc)`, `(sha256)`. Queries never `select *`: list queries omit `bytes` (Neon egress).

### `ai_requests` APPEND
`id uuid pk`, `feature text not null` (an `AI_FEATURES` key), `model text not null` (check in `('claude-opus-5-5','claude-haiku-5-5')`), `actor jsonb not null`, `person_id uuid` FK `persons.id`, `fields_sent text[] not null default '{}'`, `prompt text not null`, `output text`, `input_tokens integer not null default 0`, `output_tokens integer not null default 0`, `cache_read_tokens integer not null default 0`, `cost_cents numeric(12,4) not null default 0`, `status ai_requests_status not null`, `error text`, `job_id uuid`, `duration_ms integer`, `created_at`. Indexes: `(created_at)`, `(feature, created_at desc)`, `(person_id)`. Purged after 30 days by the retention sweep. `prompt` and `output` are personal data (they may contain a first name); they never contain sensitive fields (rule PL-60).

### `rate_limits` (addition)
`key text primary key` (`login:ip:<ip>`, `login:acct:<sha256(email)>`, `magic:<sha256(email)>`, `forms:ip:<ip>`, `heartbeat:<registration_id>`, `api:ip:<ip>`), `window_start timestamptz not null`, `count integer not null default 0`, `expires_at timestamptz not null`. Index `(expires_at)`. Fixed-window counter: `insert ... on conflict (key) do update set count = case when rate_limits.window_start < $windowStart then 1 else rate_limits.count + 1 end, window_start = greatest(...)`. Holds no plain personal data.

### `security_incidents` (addition, blueprint 65)
`id uuid pk`, `title text not null`, `severity security_incidents_severity not null`, `status security_incidents_status not null default 'open'`, `discovered_at timestamptz not null`, `beam_notified_at timestamptz`, `systems_affected text not null default ''`, `data_affected text not null default ''`, `risk text not null default ''`, `actions text not null default ''`, `notifications text not null default ''`, `resolution text not null default ''`, `resolved_at timestamptz`, `created_by_user_id uuid not null` FK `users.id`, `created_at`, `updated_at`. Check `status <> 'resolved' or resolved_at is not null`. Index `(status, discovered_at desc)`. Free text must not name customers (UI hint; reviewed in the quarterly security report). Transitions (rule PL-73a): `open → contained`, `open → resolved`, `contained → resolved`, `resolved → open` (reopen, clears `resolved_at`, needs a note appended to `actions`); every other change of `status` is `conflict`.

### `support_requests` (addition, blueprint 73, proposal section 7)
`id uuid pk`, `reference text not null unique` (`SUP-2026-0001`, allocated from the max of the year inside the insert transaction under `lock table support_requests in share row exclusive mode`), `severity support_requests_severity not null`, `channel support_requests_channel not null`, `title text not null` (check length 3–200), `description text not null default ''`, `status support_requests_status not null default 'open'`, `received_at timestamptz not null`, `response_due_at timestamptz not null` (computed by `slaDueAt()`, rule PL-90), `first_response_at timestamptz`, `resolved_at timestamptz`, `reported_by_user_id uuid` FK `users.id`, `assignee_user_id uuid` FK `users.id`, `incident_id uuid` FK `security_incidents.id`, `page_url text`, `request_id text`, `created_at`, `updated_at`. Checks: `first_response_at is null or first_response_at >= received_at`; `status not in ('resolved','closed') or resolved_at is not null`. Indexes `(status, response_due_at)`, `(received_at desc)`. The breach flag lives in view `v_support_sla`. Transitions: `open → responded` (sets `first_response_at`), `open|responded → resolved`, `resolved → closed`, `resolved → open` (reopen). Free text must not contain customer personal data; staff reference customers by person id link only.

### `monthly_reports` (addition, proposal section 7)
`id uuid pk`, `month_on date not null unique` (first day of the Brussels month), `status monthly_reports_status not null default 'draft'`, `data jsonb not null` (`MonthlyReportData`: `{ uptime_pct, downtime_minutes, uptime_source: 'betterstack' | 'manual', incidents: { critical, high, normal }, support: { per_severity: { received, resolved, median_first_response_minutes, breaches } }, dead_jobs, alerts_sent, backups_ok, backups_failed, restore_drill: { at, ok } | null, ai_spend_cents, db_size_bytes, files_size_bytes }`), `notes text not null default ''`, `sent_at timestamptz`, `sent_by_user_id uuid` FK `users.id`, `created_at`, `updated_at`. Holds counts only, no personal data.

### Markings summary
- **APPEND** (trigger `reject_update_delete()`, bypass only with `SET LOCAL beam.allow_rewrite = 'on'`): `webhook_events`, `integration_calls`, `audit_log`, `ai_requests`.
- **Mutable additions**: `support_requests`, `monthly_reports` (both `updated_at`; changes audited).
- **IMMUTABLE**: none; platform has no versioned definitions. `settings` keeps history through `audit_log` old and new values.
- **Sensitive (special-category) columns**: none owned by platform. Platform provides the `sensitive()` helper and the encryption that crm (`person_sensitive_fields.value_enc`) and forms (`form_sensitive_answers.value_enc`) use.
- **Secret columns** (encrypted with the same keyring, never exported, never logged): `users.totp_secret_enc`, `users.recovery_codes_enc`; hashed: `users.password_hash`, `auth_verification_tokens.token`.
- **Personal-data columns** (covered by section 9): `users.email`, `users.name`, `auth_sessions.ip`, `auth_sessions.user_agent`, `audit_log.ip`, `audit_log.old_value`, `audit_log.new_value`, `ai_requests.prompt`, `ai_requests.output`, `files.bytes`, `webhook_events.payload`.

### Views (`platform.views.ts`, Drizzle `pgView` with `.as(sql\`...\`)`)

```sql
-- v_job_stats: one row per lane and status, for /admin/system and the health endpoint
select lane, status, count(*)::int as jobs,
       min(run_at) filter (where status = 'pending') as oldest_pending_run_at,
       max(finished_at) as last_finished_at
from jobs group by lane, status;

-- v_integration_health: last 24 h per provider
select provider, count(*)::int as calls_24h,
       count(*) filter (where not ok)::int as errors_24h,
       max(created_at) filter (where ok) as last_ok_at,
       max(created_at) filter (where not ok) as last_error_at
from integration_calls where created_at > now() - interval '24 hours' group by provider;

-- v_ai_usage_month: spend and calls per Brussels month and feature
select date_trunc('month', created_at at time zone 'Europe/Brussels') as month, feature, model,
       count(*)::int as calls, sum(cost_cents) as cost_cents,
       sum(input_tokens)::bigint as input_tokens, sum(output_tokens)::bigint as output_tokens
from ai_requests group by 1, 2, 3;

-- v_support_sla: one row per request with its breach flag, for the support screen and the monthly report
select id, reference, severity, status, received_at, response_due_at, first_response_at, resolved_at,
       coalesce(first_response_at, now()) > response_due_at as is_breached,
       extract(epoch from (first_response_at - received_at))::int / 60 as first_response_minutes
from support_requests;
```

### Tables of other modules that platform reads or writes
- Reads `persons` (crm): `id`, `first_name`, `last_name`, `email`, `locale`, `is_tester`, `partner_company_id`, `erased_at` for sign-in, flags, partner scope and demo seed.
- Reads `orders` (commerce Wave 0 contract table: `created_at`, `channel`) only as a count inside `platform.check_alerts` for the Mollie-silence alert (PL-75); never personal columns.
- Writes `activity_events` (crm) only through `recordEvent()` (the function lives in `apps/web/lib/events.ts`; the table belongs to crm).
- Reads `v_consent_current` never; reads `form_sensitive_answers` and `person_sensitive_fields` only inside `readSensitive()` / `writeSensitive()` / `security.rekey`.
- Wave 0 *creates on behalf of their owners* (owners take the files over in Wave 1): `crm.ts` with the final `persons`, `activity_events`, `consent_records`, `suppressions`; contract stubs `sessions`, `bookings` (booking.ts), `products`, `price_versions`, `orders`, `order_lines` (commerce.ts), `credit_grants`, `credit_entries` (credits.ts), `invoices` (finance.ts), `forms` (forms.ts), `email_templates`, `email_messages` (email.ts), `automations` (automation.ts), `pages` (site.ts), and empty `ops.ts`, `webinar.ts`. Their columns are those of architecture section 2 and the owning module spec; platform does not own them.

## 3. Business rules

Each rule is testable; the test file that proves it is named in section 12.

**Staff authentication**
- PL-1 A staff password has at least 12 characters, a zxcvbn score of 3 or more, differs from the email, and is not in the Have I Been Pwned range list. The server enforces length, zxcvbn (whose dictionaries include the common breached passwords) and the email rule. The HIBP check runs in the browser, because a request never calls an external service (architecture section 3): `password-strength.tsx` computes SHA-1 with WebCrypto, fetches `https://api.pwnedpasswords.com/range/<5-char prefix>` with `Add-Padding: true` and a 1.5 s timeout, and disables submit with "This password appeared in a data breach" when the suffix matches. On timeout or error the form allows submit. Only the 5-character prefix leaves the browser; the server never contacts HIBP.
- PL-2 Passwords are hashed with argon2id (`memoryCost 19456 KiB, timeCost 2, parallelism 1`). A successful login with a hash made with weaker parameters rehashes it.
- PL-3 Staff login is two steps. Step 1 (email + password) creates an `auth_sessions` row with `mfa_at = null`. Until step 2 (TOTP: 6 digits, 30 s, SHA-1, ±1 step) sets `mfa_at`, only `/admin/mfa/*` renders and every staff action returns `unauthorized`.
- PL-4 A staff user without `mfa_enrolled_at` is sent to `/admin/mfa/setup`. Enrolment shows an `otpauth://` QR (issuer `BEAM`), requires one valid code, then shows 10 recovery codes once (format `xxxxx-xxxxx`, Crockford base32). Only their sha256 hashes are stored.
- PL-5 A recovery code works once instead of a TOTP code. Its use writes audit `auth.recovery_code_used`. With 2 or fewer codes left the admin shows a banner to regenerate.
- PL-6 Every failed password or TOTP attempt increments `failed_logins`. At 10, `locked_until = now() + 15 min` and audit `auth.locked`. While locked, even the right password fails. A successful login resets `failed_logins` to 0.
- PL-7 Login errors never reveal whether an account exists: one message, "Email address or password is incorrect", for unknown email, wrong password, disabled user and locked account. The locked state is shown only after a correct password.
- PL-8 Staff sessions expire after 12 hours idle (or the role's value in `settings.security.staff_idle_hours_by_role`: reception 4 hours, for the shared front-desk device) or 7 days absolute; customer sessions after 90 days. `last_seen_at` and the idle expiry move at most once per 5 minutes. An expired session redirects to the login page with a same-origin `returnTo`.
- PL-9 Logout deletes the session row. A password change, MFA reset or role change deletes every other session of that user. Disabling a user deletes all its sessions at once. A staff password change, password reset, MFA reset or recovery-code regeneration sends the transactional email `platform.mfa_changed` to the user (key `security-notice:<user_id>:<audit_log_id>`), so a takeover attempt is noticed.
- PL-10 A staff account is created only by an invitation from `/admin/settings/users` (`users.manage`). The invite link (token identifier `staff-invite:<user_id>`) is valid 72 hours and single-use. It leads to "set password", then MFA setup. Password reset links are valid 1 hour.

**Customer authentication**
- PL-11 Customers sign in with a magic link from `mail.beam.be`: valid 15 minutes, single use, at most 5 requests per address per hour. The 6th request shows the same "check your inbox" page and sends nothing. The email is the transactional template `platform.magic_link` (slug `platform/magic-link`), sent through `email.sendTransactional()` (a job, never a direct Resend call) with key `magic:<sha256(email)>:<token_created_at ms>`.
- PL-12 Verifying a link for an email without a `users` row calls `crm.findOrCreatePersonByEmail()` with source `portal_signup` and the URL locale, creates a `customer` user linked to that person, and records event `platform.account_created`. An email that belongs to a staff user cannot become a customer account; the page says to use a different address.
- PL-13 A customer may add a password afterwards: at least 10 characters, zxcvbn score 2 or more, browser HIBP check as PL-1. Customer password logins follow PL-6 and PL-7. No MFA for customers.
- PL-14 A disabled user cannot sign in. When crm erases a person, platform's privacy handler deletes that person's customer user, sessions and verification tokens.

**Roles and permissions**
- PL-15 `action({ permission })` refuses before the handler runs. `roles.permissions = '{*}'` (owner only) grants every permission in the registry, including permissions added in later releases.
- PL-16 Only an owner may add `persons.sensitive_read` to a role, change any user to or from `owner`, or reset another owner's MFA. Nobody may disable, demote or delete the last active owner (`conflict`).
- PL-17 Role and permission changes apply on the next request: permissions are read with the session in one query per request, with no cache.
- PL-18 A role can only hold permission strings present in `registry/permissions.generated.ts`. An unknown string is rejected on save. A string that disappears from the registry later is ignored at runtime and listed on `/admin/settings/roles`.
- PL-19 Navigation entries (`modules/*/nav.ts`) render only when the user holds their permission, through the same `hasPermission()` used by `action()`.

**Audit**
- PL-20 Every staff write through `action()` writes one `audit_log` row: actor, action (the action name), entity type and id, person id when known, old and new values of the changed fields, request id and IP. A handler that calls `ctx.audit()` itself for its own action name suppresses the automatic row; a handler may add further rows with other action names.
- PL-21 Values written to `audit_log` pass through `redactForAudit()`: keys in `SENSITIVE_COLUMNS`, and keys matching `/password|token|secret|totp|recovery|_enc$/i`, become `"[redacted]"`.
- PL-22 `readSensitive()` writes audit `sensitive.read` with the person id, purpose and field keys, never values.
- PL-23 `UPDATE` or `DELETE` on any APPEND table raises `append_only_violation` unless `current_setting('beam.allow_rewrite', true) = 'on'` in the same transaction.

**Jobs**
- PL-24 `enqueue()` with a key that already exists inserts nothing and returns `{ id: <existing id>, inserted: false }`.
- PL-25 A job runs in its own transaction with `SET LOCAL statement_timeout = <timeoutMs>`. On success the handler's writes, `status = 'succeeded'`, `result` and `finished_at` commit together. A handler that resolves twice for the same payload leaves the same database state (the double-run test).
- PL-26 After failed attempt n (n = 1..5) the next `run_at` is now + 60 s, 300 s, 900 s, 3600 s, 21600 s, each plus 0–20 % random jitter. Attempt 6 failing makes the job `dead`.
- PL-27 The runner never writes `status = 'failed'`; a failed attempt becomes `pending` (with `last_error`) or `dead`.
- PL-28 A `PermanentError`, an input that fails the job's Zod schema, or an unknown `kind` makes the job `dead` at once, whatever `attempts` is.
- PL-29 A job turning `dead` sends one Sentry event and enqueues `notify.slack` with key `slack:dead:<kind>:<YYYY-MM-DDTHH>` (Brussels), so one Slack line per kind per hour. A dead `notify.slack` job only goes to Sentry.
- PL-29a A job definition may declare `onDead(ctx, input, error)`. When the job turns `dead`, the runner calls it in a new transaction after the dead status commits (so the owner can record the failure, for example automation's `failed` run and step advance). `onDead` runs once per dead transition (guarded by `jobs.result->>'on_dead_at'`, written in the same transaction); if it throws, the error goes to Sentry and the job stays `dead`. `retryJob` clears `on_dead_at`.
- PL-30 A `running` job with `locked_at` older than 10 minutes is set back to `pending` with `last_error = 'stale lock'`; its attempt still counts.
- PL-31 `jobs.prune` deletes `succeeded` jobs older than 7 days and `dead` jobs older than 90 days, 5,000 rows per statement until none remain or 40 s pass.
- PL-32 `/api/cron/tick` answers 401 unless `Authorization: Bearer $CRON_SECRET` matches (constant-time compare). It enqueues due schedules, then loops for at most 50 s claiming up to 20 `fast` jobs and then up to 5 `bulk` jobs per iteration, running fast jobs 5 at a time and bulk jobs 2 at a time. It leaves the loop early when an iteration claims nothing and no pending job is due in the next 10 s. It then reclaims stale locks, writes `settings.last_tick_at` and pings the Better Stack heartbeat. That ping is a direct `fetch` with a 2 s timeout, the only outbound call the tick makes itself, and it is logged in `integration_calls`.
- PL-33 Schedules are 5-field cron expressions evaluated in `Europe/Brussels`. The key is `schedule:<kind>:<local YYYY-MM-DDTHH:mm>`. Each tick enqueues every slot between the previous `last_tick_at` and now, at most 60 minutes back, for schedules whose interval is an hour or longer; minute-level and 10/15-minute schedules only enqueue the current slot. On the spring DST day, slots inside the skipped hour fire at 03:00 local; on the autumn day the repeated hour is deduplicated by the local-time key.
- PL-34 After a committing action, `after(() => runJobs({ ids, budgetMs: 8000 }))` runs only the jobs that action enqueued, and only those already due. Unfinished ones are left for the tick.
- PL-35 `runJobInline()` accepts only job definitions with `inline: true`: `payments.create`, `payments.terminal` and `ai.answer_question` (R4), the three exceptions of architecture section 3. Any other kind throws at call time. An inline job is still a `jobs` row with the same idempotency, logging and dead handling.
- PL-36 Job handlers get a context whose actor is `{ kind: 'system', jobId }` (stored in JSON as `{ kind: 'job', id: jobId }`).

**Webhooks**
- PL-37 A webhook with a bad signature gets 401, writes `integration_calls` (`operation = 'webhook.signature_failed'`, `status_code = 401`) and no `webhook_events` row. More than 5 such failures for one provider in 10 minutes raises a Slack alert.
- PL-38 A webhook whose `(provider, external_event_id)` already exists gets 200 and enqueues nothing.
- PL-39 A webhook handler only verifies, inserts and enqueues; it answers within 2 seconds. In one transaction it picks a job id, inserts the event with that `job_id` (`on conflict do nothing`), and enqueues `webhook.process` with that id and key `webhook:<provider>:<external_event_id>` only if the insert happened.
- PL-40 Staff with `system.jobs` can replay a stored event. Replay n enqueues `webhook.process` with key `webhook:<provider>:<external_event_id>:replay:<n>` and writes audit `webhooks.replay`.

**Settings and flags**
- PL-41 A setting is written only through `updateSetting` with `expectedVersion`. A stale version returns `conflict`. The value must pass the key's Zod schema. Each write bumps `version` and writes audit `settings.update` with old and new value, except the system keys `last_tick_at` and `automation_cursor`.
- PL-42 `getSetting(key)` returns the declared default when no row exists, and never throws for a missing row.
- PL-43 Flag keys are a TypeScript union generated from `modules/*/config.ts`, so an unknown key fails typecheck. A declared flag without a row is `off`. Resolved flags are cached 60 s per server instance. Every state or tester-list change writes audit `flags.update`.
- PL-44 Flags are resolved on the server only; client components receive booleans as props.

**Files**
- PL-45 A file above 10 MB (10,485,760 bytes) is refused with `validation`. `sha256` is computed on store.
- PL-46 Download access: a public image is open to anyone and is served with `Cache-Control: public, max-age=31536000, immutable` (file rows never change; a new upload is a new id); otherwise a valid signed token, or a staff session with the permission for the kind (`invoice_pdf` → `invoices.read`, `receipt` → `commerce.sell`, `import` and `export` → `persons.export`, `rendered_email` → `email.write`, `image` → any staff), or a customer session whose `personId` equals `files.person_id` for kinds `invoice_pdf`, `receipt` and `export`.
- PL-47 A signed token is `base64url(exp).base64url(HMAC-SHA256(fileId + '.' + exp))` with a key derived from `AUTH_SECRET` (HKDF, info `beam-files-v1`); it expires at most 7 days after issue and only opens the file it was made for.
- PL-48 `files.purge_expired` (daily 02:00) deletes files with `expires_at < now()`, 100 rows per statement.
- PL-49 Total `files` size above 4 GB adds a warning to the daily digest; above 5 GB it raises a High alert (the architecture's trigger to move bytes to object storage).
- PL-50 Non-public files are served with `Content-Disposition: attachment`, `Cache-Control: private, no-store` and `X-Content-Type-Options: nosniff`. Downloading a file of kind `export` writes audit `files.downloaded`. SVG is never accepted.

**AI gateway**
- PL-51 Claude is called only through `callClaude()` inside a job or an inline job. Importing `@anthropic-ai/sdk` outside `packages/integrations/src/anthropic/` fails lint.
- PL-52 A call names a feature from `AI_FEATURES` (`packages/core/src/ai/features.ts`). An unknown feature is a `PermanentError`.
- PL-53 `fieldsSent` must be a subset of the feature's `allowedFields`, which must be a subset of `AI_ALLOWED_FIELDS`. Otherwise the call is not made, an `ai_requests` row is written with `status = 'error'`, `error = 'field_not_allowed'`, and a `PermanentError` is thrown.
- PL-54 No key in `SENSITIVE_FIELD_KEYS` (`health_note`, `sleep`, `stress`, `recovery`, `wellbeing`, `medical`, and every `form_versions.sensitive_field_keys` entry) may be sent unless `settings.ai.sensitive_enabled` is true *and* the feature has `allowsSensitive: true`. No V1–R4 feature has `allowsSensitive: true`.
- PL-55 Turning `sensitive_enabled` on needs the owner role, a purpose of at least 20 characters, a DPIA reference, and `ops.isDpiaApproved('ai_sensitive_processing')` returning true (ops' DPIA register, blueprint 66), and writes audit `ai.sensitive_enabled`. Owner or technical_admin may turn it off (audit `ai.sensitive_disabled`).
- PL-56 Before a call: the Brussels-month spend must be below `monthly_budget_cents` and today's call count below `daily_cap_calls` (100 outside production). Otherwise an `ai_requests` row with `budget_exceeded` is written and `PermanentError('budget')` makes the job dead with reason `budget`. Crossing 80 % of the monthly budget sends one Slack line per month.
- PL-57 `cost_cents = (input_tokens × in + output_tokens × out + cache_read_tokens × cache_read) / 1,000,000`, prices in cents per million tokens from `settings.ai.pricing`.
- PL-58 `model: 'opus'` maps to `claude-opus-5-5` and `'haiku'` to `claude-haiku-5-5`. Requests use adaptive thinking with an explicit `effort` per feature (Opus 5.5 defaults to `medium`), structured outputs through `output_config.format` built from the feature's Zod schema, and `cache_control` on the stable system prompt. The Anthropic organisation has no training opt-in; this is recorded per feature in `AI_FEATURES.trainingStatus = 'not_used_for_training'`. The Anthropic organisation and its API key are in BEAM's name (blueprint 71); no personal ChatGPT or Claude account is connected to BEAM data, `ANTHROPIC_API_KEY` exists only in the Vercel environment groups, and data-sharing or research-preview settings in the Anthropic console stay off. The go-live item `ai_no_training_confirmed` records who checked the console and when (blueprint 61).
- PL-59 A response with `stop_reason = 'refusal'` writes `status = 'error'`, `error = 'refusal:<category>'` and is a `PermanentError`.
- PL-60 `prompt` and `output` never contain a sensitive field: context comes only from `toAiContext()`, and a unit test feeds a person with every sensitive field filled and asserts none of their values reaches the prompt.
- PL-61 `callClaude()` never writes domain rows. It returns the output; the calling module stores it as a draft that a person approves.

**Multi-language**
- PL-62 `en` is the source catalogue. `pnpm i18n:check` fails when `nl-BE` or `fr-BE` lacks a key that `en` has, has an extra key, or has an empty value.
- PL-63 A missing message at runtime renders `⟦<key>⟧` (admin, portal and site) and reports to Sentry once per key per deployment. No other language is ever shown in its place.
- PL-64 `assertComplete(text, locales)` throws `MissingTranslationError { missing: Locale[] }`; a value that is empty after trimming counts as missing.
- PL-65 Locale negotiation for `(site)` and `(portal)`: URL segment (`/nl` = `nl-BE`, `/fr` = `fr-BE`, `/en` = `en`), then the `NEXT_LOCALE` cookie, then `Accept-Language`, then `nl-BE`. A bare path gets a 307 to the negotiated prefix. The back-office uses `users.locale`.
- PL-66 Dates, times, money and plurals render through `Intl` with the locale and `Europe/Brussels`; money is integer cents formatted as EUR.

**Security**
- PL-67 Every HTML response carries a CSP with a per-request nonce, set by `proxy.ts`: `default-src 'self'; script-src 'self' 'nonce-<n>' 'strict-dynamic'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://i.ytimg.com https://*.google-analytics.com https://*.googletagmanager.com; frame-src https://www.youtube-nocookie.com https://www.youtube.com; connect-src 'self' https://*.ingest.de.sentry.io https://*.google-analytics.com https://*.analytics.google.com https://www.googletagmanager.com https://va.vercel-scripts.com https://api.pwnedpasswords.com; frame-ancestors 'none'; form-action 'self' https://www.mollie.com; base-uri 'self'; object-src 'none'`. Third-party scripts (YouTube IFrame API for webinar, GA4 and Vercel Analytics for site after cookie consent) are loaded only through `next/script` with the request nonce, so `'strict-dynamic'` admits them without host lists. One route-level exception: responses under `/:locale/f/*` (forms' embeddable pages) send `frame-ancestors *` instead of `'none'`. R3 adds `https://connect.facebook.net` to `script-src` hosts and `https://www.facebook.com` to `img-src` for site's Meta pixel, behind site's marketing-cookie consent. The CSP builder is `buildCsp({ nonce, pathname })` in `apps/web/lib/csp.ts`; a new origin is added there by an orchestrator PR, never in a module. Static headers: HSTS `max-age=63072000; includeSubDomains; preload`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Content-Type-Options: nosniff`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`.
- PL-68 Application rate limits (fixed windows in `rate_limits`, on top of the Vercel WAF rules of the architecture): staff and customer password login 10 per IP per minute and 20 per account per hour; magic link 5 per address per hour; `/api/public/forms/*` 20 per IP per minute; webinar heartbeat and `/api/webinar/state` 8 per registration per minute and exempt from the per-IP rule (a room of viewers behind one venue NAT would otherwise be blocked; the Vercel WAF rule carries the same exemption); every other `/api/*` route 60 per IP per minute. Exceeding returns 429 with `Retry-After`, or the action error `rate_limited`.
- PL-69 Sensitive values are encrypted with AES-256-GCM: a 12-byte random IV, AAD `<table>.<column>:<row owner id>`, stored as `0x01 || iv || ciphertext || tag`. Keys come from `SENSITIVE_DATA_KEY_V<n>` (base64, 32 bytes); `settings.security.current_key_version` picks the key for new writes and `key_version` on the row picks the key for reads. In production a missing current key fails the health check.
- PL-70 `security.rekey` re-encrypts every row whose `key_version` is below the current version, 500 rows per job, self-continuing, for each table in `SENSITIVE_COLUMNS` plus `users.totp_secret_enc` and `users.recovery_codes_enc`. It is started from `/admin/system/security` by an owner and writes audit `security.rekey_started`.
- PL-71 Server Actions accept only the app's own origin (`experimental.serverActions.allowedOrigins = [APP_HOST]`). Every route handler parses input with Zod.
- PL-72 Logs carry ids only. pino redacts `*.email`, `*.phone`, `*.name`, `*.first_name`, `*.last_name`, `*.password`, `*.token`, `req.headers.cookie`, `req.headers.authorization`. Sentry `beforeSend` removes request bodies and cookies and masks email and phone patterns in messages.
- PL-73 A security incident record holds discovery time, systems affected, data affected, risk, actions, notifications and resolution (blueprint 65). Creating a `critical` or `high` incident sends a Slack alert. If `beam_notified_at` is still empty 20 hours after `discovered_at`, `platform.check_alerts` posts a reminder; the contractual limit is 24 hours.
- PL-73a Incident status follows the transitions of section 2 (`open → contained → resolved`, `open → resolved`, `resolved → open` with a note); any other change returns `conflict`. Setting `beam_notified_at` is its own action field and is never cleared once set.

**Monitoring and environments**
- PL-74 `GET /api/health` returns `{ status, version, checks: { database, tick, jobs, config } }`. It returns 503 when the database round trip fails, when `last_tick_at` is older than 180 s (only where `APP_ENV` is `staging` or `production`), when the pending backlog exceeds 500, or when the production configuration check fails (missing `SENSITIVE_DATA_KEY_V<current>`, `EMAIL_SINK` set, a Mollie key starting with `test_`, or a `DATABASE_URL` without `sslmode=require`). It never returns personal data.
- PL-75 `platform.check_alerts` (every 5 minutes) raises Slack alerts for: pending backlog above 500; tick older than 3 minutes (from `settings.last_tick_at`, staging and production only; Better Stack's heartbeat is the independent check when the tick itself is dead); more than 5 webhook signature failures per provider in 10 minutes; Mollie silence (no `webhook_events` row with provider `mollie` for 24 hours while at least one `orders` row with channel `portal`, `site` or `link` was created in that window, High); a provider with at least 10 failed calls and no successful call in the last 60 minutes (High); database size above 8 GB (`pg_database_size`, Normal; the Neon Launch plan bills storage per GB, so growth is noticed early); AI spend above 80 % (once per month); files above 5 GB; incidents without BEAM notification after 20 hours; support requests past `response_due_at` without a first response (Critical and High only). Each alert has a fingerprint and is sent at most once per hour.
- PL-75a Blueprint 72 coverage. Every monitored failure has one owner and one alert; platform provides the mechanism (`notify.slack`, dead-job alerts, the System page), the owning module provides the check.

| Blueprint 72 item | Signal | Threshold and channel | Owner |
| --- | --- | --- | --- |
| Downtime | Better Stack on `/api/health` every minute; Better Stack heartbeat from the tick | health 503 or no heartbeat for 3 minutes: Slack `#beam-alerts` + phone call to the on-call founder | platform |
| Failed automations | dead `automation.step` jobs, `automation_runs.outcome = failed`, stuck enrolments | dead-job alert (PL-29) and automation's `automation-stuck` sweep alert | automation (check), platform (dead jobs) |
| Failed emails | dead `email.send` jobs; `email_messages` `failed` or `blocked_translation` | dead-job alert; `blocked_translation` in the daily digest and an alert | email |
| Payment failures | payments `pending` above 15 minutes; 3 failed renewals in a day; dead `payments.*` jobs | Slack High and action dashboard | commerce, credits |
| Integration failures | `integration_calls` errors; Billit failed 60 minutes | provider-down alert (PL-75); finance's Billit alert | platform, finance |
| Database issues | health DB round trip (5 s timeout), database size, Neon status | PL-74 503 (Better Stack phone call), PL-75 size alert | platform |
| API failures | Sentry error rate above 1 % over 5 minutes; webhook signature failures; Mollie silence | Sentry → Slack; PL-75 | platform |
| Deliverability | bounce above 2 % per campaign (auto-pause), complaints above 0.1 % in 24 h, DNS records not verified | email's alerts | email |
- PL-76 Outside production `EMAIL_SINK` rewrites every recipient, payment providers run in test mode, Billit uses its sandbox and AI is capped at 100 calls a day. `APP_ENV` is one of `local`, `preview`, `staging`, `production`.
- PL-76a Release flow (blueprint 78, proposal section 3). Every change goes PR → preview deployment on its own Neon branch (CI green, author tests) → merge to `staging` → staging deployment on Neon branch `staging` (BEAM's product owner tests, Playwright `e2e.yml` green) → merge to `main` → production. Before week 7 the `main` deployment on `beam_dev` acts as staging. A user-visible feature reaches production behind an `ff_<module>_<name>` flag in state `testers` and goes to `on` only after BEAM approves it on `/admin/settings/flags`. `deploy.yml` refuses to deploy `main` when the commit has not been on `staging` first (`git merge-base --is-ancestor <sha> origin/staging`), except a hotfix PR labelled `hotfix`, which is merged into `staging` within 24 hours. Rollback is `vercel rollback` (under a minute, runbook `rollback.md`); the schema stays (expand-only releases).
- PL-77 The go-live gate is complete only when all 13 items of `settings.go_live_gate` are confirmed, each by an owner or technical_admin with a note. While it is incomplete in production, the admin shows a red banner and `platform.isGoLiveGateComplete()` returns false; ops refuses non-dry-run imports in production until it returns true.
- PL-78 `backup.yml` runs daily at 02:30 UTC: `pg_dump --format=custom` over `DATABASE_URL_UNPOOLED`, encrypted with `age`, uploaded to Scaleway Object Storage (Paris); 35 daily and 12 monthly dumps are kept; a failed run posts to Slack. Neon point-in-time restore gives RPO 1 minute and RTO 1 hour; full provider loss gives RPO 24 hours and RTO 8 hours. `restore-drill.yml` restores the latest dump into a fresh Neon branch on the first Monday of each quarter, runs the integration suite and posts the result. Blueprint 67, as stated in `docs/runbooks/backup.md` and the DPA annex: frequency continuous (Neon WAL) plus one daily dump; retention 7 days point-in-time, 35 daily and 12 monthly dumps; location Neon `aws-eu-central-1` (Frankfurt) and Scaleway `fr-par` (Paris), both in BEAM-owned accounts; procedure `docs/runbooks/restore.md`; responsibility Sidestream's on-call founder executes the restore and informs BEAM's product owner and technical_admin within 1 hour of the decision, BEAM's owner approves a restore that discards data; expected recovery time 1 hour (point-in-time) or 8 hours (full provider loss).

**Seeds and generators**
- PL-79 The `defaults` seed profile is idempotent and runs on every deploy after `db:migrate`. The `demo` profile refuses to run when `APP_ENV = production`.
- PL-80 `grantDefaultPermission(tx, roleKey, permission)` adds the permission to the role only when it is not yet in `seeded_permissions`, then records it there, so a permission the owner removed is never re-granted by a later deploy.
- PL-81 `pnpm gen:indexes` writes sorted, deterministic output and fails when two modules declare the same job kind, event kind, permission, schedule kind, flag key, settings key or nav key.
- PL-82 ESLint fails when a file in `apps/web/modules/<a>/` imports from `apps/web/modules/<b>/` other than `<b>/api.ts`, or when a package breaks the import table of architecture section 1.

**Security safeguards (blueprint 64)**
- PL-83 Each blueprint-64 safeguard has one implementation and one proof, listed in `docs/runbooks/security-controls.md`:

| Safeguard | Implementation | Proof |
| --- | --- | --- |
| Encryption in transit | TLS on Vercel and Neon (`sslmode=require` in both URLs), HSTS preload (PL-67) | `proxy.test.ts` header assertion; health check refuses a `DATABASE_URL` without `sslmode=require` in production |
| Encryption at rest | Neon storage encrypted (AES-256) by the provider; sensitive columns and TOTP secrets additionally AES-256-GCM (PL-69); backups `age`-encrypted (PL-78) | `sensitive.test.ts`; backup workflow log |
| Multi-factor authentication | TOTP for every staff and partner account (PL-3, PL-4) | `auth.test.ts`; MFA coverage on `/admin/system/security` |
| Role-based access | `action({ permission })`, nav filtering (PL-15, PL-19) | `permissions.test.ts` in every module |
| Password policies | PL-1, PL-13 | `password.test.ts` |
| Logging | `audit_log`, `integration_calls`, Sentry, ids-only logs (PL-20, PL-72) | `audit.test.ts`, `logger.test.ts` |
| Backup and recovery | PL-78 | quarterly restore drill result on `/admin/system/security` |
| API security | signed webhooks (PL-37), Zod on every route, Server Actions origin check (PL-71), CSP | `webhooks.test.ts`, route tests |
| Rate limiting | PL-68 plus Vercel WAF | `rate-limit.test.ts` |
| Vulnerability testing | PL-85 | pentest report and `settings.security.last_pentest_on` |
| Dependency management | PL-84 | CI logs |
| Secret management | secrets only in Vercel environment groups and `.env.local` (gitignored); `.env.example` lists names only; gitleaks in CI; yearly rotation (`rotate-keys.md`) | gitleaks job |

- PL-84 Dependencies: Renovate (`renovate.json`) opens grouped update PRs every Monday before 06:00 Brussels and security updates at once; `pnpm audit --audit-level high --prod` fails CI; gitleaks (`.gitleaks.toml`) scans every PR and fails on a finding. A package update is merged only with a green CI and lands through staging (PL-76a).
- PL-85 Sidestream runs an ethical-hacking test (OWASP ASVS level 2 scope: auth, access control, sessions, input handling, file access, webhooks, rate limits) before go-live and once per quarter after. The report is stored outside the platform in BEAM's shared drive; an owner or technical_admin records the date in `settings.security.last_pentest_on` (next due = +92 days). A critical or high finding opens a `security_incidents` row. The go-live item `security_confirmed` can be confirmed only when `last_pentest_on` is within 30 days and no critical or high incident is open. From 7 days before `next_pentest_due_on`, `platform.check_alerts` posts a reminder once per day.

**Support and SLA (blueprint 73, proposal section 7)**
- PL-86 Any staff user can open "Report a problem" from the `AdminShell` user menu: title, description, severity (`critical`, `high`, `normal`, `improvement`, each with the proposal's example text). The action `reportProblem` stores a `support_requests` row with channel `in_app`, the current page URL and request id, and enqueues `notify.slack` (fingerprint `support:<reference>`). A `critical` report also shows the emergency phone number from `settings.support.emergency_phone`, because Slack alone does not satisfy the critical response path.
- PL-87 Sidestream logs requests that arrive by email, Slack, WhatsApp or phone on `/admin/system/support` (`system.jobs`) with their real `received_at`. A reporter sees their own requests and status on `/admin/support`. Transitions are those of section 2; every change writes audit `support.update`. Marking a request `responded` needs a response note (stored in `description` as an appended, timestamped line).
- PL-88 `slaDueAt(severity, receivedAt, calendar)` (pure, `packages/core/src/platform/sla.ts`) counts minutes only inside support hours: Monday to Friday 09:00–18:00 Brussels, excluding Belgian public holidays (`belgianPublicHolidays(year)` in `packages/core/src/platform/holidays.ts`: 1 January, Easter Monday, 1 May, Ascension Day, Whit Monday, 21 July, 15 August, 1 November, 11 November, 25 December). `critical` also counts Saturday, Sunday and public holidays 10:00–18:00; its target is 120 minutes when received on a business day (or outside hours before one) and 240 minutes when received on a weekend day or public holiday; `high` 240, `normal` 540 and `improvement` 1080 business minutes. A request received outside support hours starts counting at the next support-hour opening. Calendar values come from `settings.support`.
- PL-89 `platform.build_monthly_report` runs at 07:10 on the 1st of each month and writes the `monthly_reports` draft for the previous Brussels month (upsert on `month_on`): uptime and downtime minutes from the Better Stack SLA API (`uptime_source = 'betterstack'`; if the call fails after retries, an owner fills `uptime_pct` by hand and `uptime_source` becomes `manual`), incidents by severity, support requests per severity (received, resolved, median first response, breaches from `v_support_sla`), dead jobs (`jobs` with `status = 'dead'` and `finished_at` in the month; dead rows are kept 90 days), alerts sent (`integration_calls` rows of provider `slack`), backup runs ok and failed and the last restore drill (audit rows `backup.completed` and `restore_drill.completed` that `apps/web/scripts/record-backup.ts` writes with `{ ok }` next to `settings.security`), AI spend (`v_ai_usage_month`), database and files size. An owner or technical_admin reviews it on `/admin/system/reports`, adds notes and sends it (`sendMonthlyReport`): the transactional email `platform.monthly_report` goes to `settings.support.report_recipients` with the figures in the body, and the row becomes `sent`. A sent report is read-only.
- PL-89a The uptime target is 99.5 % per month (proposal section 7). A month below target is shown in red on the report and on `/admin/system`.

**Accessibility (hidden requirement: European Accessibility Act and WCAG 2.1 AA)**
- PL-90 Site, portal and back-office meet WCAG 2.1 level AA. `packages/ui` components are keyboard operable with a visible focus ring, every input has a label (`FormField` requires one), colour tokens keep text contrast at 4.5:1 or more, motion respects `prefers-reduced-motion`, dialogs trap and return focus, and `<html lang>` follows the locale. Every Playwright spec calls `expectAccessible(page)` (`@axe-core/playwright`, rules `wcag2a`, `wcag2aa`, `wcag21aa`) on each page it visits and fails on any `serious` or `critical` violation.

**Documentation and training (blueprints 79, 80, 68–71)**
- PL-91 The handbook in `docs/handbook/` covers every topic of blueprint 80 (table in platform-P11). `docs/handbook/data-model.generated.md` is written by `pnpm docs:schema` from the Drizzle schema (tables, columns, types, enums, FKs, APPEND and sensitive markings, owning module), and CI runs `pnpm docs:schema --check` so the database documentation cannot drift from the code. A PR that changes a business rule edits the matching handbook page in the same PR (PR template checkbox).
- PL-92 Exit capability (blueprints 68, 70; proposal section 10): `pnpm exit:export` (script `apps/web/scripts/exit-export.ts`, needs `DATABASE_URL_UNPOOLED`) writes `pg_dump --format=custom` plus one CSV with header per table (`COPY ... TO STDOUT WITH CSV HEADER`, sensitive columns exported still encrypted with a note on the key) into one `age`-encrypted archive. `docs/handbook/ownership-and-exit.md` lists every account (GitHub organisation, Vercel team, Neon organisation, Resend, Mollie, Billit, Anthropic, Sentry, Better Stack, Slack, Scaleway, Google), its owner (BEAM), Sidestream's access level and the handover steps.

## 4. Server surface

### 4.1 Runtime library (`apps/web/lib/*`, frozen after Wave 0)

```ts
// lib/ctx.ts
export type Actor =
  | { kind: 'staff'; userId: string; roleKey: RoleKey; permissions: ReadonlySet<Permission>; mfaAt: Date }
  | { kind: 'customer'; userId: string; personId: string }
  | { kind: 'system'; jobId: string }
  | { kind: 'webhook'; provider: WebhookProvider }
  | { kind: 'public' };
export type Ctx = {
  tx: Tx; actor: Actor; requestId: string; now: Date; locale: Locale; ip: string | null;
  enqueue: (input: EnqueueInput) => Promise<{ id: string; inserted: boolean }>;
  recordEvent: (input: RecordEventInput) => Promise<{ id: bigint | null }>;
  audit: (input: AuditInput) => Promise<void>;
  require: (permission: Permission) => void;            // throws ForbiddenError
  integrationLog: (entry: IntegrationCallEntry) => void; // buffered, written after commit or rollback
};
export type JobCtx = Ctx & { job: { id: string; kind: JobKind; attempt: number; key: string } };

// lib/action.ts
export function action<I extends z.ZodTypeAny, O>(
  def: { name: `${string}.${string}`; audience: 'public' | 'staff' | 'staff_pending_mfa' | 'customer' | 'any_signed_in';
         permission?: Permission; input: I; audit?: AuditSpec<z.infer<I>, O> | false; rateLimit?: RateLimitSpec },
  handler: (ctx: Ctx, input: z.infer<I>) => Promise<O>,
): (raw: unknown) => Promise<ActionResult<O>>;
export type ActionResult<O> = { ok: true; data: O } | { ok: false; error: { code: ActionErrorCode; message: string; fields?: Record<string, string> } };
export type ActionErrorCode = 'unauthorized' | 'forbidden' | 'validation' | 'not_found' | 'conflict' | 'rate_limited' | 'internal';
export type AuditSpec<I, O> = string | { entityType: string; entityId: (i: I, o: O) => string | null; personId?: (i: I, o: O) => string | null };

// lib/job-runner.ts
export function defineJob<I extends z.ZodTypeAny>(def: { kind: JobKind; lane: 'fast' | 'bulk'; priority?: number; input: I;
  maxAttempts?: number; timeoutMs?: number; inline?: boolean; run: (ctx: JobCtx, input: z.infer<I>) => Promise<unknown>;
  onDead?: (ctx: JobCtx, input: z.infer<I>, error: { message: string; permanent: boolean }) => Promise<void> /* PL-29a */ }): JobDefinition<I>;
export function runJobs(opts: { ids?: string[]; budgetMs: number; lanes?: ('fast' | 'bulk')[]; tickId?: string }): Promise<RunSummary>;
export function runJobInline<T>(kind: InlineJobKind, payload: unknown, opts: { key: string; requestId: string }): Promise<T>;
export function defineSchedule(def: { kind: JobKind; cron: string; payload?: Record<string, unknown>; catchUp?: boolean }): ScheduleDefinition;
export class RetryableError extends Error {}   // re-exported from @beam/core/errors
export class PermanentError extends Error {}

// packages/db/src/enqueue.ts (no registry knowledge; ctx.enqueue adds defaults and Zod validation)
export function enqueue(tx: DbOrTx, input: { kind: string; payload: unknown; key: string; runAt?: Date;
  lane?: 'fast' | 'bulk'; priority?: number; maxAttempts?: number; id?: string; requestId?: string }): Promise<{ id: string; inserted: boolean }>;

// lib/events.ts
export function defineEvent<D extends z.ZodTypeAny>(def: { kind: EventKind; data: D; isSensitive?: boolean; subject: 'person' | 'company' | 'either' }): EventDefinition<D>;
export type RecordEventInput = { kind: EventKind; personId?: string; companyId?: string; occurredAt?: Date; data: unknown;
  ref?: { type: string; id: string }; dedupeKey?: string; mode?: 'live' | 'replay' | 'on_demand'; isSensitive?: boolean };

// lib/audit.ts
export type AuditInput = { action: string; entityType: string; entityId?: string | null; personId?: string | null; oldValue?: unknown; newValue?: unknown };
export function redactForAudit(value: unknown): unknown;

// lib/settings.ts, lib/flags.ts
export function getSetting<K extends SettingKey>(tx: DbOrTx, key: K): Promise<SettingValue<K>>;
export function writeSystemSetting<K extends SystemSettingKey>(tx: DbOrTx, key: K, value: SettingValue<K>): Promise<void>;
// Programmatic setter for modules with their own settings screens (finance company form, site settings): same rules as PL-41
export function setSetting<K extends SettingKey>(ctx: Ctx, key: K, value: SettingValue<K>, expectedVersion: number): Promise<{ version: number }>;
export function flag(key: FlagKey, actor: Actor): Promise<boolean>;

// lib/auth.ts
export function getSession(): Promise<SessionInfo | null>;
export function requireStaff(opts?: { permission?: Permission }): Promise<Extract<Actor, { kind: 'staff' }>>; // redirects
export function requireCustomer(locale: Locale): Promise<Extract<Actor, { kind: 'customer' }>>;
export function requirePermission(permission: Permission): Promise<void>;
export function hasPermission(actor: Actor, permission: Permission): boolean;

// lib/files.ts, lib/sensitive.ts, lib/webhooks.ts, lib/ai.ts, lib/rate-limit.ts, lib/alerts.ts, lib/logger.ts, lib/i18n.ts
export function storeFile(ctx: Ctx, input: { kind: FileKind; name: string; mime: string; bytes: Uint8Array; isPublic?: boolean; expiresAt?: Date; personId?: string }): Promise<{ fileId: string; sha256: string }>;
export function readFile(tx: DbOrTx, fileId: string): Promise<{ name: string; mime: string; bytes: Uint8Array; kind: FileKind; personId: string | null } | null>;
export function signFileUrl(fileId: string, ttlSeconds?: number /* default 86400, max 604800 */): string;
export function encryptSensitive(plain: string, aad: string): { valueEnc: Uint8Array; keyVersion: number };
export function decryptSensitive(valueEnc: Uint8Array, keyVersion: number, aad: string): string;
export function readSensitive(ctx: Ctx, personId: string, purpose: 'care' | 'customer_request' | 'privacy_export',
  scope?: { keys?: SensitiveFieldKey[]; eventIds?: string[]; submissionIds?: string[] }): Promise<SensitiveBundle>;
export function handleWebhook(req: Request, opts: { provider: WebhookProvider;
  verify: (raw: string, headers: Headers) => Promise<{ ok: true; externalEventId: string; payload: unknown } | { ok: false }> }): Promise<Response>;
export function defineWebhookHandler(def: { provider: WebhookProvider; handle: (ctx: JobCtx, event: { id: string; payload: unknown }) => Promise<void> }): WebhookHandlerDefinition;
export function callClaude<S extends z.ZodTypeAny | undefined>(ctx: JobCtx, req: { feature: AiFeatureKey; model: 'opus' | 'haiku';
  system: string; messages: ClaudeMessage[]; personId?: string; fieldsSent: string[]; outputSchema?: S; maxTokens?: number }): Promise<{ text: string; parsed: S extends z.ZodTypeAny ? z.infer<S> : undefined; aiRequestId: string }>;
export function rateLimit(tx: DbOrTx, spec: { key: string; limit: number; windowSeconds: number }): Promise<{ ok: boolean; retryAfterSeconds: number }>;
// The one way to alert: enqueues notify.slack with key `slack:<fingerprint>:<YYYY-MM-DDTHH Brussels>`. Modules never enqueue notify.slack with their own key.
export function notifySlack(ctx: Ctx, input: { fingerprint: string; severity: 'critical' | 'high' | 'normal'; text: string }): Promise<{ jobId: string; inserted: boolean }>;
export function buildCsp(input: { nonce: string; pathname: string }): string; // lib/csp.ts, PL-67
export const logger: pino.Logger;
export function t(locale: Locale, key: MessageKey, params?: Record<string, string | number>): string; // from @beam/core/i18n
```

`SensitiveBundle = { fields: Partial<Record<SensitiveFieldKey, string>>; formAnswers: { submissionId: string; fieldKey: string; value: string }[]; events: { eventId: string; kind: string; occurredAt: Date; data: unknown }[] }`. `events` are the person's `activity_events` rows with `is_sensitive = true` (sensitive staff notes). Purposes match crm's spec: `care` (staff reading for treatment), `customer_request` (the person asked), `privacy_export` (system actor only). `scope` narrows what is decrypted and what the `sensitive.read` audit row lists; without `scope` everything of the person is read.

### 4.2 Server actions (`apps/web/modules/platform/actions.ts`)

| Action (name) | Audience / permission | Input (Zod summary) → output | Audit / events |
| --- | --- | --- | --- |
| `requestMagicLink` (`auth.request_magic_link`) | public, rate limit magic | `{ email, locale, returnTo? }` → `{ sent: true }` always | none; enqueues `email.send` via `email.sendTransactional` (template `platform-magic-link`) |
| `customerPasswordSignIn` (`auth.customer_password_sign_in`) | public, rate limit login | `{ email, password, locale }` → redirect | event `platform.signed_in` (dedupe per day) |
| `staffSignIn` (`auth.staff_sign_in`) | public, rate limit login | `{ email, password }` → `{ next: '/admin/mfa/verify' \| '/admin/mfa/setup' }` | `auth.login_failed`, `auth.locked` on failure |
| `verifyTotp` (`auth.verify_totp`) | staff_pending_mfa | `{ code: /^\d{6}$/ }` → redirect `returnTo` | `auth.staff_login` |
| `useRecoveryCode` (`auth.use_recovery_code`) | staff_pending_mfa | `{ code }` → redirect | `auth.recovery_code_used`, `auth.staff_login` |
| `startMfaEnrolment` (`auth.start_mfa`) | staff_pending_mfa, user without MFA | `{}` → `{ otpauthUri, qrSvg }` (secret kept encrypted on the user, unconfirmed) | none |
| `confirmMfaEnrolment` (`auth.confirm_mfa`) | staff_pending_mfa | `{ code }` → `{ recoveryCodes: string[10] }` | `auth.mfa_enrolled` |
| `regenerateRecoveryCodes` (`auth.regenerate_recovery_codes`) | staff, own account | `{ code }` (current TOTP) → `{ recoveryCodes }` | `auth.recovery_codes_regenerated` |
| `acceptInvite` (`auth.accept_invite`) | public + token | `{ token, password }` → redirect `/admin/mfa/setup` | `users.invite_accepted` |
| `requestPasswordReset` (`auth.request_password_reset`) | public, rate limit login | `{ email, audience }` → `{ sent: true }` always | none |
| `resetPassword` (`auth.reset_password`) | public + token | `{ token, password }` → redirect | `auth.password_reset`; deletes sessions |
| `changeMyPassword` (`auth.change_password`) | any_signed_in | `{ currentPassword?, newPassword }` → `{}` | `auth.password_changed` (staff); event `platform.password_set` (customer) |
| `signOut` (`auth.sign_out`) | any_signed_in | `{}` → redirect | none |
| `updateMyProfile` (`users.update_self`) | staff | `{ name, locale }` → `{}` | `users.update_self` |
| `inviteStaffUser` (`users.invite`) | staff, `users.manage` | `{ email, name, roleKey, locale }` → `{ userId }` | `users.invite`; enqueues invite email |
| `resendInvite` (`users.resend_invite`) | `users.manage` | `{ userId }` → `{}` | `users.resend_invite` |
| `updateStaffUser` (`users.update`) | `users.manage` (+ owner rule PL-16) | `{ userId, name?, locale?, roleKey?, isTester? }` → `{}` | `users.update` / `users.role_change` |
| `setUserStatus` (`users.set_status`) | `users.manage` | `{ userId, status: 'active'\|'disabled' }` → `{}` | `users.disable` / `users.enable` |
| `resetUserMfa` (`users.reset_mfa`) | `users.manage` (owner for owners) | `{ userId, reason: min 5 }` → `{}` | `users.reset_mfa` |
| `unlockUser` (`users.unlock`) | `users.manage` | `{ userId }` → `{}` | `users.unlock` |
| `revokeSession` (`sessions.revoke`) | `users.manage`, or own session | `{ sessionId }` → `{}` | `auth.session_revoked` |
| `revokeAllSessions` (`sessions.revoke_all`) | `users.manage` | `{ userId }` → `{ count }` | `auth.session_revoked` |
| `setCustomerTester` (`users.set_tester`) | `flags.manage` | `{ personId, isTester }` → `{}` (writes `persons.is_tester` through `crm.setPersonTester`) | `users.set_tester` |
| `updateRolePermissions` (`roles.update_permissions`) | `users.manage` (+ owner for `persons.sensitive_read`) | `{ roleKey, permissions: Permission[] }` → `{}` | `roles.update_permissions` (old and new arrays) |
| `updateSetting` (`settings.update`) | `settings.write` | `{ key: SettingKey, value: unknown, expectedVersion: int }` → `{ version }` | `settings.update` |
| `setAiSensitiveProcessing` (`ai.set_sensitive`) | owner (on) / owner or technical_admin (off) | `{ enabled, purpose?: min 20, dpiaReference?: min 3 }` → `{}` | `ai.sensitive_enabled` / `ai.sensitive_disabled` |
| `updateFlag` (`flags.update`) | `flags.manage` | `{ key: FlagKey, state, userIds: uuid[], personIds: uuid[] }` → `{}` | `flags.update` |
| `retryJob` (`jobs.retry`) | `system.jobs` | `{ jobId }` → `{}`: dead → `pending`, `run_at = now()`, `max_attempts = attempts + 3`, `result.on_dead_at` removed (PL-29a) | `jobs.retry` |
| `discardJob` (`jobs.discard`) | `system.jobs` | `{ jobId, reason }` → `{}`: deletes a dead job | `jobs.discard` (with kind, key, last_error) |
| `replayWebhookEvent` (`webhooks.replay`) | `system.jobs` | `{ webhookEventId }` → `{ jobId }` | `webhooks.replay` |
| `confirmGoLiveItem` (`go_live.confirm`) | `settings.write` and role owner or technical_admin | `{ item: GateItemKey, confirmed: boolean, note: min 3 }` → `{}` | `go_live.confirm` |
| `createIncident` / `updateIncident` (`incidents.create` / `incidents.update`) | `system.jobs` | the 7 blueprint-65 fields, severity, status → `{ incidentId }` | `incidents.create` / `incidents.update`; Slack for critical/high |
| `startRekey` (`security.rekey`) | owner | `{ toVersion: int }` (must equal `current_key_version + 1` and the env key must exist) → `{ jobId }` | `security.rekey_started` |
| `uploadImage` (`files.upload_image`) | staff with `site.edit` or `email.write` | multipart `{ file ≤ 10 MB, png/jpeg/webp/gif }` → `{ fileId, url }` | `files.upload_image` |
| `reportProblem` (`support.report`) | staff (any role) | `{ title: 3–200, description, severity, pageUrl }` → `{ reference }` | `support.report`; Slack via `notifySlack` (PL-86) |
| `logSupportRequest` (`support.create`) | `system.jobs` | `{ title, description, severity, channel, receivedAt, reportedByUserId? }` → `{ reference }` | `support.create` |
| `updateSupportRequest` (`support.update`) | `system.jobs` | `{ id, status?, note?, assigneeUserId?, incidentId? }` → `{}`; transitions of section 2, else `conflict` | `support.update` |
| `recordPentest` (`security.record_pentest`) | owner or technical_admin | `{ testedOn: date, summary: min 10, criticalOrHighFindings: int }` → `{}`; sets `last_pentest_on` and `next_pentest_due_on` | `security.record_pentest` |
| `updateMonthlyReport` / `sendMonthlyReport` (`reports.monthly_update` / `reports.monthly_send`) | owner or technical_admin | `{ id, notes?, uptimePct? }` / `{ id }` → `{}`; a `sent` report is `conflict` | `reports.monthly_update` / `reports.monthly_send`; enqueues `platform.monthly_report` email |

### 4.3 Queries (`apps/web/modules/platform/queries.ts`)

`getCurrentUser()`, `listStaffUsers({ q?, roleKey?, status?, page })`, `getStaffUser(userId)` (with sessions), `listSessions(userId)`, `listRoles()`, `getRole(roleKey)` (with the registry's permission list grouped by module), `listSettings()`, `getSettingForEdit(key)` (value, version, schema description), `listFlags()`, `listJobs({ status?, kind?, lane?, q?, page })`, `getJob(jobId)`, `getJobStats()` (from `v_job_stats`), `listWebhookEvents({ provider?, from?, to?, page })`, `getWebhookEvent(id)` (with its job), `listIntegrationCalls({ provider?, ok?, page })`, `getIntegrationHealth()` (from `v_integration_health`), `searchAudit({ actorId?, action?, entityType?, entityId?, personId?, from?, to?, page })`, `listIncidents({ status? })`, `getIncident(id)`, `getGoLiveGate()`, `getAiUsage({ month })` (from `v_ai_usage_month` plus the feature register), `getSecurityStatus()` (key versions, rows per key version, MFA coverage, last pentest), `listSupportRequests({ status?, severity?, mine?, page })` (from `v_support_sla`; `mine` = reported by the current user), `getSupportRequest(id)`, `listMonthlyReports()`, `getMonthlyReport(id)`. Every list is keyset-paginated (50 rows, cursor = `created_at,id`), selects explicit columns and never `files.bytes`.

### 4.4 Route handlers

| Route | Method | Auth | Behaviour |
| --- | --- | --- | --- |
| `app/api/health/route.ts` | GET | public | PL-74; `cache-control: no-store`; `runtime = 'nodejs'`. |
| `app/api/cron/tick/route.ts` | GET | `Bearer CRON_SECRET` | PL-32, PL-33; `maxDuration = 120`; returns `{ tickId, enqueuedSchedules, ran: { fast, bulk }, reclaimed }`. |
| `app/api/auth/[...nextauth]/route.ts` | GET, POST | Auth.js | Email provider (magic link) and the Credentials callbacks; session strategy `database`. |
| `app/api/public/files/[id]/route.ts` | GET | PL-46 | Streams `bytes`; 404 for unknown or expired files and for denied access (no existence leak). |
| `app/(admin)/admin/mfa/qr/route.ts` | GET | staff_pending_mfa | Returns the enrolment QR as SVG; `no-store`. |

The webhook routes (`/api/webhooks/mollie` by commerce, `/api/webhooks/resend` by email, `/api/webhooks/meta` by crm in R3) are one-liners over `handleWebhook()`.

### 4.5 Jobs (`apps/web/modules/platform/jobs.ts`)

| Kind | Lane / priority | Idempotency key | Input | Retry behaviour |
| --- | --- | --- | --- | --- |
| `webhook.process` | fast / 2 | `webhook:<provider>:<external_event_id>` (replays add `:replay:<n>`) | `{ webhookEventId }` | default 6 attempts; calls `WEBHOOK_HANDLERS[provider]`; no handler → PermanentError |
| `notify.slack` | fast / 5 | `slack:<fingerprint>:<YYYY-MM-DDTHH>` | `{ fingerprint, severity, text }` | 4 attempts; dead → Sentry only |
| `jobs.prune` | bulk / 9 | `schedule:jobs.prune:<minute>` | `{}` | default |
| `files.purge_expired` | bulk / 9 | `schedule:files.purge_expired:<minute>` | `{}` | default |
| `platform.check_alerts` | fast / 4 | `schedule:platform.check_alerts:<minute>` | `{}` | 2 attempts (the next run follows in 5 minutes) |
| `platform.prune_ephemeral` | bulk / 9 | `schedule:platform.prune_ephemeral:<minute>` | `{}` | default; deletes expired `auth_sessions`, `auth_verification_tokens`, `rate_limits` |
| `security.rekey` | bulk / 9 | `rekey:<toVersion>:<table>:<afterId or 'start'>` | `{ toVersion, table, afterId? }` | default; enqueues the next chunk (key with the last id of this chunk) or the next table (`start`) |
| `platform.build_monthly_report` | bulk / 5 | `schedule:platform.build_monthly_report:<minute>` | `{ monthOn? }` (default previous Brussels month) | default; upsert on `month_on`, skipped when that month is already `sent`; Better Stack SLA call through `betterstack/client.ts` |

Every handler is idempotent: prune and purge delete by predicate; rekey skips rows already at `toVersion`; `notify.slack` sends with the key as Slack's dedupe text suffix and a second run after success is a no-op because the job row is already `succeeded`.

### 4.6 Schedules (`apps/web/modules/platform/schedules.ts`, Europe/Brussels)

| Kind | Cron | Catch-up |
| --- | --- | --- |
| `platform.check_alerts` | `*/5 * * * *` | no |
| `platform.prune_ephemeral` | `17 * * * *` | yes |
| `files.purge_expired` | `0 2 * * *` | yes |
| `jobs.prune` | `30 3 * * *` | yes |
| `platform.build_monthly_report` | `10 7 1 * *` | yes |

### 4.7 Events (`apps/web/modules/platform/events.ts`)

| Kind | Subject | Data | Dedupe key |
| --- | --- | --- | --- |
| `platform.account_created` | person | `{ userId, method: 'magic_link' }` | `account:<user_id>` |
| `platform.signed_in` | person | `{ method: 'magic_link' \| 'password' }` | `signin:<user_id>:<YYYY-MM-DD>` |
| `platform.password_set` | person | `{}` | none |

Staff sign-ins are audit rows, not timeline events (staff are not persons).

### 4.8 `apps/web/modules/platform/api.ts` (exposed to every module)

```ts
export { recordEvent, audit, enqueue, getSetting, setSetting, writeSystemSetting, flag, storeFile, readFile, signFileUrl,
         encryptSensitive, decryptSensitive, readSensitive, callClaude, notifySlack, hasPermission } from '../../lib/...';
export { belgianPublicHolidays, slaDueAt } from '@beam/core/platform'; // booking may reuse the holiday calendar for closed-day suggestions
export function isGoLiveGateComplete(tx: DbOrTx): Promise<boolean>;
export function getPlatformDigest(tx: DbOrTx, day: string /* YYYY-MM-DD Brussels */): Promise<DigestSection>;
export type DigestSection = { title: string; lines: { label: string; value: string; level: 'ok' | 'warn' | 'alert' }[] };
export function getCustomerAccount(tx: DbOrTx, personId: string): Promise<{ userId: string; email: string; lastLoginAt: Date | null; hasPassword: boolean } | null>;
export function reassignCustomerAccount(ctx: Ctx, input: { fromPersonId: string; toPersonId: string }): Promise<{ moved: boolean }>;
export function syncCustomerAccountEmail(ctx: Ctx, input: { personId: string; email: string | null }): Promise<void>;
export function listStaffForAssignment(tx: DbOrTx, opts?: { roleKey?: RoleKey; permission?: Permission }): Promise<{ userId: string; name: string; roleKey: RoleKey }[]>;
export function partnerScope(ctx: Ctx): Promise<{ companyId: string }>; // R3; throws ForbiddenError without partner.own
export function runAiReadOnlyQuery(ctx: JobCtx, sql: string): Promise<{ columns: string[]; rows: unknown[][] }>; // R4
```

These are the only names. Other specs that wrote `aiComplete`, `aiGenerate` (use `callClaude`), `createFile` (use `storeFile`), `listActiveStaffByRole` (use `listStaffForAssignment({ roleKey })`) or `integrationCallLogger` (use `ctx.integrationLog`, wired to every client's `onCall`) map to these functions; Wave 0 does not add aliases.

`getPlatformDigest` lines: dead jobs (24 h), open support requests and breaches, pending backlog, oldest pending age, last tick age, webhook events and signature failures (24 h), integration errors per provider, AI spend this month vs budget, files total size, database size (`pg_database_size(current_database())`), open incidents.

### 4.9 Cross-module stubs written by Wave 0 (owners implement them in Wave 1)

Each stub throws `NotImplementedError('<module>.<fn>')`, with one exception: `email.sendTransactional` and the `email.send` job are working in Wave 0 (architecture section 11 item 4, "sendTransactional job, one working template"), written by platform-P7 on behalf of the email module, which takes the files over in Wave 1. The Wave 0 version inserts the `email_messages` contract row (`idempotency_key = key`, status `queued`), enqueues `email.send` (key `email:<message_id>`, lane `fast`, priority 1), and the job renders the registered component with `renderEmail()`, applies `EMAIL_SINK` (rewrites `to`, stores the HTML as a `rendered_email` file outside production), sends through `getIntegrations().resend.sendEmail()` (fake under `INTEGRATIONS=fake`) and sets `resend_id`, `sent_at` and status `sent`. Suppression, consent and webhook handling are email's Wave 1 work. Types live in `packages/core/src/<m>/types.ts`. Where the owner's spec in `docs/plan/modules/<m>.md` defines a signature, Wave 0 copies that one; otherwise it uses these:

```ts
// crm/api.ts
findOrCreatePersonByEmail(ctx: Ctx, input: { email: string; locale: Locale; firstName?: string; lastName?: string; source: string; acquisition?: AcquisitionInput }): Promise<{ personId: string; created: boolean }>;
getPersonStatus(tx: DbOrTx, personId: string): Promise<{ status: 'lead' | 'customer' | 'member'; isMember: boolean; isOverridden: boolean }>;
setPersonTester(ctx: Ctx, input: { personId: string; isTester: boolean }): Promise<void>;
// credits/api.ts
consumeCredits(ctx: Ctx, input: { personId: string; beneficiaryPersonId: string; kind: CreditKind; units: number; ref: { type: string; id: string } }): Promise<{ entryIds: string[]; grantIds: string[] }>;
releaseCredits(ctx: Ctx, input: { ref: { type: string; id: string }; reason: string }): Promise<{ entryIds: string[] }>;
// commerce/api.ts
quote(tx: DbOrTx, input: QuoteRequest): Promise<Quote>;
createOrder(ctx: Ctx, input: CreateOrderInput): Promise<{ orderId: string; status: OrderStatus; checkoutUrl: string | null }>;
// booking/api.ts
getAvailability(tx: DbOrTx, input: { sessionId: string; personId?: string }): Promise<Availability>;
// email/api.ts
sendTransactional(ctx: Ctx, input: { template: string; personId?: string; to?: string; locale: Locale; data: Record<string, unknown>; key: string }): Promise<{ emailMessageId: string; jobId: string }>;
// finance/api.ts
issueInvoice(ctx: Ctx, input: { orderId: string }): Promise<{ invoiceId: string; number: string }>;
// ops/api.ts
isDpiaApproved(tx: DbOrTx, key: 'ai_sensitive_processing' | 'behavioural_scoring' | 'ai_customer_ranking' | 'watch_time_profiling' | 'b2b_prospecting' | 'voice_ai'): Promise<boolean>;
```

## 5. Screens

All staff screens use `AdminShell` (sidebar from `registry/nav.generated.ts`, filtered by `hasPermission`; top bar with user menu including "Report a problem" (PL-86) and "Sign out", locale from `users.locale`, tester badge, go-live banner; skip-to-content link and landmark regions, PL-90). Lists use `DataTable` (server-side keyset pagination in the URL, column filters, CSV export only where `persons.export` applies). Loading = route `loading.tsx` with table skeletons; error = route `error.tsx` showing "Something went wrong" plus the request id and a retry button; empty states named per screen below. Every string is in the `platform` catalogue.

**Staff authentication (no shell; route group `app/(admin-auth)/admin/`)**

| Route | Shows and does | States | Audience |
| --- | --- | --- | --- |
| `/admin/login` | Email + password form → `staffSignIn`. Link "Forgot password". | Error: generic message (PL-7); 429: "Too many attempts, try again in N minutes". | public |
| `/admin/mfa/setup` | QR code + manual key, code field → `confirmMfaEnrolment`; then the 10 recovery codes with "Download as .txt" and "I stored them" checkbox before continuing. | Wrong code: inline error, attempts count toward lockout. | staff_pending_mfa without MFA |
| `/admin/mfa/verify` | 6-digit code field → `verifyTotp`; "Use a recovery code" toggle → `useRecoveryCode`. | Locked: "Account locked until HH:mm". | staff_pending_mfa |
| `/admin/invite/[token]` | Set password (strength meter from zxcvbn, policy hints) → `acceptInvite`. | Expired or used token: "This invitation is no longer valid; ask an administrator to resend it." | public + token |
| `/admin/reset-password`, `/admin/reset-password/[token]` | Request form → `requestPasswordReset`; set new password → `resetPassword`. | Always "If the address is known we sent a link". Expired token message. | public |

**Staff back-office (`app/(admin)/admin/`)**

| Route | Shows | Actions | Empty state | Permission |
| --- | --- | --- | --- | --- |
| `/admin` | Redirects to the first nav entry the user can open (ops' `/admin/dashboard` for most roles). | | | staff |
| `/admin/account` | Own name, locale, password change, recovery codes left, own sessions (device, IP, last seen). | `updateMyProfile`, `changeMyPassword`, `regenerateRecoveryCodes`, `revokeSession` | | staff |
| `/admin/settings` | Index cards: Users, Roles, Flags, AI, Company, then one card per module setting key the user may edit. | | | `settings.write` or `users.manage` or `flags.manage` |
| `/admin/settings/users` | Staff users: name, email, role, MFA status, last login, status, locked badge. Filters role/status, search. | `inviteStaffUser` (dialog), row menu | "No staff users yet. Invite the first one." | `users.manage` |
| `/admin/settings/users/[id]` | Profile, role select, tester switch, status, MFA state, sessions table, last 20 audit rows about this user. | `updateStaffUser`, `setUserStatus`, `resetUserMfa`, `unlockUser`, `resendInvite`, `revokeSession`, `revokeAllSessions` | "No active sessions." | `users.manage` |
| `/admin/settings/roles` | The nine roles with member counts and permission counts; unknown-permission warnings (PL-18). | | | `users.manage` |
| `/admin/settings/roles/[key]` | Permission checklist grouped by module with descriptions from the catalogue; `persons.sensitive_read` disabled unless the actor is owner; owner role read-only ("all permissions"). | `updateRolePermissions` with a diff confirmation dialog | | `users.manage` |
| `/admin/settings/flags` | Flags from the registry joined with rows: key, description, state, tester counts, last change. | `updateFlag` (state radio, staff picker, person picker via `crm` search), `setCustomerTester` | "No flags declared." | `flags.manage` |
| `/admin/settings/ai` | Budget, daily cap, month spend bar, model prices, sensitive-processing panel (purpose, DPIA reference, who and when). | `updateSetting('ai')`, `setAiSensitiveProcessing` | | `settings.write`; sensitive switch owner only |
| `/admin/settings/[key]` | Generic editor for any declared settings key: a form generated from the key's Zod schema (string, number, boolean, enum, LocalizedText via `LocalizedInput`, arrays of these) and a validated JSON editor for anything deeper; version and last editor shown. | `updateSetting` | | `settings.write` |
| `/admin/system` | Overview: last tick age, jobs by lane and status, oldest pending, dead count (link), integration health tiles, webhook volume 24 h, AI spend, files size, open incidents, go-live gate progress. Auto-refresh 30 s. | | | `system.jobs` |
| `/admin/system/jobs` | Jobs table: kind, status, lane, attempts, run_at, last_error (first line), key. Default filter `dead`. | `retryJob`, `discardJob` (reason) | "No dead jobs. Everything ran." | `system.jobs` |
| `/admin/system/jobs/[id]` | Full row with payload (redacted keys), result, error, timeline of attempts from `integration_calls`. | Retry, Discard | | `system.jobs` |
| `/admin/system/webhooks` | Webhook events: provider, external id, received, job status. | `replayWebhookEvent` | "No webhook events received yet." | `system.jobs` |
| `/admin/system/integrations` | `v_integration_health` per provider plus the last 200 calls (operation, status, duration, error). | | "No calls in the last 24 hours." | `system.jobs` |
| `/admin/system/audit` | Audit search: actor (staff picker), action, entity type and id, person (crm search), date range; rows expand to old/new JSON diff. | Export CSV of the filtered result (audited `audit.export`) | "No audit entries match these filters." | `system.jobs` |
| `/admin/system/incidents`, `/admin/system/incidents/[id]` | Incident register with the seven blueprint-65 fields, severity, status, timers (time since discovery, BEAM notified). | `createIncident`, `updateIncident` | "No incidents recorded." | `system.jobs` |
| `/admin/system/go-live` | The 13 gate items with confirmation state, confirmer, date, note; link to the relevant runbook per item. | `confirmGoLiveItem` | | `system.jobs` to view; owner or technical_admin to confirm |
| `/admin/system/security` | Key versions in use (rows per version per table), MFA coverage of staff, locked accounts, last backup run and last restore drill (from `settings.security`, written by `apps/web/scripts/record-backup.ts` at the end of `backup.yml` and `restore-drill.yml`), last and next ethical-hacking test, the blueprint-64 safeguard list with links to `security-controls.md`. | `startRekey` (owner), `recordPentest` (owner or technical_admin) | | `system.jobs` |
| `/admin/support` | My reported problems: reference, title, severity, status, received, due, responded. "Report a problem" button (same dialog as the user menu). | `reportProblem` | "You have not reported any problems." | staff |
| `/admin/system/support` | Support register from `v_support_sla`: reference, severity, channel, title, status, received, due (red when breached), first response, reporter, assignee. Default filter: open and responded. | `logSupportRequest`, `updateSupportRequest` (status, note, assignee, link incident) | "No open support requests." | `system.jobs` |
| `/admin/system/reports`, `/admin/system/reports/[id]` | Monthly SLA reports: month, uptime (red below 99.5 %), downtime, incidents, support per severity with breaches, dead jobs, alerts, backups, restore drill, AI spend, sizes; notes field. | `updateMonthlyReport`, `sendMonthlyReport` (owner or technical_admin) | "The first report is created on the 1st of next month." | `system.jobs` |
| `/admin/system/ai` | The AI feature register (blueprint 61: fields sent, when, why, provider, location, retention, training status, output storage, prompt storage, prompt retention) and usage per feature from `v_ai_usage_month`; R4 adds per-day charts and the read-only SQL log. | | "No AI calls this month." | `system.jobs` or `ai.use` |

**Customer portal (`app/[locale]/(portal-auth)/account/` and `(portal)` shell)**

| Route | Shows and does | States | Audience |
| --- | --- | --- | --- |
| `/[locale]/account/login` | Email field → `requestMagicLink`; "Sign in with password" tab → `customerPasswordSignIn`. | Rate-limited and invalid-email messages. | public |
| `/[locale]/account/login/check-email` | "Check your inbox; the link works for 15 minutes." Resend button (respects the limit). | | public |
| `/[locale]/account/login/verify` | Target of the emailed link: "Sign in to BEAM as <masked email>" and a button that submits to the Auth.js email callback, so link-prefetching mail scanners do not consume the token. | Missing parameters → the login page. | public |
| `/[locale]/account/login/error` | Expired or used link: "This link has expired" and a new-link form. | | public |
| `/[locale]/account/security` | Set or change password, sign out on all devices. | Success toasts. | customer |

`PortalShell` (a `packages/ui` component: installable PWA chrome, bottom navigation on mobile from `audience: 'customer'` nav entries, locale switch) wraps every `(portal)` page. platform-P6 writes the first `app/[locale]/(portal)/account/layout.tsx` (session check plus `PortalShell`) so Wave 0 renders; from Wave 1 the site module owns that layout, the portal home `page.tsx`, the manifest and the service worker (site spec), and platform keeps only `loading.tsx`, `error.tsx`, `security/` and the `(portal-auth)` sign-in pages. Platform also owns `app/not-found.tsx`, `app/global-error.tsx` and `app/[locale]/not-found.tsx`, rendered in the visitor's locale.

## 6. Integrations

| Service | Client (`packages/integrations/src/...`) | Calls | Failure handling | Idempotency |
| --- | --- | --- | --- | --- |
| Anthropic Claude | `anthropic/client.ts` (`createClaudeClient({ apiKey, onCall })`: `complete()`, R4 `createBatch()`, `getBatch()`, `getBatchResults()`), `anthropic/fake.ts` (scripted responses keyed by feature, token counts, refusal and 529 simulation) | `messages.create` with `output_config.format`, adaptive thinking, `cache_control` on the system prompt; Message Batches (R4, 50 % price) | 429/5xx/connection → `IntegrationError { retryable: true }` → job retry; 400 and refusals → Permanent; AI panels show "AI unavailable, write manually" | the job key; a retried job may call again, which only costs tokens; the ai_requests row of a failed attempt stays |
| Slack | `slack/client.ts` (`postMessage({ text })` to `SLACK_WEBHOOK_URL`), `slack/fake.ts` (records messages) | incoming webhook POST | retry 4 attempts; then Sentry only | key per fingerprint per hour (PL-29) |
| Have I Been Pwned (browser only) | no server client; `apps/web/modules/platform/ui/hibp.ts` (`isBreached(password, fetchImpl)`), used by `password-strength.tsx`; tests pass a fake `fetch` with the known-breached list `Password123!`, `Welkom2026!!` | browser `GET https://api.pwnedpasswords.com/range/<prefix>` (`connect-src` allows it) | 1.5 s timeout → allow submit (PL-1) | none needed (read-only) |
| Better Stack | direct `fetch(BETTERSTACK_HEARTBEAT_URL)` from the tick; uptime monitor on `/api/health` configured in the Better Stack dashboard (EU region, BEAM-owned account); `betterstack/{client.ts, fake.ts}` with `getMonitorSla({ monitorId, from, to }): { availabilityPct, downtimeSeconds }` (`GET /api/v2/monitors/<id>/sla`, bearer `BETTERSTACK_API_TOKEN`) for the monthly report | heartbeat GET; SLA GET once a month | heartbeat: 2 s timeout, logged, ignored; SLA: retryable job, then manual entry (PL-89) | report job key |
| Resend (Wave 0 minimum, on behalf of email) | `resend/{client.ts, fake.ts}` with only `sendEmail({ from, to, subject, html, text, headers, idempotencyKey }): { id }`; the email module extends the client in Wave 1 | `POST /emails` with `Idempotency-Key` = job key | `IntegrationError` retryable on 429/5xx | job key |
| Sentry (EU) | `@sentry/nextjs` in `instrumentation.ts`, `sentry.server.config.ts`, `sentry.client.config.ts`; not a job (SDK buffers and sends) | error and message capture | SDK internal; never blocks a request | n/a |
| Fakes for other modules | Wave 0 writes `payments/{provider.ts,fake.ts}` (the `PaymentProvider` interface), `billit/fake.ts`, `youtube/fake.ts`, `ads/fake.ts` with the interfaces of architecture section 8; owners write the real `client.ts` | | | |

Shared rules in `packages/integrations/src/_shared/`: `IntegrationError { provider, retryable, statusCode? }`, `withTimeout()`, `digestRequest()` (sha256 of method, path and sorted non-secret params), and the `onCall(entry)` callback type that job context wires to `ctx.integrationLog`. A client is selected by `getIntegrations()` in `apps/web/lib/integrations.ts`: real clients when `APP_ENV` is `staging` or `production` or the env key is set, fakes when `INTEGRATIONS=fake` (tests, demo, e2e).

## 7. Permissions and audit

Platform declares these permissions in `apps/web/modules/platform/permissions.ts`: `settings.write`, `users.manage`, `flags.manage`, `system.jobs`, `ai.use`, `partner.own`. No new permission is added for support: reporting a problem needs only a staff session, and the register uses `system.jobs`. (Other strings of architecture section 4 are declared by their modules: `privacy.run`, `reports.*` and `dashboards.manage` by ops, and so on.)

| Permission | owner | technical_admin | management | customer_service | sales | marketing | finance | reception | external_partner |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `settings.write` | yes | yes | yes | – | – | – | – | – | – |
| `users.manage` | yes | yes | – | – | – | – | – | – | – |
| `flags.manage` | yes | yes | yes | – | – | – | – | – | – |
| `system.jobs` | yes | yes | – | – | – | – | – | – | – |
| `ai.use` | yes | yes | yes | – | yes | yes | – | – | – |
| `partner.own` | yes | yes | yes | – | – | – | – | – | yes |

Extra rules beyond the strings: owner-only operations (PL-16, PL-55, `startRekey`); go-live confirmation needs `settings.write` and role owner or technical_admin; `/admin/system/ai` also opens with `ai.use`. The owner holds `'*'`; technical_admin's seeded set is every registry permission except `persons.sensitive_read`; management's is every permission except `users.manage`, `system.jobs`, `privacy.run`, `persons.sensitive_read` (computed from the registry at seed time).

**Audit actions written by platform:** `auth.staff_login`, `auth.login_failed`, `auth.locked`, `auth.mfa_enrolled`, `auth.recovery_code_used`, `auth.recovery_codes_regenerated`, `auth.password_changed`, `auth.password_reset`, `auth.session_revoked`, `users.invite`, `users.resend_invite`, `users.invite_accepted`, `users.update`, `users.update_self`, `users.role_change`, `users.disable`, `users.enable`, `users.reset_mfa`, `users.unlock`, `users.set_tester`, `roles.update_permissions`, `settings.update`, `ai.sensitive_enabled`, `ai.sensitive_disabled`, `flags.update`, `jobs.retry`, `jobs.discard`, `webhooks.replay`, `go_live.confirm`, `incidents.create`, `incidents.update`, `security.rekey_started`, `security.record_pentest`, `files.upload_image`, `files.downloaded`, `audit.export`, `sensitive.read`, `support.report`, `support.create`, `support.update`, `reports.monthly_update`, `reports.monthly_send`, `backup.completed`, `restore_drill.completed` (actor `system`). Failed customer logins are not audited (volume); they count in `rate_limits` and `failed_logins`.

**Blueprint 56 coverage.** Each example is an audit action written by `action()` in the owning module; the audit test of each module asserts its row.

| Blueprint 56 example | Audit action (module) |
| --- | --- |
| Package manually adjusted | `credits.adjust`, `credits.extend` (credits) |
| Discount applied | `orders.apply_discount` (commerce) |
| Customer record changed | `persons.update` (crm) |
| Booking cancelled | `bookings.cancel` (booking) |
| Refund issued | `refunds.create` (commerce) |
| Membership changed | `memberships.update`, `memberships.cancel` (credits) |
| Customer merged | `persons.merge` (crm) |
| User access changed | `users.role_change`, `users.disable`, `users.reset_mfa` (platform) |
| Data exported | `privacy.export`, `persons.export`, `files.downloaded` (ops, crm, platform) |
| Waitlist manually changed | `waitlist.update` (booking) |
| Consent changed | `consent.record` (crm) |
| Customer deleted | `privacy.erase` (ops), stored without personal data |
| Permission changed | `roles.update_permissions` (platform) |
| Campaign sent | `campaigns.send` (email) |
| Automation manually moved/stopped | `automations.move_person`, `automations.exit_person`, `automations.pause` (automation) |

## 8. Multi-language and content

- Infrastructure owned by platform in `packages/core/src/i18n/`: `locales.ts` (`LOCALES = ['nl-BE','fr-BE','en'] as const`, `DEFAULT_LOCALE = 'nl-BE'`, `URL_SEGMENT = { 'nl-BE': 'nl', 'fr-BE': 'fr', en: 'en' }`), `localized-text.ts` (`type LocalizedText = Partial<Record<Locale, string>>`, Zod `LocalizedTextSchema`, `isComplete`, `missingLocales`, `assertComplete`, `MissingTranslationError extends PermanentError`), `t.ts` (`t(locale, key, params)` using ICU via `intl-messageformat`, throwing `MissingMessageError` in tests and returning `⟦key⟧` in production), `format.ts` (`formatMoney(cents, locale)`, `formatDate(date, locale, style)`, `formatDateTime`, all in `Europe/Brussels`), `messages/<locale>/<module>.json` for all 12 modules and `messages/index.generated.ts`.
- `apps/web/lib/i18n.ts` configures `next-intl` (`getRequestConfig` loads only the namespaces of the current route group: `platform` + `site` for `(site)`, `platform` + the portal modules for `(portal)`, all for `(admin)`), `onError` → Sentry once per key, `getMessageFallback` → `⟦key⟧`.
- `pnpm i18n:check` (`packages/core/scripts/i18n-check.ts`) enforces PL-62 and also fails on keys that do not start with their file's module name, and on ICU syntax errors.
- Catalogue namespace `platform`, keys `platform.<screen>.<element>`. Screens: `login`, `mfa`, `invite`, `reset`, `account`, `users`, `roles`, `flags`, `settings`, `ai`, `system`, `jobs`, `webhooks`, `integrations`, `audit`, `incidents`, `golive`, `security`, `support`, `reports`, `portal_login`, `portal_security`, `errors` (the seven action error codes), `nav` (section and entry labels), `shell` (shared chrome), `permissions` (descriptions of the six platform permissions), `email` (magic link, invite and reset email copy). Every other module describes its own permissions under `<module>.permissions.<action>`; the roles screen reads them from there.
- `LocalizedText` fields owned by platform: `roles.name`, `roles.description`. They are seeded complete in all three locales; `updateRolePermissions` does not edit them.
- Transactional email templates owned by platform (in `packages/email/src/templates/platform/`, the folder architecture section 1 gives the platform module): `magic-link.tsx`, `staff-invite.tsx`, `password-reset.tsx`, `mfa-changed.tsx`, `monthly-report.tsx`, plus `index.ts` exporting them for email's `TEMPLATE_REGISTRY`. Template keys `platform.magic_link`, `platform.staff_invite`, `platform.password_reset`, `platform.mfa_changed`, `platform.monthly_report`; slugs `platform/magic-link`, `platform/staff-invite`, `platform/password-reset`, `platform/mfa-changed`, `platform/monthly-report` (email's slug rule `<module>/<file basename>`). Their copy comes from `platform.email.*`; the email module's seed registers the `email_templates` rows. `monthly-report` goes to BEAM management in each recipient's `users.locale`. Staff emails go out in `users.locale`, customer emails in `persons.locale` (falling back to the URL locale on first sign-up).
- `packages/ui` components take strings as props; they contain no catalogue lookups, so `ui` stays free of `next-intl`.
- Publish-time checks: platform publishes nothing itself; it provides `assertComplete()` that every publishing module calls, and `LocalizedInput` shows a completeness badge per locale.

## 9. Privacy

`apps/web/modules/platform/privacy.ts` registers:

| Table | Person link | Export | Erase | Why |
| --- | --- | --- | --- | --- |
| `users` (customer) | `person_id` | email, locale, created_at, last_login_at, has_password | delete the row (cascades `auth_sessions`, `auth_accounts`), delete `auth_verification_tokens` with identifier = email | an account has no legal retention need |
| `users` (staff / partner) | `person_id` (partner only) | n/a (staff are not data subjects of this flow) | an `external_partner` user linked to the erased person is deleted with its sessions (the check requires a person for partners) | the partner link points at the erased person |
| `audit_log` | `person_id` | rows where `person_id` = subject: action, created_at, entity_type (values omitted) | under `beam.allow_rewrite`: `old_value`, `new_value` replaced by `{ digest: sha256(json) }`, `ip` nulled, `is_redacted = true`; `person_id` kept so the erasure itself stays provable | audit trail must survive (blueprint 56), values must not |
| `files` | `person_id` | list of files with kind and name; `invoice_pdf` and `receipt` bytes included | delete kinds `export`, `import`, `rendered_email`, `image`; keep `invoice_pdf` and `receipt` with `person_id` nulled | invoices kept 7 years under Belgian accounting law (finance owns the invoice rows) |
| `ai_requests` | `person_id` | feature, created_at, fields_sent (prompt and output included) | delete (under `beam.allow_rewrite`) | proposal scenario 7: AI logs removed |
| `rate_limits`, `webhook_events`, `integration_calls`, `jobs`, `settings`, `feature_flags.person_ids` | none or indirect | none | `feature_flags.person_ids` and `user_ids`: remove the ids; job payloads are ids only and are pruned by age | no stored personal data beyond ids |

`NO_PII_TABLES` entries from platform: `roles`, `jobs`, `settings`, `rate_limits`, `security_incidents`, `webhook_events`, `integration_calls`, `support_requests`, `monthly_reports` (none has a `persons.id` column; support and incident free text must not hold customer data, and staff user references are staff, not data subjects of this flow). `webhook_events.payload` can contain an email address (Resend events): it is covered by the 90-day retention policy, and the erase handler deletes `webhook_events` rows whose `payload::text` contains the subject's lower-cased email (sequential scan accepted: the table holds at most 90 days).

Retention policies (rows in ops' `retention_policies`, enforced by `privacy.retention_sweep`; platform supplies the sweep functions in `privacy.ts` as `sweep: Record<policyKey, (tx, cutoff: Date) => Promise<number>>`):

| Policy key | Table | Days | Action |
| --- | --- | --- | --- |
| `audit_log` | `audit_log` | 1826 (5 years) | delete |
| `ai_requests` | `ai_requests` | 30 | delete |
| `webhook_events` | `webhook_events` | 90 | delete |
| `integration_calls` | `integration_calls` | 90 | delete |
| `exports` | `files` where kind = `export` | 7 | delete (also via `expires_at`) |
| `rendered_emails` | `files` where kind = `rendered_email` | 30 | delete |
| `jobs` | handled by `jobs.prune` (7 / 90 days) | – | delete |
| `support_requests` | `support_requests` where `status = 'closed'` | 1095 (3 years) | delete |

Customer accounts of persons with no activity for 3 years are anonymised together with the marketing profile by crm's sweep, which calls platform's erase handler for `users`. The subject's GDPR export includes sensitive data only through `readSensitive(ctx, personId, 'privacy_export')` with the system actor (architecture section 4).

## 10. Dependencies

**Platform needs from other modules** (all through `api.ts` stubs that Wave 0 writes; platform's own tests mock them):
- `crm:findOrCreatePersonByEmail` (customer sign-up, PL-12), `crm:setPersonTester` (flag testers), table `persons` (read: `is_tester`, `locale`, `partner_company_id`, `erased_at`) and `activity_events` (written via `recordEvent`).
- `email:sendTransactional` (magic link, staff invite, password reset, security notice, monthly report). Wave 0 writes a working minimum of it on email's behalf (section 4.9), so the auth e2e runs at the Wave 0 checkpoint; email replaces it in Wave 1 behind the same signature.
- `email:TEMPLATE_REGISTRY` reads `packages/email/src/templates/platform/index.ts`; `email:seed` registers the five platform templates.
- `site:portal layout` takes over `app/[locale]/(portal)/account/layout.tsx` in Wave 1; `site:legal pages` supplies the accessibility statement page (PL-90) and the privacy notice linked from the sign-in screens.
- `ops:retention_policies` table and `privacy.retention_sweep` (runs platform's sweep functions); `ops.daily_digest` (calls `getPlatformDigest`); `ops:isDpiaApproved` (PL-55; mocked in platform tests, and while the ops stub throws the sensitive switch stays off, which is the safe default).
- `crm:v_person_profile` is not read by platform; `toAiContext()` takes an already loaded profile object.

**Platform provides to every module:** `action()`, `Ctx`/`JobCtx`, `defineJob`, `defineSchedule`, `defineEvent`, `defineWebhookHandler`, `enqueue`, `runJobInline`, `recordEvent`, `audit`, `getSetting`, `flag`, `storeFile`/`readFile`/`signFileUrl`, `encryptSensitive`/`decryptSensitive`/`readSensitive`, `handleWebhook`, `callClaude`, `notifySlack`, `rateLimit`, `requireStaff`/`requireCustomer`/`requirePermission`/`hasPermission`, `logger`, i18n (`t`, `LocalizedText`, `assertComplete`, formatters), UI kit (`AdminShell`, `PortalShell`, `DataTable`, `LocalizedInput`, `FormField`, shadcn set), the generators and registries, test helpers (`createTestDb()` plus `makePerson`, `makeUser`, `makeProduct`, `makeSession`, `makeGrant`, `makeCtx`, `makeJobCtx`, `runJobTwice`), integration fakes, `isGoLiveGateComplete` (ops imports), `getCustomerAccount`/`reassignCustomerAccount`/`syncCustomerAccountEmail` (crm person page, merge and email change), `listStaffForAssignment` (crm tasks, automation task steps), `setSetting` (finance company form, site settings), `onDead` hooks (automation step failures), `belgianPublicHolidays` (booking closed-day suggestions), `expectAccessible` (every module's Playwright specs), `partnerScope` (R3: crm, booking, ops partner views), `runAiReadOnlyQuery` (R4: ops NL questions).

## 11. Edge cases and failure modes

1. **Two ticks overlap** (a slow tick still running when the next starts): both claim with `FOR UPDATE SKIP LOCKED`, so no job runs twice; schedule keys dedupe enqueues.
2. **Vercel Cron skips minutes**: daily and hourly schedules catch up 60 minutes (PL-33); minute-level work simply runs on the next tick. A gap above 3 minutes trips the health check and Better Stack calls the on-call founder.
3. **A job's handler succeeds against a provider, then the transaction fails to commit**: the job retries; the provider call is repeated with the same idempotency key (Mollie `Idempotency-Key`, Resend `Idempotency-Key` header = job key), so no duplicate side effect.
4. **A job exceeds `timeoutMs`**: `statement_timeout` aborts SQL, the runner's timer rejects with `RetryableError('timeout')`, the transaction rolls back and the attempt counts.
5. **The function instance dies mid-job**: the row stays `running`; after 10 minutes it is reclaimed with `stale lock` (PL-30).
6. **An idempotency key is reused after its job was pruned** (7 days): the job is created again. Keys embed ids and dates, and handlers are idempotent on state, so a rerun is harmless; this is accepted and documented in conventions.
7. **Dead-job storm** (Resend outage kills 300 `email.send` jobs): one Slack line per kind per hour, not 300; the System page groups by kind; "Retry all dead of this kind" is a bulk use of `retryJob` limited to 500 rows per click.
8. **Webhook arrives before the order row commits** (Mollie is fast): `webhook.process` → `payments.sync` finds no payment, throws `RetryableError`, and the 60 s backoff resolves it.
9. **Webhook signature secret rotated wrongly**: every call is 401 and logged; the alert after 5 failures in 10 minutes names the provider; restore uses replay from the provider dashboard.
10. **Staff loses the TOTP device and all recovery codes**: another user with `users.manage` runs `resetUserMfa` with a reason (owner for an owner). If the only owner is locked out, Sidestream runs `pnpm admin:reset-mfa --email` (script in `apps/web/scripts/`, needs `DATABASE_URL_UNPOOLED`, writes audit with actor `system`), documented in `docs/runbooks/access.md`.
11. **Brute force against one account from many IPs**: the per-account limit (20 per hour) and lockout (10) stop it; the per-IP limit stops spraying across accounts.
12. **Magic link opened on a different device or by a mail scanner that prefetches links**: the link lands on a confirmation page with a "Sign in" button that POSTs, so a prefetching scanner does not consume the token.
13. **A customer changes their email in crm**: crm calls `syncCustomerAccountEmail`; if the new email belongs to another user, crm's action fails with `conflict` before any write.
14. **Two persons are merged and both have portal accounts**: `reassignCustomerAccount` keeps the winner's account, deletes the loser's account and sessions, and the loser's email can sign in again only after it is added to the winner. If only the loser has an account, it moves to the winner.
15. **Settings edited in two tabs**: the second save gets `conflict` (PL-41) and the form reloads the current value with a notice.
16. **A flag is removed from code while a row still exists**: the row is ignored and shown as "orphaned" on the flags screen; `gen:indexes` does not fail.
17. **A role is edited so nobody holds `users.manage` except the owner**: allowed; the owner keeps `'*'`, which cannot be removed (check constraint).
18. **Encryption key missing at runtime** (env not set on a new environment): `encryptSensitive` throws `PermanentError('missing_key')`, health returns 503 in production, and writes of sensitive fields fail with `internal`. Nothing is stored in plain text.
19. **Rekey interrupted halfway**: rows carry their own `key_version`; reads work with both keys; the self-continuing job resumes from `afterId`. The old key env var is removed only after `/admin/system/security` shows zero rows on it.
20. **AI budget reached mid-month**: new AI calls end `budget_exceeded`; the owner can raise `monthly_budget_cents`; the dead AI jobs can be retried from the System page.
21. **Claude returns invalid structured output**: Zod parse fails → `RetryableError` once (attempt 2), then `PermanentError`; the draft panel shows "AI unavailable, write manually".
22. **A file upload of 10 MB + 1 byte, or an SVG**: refused with `validation` before any bytes are stored.
23. **Missing translation key in production**: the UI shows `⟦platform.users.title⟧`, Sentry gets one event per key per deployment, and CI's `i18n:check` should have blocked it, so the fix is a catalogue PR.
24. **`proxy.ts` sees a session cookie that is no longer valid**: proxy only checks presence; the layout's `requireStaff()` finds no row and redirects to login, deleting the stale cookie.
25. **Database unreachable** (Neon incident): health returns 503 within 5 s (query timeout), actions return `internal` with a request id, the tick exits early and Better Stack alerts; after recovery, pending jobs resume from the table with nothing lost.
26. **Clock skew between Vercel instances**: all comparisons of `run_at`, `locked_at` and expiries use the database's `now()`, never the app clock.
27. **Audit search on 5 years of rows**: every filter maps to an index of section 2; free-text search is not offered; results are keyset-paginated.
28. **Demo seed accidentally pointed at production**: refused because `APP_ENV = production` (PL-79), and the demo seed also refuses when the `persons` table holds more than 500 rows without `is_tester`.
29. **Reception tablet left signed in overnight**: the reception role's 4-hour idle timeout (PL-8) ends the session; the next user signs in with their own account and TOTP, so audit rows name the right person.
30. **A support request arrives on Friday 17:30 as `normal`**: `slaDueAt` counts 30 minutes on Friday and 510 on Monday, so it is due Monday 17:30; if Monday is Easter Monday it is due Tuesday 17:30 (PL-88).
31. **Better Stack API down on the 1st**: `platform.build_monthly_report` retries with backoff and goes dead after 6 attempts; the owner enters uptime by hand on the report (`uptime_source = 'manual'`) and retries later if wanted.
32. **`onDead` hook throws** (automation cannot write its `failed` run): the job stays `dead`, Sentry gets the hook error, and `retryJob` clears `on_dead_at` so a later dead transition calls the hook again (PL-29a).
33. **A third-party script without the nonce** (a pasted embed snippet on a site page): the CSP blocks it and the browser reports a violation; site's block schema has no raw-HTML block, so this only happens through a code change, which the CSP test in `proxy.test.ts` catches for known routes.
34. **A dependency update breaks the build**: Renovate's PR fails CI and is not merged; security updates that fail are raised as a `high` support request by Sidestream so the SLA clock applies.

## 12. Build packages

**Order and parallelism.** W0-0 (orchestrator) → P1 → {P2, P3, P4 in parallel} → P5 → {P6, P7 in parallel} → merge = end of Wave 0 → P8 in Wave 1 → P11 as a week-5 sprint package (after Waves 1 and 2 have merged; finished by week 6) → P9 in Release 3 → P10 in Release 4. The critical path P1 → P2 → P5 → P6 fits the architecture's two-hour Wave 0 window with each package at 30–60 minutes. No two packages in the same step touch the same file. Files edited by more than one package are listed under each package and are always strictly sequential.

**W0-0, orchestrator step (not a coding package).** Because no package edits `package.json` or the lockfile, the orchestrator first creates `packages/{config,ui,core,email,integrations}/package.json` (names `@beam/<name>`, `"type": "module"`, `exports` of `./src/index.ts` plus subpaths `./<module>`, `./i18n`, `./errors`, `./ai`, `./privacy`), adds root scripts (`gen:indexes`, `lint`, `i18n:check`, `gdpr:coverage`, `test:e2e`, `db:seed`, `seed:demo`, `admin:reset-mfa`, `docs:schema` (= `pnpm --filter @beam/db docs-schema`, with the matching `docs-schema` script in `packages/db/package.json`), `exit:export`, `test:load`), and installs `@axe-core/playwright` and `autocannon` (dev) next to: `next-auth@5`, `@auth/drizzle-adapter`, `next-intl`, `intl-messageformat`, `zod`, `@node-rs/argon2`, `otpauth`, `qrcode`, `@zxcvbn-ts/core`, `@zxcvbn-ts/language-common`, `@zxcvbn-ts/language-en`, `@zxcvbn-ts/language-nl-be`, `@zxcvbn-ts/language-fr`, `@sentry/nextjs`, `pino`, `serwist`, `@serwist/next`, `date-fns`, `@date-fns/tz`, `csv-parse`, `fflate`, `@react-pdf/renderer`, `react-email`, `@react-email/components`, `mjml`, `resend`, `svix`, `@mollie/api-client`, `@anthropic-ai/sdk`, `google-auth-library`, `tailwindcss@4`, `@tailwindcss/postcss`, `class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react`, the `@radix-ui/react-*` primitives shadcn uses, `@tanstack/react-table`, `react-hook-form`, `@hookform/resolvers`, `sonner`, `cmdk`; dev: `vitest`, `@vitest/coverage-v8`, `@testing-library/react`, `@testing-library/user-event`, `jsdom`, `@playwright/test`, `eslint`, `typescript-eslint`, `@next/eslint-plugin-next`, `eslint-plugin-react-hooks`, `prettier`, `prettier-plugin-tailwindcss`, `tsx`, `@types/qrcode`, `@types/mjml`. Then `pnpm install` and commit the lockfile.

### platform-P1: Tooling, generator and repository rules (V1, Wave 0)
- **Goal:** lint, configs, CI, conventions and the index generator, so every later package has its guard rails.
- **Files:** `packages/config/{eslint.config.js, tsconfig.base.json, tsconfig.next.json, tsconfig.lib.json, tailwind-theme.css, prettier.config.js}`; `eslint.config.js`, `turbo.json` (task `gen` that `dev`, `build`, `test`, `typecheck`, `lint` and `db:generate` depend on), `.gitignore` (add `apps/web/registry/*.generated.ts`, `packages/db/src/schema/index.ts`, `packages/core/src/i18n/messages/index.generated.ts`), `.env.example` (every variable of architecture section 9 plus `APP_ENV`, `APP_URL`, `EMAIL_SINK`, `INTEGRATIONS`, `DEMO_STAFF_PASSWORD`, `DEMO_TOTP_SECRET`, `BETTERSTACK_API_TOKEN`, `BETTERSTACK_MONITOR_ID`); `vercel.json` (the one cron, `regions: ["fra1"]`); `apps/web/next.config.ts` (static security headers PL-67, `serverActions.allowedOrigins`, `typedRoutes`, and the Serwist wrapper `withSerwistInit({ swSrc: 'app/sw.ts', swDest: 'public/sw.js', disable: process.env.NODE_ENV === 'development' || !existsSync('app/sw.ts') })` so site's service worker in Wave 1 needs no frozen-file change); `renovate.json` (PL-84: `config:recommended`, schedule `before 6am on monday`, timezone `Europe/Brussels`, groups for `@radix-ui/*`, `@sentry/*`, `drizzle-*`, `@auth/*`/`next-auth`, vulnerability alerts immediate); `.gitleaks.toml` (default rules plus an allow-list for `.env.example`); `.github/pull_request_template.md` (checkboxes: tests, i18n keys, handbook page updated when a rule changed, flag for user-visible change); `git rm --cached packages/db/src/schema/index.ts` (it becomes generated); `apps/web/{vitest.config.ts, playwright.config.ts}`; `packages/{config,ui,core,email,integrations}/{tsconfig.json, vitest.config.ts, src/index.ts}`; `apps/web/scripts/{gen-indexes.ts, gen-indexes.test.ts, check-ownership.ts, eslint-boundaries.test.ts}` with fixtures in `apps/web/scripts/__fixtures__/`; `.github/workflows/{ci,preview-branch,deploy,e2e,backup,restore-drill,anonymise-staging}.yml`; `.github/CODEOWNERS`; `docs/plan/conventions.md`; `CLAUDE.md`; `docs/build/{dependency-requests.md, ownership.json}`.
- **Interfaces:** `gen-indexes.ts` scans `apps/web/modules/*/{jobs,schedules,events,permissions,nav,privacy,config,seed}.ts` for the named exports `jobs`, `webhookHandlers`, `schedules`, `events`, `permissions`, `nav`, `privacy`, `settings`, `flags`, `seed` and writes `apps/web/registry/{jobs,webhooks,schedules,events,permissions,nav,privacy,settings,flags,seeds}.generated.ts`, `packages/db/src/schema/index.ts` (re-exports `<m>.ts` and `<m>.views.ts`) and `packages/core/src/i18n/messages/index.generated.ts`. It works with any subset of modules present. ESLint: per-module `no-restricted-imports` overrides generated from the twelve module ids (PL-82), `@anthropic-ai/sdk` restricted to `packages/integrations/src/anthropic/` (PL-51), the package import table of architecture section 1.
- **Depends on:** W0-0.
- **Tests:** `gen-indexes.test.ts`: (1) a fixture tree with two modules produces sorted, byte-identical output on two runs; (2) duplicate job kind across modules fails with both file names; (3) a module missing `nav.ts` is skipped; (4) schema index includes `<m>.views.ts` only when it exists. `check-ownership.ts` self-test with a fake diff. An ESLint fixture test (`apps/web/scripts/eslint-boundaries.test.ts`) lints two fixture files and expects a `no-restricted-imports` error for `modules/crm/x.ts` importing `modules/booking/queries.ts` and for an `@anthropic-ai/sdk` import outside `packages/integrations/src/anthropic/` (PL-51, PL-82). `ci.yml` steps: `gen:indexes`, typecheck, lint, `i18n:check`, unit and PGlite tests, `db:check-migrations`, `gdpr:coverage`, ownership check, `pnpm audit --audit-level high --prod`, gitleaks, and on pushes to `main` only `docs:schema --check` (PL-91). `deploy.yml` checks that the commit is on `origin/staging` unless the PR carries the `hotfix` label (PL-76a).
- **Done:** `pnpm gen:indexes`, `pnpm typecheck`, `pnpm lint` green; CI workflow YAML passes `actionlint` in CI.

### platform-P2: Database foundation (V1, Wave 0)
- **Goal:** all platform tables and views, the shared schema helpers, the contract tables of other modules, `enqueue`, append-only SQL, seed runner and factories.
- **Files:** `packages/db/scripts/docs-schema.ts` (PL-91: writes `docs/handbook/data-model.generated.md` from the schema with `getTableConfig`; `--check` exits 1 when the file differs) and `packages/db/test/docs-schema.test.ts`; `packages/db/src/schema/{_shared.ts, platform.ts, platform.views.ts, crm.ts, booking.ts, commerce.ts, credits.ts, finance.ts, forms.ts, email.ts, automation.ts, ops.ts, site.ts, webinar.ts}`; `packages/db/src/enqueue.ts`; `packages/db/src/index.ts` (edit: export `enqueue`, `Tx`, `DbOrTx`); `packages/db/src/sql/0002_append_only.sql` (function `reject_update_delete()` and one `BEFORE UPDATE OR DELETE` trigger per table in `APPEND_ONLY_TABLES`; the orchestrator copies it into the custom migration); `packages/db/src/seed/{run.ts, platform.ts}`; `packages/db/src/testing/factories.ts`; `packages/db/src/testing.ts` (edit: re-export factories, add `applyCustomSql(handle)`); `packages/db/test/{platform-schema.test.ts, enqueue.test.ts, append-only.test.ts, factories.test.ts, seed-platform.test.ts}`.
- **Interfaces:** section 2 tables, enums and views (including `support_requests`, `monthly_reports`, `v_support_sla`, because `platform.ts` is frozen after Wave 0); `enqueue()` of 4.1; `SENSITIVE_COLUMNS: { table: string; column: string; keyColumn: string }[]`; `APPEND_ONLY_TABLES`; `seedDefaults(db)` running every module's `packages/db/src/seed/<m>.ts` `seed(db)` in dependency order; `grantDefaultPermission(tx, roleKey, permission)`; factories `makeUser(db, overrides?)`, `makePerson(db, overrides?)`, `makeProduct`, `makeSession`, `makeGrant`.
- **Depends on:** platform-P1.
- **Tests:** schema: lower-email uniqueness, `users_audience_shape_ck`, owner `'{*}'` check, files 10 MB check, flag key regex; enqueue: same key twice → one row, `inserted` false, same id; explicit id honoured; append-only: after `applyCustomSql`, update and delete on `audit_log` raise, succeed inside a transaction with `SET LOCAL beam.allow_rewrite = 'on'`; seed: nine roles, defaults idempotent on second run, `grantDefaultPermission` does not re-grant a removed permission (PL-80); `support_requests`: reference unique, `first_response_at >= received_at` check, `v_support_sla.is_breached` true for an unanswered request past due; `monthly_reports.month_on` unique; `docs-schema.test.ts`: two runs give byte-identical output, APPEND and sensitive markings appear, `--check` fails after a fixture column is added.
- **Done:** typecheck, lint, `pnpm --filter @beam/db test` green with `createTestDb()`.

### platform-P3: Core, integrations and email base (V1, Wave 0)
- **Goal:** the framework-free pieces: errors, i18n, AI context and feature register, cron and backoff maths, sensitive key list, provider clients and fakes, email layout and platform templates.
- **Files:** `packages/core/src/errors.ts` (`RetryableError`, `PermanentError`, `NotImplementedError`, `ForbiddenError`, `MissingTranslationError`); `packages/core/src/i18n/{locales.ts, localized-text.ts, t.ts, format.ts}`; `packages/core/src/i18n/messages/{nl-BE,fr-BE,en}/<m>.json` for all 12 modules (`{}` except `platform.json`, which P3 fills with the `errors`, `email` and `permissions` keys); `packages/core/scripts/i18n-check.ts`; `packages/core/src/privacy/{sensitive-keys.ts, registry-types.ts}` (`SENSITIVE_FIELD_KEYS`, `PrivacyRegistration` type with `tables`, `export`, `erase`, `sweep`); `packages/core/src/ai/{context.ts, features.ts, pricing.ts}`; `packages/core/src/platform/{cron.ts, backoff.ts, flags-eval.ts, rate-window.ts, recovery-codes.ts, go-live.ts, holidays.ts, sla.ts, index.ts}`; `packages/integrations/src/_shared/{errors.ts, digest.ts, timeout.ts, types.ts}`, `anthropic/{client.ts, fake.ts}`, `slack/{client.ts, fake.ts}`, `betterstack/{client.ts, fake.ts}`, `resend/{client.ts, fake.ts}` (Wave 0 minimum: `sendEmail` only, section 6), `payments/{provider.ts, fake.ts}`, `billit/fake.ts`, `youtube/fake.ts`, `ads/fake.ts`; `packages/email/src/layout/BaseLayout.tsx`, `packages/email/src/render-email.ts`, `packages/email/src/index.ts` (the file names the email spec edits in Wave 1), `packages/email/src/templates/platform/{magic-link.tsx, staff-invite.tsx, password-reset.tsx, mfa-changed.tsx, monthly-report.tsx, index.ts}`; tests beside each file.
- **Interfaces:** `toAiContext(profile: AiProfileInput): AiContext`, `AI_ALLOWED_FIELDS`, `AI_FEATURES: Record<AiFeatureKey, AiFeature>` with `{ module, purpose, model, effort, allowedFields, allowsSensitive: false, when, provider: 'Anthropic', location: 'Anthropic API, US processing under the EU-US DPF and SCCs; an EU endpoint is used once Anthropic offers one', retention: '30 days in ai_requests; Anthropic API retention per its commercial terms', trainingStatus: 'not_used_for_training', outputStorage, promptStorage: 'ai_requests.prompt', promptRetention: '30 days' }` for `site.propose_page` (V1), `ai.classify` (R3, inbox), `ai.draft_email`, `ai.draft_reply`, `ai.weekly_summary`, `ai.answer_question` (R4); the keys equal the job kinds of architecture section 8; `costCents(usage, pricing)`; `matchesCron(expr, localDate)`, `slotsBetween(expr, from, to, tz)`; `nextRunAt(attempt, now, random)`; `isFlagOn(flag, subject)`; `belgianPublicHolidays(year): { on: string; key: string }[]` (Easter by the anonymous Gregorian algorithm); `slaDueAt(severity, receivedAt, calendar): Date` (PL-88); `renderEmail(component, { locale })` returning `{ html, text, subject }` (Wave 0 shape; email widens the input in Wave 1 and keeps this overload); `PaymentProvider` interface (architecture section 8); `createClaudeClient`, `createSlackClient`, every `create<Provider>Fake()`.
- **Depends on:** platform-P1.
- **Tests:** `cron.test.ts` (every-5-minutes, daily 02:00, Monday 06:30, spring DST 2027-03-28 02:30 fires at 03:00, autumn 2026-10-25 02:30 yields one slot); `backoff.test.ts` (60/300/900/3600/21600 with jitter bounds); `localized-text.test.ts` (whitespace counts as missing); `t.test.ts` (ICU plural nl-BE and fr-BE); `i18n-check` run on fixtures (missing key, extra key, empty value, wrong prefix); `context.test.ts` (scenario 6: a profile with every sensitive key filled and a free-text health note produces an `AiContext` and JSON without any of those values; no `SENSITIVE_FIELD_KEYS` member in `AI_ALLOWED_FIELDS`); `features.test.ts` (every feature's `allowedFields` ⊆ `AI_ALLOWED_FIELDS`, all ten blueprint-61 fields present); `pricing.test.ts`; `anthropic/fake.test.ts`; `holidays.test.ts` (2026: Easter Monday 6 April, Ascension 14 May, Whit Monday 25 May; 2027: Easter Monday 29 March; ten dates per year); `sla.test.ts` (Friday 17:30 normal → Monday 17:30; Easter Monday skipped; critical Saturday 11:00 → Saturday 15:00; critical Friday 17:00 → Saturday 11:00 because weekend hours start at 10:00; high received Sunday counts from Monday 09:00); `betterstack/fake.test.ts`; `render-email.test.ts` (all five platform templates render in all three locales, text part present, magic link contains the URL).
- **Done:** typecheck, lint, `pnpm --filter @beam/core test`, `@beam/integrations test`, `@beam/email test` green; `pnpm i18n:check` green.

### platform-P4: UI kit (V1, Wave 0)
- **Goal:** `packages/ui` with tokens, the shadcn base set and the shared composite components.
- **Files:** `packages/ui/src/tokens.css`, `packages/ui/src/components/*.tsx` (button, input, textarea, select, checkbox, switch, radio-group, label, dialog, sheet, dropdown-menu, popover, tabs, table, badge, card, tooltip, skeleton, alert, separator, avatar, breadcrumb, pagination, command, sonner), `packages/ui/src/{data-table.tsx, localized-input.tsx, form-field.tsx, admin-shell.tsx, portal-shell.tsx, empty-state.tsx, error-state.tsx, locale-unavailable.tsx, report-problem-dialog.tsx, cn.ts, index.ts}`, tests `packages/ui/src/{data-table,localized-input,admin-shell,form-field,dialog}.test.tsx` and `packages/ui/src/tokens.test.ts`.
- **Interfaces:** `DataTable<T>({ columns, rows, nextCursor, prevCursor, filters, emptyState, onRowHref })` (URL-driven, no client fetching); `LocalizedInput({ name, value, onChange, locales, multiline, labels })` with per-locale completeness badge; `FormField({ label, error, hint, children })`; `AdminShell({ nav: NavSection[], user, banner?, userMenu: { onReportProblem, signOutHref }, labels, children })`; `ReportProblemDialog({ onSubmit, labels, emergencyPhone })` (strings as props, the action is passed in by the app); `PortalShell({ nav, locale, localeSwitch, children })`; `NavSection = { key, label, items: { key, href, label, icon }[] }`.
- **Depends on:** platform-P1.
- **Tests:** DataTable renders empty state and cursor links; LocalizedInput badge shows missing `fr-BE`; AdminShell renders only the items it is given (filtering happens in the app). Accessibility (PL-90) with `@testing-library/react` and `userEvent`: dialog traps focus and returns it to the trigger; `FormField` without a label fails typecheck (required prop) and links `error` through `aria-describedby`; DataTable pagination is reachable by Tab; AdminShell has a skip link and `nav`/`main` landmarks; `tokens.test.ts` computes WCAG contrast for every foreground/background token pair used for text and asserts at least 4.5:1.
- **Done:** typecheck, lint, `pnpm --filter @beam/ui test` (jsdom) green.

### platform-P5: Runtime: jobs, tick, events, audit, settings, flags, files, webhooks, AI gateway, observability (V1, Wave 0)
- **Goal:** everything that runs without a signed-in user, plus the platform module registrations.
- **Files:** `apps/web/lib/{ctx.ts, job-runner.ts, events.ts, audit.ts, settings.ts, flags.ts, files.ts, sensitive.ts, webhooks.ts, ai.ts, rate-limit.ts, alerts.ts, logger.ts, integrations.ts}` with tests `apps/web/lib/*.test.ts`; `apps/web/instrumentation.ts`, `apps/web/sentry.server.config.ts`, `apps/web/sentry.client.config.ts`; `apps/web/app/api/health/route.ts` (edit) and `route.test.ts`; `apps/web/app/api/cron/tick/route.ts` and `route.test.ts`; `apps/web/app/api/public/files/[id]/route.ts`; `apps/web/modules/platform/{api.ts, jobs.ts, schedules.ts, events.ts, permissions.ts, nav.ts, privacy.ts, config.ts}`; `apps/web/modules/platform/jobs.test.ts`, `privacy.test.ts`, `apps/web/lib/alerts.test.ts`, `apps/web/lib/logger.test.ts`.
- **Interfaces:** section 4.1 (all except `action.ts`, `auth.ts`, `i18n.ts`, `csp.ts`), section 4.5 jobs, 4.6 schedules, 4.7 events, 4.8 `api.ts`; `makeCtx(db, actor?)`, `makeJobCtx(db, kind)`, `runJobTwice(db, kind, payload)` exported from `apps/web/lib/testing.ts` (also in this package).
- **Depends on:** platform-P2 (tables, `enqueue`), platform-P3 (errors, cron, backoff, AI features, fakes).
- **Tests:** `job-runner.test.ts`: claim respects priority then `run_at`; two concurrent `runJobs` never run one job twice; retry schedule PL-26; `PermanentError` and bad payload → dead (PL-28); dead enqueues one `notify.slack` per kind per hour (PL-29); stale lock reclaim (PL-30); timeout (edge 4); `runJobInline` refuses a non-inline kind (PL-35); prune (PL-31). `schedules.test.ts` (in `job-runner.test.ts` or own file): catch-up 60 minutes for daily, none for minute-level (PL-33). `events.test.ts`: Zod validation, dedupe returns null id, person-or-company required. `audit.test.ts`: redaction PL-21. `settings.test.ts`: default when missing, version conflict, system keys skip audit. `flags.test.ts`: `off`/`testers`/`on` with user and person testers, 60 s cache. `files.test.ts`: 10 MB + 1 refused, SVG refused, signed token valid, expired, wrong id; access matrix PL-46. `sensitive.test.ts`: round trip, wrong AAD fails, read with older key version, missing key → `PermanentError`, `readSensitive` without `persons.sensitive_read` → forbidden and with it → audit row. `webhooks.test.ts`: duplicate → one job; bad signature → 401 and `integration_calls` row; job id equals `webhook_events.job_id`. `ai.test.ts` (with the Claude fake): field not allowed → no call, error row; sensitive key with `sensitive_enabled = false` → blocked (scenario 6); budget exceeded → `budget_exceeded` row and dead job; cost maths; refusal → Permanent. `rate-limit.test.ts`: window roll-over; the PL-68 limits per route (11th login per IP per minute → 429 with `Retry-After`; heartbeat not counted against the per-IP bucket). `job-runner.test.ts` also: `onDead` runs once after the dead status commits, a throwing hook leaves the job dead and reports to Sentry, retry clears `on_dead_at` (PL-29a). `settings.test.ts` also: `setSetting` with a stale version → `conflict`, writes `settings.update` audit. `alerts.test.ts` (`platform.check_alerts` on fixtures, PL-75): backlog 501 → one alert, a second run in the same hour → no second Slack job; 6 signature failures in 10 minutes → alert; Mollie silence 24 h with a portal order → High alert, without orders → none; provider down; database size above 8 GB (size function stubbed); AI 80 %; incident at 20 h; unanswered critical support request past due; pentest due in 7 days. `logger.test.ts`: pino output of `{ email, phone, first_name, req: { headers: { cookie } } }` contains none of the values (PL-72); Sentry `beforeSend` masks an email in a message. `files.test.ts` also: public image `Cache-Control: public, max-age=31536000, immutable`; private file headers of PL-50; downloading an `export` writes `files.downloaded`; `purge_expired` deletes only expired rows (PL-48); total size 4 GB + 1 → digest warning, 5 GB + 1 → High alert (PL-49, size stubbed). `ai.test.ts` also: crossing 80 % enqueues exactly one Slack job per month (PL-56). Health: 200 shape, 503 on stale tick in `production`, 503 on backlog 501, 503 in production with `EMAIL_SINK` set, with a `test_` Mollie key, without `SENSITIVE_DATA_KEY_V1`, or with a `DATABASE_URL` lacking `sslmode=require` (PL-74, PL-83). Tick: 401 without bearer, enqueues due schedules once across two calls in the same minute. `jobs.test.ts`: every platform job run twice yields the same state. `privacy.test.ts`: erase deletes customer user, sessions, tokens, `ai_requests`, person files except invoices; audit values become digests.
- **Done:** typecheck, lint, `pnpm --filter @beam/web test -- lib modules/platform app/api` green with `createTestDb()`.

### platform-P6: Auth, action wrapper, proxy, shells and sign-in screens (V1, Wave 0)
- **Goal:** both audiences can sign in; `action()` works; the three route groups render with generated navigation; dead jobs are visible and retryable.
- **Files:** `apps/web/lib/{auth.ts, auth-config.ts, password.ts, totp.ts, action.ts, i18n.ts, csp.ts}` with tests; `apps/web/proxy.ts` and `proxy.test.ts`; `apps/web/e2e/support/a11y.ts` (`expectAccessible(page)`, PL-90); `apps/web/app/api/auth/[...nextauth]/route.ts`; `apps/web/app/{layout.tsx, page.tsx}` (edit), `app/{not-found.tsx, global-error.tsx}`, `app/[locale]/{layout.tsx, not-found.tsx}`; `app/(admin)/admin/{layout.tsx, loading.tsx, error.tsx, page.tsx}`, `app/(admin)/admin/account/page.tsx`, `app/(admin)/admin/system/jobs/{page.tsx, [id]/page.tsx}`; `app/(admin-auth)/admin/{layout.tsx, login/page.tsx, mfa/setup/page.tsx, mfa/verify/page.tsx, mfa/qr/route.ts, invite/[token]/page.tsx, reset-password/page.tsx, reset-password/[token]/page.tsx}`; `app/[locale]/(portal)/account/{layout.tsx, loading.tsx, error.tsx}`, `app/[locale]/(portal)/account/security/page.tsx`; `app/[locale]/(portal-auth)/account/login/{page.tsx, check-email/page.tsx, verify/page.tsx, error/page.tsx}`; `apps/web/modules/platform/{actions.ts, queries.ts}` (auth actions, `retryJob`, `discardJob`, job queries, and a `reportProblem` stub with its final signature that P8 implements; the admin layout wires the user-menu dialog to it) with `actions.test.ts`, `permissions.test.ts`; `apps/web/modules/platform/ui/{login-form.tsx, mfa-setup.tsx, totp-form.tsx, password-strength.tsx, hibp.ts, hibp.test.ts, jobs-table.tsx}`; `packages/core/src/i18n/messages/{nl-BE,fr-BE,en}/platform.json` (edit, strictly after P3: `login`, `mfa`, `invite`, `reset`, `account`, `jobs`, `shell`, `nav`, `portal_login`, `portal_security` keys); `e2e/platform.spec.ts`.
- **Interfaces:** `action()` and `ActionResult` (4.1); `getSession`, `requireStaff`, `requireCustomer`, `requirePermission`, `hasPermission`; `hashPassword`, `verifyPassword`, `checkPasswordPolicy(password, { audience, email }): Promise<{ ok: boolean; reasons: string[] }>`; `generateTotpSecret`, `verifyTotp(secret, code, now)`; `proxy` matcher for `/admin/:path*`, `/:locale(nl|fr|en)/:path*`, `/` and the nonce header `x-nonce`.
- **Depends on:** platform-P5 (ctx, jobs, audit, rate limits, settings), platform-P4 (shells), platform-P3 (i18n). Uses `crm:findOrCreatePersonByEmail` and `email:sendTransactional` through their Wave 0 stubs, mocked in tests.
- **Tests:** `password.test.ts` (PL-1, PL-2 rehash, PL-13 customer policy, server refuses a 11-character staff password and a zxcvbn-2 staff password; `hibp.test.ts` with a fake `fetch`: breached match, no match, timeout → allowed); `totp.test.ts` (±1 step, replay of the same code in the same step rejected); `auth.test.ts` (lockout at 10 and reset, PL-6; generic errors, PL-7; idle and absolute expiry, PL-8; logout and revoke delete rows, PL-9; MFA-pending session cannot run a staff action, PL-3; recovery code single use, PL-5; magic link limit 5 per hour, PL-11; sign-up creates customer user and `platform.account_created`, staff email refused, PL-12); `action.test.ts` (permission refused before handler, Zod `validation` with fields, `conflict`/`not_found` mapping, `internal` to Sentry fake, one audit row per staff write, handler-written audit suppresses duplicate, enqueued ids passed to `after`); `proxy.test.ts` (bare `/` → `/nl`, `Accept-Language: fr` → `/fr`, `NEXT_LOCALE=en` cookie wins over `Accept-Language`, admin without cookie → `/admin/login?returnTo=`, CSP header with nonce, HSTS present); `csp.test.ts` (fresh nonce per call, `frame-ancestors 'none'` on `/nl/account` and `*` on `/nl/f/intake`, YouTube in `frame-src`, Sentry and GA hosts in `connect-src`, no `'unsafe-eval'`); `auth.test.ts` also: reception idle 4 h vs 12 h for other roles (PL-8), password change and MFA reset enqueue `platform.mfa_changed` (PL-9); `permissions.test.ts` (each platform action denies without its permission). `e2e/platform.spec.ts`: demo owner signs in with password and a TOTP from `DEMO_TOTP_SECRET`, sees `/admin/system/jobs`, signs out; 10 wrong passwords lock the account; a customer requests a magic link on `/nl/account/login`, the spec reads the link from the sink (the newest `rendered_email` row in `files`, queried from the Playwright process with `@beam/db` over `neon-ws`; this step needs P7's working `email.send` and runs at the Wave 0 checkpoint after P6 and P7 merge), confirms it and lands signed in; `expectAccessible` passes on the login, MFA and check-email pages.
- **Done:** typecheck, lint, Vitest suites green; `pnpm build` green; `e2e/platform.spec.ts` green against `beam_dev` at the Wave 0 checkpoint.

### platform-P7: Module skeletons, contract stubs, demo seed and registry tests (V1, Wave 0)
- **Goal:** every module folder exists and compiles with final cross-module signatures, so eleven Wave 1 agents start on a green tree.
- **Files:** for each module `m` of `crm, booking, commerce, credits, finance, forms, email, automation, ops, site, webinar`: `apps/web/modules/m/{actions.ts, queries.ts, api.ts, jobs.ts, schedules.ts, events.ts, permissions.ts, nav.ts, privacy.ts, seed.ts, config.ts, ui/.gitkeep}`, `packages/db/src/seed/m.ts`, `packages/core/src/m/{index.ts, types.ts}`, `packages/email/src/templates/m/.gitkeep`, `packages/core/src/i18n/messages/{nl-BE,fr-BE,en}/m.json` (edit, strictly after P3: the `m.permissions.*` and `m.nav.*` keys its stubs declare); for `email` only, a working `api.ts` (`sendTransactional`) and `jobs.ts` (`email.send`) as described in section 4.9, with `apps/web/test/wave0-email.test.ts` (send twice with the same key → one `email_messages` row and one job; the job sends once through the Resend fake; `EMAIL_SINK` rewrites `to` and stores a `rendered_email` file; a missing template is `PermanentError`); plus `packages/core/src/crm/segment-fields.ts` (`SEGMENT_ALLOWED_FIELDS` initial list), `apps/web/modules/platform/seed.ts`, `apps/web/scripts/seed-demo.ts`, `apps/web/test/{registries.test.ts, gdpr-coverage.test.ts, i18n-parity.test.ts}`, `e2e/smoke.spec.ts`, and skipped scenario shells `e2e/scenario-{1-late-entry,2-fast-unsubscribe,3-lead-access,4-seat-claim,5-replay-separation,6-sensitive-ai,7-deletion}.spec.ts` plus `e2e/acceptance-v1.spec.ts` (each `test.fixme` with the checklist of proposal section 12, owned afterwards by the module named in architecture section 11).
- **Interfaces:** the stub signatures of 4.9; each module's `permissions.ts` declares its permission strings from architecture section 4 (so `registry/permissions.generated.ts` is complete from Wave 0); each `privacy.ts` exports `{ tables: [], export: async () => ({}), erase: async () => [] }` plus its contract tables; each `config.ts` declares its settings keys of section 2 with Zod schemas and defaults, and its flags (`ff_webinar_portal`, `ff_booking_lead_priority`, `ff_commerce_abandoned_checkout`, `ff_ops_custom_dashboards`, `ff_automation_builder`).
- **Depends on:** platform-P5 (`defineJob`, `defineEvent`, `defineSchedule`, `Ctx`, registration types), platform-P2 (contract tables), platform-P3 (core folders and types it imports).
- **Tests:** `registries.test.ts` (unique job kinds, event kinds, permissions, schedule kinds, flag keys, settings keys; every schedule kind has a job; every nav permission exists; no `SENSITIVE_FIELD_KEYS` member in `AI_ALLOWED_FIELDS` or `SEGMENT_ALLOWED_FIELDS`); `gdpr-coverage.test.ts` (every column referencing `persons.id` in `information_schema` belongs to a registered or `NO_PII_TABLES` table); `i18n-parity.test.ts` (runs the checker on the real catalogues); demo seed runs twice on PGlite without error and creates one staff user per role (`<role>@demo.beam.be`) plus 20 test persons; demo seed with `APP_ENV=production` throws before any write, and with 501 non-tester persons present throws (PL-79, edge 28); `e2e/smoke.spec.ts`: `/api/health` 200, `/` → `/nl`, `/admin` → login, `expectAccessible` on `/nl` and `/admin/login`.
- **Done:** typecheck, lint, all suites green; `pnpm gen:indexes` produces complete registries; `pnpm seed:demo` succeeds on `beam_dev`.

### platform-P8: platform-admin: settings, roles, users, flags, System, security and runbooks (V1, Wave 1)
- **Goal:** every remaining V1 screen of section 5 and the operational runbooks (the handbook and training material are platform-P11).
- **Files:** `app/(admin)/admin/settings/{page.tsx, users/page.tsx, users/[id]/page.tsx, roles/page.tsx, roles/[key]/page.tsx, flags/page.tsx, ai/page.tsx, [key]/page.tsx}`; `app/(admin)/admin/system/{page.tsx, webhooks/page.tsx, webhooks/[id]/page.tsx, integrations/page.tsx, audit/page.tsx, incidents/page.tsx, incidents/[id]/page.tsx, go-live/page.tsx, security/page.tsx, ai/page.tsx, support/page.tsx, reports/page.tsx, reports/[id]/page.tsx}`; `app/(admin)/admin/support/page.tsx`; `apps/web/modules/platform/{actions.ts, queries.ts, jobs.ts, schedules.ts, nav.ts}` (edit, after P5 and P6: admin, support, pentest and monthly-report actions of 4.2, queries of 4.3, jobs `security.rekey` and `platform.build_monthly_report`, its schedule, nav entries); `apps/web/app/(admin)/admin/layout.tsx` is not edited: the "Report a problem" menu entry is wired by P6 to `reportProblem`, which P8 implements in `actions.ts` (P6 ships it as a stub returning `internal`); `apps/web/modules/platform/ui/{settings-form.tsx, zod-form.tsx, role-editor.tsx, user-form.tsx, flag-editor.tsx, audit-search.tsx, incident-form.tsx, gate-checklist.tsx, system-tiles.tsx, support-table.tsx, support-form.tsx, monthly-report-view.tsx, pentest-form.tsx}`; `packages/core/src/i18n/messages/{nl-BE,fr-BE,en}/platform.json` (edit, after P3); `apps/web/scripts/{record-backup.ts, admin-reset-mfa.ts}`; `docs/runbooks/{restore.md, backup.md, rollback.md, rotate-keys.md, dead-jobs.md, failed-sync.md, access.md, add-role-permission.md, incident.md, security-controls.md, security-testing.md, support-sla.md, monthly-report.md, go-live.md, subprocessors.md}` (`subprocessors.md`: Neon, Vercel, Resend, Mollie, Billit, Google, Anthropic, plus the operational ones Sentry (EU), Better Stack, Slack, Scaleway and GitHub, each with role, location, data processed, transfer mechanism; HIBP receives only a 5-character hash prefix and is listed as not processing personal data); tests `apps/web/modules/platform/{admin-actions.test.ts, rekey.test.ts, queries.test.ts}`, `e2e/platform-admin.spec.ts`.
- **Interfaces:** actions and queries of 4.2/4.3 not yet built; `zodToFormFields(schema)` in `ui/zod-form.tsx`.
- **Depends on:** platform-P5, platform-P6, platform-P7; `crm:searchPersons` (person picker for flags and audit; crm Wave 1, used through `crm/api.ts`, the picker degrades to an id field while the stub throws).
- **Tests:** `admin-actions.test.ts`: last owner cannot be disabled or demoted (PL-16); non-owner cannot grant `persons.sensitive_read`; unknown permission rejected (PL-18); role change deletes sessions (PL-9); settings conflict (PL-41); AI sensitive on requires owner, purpose, DPIA reference and an approved `ai_sensitive_processing` DPIA (ops mocked to false → `conflict`) (PL-55); go-live complete only with 13 items (PL-77); retry and discard of dead jobs; webhook replay key (PL-40); incident reminder at 20 h (PL-73); incident transitions, including `contained → open` refused and `resolved → open` clearing `resolved_at` (PL-73a); `reportProblem` stores channel `in_app`, page URL and request id and enqueues one Slack job (PL-86); support transitions `open → responded` sets `first_response_at`, `closed → responded` refused (PL-87); `response_due_at` equals `slaDueAt` (PL-88); `recordPentest` sets next due +92 days and `security_confirmed` refuses a pentest older than 30 days or an open high incident (PL-85); `build_monthly_report` on fixtures (Better Stack fake 99.62 %, two breaches, one dead job) writes the expected `data`, a rerun upserts the same row, a `sent` month is skipped, a failing SLA call retries, `sendMonthlyReport` twice → second is `conflict` (PL-89). `rekey.test.ts`: rows on version 1 move to 2 in chunks, reads work mid-way (edge 19). `queries.test.ts`: audit search filters use keyset pagination. `e2e/platform-admin.spec.ts`: owner invites a reception user, changes its role, toggles a flag to testers, finds the audit rows; the reception user reports a problem from the user menu and the owner sees it on `/admin/system/support`; `expectAccessible` on every page visited.
- **Done:** typecheck, lint, Vitest green; e2e green on `beam_dev`; runbooks reviewed against architecture section 10 (restore steps, RPO/RTO numbers, backup retention).

### platform-P9: Partner scope and R3 integrations (R3)
- **Goal:** external partners sign in and see only their own company's data; the unified inbox and ads integrations get platform support.
- **Files:** `packages/db/src/schema/platform.ts` (frozen-file PR approved by the orchestrator: add `meta` to `webhook_events_provider` and `integration_calls_provider`); `apps/web/modules/platform/{api.ts, queries.ts, nav.ts}` (edit: `partnerScope`, partner landing redirect, integration status for `meta_ads`, `google_ads`, `meta`); `app/(admin)/admin/system/integrations/page.tsx` (edit: token status and "data as of"); tests `apps/web/modules/platform/partner-scope.test.ts`.
- **Interfaces:** `partnerScope(ctx): Promise<{ companyId: string }>`; `requirePartnerOrPermission(ctx, permission)` helper in `api.ts`.
- **Depends on:** platform-P8; `crm:companies`, `persons.partner_company_id`.
- **Tests:** partner user without `person_id` cannot exist; partner sees only own `companyId`; a partner calling a staff action that needs any other permission gets `forbidden`; `/admin` redirects a partner to `/admin/partner`.
- **Done:** typecheck, lint, Vitest green.

### platform-P10: AI read-only SQL and batches (R4)
- **Goal:** natural-language questions can run Claude-written SQL safely; the weekly summary uses the Batches API at half price.
- **Files:** `packages/db/src/sql/0100_ai_readonly.sql` (create role `beam_ai_ro` NOLOGIN, `grant beam_ai_ro to current_user`, schema `ai` with views `ai.persons_overview`, `ai.bookings_daily`, `ai.revenue_daily`, `ai.campaign_stats`, `ai.retention_lists` built only from non-sensitive views, `grant usage on schema ai` and `select` on those views only; orchestrator places it as a custom migration); `apps/web/modules/platform/{api.ts, ai-sql.ts, ai-sql.test.ts}`; `packages/integrations/src/anthropic/{client.ts, fake.ts}` (edit: `createBatch`, `getBatch`, `getBatchResults`); `app/(admin)/admin/system/ai/page.tsx` (edit: daily charts, SQL log).
- **Interfaces:** `runAiReadOnlyQuery(ctx, sql)`: rejects anything but a single `SELECT`/`WITH` statement (parser check: no `;` outside literals, no `pg_`, `set`, `copy`, `call`), then runs `begin read only; set local role beam_ai_ro; set local search_path = ai; set local statement_timeout = '5s'`, caps 1,000 rows, logs the SQL in `ai_requests.prompt`.
- **Depends on:** platform-P8; `ops:` views `v_person_profile`, `v_revenue_daily`, `v_retention_candidates` (as the source of the `ai` views).
- **Tests:** a `delete` or `update` statement is rejected before execution; selecting `person_sensitive_fields` fails with permission denied; a query over a cross join of two `generate_series(1, 100000)` is cut at 5 s; batch fake returns results in random order keyed by `custom_id`.
- **Done:** typecheck, lint, Vitest green; `createTestDb({ from: 'migrations' })` applies `0100_ai_readonly.sql`.

### platform-P11: Handbook, training material, load tests and exit export (V1, week-5 sprint after Waves 1 and 2, done by week 6)
- **Goal:** the platform does not live only in Sidestream's heads (blueprint 80), BEAM's team gets training material before the week-7 sessions (blueprint 79), the proposal's load tests run, and the exit export exists (blueprint 70, proposal section 10).
- **Files:** `docs/handbook/{README.md, architecture.md, database.md, integrations.md, roles.md, business-rules.md, automations.md, ai-connections.md, hosting.md, backup.md, support.md, deployment.md, core-workflows.md, ownership-and-exit.md}`; `docs/handbook/training/{README.md, daily-use.md, administration.md, reporting.md, campaigns.md, customer-management.md, booking.md, troubleshooting.md, ai-tools.md, privacy-security.md}`; `apps/web/scripts/{exit-export.ts, exit-export.test.ts, load-test.ts, training-screenshots.ts, handbook-links.test.ts}`; `apps/web/scripts/load/{scenarios.ts, report.ts}`; `docs/handbook/load-test-results.md` (written by `report.ts`); `docs/handbook/training/img/*.png`. It reads the module specs and merged code; it edits no code outside `apps/web/scripts/`.
- **Blueprint 80 coverage** (one page each; `README.md` is the index George starts from):

| Blueprint 80 topic | Handbook page and content |
| --- | --- |
| Architecture | `architecture.md`: modules, request and job model, tick, outbox, diagrams of the three route groups |
| Database, data model | `database.md` (Neon project, branches, pooled vs direct URLs, migrations, PITR) and the generated `data-model.generated.md` (PL-91) |
| Integrations | `integrations.md`: each provider, client file, job kinds, webhooks, failure handling, credentials by env name |
| User roles | `roles.md`: the nine roles, default permissions, how to change them, sensitive access |
| Business rules | `business-rules.md`: booking and cancellation rules, credits, pricing, VAT, waitlist, consent, with the rule ids of each module spec |
| Automations | `automations.md`: engine, groups, seeded sequences, late-entry and exit rules, how to pause |
| AI connections | `ai-connections.md`: the `AI_FEATURES` register (blueprint 61 fields), no-training position, budget, sensitive switch |
| Hosting | `hosting.md`: blueprint 71 items: providers, region `fra1` / `aws-eu-central-1`, BEAM account ownership, monthly cost model, scaling (Neon 0.25–2 CU, Vercel Fluid), backup, monitoring, security, who pays, exit procedure |
| Backup | `backup.md`: blueprint 67 items (PL-78), links to the restore runbook |
| Support | `support.md`: severities, response targets, channels, emergency number, monthly report (PL-86 to PL-89) |
| Deployment | `deployment.md`: environments, release flow PL-76a, flags, rollback |
| Core workflows | `core-workflows.md`: sign-up to booking, purchase to invoice to Billit, form to person to automation to email, unsubscribe, deletion, each as a numbered sequence with the tables touched |

- **Training (blueprint 79):** one guide per topic of blueprint 79, task-based ("How do I…") with screenshots captured from the demo seed by `apps/web/scripts/training-screenshots.ts` (Playwright, Dutch UI), written in English with the Dutch screen labels as the staff see them. `training/README.md` maps each guide to the BEAM roles of section 7 (reception: daily use, booking; customer_service: customer management, booking; marketing: campaigns, AI tools; management and finance: reporting; owner and technical_admin: administration, troubleshooting, privacy-security). The people named in blueprint 79 (Jonathan, Tinne, George, Tet) follow the guides of the role they hold; George also covers administration, troubleshooting, privacy-security and the whole handbook as BEAM's technical point of reference.
- **Load tests (proposal section 5):** `pnpm test:load` (`load-test.ts`, `autocannon`) against staging with the demo seed: (1) 100 concurrent visitors on `/nl/account/book` and the availability query for 60 s, p95 below 800 ms and no 5xx; (2) 50 concurrent `requestMagicLink` calls from distinct addresses, all `email.send` jobs succeeded within 2 minutes; (3) 5,000 queued `email.send` jobs drained by the tick within 15 minutes; (4) a 20,000-recipient campaign plan and send on the fake Resend adapter finishes within 15 minutes. `report.ts` writes the results to `docs/handbook/load-test-results.md`. A failed threshold is a `high` support request.
- **Exit export (PL-92):** `exit-export.ts` with `exit-export.test.ts` on PGlite (every table of the schema index appears as a CSV with a header row; sensitive columns stay encrypted; the archive is encrypted with the given `age` public key).
- **Depends on:** platform-P8; every V1 module merged (Waves 1 and 2); `booking:getAvailability`, `email:campaign send` for the load scenarios.
- **Done:** every page of both tables exists and `handbook-links.test.ts` (every relative markdown link and anchor in `docs/handbook/` resolves) is green; `pnpm test:load` thresholds met on staging and the results page committed; `exit-export.test.ts` green; George has walked through `README.md` in the week-6 session.

## 13. Decisions made

**Additions to the architecture**
1. Wave 0 is split into seven coding packages (P1 to P7) plus an orchestrator step W0-0 that writes every `package.json` and installs every dependency, because packages may not touch `package.json` or the lockfile. Critical path: P1 → P2 → P5 → P6; P2, P3, P4 run in parallel, then P6 and P7.
2. New table `rate_limits` (application rate limits, magic-link limit of 5 per hour) and new table `security_incidents` (blueprint 65 incident register).
3. New columns: `users.image` (Auth.js adapter), `users.password_changed_at`, `users.secret_key_version`, `users.created_by_user_id`; `auth_sessions.id`, `absolute_expires_at`, `mfa_at`, `last_seen_at`, `ip`, `user_agent`, `created_at`; `roles.description`, `roles.seeded_permissions`; `jobs.request_id`; `integration_calls.ok`; `ai_requests.cache_read_tokens`, `error`, `job_id`, `duration_ms`; `files.created_by_user_id`; `feature_flags.description`; `webhook_events.created_at`.
4. New enums: `integration_calls_provider` (adds `betterstack`, `stripe`, `viva` next to the architecture's providers), `security_incidents_severity`, `security_incidents_status`. R3 adds `meta` to both provider enums.
5. New views: `v_job_stats`, `v_integration_health`, `v_ai_usage_month`.
6. New per-module file `apps/web/modules/<m>/config.ts` that declares settings keys (Zod schema and default) and feature flags; new generated registries `settings`, `flags`, `webhooks` and `seeds` next to the architecture's ones.
7. New settings keys `company`, `go_live_gate`, `security`. `payment_provider_by_channel` belongs to commerce.
8. New job kinds and schedules: `platform.check_alerts` (every 5 minutes), `platform.prune_ephemeral` (hourly at :17), no new inline job. New events `platform.account_created`, `platform.signed_in`, `platform.password_set`.
9. The breached-password check runs in the browser (k-anonymity range API, 1.5 s timeout, fails open), so the architecture's three synchronous exceptions stay three and no request calls an external service. Bypassing it only weakens the bypasser's own password, and the server still enforces length and zxcvbn. Only the 5-character SHA-1 prefix leaves the browser.
10. New platform `api.ts` functions: `isGoLiveGateComplete`, `getPlatformDigest`, `getCustomerAccount`, `reassignCustomerAccount`, `syncCustomerAccountEmail`, `listStaffForAssignment`, `partnerScope` (R3), `runAiReadOnlyQuery` (R4). New crm stub `setPersonTester`.
11. The privacy registration shape gains an optional `sweep` map, so ops' retention sweep can call each module's deletes without knowing its tables.
12. The go-live gate (blueprint 77) is a setting with 13 confirmable items and a System screen. Ops refuses non-dry-run imports in production until the gate is complete.

**Resolutions where inputs differed or were silent**
13. `audit_log` lives in `platform.ts` (architecture section 2), not `crm.ts` (the Wave 0 list of section 11).
14. `readSensitive()`, `encryptSensitive()` and `decryptSensitive()` live in `apps/web/lib/sensitive.ts` and use `node:crypto`. `packages/core` may not import Node or the database, so it holds only `SENSITIVE_FIELD_KEYS` and types.
15. TOTP secrets and recovery codes use the same AES-256-GCM keyring as sensitive fields, with their own AAD. Recovery codes are stored as sha256 hashes inside that encrypted blob.
16. Roles keep the nine-value enum. Custom roles are not part of V1; each role's permissions are editable, which meets "permissions should be configurable". The owner holds `'*'` (all current and future permissions). Later deploys add permissions to roles only through `seeded_permissions`, so an owner's removal holds.
17. All System screens, including audit search, use `system.jobs`; no new permission was added. Management therefore does not see the audit search, and owner and technical_admin do.
18. `proxy.ts` sets the per-request CSP nonce, redirects locales and checks only that a session cookie exists. Session validation happens in layouts (`requireStaff`, `requireCustomer`) and in `action()`. Static security headers live in `next.config.ts`.
19. Auth.js keeps session tokens as it stores them (the adapter needs the raw value). Database access already equals full compromise, so hashing them would add nothing.
20. `lower(email)` is unique across both audiences, as the architecture says. Staff use their work address for the back-office and a different address for a customer account.
21. Sign-in screens live in the separate route groups `(admin-auth)` and `(portal-auth)`, so the authenticated layouts never wrap them.
22. The magic link opens a confirmation page with a button, so link-prefetching mail scanners cannot use up the token.
23. Customer passwords need 10 characters and a zxcvbn score of 2; staff passwords need 12 characters and a score of 3. Argon2id uses `@node-rs/argon2` (prebuilt binaries on Vercel) with the OWASP parameters; strength uses `@zxcvbn-ts` with the nl-BE and fr dictionaries.
24. Application rate limits run in Postgres (`rate_limits`). The Vercel WAF rules of the architecture stay as an outer layer, configured in the Vercel dashboard and documented in `docs/runbooks/security-controls.md`.
25. Schedule keys use Brussels wall-clock time. Daily and hourly schedules catch up 60 minutes; minute-level ones do not. Slots in the spring DST gap fire at 03:00; the repeated autumn hour runs once.
26. `jobs_status = failed` is reserved and never written. Retrying a dead job sets `max_attempts = attempts + 3`. "Discard" deletes a dead job and records an audit row.
27. The webhook job id is generated before the `webhook_events` insert, so `job_id` is set in the insert itself and the append-only rule holds.
28. Webhook signature failures are recorded as `integration_calls` rows with operation `webhook.signature_failed`, which is what the alert counts.
29. `webhook.process` dispatches to handlers that modules declare with `defineWebhookHandler` in their `jobs.ts`; the routes themselves belong to commerce, email and crm.
30. Integration call rows are written after the job transaction ends (commit or rollback), so failed calls are never lost with a rolled-back attempt.
31. File access follows a fixed matrix per kind (PL-46). Signed links use an HMAC key derived from `AUTH_SECRET` and last at most 7 days. Only images can be public, and SVG is never accepted.
32. `AI_FEATURES` is one central register in `packages/core/src/ai/features.ts`, keyed by the architecture's AI job kinds. It holds the ten documentation fields of blueprint 61. Prices sit in `settings.ai.pricing`: Opus 5.5 400/2000 cents and Haiku 5.5 10/50 cents per million input/output tokens. Batches (R4) are billed at half price.
33. `ai_requests.cost_cents` is `numeric(12,4)`, the one exception to integer cents, because a single Haiku call costs a fraction of a cent.
34. A Claude refusal is a permanent error. Invalid structured output is retried once. 80 % of the monthly AI budget triggers one Slack line per month.
35. The health endpoint also fails (503) in production on bad configuration: a missing current encryption key, `EMAIL_SINK` set, or a Mollie test key. The tick-age check applies only in staging and production, where the cron runs.
36. The backup and restore-drill workflows record their result in `settings.security` through `apps/web/scripts/record-backup.ts`, so `/admin/system/security` shows them.
37. Seed split: `packages/db/src/seed/<m>.ts` holds the `defaults` profile (roles, settings, groups, policies), run on every deploy; `apps/web/modules/<m>/seed.ts` holds the `demo` profile, which may use module logic. Demo staff are `<role>@demo.beam.be`, with password and TOTP secret from `DEMO_STAFF_PASSWORD` and `DEMO_TOTP_SECRET`, so Playwright can sign in.
38. Erasure deletes `webhook_events` rows whose payload contains the subject's email; all other platform logs hold only ids. Audit rows about the person are kept with values reduced to digests.
39. Permission descriptions live in each module's catalogue (`<module>.permissions.<action>`), so P7 and Wave 1 agents never edit the platform catalogue.
40. Failed customer logins are not audited (volume). Staff sign-ins are audited but are not timeline events, because staff are not persons.
41. A missing message shows the `⟦key⟧` marker on the public site too. Publishing checks and CI make it rare, and no other language is ever shown.
42. Integrations use fakes when `INTEGRATIONS=fake` (tests, demo, e2e) and real clients otherwise.
43. Release 2 needs no platform package. The YouTube `frame-src`, the `i.ytimg.com` image source and the heartbeat rate limit ship in V1.
44. R4's read-only SQL runs on the normal pooled connection inside `begin read only; set local role beam_ai_ro; set local statement_timeout = '5s'`. `SET LOCAL` is safe in PgBouncer's transaction mode, so no extra connection string or secret is needed.
45. External partners are staff-audience users with role `external_partner` and MFA, linked to a person whose `partner_company_id` sets their scope.
46. Session idle expiry and `last_seen_at` are written at most once per 5 minutes, to keep each request from writing to the database.

**Added in review**
47. Wave 0 ships a working minimum of `email.sendTransactional` and the `email.send` job (written by platform-P7 for the email module, with a `sendEmail`-only Resend client by P3), because architecture section 11 item 4 promises "sendTransactional job, one working template" and the night-one definition of done needs a magic link in the sink. Email replaces both in Wave 1 behind the same signatures.
48. Platform's transactional templates live in `packages/email/src/templates/platform/` (architecture section 1: the folder belongs to the module), with keys `platform.<snake>` and slugs `platform/<kebab>` (email's slug rule). Two templates were added: `mfa-changed` (security notice on password, MFA or recovery-code changes) and `monthly-report`. Wave 0 uses email's file names `layout/BaseLayout.tsx` and `render-email.ts`.
49. Monitoring of blueprint 72 is split by owner (table in PL-75a): platform owns downtime, database, API and integration signals and the alert mechanism; automation, email, commerce, credits and finance own their domain checks and alert through `notifySlack()`. Platform adds the Mollie-silence alert of architecture section 10 to `platform.check_alerts`, reading only a count from commerce's `orders` contract table.
50. `notifySlack()` is the only way to alert, and it owns the key format `slack:<fingerprint>:<YYYY-MM-DDTHH>`. Modules pass a fingerprint; they never enqueue `notify.slack` with their own key.
51. `defineJob` gains an optional `onDead` hook (PL-29a), run once in its own transaction after the dead status commits; automation needs it to record a failed step and advance.
52. `setSetting(ctx, key, value, expectedVersion)` is exported from platform's `api.ts` for modules with their own settings forms (finance, site); it applies PL-41 exactly as the `updateSetting` action does.
53. `readSensitive` takes crm's purposes (`care`, `customer_request`, `privacy_export`) and an optional `scope`, and also returns sensitive timeline notes, so the three storage places of architecture section 4 are read through one audited function.
54. New tables `support_requests` and `monthly_reports` and view `v_support_sla` carry the support register and the monthly report that proposal section 7 promises (uptime, incidents, requests handled, response times). They go into `platform.ts` in Wave 0 because the file is frozen afterwards; the screens follow in platform-P8. Support hours exclude Belgian public holidays, computed in `packages/core/src/platform/holidays.ts`.
55. Uptime comes from Better Stack's SLA API (new env vars `BETTERSTACK_API_TOKEN`, `BETTERSTACK_MONITOR_ID`); when that API is unavailable, the owner enters the figure by hand and the report says so.
56. The blueprint-64 safeguards are listed one by one with implementation and proof (PL-83). Renovate, `pnpm audit --audit-level high --prod` and gitleaks run in CI (PL-84). The ethical-hacking test is formalised as OWASP ASVS level 2 scope, before go-live and quarterly, recorded in `settings.security`, and gates the `security_confirmed` go-live item (PL-85).
57. The release flow is PR → preview → `staging` → `main`, enforced in `deploy.yml`, with flags in `testers` state before general release (PL-76a, blueprint 78, proposal section 3).
58. Backup frequency, retention, location, procedure, responsibility and recovery time are written out per blueprint 67 (PL-78); Sidestream's on-call founder executes a restore and BEAM's owner approves any restore that discards data.
59. Accessibility is a platform requirement: WCAG 2.1 AA, enforced by `@axe-core/playwright` in every e2e spec through `expectAccessible()` and by unit tests on the UI kit (PL-90). The accessibility statement page is site content.
60. The reception role gets a 4-hour idle timeout for the shared front-desk device (`settings.security.staff_idle_hours_by_role`); other staff keep 12 hours.
61. The CSP is built per request by `buildCsp()` in `apps/web/lib/csp.ts` and covers the YouTube player (webinar), GA4 and Vercel Analytics after cookie consent (site), Sentry and Mollie, with `frame-ancestors *` only for forms' embeddable pages. Third-party scripts load with the nonce. The webinar heartbeat and state routes are exempt from the per-IP rate limit.
62. `next.config.ts` (frozen after Wave 0) already contains the Serwist wrapper, disabled until site adds `app/sw.ts`, so site's PWA work needs no frozen-file change.
63. From Wave 1 the site module owns `app/[locale]/(portal)/account/layout.tsx` and the portal home; platform-P6 writes only the first version of the layout.
64. Documentation (blueprint 80) and training material (blueprint 79) are a separate package, platform-P11, run as a week-5 sprint package after the overnight waves, because they must describe merged modules. The data model page is generated from the Drizzle schema by `pnpm docs:schema` and checked on `main`.
65. The exit export (`pnpm exit:export`: `pg_dump` plus one CSV per table, `age`-encrypted) and `ownership-and-exit.md` (every account, its BEAM owner and the handover steps) cover blueprints 68 to 71 and proposal section 10 on the platform side; the contractual parts stay in the agreement.
66. Load tests (proposal section 5) are four scripted `autocannon` and job-drain scenarios with fixed thresholds, run on staging in platform-P11; `autocannon`, `@axe-core/playwright` and `@testing-library/user-event` join the W0-0 install list.
67. Public images are served with a one-year immutable cache, because file rows never change.
68. Names other specs used for platform functions (`aiComplete`, `aiGenerate`, `createFile`, `listActiveStaffByRole`, `integrationCallLogger`) map to `callClaude`, `storeFile`, `listStaffForAssignment` and `ctx.integrationLog`; Wave 0 adds no aliases.
