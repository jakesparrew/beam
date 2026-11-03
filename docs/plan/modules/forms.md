# Module spec: forms (Forms, assessments and lead capture)

Owner paths: `packages/db/src/schema/forms.ts`, `packages/db/src/schema/forms.views.ts`, `packages/core/src/forms/`, `apps/web/modules/forms/`, `apps/web/app/(admin)/admin/forms/`, `apps/web/app/[locale]/(site)/f/`, `apps/web/app/[locale]/(portal)/account/results/` (R2), `apps/web/app/api/public/forms/`, `packages/core/src/i18n/messages/*/forms.json`, `packages/db/src/seed/forms.ts`, `apps/web/e2e/forms.spec.ts`, `packages/email/src/templates/forms/` (the transactional templates `forms.result` and `forms.result_link`, written by forms with email's `defineTemplate()`; architecture sections 1 and 11, email decision 52).
Blueprint sections: 16, 17 (primary); 3, 4, 5, 6, 30, 33, 34, 35, 44, 53, 59, 60, 61, 62, 63, 66, 76, 83, 84, 87 (secondary).

## 1. Purpose and release mapping

BEAM staff build lead forms, intake forms, surveys, registration forms and scored assessments without a developer. Every published form is an immutable version. Visitors fill it in on a hosted page or an embed on another site. Every completed submission lands on one `persons` record with its source, campaign and UTM, its consent per purpose, its score and its outcome. Sensitive answers (health, sleep, stress, recovery, wellbeing) are encrypted in a separate table and never reach AI, segments or staff exports. The module replaces Typeform and ScoreApp.

| Release | What ships in this module |
| --- | --- |
| **V1 (weeks 1-6)** | Builder with all 14 blueprint field types plus `acknowledgement` (health declarations and waivers), sections, show/hide, skip, branch, conditional sections and endings, multiple conditions. Scoring: weighted answers, dimensions, category and total scores, ranges, thresholds, custom formulas (safe evaluator), outcomes by total, category or answer combinations. Endings and personalised result pages (score, category, explanation, recommendation, CTAs to a booking, event, product, experience or URL). Per-form locales and publish-time completeness. Hosted page `/[locale]/f/[slug]`, embed script, public submit API with rate limits. Person linking (session, identity token, email), prefill and skip of known fields. Started, partial, abandoned (24 h), completed tracking; optional same-browser resume. Result links by token. Sensitive routing to `form_sensitive_answers`. Consent per purpose with wording version; transactional result email. Lead attribution (source, campaign, medium, funnel, UTM, landing path, referrer, partner, tracked link key) written once to `persons.acquisition` in crm's `Acquisition` shape. Activity events for every step, including `assessment.result_generated` and `assessment.cta_clicked`. Staff-assisted entry at reception (source `manual`). Health declaration validity check for reception (`hasValidSubmission`). Seeded forms `contact`, `newsletter`, `health-declaration` and `recovery-check`. ScoreApp/Typeform webhook import plus CSV backfill (stopgap). Funnel and conversion report. Admin list, builder, scoring, preview, versions, submissions list and detail, tracked links with QR download (SVG and PNG, `qrcode` is installed in Wave 0), imports. Health signals for the daily digest and alerts. |
| **Release 2 (weeks 9-10)** | Portal page "My results" (`/[locale]/account/results`). Cross-device resume for logged-in customers. CTA kind `webinar` (the webinar module ships in R2). Per-person form history tab data for the B2C pipeline view. |
| **Release 3 (weeks 11-12)** | Referral links (`form_links.referrer_person_id`) and partner attribution report. Campaign attribution per form (leads, completions, bookings and revenue per `utm_campaign`, cost per lead joined to `ad_spend_daily`). Form KPIs for the marketing dashboard. Contact-form submissions open a thread in the unified inbox. `countLandingConversions()` for site insights. |
| **Release 4 (weeks 13-14)** | Non-sensitive form views exposed to the `ai` schema for natural-language questions and custom dashboards (`ai.form_funnel_daily`, `ai.form_outcomes`). No AI on answers. |
| **Later (out of scope)** | AI interpretation of answers, AI processing of sensitive answers, predictive lead scoring, payments inside a form, file uploads, handwritten e-signatures (V1 waivers use the `acknowledgement` field with a versioned text), A/B testing of form variants, multi-step forms across sessions by email link for anonymous visitors, captcha. |

The V1 stopgap: until the native forms go live (week 6), existing ScoreApp and Typeform assessments keep running and post their results to `/api/public/forms/import/[sourceKey]/[secret]`. Past results are backfilled by CSV upload through the same pipeline. Once a native form replaces an external one, its import source is deactivated.

## 2. Domain model

All tables live in `packages/db/src/schema/forms.ts`; views in `packages/db/src/schema/forms.views.ts`. Conventions from the architecture apply (`id uuid default gen_random_uuid()`, `created_at`, `updated_at` on mutable tables, `pgEnum('<table>_<column>')`, `LocalizedText` jsonb). Wave 0 created a stub `forms` table; forms-P1 completes it without changing the stub's existing columns.

### Enums

| Enum | Values |
| --- | --- |
| `forms_kind` | `lead`, `intake`, `survey`, `assessment`, `registration` (quizzes, scorecards and self-assessments are `assessment`; qualification forms are `lead`) |
| `forms_status` | `draft`, `published`, `archived` |
| `form_submissions_status` | `started`, `partial`, `abandoned`, `completed` |
| `form_submissions_identified_by` | `session`, `token`, `staff`, `email`, `import`, `none` (`staff` = staff-assisted entry, rule ID10) |
| `form_links_channel` | `link`, `qr`, `ad`, `email`, `social`, `partner`, `referral`, `print`, `b2b` |
| `form_import_sources_provider` | `scoreapp`, `typeform` |
| `form_import_events_status` | `received`, `processed`, `skipped`, `failed` |

### `forms`

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| id | uuid | no | `gen_random_uuid()` | PK |
| slug | text | no | | unique index; check `slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) <= 64 and slug not in ('result','import')` |
| kind | forms_kind | no | | |
| name | jsonb (LocalizedText) | no | | staff-facing name; public title lives in `definition.title` |
| description | text | yes | | internal note |
| status | forms_status | no | `'draft'` | check `status <> 'published' or current_version_id is not null` |
| current_version_id | uuid | yes | | FK `form_versions.id` on delete restrict; the version served to visitors |
| created_by_user_id | uuid | yes | | FK `users.id`; null = created by the `defaults` seed |
| archived_at | timestamptz | yes | | set when status becomes `archived` |
| cta_warnings | jsonb | no | `'[]'` | `[{ endingKey, ctaKey, reason: 'inactive_product'\|'past_session'\|'inactive_template'\|'missing_webinar' }]`, overwritten nightly by `forms.check_cta_targets` |
| created_at, updated_at | timestamptz | no | `now()` | |

Indexes: unique `forms_slug_uq (slug)`; `forms_status_idx (status)`.

### `form_versions` (IMMUTABLE once `published_at` is set)

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| id | uuid | no | `gen_random_uuid()` | PK |
| form_id | uuid | no | | FK `forms.id` on delete restrict |
| version | integer | no | | check `version > 0`; unique (form_id, version) |
| definition | jsonb | no | | `FormDefinition` (section 3, rules F1-F4) |
| scoring | jsonb | no | `'{}'` | `FormScoring`; `{}` = not scored |
| sensitive_field_keys | text[] | no | `'{}'` | derived from `definition` on every save; never edited directly |
| locales | text[] | no | `'{nl-BE}'` | check `cardinality(locales) >= 1 and locales <@ array['nl-BE','fr-BE','en']` |
| consent_purposes | text[] | no | `'{}'` | derived: purposes of consent fields |
| definition_hash | text | no | | sha256 of canonical JSON of definition + scoring |
| change_note | text | yes | | shown in the versions list |
| published_at | timestamptz | yes | | null = the editable draft |
| published_by_user_id | uuid | yes | | FK `users.id`; check `published_by_user_id is null or published_at is not null`; null on a published row = published by the `defaults` seed |
| created_by_user_id | uuid | yes | | FK `users.id`; null = `defaults` seed |
| created_at, updated_at | timestamptz | no | `now()` | `updated_at` changes only while draft |

Indexes: unique `form_versions_form_version_uq (form_id, version)`; partial unique `form_versions_one_draft_uq (form_id) where published_at is null` (one draft per form). Invariant: every `update` on this table filters `published_at is null`; a published row is never changed (enforced in `modules/forms/service/versions.ts` and tested).

### `form_submissions`

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| id | uuid | no | `gen_random_uuid()` | PK |
| form_id | uuid | no | | FK `forms.id` (denormalised for reporting) |
| form_version_id | uuid | no | | FK `form_versions.id` on delete restrict; pinned at start |
| person_id | uuid | yes | | FK `persons.id`; null for anonymous or not yet identified |
| status | form_submissions_status | no | `'started'` | |
| identified_by | form_submissions_identified_by | no | `'none'` | |
| answers | jsonb | no | `'{}'` | `{ [fieldKey]: value }`, **non-sensitive fields only** |
| score | jsonb | yes | | `{ total, totalRangeKey, dimensions: { [key]: { value, rangeKey } } }`, non-sensitive dimensions only |
| outcome_key | text | yes | | |
| ending_key | text | yes | | |
| path | text[] | no | `'{}'` | section keys visited, in order |
| current_section_key | text | yes | | for resume |
| utm | jsonb | no | `'{}'` | `{ source, medium, campaign, term, content }` |
| source | text | no | `'website'` | crm's `AcquisitionSource` vocabulary, check in (`website`, `landing_page`, `paid_meta`, `paid_google`, `paid_other`, `organic_search`, `social_media`, `webinar`, `event`, `referral`, `partner`, `customer_introduction`, `walk_in`, `qr_code`, `b2b_campaign`, `import`, `manual`, `other`); derived by rule A2 |
| campaign | text | yes | | `utm_campaign` or link name |
| funnel | text | no | | `FormSettings.funnel` or `form:<slug>` (blueprint 16 and 33 "funnel"), rule A6 |
| link_id | uuid | yes | | FK `form_links.id` |
| referrer_url | text | yes | | origin + path only, no query, max 500 chars |
| landing_path | text | yes | | path of the BEAM page (site `FormEmbed` context) or the embedding page, max 300 chars, no query |
| embed_host | text | yes | | host of the page that embedded the form |
| applied_tag_keys | text[] | no | `'{}'` | tags this submission applied (blueprint 17 "CRM storage: tags"), rule A5 |
| entered_by_user_id | uuid | yes | | FK `users.id`; set for staff-assisted entry (ID10) |
| locale | text | no | | check in (`nl-BE`,`fr-BE`,`en`) and in the version's locales (enforced in code) |
| result_token_hash | text | yes | | sha256 of the result token; unique |
| result_token_version | smallint | no | `1` | bump revokes the link |
| result_token_expires_at | timestamptz | yes | | completed_at + 180 days |
| resume_token_hash | text | yes | | sha256; unique; null when resume is off |
| ip_hash | text | yes | | HMAC of client IP; nulled after 30 days |
| consent_snapshot | jsonb | no | `'[]'` | `[{ purpose, granted, wordingVersion, fieldKey }]` |
| import_event_id | uuid | yes | | FK `form_import_events.id`; partial unique where not null |
| external_ref | text | yes | | ScoreApp or Typeform response id |
| result_email_message_id | uuid | yes | | FK `email_messages.id` |
| started_at | timestamptz | no | `now()` | |
| last_activity_at | timestamptz | no | `now()` | |
| completed_at | timestamptz | yes | | check `(status = 'completed') = (completed_at is not null)` |
| abandoned_at | timestamptz | yes | | check `status <> 'abandoned' or abandoned_at is not null` |
| created_at, updated_at | timestamptz | no | `now()` | |

Indexes: `form_submissions_form_status_idx (form_id, status, started_at desc)`; `form_submissions_person_idx (person_id, form_id, completed_at desc) where person_id is not null` (person tab, `hasValidSubmission`, `v_form_latest_results`); `form_submissions_open_idx (last_activity_at) where status in ('started','partial')` (abandon job); `form_submissions_version_idx (form_version_id)`; `form_submissions_link_idx (link_id) where link_id is not null`; `form_submissions_ip_idx (form_id, ip_hash, started_at) where ip_hash is not null` (rate limit); unique `form_submissions_result_token_uq (result_token_hash)`; unique `form_submissions_resume_token_uq (resume_token_hash)`; partial unique `form_submissions_import_uq (import_event_id) where import_event_id is not null`.

### `form_sensitive_answers` (every value column is SENSITIVE)

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| id | uuid | no | `gen_random_uuid()` | PK |
| submission_id | uuid | no | | FK `form_submissions.id` on delete cascade |
| person_id | uuid | yes | | FK `persons.id`; set when the submission is linked |
| field_key | text | no | | a field key, or `score:<dimensionKey>` for a dimension computed from sensitive fields |
| value_enc | bytea | no | | **SENSITIVE**, declared `sensitive(bytea('value_enc'))`; `encryptSensitive(JSON.stringify(value), aad)` with `aad = 'form_sensitive_answers:<submission_id>:<field_key>'` (AES-256-GCM, platform) |
| key_version | smallint | no | `1` | |
| created_at, updated_at | timestamptz | no | `now()` | |

Indexes: unique `form_sensitive_answers_uq (submission_id, field_key)`; `form_sensitive_answers_person_idx (person_id) where person_id is not null`. Read only through `readSensitive()`.

### `form_links` (addition: tracked links and QR codes)

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| id | uuid | no | `gen_random_uuid()` | PK |
| form_id | uuid | no | | FK `forms.id` |
| key | text | no | | unique; 8 chars `[a-z0-9]`; used as `?l=<key>` |
| name | text | no | | e.g. "Flyer Ghent station" |
| channel | form_links_channel | no | `'link'` | |
| utm | jsonb | no | `'{}'` | defaults applied when the URL has no UTM |
| partner_company_id | uuid | yes | | FK `companies.id` |
| referrer_person_id | uuid | yes | | FK `persons.id` (R3 referral links) |
| is_active | boolean | no | `true` | inactive links still resolve the form but record no link |
| created_by_user_id | uuid | no | | FK `users.id` |
| created_at, updated_at | timestamptz | no | `now()` | |

Indexes: unique `form_links_key_uq (key)`; `form_links_form_idx (form_id)`.

### `form_views_daily` (addition: page-view counter for the funnel; no personal data)

Columns: `id uuid pk`, `form_id uuid not null` FK `forms.id`, `day_on date not null` (Europe/Brussels), `link_key text not null default ''`, `locale text not null`, `views integer not null default 0 check (views >= 0)`, `updated_at timestamptz not null default now()`. Unique `form_views_daily_uq (form_id, day_on, link_key, locale)`; incremented with `insert ... on conflict do update set views = views + 1`.

### `form_import_sources` (addition: V1 stopgap)

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| id | uuid | no | `gen_random_uuid()` | PK |
| key | text | no | | unique; 12 chars `[a-z0-9]`; path segment |
| provider | form_import_sources_provider | no | | |
| name | text | no | | |
| form_id | uuid | no | | FK `forms.id`; mirror form (kind `assessment`) holding a published version whose fields mirror the mapping |
| token_hash | text | no | | sha256 of the 32-byte URL secret; shown once on creation |
| mapping | jsonb | no | | `ImportMapping` (rule I2) |
| is_active | boolean | no | `true` | |
| last_received_at | timestamptz | yes | | |
| created_by_user_id | uuid | no | | FK `users.id` |
| created_at, updated_at | timestamptz | no | `now()` | |

### `form_import_events` (addition: inbox for imported results)

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| id | uuid | no | `gen_random_uuid()` | PK |
| source_id | uuid | no | | FK `form_import_sources.id` |
| external_id | text | no | | Typeform `event_id`, ScoreApp response id, or sha256 of the CSV row |
| payload | jsonb | no | | raw body (person data; deleted after 90 days) |
| email_hash | text | yes | | sha256 of the lower-cased email found by the mapping (erasure lookup) |
| status | form_import_events_status | no | `'received'` | |
| error | text | yes | | |
| submission_id | uuid | yes | | FK `form_submissions.id` on delete set null |
| received_at | timestamptz | no | `now()` | |
| processed_at | timestamptz | yes | | |
| created_at, updated_at | timestamptz | no | `now()` | |

Indexes: unique `form_import_events_uq (source_id, external_id)`; `form_import_events_status_idx (status, received_at)`; `form_import_events_email_idx (email_hash)`.

No table of this module is APPEND (the timeline facts go to `activity_events`, consent to `consent_records`). `form_versions` is IMMUTABLE after publish.

### Views (`forms.views.ts`, Drizzle `pgView` with `.as(sql\`...\`)`)

```sql
-- v_form_funnel_daily: one row per form per Brussels day
create view v_form_funnel_daily as
with s as (
  select form_id, (started_at at time zone 'Europe/Brussels')::date as day_on,
         count(*) as started,
         count(*) filter (where status in ('partial','completed') or path <> '{}') as engaged,
         count(*) filter (where status = 'completed') as completed,
         count(*) filter (where status = 'abandoned') as abandoned
  from form_submissions group by 1, 2),
v as (select form_id, day_on, sum(views)::int as views from form_views_daily group by 1, 2)
select coalesce(s.form_id, v.form_id) as form_id, coalesce(s.day_on, v.day_on) as day_on,
       coalesce(v.views, 0) as views, coalesce(s.started, 0) as started, coalesce(s.engaged, 0) as engaged,
       coalesce(s.completed, 0) as completed, coalesce(s.abandoned, 0) as abandoned
from s full join v on v.form_id = s.form_id and v.day_on = s.day_on;

-- v_form_conversions: what a completed, linked submission led to within 30 days
create view v_form_conversions as
select fs.id as submission_id, fs.form_id, fs.form_version_id, fs.person_id, fs.outcome_key,
       fs.source, fs.campaign, fs.completed_at,
       (select min(b.created_at) from bookings b where b.person_id = fs.person_id
          and b.status in ('confirmed','attended') and b.created_at >= fs.completed_at
          and b.created_at < fs.completed_at + interval '30 days') as first_booking_at,
       (select min(o.paid_at) from orders o where o.person_id = fs.person_id and o.paid_at is not null
          and o.paid_at >= fs.completed_at and o.paid_at < fs.completed_at + interval '30 days') as first_paid_at,
       (select coalesce(sum(o.total_cents), 0) from orders o where o.person_id = fs.person_id
          and o.status = 'paid' and o.paid_at >= fs.completed_at
          and o.paid_at < fs.completed_at + interval '30 days') as revenue_30d_cents
from form_submissions fs where fs.status = 'completed' and fs.person_id is not null;

-- v_form_latest_results: latest completed result per person per form (segments, email content blocks)
create view v_form_latest_results as
select distinct on (fs.person_id, fs.form_id)
       fs.person_id, fs.form_id, f.slug as form_slug, fs.form_version_id, fs.id as submission_id,
       fs.outcome_key, (fs.score ->> 'total')::numeric as total_score, fs.score ->> 'totalRangeKey' as total_range_key,
       fs.completed_at
from form_submissions fs join forms f on f.id = fs.form_id
where fs.status = 'completed' and fs.person_id is not null
order by fs.person_id, fs.form_id, fs.completed_at desc;
```

Tables of other modules this module reads: `persons`, `companies`, `tags`, `consent_records` via `v_consent_current` (crm); `users` (platform); `sessions`, `session_templates`, `bookings` (booking); `products`, `orders` (commerce); `email_messages` (email); `retention_policies` (ops); `webinars` (webinar, R2); `ad_spend_daily` (ops, R3). Tables of other modules it writes, only through their `api.ts`: `persons`, `person_tags`, `consent_records`, `activity_events`, `audit_log`, `jobs`, `email_messages`, `inbox_threads` (R3). Retention rows for forms' own tables are seeded by forms into ops' `retention_policies` (section 9); ops' `privacy.retention_sweep` runs them through forms' `sweep` handlers.

## 3. Business rules

Rules are grouped by prefix. Every rule has at least one test named after it (for example `it('S4: outcome by answer combination')`).

### F. Definition (Zod schemas in `packages/core/src/forms/definition.ts`)

- **F1** `FormDefinition = { title: LocalizedText, intro?: LocalizedText, settings: FormSettings, sections: Section[], fields: Record<FieldKey, Field>, logic: LogicRule[], endings: Ending[] }`. `FormSettings = { resumeEnabled: boolean (default false), resumeDays: 1..30 (default 7), skipKnownFields: boolean (default true), capturePartialLeads: boolean (default false), showProgress: boolean (default true), sendResultEmail: boolean (default true for assessment, false otherwise), submitLabel: LocalizedText, createInboxThread: boolean (R3, default false, true on the seeded contact form; the one inbox switch, cross-module D62), funnel?: string (`^[a-z0-9_-]{1,64}$`, default `form:<slug>`), validityDays?: 1..1095 (how long a completed submission counts as valid for `hasValidSubmission`; default 365 for `intake`, unset otherwise), staffEntryAllowed: boolean (default true for `intake` and `registration`, false otherwise) }`.
- **F2** Field types: `single_choice`, `multiple_choice`, `yes_no`, `rating` (scale 5 or 10), `number` (min, max, step), `short_text` (max 255 chars), `long_text` (max 5,000 chars), `dropdown`, `date` (min/max, ISO `YYYY-MM-DD`), `email`, `phone` (E.164 after normalisation, default region BE), `consent`, `hidden`, `utm`, plus `acknowledgement` (a checkbox under a versioned text, always required, stored as `true` in `answers`; used for health declarations and waivers before sauna, cold plunge or breathwork; house rules and the health self-declaration are chapters of site's `terms` checked with `site.hasAcceptedCurrentTerms`, never a forms field (cross-module D15); it is proof of acknowledgement, not a consent purpose and never writes `consent_records`). Common properties: `key` (`^[a-z][a-z0-9_]{0,39}$`, unique in the form), `type`, `label`, `help?`, `required`, `visibleIf?: Condition`, `sensitive: boolean`, `sensitiveKind?: 'health'|'sleep'|'stress'|'recovery'|'wellbeing'`, `mapsTo?: 'person.email'|'person.first_name'|'person.last_name'|'person.phone'|'person.birth_on'`. Choice fields carry `options: [{ key, label, scores?: Record<DimensionKey, number> }]` (2 to 50 options). `multiple_choice` has `minSelected?`, `maxSelected?`. `consent` carries `purpose` and `wording: LocalizedText`. `acknowledgement` carries `text: LocalizedText` (markdown subset of F5, max 5,000 chars per locale). `hidden` carries `from: 'query'|'constant'`, `param?`, `value?`. `utm` carries `param: 'utm_source'|'utm_medium'|'utm_campaign'|'utm_term'|'utm_content'`.
- **F3** `Section = { key, title?, description?, fieldKeys: FieldKey[], visibleIf?: Condition }`. A section is one page. Every field belongs to exactly one section. Hidden and UTM fields belong to the first section and are never rendered.
- **F4** `Condition` is recursive: `{ all: Condition[] } | { any: Condition[] } | { not: Condition } | { field, op, value? } | { score, op, value } | { range: { dimension, key } }`. Ops: `eq`, `neq`, `in`, `not_in`, `gt`, `gte`, `lt`, `lte`, `contains` (multiple choice), `answered`, `not_answered`. Max nesting depth 6, max 50 leaves per condition.
- **F5** `Ending = { key, kind: 'result'|'thank_you'|'redirect', title, body (LocalizedText, markdown subset: paragraphs, bold, italic, links, lists), showScore: boolean, showDimensions: DimensionKey[], ctas: Cta[] (max 4), redirectUrl?: https URL, email?: { subject: LocalizedText, intro: LocalizedText } }`. `Cta = { key, label: LocalizedText, kind: 'booking'|'event'|'product'|'experience'|'webinar'|'url', sessionTemplateId?, sessionId?, productId?, webinarId?, url? }`. `experience` points at a session template of kind `day` or `night` (a "BEAM Experience"); `event` at a session of kind `event`; `webinar` is accepted from R2.
- **F6** Long-text fields in forms of kind `assessment` or `intake` default to `sensitive: true`; unticking shows a confirmation and is recorded in the version's `change_note`.
- **F7** Limits: 30 sections, 200 fields, 50 outcomes, 20 dimensions, 100 logic rules; definition plus scoring at most 256 KB as JSON. Larger drafts are refused with `validation`.

### L. Logic (`packages/core/src/forms/logic.ts`)

- **L1** `isVisible(field|section, answers, scores)` evaluates `visibleIf`; a hidden field is never required and its answer is dropped from `answers` at submit.
- **L2** `LogicRule = { key, afterSection, if: Condition, then: { goto: SectionKey } | { end: EndingKey } }`. After a section the first matching rule (array order) wins; with no match the next visible section follows; past the last section the form ends.
- **L3** `goto` may only target a later section (forward-only), so every path terminates. Skip = `goto` past sections; branch = several rules on one section; conditional ending = `end`.
- **L4** Conditions may reference only fields in earlier sections or earlier in the same section, and dimensions whose fields all sit in earlier sections.
- **L5** `nextStep(definition, scoring, answers, currentSection)` is pure and is run on the server at every save and at submit; the client runs the same function for display. The server result is authoritative: a client that skips a required visible field gets `validation` with the field keys.
- **L6** Conditions that reference a sensitive field or a sensitive dimension are allowed only in `visibleIf` (show/hide), evaluated in memory. A field whose `visibleIf` references sensitive data, and every field of a section whose `visibleIf` does, is itself sensitive (`deriveSensitiveKeys` adds it), so the presence of a follow-up answer never reveals a health answer. Logic rules (`goto`, `end`) and outcome `when` conditions may not reference sensitive data (publish error `sensitive_in_logic`), because `path`, `ending_key` and `outcome_key` are stored in plain form and outcomes are visible to marketing (S7).
- **L7** Ending resolution at the end of the path: the ending of a matching `end` rule; else the selected outcome's `endingKey` (S4); else the first ending in `endings`. `computePath` therefore never returns `endingKey = null` for a publishable form (P3 requires at least one ending).

### S. Scoring (`packages/core/src/forms/scoring.ts`, `expression.ts`)

- **S1** `FormScoring = { dimensions: Dimension[], total?: { kind: 'sum_dimensions'|'formula', formula?, ranges: Range[] }, outcomes: Outcome[], defaultOutcomeKey? }`. `Dimension = { key, label, kind: 'sum'|'avg'|'formula', formula?, min?, max?, ranges: Range[] }`. `Range = { key, from, to, label, explanation?, recommendation? }` with `from` inclusive and `to` exclusive, except the last range whose `to` is inclusive; ranges of one dimension may not overlap.
- **S2** Weighted answers: a choice option adds `scores[dim]` to that dimension; a `rating` or `number` field adds `value * weight[dim]` from `field.weights?: Record<DimensionKey, number>`; `yes_no` uses options `yes` and `no` with scores. Unanswered or hidden fields add nothing. `avg` divides by the number of answered contributing fields.
- **S3** Formulas run in a safe evaluator: tokenizer plus Pratt parser, no `eval`, no property access, no loops. Grammar: numbers, `dim.<key>`, `answer.<key>` (number, rating, yes_no as 1/0, count for multiple choice), `total`, operators `+ - * / %`, comparisons, `and`, `or`, `not`, parentheses, functions `min`, `max`, `abs`, `round(x, digits)`, `clamp(x, lo, hi)`, `if(cond, a, b)`, `contains(answer.<key>, '<option>')`. Max 500 characters, AST depth 32, 200 nodes. Division by zero or a missing operand yields `null`; a `null` dimension matches no range and no outcome condition.
- **S4** Outcomes: `Outcome = { key, label, priority, when: Condition, endingKey, tagKeys: string[], explanation?, recommendation? }`. Outcomes are evaluated by ascending `priority`; the first whose `when` matches wins (total, category via `range`, or answer combinations via `all`/`any` of field conditions); no match gives `defaultOutcomeKey`; a form without outcomes has no outcome.
- **S5** Dimensions are computed in dependency order; a formula cycle is a publish error.
- **S6** A dimension is sensitive when any contributing field is sensitive or its formula references a sensitive dimension or field. Sensitive dimension values are stored only in `form_sensitive_answers` as `score:<key>`; `form_submissions.score` holds non-sensitive dimensions and the total only when the total does not depend on a sensitive dimension.
- **S7** Outcome keys and labels are visible to marketing, automations and segments. The builder states this next to the outcome editor; an outcome is never treated as sensitive.
- **S8** Scores are computed once at submit with the pinned version and stored. A later version never recomputes them (blueprint 17: changing an assessment does not rewrite history).

### P. Publishing (`packages/core/src/forms/validate.ts` plus server checks)

- **P1** `validateForPublish(definition, scoring, locales): PublishIssue[]` returns blocking `error`s and non-blocking `warning`s; publish fails while any error exists and lists them all.
- **P2** Completeness: every `LocalizedText` in definition and scoring (title, intro, labels, help, options, section titles and descriptions, ending texts, CTA labels, consent wording, acknowledgement text, submit label, dimension, range and outcome labels and texts, email subject and intro) passes `assertComplete(text, locales)`.
- **P3** Structure: unique keys; every field in one section; L3, L4 and L6 hold; every referenced field, section, dimension, range, ending and outcome exists; formulas parse; no dimension cycle; at least one ending; `defaultOutcomeKey` exists when outcomes exist.
- **P4** Every kind except `survey` needs one required `email` field with `mapsTo: 'person.email'`. A `survey` with any sensitive field needs it too, so special-category data always belongs to a person who can export or erase it. `sendResultEmail` needs that field and an `email` block on every `result` ending.
- **P5** A form with any sensitive field needs a required `consent` field with purpose `sensitive_processing` placed in the first section that holds a sensitive field or earlier.
- **P6** Consent fields: purpose in `newsletter|events|member_comms|b2b|sensitive_processing|ai_processing`; `newsletter`, `events`, `member_comms`, `b2b` and `ai_processing` fields must be `required: false` (freely given). One exception: a form whose fields are only email, first name, last name, hidden or UTM fields and exactly one marketing consent (a pure sign-up form such as the seeded `newsletter`) may make that consent required, because subscribing is the whole request and nothing else is offered. `assessment_result` is never a field; it is recorded automatically (C3).
- **P7** Server-side checks at publish: CTA targets exist and are active (`products.is_active`, `session_templates.is_active`, session `status = 'open'` and in the future, webinar exists from R2); outcome `tagKeys` exist in `tags`; slug free and not reserved; a version with non-empty `sensitive_field_keys` publishes only while ops' `isDpiaApproved(tx, 'sensitive_assessment_processing')` is true, i.e. the register row is `approved` or `not_required` (blueprint 66; ops rule 70; cross-module D38), otherwise blocking error `dpia_not_approved` ("The DPIA for sensitive assessment processing is not approved yet", linking to `/admin/privacy/dpia` for staff who may open it). The check runs only at publish: an approval withdrawn later does not unpublish a served version, and a version without sensitive fields never calls it.
- **P8** Warnings (non-blocking): unreachable section or ending, outcome never selectable by its ranges, a long-text field unmarked sensitive on an assessment, a result ending without CTA.
- **P9** Publishing sets `published_at`, `published_by_user_id`, `forms.current_version_id`, `forms.status = 'published'` in one transaction. A new draft is created by copying the current version into `version + 1`. Restoring an old version copies it into a new draft.
- **P10** Archiving sets `status = 'archived'` and `archived_at`; the hosted page shows "This form is closed" and every public endpoint answers `410 form_closed`. Unarchiving restores `published` when a current version exists.
- **P11** A form can be deleted only while no version was ever published (no submissions exist).
- **P12** Form status machine (`forms.status`), every transition tested in `actions.test.ts`:

  | From | To | By | Guard |
  | --- | --- | --- | --- |
  | (none) | `draft` | `createForm`, `duplicateForm` | slug free |
  | `draft` | `published` | `publishVersion` | P1-P7 pass |
  | `published` | `published` | `publishVersion` of a newer draft | P1-P7 pass; `current_version_id` moves |
  | `published` | `archived` | `archiveForm` | slug not in `SYSTEM_FORM_SLUGS` (P13) |
  | `archived` | `published` | `unarchiveForm` | `current_version_id is not null` (always true after a publish) |
  | `draft` | (deleted) | `deleteForm` | no version ever published (P11); slug not in `SYSTEM_FORM_SLUGS` (P13) |

  `archiveForm` on a `draft` form is refused with `conflict` ("delete it instead"); `deleteForm` on `published` or `archived` is refused with `conflict`. No other transition exists.
- **P13** System slugs: `SYSTEM_FORM_SLUGS = ['contact', 'newsletter', 'health-declaration']` (exported from `packages/core/src/forms/seed-definitions.ts`) are stable contracts read by other modules (site's contact page and footer, booking R62b and crm's reception card through `hasValidSubmission`, automation's `form_completed: { slug: health-declaration }` condition in `after-first-booking`). Their slug never changes (`updateFormMeta` refuses a slug change for them even while never published; the seed inserts `on conflict (slug) do nothing` and never renames), `archiveForm` and `deleteForm` on them are refused with `conflict` ("This form is used by the website, booking or automations"), and `duplicateForm` must use a new slug. Their content changes only through new published versions.

### U. Submission lifecycle (`modules/forms/service/submissions.ts`)

- **U1** `started`: created by `POST start` on the visitor's first interaction (first answer or "Start" button), not on page view. The version is pinned to `forms.current_version_id` at that moment.
- **U2** `partial`: at least one section saved. Each save merges answers, updates `path`, `current_section_key`, `last_activity_at`.
- **U3** `completed`: `POST submit` validates every visible required field across the path, computes score and outcome, links the person, writes consent, applies outcome tags, creates the result token, enqueues the result email and records events, all in one transaction.
- **U4** `abandoned`: `forms.mark_abandoned` (every 10 minutes) sets `started` and `partial` submissions with `last_activity_at < now() - interval '24 hours'` to `abandoned`. An abandoned submission never emits `form.completed`, so it never enters a completed-result sequence (blueprint 17).
- **U5** Resume: when `settings.resumeEnabled`, `start` returns a resume token kept in `localStorage` under `beam_form_<slug>`; opening the form within `resumeDays` of `last_activity_at` offers "Continue where you left off". Resuming an `abandoned` submission sets it back to `partial`; its `form.abandoned` event stays on the timeline. Logged-in customers resume their latest open submission of that form on any device (R2).
- **U6** A submission continues on its pinned version even after a newer version is published. A submission of an archived form cannot complete.
- **U7** Submit is idempotent per submission: a second submit of a completed submission returns `200` with the same result URL (the token is derived, rule ID6) and changes nothing.
- **U8** Preview in the admin never writes a submission, an event, a person or an email.
- **U9** Answers are validated per type: choice values must be option keys, numbers within min/max/step, dates within bounds, email by Zod `.email()` lower-cased, phone normalised to E.164, text trimmed and length-capped.
- **U10** A person may complete the same form more than once; each completion is its own submission; `v_form_latest_results` shows the latest.
- **U11** Submission status machine (`form_submissions.status`), every transition tested in `submissions.test.ts`:

  | From | To | By | Guard |
  | --- | --- | --- | --- |
  | (none) | `started` | `POST start` | form `published`; R2-R3 pass |
  | `started` | `partial` | `POST save` | proof of ownership; section valid |
  | `started`, `partial` | `completed` | `POST submit` | U3 validation; form not archived (U6) |
  | `started`, `partial` | `abandoned` | `forms.mark_abandoned` | `last_activity_at` older than 24 h |
  | `abandoned` | `partial` | `GET resume` (U5), or a `save` or `submit` with valid proof of ownership (a `submit` then continues to `completed` in the same transaction) | within `resumeDays` of `last_activity_at` when resume is on; within 24 hours of `abandoned_at` when resume is off (edge case 26) |
  | any | (deleted) | `deleteSubmission`, erasure, retention sweep | |

  `completed` is terminal: a second submit returns the stored result (U7), a save answers `conflict`. Every status update runs `update form_submissions ... where id = $1 and status in (<allowed from>)` after `select ... for update` on the row, so a submit racing the abandon job cannot produce two outcomes: the loser sees zero updated rows and re-reads.

### ID. Identity and prefill

- **ID1** Precedence: customer session (`identified_by = session`) > identity token `?pt=` (`token`) > resume token > typed email at submit (`email`) > none.
- **ID2** Session or token: known fields with `mapsTo` are prefilled from `crm.getPersonPrefill(db, personId)` (first and last name, phone, birth date, postal code, city; the email for the masked line comes from `crm.getPerson(db, personId)`); with `skipKnownFields` they are hidden and a summary line shows first name and masked email (`j•••@gmail.com`) with "Not you?", which drops the identification. With a session the email field is read-only; with a token, changing the email drops the token identification.
- **ID3** At submit the person is found or created by `crm.findOrCreatePersonByEmail` (lower-cased email). A new person gets `locale` = submission locale and `acquisition` from rule A2.
- **ID4** Profile updates go through `crm.updatePersonFields(tx, ctx, personId, patch, { onlyEmpty })` with `patch` from the `mapsTo` values (`firstName`, `lastName`, `phone`, `birthOn`, `postalCode`, `city`; never email, locale or acquisition, which crm refuses there). With `session` or `token` identification submitted values overwrite (`onlyEmpty: false`). With `email` identification only empty person fields are filled (`onlyEmpty: true`); forms compares the submitted values with `crm.getPersonPrefill()` read before the write, keeps differing values in `answers` and lists them in the `form.completed` event `data.profile_conflicts` (field names only; crm's function returns only `changed`). This stops anyone overwriting another person's data by typing their address, and still meets "existing customer record is updated".
- **ID5** Identity tokens: `pt = base64url(payload).base64url(hmac)`, payload `{ p: personId, f: formSlug|null, e: expiryEpochSeconds, s?: staffUserId }` (`s` only for ID10), HMAC-SHA256 with a key derived by HKDF-SHA256 from `AUTH_SECRET` (info `beam-forms-identity`). Default validity 30 days. They identify for prefill and linking only, never for portal access.
- **ID6** Result token = `base64url(HMAC-SHA256(key 'beam-forms-result', submission_id || ':' || result_token_version))`, 43 chars; only its sha256 is stored. Valid until `result_token_expires_at` (180 days). Bumping `result_token_version` revokes it.
- **ID7** The result page recognises the person: its CTAs carry a fresh identity token so a following form, booking or checkout page can prefill through `forms.api.verifyPersonToken()` without asking again.
- **ID8** An expired result link shows "This link has expired" with an email box; `requestResultLink` always answers "If we know this address, we sent you a new link" and, when a completed submission of that form exists for that email, sends a new link (max 3 per email per form per day).
- **ID9** `capturePartialLeads` (default off): when on, a saved section containing a valid email links the submission to a found-or-created person at that save, so `form.started` and `form.abandoned` reach the timeline. When off, an anonymous visitor who never submits leaves no person.
- **ID10** Staff-assisted entry (reception, phone intake; blueprint 16 "manual entry"): `startStaffEntry({ formId, personId })` (permission `persons.write`, so reception and customer service can use it without `forms.write`; only forms with `settings.staffEntryAllowed`) returns the hosted URL with a 2-hour identity token whose payload carries `s: <userId>`. The renderer shows a banner "Entered by staff for <first name>". At submit: `identified_by = 'staff'`, `source = 'manual'`, `entered_by_user_id` set, profile updates follow the `token` rule of ID4. Consents are recorded with `method = 'staff'` and `source = 'staff:<user_id>'`; marketing consents are only recorded when the staff member ticks them on the guest's explicit spoken request; the `sensitive_processing` consent box shows the extra line "The guest has read and confirmed this" and is required as usual (P5). The result email goes to the person as normal. The token payload's `s` is checked against an active staff user at submit; a token minted for staff entry is refused outside the 2 hours.
- **ID11** Health declaration validity: `hasValidSubmission(db, { personId, formSlug })` returns `{ valid, completedAt, expiresAt }` where `valid` means a `completed` submission of any version of that form exists with `completed_at >= now() - validityDays` (F1). Booking uses it to show "Health declaration missing or expired" on the reception check-in list and the portal booking page; whether a missing declaration blocks a customer booking is booking's setting `settings.booking_rules.require_health_declaration` (boolean, default `false`; snake_case per Convention 3 and cross-module D16); booking never blocks check-in or staff bookings on it. crm's `getReceptionCard().declarations.healthDeclarationValid` is built from `hasValidSubmission(db, { personId, formSlug: 'health-declaration' })` (365-day validity, cross-module D15).

### C. Consent

- **C1** A checked consent field calls `crm.recordConsent(tx, ctx, { personId, purpose, status: 'granted', method: 'form', source: 'form:<slug>', wordingVersion: 'form:<slug>:v<version>:<fieldKey>', lawfulBasis: 'consent', ip, userAgent, ref: { type: 'form_submission', id } })`. An unchecked box records nothing (never a withdrawal). When crm answers `needs_confirmation` (the address unsubscribed earlier from that purpose), crm sends its re-subscribe confirmation email; forms stores `{ purpose, granted: false, pendingConfirmation: true }` in `consent_snapshot` and shows "Check your inbox to confirm your subscription" on the ending. `skipped_suppressed` is stored the same way without the message. `skipped_minor` (crm rule 53: the person's stored `birth_on` gives an age under 13 on that day) is stored as `{ purpose, granted: false, skippedMinor: true }` and the ending shows "A parent or guardian must give this consent" (`forms.public.guardian_consent`); the submission still completes. Every outcome of `recordConsent` (`recorded`, `unchanged`, `needs_confirmation`, `skipped_suppressed`, `skipped_minor`) is handled; none rolls back the submit.
- **C2** Consent is written only at submit (or at the save that links the person under ID9), and the snapshot goes into `consent_snapshot`.
- **C3** At submit of a form whose ending is of kind `result` or that has `sendResultEmail`, consent purpose `assessment_result` is recorded as `granted` (method `form`, lawful basis `consent`, `wordingVersion = 'form:<slug>:v<version>:submit'`, the submit button text being the request). It documents fulfilment of the request. No form path ever records `newsletter` unless the visitor ticks an optional newsletter field (acceptance test "a result does not create newsletter consent").
- **C4** The result email is transactional (`kind = transactional`, purpose null, template key `forms.result`): it is not gated on marketing consent, it is blocked by a suppression of scope `all`, and it never enrols the person in a marketing purpose.
- **C5** Age: the marketing age rule is crm's (rule 53, Belgian age of digital consent 13): forms writes a submitted `person.birth_on` through ID4 before it records consents, and when the submitted date gives an age under 13 on the submission day (Brussels) forms does not call `recordConsent` for `newsletter`, `events`, `member_comms` or `b2b` and stores `skippedMinor: true` as in C1 (so a conflicting stored birth date cannot let a grant through); crm's `skipped_minor` covers a stored birth date the form did not ask. Separately, when the submitted date gives an age under 16, the `sensitive_processing` consent fails with a field error "A parent or guardian must complete this form" (special-category data needs explicit consent; forms keeps the stricter age here). Without any birth date no age check is made.

### SE. Sensitive answers

- **SE1** Values of fields in `sensitive_field_keys` are never written to `form_submissions.answers`, `score`, `activity_events.data`, `audit_log`, logs or Sentry. They go only to `form_sensitive_answers`, encrypted with the current `SENSITIVE_DATA_KEY_V<n>`.
- **SE2** Before the `sensitive_processing` consent is checked, the server discards sensitive answers received in a save; the browser keeps them until consent is given. Submit without that consent fails with `validation`.
- **SE3** Decryption happens only in `readSensitive(ctx, personId, purpose, scope?)` (platform's signature, Convention 7 and cross-module D11; `scope = { keys?, eventIds?, submissionIds? }`, result `SensitiveBundle = { fields, formAnswers: { submissionId, fieldKey, value }[], notes }`, forms reads `formAnswers`): staff with `persons.sensitive_read` on the submission detail (purpose `staff_view`, scope `{ submissionIds: [id] }`), the subject on their own result page (purpose `subject_result`, system actor, token-verified, a non-empty `submissionIds` of the person's own submissions) and the privacy export (purpose `privacy_export`, system actor). Each read writes `audit_log` action `sensitive.read` with field keys, never values. The purpose `subject_result` and the `{ submissionIds }` scope are in platform's signature (`SensitivePurpose`, PL-22; section 13, decision 9).
- **SE4** Sensitive fields and sensitive dimensions are never in `AI_ALLOWED_FIELDS` or `SEGMENT_ALLOWED_FIELDS`, never in staff CSV exports, never in the result email. `v_form_latest_results` exposes only outcome and non-sensitive total.
- **SE5** Anonymous `abandoned` submissions (no person) lose their sensitive answers after 30 days (retention key and sweep handler `forms.form_submissions_anonymous_abandoned`, section 9).

### A. Attribution and lead capture

- **A1** `start` reads the landing URL: `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`, `l` (tracked link key), `src` (explicit source), `ref` (embed referrer), and the site context `{ pagePath, landingPath?, referrer?, partnerCompanyId? }` passed by `FormEmbed` (signed into `embedContext`; `pagePath` fills `landing_path` when `landingPath` is absent, `referrer` fills `referrer_url` when the request has none, and the context's `utm` fills missing UTM values). (R3) The submit route also reads site's `beam_ref` cookie with `site.readReferralCode(cookies, searchParams)` and passes the code as `acquisition.referral_code` to `findOrCreatePersonByEmail`; crm resolves it through `credits.resolveReferralCode` when the person is created (crm rule 3.4, cross-module D18). The referral code is never part of the embed context (`FormEmbed` context has no `referralCode`). Values are trimmed to 100 characters and lower-cased for `source` and `medium`. Link UTM defaults fill only missing UTM values.
- **A2** `source` is derived by `deriveSource()` in `packages/core/src/forms/attribution.ts`, first match wins, always a value of crm's `AcquisitionSource`: (1) explicit `src` when it is one of those values (`webinar`, `event`, `manual`, `walk_in`, `customer_introduction` arrive this way from other modules' links); (2) link channel `qr` or `print` → `qr_code`, `partner` → `partner`, `referral` → `referral`, `b2b` → `b2b_campaign`; (3) `utm_medium` in (`cpc`, `paid`, `ppc`, `paid_social`) with `utm_source` in (`facebook`, `instagram`, `meta`, `fb`, `ig`) → `paid_meta`; with `utm_source` in (`google`, `adwords`, `youtube`) → `paid_google`; any other paid medium → `paid_other`; (4) `utm_medium` in (`social`, `organic_social`) → `social_media`; (5) `utm_medium = b2b` → `b2b_campaign`; (6) `utm_medium` in (`organic`, `seo`) or a referrer host of google., bing., duckduckgo., ecosia. → `organic_search`; (7) a `landingPath` of a site page of kind `landing`, or an embed host that is not the BEAM origin → `landing_page`; (8) otherwise `website`. Email traffic (`utm_medium = email`) has no own source value: it falls to (8) or earlier branches and keeps `medium = 'email'`. `campaign` = `utm_campaign` or the link name.
- **A3** `persons.acquisition` is written once, in crm's `Acquisition` shape: `{ source, campaign, medium, funnel, utm, referrer_person_id, partner_company_id, form_slug, referral_code? }` (`referral_code` R3, rule A1; crm adds `captured_at`). It is passed to `findOrCreatePersonByEmail({ acquisition })` at person creation, or later through `crm.fillAcquisitionIfEmpty(tx, ctx, personId, acquisition)` (returns `{ applied }`) when it is still null. It never changes status, queue position or priority (blueprint 3).
- **A4** Every submission keeps its own source, campaign, funnel, UTM, landing path and link even when the person's acquisition was set earlier.
- **A5** Outcome `tagKeys` and an optional form-level tag `form:<slug>` are applied one by one with `crm.applyTag(tx, ctx, personId, tagKey, 'form')`; the keys actually applied are stored in `form_submissions.applied_tag_keys`.
- **A6** `funnel` = `FormSettings.funnel` or `form:<slug>`. It names the journey the lead entered ("recovery-assessment", "webinar-sleep") and is what blueprint 16 and 33 call funnel; reports group by it.

### E. Activity events (recorded with `ctx.recordEvent`, `is_sensitive = false`, `ref_type = 'form_submission'`, `ref_id = submission id`)

Every forms event, `assessment.result_generated` included, is recorded with `is_sensitive = false`, also for versions with `sensitive_field_keys`: rule L6 keeps outcomes and logic off sensitive answers and `score` carries only the non-sensitive total, so automation triggers and segments can read `form_slug` and `outcome_key` (automation section 10). Kind names and `data` keys are the ones crm's timeline and segment compiler expect (crm spec 4.6: `form_slug`, `form_version_id`, `version`, `score`, `outcome_key`, `submission_id`; `SEGMENT_ALLOWED_EVENT_KINDS`); keys are snake_case like every event payload.

| Kind | When | dedupe_key | data |
| --- | --- | --- | --- |
| `form.started` | person known at start, or backfilled at link time with `occurred_at = started_at` | `form:<submission_id>:started` | submission_id, form_id, form_slug, form_kind, form_version_id, version, source, campaign, funnel, utm, link_key |
| `form.completed` | submit | `form:<submission_id>:completed` | the above + outcome_key, score (non-sensitive total or null), dimensions (non-sensitive `{ key: range_key }`), ending_key, applied_tag_keys, profile_conflicts (field names), via_import, entered_by_staff |
| `assessment.result_generated` | submit, when the form has scoring or the ending is of kind `result` (blueprint 17 "result generated") | `form:<submission_id>:result` | submission_id, form_slug, form_kind, form_version_id, version, outcome_key, score (non-sensitive total or null), funnel, source, result_email (`queued`, `not_sent`; a later suppression is decided by `email.send` and shown on the submission detail from `email_messages.status`) |
| `form.abandoned` | abandon job, person known | `form:<submission_id>:abandoned` | submission_id, form_slug, form_version_id, last_section_key, answered_count |
| `form.result_viewed` | result page beacon | `form:<submission_id>:viewed:<YYYY-MM-DD>` | submission_id, form_slug, outcome_key |
| `assessment.cta_clicked` | CTA redirect | `form:<submission_id>:cta:<cta_key>:<YYYY-MM-DD>` | submission_id, form_slug, outcome_key, cta_key, cta_kind, target_id, fallback |

- **E1** Events without a person are not recorded (the timeline requires a person); funnel numbers come from `form_submissions` and `form_views_daily` instead.
- **E2** Events never contain answer values, only keys, counts, scores of non-sensitive dimensions and outcome.
- **E3** Booking and purchase after a form are not new form events; they are the booking and commerce events, joined in `v_form_conversions`.
- **E4** Every event is written in the same transaction as the state change that causes it; the dedupe key makes a retried request or job harmless.

### R. Rate limits and abuse

- **R1** Vercel WAF limits `/api/public/forms/*` to 20 requests per minute per IP (architecture).
- **R2** Through platform's `rateLimit(tx, { key, limit, windowSeconds })`: `start` at most 30 per form per IP per hour (key `form_start:<form_id>:<ip_hash>`); `submit` at most 5 completions per form per email per hour (key `form_submit:<form_id>:<sha256(lower(email))>`); `requestResultLink` at most 3 per form per email per day (key `form_link:<form_id>:<email_hash>`, ID8). Excess returns `429 rate_limited` with `retry-after`.
- **R3** A honeypot field `website` and a minimum of 3 seconds between `start` and `submit`; a hit returns a normal-looking `200` thank-you, writes nothing and logs `forms.bot_dropped` (ids only).
- **R4** Request bodies above 64 KB return `413`.

### I. Import stopgap (ScoreApp and Typeform)

- **I1** `POST /api/public/forms/import/[sourceKey]/[secret]`: the sha256 of `secret` must equal `token_hash` (constant-time compare) and the source must be active, else `404`. The body is stored with `insert ... on conflict (source_id, external_id) do nothing`; `forms.process_import` is enqueued only when the insert happened. Response `200` within 2 seconds.
- **I2** `ImportMapping = { email: JsonPath, firstName?, lastName?, phone?, locale?, externalId: JsonPath, completedAt?: JsonPath, score?: JsonPath, outcome?: JsonPath, outcomeMap?: Record<string, OutcomeKey>, answers: Record<FieldKey, JsonPath>, sensitiveFieldKeys: FieldKey[], consents?: Record<Purpose, JsonPath> }`. JsonPath is a dotted path with `[n]` indexes; Typeform answers are addressed by `form_response.answers[field.ref=<ref>]`.
- **I3** Processing creates a `completed` submission on the mirror form's current version with `identified_by = 'import'`, `source = 'import'`, `external_ref`, finds or creates the person (ID3 and ID4 rules for `email`), stores sensitive mapped answers in `form_sensitive_answers`, writes `form.completed` with `via_import: true` (and `assessment.result_generated` when the mirror form has scoring). A consent maps to granted only when the payload value is literally true, recorded with `method = 'import'` and `source = 'form_import:<source_key>'`; `newsletter` is never inferred. crm's rule that an import never lifts a suppression applies unchanged.
- **I4** Imported results never send the result email (the external tool already did). A payload without a valid email is `skipped` with the reason.
- **I5** CSV backfill: staff upload a CSV export (max 2 MB, 5,000 rows) on the source page; each row becomes a `form_import_events` row with `external_id = sha256(row)` and the same job. Duplicate uploads are harmless.

## 4. Server surface

### Server actions (`apps/web/modules/forms/actions.ts`, all `audience: 'staff'` unless stated)

| Action (`name`) | Input (Zod summary) | Output | Permission | Audit action / events |
| --- | --- | --- | --- | --- |
| `createForm` (`forms.create`) | `{ slug, kind, name: LocalizedText, locales: Locale[], template?: 'blank'\|'lead'\|'assessment' }` | `{ formId, versionId }` | `forms.write` | `forms.created` |
| `updateFormMeta` (`forms.update_meta`) | `{ formId, slug?, name?, description? }`; slug change only while never published and never for `SYSTEM_FORM_SLUGS` (P13) | `{ ok }` | `forms.write` | `forms.updated` |
| `saveDraft` (`forms.save_draft`) | `{ formId, versionId, definition: FormDefinition, scoring: FormScoring, locales, changeNote?, expectedHash }` | `{ definitionHash, issues: PublishIssue[] }`; `conflict` when `expectedHash` differs (another editor saved) | `forms.write` | `forms.draft_saved` (old and new `definition_hash` only, not the JSON) |
| `createDraft` (`forms.create_draft`) | `{ formId, fromVersionId? }` (default current) | `{ versionId }`; `conflict` if a draft exists | `forms.write` | `forms.draft_created` |
| `discardDraft` (`forms.discard_draft`) | `{ formId, versionId }` | `{ ok }` | `forms.write` | `forms.draft_discarded` |
| `publishVersion` (`forms.publish`) | `{ formId, versionId, changeNote }` | `{ version }` or `validation` with `PublishIssue[]` | `forms.publish` | `forms.published` (version, hash) |
| `archiveForm` (`forms.archive`) / `unarchiveForm` (`forms.unarchive`) | `{ formId }`; P12 guards | `{ ok }` | `forms.publish` | `forms.archived` / `forms.unarchived` |
| `deleteForm` (`forms.delete`) | `{ formId }`; only per P11 | `{ ok }` | `forms.publish` | `forms.deleted` |
| `duplicateForm` (`forms.duplicate`) | `{ formId, newSlug, name }` | `{ formId }` | `forms.write` | `forms.created` (with `duplicatedFrom`) |
| `createLink` (`forms.create_link`) / `updateLink` (`forms.update_link`) | `{ formId, name, channel, utm?, partnerCompanyId?, referrerPersonId? (R3) }` / `{ linkId, ...partial, isActive? }` | `{ linkId, key, url }` | `forms.write` | `forms.link_created` / `forms.link_updated` |
| `revealSensitiveAnswers` (`forms.reveal_sensitive`) | `{ submissionId }`; calls `readSensitive(ctx, personId, 'staff_view', { submissionIds: [submissionId] })` | `{ answers: { fieldKey, label, value }[] }` (mapped from the bundle's `formAnswers`, labels of the pinned version) | `persons.sensitive_read` | `sensitive.read` (written by `readSensitive`) |
| `resendResultEmail` (`forms.resend_result`) | `{ submissionId }`; max 3 per submission (key `form_result:<submission_id>:resend:<n>`) | `{ emailMessageId }` | `forms.write` | `forms.result_resent` |
| `revokeResultLink` (`forms.revoke_result_link`) | `{ submissionId }` | `{ ok }` | `forms.write` | `forms.result_link_revoked` |
| `deleteSubmission` (`forms.delete_submission`) | `{ submissionId, reason: 'spam' \| 'test' \| 'subject_request' }` (`subject_request` = the person asked to remove one result without full erasure) | `{ ok }` | `forms.publish` | `forms.submission_deleted` (reason, no answers) |
| `createImportSource` (`forms.create_import_source`) | `{ provider, name, mapping: ImportMapping, mirrorFields: Field[] }` | `{ sourceId, url }` (secret shown once) | `forms.publish` | `forms.import_source_created` |
| `updateImportSource` (`forms.update_import_source`) | `{ sourceId, name?, mapping?, isActive? }` | `{ ok }` | `forms.publish` | `forms.import_source_updated` |
| `rotateImportSecret` (`forms.rotate_import_secret`) | `{ sourceId }` | `{ url }` | `forms.publish` | `forms.import_secret_rotated` |
| `uploadImportCsv` (`forms.upload_import_csv`) | `{ sourceId, csv: string (max 2 MB) }` | `{ inserted, duplicates }` | `forms.publish` | `forms.import_csv_uploaded` (counts) |
| `reprocessImportEvent` (`forms.reprocess_import`) | `{ eventId }` (status `failed` or `skipped`) | `{ jobId }` | `forms.publish` | `forms.import_reprocessed` |
| `startStaffEntry` (`forms.start_staff_entry`) | `{ formId, personId, locale? }` (locale defaults to `persons.locale`); form must have `settings.staffEntryAllowed` | `{ url }` (2-hour identity token with `s`, rule ID10) | `persons.write` | `forms.staff_entry_started` |
| `requestResultLink` (public, `audience: 'public'`) | `{ slug, email, locale }` | always `{ ok: true }` | none; rate-limited (ID8) | no audit; enqueues email when matched |

### Queries (`apps/web/modules/forms/queries.ts`)

- `listForms(db, { status?, kind?, q? }): FormListRow[]` with 30-day started, completed and completion rate from `v_form_funnel_daily` (`forms.write`).
- `getForm(db, formId): FormDetail` (form, current version, draft, link count) (`forms.write`).
- `getFormVersion(db, versionId): FormVersion`; `listVersions(db, formId): VersionRow[]`; `diffVersions(db, aId, bId): VersionDiff` (fields, logic, scoring added, removed, changed) (`forms.write`).
- `listSubmissions(db, { formId, status?, outcomeKey?, versionId?, source?, from?, to?, q?, cursor? }): Page<SubmissionRow>` (50 per page; `q` matches person email or name) (`forms.write` and `persons.read`).
- `getSubmission(db, submissionId): SubmissionDetail` (answers rendered against the pinned version, score, outcome, path, events, `hasSensitive`) (`forms.write` and `persons.read`).
- `getFormReport(db, { formId, from, to, groupBy: 'day'|'version'|'source'|'campaign'|'funnel'|'link' }): FormReport` (views, started, engaged, completed, abandoned, completion rate = completed / started, outcome distribution, conversion to booking and purchase within 30 days, revenue) (`reports.read` or `forms.write`).
- `listLinks(db, formId)`; `listImportSources(db)`; `listImportEvents(db, { sourceId, status?, cursor? })` (`forms.write`).
- Public (no permission, used by the hosted page): `getPublishedForm(db, slug, locale): PublicForm | { closed } | { unavailableLocale, locales } | null`, `getResultByToken(db, token): PublicResult | { expired } | null`.

### Route handlers (`apps/web/app/api/public/forms/`, `runtime = 'nodejs'`, `dynamic = 'force-dynamic'`, JSON, `cache-control: no-store` unless noted)

| Route | Body / params | Response | Effects |
| --- | --- | --- | --- |
| `POST /api/public/forms/[slug]/view` | `{ locale, linkKey? }` | `204` | upsert `form_views_daily` |
| `POST /api/public/forms/[slug]/start` | `{ locale, url, referrer?, embedHost?, identityToken?, embedContext?, honeypot }`; `embedContext` is the HMAC-signed `{ pagePath, landingPath?, referrer?, partnerCompanyId?, utm? }` that `FormEmbed` renders server-side from site's `context` prop (key derived from `AUTH_SECRET`, info `beam-forms-embed`); unsigned or tampered context is ignored | `{ submissionId, resumeToken?, prefill?: { firstName, maskedEmail, known: FieldKey[] } }` | insert submission; `form.started` when person known |
| `GET /api/public/forms/[slug]/resume?token=` | | `{ submissionId, answers (non-sensitive), currentSectionKey }` or `404` | status `abandoned` → `partial` |
| `POST /api/public/forms/[slug]/save` | `{ submissionId, resumeToken?, sectionKey, answers }` | `{ next: { sectionKey } \| { end: true } }` or `validation` | merge answers, sensitive split (SE2), ID9 |
| `POST /api/public/forms/[slug]/submit` | `{ submissionId, resumeToken?, answers, honeypot }` | `{ resultUrl?, redirectUrl?, endingKey }` | rule U3; the route named in the architecture |
| `POST /api/public/forms/result/[token]/viewed` | | `204` | `form.result_viewed` |
| `GET /api/public/forms/result/[token]/go/[ctaKey]` | | `302` to the CTA target with `pt=<identity token>` | `assessment.cta_clicked` |
| `POST /api/public/forms/import/[sourceKey]/[secret]` | provider payload | `200` | rule I1 |
| `GET /api/public/forms/embed.js` | | JavaScript, `cache-control: public, max-age=3600` | none |

Ownership of a submission on `save` and `submit`: the request must carry the `submissionId` plus either the resume token, or a session or identity token that matches the submission's person, or the signed `fsid` cookie (`HttpOnly`, `SameSite=None; Secure`, 24 hours, HMAC of the submission id) set by `start`. Otherwise `404`. Errors use the `action()` codes as JSON `{ ok: false, error: { code, message, fields? } }`; `410 form_closed`, `413`, `429 rate_limited`.

CTA targets for `go/[ctaKey]`: `booking` and `experience` → `/[locale]/account/book?template=<sessionTemplateId>` (booking's portal page; it preselects the tab of the template's kind and filters on the template); `event` → `site.getEventPageUrl(db, sessionId, locale)` (the event page, or `/[locale]/account/book/<sessionId>` when no page exists); `product` → `/[locale]/account/shop?product=<productId>` (commerce's shop opens that product); `webinar` (R2) → `/[locale]/webinars/<webinar slug>` (resolved from `webinarId`); `url` → the URL (https only, with `utm_source=beam_form&utm_medium=result&utm_campaign=<slug>` appended). Every internal target gets `pt=<identity token>` (ID7). The redirect is `302` with `cache-control: no-store`.

### Jobs (`apps/web/modules/forms/jobs.ts`, `defineJob`)

| Kind | Lane, priority | Input | Idempotency key | Retry | Behaviour |
| --- | --- | --- | --- | --- | --- |
| `forms.mark_abandoned` | fast, 5 | `{ n?: number }` | `schedule:forms.mark_abandoned:<YYYY-MM-DDTHH:mm>`; continuation `form_abandon:<YYYY-MM-DDTHH:mm>:<n>` | 6 attempts, default backoff | selects up to 1,000 open submissions past 24 h with `for update skip locked`, sets `abandoned` with the guarded update of U11, records `form.abandoned`; enqueues its continuation with `n + 1` when 1,000 were updated |
| `forms.process_import` | fast, 5 | `{ importEventId }` | `form_import:<import_event_id>` | 6 attempts; invalid mapping or missing email → `PermanentError`, event `skipped` | rule I3; locks the event row `for update`; a second run sees `status = processed` and returns |
| `forms.send_result_link` | fast, 1 | `{ submissionId, locale }` | `form_result_link:<submission_id>:<YYYY-MM-DD>:<n>` (n = 1..3, ID8) | 6 | calls `email.sendTransactional(ctx, { template: 'forms.result_link', personId, locale, data: FormResultLinkProps, key: 'form_result_link:<submission_id>:<YYYY-MM-DD>:<n>' })` with a fresh result URL |
| `forms.check_cta_targets` | bulk, 9 | `{}` | `schedule:forms.check_cta_targets:<YYYY-MM-DDTHH:mm>` | 3 | for every published current version, checks CTA targets (P7 rules); writes the list of broken CTAs into the form overview's warning (stored in `forms.cta_warnings jsonb`) and records nothing else; idempotent because it overwrites the list |

Retention is not a forms job: ops' `privacy.retention_sweep` (01:00) calls the `sweep` handlers forms registers in `privacy.ts` (section 9).

The result email itself is not a forms job: `submit` calls `email.sendTransactional(ctx, { template: 'forms.result', personId, locale, data: FormResultProps, key: 'form_result:<submission_id>:email' })` inside its transaction (`ctx.tx`), which inserts `email_messages`, enqueues `email.send` and returns `{ emailMessageId, jobId }`; forms stores `emailMessageId` in `result_email_message_id`, and `after()` sends it within seconds. The input carries no `purpose` (a transactional message has none, email decision 6), and the call never throws for content problems, so the email can never roll back a submission.

### Schedules (`apps/web/modules/forms/schedules.ts`, cron in Europe/Brussels)

- `forms.mark_abandoned`: `*/10 * * * *`.
- `forms.check_cta_targets`: `50 2 * * *` (after `files.purge_expired` at 02:00, before `sessions.materialise` at 03:10).

### Event definitions (`apps/web/modules/forms/events.ts`, `defineEvent`)

`form.started`, `form.completed`, `assessment.result_generated`, `form.abandoned`, `form.result_viewed`, `assessment.cta_clicked`, each with a Zod `data` schema matching the table in section 3 (E). Automation triggers and crm segment event rules filter on `data.form_slug`, `data.form_kind`, `data.outcome_key`, `data.source`, `data.funnel`, `data.cta_key`.

### Cross-module API (`apps/web/modules/forms/api.ts`)

```ts
import type { DbOrTx } from '@beam/db';
import type { Locale, LocalizedText } from '@beam/core/i18n';
import type { AcquisitionSource } from '@beam/core/crm';

export type PublicFormRef = { id: string; slug: string; kind: FormKind; name: LocalizedText; locales: Locale[] };
export type PersonSubmissionSummary = { submissionId: string; formId: string; formSlug: string; formName: LocalizedText;
  version: number; status: SubmissionStatus; outcomeKey: string | null; outcomeLabel: LocalizedText | null;
  total: number | null; source: string; campaign: string | null; startedAt: Date; completedAt: Date | null; hasSensitive: boolean };
export type LatestOutcome = { formSlug: string; outcomeKey: string; totalScore: number | null; completedAt: Date };

/** Site pages and pickers (site, automation, email). */
export function listPublishedForms(db: DbOrTx): Promise<PublicFormRef[]>;
/** Site publish check for `form_embed` blocks; null when the slug is not a published form. */
export function getPublishedFormMeta(db: DbOrTx, slug: string): Promise<{ formId: string; locales: Locale[] } | null>;
/** Outcome keys and labels of the current version (automation `where`, email content blocks). */
export function listOutcomes(db: DbOrTx, formSlug: string): Promise<{ key: string; label: LocalizedText }[]>;
/** Person page tab (crm) and portal. Never includes answer values. */
export function listPersonSubmissions(db: DbOrTx, personId: string): Promise<PersonSubmissionSummary[]>;
/** Latest outcome per form for many persons (ops profile, R3 dashboards). */
export function getLatestOutcomes(db: DbOrTx, personIds: string[]): Promise<Map<string, LatestOutcome[]>>;
/** Email's dynamic "assessment outcome" block: personId -> latest outcome key of that form (persons without one are absent). */
export function listLatestOutcomes(tx: DbOrTx, personIds: string[], formSlug: string): Promise<Map<string, string>>; // email's name and argument order; latest completed submission per person, any version
/** Reception check-in and booking: is there a completed, unexpired submission (ID11)? */
export function hasValidSubmission(db: DbOrTx, input: { personId: string; formSlug: string }): Promise<{ valid: boolean; completedAt: Date | null; expiresAt: Date | null }>;
/** Prefill links in emails and on result pages; identification only, never login. */
export function createPersonToken(personId: string, opts?: { formSlug?: string; ttlDays?: number }): string;
export function verifyPersonToken(token: string): { personId: string; formSlug: string | null; expiresAt: Date; staffUserId: string | null } | null;
/** Absolute hosted-form URL with optional identity token and UTM (email, automation, webinar). */
export function buildFormUrl(input: { slug: string; locale: Locale; personId?: string; src?: AcquisitionSource;
  utm?: Partial<Record<'source' | 'medium' | 'campaign' | 'term' | 'content', string>>; linkKey?: string }): string;
/** Site insights (R3): submissions and new persons per landing path and campaign. */
export function countLandingConversions(db: DbOrTx, input: { from: Date; to: Date }): Promise<{ landingPath: string; utmCampaign: string | null; submissions: number; newPersons: number }[]>;
/** Daily digest and alerts (ops, platform). */
export function getFormsHealth(db: DbOrTx, input: { day: string /* YYYY-MM-DD Brussels */ }): Promise<{ completions: number; started: number;
  importFailed: number; importSkipped: number; deadJobs: number; formsWithBrokenCtas: number }>;
/** Server component for site page blocks: renders a published form inline (same origin). */
export { FormEmbed } from './ui/public/form-embed';
// props (site's published names): { slug: string; locale: Locale; context: { pagePath: string; utm?: Partial<Record<'source' | 'medium' | 'campaign' | 'term' | 'content', string>>;
//   landingPath?: string; referrer?: string; partnerCompanyId?: string } }; FormEmbed signs the whole context into embedContext.
// No referralCode prop: the R3 code is read from the `beam_ref` cookie by the submit route (site rule 63, site decision 57).
```

## 5. Screens

All admin screens use `requirePermission()` and hide nav entries through `modules/forms/nav.ts` (entry "Forms" under Marketing, permission `forms.write`; entry "Fill in a form" under Customers, permission `persons.write`, pointing to `/admin/forms/enter`). Loading states use skeletons from `@beam/ui`; action errors show a toast with the error code's message; a missing translation renders `⟦forms.screen.element⟧`.

### Staff back-office (`apps/web/app/(admin)/admin/forms/`)

| Route | Shows | Actions | Empty / error states | Permission |
| --- | --- | --- | --- | --- |
| `/admin/forms` | DataTable: name, slug, kind, status, current version, locales, started and completed (30 days), completion rate; filters status and kind; search | New form, duplicate, archive, open | "No forms yet. Create a lead form or an assessment." with two template buttons | `forms.write` |
| `/admin/forms/new` | slug, kind, name (LocalizedInput), locales, template | `createForm` → builder | slug taken: inline field error | `forms.write` |
| `/admin/forms/[formId]` | overview: status, current version, draft badge, hosted URL with copy, embed snippet, last 7 days funnel, links count, import source if any | Edit draft, publish, archive or unarchive, delete (never published only) | archived banner; `cta_warnings` banner "2 result buttons point to something that is no longer available" with links to the endings | `forms.write` |
| `/admin/forms/[formId]/build` | three panes: section and field tree (drag to reorder), field editor (type, label, help, required, options with scores, `mapsTo`, sensitive toggle with kind, visibility condition builder), right pane tabs "Logic" (rules per section), "Endings" (ending editor with CTAs and email texts), "Settings" (F1 settings, locales). Issues panel from `validateForPublish` live; completeness badge per locale | autosave `saveDraft` 5 s after the last change; Publish (dialog with change note and the issue list) | no draft: "Create a draft from version n" button; save conflict: dialog "Someone else saved this draft" with reload | `forms.write`; Publish button needs `forms.publish` |
| `/admin/forms/[formId]/scoring` | dimensions (kind, formula editor with syntax check, ranges), total, outcomes (priority order, condition builder over scores, ranges and answers, ending, tags); formula tester with sample values | saved through `saveDraft` | "This form has no scoring. Add a dimension to score answers." | `forms.write` |
| `/admin/forms/[formId]/preview?version=&locale=` | the public renderer in an iframe with a "Preview, nothing is saved" bar; a side panel shows visited path, live scores, matched outcome, ending; locale switch | restart, jump to section | invalid draft: issue list with links to the builder | `forms.write` |
| `/admin/forms/[formId]/versions` | list: version, published at and by, change note, submissions count; read-only view; compare two versions (diff by field, logic, scoring) | Restore as draft | only a draft: "Not published yet" | `forms.write` |
| `/admin/forms/[formId]/submissions` | DataTable: started, completed, status, person (link to `/admin/persons/[id]`), outcome, total, version, source, campaign, funnel, entered by (staff entry); filters status, outcome, version, source, funnel, date; cursor paging | Export CSV (non-sensitive columns only), open | "No submissions yet. Share the form link." | `forms.write` and `persons.read` |
| `/admin/forms/[formId]/submissions/[submissionId]` | answers per section as the visitor saw them (labels of the pinned version, in staff locale), hidden and UTM values, score per dimension with range, outcome, ending, path, consent snapshot, attribution, timeline of form events, result email status; sensitive answers as a locked card "n sensitive answers" | Reveal sensitive answers (audited), resend result email, revoke result link, delete submission | person null: "Anonymous submission"; deleted person: "Erased person" | view: `forms.write` and `persons.read`; reveal: `persons.sensitive_read`; delete: `forms.publish` |
| `/admin/forms/[formId]/submissions/export` (route handler `route.ts`) | CSV download | | | `forms.write` and `persons.read`, audit `forms.submissions_exported` |
| `/admin/forms/[formId]/links` | tracked links: name, channel, URL, partner, starts, completions; QR download as SVG and PNG (1024 px, error correction M) per link | create, edit, deactivate, copy URL | "No tracked links. Create one per flyer, partner or ad." | `forms.write` |
| `/admin/forms/[formId]/report` | funnel (views, started, engaged, completed, abandoned), completion rate, outcome distribution, conversions to booking and purchase within 30 days with revenue; group by day, version, source, campaign, link; date range | CSV of the table | "Not enough data yet" below 1 started | `reports.read` or `forms.write` |
| `/admin/forms/enter?personId=` | reception and phone intake: person summary (first name, masked email), list of published forms with `staffEntryAllowed`, the person's health declaration status from `hasValidSubmission` ("valid until 12 Mar 2027" or "missing") | Start (calls `startStaffEntry`, opens the hosted form in a new tab with the staff banner) | no eligible form: "No form allows staff entry. Enable it in the form settings." | `persons.write` |
| `/admin/forms/imports` | import sources: provider, name, mirror form, last received, counts per status | create source (wizard: provider, field mapping, mirror fields), deactivate | "No import sources." | `forms.publish` |
| `/admin/forms/imports/[sourceId]` | webhook URL (secret masked), mapping, events table (received, status, error, submission link) | rotate secret, upload CSV, reprocess failed | | `forms.publish` |

The crm person page (`/admin/persons/[id]`) shows a "Forms" tab built by crm from `forms.api.listPersonSubmissions()`; it links to the submission detail and to `/admin/forms/enter?personId=<id>` ("Fill in a form with this person").

### Public (`apps/web/app/[locale]/(site)/f/[slug]/`)

| Route | Shows | Audience |
| --- | --- | --- |
| `/[locale]/f/[slug]` | the hosted form: title, intro, one section per page, progress bar, prefill summary (ID2), resume offer (U5), localised validation, submit; on finish the ending (thank-you, result or redirect). Mobile first, WCAG 2.1 AA: every input has a visible `<label>`; choice fields are `fieldset`/`legend`; required marked in text, not colour only; on a failed save focus moves to an error summary with links to the fields and errors are announced through `aria-live="polite"`; full keyboard use (rating and choice groups by arrow keys); touch targets at least 44 px; contrast 4.5:1 from the `@beam/ui` tokens; `prefers-reduced-motion` disables transitions; no time limit except the invisible 3-second bot rule; the progress bar has a text equivalent "Step 2 of 5"; `lang` follows the locale. `?embed=1` renders without site header and footer and posts its height to the parent (`postMessage({ type: 'beam-form:height', h })`). On a completed submit (the ending is shown) the renderer emits the browser event `beam-form:completed` exactly once per submission: inline (`FormEmbed` on the BEAM site) it dispatches `window.dispatchEvent(new CustomEvent('beam-form:completed', { detail }))`; inside the iframe it posts `postMessage({ type: 'beam-form:completed', ...detail }, parentOrigin)` and `embed.js` re-dispatches it as the same `CustomEvent` on the host page's `window`. `detail = { slug, kind, locale, endingKind: 'thank_you' \| 'result' \| 'redirect' }`: no person id, email, answers, score or outcome, so consent-gated ad tags (site R3 conversion tags) may read it. A bot-dropped submit (R3) and an idempotent second submit (U7) emit nothing | public |
| `/[locale]/f/[slug]/r/[token]` | personalised result: score (when `showScore`), dimensions with range labels and explanations, outcome label, explanation, recommendation, CTAs (BEAM experience, booking, event, product, webinar, URL); sensitive dimension values decrypted for the subject (SE3) | holder of the result token |

States: unknown slug, or a form with no published version (for example `health-declaration` before the DPIA decision, cross-module D39) → the "form not available" page (`f/[slug]/not-found.tsx`, status 404); archived → "This form is closed"; locale not in `locales` → "This form is not available in your language" with links to the available locales (never a mixed page); expired result → ID8 email box; revoked or unknown token → 404; network error on save → inline "Could not save, retrying" with three retries at 1, 3, 9 seconds, then a retry button; 429 → "Too many attempts, try again in a few minutes". Loading: the first section renders server-side; section transitions show a button spinner.

Embed script (`/api/public/forms/embed.js`, under 4 KB, no dependencies): finds `<div data-beam-form="<slug>" data-locale="nl|fr|en">`, creates an iframe to `/<locale>/f/<slug>?embed=1&embedHost=<location.host>&ref=<origin+path>` plus the parent page's `utm_*`, `l` and `src` query values, `loading="lazy"`, `title` from the form, and resizes on `beam-form:height` messages from the BEAM origin only; a `beam-form:completed` message from the BEAM origin is re-dispatched as `CustomEvent('beam-form:completed')` on `window` with the same `detail`. On the BEAM site itself the site module renders `FormEmbed` inline instead (same renderer, with the signed `embedContext`).

### Customer portal (R2, `apps/web/app/[locale]/(portal)/account/results/`)

| Route | Shows | Audience |
| --- | --- | --- |
| `/[locale]/account/results` | the customer's completed submissions: form title, date, outcome label, "View result" (opens the result page through a fresh token), and open submissions with "Continue" | logged-in customer, filtered on `ctx.actor.personId` |

Empty: "You have not completed an assessment yet" with a link to the featured form (`settings` key none; the newest published assessment).

## 6. Integrations

This module calls no external provider directly. ScoreApp and Typeform call us (inbound webhook, rule I1); there is no outbound client, so there is no `packages/integrations` client and no `fake.ts` for them. Test fixtures with real-shaped payloads live in `apps/web/modules/forms/__fixtures__/{typeform,scoreapp}.json`.

- Email goes through `email.sendTransactional` (Resend behind it, owned by email).
- R3 inbox threads go through `crm.createInboxThreadFromForm(tx, ctx, { personId, submissionId, subject, body })`; R3 ad cost is read from `ad_spend_daily`.
- Inbound import idempotency: unique `(source_id, external_id)` plus job key `form_import:<import_event_id>`. Failure handling: a job that fails 6 times is `dead` and visible on `/admin/system/jobs` and on the source page with Reprocess. Typeform retries for up to 24 hours on non-2xx; we answer `200` as soon as the row is stored, so its retries only happen when our insert failed.

Monitoring (the SLA treats "lead forms not accepting submissions" as Critical, since leads are lost):
- Better Stack checks `GET /nl/f/contact` every 5 minutes (200 and the form title in the HTML); failure alerts `#beam-alerts`.
- `start`, `save` and `submit` errors with code `internal` go to Sentry with tags `form_slug` and `route` (ids only, `beforeSend` strips bodies); Sentry alert when more than 5 `internal` errors on `/api/public/forms/*` in 10 minutes.
- Dead `forms.*` jobs alert through platform's dead-job rule; `form_import_events` with status `failed` older than 1 hour raise one Slack line per source per day (fingerprint `forms-import:<source_key>`).
- `ops.daily_digest` adds one line from `getFormsHealth()`: completions and starts yesterday, import failures and skips, forms with broken CTAs.
- A published form with at least 20 views and zero completions on a Brussels day appears in the digest as "check form <slug>" (a broken form looks like that).

## 7. Permissions and audit

This module declares no new permission strings. `modules/forms/permissions.ts` registers `forms.write` and `forms.publish` (both in the architecture's list) and uses `persons.read`, `persons.sensitive_read` and `reports.read` from crm and ops.

| Capability | Permission | Default roles |
| --- | --- | --- |
| See forms, build drafts, preview, links, resend result email, revoke result link | `forms.write` | owner, technical_admin, management, marketing |
| Publish, archive, delete a never-published form, delete a submission, manage import sources and CSV backfill | `forms.publish` | owner, technical_admin, management, marketing |
| Submissions list, detail, CSV export | `forms.write` and `persons.read` | owner, technical_admin, management, marketing |
| Staff-assisted entry (`/admin/forms/enter`, `startStaffEntry`) and health declaration status | `persons.write` | owner, technical_admin, management, customer_service, sales, reception |
| Reveal sensitive answers | `persons.sensitive_read` | owner only by default (granted per role by the owner) |
| Form report | `reports.read` or `forms.write` | owner, technical_admin, management, marketing, customer_service, sales, finance |
| Forms tab on the person page (no answer values beyond non-sensitive answers) | `persons.read` | every staff role except external_partner |
| Partner counts per tracked link (R3) | `partner.own` | external_partner, only links with their `partner_company_id`, counts only |

Audited (`audit_log`, written by `action()` for every staff write; `entity_type` = `form`, `form_version`, `form_submission`, `form_link`, `form_import_source`): every action in section 4 with the listed action names (including `forms.staff_entry_started` with person id and form id), plus `forms.submissions_exported` (filters and row count) and `sensitive.read` (by `readSensitive`). Values in audit rows: form meta old and new values; `saveDraft` and `publishVersion` store only `definition_hash` and version numbers; `deleteSubmission` stores the reason and the submission id, never answers; import secrets are never logged. Public routes write no audit rows; their effects are traced by `activity_events` and `jobs`.

## 8. Multi-language and content

- Catalogue namespace `forms`, files `packages/core/src/i18n/messages/{en,nl-BE,fr-BE}/forms.json`, `en` the source. Key groups: `forms.list.*`, `forms.new.*`, `forms.builder.*` (field type names, condition operators, issue messages `forms.builder.issue.<code>`), `forms.scoring.*`, `forms.preview.*`, `forms.versions.*`, `forms.submissions.*`, `forms.report.*`, `forms.links.*`, `forms.imports.*`, `forms.enter.*` (staff-assisted entry), `forms.public.*` (next, back, submit fallback, required, staff banner, guest confirmed line, pending subscription confirmation, guardian required, guardian consent (`forms.public.guardian_consent`), invalid email, invalid phone, number range, too long, saving, retry, closed, unavailable locale, resume offer, not you, expired link, link sent, rate limited, progress "Step {n} of {total}"), `forms.result.*` (your score, your profile, recommended for you), `forms.email.result.<slot>` and `forms.email.result_link.<slot>` (the copy slots the two templates declare in `defineTemplate({ slots })`; email's seed copies them into version 1 of each system template, after which staff edit the wording in the admin), `forms.portal.results.*` (R2).
- `LocalizedText` content in `form_versions.definition` and `scoring`: title, intro, submit label, section title and description, field label and help, placeholder, option labels, consent wording, ending title and body, CTA labels, ending email subject and intro, dimension labels, range labels, explanations and recommendations, outcome labels, explanations and recommendations. `forms.name` is LocalizedText for staff and the portal list.
- Publish-time completeness is rule P2: `assertComplete()` over every content path listed above for every locale in `form_versions.locales`; the issue list names the path (for example `fields.sleep_hours.label: fr-BE missing`). Drafts may be incomplete. The builder shows a completeness badge per locale.
- A form may declare fewer locales than three. The hosted page for a locale outside `locales` shows the "not available in your language" page. `persons.locale` for a new person is the submission locale; the result email uses the submission locale (always in the version's locales, so it can never be blocked for translation). `forms.result_link` emails use the submission locale too. A staff-assisted entry (ID10) uses the locale the staff member picked, which must be in the version's locales.
- Transactional templates written by forms in `packages/email/src/templates/forms/{index.ts,result.tsx,result-link.tsx}` (cross-module D4: forms writes every file of that folder, components, props schemas and `index.ts`, and its copy in `forms.email.*`; email owns `templates/email/`, `templates/define.ts`, the shared layout, footer, renderer, the generated registry and the seeding of system rows; keys follow Convention 1, file basename with `-` replaced by `_`, one file one key: `export const templates = [defineTemplate({ name: 'result', ... }), defineTemplate({ name: 'result_link', ... })]`, registry keys `forms.result` and `forms.result_link`; each declares a `sample` for email's `define.test.ts` and no `loadProps`, because no automation step sends them): `forms.result` (props schema `FormResultProps` exported from `packages/core/src/forms/email-props.ts`: `firstName`, `formTitle`, `outcomeLabel`, `scoreLine` (non-sensitive total only, or null), `explanation`, `recommendation`, `intro`, `resultUrl`, `ctas: { label, url }[]` (max 4), `pendingConfirmation: boolean`) and `forms.result_link` (`FormResultLinkProps`: `firstName`, `formTitle`, `resultUrl`). Static strings are the copy slots above; dynamic texts are already resolved to the submission locale by forms and passed as `data`. `pendingConfirmation` adds the line "Check your inbox to confirm your subscription" (C1).
- Dates in answers are shown with `Intl.DateTimeFormat(locale, { timeZone: 'Europe/Brussels' })`; numbers with `Intl.NumberFormat(locale)`.

## 9. Privacy

`apps/web/modules/forms/privacy.ts` registers into `GDPR_REGISTRY`:

```ts
export const formsPrivacy = {
  tables: ['form_submissions', 'form_sensitive_answers', 'form_links', 'form_import_events'],
  export: async (tx, personId) => ({ /* see below */ }),
  erase: async (tx, personId) => ({ /* see below */ }),
  // retention handlers called by ops' privacy.retention_sweep, keyed by retention policy key (Convention 4, cross-module D37);
  // each returns the rows touched in one batch of batch_size
  sweep: {
    'forms.form_submissions': sweepSubmissions,
    'forms.form_sensitive_answers': sweepSensitiveAnswers,
    'forms.form_submissions_anonymous_abandoned': sweepAnonymousAbandoned,
    'forms.form_sensitive_answers_unlinked': sweepSensitiveUnlinked,
    'forms.form_submissions_ip_hash': sweepIpHash,
    'forms.form_import_events': sweepImportEvents,
    'forms.form_views_daily': sweepViewsDaily,
  } satisfies Record<string /* policy key */, (tx: Tx, cutoff: Date) => Promise<number>>,
} satisfies PrivacyRegistration; // { tables, export, erase, sweep?, retention? } (cross-module D69)
```

Merge: crm's merge repoints every `person_id` column it finds in `information_schema` inside the merge transaction (crm rule 3.30). No forms table has a unique key that includes `person_id`, so forms needs no entry in crm's `MERGE_STRATEGIES` and registers no merge hook; `merge-coverage.test.ts` (crm) covers `form_submissions.person_id` and `form_sensitive_answers.person_id`, and `form_links.referrer_person_id` is repointed the same way.

`NO_PII_TABLES` additions: `forms`, `form_versions` (definitions and staff user ids only), `form_views_daily`, `form_import_sources`.

| Table | Export (subject's GDPR export) | Erase | Why |
| --- | --- | --- | --- |
| `form_submissions` | every submission: form name, version, dates, status, answers with labels, score, outcome, source, campaign, funnel, UTM, landing path, applied tags, consent snapshot, entered by staff (yes/no) | **deleted** | assessment answers and results are marketing and wellbeing data; no legal retention duty |
| `form_sensitive_answers` | decrypted with `readSensitive(ctx, personId, 'privacy_export')`, labelled per field | **deleted** (by `person_id` and by the person's submission ids) | special-category data |
| `form_import_events` | not exported (raw duplicates of the submissions already exported) | **deleted** where `email_hash` = sha256 of the person's email or `submission_id` belongs to the person | raw payloads hold the email and answers |
| `form_links` | not exported | `referrer_person_id` **set null** (anonymised) | link stays for the referring campaign's counts |
| `activity_events` `form.*` | exported by crm | handled by crm | append-only timeline owned by crm |
| `consent_records` from forms | exported by crm | retained by crm per its rules (proof of consent and withdrawal) | |

Erase runs inside `privacy.erase` under `SET LOCAL beam.allow_rewrite = 'on'` and returns `{ table, rows, action }` per table. It runs before crm's handler (forms rows reference `persons`). `privacy.test.ts` asserts that after erase no row in `form_submissions`, `form_sensitive_answers` or `form_import_events` references the person or their email hash, and that `form_links.referrer_person_id` is null.

Retention. ops seeds the two policies of blueprint 63 ("assessment answers", "assessment results") in `packages/db/src/seed/ops.ts`: `forms.form_sensitive_answers` (run_order 20) and `forms.form_submissions` (run_order 30), both 1095 days, delete, handler forms (the `forms.` prefix names the module whose `sweep[key]` runs the policy, whoever seeds the row; Convention 4, cross-module D37). forms seeds five more rows in `packages/db/src/seed/forms.ts` (insert `on conflict (key) do nothing`, so a staff edit of `days` survives re-seeding). ops' `privacy.retention_sweep` (01:00) runs them by `run_order` through `formsPrivacy.sweep[key]`, which deletes or anonymises at most `batch_size` rows per call under `SET LOCAL beam.allow_rewrite = 'on'` and returns the count; ops self-continues while the count equals `batch_size`.

| key | table_name | days | action | run_order | Handler rule (cutoff = now() - days) |
| --- | --- | --- | --- | --- | --- |
| `forms.form_sensitive_answers` (seeded by ops) | `form_sensitive_answers` | 1095 | delete | 20 | rows whose submission's `coalesce(completed_at, abandoned_at, started_at) < cutoff` (answers go first, blueprint 63) |
| `forms.form_submissions` (seeded by ops) | `form_submissions` | 1095 | delete | 30 | `coalesce(completed_at, abandoned_at, started_at) < cutoff`; sensitive rows cascade |
| `forms.form_submissions_anonymous_abandoned` | `form_submissions` | 30 | delete | 31 | `status = 'abandoned' and person_id is null and abandoned_at < cutoff` (SE5) |
| `forms.form_sensitive_answers_unlinked` | `form_sensitive_answers` | 30 | delete | 32 | `person_id is null` and the submission is not `completed` and `created_at < cutoff` |
| `forms.form_submissions_ip_hash` | `form_submissions` | 30 | anonymise | 33 | `ip_hash = null where ip_hash is not null and started_at < cutoff` |
| `forms.form_import_events` | `form_import_events` | 90 | delete | 34 | `received_at < cutoff` (same as `webhook_events`) |
| `forms.form_views_daily` | `form_views_daily` | 1095 | delete | 35 | `day_on < cutoff::date` (aggregates, no personal data) |

Other privacy guarantees: sensitive values never leave `form_sensitive_answers` except through `readSensitive` (SE1 to SE4); the unit test `forms-sensitive.test.ts` asserts that `form_sensitive_answers.value_enc` is in `SENSITIVE_COLUMNS` that no forms column appears in `AI_ALLOWED_FIELDS`, and that the only form-derived entries of `SEGMENT_ALLOWED_FIELDS` are ops' `v_person_profile.last_assessment_form_slug` and `last_assessment_outcome_key` (plus crm's event rules on `form.*` and `assessment.*` kinds, whose data never holds answers). Logs carry submission ids only. A person under a processing restriction (crm's `persons.processing_restricted_at is not null`, the one restriction flag of Convention 7 and cross-module D12; forms never reads ops' `processing_restrictions` request table) who submits a form is still served (they asked for it): the submission, result page and transactional result email work, while crm and ops keep them out of segments, campaigns and marketing automations. The DPIA trigger of blueprint 66 ("sensitive assessment processing") is enforced in code: rule P7 refuses to publish a version with sensitive fields until ops' register row `sensitive_assessment_processing` is `approved` or `not_required` (`isDpiaApproved`), on top of P5 (explicit consent) and the `settings.ai.sensitive_enabled = false` default, which forms never reads as permission to send answers to AI. Because of this gate the `defaults` seed publishes only `contact` and `newsletter`; `health-declaration` is seeded as form `draft` with its v1 draft and is published by staff once the DPIA is decided (a go-live step).

## 10. Dependencies

### Needs from other modules

| Module | What | Used for |
| --- | --- | --- |
| platform | `action()` (audiences `staff` and `public`), `defineJob`, `defineSchedule`, `defineEvent`, `enqueue`, `ctx.recordEvent`, `ctx.audit`, `requirePermission()`, `rateLimit(tx, { key, limit, windowSeconds })`, `encryptSensitive(plain, aad)` / `decryptSensitive(valueEnc, keyVersion, aad)`, `readSensitive(ctx: Ctx, personId: string, purpose: 'staff_view' | 'privacy_export' | 'subject_result', scope?: { keys?: SensitiveFieldKey[]; eventIds?: string[]; submissionIds?: string[] }): Promise<SensitiveBundle>` (platform's signature, Convention 7 and cross-module D11; forms passes `submissionIds` and reads `SensitiveBundle.formAnswers`), the `sensitive()` column helper, `users` table, `flag()` | every server path |
| crm | `findOrCreatePersonByEmail(tx, ctx, { email, firstName?, lastName?, phone?, locale, acquisition?: Omit<Acquisition, 'captured_at'> }): Promise<{ personId: string; created: boolean }>` (Wave 0 contract) | ID3 |
| crm | `updatePersonFields(tx, ctx, personId, patch: PersonFieldPatch, opts: { onlyEmpty: boolean }): Promise<{ changed: string[] }>` (`onlyEmpty: true` for `email` identification, `false` for session, token and staff) | ID4 |
| crm | `fillAcquisitionIfEmpty(tx, ctx, personId, acquisition: Omit<Acquisition, 'captured_at'>): Promise<{ applied: boolean }>` | A3 |
| crm | `recordConsent(tx, ctx, { personId, purpose, status, method, source, wordingVersion, lawfulBasis?, ip?, userAgent?, ref? })` returning `{ recordId, outcome: 'recorded' \| 'unchanged' \| 'needs_confirmation' \| 'skipped_suppressed' \| 'skipped_minor' }` | C1, C3, C5 |
| crm | `applyTag(tx, ctx, personId, tagKey, 'form'): Promise<{ applied: boolean }>`, called once per key (no batch function); `tags` table read at publish | A5, P7 |
| crm | `persons`, `companies` (FKs); `getPersonPrefill(tx, personId): Promise<{ firstName, lastName, phone, locale, birthOn, postalCode, city }>` and `getPerson(tx, personId)` (email for the masked line) | ID2, ID4 |
| crm | merge repoints `form_submissions.person_id`, `form_sensitive_answers.person_id`, `form_links.referrer_person_id` by `information_schema` (crm rule 3.30) | edge case 25 |
| crm (R3) | `createInboxThreadFromForm(tx, ctx, { personId, submissionId, subject, body }): Promise<{ threadId: string }>` | contact forms in the unified inbox |
| email | `sendTransactional(ctx, { template, personId?, to?, locale, data, key, attachments?, context?, sendAt?, replyTo?, headers? }): Promise<{ emailMessageId: string; jobId: string }>` (cross-module D5, the Wave 0 stub shape; forms passes `template: 'forms.result' \| 'forms.result_link'`, `personId`, `locale`, `data`, `key`; never `props`, `idempotencyKey`, `toEmail` or `purpose`; the call returns no status, suppression and translation are decided later by `email.send`); forms writes `forms.result` and `forms.result_link` itself in `packages/email/src/templates/forms/` (cross-module D4, section 8); from email: `defineTemplate()` from `@beam/email/templates/define`, the shared layout and footer, the `gen:indexes` collector that registers `packages/email/src/templates/forms/index.ts` in `TEMPLATE_REGISTRY`, and email's seed of one editable system row per key | C4, ID8 |
| booking | `session_templates`, `sessions` read (CTA targets, P7); `bookings` read in `v_form_conversions`; the portal page `/[locale]/account/book` accepts `?template=<id>`; uses `hasValidSubmission()` on the reception check-in list; owns `settings.booking_rules.require_health_declaration` (cross-module D16; forms never reads it) | result CTAs, conversion, ID11 |
| commerce | `products` read (CTA targets); `orders` read in `v_form_conversions`; `/[locale]/account/shop` accepts `?product=<id>` | result CTAs, conversion |
| ops | `isDpiaApproved(db: DbOrTx, key: DpiaKey): Promise<boolean>` called with `'sensitive_assessment_processing'` (rule P7 publish check; cross-module D38, the name `ai_sensitive_processing` does not exist); `retention_policies` (forms seeds five rows, ops seeds `forms.form_sensitive_answers` and `forms.form_submissions`; keys of section 9, cross-module D37); `privacy.retention_sweep` calls `formsPrivacy.sweep[key]`; `ops.daily_digest` calls `getFormsHealth()`. Processing restrictions: forms reads no ops table; the flag is crm's `persons.processing_restricted_at` (cross-module D12), which crm and ops apply to segments, campaigns and marketing automations | section 9, monitoring |
| site | renders `FormEmbed` inside its `form_embed` page blocks and passes `context`; `getEventPageUrl(db, sessionId, locale)` for event CTAs; (R3) `readReferralCode(cookies, searchParams)` read by forms' submit route from the `beam_ref` cookie and passed to crm as `acquisition.referral_code` (cross-module D18; forms-P9) | site embedding, event CTA, referral attribution |
| webinar (R2) | `webinars` read (id, slug, status); `/[locale]/webinars/[slug]` route | webinar CTA |
| ops (R3) | `ad_spend_daily` read | cost per lead |
| platform | `buildCsp({ nonce, pathname })` in `apps/web/lib/csp.ts`, called from `proxy.ts` per request with a nonce and `strict-dynamic` (PL-67, cross-module D41): responses under `/:locale/f/:path*` carry `frame-ancestors *` instead of `'none'` (embedding on partner and landing-page sites); every other path keeps `frame-ancestors 'none'`. No `next.config.ts` CSP header exists, because a second CSP header would be enforced together with proxy's `'none'` | embed script |
| orchestrator | Better Stack check on `GET /nl/f/contact` configured at go-live (the go-live probe of cross-module D41). No `next.config.ts` header request: the frame exception comes from platform's `buildCsp()` (row above) | monitoring (section 6) |

### Provides to other modules

| Module | What |
| --- | --- |
| crm | `hasValidSubmission(db, { personId, formSlug: 'health-declaration' })` for `getReceptionCard().declarations.healthDeclarationValid` (cross-module D15); `FormSettings.createInboxThread` as the R3 inbox switch (cross-module D62); `listPersonSubmissions()` for the person page Forms tab; `form.*` and `assessment.*` events on the timeline with crm's data keys; the "Fill in a form" link target `/admin/forms/enter?personId=` |
| automation | events `form.started`, `form.completed`, `assessment.result_generated`, `form.abandoned`, `form.result_viewed`, `assessment.cta_clicked` with `form_slug`, `form_kind`, `outcome_key`, `source`, `funnel` in `data`; `listOutcomes()` and `listPublishedForms()` for trigger pickers; `buildFormUrl()` for invitation steps |
| email | `listLatestOutcomes(tx, personIds, formSlug)` for "assessment outcome" content blocks; `buildFormUrl()` and `createPersonToken()` for links in templates; the registry templates `forms.result` (`FormResultProps` with `pendingConfirmation`) and `forms.result_link` (`FormResultLinkProps`) written by forms in `packages/email/src/templates/forms/` (cross-module D2, D4), props schemas exported from `@beam/core/forms` |
| ops | tables `forms`, `form_versions`, `form_submissions` read directly (ops builds `last_assessment_form_slug` and `last_assessment_outcome_key` in `v_person_profile` itself); views `v_form_funnel_daily`, `v_form_conversions`, `v_form_latest_results`; `getLatestOutcomes()`; `getFormsHealth()` for the digest; `sweep` handlers; form KPIs for the marketing dashboard (R3), `v_ai_form_*` (R4) |
| site | `FormEmbed` (props `{ slug, locale, context }` of section 4), the browser event `beam-form:completed` (`detail { slug, kind, locale, endingKind }`) for R3 conversion tags, `getPublishedFormMeta()`, `listPublishedForms()`, seeded forms `contact` (kind `lead`) and `newsletter` (kind `lead`, one required `newsletter` consent field under the P6 exception), `countLandingConversions()` (R3) |
| booking | `hasValidSubmission()` for the seeded `health-declaration` form on the reception check-in list and booking page (ID11; it answers `{ valid: false }` while the form is still an unpublished draft before the DPIA decision); `verifyPersonToken()` to prefill booking pages from result-page CTAs |
| commerce | `verifyPersonToken()` to prefill guest checkout from result-page CTAs |
| webinar (R2) | `buildFormUrl()` with `src = 'webinar'` for post-webinar assessments |

## 11. Edge cases and failure modes

1. **Two staff edit the same draft.** `saveDraft` carries `expectedHash`; the second save gets `conflict` and a reload dialog. No silent overwrite.
2. **Publish while visitors are mid-form.** Their submissions stay pinned to the old version (U6) and complete with its scoring; reports group by version.
3. **A visitor answers, goes back and changes an answer that hides a later section.** At submit the server recomputes visibility (L1, L5) and drops answers of now-hidden fields before scoring.
4. **Logic sends the visitor to an ending before required fields of later sections.** Only fields on the visited path are required; the path is recomputed on the server, so a forged path fails `validation`.
5. **Formula divides by zero or uses an unanswered field.** The dimension is `null` (S3); no range or outcome matches it; `defaultOutcomeKey` applies; the result page hides the null dimension.
6. **Typed email belongs to an existing customer.** The submission links to that person; only empty fields are filled (ID4); conflicts are listed by name in the event; acquisition is not overwritten (A3).
7. **Typed email differs from the logged-in customer's email.** Impossible: the field is read-only with a session (ID2). With an identity token, changing the email drops the token and the typed email is used.
8. **Email belongs to an erased person.** `findOrCreatePersonByEmail` creates a new person (the partial unique index excludes erased rows); the suppression with reason `erased` still blocks marketing, the transactional result email is still sent because the person asked for it now.
9. **Email is suppressed with scope `all` (hard bounce or complaint).** The submission completes and the result page works; `sendTransactional` still inserts the message and returns `{ emailMessageId, jobId }` with no status (event `result_email: 'queued'`; cross-module D5) and `email.send` blocks it (`email_messages.status = suppressed`, shown on the submission detail); the result page is the fallback.
10. **Visitor never gives consent for sensitive processing.** Sensitive answers are not stored at saves (SE2) and submit fails with a field error on the consent box; nothing sensitive reaches the database.
11. **Anonymous visitor abandons.** Submission becomes `abandoned`, no event (E1), no person; sensitive rows and the submission are deleted after 30 days (section 9).
12. **Abandoned submission is resumed and completed on day 3.** Status returns to `partial` then `completed`; `form.completed` fires once; an automation started on `form.abandoned` exits only if its `exit_on` lists `form.completed`; the builder's help text for `form.abandoned` triggers tells marketing to add it.
13. **Double click on submit or network retry.** U7: the second call returns the same result URL; the result email key `form_result:<submission_id>:email` prevents a second email; event dedupe keys prevent duplicate timeline rows.
14. **Bot floods the start endpoint.** WAF 20/min per IP, 30 starts per IP per form per hour, honeypot and minimum fill time (R1 to R3). Bot submissions write nothing.
15. **Form archived while visitors are mid-form.** `save` and `submit` answer `410 form_closed`; the page shows "This form is closed"; open submissions become abandoned after 24 h.
16. **Locale removed in a new version.** Visitors with that locale see the "not available" page; existing submissions in that locale keep their result pages (they use their pinned version).
17. **CTA target disappears after publish (product deactivated, session cancelled).** The `go` route checks the target: inactive or past targets fall back to the ending's first `url` CTA or to `/[locale]` and still record the click with `data.fallback = true`; the builder shows a warning on the form overview from the nightly `forms.check_cta_targets` (stored in `forms.cta_warnings`).
18. **Result token leaked or forwarded.** The result page shows only the result, first name and CTAs, never email, phone or raw answers; staff can revoke the link (`revokeResultLink`); tokens expire after 180 days.
19. **Identity token forwarded to another person.** It prefills only first name and masked email; "Not you?" clears it; with token identification the profile overwrite (ID4) applies, so the forwarded-link risk is accepted and limited to the person's own name and phone fields; tokens expire in 30 days.
20. **ScoreApp sends the same result twice, or a CSV is uploaded twice.** Unique `(source_id, external_id)` drops the duplicate; the job key prevents double processing.
21. **Import payload shape changes (Typeform field renamed).** The JsonPath for a required mapping key (`email`, `externalId`) resolves to nothing: `PermanentError`, event `skipped` with reason `mapping:email`; the source page shows the count and a Reprocess button after the mapping is fixed.
22. **Third-party cookies blocked inside the embed iframe.** The `fsid` cookie may be dropped; the client then sends the resume token (always issued for embedded forms, even with resume off, but stored only in memory) to prove ownership of the submission.
23. **Encryption key rotation during a submission.** New rows use the current `key_version`; `security.rekey` re-encrypts old rows; decrypt reads the row's version.
24. **Very large multiple-choice or long-text payloads.** Zod caps per type (U9) and the 64 KB body limit (R4) reject them with field errors.
25. **Person merged after submitting.** crm's merge repoints `form_submissions.person_id`, `form_sensitive_answers.person_id` and `form_links.referrer_person_id` to the winner by `information_schema` in the merge transaction; result tokens keep working because they hash the submission id, not the person.
26. **Submit races the abandon job at exactly 24 hours.** Both lock the submission row (U11); whichever commits second sees a status it may not move from. If the job won, the submit finds `abandoned`, treats it as a resume (`abandoned` → `partial` → `completed` in the same transaction) and completes; `form.abandoned` stays on the timeline, `form.completed` follows.
27. **A staff-entry link is reused the next day or by someone else.** The token expires after 2 hours and names the staff user; after expiry the page shows "This link has expired, start again from the person page". A disabled staff user's token is refused.
28. **Visitor ticks newsletter after an earlier unsubscribe.** crm returns `needs_confirmation` and sends its confirmation email; the ending says "Check your inbox to confirm"; no grant exists until the click (crm edge case 10).
29. **Health declaration expires between booking and visit.** `hasValidSubmission` is evaluated at check-in, not at booking; reception sees "expired" and uses "Fill in a form" with the guest at the desk (ID10). The booking itself is never cancelled by forms.
30. **A 14-year-old fills in an assessment with a birth date field.** C5: a ticked marketing consent is recorded (13 or older, crm rule 53), a sensitive-processing consent is refused with the guardian message; the visitor can still complete a form without sensitive fields. A 12-year-old's ticked newsletter box is not recorded (forms skips the call; crm would answer `skipped_minor`) and the ending shows the guardian line.
31. **The DPIA for sensitive assessment processing is not decided at go-live.** `health-declaration` stays a draft (cross-module D39): `/[locale]/f/health-declaration` shows the "form not available" page, `hasValidSubmission` returns `valid: false` for everyone, booking's reception badge shows "missing", automation's `intake_reminder` step is skipped, and, with `settings.booking_rules.require_health_declaration` at its default `false`, nothing is blocked (booking never blocks check-in or staff bookings on it, cross-module D16). Publishing it is refused with `dpia_not_approved` until the owner records the decision in `/admin/privacy/dpia`.

## 12. Build packages

Order: forms-P1 and forms-P2 run in parallel (no shared files). forms-P3 to forms-P7 are strictly sequential in that order because they share `apps/web/modules/forms/{api.ts,actions.ts,queries.ts,jobs.ts}` and the three `forms.json` catalogues; each package below names the shared files it edits. forms-P8 to forms-P10 follow in their releases. No package edits `package.json`, the lockfile, migrations, `packages/db/src/schema/index.ts` or any `registry/*.generated.ts`. Every package's done-definition includes: `pnpm gen:indexes && pnpm typecheck && pnpm lint` clean, its Vitest suites green (integration tests with `createTestDb()` and the Wave 0 factories), `pnpm i18n:check` green when it touched catalogues. Waves: forms-P1 and forms-P2 in Wave 1 hours 2-4; forms-P3 and forms-P4 in Wave 1 hours 4-7; forms-P5, forms-P6 and forms-P7 in Wave 2 (they still run one after another); forms-P8 in the R2 sprint, forms-P9 in R3, forms-P10 in R4. Anything a package needs from another module that is not yet merged is mocked with `vi.mock('@/modules/<m>/api')` in unit tests, never by editing that module.

### forms-P1 (V1): schema and views

- **Goal:** every forms table, enum, index, check and view from section 2.
- **Files:** edit `packages/db/src/schema/forms.ts` (complete the Wave 0 stub, keeping its columns); create `packages/db/src/schema/forms.views.ts`, `packages/db/src/schema/forms.test.ts`.
- **Interfaces:** exported tables `forms`, `formVersions`, `formSubmissions`, `formSensitiveAnswers`, `formLinks`, `formViewsDaily`, `formImportSources`, `formImportEvents`; enums `formsKind`, `formsStatus`, `formSubmissionsStatus`, `formSubmissionsIdentifiedBy`, `formLinksChannel`, `formImportSourcesProvider`, `formImportEventsStatus`; views `vFormFunnelDaily`, `vFormConversions`, `vFormLatestResults`; inferred types `Form`, `FormVersionRow`, `FormSubmissionRow`.
- **Depends on:** `platform:users`, `crm:persons`, `crm:companies`, `booking:bookings` (contract columns `person_id`, `status`, `created_at`), `commerce:orders` (contract columns `person_id`, `status`, `paid_at`, `total_cents`), `email:email_messages` (Wave 0 contract tables).
- **Tests (`forms.test.ts`):** slug check rejects `Bad Slug` and `result`; `status = 'published'` without `current_version_id` fails; second draft per form violates `form_versions_one_draft_uq`; check `published_by_user_id is null or published_at is not null` (a draft with a publisher fails; a seed-published row without one passes); `source` check rejects `paid_social` and accepts `paid_meta`; `funnel` not null; `applied_tag_keys` defaults to `{}`; `cta_warnings` defaults to `[]`; `completed` without `completed_at` fails; unique result and resume token hashes; `form_import_events` duplicate `(source_id, external_id)` ignored with `on conflict do nothing`; `v_form_funnel_daily` counts views and statuses on the right Brussels day (23:30 UTC case); `v_form_conversions` sees a booking on day 29 and ignores day 31; `v_form_latest_results` returns the newest completion; `value_enc` is in `SENSITIVE_COLUMNS`.
- **Done:** the common done-definition.
- **Build order note (03-build-order.md, forward-call stubs):** this package also owns `apps/web/modules/forms/api.ts` and declares in it every forms function that another module calls (section 4 and section 10), with its final signature, as a typed stub that throws `NotImplementedError`; input and output types are declared inline in `api.ts` because the pure core lands in parallel in forms-P2. Later forms packages replace the stub bodies; no signature changes without a cross-module decision.

### forms-P2 (V1): core engine (pure)

- **Goal:** definition schemas, logic, safe expression evaluator, scoring, outcomes, publish validation, attribution, email props, seeded form definitions.
- **Files:** create `packages/core/src/forms/{definition.ts,expression.ts,logic.ts,scoring.ts,validate.ts,attribution.ts,age.ts,email-props.ts,seed-definitions.ts}` and tests `{definition,expression,logic,scoring,validate,attribution,age}.test.ts` beside them; edit the Wave 0 stubs `packages/core/src/forms/{index.ts,types.ts}`; edit the Wave 0 stub `packages/db/src/seed/forms.ts` (`defaults` profile, idempotent with `on conflict do nothing`: the five retention rows of section 9; published v1 (seed publisher, no DPIA check needed because neither has sensitive fields) of `contact` (lead: email, first name, message long text marked non-sensitive, optional `newsletter` consent, thank-you ending, `createInboxThread` for R3), `newsletter` (lead: email, first name, required `newsletter` consent under the P6 exception), and `health-declaration` as form `draft` with an unpublished v1 draft (P7 DPIA gate; staff publish it after the DPIA decision) (intake, `nl-BE`/`fr-BE`/`en`, `validityDays` 365, `staffEntryAllowed`: identity section with email, names, birth date and phone plus the required `sensitive_processing` consent; health section with eight sensitive `yes_no` questions of kind `health` (heart condition, blood pressure, pregnancy, epilepsy, recent surgery, skin condition, medication, alcohol in the last 4 hours) and one sensitive long text; acknowledgement of contraindications (house rules are a chapter of site's `terms`, not part of this form, cross-module D15); thank-you ending; no scoring)); edit the Wave 0 stub `apps/web/modules/forms/seed.ts` (`demo` profile: `recovery-check`, an assessment with 3 sections, 12 fields, 3 dimensions of which `sleep` and `stress` are sensitive and `habits` is not, 4 outcomes on `habits` ranges and answer combinations, result endings with booking, experience and event CTAs, in all three locales; plus 30 demo submissions across statuses and sources; the `demo` profile, which runs only on `beam_dev` and never on `neondb`, publishes `health-declaration` and `recovery-check` through `service/versions.ts` with `{ skipDpiaCheck: 'demo_seed' }`, the only caller allowed to pass it, because demo submissions are fake persons).
- **Interfaces:**
  ```ts
  export const FormDefinition: z.ZodType<FormDefinition>; export const FormScoring: z.ZodType<FormScoring>; export const ImportMapping: z.ZodType<ImportMapping>;
  export function parseExpression(src: string): { ok: true; ast: Expr } | { ok: false; error: { pos: number; message: string } };
  export function evaluate(ast: Expr, env: ExprEnv): number | boolean | null;
  export function evaluateCondition(c: Condition, s: { answers: Answers; scores: ScoreState }): boolean;
  export function isVisible(target: Field | Section, s: { answers: Answers; scores: ScoreState }): boolean;
  export function nextStep(def: FormDefinition, scoring: FormScoring, answers: Answers, current: SectionKey | null): { section: SectionKey } | { end: EndingKey | null };
  export function computePath(def: FormDefinition, scoring: FormScoring, answers: Answers): { path: SectionKey[]; endingKey: EndingKey | null };
  export function validateAnswers(def: FormDefinition, path: SectionKey[], answers: Answers, opts: { final: boolean }): { ok: true; clean: Answers } | { ok: false; fields: Record<string, string> };
  export function computeScore(def: FormDefinition, scoring: FormScoring, answers: Answers): ScoreResult; // { total, totalRangeKey, dimensions, sensitiveDimensionKeys }
  export function selectOutcome(scoring: FormScoring, answers: Answers, score: ScoreResult): Outcome | null;
  export function splitSensitive(def: FormDefinition, answers: Answers): { plain: Answers; sensitive: Answers };
  export function deriveSensitiveKeys(def: FormDefinition): string[]; export function deriveConsentPurposes(def: FormDefinition): string[];
  export function canonicalHash(def: FormDefinition, scoring: FormScoring): string;
  export function validateForPublish(kind: FormKind, def: FormDefinition, scoring: FormScoring, locales: Locale[]): PublishIssue[];
  export function deriveSource(input: { src?: string; utm: Utm; linkChannel?: FormLinkChannel; linkName?: string; referrerHost?: string;
    landingPathKind?: 'landing' | 'other'; embedHostIsBeam: boolean | null }): { source: AcquisitionSource; campaign: string | null; medium: string | null };
  export function ageOn(birthOn: string, day: string): number; // completed years, Brussels calendar days
  export const FormResultProps: z.ZodType<FormResultProps>; export const FormResultLinkProps: z.ZodType<FormResultLinkProps>;
  export function seedDefinitions(): Record<'contact' | 'newsletter' | 'health-declaration', { kind: FormKind; name: LocalizedText; definition: FormDefinition; scoring: FormScoring; locales: Locale[] }>;
  ```
- **Depends on:** `platform:@beam/core/i18n assertComplete, LocalizedText` (Wave 0); `crm:AcquisitionSource` type from `@beam/core/crm` (crm-P1; until merged, the union is copied into a local type and replaced by the import in forms-P3).
- **Tests:** `expression.test.ts`: precedence, functions, `contains`, division by zero → null, rejects `constructor`, `__proto__`, `a.b.c` beyond allowed roots, 501-char input, depth 33; `logic.test.ts`: show/hide, skip, branch, conditional section, conditional ending, multiple conditions (`all`/`any`/`not`), forward-only, hidden answers dropped; `scoring.test.ts`: weighted options, rating weights, `avg` ignores unanswered, ranges inclusive and exclusive edges, formula dimension, total by sum and by formula, S4 outcome by total, by category range, by answer combination, default outcome, S6 sensitive dimension detection; `validate.test.ts`: one case per P2 to P6 and P8 code, including missing `fr-BE` label path, missing acknowledgement text, newsletter consent required → error except on a pure sign-up form, sensitive field without consent → error, survey with a sensitive field and no email → error, `goto` or outcome on a sensitive field → `sensitive_in_logic`, field shown by a sensitive condition is derived sensitive, cycle → error; `attribution.test.ts`: each A2 branch in order (src wins over link, `print` → `qr_code`, `ig` + `cpc` → `paid_meta`, `utm_medium=email` → `website` with medium `email`, foreign embed → `landing_page`); `age.test.ts`: birthday today, 29 February, under 13 and under 16 on the boundary days; `definition.test.ts`: limits F7, key regex, `acknowledgement` always required, every `seedDefinitions()` form and the demo `recovery-check` validate with zero errors.
- **Done:** the common done-definition; coverage of `packages/core/src/forms` at least 90 %.

### forms-P3 (V1): submission pipeline, jobs, privacy and api

- **Goal:** the server logic of rules U, ID, C, SE, A, E and R, without HTTP: start, save, complete, abandon, tokens, staff entry, sensitive storage, result email, CTA target checks, retention sweep handlers, privacy, cross-module API.
- **Files:** create `apps/web/modules/forms/service/{tokens.ts,identity.ts,submissions.ts,sensitive.ts,rate-limit.ts,public-queries.ts,versions.ts,cta-targets.ts,retention.ts,health.ts}`; edit the Wave 0 files `apps/web/modules/forms/{api.ts,jobs.ts,schedules.ts,events.ts,permissions.ts,privacy.ts,config.ts}`; tests `apps/web/modules/forms/service/{tokens,submissions,staff-entry,sensitive,rate-limit,cta-targets,retention,versions}.test.ts`, `apps/web/modules/forms/{jobs,privacy,api}.test.ts`. No file under `packages/email/` (forms-P4 writes the two templates; this package sends their `data` with the props schemas of forms-P2).
- **Interfaces:**
  ```ts
  startSubmission(tx: Tx, ctx: PublicCtx, i: { slug: string; locale: Locale; url: string; referrer?: string; embedHost?: string; identityToken?: string; embedContext?: string; ip: string }): Promise<{ submissionId: string; resumeToken: string | null; prefill: Prefill | null }>;
  saveSection(tx: Tx, ctx: PublicCtx, i: { submissionId: string; proof: SubmissionProof; sectionKey: string; answers: Answers }): Promise<{ next: { sectionKey: string } | { end: true } }>;
  completeSubmission(tx: Tx, ctx: PublicCtx, i: { submissionId: string; proof: SubmissionProof; answers: Answers; ip: string; userAgent: string }): Promise<{ resultUrl: string | null; redirectUrl: string | null; endingKey: string; pendingConfirmation: boolean }>;
  markAbandoned(tx: Tx, ctx: JobCtx, limit: number): Promise<number>;
  createStaffEntryUrl(tx: Tx, ctx: StaffCtx, i: { formId: string; personId: string; locale?: Locale }): Promise<{ url: string }>; // used by forms-P6's action
  resolveCtaTarget(db: DbOrTx, cta: Cta, locale: Locale): Promise<{ url: string; fallback: boolean }>;
  checkCtaTargets(db: DbOrTx, def: FormDefinition): Promise<CtaWarning[]>; // used by P7 publish checks in forms-P5 and the nightly job
  createResultToken(submissionId: string, version: number): string; hashToken(t: string): string;
  publishVersion(tx: Tx, ctx: StaffCtx, i: { formId: string; versionId: string; changeNote: string }): Promise<{ version: number }>; // used by forms-P5 actions
  ```
  plus every `api.ts` function of section 4 except `FormEmbed` and `countLandingConversions` (R3); `privacy.ts` `{ tables, export, erase, sweep }`; jobs `forms.mark_abandoned`, `forms.send_result_link`, `forms.check_cta_targets` and their schedules; the six event definitions; `permissions.ts` registering `forms.write` and `forms.publish` with default grants to marketing (owner and management get them from the registry).
- **Depends on:** forms-P1, forms-P2; `platform:action/defineJob/defineSchedule/defineEvent/recordEvent/rateLimit/encryptSensitive/readSensitive`; `crm:findOrCreatePersonByEmail`, `crm:updatePersonFields`, `crm:fillAcquisitionIfEmpty`, `crm:recordConsent` (all five outcomes), `crm:applyTag`, `crm:getPersonPrefill`, `crm:getPerson`; `ops:isDpiaApproved` (P7 check inside `service/versions.ts` `publishVersion`; mocked until ops-P6 merges); `email:sendTransactional` with keys `forms.result` and `forms.result_link`; `site:getEventPageUrl`. Functions not merged yet are mocked with `vi.mock('@/modules/crm/api')` (and email, site) in unit tests; integration tests switch to the real functions after crm's and email's Wave 1 packages merge (Wave 2 seam).
- **Tests:** `submissions.test.ts`: every transition of U11 (and that no other transition happens: `completed` → save is `conflict`), U1 to U10 and ID1 to ID9, ID11 (`hasValidSubmission` valid on day 364, expired on day 366, any version counts), C1 to C5 (no `newsletter` consent row after an assessment with an unticked newsletter box; `assessment_result` row written; `needs_confirmation` stored in the snapshot with `pendingConfirmation`; `skipped_minor` from crm stored with `skippedMinor` and the guardian line, submit still completes; a submitted birth date under 13 makes no marketing `recordConsent` call; a 14-year-old's newsletter grant is recorded while their `sensitive_processing` consent is refused; ID4 calls `updatePersonFields` with `onlyEmpty: true` for email identification and lists `profile_conflicts` from `getPersonPrefill`), A3 (acquisition written once in crm's shape with `funnel` and `form_slug`, second form keeps the first), A5 (`applied_tag_keys`), A6, E1 to E4 (event kinds and snake_case keys exactly as section 3; no answer values in `activity_events.data`; `assessment.result_generated` only for scored or result-ending forms, always `is_sensitive = false` with `form_slug` and `outcome_key` on a version with sensitive fields; `sendTransactional` receives `{ template: 'forms.result', personId, locale, data, key: 'form_result:<id>:email' }` and no `purpose`), existing customer updated (fill-empty vs overwrite), abandoned never emits `form.completed`, submit racing the abandon job (two transactions on PGlite, edge case 26); `staff-entry.test.ts`: ID10 token carries `s`, expires after 2 hours, refused for a disabled user and for a form without `staffEntryAllowed`, consents recorded with method `staff`, `source = 'manual'`; `sensitive.test.ts`: SE1 (no sensitive key in `answers`, `score`, event data), SE2 (discarded before consent), sensitive dimension stored as `score:<key>`, `aad` mismatch fails to decrypt, decrypt via `readSensitive(ctx, personId, purpose, { submissionIds })` with platform's purposes only (`staff_view`, `subject_result`, `privacy_export`) writes `sensitive.read` and the values come from `SensitiveBundle.formAnswers`; `tokens.test.ts`: identity token tamper, expiry, result token determinism and revocation by version, `embedContext` tamper ignored; `rate-limit.test.ts`: R2 thresholds through `rateLimit`, R3 honeypot and 3-second rule; `cta-targets.test.ts`: inactive product, past session, missing template each fall back with `fallback = true`; `retention.test.ts`: the `sweep` map keys are exactly the seven `forms.<table>[_<qualifier>]` keys of section 9 and each matches `^[a-z]+\.[a-z][a-z0-9_]*$` (cross-module D37), each handler deletes only rows past its cutoff and returns the count, a second call returns 0; `versions.test.ts`: `publishVersion` of a version with non-empty `sensitive_field_keys` calls `ops.isDpiaApproved(tx, 'sensitive_assessment_processing')` (mocked) and fails with `dpia_not_approved` while it is false, publishes once it is true, and a version without sensitive fields never calls it (rule P7, cross-module D38); `jobs.test.ts`: `forms.mark_abandoned`, `forms.send_result_link` and `forms.check_cta_targets` run twice with the same payload give the same state (`runJobTwice`); `privacy.test.ts`: export includes decrypted sensitive answers through `privacy_export`, erase leaves no row referencing the person or their email hash, `form_links.referrer_person_id` nulled, merge by crm's `information_schema` repoint keeps result tokens valid; `api.test.ts`: `getLatestOutcomes`, `listLatestOutcomes` for one slug (inside a transaction too), `getPublishedFormMeta` null for archived, `getFormsHealth` counts, `listPersonSubmissions` has no answer values; `forms-sensitive.test.ts` of section 9.
- **Done:** the common done-definition.

### forms-P4 (V1): public routes, hosted page, result page and embed

- **Goal:** HTTP surface and the visitor UI: route handlers of section 4, `/[locale]/f/[slug]`, the result page, `embed.js`, `FormEmbed`, public and email strings.
- **Files:** create `apps/web/app/api/public/forms/[slug]/{view,start,resume,save,submit}/route.ts`, `apps/web/app/api/public/forms/result/[token]/viewed/route.ts`, `apps/web/app/api/public/forms/result/[token]/go/[ctaKey]/route.ts`, `apps/web/app/api/public/forms/embed.js/route.ts`, `apps/web/app/[locale]/(site)/f/[slug]/{page.tsx,not-found.tsx}`, `apps/web/app/[locale]/(site)/f/[slug]/r/[token]/page.tsx`, `apps/web/modules/forms/ui/public/{form-renderer.tsx,field-inputs.tsx,form-embed.tsx,result-view.tsx,embed-script.ts,http.ts}`, `packages/email/src/templates/forms/{index.ts,result.tsx,result-link.tsx}` (section 8; only forms writes this folder); edit `apps/web/modules/forms/api.ts` (add the `FormEmbed` export; sequential after forms-P3) and `packages/core/src/i18n/messages/{en,nl-BE,fr-BE}/forms.json` (keys `forms.public.*`, `forms.result.*`, `forms.email.result.*`, `forms.email.result_link.*`); tests `packages/email/src/templates/forms/forms-templates.test.ts` (both samples render in the three locales, the result email never contains a sensitive dimension value, `pendingConfirmation` adds the confirmation line), `apps/web/modules/forms/ui/public/{http,embed-script,form-renderer}.test.ts(x)`, `apps/web/app/api/public/forms/routes.test.ts`, create `apps/web/e2e/forms.spec.ts`.
- **Interfaces:** `FormEmbed({ slug, locale, context }): Promise<JSX.Element>` (props of section 4; signs `embedContext`); `embedScript(origin: string): string`; `handlePublic(req: Request, fn): Promise<Response>` in `http.ts` (body limit, JSON errors, IP extraction from `x-forwarded-for`, `fsid` cookie).
- **Depends on:** forms-P3; `email:defineTemplate`, the shared layout and the `gen:indexes` template collector (email Wave 1; until merged the template files compile against the Wave 0 `defineTemplate` stub); `site:(site) layout` (Wave 0 shell); `platform:proxy locale routing`; `platform:buildCsp` (`frame-ancestors *` on `/:locale/f/:path*`, section 10; platform's `csp.test.ts` covers `/nl/f/intake`).
- **Tests:** `routes.test.ts` (handlers called with `new Request()` on `createTestDb()`): happy path start → save → submit; 410 on archived; 404 without proof; 413; 429; honeypot returns 200 and writes nothing; `go/[ctaKey]` records `assessment.cta_clicked` once per day and redirects with `pt`, and to the fallback with `fallback = true` for an inactive product; `start` with a forged `embedContext` ignores the partner; result `viewed` dedupes; `embed-script.test.ts`: iframe src carries UTM from the parent, ignores messages from other origins, re-dispatches `beam-form:completed` from the BEAM origin only; `form-renderer.test.tsx` (jsdom): `beam-form:completed` fires once after a completed submit with `{ slug, kind, locale, endingKind }` and no other keys, not after a failed or repeated submit; `FormEmbed` signs `pagePath`, `referrer` and `partnerCompanyId` and the start route stores `landing_path` from `pagePath` when `landingPath` is absent; `apps/web/e2e/forms.spec.ts` against `beam_dev`: the demo `recovery-check` in `fr-BE` with branching to a conditional ending, result page shows score and CTA (acceptance "a weighted, branched assessment works"), the person exists with `acquisition.source = 'paid_meta'` and `funnel = 'form:recovery-check'` for `?utm_source=facebook&utm_medium=paid_social`, no newsletter consent (acceptance "a result does not create newsletter consent"), a second run with an existing customer's email fills their empty phone (acceptance "an existing customer record is updated"), unavailable-locale page for a `nl-BE`-only form, the whole `contact` form completed with the keyboard only (Tab, arrows, Space, Enter) and the error summary receiving focus on an empty submit.
- **Done:** the common done-definition plus `apps/web/e2e/forms.spec.ts` green at the wave checkpoint.

### forms-P5 (V1): admin builder, preview and versions

- **Goal:** staff create, edit, preview, publish, archive, duplicate and version forms; links management with QR download.
- **Files:** edit `apps/web/modules/forms/actions.ts` (form, draft, publish, archive, delete, duplicate, link actions), `apps/web/modules/forms/queries.ts` (`listForms`, `getForm`, `getFormVersion`, `listVersions`, `diffVersions`, `listLinks`), `apps/web/modules/forms/nav.ts` (both admin entries of section 5), the three `forms.json` catalogues (keys `forms.list.*`, `forms.new.*`, `forms.builder.*`, `forms.scoring.*`, `forms.preview.*`, `forms.versions.*`, `forms.links.*`; sequential after forms-P4); create `apps/web/app/(admin)/admin/forms/{page.tsx,new/page.tsx}`, `apps/web/app/(admin)/admin/forms/[formId]/{page.tsx,build/page.tsx,scoring/page.tsx,preview/page.tsx,versions/page.tsx,links/page.tsx}`, `apps/web/app/(admin)/admin/forms/[formId]/links/[linkId]/qr/route.ts` (`?format=svg|png`, `forms.write`), `apps/web/modules/forms/service/qr.ts`, `apps/web/modules/forms/ui/admin/{form-list.tsx,field-tree.tsx,field-editor.tsx,condition-builder.tsx,logic-editor.tsx,ending-editor.tsx,scoring-editor.tsx,formula-input.tsx,issues-panel.tsx,preview-frame.tsx,version-diff.tsx,link-table.tsx}`, `apps/web/modules/forms/service/diff.ts`; tests `apps/web/modules/forms/{actions,permissions}.test.ts`, `apps/web/modules/forms/service/{diff,qr}.test.ts`.
- **Interfaces:** the actions of section 4 rows `createForm` to `updateLink`; `diffVersions(a: FormVersionRow, b: FormVersionRow): VersionDiff`.
- **Depends on:** forms-P3 (`service/versions.ts`, `service/cta-targets.ts` for the P7 checks), forms-P4 (renderer reused by preview); `ops:isDpiaApproved` (ops-P6; mocked with `vi.mock('@/modules/ops/api')` until merged); `platform:@beam/ui LocalizedInput, DataTable`; `crm:tags` read; `booking:session_templates`, `booking:sessions`, `commerce:products` read through `checkCtaTargets`.
- **Tests:** `actions.test.ts`: every row of the P12 table and both refused transitions (`archiveForm` on a draft, `deleteForm` on a published form → `conflict`); P13: archive and delete of `health-declaration`, `contact` and `newsletter` → `conflict`, re-running the `defaults` seed keeps the slug and the staff-published current version; create → save → publish → edit creates `version + 1` draft; publish fails with `sensitive_in_logic` for a `goto` on a sensitive field; the overview shows `cta_warnings`; published row never updated (direct update attempt through the service throws); `expectedHash` conflict; publish fails with the issue list on a missing `fr-BE` label and on an inactive product CTA; a version with a sensitive field fails with `dpia_not_approved` while `isDpiaApproved` (mocked, then the real ops function after the Wave 2 seam) is false and publishes once it is true, and a version without sensitive fields never calls it; `skipDpiaCheck` is refused from any caller except the demo seed; restore old version as draft; delete refused after publish; archive → public `getPublishedForm` returns `closed`; audit rows carry hashes only; `permissions.test.ts`: every action denies without its permission (marketing allowed, reception denied, publish needs `forms.publish`); `diff.test.ts`: added, removed, changed field, logic and outcome; `qr.test.ts`: the SVG encodes `<origin>/<locale>/f/<slug>?l=<key>` (decoded with the `qrcode` segment output in the test) and PNG bytes start with the PNG signature.
- **Done:** the common done-definition; manual check in `pnpm dev` that the builder autosaves and the preview reflects branching.

### forms-P6 (V1): submissions, detail, export and report

- **Goal:** submissions list and detail with sensitive reveal, result email resend, link revoke, submission delete, CSV export, the funnel and conversion report, staff-assisted entry page.
- **Files:** edit `apps/web/modules/forms/actions.ts` (`revealSensitiveAnswers`, `resendResultEmail`, `revokeResultLink`, `deleteSubmission`, `requestResultLink`, `startStaffEntry`; sequential after forms-P5), `apps/web/modules/forms/queries.ts` (`listSubmissions`, `getSubmission`, `getFormReport`; sequential after forms-P5), the three `forms.json` catalogues (`forms.submissions.*`, `forms.report.*`, `forms.enter.*`); create `apps/web/app/(admin)/admin/forms/[formId]/submissions/{page.tsx,[submissionId]/page.tsx,export/route.ts}`, `apps/web/app/(admin)/admin/forms/[formId]/report/page.tsx`, `apps/web/app/(admin)/admin/forms/enter/page.tsx`, `apps/web/modules/forms/ui/admin/{submission-table.tsx,submission-detail.tsx,sensitive-card.tsx,funnel-chart.tsx,report-table.tsx,staff-entry-panel.tsx}`, `apps/web/modules/forms/service/export-csv.ts`; edit `apps/web/app/[locale]/(site)/f/[slug]/r/[token]/page.tsx` (expired state with the `requestResultLink` form; sequential after forms-P4); tests `apps/web/modules/forms/{submissions-admin,report}.test.ts`, `apps/web/modules/forms/service/export-csv.test.ts`.
- **Interfaces:** `toSubmissionCsv(rows: SubmissionExportRow[], version: FormVersionRow, locale: Locale): string`; `getFormReport` of section 4.
- **Depends on:** forms-P3, forms-P5; `platform:readSensitive`; `email:sendTransactional`, `email:email_messages` read; `booking:bookings`, `commerce:orders` through `v_form_conversions`.
- **Tests:** `submissions-admin.test.ts`: list filters and cursor; detail renders labels of the pinned version after a newer version changed the label; reveal requires `persons.sensitive_read` and writes `sensitive.read`; resend limited to 3 with distinct idempotency keys; revoke makes the old token 404; delete removes sensitive rows (cascade) and audits the reason without answers; `startStaffEntry` allowed for reception (`persons.write`) and denied without it, refused for a form without `staffEntryAllowed`, audits `forms.staff_entry_started`; the enter page shows the `health-declaration` status from `hasValidSubmission`; `requestResultLink` returns the same response for known and unknown emails and sends at most 3 per day; `export-csv.test.ts`: no sensitive column, CSV injection guard (cells starting with `=`, `+`, `-`, `@` prefixed with `'`); `report.test.ts`: completion rate, outcome distribution, conversion within 30 days, group by source, funnel and version.
- **Done:** the common done-definition.

### forms-P7 (V1): ScoreApp and Typeform import stopgap

- **Goal:** rules I1 to I5: import sources, webhook route, processing job, CSV backfill, admin screens.
- **Files:** create `apps/web/app/api/public/forms/import/[sourceKey]/[secret]/route.ts`, `apps/web/modules/forms/service/import.ts`, `apps/web/modules/forms/service/json-path.ts`, `apps/web/app/(admin)/admin/forms/imports/{page.tsx,[sourceId]/page.tsx}`, `apps/web/modules/forms/ui/admin/{import-wizard.tsx,import-events-table.tsx}`, `apps/web/modules/forms/__fixtures__/{typeform.json,scoreapp.json,scoreapp.csv}`; edit `apps/web/modules/forms/jobs.ts` (add `forms.process_import`; sequential after forms-P3), `apps/web/modules/forms/actions.ts` (import source actions; sequential after forms-P6), `apps/web/modules/forms/queries.ts` (`listImportSources`, `listImportEvents`; sequential after forms-P6), the three `forms.json` catalogues (`forms.imports.*`); tests `apps/web/modules/forms/service/{import,json-path}.test.ts`, `apps/web/modules/forms/jobs-import.test.ts`.
- **Interfaces:** `resolvePath(obj: unknown, path: string): unknown`; `processImportEvent(tx: Tx, ctx: JobCtx, eventId: string): Promise<'processed' | 'skipped'>`; `ingestCsv(tx: Tx, ctx: StaffCtx, sourceId: string, csv: string): Promise<{ inserted: number; duplicates: number }>` (uses `csv-parse/sync`, installed in Wave 0).
- **Depends on:** forms-P3 (`completeSubmission` internals for linking, consent and events), forms-P6 (shared `actions.ts` and `queries.ts`); `crm:findOrCreatePersonByEmail`, `crm:recordConsent`.
- **Tests:** wrong secret → 404 and nothing stored; duplicate event ignored; Typeform fixture creates a completed submission with mapped outcome and a sensitive answer only in `form_sensitive_answers`; no result email enqueued; missing email → `skipped`; `newsletter` consent never inferred from a non-true value, a literal `true` recorded with method `import`; import never lifts a suppression (crm returns `skipped_suppressed`); job run twice → same state; CSV uploaded twice → second upload `duplicates = n`; JsonPath `answers[field.ref=sleep].number`.
- **Done:** the common done-definition.

### forms-P8 (R2): portal results, cross-device resume, webinar CTA

- **Goal:** `/[locale]/account/results`, U5 for logged-in customers on any device, CTA kind `webinar`, the portal flag.
- **Files:** create `apps/web/app/[locale]/(portal)/account/results/page.tsx`, `apps/web/modules/forms/ui/portal/results-list.tsx`; edit `apps/web/modules/forms/service/submissions.ts` (session resume lookup), `apps/web/modules/forms/nav.ts` (portal entry), `apps/web/modules/forms/config.ts` (declare flag `ff_forms_portal_results`), `packages/core/src/forms/validate.ts` (accept `webinar` CTAs), `apps/web/modules/forms/service/cta-targets.ts` (webinar target by slug), `apps/web/app/api/public/forms/result/[token]/go/[ctaKey]/route.ts` (webinar target), the three `forms.json` catalogues (`forms.portal.results.*`); tests `apps/web/modules/forms/portal-results.test.ts`, extend `packages/core/src/forms/validate.test.ts`.
- **Depends on:** forms-P1 to forms-P7; `webinar:webinars` table (id, slug, status) and the `/[locale]/webinars/[slug]` route.
- **Tests:** portal list shows only the actor's submissions; "View result" issues a fresh token; logged-in resume from a second session continues the same submission; webinar CTA validates against an existing webinar and redirects.
- **Done:** the common done-definition; `ff_forms_portal_results` flag gates the portal entry until BEAM switches it on.
- **Build order note (03-build-order.md, forward-call stubs):** this package declares `countLandingConversions` in `apps/web/modules/forms/api.ts` as a typed stub returning `[]`, because site-P9 runs in the same wave as forms-P9, which implements it.

### forms-P9 (R3): referral and partner attribution, campaign report, inbox, landing conversions

- **Goal:** referral links; partner view of counts; campaign attribution with cost per lead; contact forms into the unified inbox; marketing KPI view; `countLandingConversions` for site.
- **Files:** create `apps/web/app/(admin)/admin/forms/attribution/page.tsx`, `apps/web/modules/forms/ui/partner/partner-link-counts.tsx` (rendered by crm's partner area through `api.ts`), `apps/web/modules/forms/ui/admin/attribution-table.tsx`; edit `packages/db/src/schema/forms.views.ts` (add `v_form_kpis_daily`: per day leads created by forms, completions, CTA clicks, conversions; and `v_form_campaign_attribution`: per `utm_campaign` leads, completions, bookings, revenue 30 d, joined to `ad_spend_daily` spend for cost per lead), `apps/web/modules/forms/service/submissions.ts` (inbox thread through `crm.createInboxThreadFromForm` when `settings.createInboxThread`; referral `referrer_person_id` into acquisition; `acquisition.referral_code` from `site.readReferralCode(cookies, searchParams)` read by the submit route and passed to crm, cross-module D18), `apps/web/modules/forms/api.ts` (`countLandingConversions`, `PartnerLinkCounts`), `apps/web/modules/forms/actions.ts`, `apps/web/modules/forms/queries.ts`, the three `forms.json` catalogues (`forms.attribution.*`); tests `apps/web/modules/forms/attribution.test.ts`.
- **Depends on:** forms-P8; `crm:createInboxThreadFromForm` (R3); `site:readReferralCode` (R3); `ops:ad_spend_daily` (R3); `platform:partnerScope` (R3).
- **Tests:** `countLandingConversions` totals match fixtures; referral link sets `acquisition.referrer_person_id` for a new person only; partner user sees counts for their links only and no PII; attribution totals match fixtures; inbox thread created once per submission; a `beam_ref` cookie on the submit request reaches `findOrCreatePersonByEmail` as `acquisition.referral_code` for a new person only.
- **Done:** the common done-definition.

### forms-P10 (R4): AI-safe views and dashboard sources

- **Goal:** non-sensitive form data for natural-language questions and custom dashboards.
- **Files:** edit `packages/db/src/schema/forms.views.ts` (add `pgSchema('ai')` views `ai.form_funnel_daily` (from `v_form_funnel_daily`) and `ai.form_outcomes` (form slug, version, outcome key, Brussels day, count; no person ids)); create `apps/web/modules/forms/dashboard-sources.ts` (widget sources `forms.funnel`, `forms.outcomes`, `forms.conversion`); tests `apps/web/modules/forms/ai-views.test.ts`.
- **Depends on:** forms-P9; `ops:custom dashboards widget registry` (R4); `platform:beam_ai_ro role grants on schema ai` (custom migration by the orchestrator).
- **Tests:** the `ai` views expose no column that references `persons.id` and no sensitive column; outcome counts below 5 per day are merged into `other` (no re-identification); dashboard sources return the same totals as `getFormReport`.
- **Done:** the common done-definition.

### Acceptance and scenario coverage

| Proposal promise (section 12 V1 checklist, blueprint 76 and 87) | Where it is proven |
| --- | --- |
| "A weighted, branched assessment works" | forms-P2 `scoring.test.ts` and `logic.test.ts`; forms-P4 `apps/web/e2e/forms.spec.ts` (`recovery-check` in `fr-BE`); the orchestrator's `e2e/acceptance-v1.spec.ts` calls the same flow |
| "An existing customer record is updated" | forms-P3 `submissions.test.ts` (ID4 fill-empty and overwrite); forms-P4 e2e second run |
| "A result does not create newsletter consent" | forms-P3 `submissions.test.ts` (C3); forms-P4 e2e; crm's `consent.test.ts` |
| "Sensitive free text is excluded from AI" (scenario 6) | forms-P3 `sensitive.test.ts` and `forms-sensitive.test.ts` (no forms column in `AI_ALLOWED_FIELDS`, values only in `form_sensitive_answers`); crm's `e2e/scenario-6-sensitive-ai.spec.ts` uses the seeded `health-declaration` long text as its fixture |
| "Deletion propagates" through assessments (scenario 7) | forms-P3 `privacy.test.ts`; ops' `e2e/scenario-7-deletion.spec.ts` asserts zero `form_submissions`, `form_sensitive_answers` and `form_import_events` rows for the person |
| "Data can be exported" | forms-P3 `privacy.test.ts` (subject export incl. decrypted answers); forms-P6 `export-csv.test.ts` (staff CSV without sensitive columns) |
| "CRM reflects activity" | forms-P3 `submissions.test.ts` (E table events on the timeline) |
| "Suppression survives import" | forms-P7 import test (crm returns `skipped_suppressed`) |
| Scenario 1 (late entry) for form-triggered sequences | automation's `scenario-1-late-entry` covers the engine; forms only supplies `form.completed` with `occurred_at` |
| SLA monitoring of lead capture | section 6 monitoring; forms-P3 `getFormsHealth` test; Better Stack check on `/nl/f/contact` configured by the orchestrator at go-live |

## 13. Decisions made

Additions to the architecture:

1. **Four tables added:** `form_links` (tracked links and QR attribution), `form_views_daily` (page views for the funnel), `form_import_sources` and `form_import_events` (ScoreApp and Typeform stopgap; platform's `webhook_events.provider` enum is frozen and has no value for them).
2. **Columns added to `forms`:** `description`, `created_by_user_id` (nullable: seed), `archived_at`, `cta_warnings`, `updated_at`. **To `form_versions`:** `definition_hash`, `change_note`, `published_by_user_id`, `updated_at`; `created_by_user_id` and `published_by_user_id` are null for rows written by the `defaults` seed; drafts are `form_versions` rows with `published_at is null`, one per form (partial unique index); immutability applies from publish on.
3. **Columns added to `form_submissions`:** `form_id`, `identified_by`, `ending_key`, `path`, `current_section_key`, `campaign`, `funnel`, `link_id`, `referrer_url`, `landing_path`, `embed_host`, `applied_tag_keys`, `entered_by_user_id`, `result_token_version`, `result_token_expires_at`, `resume_token_hash`, `ip_hash`, `consent_snapshot`, `import_event_id`, `external_ref`, `result_email_message_id`, `abandoned_at`, `updated_at`; `person_id` is nullable (anonymous surveys and not-yet-identified visitors).
4. **`form_sensitive_answers.person_id` is nullable** until the submission is linked; columns `created_at`, `updated_at`; unique `(submission_id, field_key)`; sensitive dimension scores stored there as `score:<key>`.
5. **Three views:** `v_form_funnel_daily`, `v_form_conversions` (30-day booking and purchase window), `v_form_latest_results`; R3 adds `v_form_kpis_daily` and `v_form_campaign_attribution`; R4 adds two `ai` schema views.
6. **New routes beyond the architecture's `public/forms/[slug]/submit`:** `view`, `start`, `resume`, `save`, `result/[token]/viewed`, `result/[token]/go/[ctaKey]`, `import/[sourceKey]/[secret]`, `embed.js`; slugs `result` and `import` are reserved. Admin routes `/admin/forms/enter` (staff-assisted entry) and `/admin/forms/[formId]/links/[linkId]/qr`. Portal route `/[locale]/account/results` (R2) is added to forms' ownership.
7. **New job kinds:** `forms.mark_abandoned`, `forms.process_import`, `forms.send_result_link`, `forms.check_cta_targets`; schedules `*/10 * * * *` and `50 2 * * *`. Retention is not a forms job: forms seeds five `retention_policies` rows and registers `sweep` handlers in `privacy.ts`; ops' `privacy.retention_sweep` runs them with the two forms policies ops seeds itself. Idempotency keys follow `<noun>:<id>:<qualifier>`: `form_import:<id>`, `form_result:<submission_id>:email`, `form_result:<submission_id>:resend:<n>`, `form_result_link:<submission_id>:<date>:<n>`, `form_abandon:<minute>:<n>`.
8. **Email templates** `forms.result` and `forms.result_link` are written by forms in `packages/email/src/templates/forms/` with email's `defineTemplate()` (architecture sections 1 and 11 give `templates/<m>/` to module `<m>`; email decision 52 declined writing them); props schemas `FormResultProps` and `FormResultLinkProps` live in `@beam/core/forms`, copy slots in `forms.email.result.<slot>` and `forms.email.result_link.<slot>`. The keys are `forms.result` and `forms.result_link` (Convention 1, cross-module D1 and D2: file basename with `-` replaced by `_`, one file one key); the slash form `<m>/<name>` is retired everywhere, so the earlier `forms/form-result` and `forms/form-link` requests are void. `sendTransactional` is called with the Wave 0 stub's input names (`data`, `key`, `to` when needed) and no `purpose`, and returns `{ emailMessageId, jobId }` (cross-module D5). Result emails are transactional; consent purpose `assessment_result` is recorded for the request, never `newsletter`.
9. **`readSensitive()` purposes and scope:** forms uses platform's `SensitivePurpose` values `staff_view`, `privacy_export` and `subject_result` and the scope `{ submissionIds }` (platform section 4 and PL-22 now carry both); encryption uses platform's `encryptSensitive(plain, aad)` with the AAD of section 2.
10. **crm functions forms relies on, under crm's names (crm review, crm decision 56):** `findOrCreatePersonByEmail`, `recordConsent` (all outcomes, including `needs_confirmation` and `skipped_minor`), `applyTag` once per key (no `applyTags`), `updatePersonFields(tx, ctx, personId, patch, { onlyEmpty })` ("fill empty" = `onlyEmpty: true`, "overwrite" = `onlyEmpty: false`; profile conflicts are computed by forms from `getPersonPrefill`), `fillAcquisitionIfEmpty(tx, ctx, personId, acquisition)` (cross-module D13: the only write paths; no other profile or acquisition writer exists), `getPersonPrefill`, `getPerson`, `createInboxThreadFromForm` (R3, not `createInboxThread`). crm adds no aliases, so forms adapts. Merge needs no forms hook: crm repoints `person_id` columns by `information_schema`. Event kinds and data keys follow crm's catalogue (`assessment.result_generated`, `assessment.cta_clicked`, snake_case keys); forms adds `form.result_viewed` to that catalogue.
11. **Embedding exception lives in platform's CSP builder:** `buildCsp()` in `apps/web/lib/csp.ts` (frozen after Wave 0, platform PL-67, applied by `proxy.ts`) sends `frame-ancestors *` for `/:locale/f/:path*` only, so forms can be embedded on landing pages and partner sites. `next.config.ts` sends no CSP or frame header and forms requests none (cross-module D41): browsers enforce every CSP header they receive, so a second header could never relax proxy's `frame-ancestors 'none'`, and the per-request nonce keeps the whole CSP in one place. The architecture's section 10 states the same (CSP with per-request nonces built by `buildCsp()` in `proxy.ts`). forms adds no file under `apps/web/lib/`.
12. **No new permission strings:** `forms.write` and `forms.publish` cover the module; submissions also need `persons.read`; reveal needs `persons.sensitive_read`; staff-assisted entry needs `persons.write`.
12a. **Source vocabulary:** `form_submissions.source` uses crm's `AcquisitionSource` values, so a submission's source and `persons.acquisition.source` never need translating; email traffic has no own value and keeps `medium = email`.
12b. **Cross-module surface named by consumers:** `FormEmbed` (site's name and props, not `FormBlock`), `getPublishedFormMeta`, `listLatestOutcomes` (email), `hasValidSubmission` (booking), `getFormsHealth` (ops), `countLandingConversions` (site, R3); seeded forms `contact`, `newsletter`, `health-declaration` in the `defaults` profile.

Choices the inputs left open:

13. Field keys `^[a-z][a-z0-9_]{0,39}$`; limits 30 sections, 200 fields, 50 outcomes, 20 dimensions, 100 rules, 256 KB.
14. A section is a page; logic is evaluated after a section and only jumps forward, so every path ends.
15. Conditions reference only earlier fields; nesting depth 6, 50 leaves.
16. The formula language is a hand-written Pratt parser with a fixed function list; null propagation instead of errors; limits 500 characters, depth 32, 200 nodes.
17. Ranges are `[from, to)` with the last range closed; outcomes are chosen by ascending priority with a default.
18. A dimension that touches a sensitive field is itself sensitive and encrypted; outcome keys are never sensitive, and the builder says so.
19. `started` begins at the first interaction, not on page view; page views are counted separately.
20. Abandonment after 24 hours of inactivity, checked every 10 minutes; resuming an abandoned submission is allowed and sets it to `partial`.
21. Resume is off by default; `resumeDays` default 7, max 30; same-browser in V1 through `localStorage`, any device for logged-in customers in R2.
22. Partial lead capture is off by default, so visitors who never submit leave no person record.
23. Identity tokens are stateless HMAC tokens valid 30 days, prefill only; result tokens are deterministic HMACs of the submission id and a version, valid 180 days, with only the sha256 stored.
24. With typed-email identification only empty profile fields are filled; with session or token identification submitted values overwrite.
25. Every kind except `survey` requires an email field; optional marketing consents are never required fields; forms with sensitive fields need a required `sensitive_processing` consent before or with the first sensitive field.
26. Long-text fields in assessment and intake forms default to sensitive.
27. Source derivation order of A2; `persons.acquisition` is written once, a submission always keeps its own attribution.
28. Rate limits: 30 starts per IP per form per hour, 5 completions per email per form per hour, honeypot plus 3-second minimum, 64 KB body; no captcha in V1.
29. IP addresses are stored only as an HMAC and cleared after 30 days.
30. Embedding uses an iframe plus a 4 KB script with height messages; the BEAM site renders forms inline through `FormEmbed`, whose page context is HMAC-signed so a visitor cannot forge a partner attribution.
31. Import credential is a 32-byte secret in the URL path (ScoreApp has no signature); Typeform's own HMAC is not checked in the stopgap. Imported results never trigger the result email, and consent is imported only from literal `true`.
32. CSV backfill of past ScoreApp and Typeform results runs through the same import pipeline (max 2 MB, 5,000 rows) instead of ops' import kinds.
33. Submissions are kept 3 years, anonymous abandoned ones 30 days, import payloads 90 days.
34. Erasure deletes submissions and sensitive answers outright (no legal retention duty); referral links lose their `referrer_person_id`.
35. Staff CSV exports never contain sensitive answers; cells are guarded against CSV injection.
36. Preview never persists anything.
37. QR download ships in V1, because `qrcode` is already installed in Wave 0 for booking and QR codes are a lead source of blueprint 16 that flyers need at go-live.
38. A result CTA whose target disappeared falls back to the first URL CTA or the home page and records the click with `fallback = true`.
39. Waivers and health declarations are forms of kind `intake` with an `acknowledgement` field and sensitive health questions; their proof is the completed submission of a pinned version. Validity is `validityDays` (365 by default for intake); whether a missing declaration blocks a customer booking is booking's setting `settings.booking_rules.require_health_declaration`, default off, and check-in and staff bookings are never blocked on it (cross-module D16). House rules are not a forms acknowledgement but a chapter of site's `terms` (cross-module D15).
40. Staff-assisted entry reuses the public renderer with a 2-hour staff identity token instead of a separate admin form UI, so one renderer serves visitors, embeds, preview and reception.
41. Logic rules and outcomes may not depend on sensitive answers; show/hide may, and fields it reveals inherit sensitivity. This keeps `path`, `ending_key` and `outcome_key` safe to store in plain form and to show to marketing.
42. Marketing consent follows crm's single age rule (under 13 not recorded, `skipped_minor`, Belgian law of 30 July 2018 art. 7), checked on the submitted birth date by forms and on the stored one by crm, so the portal and forms never disagree; a sensitive-processing consent from anyone under 16 is refused (forms' stricter rule for special-category data).
43. A pure sign-up form (only identity fields and one marketing consent) may require that consent; everywhere else marketing consents are optional.
44. The funnel of a lead is `FormSettings.funnel`, defaulting to `form:<slug>`; it is written into `persons.acquisition.funnel` once and kept on every submission.

Cross-module review items (round 2), applied or declined:

45. **CSP exception (platform review): applied.** The `frame-ancestors *` exception for `/:locale/f/:path*` is produced by platform's `buildCsp()` in `apps/web/lib/csp.ts` through `proxy.ts`, not by a `next.config.ts` header (decision 11, section 10). The orchestrator keeps only the Better Stack check on `GET /nl/f/contact` at go-live.
46. **crm function names (crm review): applied.** forms calls `updatePersonFields(..., { onlyEmpty })`, `fillAcquisitionIfEmpty`, `applyTag` once per key, `createInboxThreadFromForm` (R3) and `getPersonPrefill` (decision 10). `recordConsent`'s `skipped_minor` outcome is handled (C1): the submission completes, the snapshot stores `skippedMinor: true`, the ending shows the guardian line. To keep one marketing age in the platform, forms' own marketing threshold moves from 16 to crm's 13 (C5, decision 42); the under-16 refusal of `sensitive_processing` consent stays, because it is a forms-only rule for special-category data.
47. **FormEmbed context prop (site review): applied, with two parts declined.** The context prop exists under site's published names: the component is `FormEmbed` (not `FormBlock`, site decision 57) with props `{ slug, locale, context: { pagePath, utm?, landingPath?, referrer?, partnerCompanyId? } }`; `utm` sits inside `context`, not beside `slug` and `locale`, as site's own spec shows. Rule A1 and the `start` route now read all of `pagePath`, `landingPath`, `referrer`, `partnerCompanyId` and `utm` from the signed `embedContext`. `referralCode` is declined as a context field: site's own spec (rule 63, decision 57) keeps the code in the `beam_ref` cookie, and forms' same-origin submit route reads it with `site.readReferralCode()` and passes it to crm as `acquisition.referral_code` (R3, forms-P9), so the code cannot be forged into a signed context and is never stored by forms.
48. **`beam-form:completed` browser event (site review): applied.** Section 5 defines it: dispatched once per completed submission on `window` (inline) or posted to the parent and re-dispatched by `embed.js` (iframe), with `detail { slug, kind, locale, endingKind }` and no personal data, answers, score or outcome, so marketing-consent-gated ad tags may read it.
49. **Email items (email review): partly applied.** `listLatestOutcomes(tx, personIds, formSlug)` keeps email's name and argument order (it already existed; the first parameter is renamed `tx` and stays `DbOrTx`). The `sendTransactional` call carries no `purpose` input and uses the Wave 0 names `data` and `key`, returning `{ emailMessageId, jobId }`; the `assessment.result_generated` value `result_email: 'suppressed'` is dropped because suppression is decided later by `email.send`. forms now writes its two templates in `packages/email/src/templates/forms/` (forms-P4) with copy under `forms.email.result.*` and `forms.email.result_link.*`, as architecture sections 1 and 11 and email decision 52 require. Void: the template keys `forms/form-result` and `forms/form-link`. The slash form is retired everywhere (Convention 1, cross-module D1), so the keys are `forms.result` and `forms.result_link`, as email's section 10 registry list states (cross-module D2).
50. **Automation items (automation review): applied.** Rule P13 makes `contact`, `newsletter` and `health-declaration` system slugs that never change and cannot be archived or deleted. Every forms event, `assessment.result_generated` included, is recorded with `is_sensitive = false` and carries `form_slug` and `outcome_key` (plus `form_kind`, `funnel`, `source`), also for versions with sensitive fields (rule L6).
51. **DPIA publish check (ops review): applied.** P7 calls `ops.isDpiaApproved(tx, 'sensitive_assessment_processing')` (ops' key, cross-module D38; the name `ai_sensitive_processing` does not exist) before publishing a version with `sensitive_field_keys`; the error code is `dpia_not_approved`. As a result the `defaults` seed publishes only `contact` and `newsletter`, and `health-declaration` is seeded as a draft that staff publish after the DPIA decision; only the `demo` profile (never on `neondb`) publishes sensitive forms, through `skipDpiaCheck: 'demo_seed'`.
52. **Alignments made while applying the items.** booking's setting is `settings.booking_rules.require_health_declaration` (snake_case, Convention 3 and cross-module D16) in ID11. The R3 inbox switch is `FormSettings.createInboxThread`: it is part of forms' versioned `FormDefinition` schema (rule F1) and true on the seeded `contact` form; `definition.settings.inbox` does not exist (cross-module D62).

Cross-module decisions (`_cross-module-decisions.md`), applied:

53. **Conventions confirmed applied.** Template keys `forms.result` and `forms.result_link` with copy slots `forms.email.<name>.<slot>` (Convention 1); event kinds `form.*` and `assessment.*` declared once in `events.ts` with snake_case `data` keys (Convention 2); forms declares no settings key and names booking's `settings.booking_rules.require_health_declaration` and platform's `settings.ai.sensitive_enabled` by their snake_case names (Convention 3); retention keys `forms.<table>[_<qualifier>]` (Convention 4); idempotency keys `<noun>:<id>[:<qualifier>]` (Convention 5); flag `ff_forms_portal_results`, permissions from the architecture list only, job kinds `forms.<verb_noun>` (Convention 6); `persons.processing_restricted_at` and platform's `readSensitive(ctx, personId, purpose, scope?)` (Convention 7).
54. **Cross-module decision 1 applied.** Transactional keys are `<m>.<name>` with `<name>` equal to the file basename with `-` replaced by `_`; `result.tsx` -> `forms.result`, `result-link.tsx` -> `forms.result_link`; no slash keys (section 8, decisions 8 and 49).
55. **Cross-module decision 2 applied.** Email's registry lists exactly `forms.result` and `forms.result_link` for forms (section 10 provides-to email row).
56. **Cross-module decision 4 applied.** forms writes every file of `packages/email/src/templates/forms/` (components, props schemas `FormResultProps` with `pendingConfirmation` and `FormResultLinkProps`, `index.ts`) and its `forms.email.*` copy; the owner paths include that folder; email owns the framework, registry and system-row seeding (sections 8 and 10).
57. **Cross-module decision 5 applied.** `sendTransactional(ctx, { template, personId?, to?, locale, data, key, attachments?, context?, sendAt?, replyTo?, headers? })` returns `{ emailMessageId, jobId }` and no status; forms uses `data`, `key`, `to`, never `props`, `idempotencyKey`, `toEmail` or `purpose` (section 10 email row, edge case 9, decision 8).
58. **Cross-module decision 11 applied.** No change of substance (SE3 and decision 9 already matched); SE3, `revealSensitiveAnswers`, the section 10 platform row and the `sensitive.test.ts` cases now state platform's full signature, the three purposes and the `SensitiveBundle.formAnswers` result.
59. **Cross-module decision 12 applied.** The processing restriction is read from crm's `persons.processing_restricted_at`; forms names no `processing_restrictions` table (section 9, section 10 ops row).
60. **Cross-module decision 13 applied.** Profile writes use `crm.updatePersonFields(tx, ctx, personId, patch, { onlyEmpty })` and acquisition uses `crm.fillAcquisitionIfEmpty(tx, ctx, personId, acquisition)` everywhere (ID4, A3, section 10, decision 10).
61. **Cross-module decision 15 applied.** `hasValidSubmission(db, { personId, formSlug: 'health-declaration' })` with 365-day validity feeds crm's `getReceptionCard().declarations.healthDeclarationValid` (ID11, section 10 provides-to crm row); house rules are a chapter of site's `terms`, so the seeded `health-declaration` acknowledges contraindications only (F2, forms-P2 seed, decision 39).
62. **Cross-module decision 16 applied.** ID11, edge case 31, section 10 booking row and decisions 39 and 52 name `settings.booking_rules.require_health_declaration` (default `false`); booking never blocks check-in or staff bookings on it.
63. **Cross-module decision 18 applied.** forms' submit route reads the `beam_ref` cookie with `site.readReferralCode(cookies, searchParams)` and passes `acquisition.referral_code` to crm, which resolves it through `credits.resolveReferralCode` at person creation (crm rule 3.4); `FormEmbed` context carries no `referralCode` (A1, A3, section 10 site row, forms-P9).
64. **Cross-module decision 37 applied.** Retention keys and `formsPrivacy.sweep` map keys are `forms.form_sensitive_answers`, `forms.form_submissions` (seeded by ops), `forms.form_submissions_anonymous_abandoned`, `forms.form_sensitive_answers_unlinked`, `forms.form_submissions_ip_hash`, `forms.form_import_events`, `forms.form_views_daily` (seeded by forms) (section 9, SE5, forms-P3 `retention.test.ts`).
65. **Cross-module decision 38 applied.** P7 gates publishing a version with non-empty `sensitive_field_keys` on `ops.isDpiaApproved(tx, 'sensitive_assessment_processing')` (approved or `not_required`); forms-P3 adds `service/versions.test.ts` for the check (P7, section 10 ops row, decision 51).
66. **Cross-module decision 39 applied.** No change of substance (decisions 51 and P13 stand): the `defaults` seed keeps `health-declaration` a draft; the public states and edge case 31 now say `/[locale]/f/health-declaration` shows the "form not available" page until staff publish it.
67. **Cross-module decision 41 applied.** The frame exception comes from `buildCsp()` in `proxy.ts`; `next.config.ts` sends no CSP or frame header and forms requests none; the go-live check is the Better Stack probe on `GET /nl/f/contact` (section 10 platform and orchestrator rows, decision 11).
68. **Cross-module decision 62 applied.** `FormSettings.createInboxThread` is the one R3 inbox switch, true on the seeded `contact` form (F1, section 10 provides-to crm row, decision 52).
69. **Cross-module decision 63 applied.** No change (decision 48 stands): `FormEmbed({ slug, locale, context: { pagePath, utm?, landingPath?, referrer?, partnerCompanyId? } })` and the `beam-form:completed` event with `detail { slug, kind, locale, endingKind }`, re-dispatched by `embed.js`.
70. **Cross-module decision 69 applied.** `formsPrivacy` is a `PrivacyRegistration` `{ tables, export, erase, sweep? }` whose `sweep` is keyed by policy key; erase runs under `SET LOCAL beam.allow_rewrite = 'on'` only (section 9).
