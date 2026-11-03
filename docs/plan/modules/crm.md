# Module `crm`: Customer core

Owner of identity, consent, suppressions, the timeline, tags, segments, tasks, companies, the B2B pipeline and the unified inbox. Blueprint sections 3, 4, 5, 6, 24, 25, 29, 35, 36, 37, 54, 59, 60 are primary; requirements from 16, 17, 19, 21, 30, 53, 55, 56, 62 and 63 also land here. This spec follows `docs/plan/00-decisions.md` and `docs/plan/01-architecture.md`. Every addition to the architecture is listed in section 13.

## 1. Purpose and release mapping

`crm` is the one place a person exists. Every other module refers to `persons.id`, writes facts to `activity_events`, and asks this module whether a person may be contacted. Staff see the whole relationship with a customer on one screen (`/admin/persons/[id]`).

| Release | Weeks | What `crm` ships |
| --- | --- | --- |
| **V1** | 1–6 | `persons` with derived status and a manual override; acquisition origin captured once; locale; customer number and legacy external ids; search; duplicate detection (email variants, phone, name, legacy id) with a review queue; staff merge that keeps all history (`person_merges`); encrypted sensitive fields read only through `readSensitive()`; consent per purpose with wording version, source, method, lawful basis and withdrawal; `v_consent_current`; suppressions separate from contacts and immune to imports; one-click unsubscribe and the token-based preference centre; the `activity_events` catalogue and the customer 360 page; manual notes and logged interactions (sensitive notes encrypted); tags; dynamic and static segments with exclusions, the segment compiler and `SEGMENT_ALLOWED_FIELDS`, hourly refresh; tasks with owner, due date, priority, related person or company and overdue visibility; companies and company contacts with decision roles (one person can be both B2C customer and B2B contact); portal pages for personal details and communication preferences; privacy registration of every crm table. |
| **Release 2** | 9–10 | No new crm tables. crm supplies what R2 modules need: `segment.entered` events for the B2C pipeline (ops), webinar event kinds already in the catalogue, `findLikelyDuplicates()` for waitlist duplicate flags (booking). |
| **Release 3** | 11–12 | B2B CRM pipeline: `opportunities`, the board at `/admin/pipeline` (value, probability, expected close, owner, next action, last contact, activity history), sales playbook stage definitions (`playbook_stages`: required action, owner, deadline, automated and human communication, escalation, KPI) for the B2B and B2C pipelines with automatic tasks and escalation. Unified inbox at `/admin/inbox`: inbound email and website contact forms linked to persons; Instagram and Messenger behind Meta app review and flag `ff_crm_inbox_meta`; reply templates; assignment, status and resolution tracking. |
| **Release 4** | 13–14 | AI-drafted inbox replies (`ai.draft_reply`, `claude-opus-5-5`) shown to staff who edit and approve before anything is sent; a deterministic sensitive-content screen blocks drafting. |
| **Later** (out of scope) | — | Automated B2B prospecting, enrichment and outbound cold email (blueprint 26, 27), voice AI and call transcription (28), predictive churn or lead scoring inside crm, Google Business messages and other channels beyond those listed, gamification and loyalty status (52), WhatsApp inbox. None of these get tables, routes or flags now. |

## 2. Domain model

All tables live in `packages/db/src/schema/crm.ts`; views in `packages/db/src/schema/crm.views.ts`. Conventions from architecture section 2 apply (uuid `id` with `gen_random_uuid()`, `created_at timestamptz not null default now()`, `updated_at` on mutable tables, enums named `<table>_<column>`). Wave 0 already created `persons`, `activity_events`, `consent_records` and `suppressions` with their architecture columns; this module adds columns to them in its own file (expand only) and creates the rest. **APPEND** = insert-only via the `reject_update_delete()` trigger (registered in `APPEND_ONLY_TABLES`). **SENSITIVE** = declared with `sensitive()` and listed in `SENSITIVE_COLUMNS`. Shared types in `packages/core/src/crm/types.ts`: `Locale = 'nl-BE'|'fr-BE'|'en'`, `LocalizedText`, `PostalAddress = { street?: string; number?: string; box?: string; postal_code?: string; city?: string; country: string /* ISO 3166-1 alpha-2, default 'BE' */ }`, `Actor` (architecture section 3).

### 2.1 `persons`

| Column | Type | Null | Default / check |
| --- | --- | --- | --- |
| id | uuid | no | `gen_random_uuid()` |
| customer_number | bigint generated always as identity | no | unique; shown as `C-000123` (ADD) |
| email | text | yes | stored trimmed and lower-cased; check `email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'` |
| email_hash | text | yes | sha256 hex of `email`, set by `emailHash()` in code whenever email changes (ADD) |
| phone | text | yes | as entered |
| phone_e164 | text | yes | `normalisePhone(phone, 'BE')`; check `~ '^\+[1-9][0-9]{6,14}$'` (ADD) |
| first_name, last_name | text | yes | check `char_length <= 100` |
| locale | `locale` enum (`nl-BE|fr-BE|en`, from `_shared.ts`) | no | `'nl-BE'` |
| address | jsonb `PostalAddress` | yes | |
| birth_on | date | yes | check `birth_on > '1900-01-01'`; Zod also rejects future dates |
| preferred_channel | `persons_preferred_channel` (`email|phone|whatsapp`) | yes | |
| linkedin_url | text | yes | B2B contact field (ADD) |
| status_override | `persons_status_override` (`lead|customer|member`) | yes | |
| status_override_reason | text | yes | check `status_override is null or status_override_reason is not null` |
| status_override_by_user_id | uuid → users.id | yes | |
| status_override_at | timestamptz | yes | (ADD) |
| acquisition | jsonb `Acquisition` | no | `'{}'`; written once (rule 3.4) |
| partner_company_id | uuid → companies.id on delete set null | yes | |
| external_ids | jsonb `Record<'simplybook'|'mailchimp'|'lightspeed'|'webinargeek'|'typeform'|'scoreapp'|'billit'|'sheet', string>` | no | `'{}'` (ADD) |
| is_tester | boolean | no | false |
| processing_restricted_at | timestamptz | yes | GDPR art. 18 restriction (ADD) |
| merged_into_person_id | uuid → persons.id | yes | check `merged_into_person_id <> id` |
| erased_at | timestamptz | yes | |
| search_tsv | tsvector generated always as `to_tsvector('simple', coalesce(first_name,'') || ' ' || coalesce(last_name,'') || ' ' || coalesce(email,'') || ' ' || coalesce(phone_e164,''))` stored | no | (ADD) |
| version | integer | no | 1; optimistic concurrency (ADD) |
| created_at, updated_at | timestamptz | no | `now()` |

`Acquisition` (Zod `AcquisitionSchema` in `packages/core/src/crm/acquisition.ts`): `{ source: AcquisitionSource; campaign?: string; medium?: string; funnel?: string; utm?: { source?, medium?, campaign?, term?, content? }; referrer_person_id?: uuid; partner_company_id?: uuid; event_session_id?: uuid; webinar_id?: uuid; form_slug?: string; captured_at: ISO string }`. `AcquisitionSource` = `website|landing_page|paid_meta|paid_google|paid_other|organic_search|social_media|webinar|event|referral|partner|customer_introduction|walk_in|qr_code|b2b_campaign|import|manual|other` (covers every origin in blueprint 3 and 16).

Indexes: `persons_email_active_uq` unique on `lower(email)` where `erased_at is null and merged_into_person_id is null`; `persons_email_idx` on `lower(email)` (all rows, so a merged loser's address still resolves); `persons_email_hash_idx`; `persons_phone_idx` on `phone_e164`; `persons_name_idx` on `(lower(last_name), lower(first_name))`; `persons_search_gin` GIN on `search_tsv`; `persons_external_ids_gin` GIN on `external_ids jsonb_path_ops`; `persons_merged_into_idx` on `merged_into_person_id` where not null; `persons_partner_company_idx`. Invariants: a merged or erased person is never updated except by the erasure handler; `acquisition` never changes once `acquisition.source` is set.

### 2.2 Identity history and sensitive data

**`person_merges`** APPEND: `winner_person_id uuid not null → persons`, `loser_person_id uuid not null unique → persons` (a person is merged once), `loser_snapshot jsonb not null` (the loser's `persons` row before the merge; never sensitive values), `field_choices jsonb not null default '{}'` (`{ column: 'winner'|'loser' }`, ADD), `repointed jsonb not null default '{}'` (`{ "<table>.<column>": rowCount }`, ADD), `merged_by_user_id uuid not null → users`, `created_at`. Check `winner_person_id <> loser_person_id`.

**`person_duplicate_candidates`** (ADD): `person_a_id uuid not null → persons`, `person_b_id uuid not null → persons` (check `person_a_id < person_b_id`), `score smallint not null check 0..100`, `reasons text[] not null` (values `email_variant|phone|name_birth|name_postal|external_id`), `status person_duplicate_candidates_status` (`open|merged|dismissed`) default `open`, `reviewed_by_user_id uuid`, `reviewed_at timestamptz`, `created_at`, `updated_at`. Unique `(person_a_id, person_b_id)`; index `(status, score desc)`.

**`person_sensitive_fields`**: `person_id uuid not null → persons on delete cascade`, `key person_sensitive_fields_key` (`health_note|sleep|stress|recovery|wellbeing|medical`), `value_enc bytea not null` **SENSITIVE** (AES-256-GCM, `SENSITIVE_DATA_KEY_V<n>`), `key_version smallint not null default 1`, `updated_by_user_id uuid → users` (ADD), `created_at`, `updated_at`. Unique `(person_id, key)`.

### 2.3 Consent and suppression

**`consent_records`** APPEND:

| Column | Type | Null | Default / check |
| --- | --- | --- | --- |
| person_id | uuid → persons | no | |
| purpose | `consent_records_purpose` (`newsletter|events|member_comms|b2b|assessment_result|sensitive_processing|ai_processing`) | no | |
| status | `consent_records_status` (`granted|withdrawn`) | no | |
| lawful_basis | `consent_records_lawful_basis` (`consent|legitimate_interest`) | no | `'consent'` (ADD) |
| source | text | no | `form:<slug>`, `portal`, `import:<import_id>`, `staff:<user_id>`, `preference_centre`, `unsubscribe_link`, `resend_complaint`, `merge:<merge_id>` |
| method | `consent_records_method` (`form|portal|import|staff|preference_centre|unsubscribe_link|complaint`) | no | |
| wording_version | text | no | `<purpose>@<version>` of `consent_wordings`, or `legacy-import`, `unsubscribe`, `complaint` |
| ip | inet | yes | |
| user_agent | text | yes | (ADD) |
| recorded_at | timestamptz | no | `now()`; imports pass the legacy opt-in time |
| actor | jsonb `Actor` | no | (ADD) |
| ref_type, ref_id | text | yes | e.g. `form_submission`, id (ADD) |
| copied_from_record_id | uuid → consent_records | yes | set when a merge copies a record (ADD) |

Index `(person_id, purpose, recorded_at desc, id desc)`. Booking, payment and membership processing rest on contract and are never consent rows.

**`consent_wordings`** IMMUTABLE (ADD): `purpose consent_records_purpose not null`, `version integer not null`, `text jsonb LocalizedText not null`, `published_at timestamptz`, `created_by_user_id uuid → users`, `created_at`. Unique `(purpose, version)`. A published row is never edited; `wording_version` strings point to `<purpose>@<version>`. Seeded with version 1 of every purpose in three locales.

**`suppressions`** APPEND: `email_hash text not null`, `email text` (nulled only by erasure), `scope suppressions_scope` (`all|newsletter|events|member_comms|b2b`), `reason suppressions_reason` (`unsubscribe|hard_bounce|complaint|manual|erased`), `source text not null`, `person_id uuid → persons on delete set null` (ADD, the person known at insert time), `actor jsonb not null` (ADD), `created_at`. Unique `(email_hash, scope)`; index `person_id`. Keyed by address, not by person, so a re-imported address is still suppressed.

### 2.4 Timeline

**`activity_events`** APPEND: `id bigint generated always as identity primary key`, `person_id uuid → persons`, `company_id uuid → companies`, check `person_id is not null or company_id is not null`, `kind text not null` check `kind ~ '^[a-z_]+\.[a-z_]+$'`, `occurred_at timestamptz not null default now()`, `mode activity_events_mode` (`live|replay|on_demand`, null when not applicable), `is_sensitive boolean not null default false`, `actor jsonb not null`, `ref_type text`, `ref_id text`, `data jsonb not null default '{}'`, `dedupe_key text unique`, `created_at`. Indexes: `(person_id, occurred_at desc, id desc)`; `(company_id, occurred_at desc, id desc) where company_id is not null`; `(kind, occurred_at desc)`; `(ref_type, ref_id)`. Invariant: when `is_sensitive` the row's `data` is exactly `{ body_enc: base64, key_version }` and **SENSITIVE**; `data` never contains email addresses, phone numbers or sensitive values otherwise. The event catalogue is in section 4.6.

### 2.5 Tags and segments

**`tags`**: `key text not null unique` check `~ '^[a-z0-9][a-z0-9_:-]{1,62}$'`, `name jsonb LocalizedText not null`, `color text not null default '#64748b'` check `~ '^#[0-9a-f]{6}$'`, `description text` (ADD), `is_system boolean not null default false` (ADD; system tags such as `vip` cannot be deleted), `created_at`, `updated_at`. Interests are tags with key prefix `interest:`.

**`person_tags`**: `person_id → persons on delete cascade`, `tag_id → tags on delete restrict`, `source person_tags_source` (`manual|automation|import|form`), `added_by jsonb Actor not null` (ADD), `created_at`. Unique `(person_id, tag_id)`; index `tag_id`.

**`segments`**: `name text not null`, `description text` (ADD), `kind segments_kind` (`dynamic|static`), `definition jsonb not null default '{"op":"and","rules":[]}'` (`SegmentRule`, section 4.5), `exclude_segment_ids uuid[] not null default '{}'`, `is_archived boolean not null default false` (ADD), `refresh_error text` (ADD), `last_count integer`, `last_counted_at timestamptz`, `created_by_user_id uuid → users`, `created_at`, `updated_at`. Check `not (id = any(exclude_segment_ids))`.

**`segment_members`**: primary key `(segment_id, person_id)`, `segment_id → segments on delete cascade`, `person_id → persons on delete cascade`, `source segment_members_source` (`rule|manual`), `computed_at timestamptz not null default now()`. Index `person_id`. Stores the raw set (rule result for dynamic, the manual list for static); exclusions apply at read time.

### 2.6 Tasks

**`tasks`**: `owner_user_id uuid not null → users`, `person_id uuid → persons`, `company_id uuid → companies`, `opportunity_id uuid → opportunities` (added in R3 by crm-P7), `title text not null` check length 1..200, `kind tasks_kind` (`call|follow_up|payment|proposal|review|other`), `due_at timestamptz`, `priority tasks_priority` (`low|normal|high`) default `normal`, `status tasks_status` (`open|done|cancelled`) default `open`, `source tasks_source` (`manual|automation|retention|system`) default `manual`, `ref_type text`, `ref_id text`, `notes text`, `done_at timestamptz`, `done_by_user_id uuid → users` (ADD), `created_by jsonb Actor not null` (ADD), `dedupe_key text unique` (ADD; e.g. `automation:<enrolment_id>:<step_key>`), `created_at`, `updated_at`. Check `(status = 'done') = (done_at is not null)`. Indexes `(owner_user_id, status, due_at)`, `person_id`, `company_id`, `(due_at) where status = 'open'`.

### 2.7 Companies

**`companies`**: `name text not null`, `vat_number text` (normalised `BE0123456789`, check `~ '^[A-Z]{2}[0-9A-Z]{2,12}$'`), `address jsonb PostalAddress`, `website text`, `industry text`, `size companies_size` (`1_9|10_49|50_249|250_plus`), `status companies_status` (`target|prospect|customer|partner|inactive`) default `target`, `owner_user_id uuid → users`, `notes text`, `is_partner boolean not null default false`, `partner_commission_pct numeric(5,2)` check 0..100, `created_at`, `updated_at`. Unique partial on `vat_number` where not null; index `lower(name)`.

**`company_contacts`**: `company_id → companies on delete cascade`, `person_id → persons on delete restrict`, `position text`, `decision_role company_contacts_decision_role` (`decision_maker|influencer|user|gatekeeper`), `relationship text`, `is_primary boolean not null default false` (ADD), `ended_on date` (ADD; contact left the company, history kept), `created_at`, `updated_at`. Unique `(company_id, person_id)`; partial unique `(company_id) where is_primary and ended_on is null`. A person is a B2C customer through their own bookings and orders and a B2B contact through this table; one `persons` row serves both.

### 2.8 Release 3 tables

**`opportunities`** (R3): `company_id uuid not null → companies`, `title text not null` (ADD), `primary_contact_person_id uuid → persons`, `stage opportunities_stage` (`target|prospect_identified|contact_identified|outreach|response|qualified|discovery|proposal|negotiation|won|lost|account_management|renewal`), `stage_entered_at timestamptz not null default now()` (ADD), `value_cents integer not null default 0` check ≥ 0, `probability_pct smallint not null default 10` check 0..100, `expected_close_on date`, `owner_user_id uuid not null → users`, `next_action text`, `next_action_at timestamptz`, `lost_reason text` (check `stage <> 'lost' or lost_reason is not null`), `won_at`, `lost_at` (ADD), `source text` (ADD), `notes text`, `version integer not null default 1`, `created_at`, `updated_at`. Indexes `stage`, `owner_user_id`, `company_id`.

**`playbook_stages`** (R3, ADD): `pipeline playbook_stages_pipeline` (`b2b|b2c`), `stage_key text not null` (an `opportunities_stage` value for `b2b`, an ops `person_stats.b2c_stage` value for `b2c`), `sort_order smallint not null`, `name jsonb LocalizedText not null`, `required_action jsonb LocalizedText not null`, `owner_role text not null` (a `roles.key`), `deadline_days smallint not null default 3` check 0..365, `default_probability_pct smallint` (b2b only), `automated_communication jsonb not null default '{}'` (`{ automation_slug?: string; template_slug?: string }`), `human_communication jsonb LocalizedText`, `escalation jsonb not null default '{}'` (`{ after_days?: number; notify_role?: string; create_task?: boolean }`), `kpi jsonb not null default '{}'` (`{ name?: LocalizedText; target?: number; unit?: 'count'|'pct'|'cents'|'days' }`), `is_active boolean not null default true`, `updated_by_user_id uuid → users`, `created_at`, `updated_at`. Unique `(pipeline, stage_key)`.

**`inbox_threads`** (R3): `channel inbox_threads_channel` (`email|instagram|messenger|form`), `external_thread_id text`, `person_id uuid → persons`, `company_id uuid → companies` (ADD), `from_address text` (email address or Meta sender id, ADD), `from_name text` (ADD), `status inbox_threads_status` (`open|pending|resolved`) default `open`, `assignee_user_id uuid → users`, `subject text`, `last_message_at timestamptz not null` (ADD), `first_response_at`, `resolved_at` (ADD), `is_sensitive boolean not null default false` (ADD; blocks AI), `created_at`, `updated_at`. Partial unique `(channel, external_thread_id) where external_thread_id is not null`; index `(status, last_message_at desc)`, `person_id`, `assignee_user_id`.

**`inbox_messages`** (R3): `thread_id → inbox_threads on delete cascade`, `direction inbox_messages_direction` (`in|out|note`; `note` is ADD for internal notes), `body text not null` (plain text, max 50,000 chars), `external_message_id text unique`, `ai_draft text`, `ai_draft_status inbox_messages_ai_draft_status` (`none|pending|ready|blocked_sensitive|failed|used|discarded`) default `none` (R4, ADD), `ai_request_id uuid → ai_requests` (R4, ADD), `sent_by_user_id uuid → users`, `email_message_id uuid → email_messages` (ADD), `attachment_count smallint not null default 0` (ADD; attachments are not stored), `occurred_at timestamptz not null`, `created_at`.

**`inbox_reply_templates`** (R3, ADD): `key text unique not null`, `name jsonb LocalizedText not null`, `body jsonb LocalizedText not null`, `is_active boolean not null default true`, `created_at`, `updated_at`.

### 2.9 Views (`crm.views.ts`)

```sql
-- latest record per person and purpose
create view v_consent_current as
select distinct on (person_id, purpose) person_id, purpose, status, lawful_basis, method, source,
       wording_version, recorded_at,
       case when status = 'granted' then recorded_at end as granted_at,
       case when status = 'withdrawn' then recorded_at end as withdrawn_at
from consent_records order by person_id, purpose, recorded_at desc, created_at desc, id desc;

-- one row per person and marketing purpose
create view v_suppression_status as
select p.id as person_id, pr.purpose,
  (exists (select 1 from suppressions s where s.email_hash = p.email_hash and (
      s.scope = 'all'
      or (s.scope::text = pr.purpose and not (s.reason = 'unsubscribe' and exists (
            select 1 from v_consent_current c where c.person_id = p.id and c.purpose::text = pr.purpose
              and c.status = 'granted' and c.method in ('form','portal','preference_centre')
              and c.recorded_at > s.created_at)))))
    or p.erased_at is not null or p.email is null or p.processing_restricted_at is not null) as is_suppressed
from persons p cross join (values ('newsletter'),('events'),('member_comms'),('b2b')) pr(purpose)
where p.merged_into_person_id is null;

-- manual status that no longer matches the calculated status
create view v_status_override_conflicts as
select p.id as person_id, p.status_override, s.derived_status, p.status_override_at, p.status_override_by_user_id
from persons p join v_person_status s on s.person_id = p.id
where p.status_override is not null and p.status_override::text <> s.derived_status::text
  and p.erased_at is null and p.merged_into_person_id is null;

create view v_open_tasks as
select t.*, (t.due_at < now()) as is_overdue,
       (t.due_at >= date_trunc('day', now() at time zone 'Europe/Brussels') at time zone 'Europe/Brussels'
        and t.due_at < (date_trunc('day', now() at time zone 'Europe/Brussels') + interval '1 day') at time zone 'Europe/Brussels') as is_due_today
from tasks t where t.status = 'open';
```

R3 adds `v_opportunity_board`: every opportunity joined with `companies.name`, the owner's name, `last_contact_at = max(activity_events.occurred_at)` over events with that `company_id` or the primary contact's `person_id` and `kind in ('interaction.logged','email.sent','inbox.message_received','inbox.reply_sent','opportunity.stage_changed')`, `stage_deadline_at = stage_entered_at + playbook_stages.deadline_days`, and `is_stalled = now() > stage_deadline_at`.

### 2.10 Tables of other modules this module reads or writes

- Reads: `users` and `roles` (platform: owners, assignees), `v_person_status` (credits; required columns `person_id, derived_status, status_override, status, has_active_membership`), `v_person_profile` (ops; the segment compiler's only target), `person_stats` (ops, 360 header), `email_messages` (email, inbox reply link), `ai_requests` (platform, R4 link), `automation_enrolments` (via automation api).
- Writes through other modules' api.ts only: `jobs` (platform `enqueue`), `audit_log` (platform `audit`), `email_messages` (email `sendTransactional`), `automation_enrolments` (automation `enrolPerson`, `exitPerson`).
- Writes directly as the documented cross-module operation: the person merge repoints `persons.id` foreign keys in every module's mutable tables, discovered from `information_schema`, inside the merge transaction (rule 3.30).

## 3. Business rules

Numbered `3.n`. Each one has at least one test named after it (`it('3.7 ...')`).

**Identity**
1. One person per active email address: `lower(email)` is unique among persons that are neither merged nor erased. Emails are trimmed and lower-cased before storage; an empty string is stored as null.
2. `findOrCreatePersonByEmail` takes `pg_advisory_xact_lock(hashtext(lower(email)))`, then returns the active person with that address; if none, it follows a merged person with that address to its winner; only then does it create. Two concurrent calls for one address create exactly one person.
3. On an existing person, `findOrCreatePersonByEmail` and imports only fill empty fields (`first_name`, `last_name`, `phone`, `address`, `birth_on`). They never overwrite a non-empty value, never change `locale`, never change `acquisition`, and never touch consent or suppressions.
4. `acquisition` is written once, in the creating transaction. Later writes are refused with `conflict`, except staff with `persons.write` may fill it when the stored `source` is missing; that fill is audited. The acquisition source never feeds status, queue position or event priority.
5. `locale` is set on creation from the explicit form or portal choice, else the URL locale, else `Accept-Language`, else `nl-BE`. Only the person (portal, preference centre) or staff change it afterwards; each change writes `person.locale_changed`.
6. `customer_number` is assigned by the database and never reused. Staff search accepts `C-000123`, `123`, an email, a phone number (any format, normalised) or a name prefix.
7. `phone_e164` is derived from `phone` on every write with default country `BE` (`0470 12 34 56` → `+32470123456`, `0032...` → `+32...`). An unparseable phone keeps `phone` and leaves `phone_e164` null.

**Commercial status**
8. Derived status is `member` with an active or past-due membership, else `customer` with at least one paid order containing a session, night, package, membership or ticket line, else `lead` (blueprint 3, 19). It comes from `v_person_status`; crm never stores it.
9. `status = coalesce(status_override, derived_status)`. Only `setStatusOverride` writes `status_override`; it requires a reason of 3–500 characters, writes `audit_log` action `person.status_override` with old and new value, and an activity event `person.status_overridden`.
10. A purchase, a membership or any job never clears or changes an override. An automation step `status_override` calls `setStatusOverride` only when no override exists; otherwise it logs `skipped_condition`.
11. When an override differs from the derived status, the person appears in `v_status_override_conflicts`; the 360 page shows a banner "Manual status *lead* differs from calculated *customer*" with buttons "Keep" (records `person.status_override_confirmed`, hides the banner until the derived status changes again) and "Clear override".
12. Member pricing and member-only booking use `has_active_membership` from `v_person_status`, never the override. Segments, lead-priority windows and status content blocks use `status`.

**Consent and suppression**
13. Consent is per purpose. `recordConsent` appends a row; nothing updates or deletes one outside erasure. `v_consent_current` is the latest row per `(person_id, purpose)` by `recorded_at`, then `created_at`, then `id`.
14. A grant with method `form`, `portal` or `preference_centre` requires a published `consent_wordings` version for that purpose and stores `<purpose>@<version>`. Imports may store `legacy-import`. Staff grants are allowed only for `b2b` with `lawful_basis = legitimate_interest`.
15. Delivering an assessment result never creates `newsletter` consent: only an explicitly ticked consent field of a form produces a grant, and only for the purpose that field declares.
16. Withdrawing a marketing purpose (`newsletter|events|member_comms|b2b`) appends `withdrawn`, inserts a suppression with that scope and reason `unsubscribe` (`on conflict do nothing`), enqueues `automation.exit_for_suppression` with key `supp:<suppression_id>` on lane `fast`, and records `consent.withdrawn` and `suppression.added`, all in one transaction. The action's `after()` kick runs the exit job, so running marketing sequences end within seconds (scenario 2).
17. "Unsubscribe from everything" writes `withdrawn` for every currently granted marketing purpose and a suppression with scope `all`.
18. Hard bounces and complaints (from the email module) insert scope `all` with reason `hard_bounce` or `complaint`; a complaint also withdraws every marketing purpose with method `complaint`.
19. A suppression is never deleted. A scope-specific `unsubscribe` suppression stops blocking only when the person later gives a fresh grant for that purpose through `form` (after the confirmation email of rule 3.21), `portal` or `preference_centre` that is newer than the suppression. Scope `all`, `hard_bounce`, `complaint`, `manual` and `erased` block forever for that address.
20. Imports never write suppressions except an import of kind `suppressions`, and an imported consent grant is skipped (reported as `skipped: suppressed_or_withdrawn`) when the address is suppressed for that scope or `all`, or the person has any `withdrawn` record for that purpose. "Suppression survives an import" is an acceptance test.
21. A form grant for a purpose blocked by an `unsubscribe` suppression is not recorded directly: crm sends `crm/confirm-resubscribe` with a preference-centre link, and the grant is recorded with method `preference_centre` when the person confirms.
22. Persons with `processing_restricted_at` set, no email, or `erased_at` set are suppressed for every marketing purpose in `v_suppression_status` and excluded from every segment.

**Sensitive data**
23. Sensitive values exist only in `person_sensitive_fields.value_enc`, in `activity_events` rows with `is_sensitive = true`, and (forms module) `form_sensitive_answers`. Plain values never appear in `data`, logs, Sentry, segments, exports for staff, or AI context.
24. Reading a sensitive value goes only through `readSensitive(ctx, personId, purpose, scope)`; it needs `persons.sensitive_read` (or the system actor with purpose `privacy_export`) and writes `audit_log` action `sensitive.read` with the keys or event ids read, never the values.
25. Writing a sensitive field needs `persons.sensitive_read`, writes `audit_log` action `sensitive.write` with `old_value`/`new_value` = `{ key, changed: true }` only, and an activity event `sensitive.updated` with `data = { key }`.
26. A staff note marked sensitive is stored as an `is_sensitive` event; the timeline shows "Sensitive note" with a Reveal button for holders of `persons.sensitive_read`; revealing calls `readSensitive` (purpose `care`).
27. `SEGMENT_ALLOWED_FIELDS` and `SEGMENT_ALLOWED_EVENT_KINDS` contain no `SENSITIVE_COLUMNS` member and no `is_sensitive` events (unit test).

**Duplicates and merge**
28. Duplicate candidates are scored by fixed rules: same legacy external id 95; same email after removing dots and `+tag` for gmail.com and googlemail.com addresses 90; same `phone_e164` 80; same lower-cased first and last name and same `birth_on` 70; same name and same postal code 50. Scores of several reasons do not add up; the highest counts. Pairs scoring 50 or more are stored as `open` candidates; a `dismissed` pair is never re-proposed.
29. Creating a person in the admin shows candidates scoring 50 or more before saving; staff confirm "create anyway". Every create and every change of email, phone, name or birth date enqueues `crm.check_duplicates`.
30. A merge needs `persons.merge`, two distinct persons that are neither erased nor merged, and an explicit winner. The merge runs in one transaction: lock both rows `FOR UPDATE` (lower id first); apply the field choices to the winner; repoint every foreign key column referencing `persons.id` in non-append tables from loser to winner; copy consent; set `merged_into_person_id = winner` on the loser and on every person already merged into the loser (chains stay one level deep); insert `person_merges`; write `audit_log` action `person.merge` and the event `person.merged` on both persons.
31. Merge refuses with `conflict`, listing the cause, when both persons hold an active or past-due membership, or both hold an active booking for the same session, or both are on the same waitlist. For tables with a unique key that includes the person (`person_tags`, `segment_members`, `company_contacts`, `person_sensitive_fields`, `webinar_registrations`, `campaign_recipients`), the winner's row is kept and the loser's row is deleted after being described in `repointed`.
32. Append-only tables (`activity_events`, `consent_records`, `credit_entries`, `automation_runs`, `audit_log`, `watch_segments`, `webinar_interactions`, `email_events`) are not rewritten. Reads resolve the merge: `resolvePersonIds(winnerId)` returns the winner plus every person whose `merged_into_person_id` is the winner (one level, because merges flatten), and the timeline, export and erasure use that list.
33. Consent on merge: for each purpose, the latest record across both persons wins; if it belongs to the loser, a copy is appended to the winner with the original `recorded_at`, `wording_version`, `method` and `source`, and `copied_from_record_id`. A withdrawal on either side newer than the other's grant therefore survives.
34. Merge keeps the oldest `acquisition` of the two (by `persons.created_at`), the winner's override (else the loser's), `is_tester` if either is a tester, and the union of `external_ids` (winner's value wins on a key clash).

**Timeline**
35. Every module writes timeline facts only through `recordEvent()` with a kind declared in a module's `events.ts`; an undeclared kind throws. `dedupe_key` makes a repeated fact a no-op.
36. Registered, started, attended and watched are distinct kinds (`webinar.registered`, `webinar.started`, `webinar.attended`, `webinar.watched`), and live, replay and on-demand activity carry `mode`; the timeline labels and filters on both.
37. The 360 timeline lists events of `resolvePersonIds(id)` newest first by `(occurred_at, id)`, 50 per page, with category filters; it renders every catalogue kind through its registered summary, and an unknown kind as its raw kind string.

**Segments**
38. The compiler accepts only fields in `SEGMENT_ALLOWED_FIELDS` with the operators allowed for their type, event rules only for kinds in `SEGMENT_ALLOWED_EVENT_KINDS`, at most 50 rules and depth 4; anything else is a `validation` error naming the rule path. Values are always bound parameters.
39. A dynamic segment's members are the rule result minus erased, merged and restricted persons. A static segment's members are its manual list minus the same. Members of every segment in `exclude_segment_ids` are removed at read time (`segmentAudienceSql`). A segment rule `in_segment` may reference other segments; cycles are refused on save.
40. `segments.refresh` runs hourly at minute 7 and refreshes each non-archived dynamic segment; saving a segment and planning a campaign refresh it on demand. A refresh writes `segment.entered` and `segment.left` events (dedupe `segment:<id>:<enter|leave>:<person_id>:<computed_at as YYYYMMDDHH>`), and updates `last_count` (after exclusions) and `last_counted_at`.
41. A failing refresh stores `refresh_error`, keeps the previous members, and shows the error on the segment page; the next refresh retries.

**Tasks**
42. A task needs an owner. Without `tasks.all` a user sees and edits only tasks they own and creates tasks only for themselves. Completing sets `done_at` and `done_by_user_id` and records `task.completed` on the related person or company.
43. A task is overdue when `status = 'open'` and `due_at < now()`. Overdue tasks are red in every list, counted in the admin navigation badge for the owner, and listed first in "My tasks".
44. A task with a `dedupe_key` is created at most once; automation passes `automation:<enrolment_id>:<step_key>`, retention passes `retention:<reason>:<person_id>:<ISO week>`.

**Companies and pipeline**
45. A company VAT number is normalised (spaces, dots removed, upper case) and unique. Linking a person to a company never changes their B2C status, consent or bookings.
46. (R3) Changing an opportunity's stage sets `stage_entered_at`, records `opportunity.stage_changed`, applies the stage's `default_probability_pct` unless staff changed the probability by hand on this stage, and creates one task for the opportunity owner titled from `required_action` due `deadline_days` later (dedupe `playbook:<opportunity_id>:<stage>:<stage_entered_at epoch>`); if the stage has an `automation_slug`, the primary contact is enrolled through automation's `enrolPerson`.
47. (R3) `won` sets `won_at` and probability 100; `lost` requires `lost_reason` and sets probability 0. Won and lost opportunities leave the open board columns.
48. (R3) An opportunity stalled beyond `escalation.after_days` in one stage creates one task for the first user with role `escalation.notify_role` and one Slack line (dedupe `escalate:<opportunity_id>:<stage>:<stage_entered_at epoch>`).

**Inbox**
49. (R3) An inbound message is linked to the active person whose email (or stored Meta sender id in `external_ids.meta_psid`) matches; otherwise the thread has no person until staff link or create one. Inbound messages never create persons or consent automatically.
50. (R3) A new inbound message on a `resolved` thread reopens it. A staff reply sets `first_response_at` once and moves `open` to `pending`. Replies to email threads go through email's `sendTransactional` with template `crm/inbox-reply`; Meta replies through the Meta Send API within its 24-hour window, else the reply button is disabled with the reason.
51. (R4) An AI draft is never sent by the system: staff edit and press Send, which records `ai_draft_status = used`. No draft is requested when the thread `is_sensitive` or the deterministic keyword screen (`SENSITIVE_KEYWORDS` per locale) matches, unless `settings.ai.sensitive_enabled` is true; the status becomes `blocked_sensitive`.

## 4. Server surface

Files: `apps/web/modules/crm/{actions,queries,api,jobs,schedules,events,permissions,nav,privacy,seed}.ts` are barrels or registries; the code lives in area folders `apps/web/modules/crm/<area>/{actions,queries,api,jobs}.ts` with areas `persons`, `tags`, `consent`, `duplicates`, `sensitive`, `timeline`, `segments`, `tasks`, `companies`, `pipeline` (R3), `inbox` (R3). Pure logic lives in `packages/core/src/crm/`. Every action uses `action({ name, audience, permission, input, audit }, handler)`; errors use the architecture's codes. "Audit" names the `audit_log.action` value (staff writes only, by the wrapper or `ctx.audit`).

### 4.1 Server actions (V1)

| Action (`name`) | Input (Zod summary) → output | Permission | Events | Audit |
| --- | --- | --- | --- | --- |
| `createPerson` (`crm.create_person`) | `{ email?, phone?, firstName?, lastName?, locale, address?, birthOn?, preferredChannel?, acquisition: { source, campaign?, medium?, funnel? }, companyId?, confirmDuplicates?: boolean }` (email or phone or last name required) → `{ personId }`; `conflict` with `{ candidates }` when score ≥ 50 and not confirmed | `persons.write` | `person.created` | `person.create` |
| `updatePerson` (`crm.update_person`) | `{ personId, version, patch: { email?, phone?, firstName?, lastName?, locale?, address?, birthOn?, preferredChannel?, linkedinUrl?, externalIds? } }` → `{ version }`; `conflict` on stale version or taken email | `persons.write` | `person.updated` (`data.fields` names only), `person.locale_changed` | `person.update` |
| `fillAcquisition` (`crm.fill_acquisition`) | `{ personId, acquisition }` → `{}`; `conflict` if source already set | `persons.write` | `person.acquisition_filled` | `person.acquisition` |
| `setStatusOverride` (`crm.set_status_override`) | `{ personId, status: 'lead'|'customer'|'member'|null, reason: string(3..500) }` → `{ status }` | `persons.write` | `person.status_overridden` or `person.status_override_cleared` | `person.status_override` |
| `confirmStatusOverride` (`crm.confirm_status_override`) | `{ personId }` → `{}` | `persons.write` | `person.status_override_confirmed` | `person.status_override` |
| `addNote` (`crm.add_note`) | `{ personId?, companyId?, body: string(1..10000), isSensitive: boolean }` → `{ eventId }`; sensitive needs `persons.sensitive_read` | `persons.write` | `note.added` (encrypted when sensitive) | `note.add` (no body) |
| `logInteraction` (`crm.log_interaction`) | `{ personId?, companyId?, channel: 'call'|'email'|'whatsapp'|'in_person'|'meeting'|'other', purpose: 'service'|'sales_follow_up'|'reactivation'|'b2b', summary: string(1..2000), occurredAt? }` → `{ eventId }` | `persons.write` | `interaction.logged` | `interaction.log` |
| `createTag` / `updateTag` / `deleteTag` (`crm.*_tag`) | `{ key, name: LocalizedText, color, description? }`; delete refuses `is_system` | `persons.write` | — | `tag.create|update|delete` |
| `tagPersons` / `untagPersons` (`crm.tag_persons`) | `{ tagId, personIds: uuid[1..5000] }` → `{ changed }` | `persons.write` | `tag.added` / `tag.removed` per person | `tag.assign` (counts) |
| `recordStaffConsent` (`crm.record_staff_consent`) | `{ personId, purpose, status }`; a grant only for `b2b` (legitimate interest) | `persons.write` | `consent.granted` / `consent.withdrawn`, `suppression.added` | `consent.change` |
| `addManualSuppression` (`crm.add_suppression`) | `{ email, scope, note: string(3..500) }` → `{ suppressionId }` | `persons.write` | `suppression.added` | `suppression.add` |
| `publishConsentWording` (`crm.publish_consent_wording`) | `{ purpose, text: LocalizedText }` → `{ version }`; `assertComplete` on all three locales | `settings.write` | — | `consent_wording.publish` |
| `dismissDuplicate` (`crm.dismiss_duplicate`) | `{ candidateId }` | `persons.merge` | — | `person.duplicate_dismiss` |
| `mergePersons` (`crm.merge_persons`) | `{ winnerId, loserId, winnerVersion, loserVersion, fieldChoices: Record<MergeField,'winner'|'loser'> }` → `{ mergeId, repointed }` | `persons.merge` | `person.merged` on both | `person.merge` |
| `setSensitiveField` (`crm.set_sensitive_field`) | `{ personId, key, value: string(1..5000) | null }` | `persons.sensitive_read` | `sensitive.updated` (`{ key }`) | `sensitive.write` |
| `revealSensitive` (`crm.reveal_sensitive`) | `{ personId, keys?: SensitiveKey[], eventIds?: string[] }` → `{ fields, notes }` via `readSensitive(ctx, personId, 'care', …)` | `persons.sensitive_read` | — | `sensitive.read` (by `readSensitive`) |
| `saveSegment` (`crm.save_segment`) | `{ id?, name, description?, kind, definition: SegmentRule, excludeSegmentIds: uuid[] }` → `{ id, count }`; compiles, refreshes inline when ≤ 20,000 persons else enqueues | `email.write` | — | `segment.save` |
| `archiveSegment` (`crm.archive_segment`) | `{ id }`; refuses when a scheduled campaign or active automation uses it (asks email and automation api) | `email.write` | — | `segment.archive` |
| `setStaticMembers` (`crm.set_static_members`) | `{ segmentId, add: uuid[], remove: uuid[] }` (≤ 5000 each) | `email.write` | — | `segment.members` (counts) |
| `refreshSegmentNow` (`crm.refresh_segment`) | `{ segmentId }` → `{ jobId }` | `email.write` | — | — |
| `createTask` / `updateTask` (`crm.save_task`) | `{ id?, title, kind, dueAt?, priority, ownerUserId, personId?, companyId?, notes? }` | `persons.read` (own), `tasks.all` (others) | `task.created` | `task.save` |
| `completeTask` / `cancelTask` (`crm.complete_task`) | `{ id }` | same | `task.completed` | `task.status` |
| `saveCompany` (`crm.save_company`) | `{ id?, name, vatNumber?, address?, website?, industry?, size?, status, ownerUserId?, notes?, isPartner, partnerCommissionPct? }` | `crm.b2b` | `company.created` / `company.updated` (company timeline) | `company.save` |
| `linkContact` (`crm.link_contact`) | `{ companyId, personId? , newPerson?: CreatePersonInput, position?, decisionRole?, relationship?, isPrimary }` | `crm.b2b` | `company.contact_linked` (person and company) | `company.contact_link` |
| `updateContact` / `endContact` (`crm.update_contact`) | `{ contactId, …, endedOn? }` | `crm.b2b` | `company.contact_unlinked` on end | `company.contact_update` |

Customer-audience actions (`audience: 'customer'`, filtered on `ctx.actor.personId`, no permission string):

| Action | Input → output | Events |
| --- | --- | --- |
| `updateMyProfile` (`crm.update_my_profile`) | `{ version, firstName, lastName, phone?, address?, birthOn?, locale, preferredChannel? }` (email is not editable in the portal) | `person.updated`, `person.locale_changed` |
| `updateMyPreferences` (`crm.update_my_preferences`) | `{ newsletter: boolean, events: boolean, member_comms: boolean, b2b: boolean }` → `{ changed: Purpose[] }` (method `portal`, current wording) | `consent.granted` / `consent.withdrawn`, `suppression.added` |

### 4.2 Server actions (R3, R4)

| Action | Input → output | Permission | Events | Audit |
| --- | --- | --- | --- | --- |
| `saveOpportunity` (`crm.save_opportunity`) | `{ id?, companyId, title, primaryContactPersonId?, valueCents, probabilityPct?, expectedCloseOn?, ownerUserId, nextAction?, nextActionAt?, notes?, source?, version? }` | `crm.b2b` | `opportunity.created` / `opportunity.updated` | `opportunity.save` |
| `moveOpportunityStage` (`crm.move_opportunity`) | `{ id, stage, version, lostReason? }` | `crm.b2b` | `opportunity.stage_changed`, `opportunity.won` / `opportunity.lost`, `task.created` | `opportunity.stage` |
| `savePlaybookStage` (`crm.save_playbook_stage`) | full `playbook_stages` row minus ids; `assertComplete` on LocalizedText fields | `settings.write` | — | `playbook.save` |
| `assignThread` / `setThreadStatus` (`crm.update_thread`) | `{ threadId, assigneeUserId? , status? }` | `persons.write` | — | `inbox.update` |
| `replyToThread` (`crm.reply_thread`) | `{ threadId, body: string(1..20000), templateKey?, usedAiDraftMessageId? }` → `{ messageId }` | `persons.write` | `inbox.reply_sent` | `inbox.reply` |
| `addThreadNote` (`crm.note_thread`) | `{ threadId, body }` | `persons.write` | — | `inbox.note` |
| `linkThreadPerson` (`crm.link_thread`) | `{ threadId, personId? , createFromSender?: { locale } }` | `persons.write` | `inbox.message_received` backfilled for linked messages | `inbox.link` |
| `markThreadSensitive` (`crm.mark_thread_sensitive`) | `{ threadId, isSensitive }` | `persons.write` | — | `inbox.sensitive` |
| `saveReplyTemplate` (`crm.save_reply_template`) | `{ id?, key, name, body: LocalizedText, isActive }` | `settings.write` | — | `inbox.template` |
| `requestAiDraft` (R4, `crm.request_ai_draft`) | `{ messageId }` → `{ jobId }` | `ai.use` | — | `ai.request` |
| `discardAiDraft` (R4, `crm.discard_ai_draft`) | `{ messageId }` | `persons.write` | — | — |

### 4.3 Queries (`queries.ts`)

`listPersons({ q?, status?, tagIds?, segmentId?, locale?, source?, isTester?, page, pageSize ≤ 100, sort: 'created_at'|'last_name'|'last_activity_at' })`; `searchPersons(q, limit = 10)` (command palette: customer number, email, `phone_e164`, then `search_tsv @@ to_tsquery('simple', prefix:*)`); `getPerson360(personId)` (follows `merged_into_person_id` and redirects); `getTimeline({ personId? | companyId?, before?: { occurredAt, id }, categories?: TimelineCategory[], limit = 50 })`; `listDuplicateCandidates({ status = 'open', minScore = 50 })`; `getMergePreview(winnerId, loserId)` (field diff, per-table counts, blocking conflicts); `listTags()`; `listSegments({ includeArchived })`; `getSegment(id)`; `previewSegment(definition, excludeIds)` → `{ count, sample: PersonRow[20], sql?: string (technical_admin only) }`; `listTasks({ scope: 'mine'|'all', status, overdueOnly, dueToday, personId?, companyId?, opportunityId? })`; `getTaskCounts(userId)` → `{ open, overdue, dueToday }`; `listCompanies({ q?, status?, isPartner? })`; `getCompany(id)`; `getMyProfile()` and `getMyPreferences()` (customer); `getPreferenceState(token)`. R3: `getPipelineBoard({ ownerUserId?, minValueCents? })` (from `v_opportunity_board`), `listPlaybookStages(pipeline)`, `listThreads({ status, assignee, channel })`, `getThread(id)`.

### 4.4 Route handlers

| Route | Method | Behaviour |
| --- | --- | --- |
| `app/api/public/unsubscribe/[token]/route.ts` | POST | RFC 8058 one-click (`List-Unsubscribe=One-Click` body). Verifies the token, withdraws the token's purpose (rule 3.16), returns 200 with an empty body. Invalid token: 400. Never needs a session. |
| same | GET | Never mutates (link scanners). 303 to `/{locale}/preferences/{token}?confirm=unsubscribe`. |
| `app/api/public/preferences/[token]/route.ts` | GET | `{ firstNameInitial, locale, purposes: Record<Purpose, boolean>, suppressedAll }` |
| same | POST | `{ purposes: Record<Purpose, boolean>, locale?, unsubscribeAll?: boolean }` → 200 `{ ok: true }`; method `preference_centre`, source `preference_centre`. Expired token (older than 365 days) → 410 and the page offers "email me a fresh link" (`crm/preference-link` template). |
| `app/api/webhooks/meta/route.ts` (R3) | GET / POST | GET answers `hub.challenge` when `hub.verify_token = META_VERIFY_TOKEN`. POST verifies `X-Hub-Signature-256` with `META_APP_SECRET`, inserts `webhook_events` (provider `meta`, `external_event_id = entry.messaging[].message.mid`) on conflict do nothing, enqueues `webhook.process` with key `webhook:meta:<mid>`, returns 200 within 2 s. |

Preference tokens are stateless: `v1.<base64url(personId)>.<purpose|all>.<issuedAt epoch s>.<HMAC-SHA256>`, key derived with HKDF from `AUTH_SECRET` (info `beam-preference-v1`). `issuedAt` older than 365 days still unsubscribes (an unsubscribe link must keep working) but cannot change other preferences. Tokens of a merged person resolve to the winner.

### 4.5 Jobs and schedules

| Job kind | Lane / priority | Input | Idempotency key | Retry and behaviour |
| --- | --- | --- | --- | --- |
| `crm.check_duplicates` | fast / 5 | `{ personId }` | `dupcheck:<person_id>:<version>` | max 3; scores the person against candidates by email variant, phone, name and external id (indexed lookups), upserts `person_duplicate_candidates`, never re-opens `dismissed`. |
| `crm.detect_duplicates` | bulk / 9 | `{ afterId?: uuid }` | `schedule:crm.detect_duplicates:<minute>` then `dupscan:<YYYY-MM-DD>:<after_id>` | 2,000 persons per run by id order, enqueues itself with the next `afterId`; idempotent upsert. |
| `segments.refresh` | fast / 5 | `{}` | `schedule:segments.refresh:<minute>` | Enqueues `segments.refresh_one` per non-archived dynamic segment with key `segment:<id>:refresh:<YYYY-MM-DDTHH>`. |
| `segments.refresh_one` | bulk / 5, timeout 60 s | `{ segmentId, reason: 'schedule'|'save'|'campaign'|'manual' }` | from caller; manual and campaign use `segment:<id>:refresh:<reason>:<request_id or campaign_id>` | Computes the set in one statement into a temp CTE, `insert … on conflict do nothing` new members, deletes departed ones, writes enter/leave events, updates counts. A second run with no data change writes nothing. Failure: `refresh_error` stored, `RetryableError`. |
| `crm.escalate_opportunities` (R3) | fast / 5 | `{}` | `schedule:crm.escalate_opportunities:<minute>` | Rule 3.48; task `dedupe_key` and `notify.slack` key make reruns harmless. |
| `crm.ingest_meta_message` (R3) | fast / 3 | `{ webhookEventId }` | `meta:<mid>` | Dispatched by platform's `webhook.process` for provider `meta`; upserts thread by `(channel, external_thread_id = sender psid)`, inserts message by `external_message_id`. |
| `crm.send_meta_reply` (R3) | fast / 1 | `{ messageId }` | `meta_reply:<message_id>` | Calls Meta Send API; 4xx (window closed, permission) → `PermanentError`, the message shows "not delivered" with the reason. |
| `crm.close_stale_threads` (R3) | bulk / 9 | `{}` | `schedule:…` | `pending` threads with no inbound message for 14 days become `resolved`. |
| `ai.draft_reply` (R4) | fast / 5, max 3 | `{ messageId }` | `ai:draft_reply:<message_id>` | Rule 3.51 screen first; builds context with `toAiContext(person)` plus the last 10 non-note messages of the thread; calls platform `aiComplete` (`claude-opus-5-5`, feature `inbox_draft`); stores `ai_draft`, `ai_request_id`, `ai_draft_status = ready`. Budget exceeded → `PermanentError`, status `failed`. |

Schedules (`schedules.ts`, `Europe/Brussels`): `segments.refresh` `7 * * * *`; `crm.detect_duplicates` `50 3 * * *`; R3 `crm.escalate_opportunities` `20 * * * *` and `crm.close_stale_threads` `10 5 * * *`.

Jobs crm enqueues for other modules: `automation.exit_for_suppression` (`supp:<suppression_id>`, fast, priority 1) on every suppression and marketing withdrawal.

### 4.6 Segment compiler

`packages/core/src/crm/segments/` (pure): `SegmentRuleSchema` (Zod), `SEGMENT_ALLOWED_FIELDS`, `SEGMENT_ALLOWED_EVENT_KINDS`, `compileSegment(rule, { now }): SqlFragment` where `SqlFragment = Array<string | { param: unknown }>`; `apps/web/modules/crm/segments/sql.ts` turns it into a Drizzle `SQL` with `sql.join`, so every value is a bound parameter and core never imports Drizzle.

```ts
type SegmentRule =
  | { op: 'and' | 'or'; rules: SegmentRule[] }
  | { type: 'not'; rule: SegmentRule }
  | { type: 'field'; field: AllowedField; cmp: Comparator; value?: unknown }
  | { type: 'tag'; tagKey: string; has: boolean }
  | { type: 'consent'; purpose: ConsentPurpose; granted: boolean }
  | { type: 'in_segment'; segmentId: string; negate?: boolean }
  | { type: 'event'; kind: AllowedEventKind; mode?: 'live' | 'replay' | 'on_demand';
      where?: Partial<Record<AllowedEventDataKey, string | number | boolean>>;
      withinDays?: number; minCount?: number; negate?: boolean };
```

Comparators by field type: `enum`/`text`: `eq|neq|in|not_in|is_null|is_not_null`; `number`: `eq|neq|gt|gte|lt|lte|between|is_null`; `timestamp`: `before|after|within_last_days|more_than_days_ago|within_next_days|is_null|is_not_null`; `text[]`: `contains_any|contains_all|contains_none`; `boolean`: `is_true|is_false`.

`SEGMENT_ALLOWED_FIELDS` (columns of ops' `v_person_profile`, a contract ops must provide): `status`, `derived_status`, `is_member`, `membership_status`, `membership_period_end_at`, `b2c_stage`, `locale`, `country`, `postal_code`, `city`, `acquisition_source`, `acquisition_campaign`, `acquisition_medium`, `acquisition_funnel`, `created_at`, `revenue_cents`, `purchases`, `visits`, `no_shows`, `avg_order_cents`, `first_purchase_at`, `last_purchase_at`, `first_visit_at`, `last_visit_at`, `last_activity_at`, `next_booking_at`, `has_future_booking`, `credits_day_remaining`, `credits_night_remaining`, `credits_euro_remaining`, `next_grant_expires_at`, `package_product_ids`, `tag_keys`, `granted_purposes`, `is_b2b_contact`, `company_ids`, `referral_count`, `is_tester`. Each entry carries `{ column, type, label: i18nKey, options? }`.

`SEGMENT_ALLOWED_EVENT_KINDS`: `webinar.registered|started|attended|watched|poll_answered|cta_clicked`, `booking.confirmed|attended|no_show|cancelled|late_cancelled`, `waitlist.joined|offered|confirmed|released`, `order.paid`, `checkout.abandoned`, `form.completed`, `form.abandoned`, `assessment.result_generated`, `assessment.cta_clicked`, `email.opened`, `email.clicked`, `membership.started`, `membership.renewed`, `credits.threshold_reached`, `promotion.used`. Allowed `where` keys: `session_kind`, `session_id`, `webinar_id`, `form_slug`, `outcome_key`, `poll_key`, `option_key`, `cta_key`, `threshold`, `product_kind`, `campaign_id`, `promotion_id`. An event rule compiles to `(select count(*) from activity_events e where e.person_id in (select id from persons where id = v.person_id or merged_into_person_id = v.person_id) and e.kind = $k and not e.is_sensitive [and e.mode = $m] [and e.data->>$key = $val] [and e.occurred_at >= $now - $days]) >= $min`. This is how webinar attendance, watch thresholds, poll answers, CTA activity, assessment outcomes, event participation and waitlist state become segmentable (blueprint 6).

The outer query is `select v.person_id from v_person_profile v join persons p on p.id = v.person_id where p.erased_at is null and p.merged_into_person_id is null and p.processing_restricted_at is null and (<compiled>)`.

### 4.7 Activity event catalogue

Kinds are declared with `defineEvent({ kind, category, label, summary(data, locale) })` in the writing module's `events.ts`. crm's timeline groups them into categories. `data` keys listed are the stable contract.

| Writer | Kinds (`mode` where marked) | Key `data` |
| --- | --- | --- |
| crm | `person.created`, `person.updated`, `person.locale_changed`, `person.acquisition_filled`, `person.status_overridden`, `person.status_override_cleared`, `person.status_override_confirmed`, `person.merged`, `note.added` (may be `is_sensitive`), `interaction.logged`, `consent.granted`, `consent.withdrawn`, `suppression.added`, `tag.added`, `tag.removed`, `segment.entered`, `segment.left`, `task.created`, `task.completed`, `sensitive.updated`, `company.created`, `company.updated`, `company.contact_linked`, `company.contact_unlinked`; R3 `opportunity.created`, `opportunity.updated`, `opportunity.stage_changed`, `opportunity.won`, `opportunity.lost`, `inbox.message_received`, `inbox.reply_sent` | `purpose`, `scope`, `reason`, `fields`, `tag_key`, `segment_id`, `task_id`, `channel`, `from_stage`, `to_stage`, `value_cents` |
| booking | `booking.reserved`, `booking.confirmed`, `booking.rescheduled`, `booking.cancelled`, `booking.late_cancelled`, `booking.no_show`, `booking.attended`, `booking.guest_added`, `waitlist.joined`, `waitlist.offered`, `waitlist.offer_expired`, `waitlist.confirmed`, `waitlist.released`, `waitlist.withdrawn`, `waitlist.flagged` | `session_id`, `session_kind` (`day|night|event`), `starts_at`, `is_first_booking`, `is_first_visit`, `paid_with`, `guest_of_person_id`, `queue` |
| commerce | `checkout.started`, `checkout.abandoned`, `checkout.recovered`, `order.paid`, `order.cancelled`, `payment.failed`, `refund.issued`, `promotion.used`, `mandate.created` | `order_id`, `total_cents`, `product_kinds`, `is_first_purchase`, `promotion_id`, `channel` |
| credits | `credits.granted`, `credits.consumed`, `credits.released`, `credits.expired`, `credits.extended`, `credits.adjusted`, `credits.threshold_reached`, `credits.shared`, `credits.guest_used`, `membership.started`, `membership.renewed`, `membership.renewal_due`, `membership.past_due`, `membership.cancelled`, `membership.expired` | `grant_id`, `credit_kind`, `units`, `remaining`, `threshold`, `membership_id`, `days` |
| finance | `invoice.issued`, `credit_note.issued` | `invoice_id`, `number`, `total_cents` |
| forms | `form.started`, `form.abandoned`, `form.completed`, `assessment.result_generated`, `assessment.cta_clicked` | `form_slug`, `form_version_id`, `version`, `score`, `outcome_key`, `submission_id` (answers stay in `form_submissions`; the timeline links to them) |
| email | `email.sent`, `email.delivered`, `email.opened`, `email.clicked`, `email.bounced`, `email.complained`, `email.blocked` | `email_message_id`, `campaign_id`, `template_slug`, `purpose`, `url` |
| automation | `automation.entered`, `automation.branched`, `automation.step_skipped`, `automation.exited`, `automation.completed`, `automation.moved` | `automation_slug`, `step_key`, `outcome`, `reason` |
| ops | `person.inactive_days`, `privacy.export_completed`, `privacy.restricted`, `referral.recorded` (R3) | `days`, `request_id` |
| webinar (R2) | `webinar.registered` (mode), `webinar.started` (mode), `webinar.attended` (live), `webinar.watched` (mode), `webinar.poll_answered` (mode), `webinar.cta_shown` (mode), `webinar.cta_clicked` (mode), `webinar.chat_posted` (mode), `webinar.question_asked` (mode) | `webinar_id`, `threshold` (`15m|30m|50pct|end`), `watch_seconds`, `poll_key`, `option_key`, `cta_key` |

Timeline categories: `profile` (person, tag, segment, sensitive), `bookings` (booking, waitlist), `purchases` (checkout, order, payment, refund, promotion, invoice, credit_note, credits, membership), `email`, `webinar`, `forms`, `automation`, `service` (note, interaction, task, inbox), `consent` (consent, suppression), `b2b` (company, opportunity).

### 4.8 Cross-module API (`apps/web/modules/crm/api.ts`)

Every function takes the caller's open transaction and context, so the caller's action or job stays one transaction. `EventCtx = Pick<Ctx, 'actor' | 'now' | 'requestId' | 'enqueue' | 'recordEvent'>`.

```ts
// identity (Wave 0 stub signature, final)
export function findOrCreatePersonByEmail(tx: Tx, ctx: EventCtx, input: {
  email: string; firstName?: string; lastName?: string; phone?: string; locale: Locale;
  acquisition?: Omit<Acquisition, 'captured_at'>; isTester?: boolean;
}): Promise<{ personId: string; created: boolean }>;
export function createPersonWithoutEmail(tx: Tx, ctx: EventCtx, input: {
  firstName: string; lastName?: string; phone?: string; locale: Locale; acquisition: Omit<Acquisition, 'captured_at'>;
}): Promise<{ personId: string }>;                      // walk-ins and guests without email
export function getPerson(tx: DbOrTx, personId: string): Promise<PersonSummary | null>; // follows merges
export function resolveCanonicalPersonId(tx: DbOrTx, personId: string): Promise<string>;
export function resolvePersonIds(tx: DbOrTx, personId: string): Promise<string[]>;
export function getPersonStatus(tx: DbOrTx, personId: string): Promise<{
  status: 'lead' | 'customer' | 'member'; derivedStatus: 'lead' | 'customer' | 'member';
  override: 'lead' | 'customer' | 'member' | null; hasActiveMembership: boolean }>;
export function setStatusOverride(tx: Tx, ctx: EventCtx, input: {
  personId: string; status: 'lead' | 'customer' | 'member' | null; reason: string; onlyIfUnset?: boolean;
}): Promise<{ applied: boolean }>;
export function upsertPersonFromImport(tx: Tx, ctx: EventCtx, row: ImportPersonRow, importId: string):
  Promise<{ personId: string; outcome: 'created' | 'updated' | 'unchanged' }>;
export function findLikelyDuplicates(tx: DbOrTx, personId: string, minScore?: number):
  Promise<Array<{ personId: string; score: number; reasons: DuplicateReason[] }>>;
export function restrictProcessing(tx: Tx, ctx: EventCtx, personId: string, restricted: boolean): Promise<void>;
export function listInactiveProfiles(tx: DbOrTx, cutoff: Date, limit: number): Promise<string[]>;

// consent and suppression
export function recordConsent(tx: Tx, ctx: EventCtx, input: {
  personId: string; purpose: ConsentPurpose; status: 'granted' | 'withdrawn'; method: ConsentMethod;
  source: string; wordingVersion: string; lawfulBasis?: 'consent' | 'legitimate_interest';
  ip?: string; userAgent?: string; recordedAt?: Date; ref?: { type: string; id: string };
}): Promise<{ recordId: string | null; outcome: 'recorded' | 'unchanged' | 'needs_confirmation' | 'skipped_suppressed' }>;
export function getCurrentConsents(tx: DbOrTx, personId: string): Promise<Record<ConsentPurpose, ConsentState | null>>;
export function addSuppression(tx: Tx, ctx: EventCtx, input: {
  email: string; scope: SuppressionScope; reason: SuppressionReason; source: string; personId?: string;
}): Promise<{ suppressionId: string; created: boolean }>;   // also enqueues automation.exit_for_suppression
export function unsubscribe(tx: Tx, ctx: EventCtx, input: {
  personId: string; purpose: MarketingPurpose | 'all'; method: ConsentMethod; source: string;
}): Promise<{ suppressionId: string }>;
export function isSuppressed(tx: DbOrTx, email: string, purpose: MarketingPurpose): Promise<boolean>;
export function buildPreferenceUrls(personId: string, purpose: MarketingPurpose | 'all', locale: Locale, now: Date):
  { unsubscribeUrl: string; oneClickPostUrl: string; preferencesUrl: string };  // pure, used by email footers

// timeline, tags, segments, tasks
export function listTimeline(tx: DbOrTx, input: { personId?: string; companyId?: string;
  before?: { occurredAt: Date; id: string }; categories?: TimelineCategory[]; limit?: number }): Promise<TimelinePage>;
export function applyTag(tx: Tx, ctx: EventCtx, personId: string, tagKey: string, source: PersonTagSource): Promise<{ applied: boolean }>;
export function removeTag(tx: Tx, ctx: EventCtx, personId: string, tagKey: string): Promise<{ removed: boolean }>;
export function segmentAudienceSql(segmentId: string, excludeSegmentIds?: string[]): SQL;  // select person_id …
export function refreshSegment(tx: Tx, ctx: EventCtx, segmentId: string, reason: 'campaign' | 'manual' | 'save'):
  Promise<{ count: number; entered: number; left: number }>;
export function isInSegment(tx: DbOrTx, segmentId: string, personId: string): Promise<boolean>;
export function getSegmentRef(tx: DbOrTx, segmentId: string): Promise<{ id: string; name: string; kind: 'dynamic' | 'static'; isArchived: boolean } | null>;
export function createTask(tx: Tx, ctx: EventCtx, input: {
  title: string; kind: TaskKind; ownerUserId?: string; ownerRole?: RoleKey; dueAt?: Date; priority?: TaskPriority;
  personId?: string; companyId?: string; source: TaskSource; ref?: { type: string; id: string };
  notes?: string; dedupeKey?: string;
}): Promise<{ taskId: string; created: boolean }>;  // ownerRole → first active user of that role, else owner role holder
export function countOpenTasks(tx: DbOrTx, filter: { overdue?: boolean; kind?: TaskKind; source?: TaskSource }): Promise<number>;

// companies
export function getCompany(tx: DbOrTx, companyId: string): Promise<CompanySummary | null>;
export function listPersonCompanies(tx: DbOrTx, personId: string): Promise<Array<{ companyId: string; name: string; position: string | null; decisionRole: DecisionRole | null }>>;
export function listPartnerCompanies(tx: DbOrTx): Promise<Array<{ id: string; name: string; commissionPct: number | null }>>;

// R3 inbox entry points for other modules
export function ingestInboundEmail(tx: Tx, ctx: EventCtx, msg: {
  messageId: string; inReplyTo?: string; from: string; fromName?: string; subject: string; text: string;
  attachmentCount: number; receivedAt: Date }): Promise<{ threadId: string }>;
export function createInboxThreadFromForm(tx: Tx, ctx: EventCtx, input: {
  personId: string; submissionId: string; subject: string; body: string }): Promise<{ threadId: string }>;
```

## 5. Screens

All admin pages are server components under `app/(admin)/admin/…` with `requirePermission()`; lists use `DataTable` from `@beam/ui`. Standard states for every page: **loading** = `loading.tsx` skeleton of the page's layout; **error** = `error.tsx` with "Something went wrong" (`crm.common.error`), the `requestId` and a Retry button; **forbidden** = the shared 403 page. Empty states are listed per page.

### 5.1 Staff back-office

| Route | Shows | Actions | Empty state | Permission |
| --- | --- | --- | --- | --- |
| `/admin/persons` | Search box (customer number, email, phone, name), filters (status, tag, segment, locale, acquisition source, tester), columns: number, name, email, status badge (override marked with a pin), member, tags, last activity, created | Create person, bulk tag/untag (≤ 5000 selected), open | "No persons yet. Create one or import a list." with links to create and `/admin/imports` | `persons.read`; bulk tag `persons.write` |
| `/admin/persons/new` | Form: names, email, phone, locale, address, birth date, preferred channel, acquisition source/campaign, optional company | Save; duplicate panel appears when candidates score ≥ 50 with "Open existing" and "Create anyway" | — | `persons.write` |
| `/admin/persons/[id]` (customer 360) | Header: name, `C-000123`, status badge with derived vs override, member badge, locale, tags, contact data, acquisition (source, campaign, date), partner, companies; KPI strip from ops `getPersonStats` (revenue, purchases, visits, no-shows, last visit, LTV); panels: credits remaining and expiry (credits), membership (credits), upcoming and past bookings and waitlist state (booking), orders and invoices (commerce, finance), open tasks, active automations with next step (automation), consents per purpose with history and suppressions, segments, sensitive panel (only with `persons.sensitive_read`); timeline with category chips and infinite scroll | Edit, add note (sensitive toggle), log interaction, add task, tag, set or clear status override, staff consent change, unsubscribe all, merge with…, enrol/exit/move automation (automation's actions), book for person (booking link), sell (commerce POS link) | Timeline: "No activity yet" | `persons.read`; each action its own permission |
| `/admin/persons/[id]/edit` | Identity form with `version` | Save (stale version → "Changed by someone else, reload") | — | `persons.write` |
| `/admin/persons/duplicates` | Open candidates by score: both persons side by side, reasons, created dates | Merge (opens compare), dismiss | "No possible duplicates found." | `persons.merge` |
| `/admin/persons/[id]/merge?with=<id>` | Field-by-field compare with radio per field, per-table counts that will move, blocking conflicts in red | Choose winner, confirm merge (typed confirmation "MERGE") | — | `persons.merge` |
| `/admin/persons/tags` | Tags with counts, colour, system flag | Create, rename (LocalizedText), recolour, delete (non-system) | "No tags yet." | `persons.read`; edit `persons.write` |
| `/admin/persons/consent-wordings` | Each purpose: current version text per locale, history | Publish new version | — | `persons.read`; publish `settings.write` |
| `/admin/segments` | Segments: name, kind, count, last refreshed, used by (campaigns, automations) | Create, archive | "No segments. Create one to target campaigns." | `persons.read`; edit `email.write` |
| `/admin/segments/[id]` (and `/new`) | Rule builder (groups, field rules with typed operators, tag, consent, in-segment, event rules with mode and filters), exclusions picker, live count and 20-person sample (debounced 500 ms), refresh error banner; static: member list with add by search or CSV of customer numbers | Save, refresh now, add/remove members | Sample: "Nobody matches these rules." | `persons.read`; edit `email.write` |
| `/admin/tasks` | Tabs Mine / All (with `tasks.all`) / Overdue / Today; columns title, kind, priority, due (red when overdue), owner, related person or company, source | Create, complete, cancel, reassign, open related | "Nothing to do. Tasks you create or that automations assign appear here." | `persons.read` |
| `/admin/companies` | Companies: name, VAT, status, size, owner, contacts count, partner flag | Create | "No companies yet." | `persons.read`; edit `crm.b2b` |
| `/admin/companies/[id]` | Company details, contacts with position and decision role (link to each person's 360), opportunities (R3), tasks, company timeline | Edit, link contact (existing or new person), end contact, add note, log interaction, add task | Contacts: "No contacts linked." | `persons.read`; edit `crm.b2b` |
| `/admin/pipeline` (R3) | Kanban board per open stage with cards (company, title, value, probability, expected close, owner avatar, next action, last contact, stalled badge); totals per column (value and weighted value); filter by owner | Drag to move stage (lost asks for reason), create opportunity, open | "No opportunities yet." | `crm.b2b` |
| `/admin/pipeline/[id]` (R3) | Opportunity details, playbook card for the current stage (required action, owner, deadline, communications, escalation, KPI), activity history (company and contact timeline), tasks | Edit, move stage, add task, log interaction | — | `crm.b2b` |
| `/admin/pipeline/playbook` (R3) | Stage definitions per pipeline (B2B, B2C) in order | Edit stage, reorder, activate | — | `crm.b2b` view; edit `settings.write` |
| `/admin/inbox` (R3) | Thread list (channel icon, sender or person, subject, last message, status, assignee) with filters; thread view with messages, internal notes, linked person summary (status, credits, next booking) and reply box with templates; R4: AI draft panel with "Use draft" and "Discard" | Assign, set status, reply, note, link or create person, mark sensitive, request AI draft (R4, `ai.use`) | "Inbox zero." | `persons.read`; reply `persons.write` |

Navigation (`nav.ts`): "Persons", "Segments", "Tasks" (badge: own overdue count), "Companies"; R3 "Pipeline" (flag `ff_crm_pipeline`) and "Inbox" (flag `ff_crm_inbox`, badge: open unassigned threads).

### 5.2 Customer portal

| Route | Shows | Actions | States | Audience |
| --- | --- | --- | --- | --- |
| `/[locale]/account/profile` | First and last name, email (read-only, "contact us to change"), phone, address, birth date, language, preferred channel, customer number | Save (`updateMyProfile`); stale version → "Your details were changed elsewhere, reload" | Loading skeleton; error card with Retry | Logged-in customer |
| `/[locale]/account/preferences` | One switch per marketing purpose (newsletter, events, member communication, B2B) with the published wording text of each purpose; language; note that booking and payment emails always arrive | Save (`updateMyPreferences`), "Unsubscribe from all marketing" | Suppressed address: switches disabled with "This address no longer receives marketing email (bounce or complaint). Contact us." | Logged-in customer |

### 5.3 Public

| Route | Shows | Actions | States |
| --- | --- | --- | --- |
| `/[locale]/preferences/[token]` (`app/[locale]/(site)/preferences/[token]/page.tsx`) | Greeting with first-name initial only, switches per purpose with wording, language; `?confirm=unsubscribe` shows a single confirm button for the token's purpose | Save, unsubscribe from the token's purpose, unsubscribe from all | Invalid token: "This link is not valid." Expired for changes: unsubscribe still offered plus "Email me a fresh link". Done: "Saved. Changes apply within a minute." Page is `noindex`. |

## 6. Integrations

V1: none called directly. Email goes out through the email module (`sendTransactional`); crm's own templates live in `packages/email/src/templates/crm/` (`confirm-resubscribe.tsx`, `preference-link.tsx`, R3 `inbox-reply.tsx`).

| Release | Service | Client | Calls | Failure handling | Idempotency |
| --- | --- | --- | --- | --- | --- |
| R3 | Resend Inbound (email to `inbox@in.beam.be`, the forward target of `hello@beam.be`) | email module's Resend webhook | Email's `webhook.process` handles event type `email.received` and calls `crm.ingestInboundEmail` | A failing ingest retries in the email module's job; the message is never lost because `webhook_events` keeps the payload | `inbox_messages.external_message_id = Message-ID` header, unique |
| R3 | Meta Graph API (Instagram and Messenger), behind Meta app review and `ff_crm_inbox_meta` | `packages/integrations/src/meta-messaging/{client,fake}.ts` (new): `verifySignature(rawBody, header)`, `parseWebhook(body)`, `sendMessage({ recipientPsid, text })`, `getProfile(psid)` | Webhook ingest; replies via `crm.send_meta_reply` | Window-closed or permission errors are `PermanentError` shown on the message; 5xx retry with backoff; until app review passes the flag stays `off` and the channel is hidden | `webhook_events (meta, mid)`; key `meta_reply:<message_id>` |
| R4 | Anthropic Claude | through platform's AI gateway `aiComplete` (no direct client use) | `ai.draft_reply` | Gateway errors → draft `failed`, panel shows "AI unavailable, write manually"; budget exceeded → `PermanentError` | `ai:draft_reply:<message_id>` |

## 7. Permissions and audit

crm declares in `permissions.ts`: `persons.read`, `persons.write`, `persons.merge`, `persons.sensitive_read`, `persons.export`, `persons.erase`, `crm.b2b`, `tasks.all` (the strings and default role sets are the architecture's; ops uses `persons.export` and `persons.erase` for privacy requests).

| Capability | Permission | Default roles |
| --- | --- | --- |
| View persons, 360, timeline, segments, companies, own tasks, inbox | `persons.read` | owner, technical_admin, management, customer_service, sales, marketing, finance, reception |
| Create and edit persons, notes, interactions, tags, status override, staff consent, manual suppression, inbox replies | `persons.write` | owner, technical_admin, management, customer_service, sales, reception |
| Review duplicates and merge | `persons.merge` | owner, technical_admin, management, customer_service |
| Read and write sensitive fields and notes | `persons.sensitive_read` | owner only (grantable per role) |
| Edit segments and static members | `email.write` | owner, technical_admin, management, customer_service, marketing |
| Companies, contacts, opportunities, pipeline | `crm.b2b` | owner, technical_admin, management, sales |
| See and edit everyone's tasks | `tasks.all` | owner, technical_admin, management, customer_service, sales, reception |
| Consent wordings, playbook stages, reply templates | `settings.write` | owner, technical_admin, management |
| Request an AI draft (R4) | `ai.use` | owner, technical_admin, management, sales, marketing |
| external_partner | none of the above | sees no person data |

Audited actions (`audit_log.action`, with old and new value unless noted): `person.create`, `person.update`, `person.acquisition`, `person.status_override`, `person.merge` (old = both versions, new = winner), `person.duplicate_dismiss`, `note.add` (no body), `interaction.log`, `tag.create|update|delete|assign`, `consent.change`, `suppression.add`, `consent_wording.publish`, `sensitive.read` and `sensitive.write` (keys only, never values), `segment.save|archive|members`, `task.save|status`, `company.save`, `company.contact_link|contact_update`; R3 `opportunity.save|stage`, `playbook.save`, `inbox.update|reply|note|link|sensitive|template`; R4 `ai.request`. Customer self-service changes and system writes are not in `audit_log`; they are on the timeline with their actor.

## 8. Multi-language and content

- Catalogue namespace `crm`: `packages/core/src/i18n/messages/{en,nl-BE,fr-BE}/crm.json`, keys `crm.<screen>.<element>`. Screens: `persons.list`, `persons.new`, `persons.edit`, `person360` (header, panels, actions, banners), `timeline` (category names and one summary key per crm event kind, e.g. `crm.timeline.consent_withdrawn`), `duplicates`, `merge`, `tags`, `consentWordings`, `segments` (builder labels, every comparator, every `SEGMENT_ALLOWED_FIELDS` label, every allowed event kind and data key), `tasks`, `companies`, `portal.profile`, `portal.preferences`, `preferences` (public page), `enums` (every crm enum value: statuses, purposes, methods, scopes, reasons, task kinds and priorities, company sizes and statuses, decision roles, acquisition sources, sensitive keys, channels), `common`; R3 `pipeline`, `playbook`, `inbox`; R4 `inbox.ai`. `en` is the source; `pnpm i18n:check` keeps `nl-BE` and `fr-BE` complete.
- Other modules' event kinds carry their own summary keys in their own namespaces; the timeline calls their registered `summary()`.
- `LocalizedText` fields: `tags.name`, `consent_wordings.text`, `playbook_stages.name|required_action|human_communication|kpi.name`, `inbox_reply_templates.name|body`. Staff-only free text (`segments.name`, task titles, notes, company fields) is single-language by design.
- Publish-time checks with `assertComplete(text, ['nl-BE','fr-BE','en'])`: `publishConsentWording` (all three, always, because consent wording must exist in the person's language), `createTag`/`updateTag`, `savePlaybookStage`, `saveReplyTemplate`. A failing check returns `validation` with the missing locales.
- Person-facing pages (portal profile, preferences, preference centre) render in the URL locale; the preference centre switches to `persons.locale` when the URL has none. Emails crm sends (`confirm-resubscribe`, `preference-link`, `inbox-reply`) render in `persons.locale` through email's `renderEmail`, which blocks on a missing translation (no fallback).
- Dates in the timeline use `Intl.DateTimeFormat(locale, { timeZone: 'Europe/Brussels' })`; money from `*_cents` uses `Intl.NumberFormat(locale, { style: 'currency', currency: 'EUR' })`.

## 9. Privacy

`apps/web/modules/crm/privacy.ts` registers `{ tables, export, erase }` in `GDPR_REGISTRY`. crm's erase handler runs last in dependency order (other modules first, then crm), under `SET LOCAL beam.allow_rewrite = 'on'`, for every id in `resolvePersonIds(personId)`.

| Table | Person data | Export includes | Erase action | Why |
| --- | --- | --- | --- | --- |
| `persons` | identity, contact, address, birth date, acquisition | all columns except `search_tsv`, `version` | **anonymised**: `first_name = 'Deleted'`, `last_name = 'person'`, `email`, `email_hash`, `phone`, `phone_e164`, `address`, `birth_on`, `linkedin_url`, `status_override_reason` null; `external_ids = '{}'`; `acquisition` reduced to `{ source, campaign, medium }`; `erased_at = now()` | The row anchors retained invoices and aggregate reports; nothing left identifies the person |
| `person_sensitive_fields` | sensitive | decrypted values (system actor, purpose `privacy_export`) | **deleted** | Special category data has no retention basis |
| `person_merges` | loser snapshot | the snapshots | **deleted** | Snapshots contain identity |
| `person_duplicate_candidates` | pairing | no | **deleted** | Internal working data |
| `consent_records` | consent history | full history | **deleted** | No processing remains; the suppression row keeps "never contact" |
| `suppressions` | email address | rows for the person's address | **anonymised**: `email` null, `person_id` null; plus a new row scope `all`, reason `erased` (`on conflict do nothing`) | A hash-only suppression prevents re-import into marketing (scenario 7) |
| `activity_events` | behaviour history | all rows; sensitive notes decrypted | **deleted** (person rows); company-only rows kept | Timeline is profile data |
| `person_tags`, `segment_members` | profiling | tag keys, segment names | **deleted** | |
| `tasks` | about the person | title, kind, due, status, notes | **deleted** where `person_id` matches | Titles often name the person |
| `company_contacts` | B2B role | rows | **deleted** | |
| `opportunities` | primary contact | rows where contact | **anonymised**: `primary_contact_person_id` null | Company deal data is BEAM's business record |
| `inbox_threads`, `inbox_messages` | messages | all threads and messages | **deleted** | Communication content |

Erase report per table: `{ table, rows, action }`, no personal data. `persons.erase` is checked by ops before it starts the request. Export output: one `crm.json` (and `crm-timeline.csv`) in the ops zip.

Retention (crm asks ops to seed these `retention_policies` rows; `privacy.retention_sweep` enforces them):

| Key | Table | Days | Action | Rule |
| --- | --- | --- | --- | --- |
| `crm.inactive_profile` | `persons` | 1095 | anonymise (runs the full erase pipeline) | No activity event, order, booking, login, active grant, active membership or open invoice in 3 years; `listInactiveProfiles()` returns the candidates |
| `crm.duplicate_candidates_closed` | `person_duplicate_candidates` | 365 | delete | `status <> 'open'` |
| `crm.tasks_closed` | `tasks` | 730 | delete | `status in ('done','cancelled')` |
| `crm.inbox_resolved` (R3) | `inbox_threads` | 730 | delete | `status = 'resolved'`, from `resolved_at` |
| — | `suppressions` | never | — | Needed to honour the objection forever; plain `email` kept for staff while the person exists |
| — | `consent_records` | life of the profile | — | Proof of consent |

## 10. Dependencies

**Needs from other modules**

| Module | What | Used for |
| --- | --- | --- |
| platform | `action()`, `Ctx`, `requirePermission()`, `defineJob`, `defineSchedule`, `defineEvent`, `recordEvent()`, `audit()`, `enqueue`, `flag()`, `readSensitive(ctx, personId, purpose: 'care'|'customer_request'|'privacy_export', scope?: { keys?: SensitiveKey[]; eventIds?: string[]; submissionIds?: string[] })` (apps/web/lib, Wave 0); `encryptSensitive(plain, keyVersion)` from `@beam/core/privacy`; `users`, `roles`; `aiComplete()` (R4); `webhook.process` dispatch for provider `meta` (R3) | everything |
| credits | view `v_person_status` (columns in 2.10); `getPersonCredits(tx, personId)`, `getMembership(tx, personId)` | status, 360 panels |
| ops | view `v_person_profile` with the columns of `SEGMENT_ALLOWED_FIELDS`; `getPersonStats(tx, personId)`; seeding of crm's `retention_policies` rows | segments, 360 KPIs, retention |
| booking | `listPersonBookings(tx, personId, { upcoming, limit })`, `listPersonWaitlist(tx, personId)` | 360 panels |
| commerce | `listPersonOrders(tx, personId, { limit })` | 360 panel |
| finance | `listPersonInvoices(tx, personId)` | 360 panel |
| automation | `listPersonEnrolments(tx, personId)`, `enrolPerson(tx, ctx, { automationSlug, personId, reason })` (R3 playbook), `isSegmentInUse(tx, segmentId)`; job kind `automation.exit_for_suppression` | 360 panel, playbook, archive guard, scenario 2 |
| email | `sendTransactional(tx, { templateSlug, personId, locale?, data, idempotencyKey, replyTo?, headers? })`; `isSegmentInUse(tx, segmentId)`; template discovery of `packages/email/src/templates/crm/*.tsx`; R3 dispatch of Resend `email.received` to `ingestInboundEmail` | confirmation emails, archive guard, inbox |
| forms | R3: forms with `definition.settings.inbox = true` call `createInboxThreadFromForm` | inbox from web forms |

The 360 page wraps every foreign panel in `safePanel()`: a `NotImplementedError` or any thrown error renders "Not available yet" for that panel only, so crm builds and ships while sibling modules are still stubs.

**Provides to other modules**

- Everyone: `findOrCreatePersonByEmail`, `createPersonWithoutEmail`, `getPerson`, `resolveCanonicalPersonId`, `resolvePersonIds`, `getPersonStatus`, `applyTag`, `removeTag`, `createTask`, the `activity_events` table and the event catalogue rules.
- booking: `getPersonStatus` (lead windows, scenario 3), `findLikelyDuplicates` (waitlist duplicate flags), `listPartnerCompanies` (holds).
- commerce: `getPersonStatus`, `getCompany` (B2B orders), `findOrCreatePersonByEmail` (guest checkout).
- email: `isSuppressed`, `addSuppression`, `unsubscribe`, `getCurrentConsents`, `buildPreferenceUrls`, `segmentAudienceSql`, `refreshSegment`, views `v_consent_current` and `v_suppression_status` (inputs of `v_marketing_reachability`).
- automation: `segment.entered`/`segment.left` events, `isInSegment`, `setStatusOverride({ onlyIfUnset: true })`, `createTask` with `dedupeKey`.
- forms: `findOrCreatePersonByEmail`, `recordConsent` (with `needs_confirmation`), `applyTag`.
- ops: `upsertPersonFromImport`, `recordConsent` (import), `addSuppression` (import kind `suppressions`), `restrictProcessing`, `listInactiveProfiles`, `countOpenTasks`, `v_status_override_conflicts`, `v_open_tasks`, the privacy handlers.
- webinar: `findOrCreatePersonByEmail`, `getPersonStatus`.
- finance: `getPerson`, `getCompany` (customer snapshot, VAT number).

## 11. Edge cases and failure modes

1. **Two forms submitted at the same second with one new email.** The advisory lock serialises them; one creates, the other finds. Both submissions link to the same person.
2. **Same email typed with capitals or spaces.** Stored trimmed and lower-cased; uniqueness is on `lower(email)`; no duplicate.
3. **Staff edits a person while a customer edits their profile.** Both send `version`; the second write gets `conflict` and the form reloads with the newer values.
4. **Staff changes an email to one used by another active person.** `conflict` "This email belongs to C-000456" with a link to merge.
5. **A waiting lead buys a package.** Without an override, the derived status becomes `customer` at payment and booking's queue logic reads the new status; confirmed seats are untouched because crm never edits bookings (R2 acceptance "waiting lead who buys is reclassified correctly"). With an override `lead`, the override stays, the person appears in `v_status_override_conflicts` and the 360 banner, and staff decide.
6. **Unsubscribe link clicked by a corporate link scanner.** GET only redirects; only a POST or the confirm button unsubscribes.
7. **One-click unsubscribe for a person who was merged.** The token's person id resolves to the winner; the winner is unsubscribed.
8. **Unsubscribe for an address that is already suppressed.** Suppression insert does nothing; the withdrawal row is still appended if consent was granted; the exit job is still enqueued with the existing suppression id (key dedupes).
9. **Re-import from Mailchimp marks an unsubscribed person "subscribed".** The import consent grant is skipped with `skipped_suppressed`; the import report lists it; acceptance test "suppression survives an import".
10. **Person unsubscribes, later ticks "newsletter" on a website form.** The grant returns `needs_confirmation`, `crm/confirm-resubscribe` is sent (a transactional email, allowed despite the scoped suppression); only the click records the grant.
11. **Hard bounce on an address, the person then changes email.** The new address has a new hash and is reachable once consent exists; the old suppression stays.
12. **Merge where both persons have an active membership.** Refused with "Both persons have an active membership. Cancel one first."; nothing changes.
13. **Merge of A into B, then B into C.** The second merge also points A at C; `resolvePersonIds(C)` returns C, B and A; the timeline shows all three histories.
14. **Merge loser had newer withdrawn newsletter consent than winner's grant.** The withdrawal is copied to the winner; the merged person is not reachable for newsletter.
15. **A module adds a new table with `person_id` after crm shipped.** Merge discovers it from `information_schema` and repoints it by default; `merge-coverage.test.ts` fails if the table has a unique key including the person column and no merge strategy in `MERGE_STRATEGIES`, so the owner adds one.
16. **Sensitive note created by a user who lacks `persons.sensitive_read`.** The sensitive toggle is hidden; the server refuses with `forbidden` if sent anyway.
17. **`SENSITIVE_DATA_KEY_V1` missing in an environment.** `addNote` with `isSensitive` and `setSensitiveField` fail with `internal` and a Sentry event; non-sensitive work continues; the health check reports `sensitive_key: missing`.
18. **Segment rule references a field ops has not shipped yet.** The registry test `segment-fields.test.ts` fails at the wave gate; at runtime the compiler rejects unknown columns with `validation`.
19. **Segment refresh of 50,000 persons times out.** Statement timeout 45 s inside the 60 s job; `refresh_error` recorded, members kept, retried next hour; the segment page shows the error and the last good count.
20. **A segment used by a scheduled campaign is archived.** `archiveSegment` refuses with the campaign name.
21. **Segment A excludes B and B excludes A.** Allowed (exclusions are one level and not recursive); `in_segment` cycles are refused on save.
22. **Task owner is disabled.** Tasks stay; `/admin/tasks` "All" shows them with owner "(disabled)"; reassignment needs `tasks.all`.
23. **Automation creates the same follow-up task twice after a job retry.** `dedupe_key` unique; second insert returns `created: false`.
24. **Company contact leaves the company.** `endContact` sets `ended_on`; history and timeline stay; the person keeps every B2C relationship.
25. **Two companies with the same VAT number typed differently (`BE 0123.456.789`, `be0123456789`).** Normalised to `BE0123456789`; the second save gets `conflict`.
26. **Preference centre token older than 365 days.** Unsubscribe still works; other changes need a fresh link sent to the person's address.
27. (R3) **Inbound email from an unknown sender.** Thread created with `person_id` null; staff link or create; no consent is recorded.
28. (R3) **Meta webhook delivered twice.** `webhook_events` unique `(meta, mid)` and `external_message_id` unique; one message.
29. (R4) **Customer email mentions burn-out.** Keyword screen matches; `ai_draft_status = blocked_sensitive`; staff write the reply manually; nothing is sent to Claude.
30. **Erasure of a person who is a company's primary contact on an open opportunity.** The opportunity stays with `primary_contact_person_id` null; the pipeline card shows "No contact".

## 12. Build packages

Ten packages. File layout rule: crm-P1 creates every shared crm file (schema, views, barrels, registries, catalogue) and an empty stub (`export {};`) for every area file of V1; later packages fill only their own area folders and pages. The barrels `apps/web/modules/crm/{actions,queries,api,jobs}.ts` re-export `./<area>/<file>` and are written once by P1 for all V1 areas (`persons`, `tags`, `consent`, `portal`, `duplicates`, `merge`, `sensitive`, `segments`, `tasks`, `companies`, `timeline`). **Parallelism:** after P1, packages P2, P3, P4, P5 and P6 touch disjoint files and may run in parallel. P7 runs after P2–P6 and is the only V1 package that edits P1 files beyond its own stubs (`privacy.ts`, `crm.json`): strictly sequential. R3 packages P8 then P9 and R4 package P10 are strictly sequential with each other and after P7, because they edit `crm.ts`, `crm.views.ts`, the barrels, `schedules.ts`, `privacy.ts`, `crm.json` and `packages/db/src/seed/crm.ts`. P1 writes the complete V1 catalogue for every screen of section 5; P2–P6 use only those keys and list any missing key in their PR description, and P7 adds them. No package edits `package.json`, the lockfile, migrations or `registry/*.generated.ts`. Every package's done-definition includes: `pnpm typecheck`, `pnpm lint`, its Vitest suites green with `createTestDb()`, and `pnpm i18n:check` green.

### crm-P1 (V1): schema, views, pure core, registries

- **Goal:** every V1 crm table, column, enum, index and view; all pure logic; the module's registry files; the full V1 `crm` catalogue.
- **Files:** edit `packages/db/src/schema/crm.ts` (add the ADD columns to `persons`, `consent_records`, `suppressions`; create `person_merges`, `person_duplicate_candidates`, `person_sensitive_fields`, `consent_wordings`, `tags`, `person_tags`, `segments`, `segment_members`, `tasks`, `companies`, `company_contacts` and their enums; register APPEND tables); create `packages/db/src/schema/crm.views.ts` (`v_consent_current`, `v_suppression_status`, `v_status_override_conflicts`, `v_open_tasks`); create `packages/db/src/seed/crm.ts` (system tags `vip`, `interest:sleep`, `interest:breathwork`, `interest:events`; `consent_wordings` v1 for every purpose in three locales; 40 demo persons, 5 companies, 10 tasks); create `packages/core/src/crm/{index,types,acquisition,normalise,status,consent,duplicates,merge-plan,preference-token}.ts` and `packages/core/src/crm/segments/{schema,fields,compile}.ts`; create `packages/core/src/i18n/messages/{en,nl-BE,fr-BE}/crm.json`; create `apps/web/modules/crm/{actions,queries,api,jobs,schedules,events,permissions,nav,privacy,seed}.ts` and every V1 area stub `apps/web/modules/crm/<area>/{actions,queries,api,jobs}.ts` (only the files this section assigns to P2–P7).
- **Interfaces:** `normaliseEmail(raw): string | null`, `emailHash(email): string`, `gmailCanonical(email): string`, `normalisePhone(raw, country = 'BE'): string | null`, `normaliseVat(raw): string | null`; `resolveStatus({ override, hasActiveMembership, hasPaidQualifyingOrder }): { status, derivedStatus }`; `latestConsent(records): ConsentState | null`; `importGrantDecision({ existingRecords, suppressions, purpose }): 'record' | 'skip'`; `suppressionBlocks({ suppression, currentConsent }): boolean`; `scorePair(a: DupInput, b: DupInput): { score, reasons }`; `planConsentCopy(winnerRecords, loserRecords): ConsentCopy[]`; `pickMergedFields(winner, loser, choices): PersonPatch`; `MERGE_STRATEGIES: Record<string, 'repoint' | 'keep_winner' | 'refuse_if_both' | 'skip'>`; `signPreferenceToken({ personId, purpose, issuedAt }, key): string`, `verifyPreferenceToken(token, key, now): { personId, purpose, issuedAt, canEdit } | null`; `SegmentRuleSchema`, `SEGMENT_ALLOWED_FIELDS`, `SEGMENT_ALLOWED_EVENT_KINDS`, `compileSegment(rule, { now }): SqlFragment`; `defineEvent` entries for every crm kind of section 4.7 (V1 and R3 kinds, R3 ones unused until R3); permissions; nav entries (R3 ones behind `ff_crm_pipeline`, `ff_crm_inbox`); schedules `segments.refresh` and `crm.detect_duplicates`.
- **Depends on:** `platform:_shared.ts helpers (id, timestamps, localized, sensitive, APPEND_ONLY_TABLES)`, `platform:defineEvent/defineSchedule`, `credits:v_person_status` (view referenced by `v_status_override_conflicts`; if absent in Wave 1, the view file declares it with `.existing()` and the test creates a fixture view).
- **Tests:** `packages/core/src/crm/normalise.test.ts` (Belgian phone formats, `0032`, unparseable, gmail dots and `+tag`, VAT forms); `status.test.ts` (rules 3.8–3.12); `consent.test.ts` (3.13, 3.19, 3.20 import decisions, ordering ties); `duplicates.test.ts` (each score, max not sum); `merge-plan.test.ts` (3.33, 3.34); `preference-token.test.ts` (tamper, expiry for edit, unsubscribe after 365 days); `segments/compile.test.ts` (every comparator, unknown field rejected, 51 rules rejected, depth 5 rejected, params bound, no `SENSITIVE_COLUMNS` member in the allow-lists, event rule SQL); `packages/db/src/schema/crm.test.ts` with `createTestDb()` (partial unique email allows a merged duplicate, check constraints, `v_consent_current` latest row, `v_suppression_status` lift rule).
- **Done:** standard definition plus `pnpm gen:indexes` picks up crm registries.

### crm-P2 (V1): persons, status, tags, search

- **Goal:** identity actions and api, status override, tags, admin list, create, edit and tags pages.
- **Files:** `apps/web/modules/crm/persons/{actions,queries,api}.ts`, `apps/web/modules/crm/tags/{actions,queries,api}.ts`, `apps/web/modules/crm/ui/{person-form,person-search,tag-picker,status-badge}.tsx`, `apps/web/app/(admin)/admin/persons/{page,loading,error}.tsx`, `apps/web/app/(admin)/admin/persons/new/page.tsx`, `apps/web/app/(admin)/admin/persons/[id]/edit/page.tsx`, `apps/web/app/(admin)/admin/persons/tags/page.tsx`.
- **Interfaces:** actions `createPerson`, `updatePerson`, `fillAcquisition`, `setStatusOverride`, `confirmStatusOverride`, `createTag`, `updateTag`, `deleteTag`, `tagPersons`, `untagPersons`; queries `listPersons`, `searchPersons`, `listTags`; api `findOrCreatePersonByEmail`, `createPersonWithoutEmail`, `getPerson`, `resolveCanonicalPersonId`, `resolvePersonIds`, `getPersonStatus`, `setStatusOverride`, `upsertPersonFromImport`, `restrictProcessing`, `listInactiveProfiles`, `applyTag`, `removeTag` (signatures in 4.8).
- **Depends on:** crm-P1; `platform:action, recordEvent, audit, enqueue`; `credits:v_person_status`.
- **Tests:** `persons/persons.test.ts` (rules 3.1–3.12, concurrent `findOrCreatePersonByEmail` with `Promise.all` creates one row, fill-only import, stale version conflict, override never cleared by a paid order, `onlyIfUnset`); `tags/tags.test.ts` (system tag delete refused, unique person tag, events written); `persons/search.test.ts` (customer number, phone formats, name prefix).
- **Done:** standard.

### crm-P3 (V1): consent, suppressions, preference centre, portal pages

- **Goal:** consent and suppression api and actions, one-click unsubscribe, the token preference centre, portal profile and preferences, consent wordings page, crm email templates.
- **Files:** `apps/web/modules/crm/consent/{actions,queries,api}.ts`, `apps/web/modules/crm/portal/{actions,queries}.ts`, `apps/web/modules/crm/ui/{consent-panel,preference-switches}.tsx`, `apps/web/app/api/public/unsubscribe/[token]/route.ts`, `apps/web/app/api/public/preferences/[token]/route.ts`, `apps/web/app/[locale]/(site)/preferences/[token]/page.tsx`, `apps/web/app/[locale]/(portal)/account/profile/page.tsx`, `apps/web/app/[locale]/(portal)/account/preferences/page.tsx`, `apps/web/app/(admin)/admin/persons/consent-wordings/page.tsx`, `packages/email/src/templates/crm/{confirm-resubscribe,preference-link}.tsx`.
- **Interfaces:** api `recordConsent`, `getCurrentConsents`, `addSuppression`, `unsubscribe`, `isSuppressed`, `buildPreferenceUrls`; actions `recordStaffConsent`, `addManualSuppression`, `publishConsentWording`, `updateMyProfile`, `updateMyPreferences`; queries `getMyProfile`, `getMyPreferences`, `getPreferenceState`.
- **Depends on:** crm-P1; `email:sendTransactional`; `automation:automation.exit_for_suppression` (job kind only; tests assert the enqueued row).
- **Tests:** `consent/consent.test.ts` (rules 3.13–3.22: withdrawal writes consent, suppression and `supp:<id>` job in one transaction; already suppressed address; complaint withdraws all; import grant skipped; scoped unsubscribe lifted only by newer portal or preference-centre grant; `all` never lifted; form grant after unsubscribe returns `needs_confirmation`; assessment result creates no newsletter consent); `consent/routes.test.ts` (one-click POST 200, GET never mutates, tampered token 400, merged person resolves, expired token edits 410); `portal/portal.test.ts` (customer can only change own record; email not editable).
- **Done:** standard.

### crm-P4 (V1): duplicates, merge, sensitive fields

- **Goal:** duplicate detection jobs and queue, the merge transaction across all modules, encrypted sensitive fields.
- **Files:** `apps/web/modules/crm/duplicates/{actions,queries,api,jobs}.ts`, `apps/web/modules/crm/merge/{actions,queries}.ts`, `apps/web/modules/crm/merge/execute.ts`, `apps/web/modules/crm/sensitive/{actions,queries}.ts`, `apps/web/modules/crm/ui/{merge-compare,sensitive-panel,duplicate-list}.tsx`, `apps/web/app/(admin)/admin/persons/duplicates/page.tsx`, `apps/web/app/(admin)/admin/persons/[id]/merge/page.tsx`.
- **Interfaces:** jobs `crm.check_duplicates`, `crm.detect_duplicates`; api `findLikelyDuplicates`; actions `dismissDuplicate`, `mergePersons`, `setSensitiveField`, `revealSensitive`; queries `listDuplicateCandidates`, `getMergePreview`; `executeMerge(tx, ctx, { winnerId, loserId, fieldChoices }): Promise<{ mergeId, repointed }>` which reads `information_schema.key_column_usage` for every FK to `persons.id` and applies `MERGE_STRATEGIES`.
- **Depends on:** crm-P1; `platform:readSensitive, encryptSensitive`.
- **Tests:** `duplicates/duplicates.test.ts` (each reason, dismissed never re-proposed, job run twice gives the same rows); `merge/merge.test.ts` (rules 3.30–3.34: repoints mutable rows, keeps append rows and resolves them, unique-key tables keep winner, both memberships refused with no change, chain flattening, consent copy keeps the newer withdrawal, audit row written); `merge/merge-coverage.test.ts` (every FK to `persons.id` with a person-including unique key has a strategy); `sensitive/sensitive.test.ts` (ciphertext stored, read requires permission, `sensitive.read` audit has keys and no values, no plaintext in `activity_events`).
- **Done:** standard.

### crm-P5 (V1): segments

- **Goal:** segment storage, builder UI, refresh jobs and the audience SQL used by email.
- **Files:** `apps/web/modules/crm/segments/{actions,queries,api,jobs,sql}.ts`, `apps/web/modules/crm/segments/test-fixtures.ts` (creates a fixture `v_person_profile` with the contract columns when the ops view is absent), `apps/web/modules/crm/ui/segment-builder/{index,rule-row,event-rule,field-picker}.tsx`, `apps/web/app/(admin)/admin/segments/{page,loading,error}.tsx`, `apps/web/app/(admin)/admin/segments/new/page.tsx`, `apps/web/app/(admin)/admin/segments/[id]/page.tsx`.
- **Interfaces:** actions `saveSegment`, `archiveSegment`, `setStaticMembers`, `refreshSegmentNow`; queries `listSegments`, `getSegment`, `previewSegment`; api `segmentAudienceSql`, `refreshSegment`, `isInSegment`, `getSegmentRef`; jobs `segments.refresh`, `segments.refresh_one`.
- **Depends on:** crm-P1; `ops:v_person_profile` (fixture in tests); `email:isSegmentInUse`, `automation:isSegmentInUse` (stubs; archive guard treats `NotImplementedError` as "not in use").
- **Tests:** `segments/segments.test.ts` (rules 3.38–3.41: dynamic result, static list, exclusions at read time, erased/merged/restricted excluded, `in_segment` cycle refused, enter/leave events with dedupe, refresh twice writes nothing new, failing refresh keeps members and stores `refresh_error`, event rule over webinar mode and poll option).
- **Done:** standard.

### crm-P6 (V1): tasks and companies

- **Goal:** tasks with overdue visibility and companies with contacts.
- **Files:** `apps/web/modules/crm/tasks/{actions,queries,api}.ts`, `apps/web/modules/crm/companies/{actions,queries,api}.ts`, `apps/web/modules/crm/ui/{task-list,task-form,company-form,contact-list}.tsx`, `apps/web/app/(admin)/admin/tasks/{page,loading,error}.tsx`, `apps/web/app/(admin)/admin/companies/{page,loading,error}.tsx`, `apps/web/app/(admin)/admin/companies/new/page.tsx`, `apps/web/app/(admin)/admin/companies/[id]/page.tsx`.
- **Interfaces:** actions `createTask`, `updateTask`, `completeTask`, `cancelTask`, `saveCompany`, `linkContact`, `updateContact`, `endContact`; queries `listTasks`, `getTaskCounts`, `listCompanies`, `getCompany`; api `createTask`, `countOpenTasks`, `getCompany`, `listPersonCompanies`, `listPartnerCompanies`.
- **Depends on:** crm-P1; `platform:users, roles`.
- **Tests:** `tasks/tasks.test.ts` (rules 3.42–3.44: own-only without `tasks.all`, overdue and due-today in Brussels time, dedupe key, owner role resolution); `companies/companies.test.ts` (3.45 VAT normalisation and uniqueness, one person as customer and contact, primary contact partial unique, end contact keeps history).
- **Done:** standard.

### crm-P7 (V1): timeline, customer 360, privacy, module-level tests

- **Goal:** the timeline, notes and interactions, the 360 page, the privacy registration, the module-wide test files, the e2e specs, and i18n reconciliation for V1.
- **Files:** `apps/web/modules/crm/timeline/{actions,queries,api}.ts`, `apps/web/modules/crm/ui/timeline/{timeline,event-row,category-chips}.tsx`, `apps/web/modules/crm/ui/person-360/{header,kpi-strip,panels,safe-panel,override-banner}.tsx`, `apps/web/app/(admin)/admin/persons/[id]/{page,loading,error}.tsx`; edits (sequential after P1–P6) `apps/web/modules/crm/privacy.ts` and `packages/core/src/i18n/messages/{en,nl-BE,fr-BE}/crm.json`; creates `apps/web/modules/crm/{privacy,permissions,jobs}.test.ts`, `e2e/crm.spec.ts`, `e2e/scenario-6-sensitive-ai.spec.ts`.
- **Interfaces:** actions `addNote`, `logInteraction`; queries `getPerson360`, `getTimeline`; api `listTimeline`; `privacy.ts` `{ tables, export, erase }` per section 9; `safePanel<T>(load: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }>`.
- **Depends on:** crm-P2…P6; `credits:getPersonCredits, getMembership`; `booking:listPersonBookings, listPersonWaitlist`; `commerce:listPersonOrders`; `finance:listPersonInvoices`; `ops:getPersonStats`; `automation:listPersonEnrolments` (all through `safePanel`); `platform:readSensitive`.
- **Tests:** `timeline/timeline.test.ts` (3.35–3.37: merged history included, cursor paging stable with equal timestamps, category filter, sensitive note stored encrypted and rendered as placeholder, unknown kind rendered raw); `privacy.test.ts` (export contains every table of section 9 and decrypted sensitive data for the subject; erase leaves no row referencing the person except anonymised `persons`, hash-only `suppressions` and anonymised `opportunities`; erase of a merged winner also erases the loser); `permissions.test.ts` (every crm action refuses without its permission; customer actions refuse another person's id); `jobs.test.ts` (every crm job run twice with the same payload yields the same state); `e2e/crm.spec.ts` (staff logs in, creates a person, sees the duplicate warning, adds a note and a task, sets an override and sees the banner, merges two persons and sees both histories; customer edits profile and unsubscribes in preferences; one-click POST on the preference URL); `e2e/scenario-6-sensitive-ai.spec.ts` (an assessment with a sensitive free-text answer and a sensitive note: `toAiContext` output and the stored `ai_requests.fields_sent` contain neither; enabling `settings.ai.sensitive_enabled` requires owner, a purpose and writes an audit row).
- **Done:** standard plus `pnpm test` green for `gdpr-coverage` with crm tables and Playwright `e2e/crm.spec.ts` green against `beam_dev`.

### crm-P8 (R3): B2B pipeline and sales playbook

- **Goal:** opportunities, the board, playbook stage definitions with tasks, enrolment and escalation.
- **Files:** edits `packages/db/src/schema/crm.ts` (`opportunities`, `playbook_stages`, `tasks.opportunity_id`), `packages/db/src/schema/crm.views.ts` (`v_opportunity_board`), `packages/db/src/seed/crm.ts` (default playbook for 13 B2B and 10 B2C stages), barrels `apps/web/modules/crm/{actions,queries,api,jobs}.ts`, `schedules.ts`, `privacy.ts`, `crm.json` ×3; creates `apps/web/modules/crm/pipeline/{actions,queries,api,jobs}.ts`, `apps/web/modules/crm/ui/pipeline/{board,card,stage-dialog,playbook-form}.tsx`, `apps/web/app/(admin)/admin/pipeline/{page,loading,error}.tsx`, `apps/web/app/(admin)/admin/pipeline/[id]/page.tsx`, `apps/web/app/(admin)/admin/pipeline/playbook/page.tsx`.
- **Interfaces:** actions `saveOpportunity`, `moveOpportunityStage`, `savePlaybookStage`; queries `getPipelineBoard`, `listPlaybookStages`; job `crm.escalate_opportunities` and its schedule.
- **Depends on:** crm-P7; `automation:enrolPerson`; `platform:notify.slack` job kind.
- **Tests:** `pipeline/pipeline.test.ts` (rules 3.46–3.48: stage change task with dedupe, default probability unless manually set, won and lost rules, escalation once per stage, last contact from timeline, enrolment call made); `pipeline/jobs.test.ts` (double run).
- **Done:** standard plus flag `ff_crm_pipeline` gates nav and pages.

### crm-P9 (R3): unified inbox

- **Goal:** threads and messages from email, web forms, Instagram and Messenger, linked to persons, with replies, notes, templates and status.
- **Files:** edits `packages/db/src/schema/crm.ts` (`inbox_threads`, `inbox_messages` without the R4 columns, `inbox_reply_templates`), barrels, `schedules.ts`, `privacy.ts`, `crm.json` ×3; creates `apps/web/modules/crm/inbox/{actions,queries,api,jobs}.ts`, `apps/web/modules/crm/ui/inbox/{thread-list,thread-view,reply-box,person-sidebar}.tsx`, `apps/web/app/(admin)/admin/inbox/{page,loading,error}.tsx`, `apps/web/app/(admin)/admin/inbox/[threadId]/page.tsx`, `apps/web/app/api/webhooks/meta/route.ts`, `packages/integrations/src/meta-messaging/{client,fake,schemas}.ts`, `packages/email/src/templates/crm/inbox-reply.tsx`.
- **Interfaces:** actions of 4.2 for the inbox; api `ingestInboundEmail`, `createInboxThreadFromForm`; jobs `crm.ingest_meta_message`, `crm.send_meta_reply`, `crm.close_stale_threads`; `MetaMessagingClient { verifySignature(raw: string, header: string): boolean; parseWebhook(body: unknown): MetaInbound[]; sendMessage(input: { recipientPsid: string; text: string }): Promise<{ messageId: string }> }`.
- **Depends on:** crm-P8; `platform:webhook_events provider 'meta'` (orchestrator enum change), `platform:webhook.process` dispatch; `email:sendTransactional`, `email:email.received dispatch`; `forms:createInboxThreadFromForm call`.
- **Tests:** `inbox/inbox.test.ts` (rules 3.49–3.50: link by email, unknown sender unlinked, reopen on new inbound, first response time, email reply enqueues one email, note never sent, duplicate inbound ignored); `inbox/meta.test.ts` with `fake.ts` (signature check, window closed → permanent error, challenge GET); `inbox/jobs.test.ts` (double run).
- **Done:** standard plus flags `ff_crm_inbox` and `ff_crm_inbox_meta` gate the UI and the Meta channel.

### crm-P10 (R4): AI-drafted replies

- **Goal:** Claude drafts replies for staff approval, with the sensitive screen.
- **Files:** edits `packages/db/src/schema/crm.ts` (`inbox_messages.ai_draft_status`, `ai_request_id`), `apps/web/modules/crm/inbox/{actions,jobs}.ts`, `apps/web/modules/crm/ui/inbox/thread-view.tsx`, `crm.json` ×3; creates `packages/core/src/crm/sensitive-screen.ts` (`SENSITIVE_KEYWORDS` for nl-BE, fr-BE, en; `screenSensitive(text, locale): { blocked: boolean; matched: string[] }`), `apps/web/modules/crm/inbox/ai-draft.ts`, `apps/web/modules/crm/ui/inbox/ai-draft-panel.tsx`.
- **Interfaces:** job `ai.draft_reply`; actions `requestAiDraft`, `discardAiDraft`; `buildDraftPrompt(context: AiContext, messages: ThreadMessage[], policies: string): { system: string; user: string }`.
- **Depends on:** crm-P9; `platform:aiComplete`, `@beam/core/ai:toAiContext`.
- **Tests:** `packages/core/src/crm/sensitive-screen.test.ts` (keywords per locale, word boundaries); `inbox/ai-draft.test.ts` with the Claude `fake.ts` (rule 3.51: blocked thread sends nothing, budget exceeded marks failed, draft never sent without a staff action, `ai_requests.fields_sent` excludes email and phone, `used` set on send).
- **Done:** standard.

## 13. Decisions made

Additions to the architecture (all expand-only):

1. `persons` gains `customer_number` (identity column, shown `C-000123`; blueprint 3 "Customer ID", 54), `email_hash` (joins to suppressions), `phone_e164` (duplicate detection and search), `linkedin_url` (blueprint 24), `external_ids` jsonb (legacy ids from SimplyBook, Mailchimp, Lightspeed and others; duplicate rule and import matching), `status_override_at`, `processing_restricted_at` (GDPR restriction right), `search_tsv` (generated tsvector, `simple` config, GIN index) and `version` (optimistic concurrency).
2. New tables: `person_duplicate_candidates` (review queue), `consent_wordings` IMMUTABLE (the wording text behind `wording_version`), R3 `playbook_stages` (blueprint 29), R3 `inbox_reply_templates` (blueprint 35 response templates).
3. New columns: `consent_records.lawful_basis`, `user_agent`, `actor`, `ref_type`, `ref_id`, `copied_from_record_id`; `suppressions.person_id`, `actor`; `person_merges.field_choices`, `repointed`; `person_sensitive_fields.updated_by_user_id`; `tags.description`, `is_system`; `person_tags.added_by`; `segments.description`, `is_archived`, `refresh_error`; `tasks.done_by_user_id`, `created_by`, `dedupe_key`, R3 `opportunity_id`; `company_contacts.is_primary`, `ended_on`; R3 `opportunities.title`, `stage_entered_at`, `won_at`, `lost_at`, `source`; R3 `inbox_threads.company_id`, `from_address`, `from_name`, `last_message_at`, `first_response_at`, `resolved_at`, `is_sensitive`; R3 `inbox_messages.email_message_id`, `attachment_count`, enum value `note` on `direction`; R4 `inbox_messages.ai_draft_status`, `ai_request_id`.
4. New views: `v_suppression_status`, `v_status_override_conflicts`, `v_open_tasks`, R3 `v_opportunity_board`.
5. New routes: `/admin/persons/duplicates`, `/admin/persons/[id]/merge`, `/admin/persons/tags`, `/admin/persons/consent-wordings`, R3 `/admin/pipeline` (+ `[id]`, `playbook`), R3 `/admin/inbox` (+ `[threadId]`), R3 `app/api/webhooks/meta/route.ts`, public page `app/[locale]/(site)/preferences/[token]` (an exception to site owning `(site)/*`, like forms), portal `/[locale]/account/{profile,preferences}`. crm owns `api/public/unsubscribe/[token]` and `api/public/preferences/[token]` because both write consent and suppressions.
6. New job kinds: `crm.check_duplicates`, `crm.detect_duplicates`, `segments.refresh_one`, R3 `crm.escalate_opportunities`, `crm.ingest_meta_message`, `crm.send_meta_reply`, `crm.close_stale_threads`; crm owns `segments.refresh` and R4 `ai.draft_reply` (names from the architecture).
7. New integration client `packages/integrations/src/meta-messaging/` (R3), new env names `META_APP_SECRET` and `META_VERIFY_TOKEN` (added to `.env.example` by the orchestrator), and webhook provider value `meta` on `webhook_events.provider` (a change to frozen `platform.ts`, done by the orchestrator before R3).
8. Flags: `ff_crm_pipeline`, `ff_crm_inbox`, `ff_crm_inbox_meta`.

Choices the inputs left open:

9. Status: crm never stores the derived status; `v_person_status` stays in credits as the architecture says. Member pricing and member-only access use the real membership, not the override; classification, lead windows and content blocks use `coalesce(override, derived)`.
10. An override that diverges from the derived status is surfaced (banner, `v_status_override_conflicts`), never auto-cleared. Automations may set an override only when none exists.
11. Acquisition is immutable after creation; staff may only fill a missing source. On merge the older person's acquisition wins.
12. Locale on an existing person is never overwritten by later forms or imports.
13. Customers cannot change their email in the portal in V1; staff do it (avoids an unverified-address takeover path).
14. Suppression lifting: suppressions are never deleted; only a scoped `unsubscribe` suppression yields to a newer explicit grant through portal, preference centre, or a form confirmed by email (double opt-in). `all`, bounce, complaint, manual and erased suppressions are permanent for the address.
15. Imports never lift a suppression and never override a withdrawal; they also never write suppressions except the `suppressions` import kind.
16. Staff may record a grant only for `b2b`, on legitimate interest. Other purposes need the person's own action.
17. Preference tokens are stateless HMAC tokens (no table, no write per sent email), derived from `AUTH_SECRET`. Unsubscribe works forever; changing other preferences needs a token younger than 365 days. This departs from the architecture's stored-hash pattern for this one token, because 50,000-recipient campaigns would otherwise write 50,000 token rows and links must keep working indefinitely.
18. One-click unsubscribe mutates only on POST; GET redirects to a confirm page, so mail scanners cannot unsubscribe people.
19. Duplicate scoring uses fixed rules and weights (95/90/80/70/50, threshold 50), no fuzzy matching and no `pg_trgm`. Search uses the built-in `tsvector` with the `simple` configuration, so PGlite and Neon behave the same.
20. Merge is generic: crm discovers every foreign key to `persons.id` from `information_schema` and repoints mutable tables, with `MERGE_STRATEGIES` for tables with person-including unique keys and a coverage test. Append-only tables are not rewritten; reads resolve merges through `resolvePersonIds` (one level, because merges flatten chains). This keeps the `beam.allow_rewrite` bypass exclusive to erasure.
21. Merge refuses when both persons hold an active membership, an active booking for the same session, or a place on the same waitlist; staff resolve those first.
22. A customer `users` row of a merged loser is repointed to the winner, so both logins see one record.
23. Sensitive fields are read and written with the same permission, `persons.sensitive_read`.
24. Segments are edited with `email.write` (marketing and customer service have it); no new permission string.
25. Segment members store the raw set; exclusions apply at read time through `segmentAudienceSql`, so a change to an excluded segment takes effect without refreshing the including segment. Exclusions are one level; `in_segment` references are checked for cycles.
26. Event-based segment rules over `activity_events` give webinar, poll, CTA, assessment, event and waitlist segmentation without widening `v_person_profile`.
27. The segment refresh runs at minute 7 of every hour, not minute 0, to stay clear of other hourly work; statement timeout 45 s.
28. Tasks: without `tasks.all` users see and create only their own tasks. Overdue is computed, not stored. No task emails; the navigation badge and the ops action dashboard surface them.
29. Companies ship in V1 (partners, holds and B2B invoices need them); opportunities, board and playbook ship in R3. Playbook editing needs `settings.write`.
30. The playbook defines stages for both pipelines; B2C stage keys are ops' `b2c_stage` values. A stage change creates exactly one task for the opportunity owner and optionally enrols the primary contact.
31. Inbound email arrives through Resend Inbound on `inbox@in.beam.be` via the email module's existing webhook; crm exposes `ingestInboundEmail`. Attachments are counted, not stored. Inbound messages never create persons or consent.
32. Website contact forms reach the inbox when the form version sets `definition.settings.inbox = true`.
33. AI drafts (R4) are generated only on request (`ai.use`), never automatically, to control cost; a keyword screen and the thread's `is_sensitive` flag block drafting unless sensitive processing is enabled in settings.
34. Erasure deletes consent records (the hash-only `erased` suppression keeps the objection), deletes the timeline and tasks, anonymises `persons`, keeps `acquisition.source/campaign/medium` for aggregate attribution, and nulls the opportunity contact.
35. Retention: inactive profiles anonymised after 3 years, closed duplicate candidates deleted after 1 year, closed tasks after 2 years, resolved inbox threads after 2 years; suppressions are kept forever.
36. The 360 page reads sibling modules only through their `api.ts`, wrapped in `safePanel()`, so crm ships independently of their build order.
37. Tests that need ops' `v_person_profile` or credits' `v_person_status` before those modules land create fixture views with the contract columns in the test database.
38. Phone normalisation is a small in-house Belgian-first normaliser in `@beam/core/crm` (no new dependency).
39. The crm catalogue is written in full by crm-P1 and reconciled by crm-P7, so parallel packages never edit the same JSON file.
