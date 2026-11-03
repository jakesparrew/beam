# Module spec: forms (Forms, assessments and lead capture)

Owner paths: `packages/db/src/schema/forms.ts`, `packages/db/src/schema/forms.views.ts`, `packages/core/src/forms/`, `apps/web/modules/forms/`, `apps/web/app/(admin)/admin/forms/`, `apps/web/app/[locale]/(site)/f/`, `apps/web/app/[locale]/(portal)/account/results/` (R2), `apps/web/app/api/public/forms/`, `packages/core/src/i18n/messages/*/forms.json`, `packages/db/src/seed/forms.ts`, `apps/web/e2e/forms.spec.ts`. The email templates `forms.result` and `forms.result_link` live in `packages/email/src/templates/forms/` but are owned and written by the email module (email spec, decision 1); forms supplies their props schemas and texts in this spec.
Blueprint sections: 16, 17 (primary); 3, 4, 5, 6, 30, 33, 34, 35, 44, 53, 59, 60, 61, 62, 63, 66, 76, 83, 84, 87 (secondary).

## 1. Purpose and release mapping

BEAM staff build lead forms, intake forms, surveys, registration forms and scored assessments without a developer. Every published form is an immutable version. Visitors fill it in on a hosted page or an embed on another site. Every completed submission lands on one `persons` record with its source, campaign and UTM, its consent per purpose, its score and its outcome. Sensitive answers (health, sleep, stress, recovery, wellbeing) are encrypted in a separate table and never reach AI, segments or staff exports. The module replaces Typeform and ScoreApp.

| Release | What ships in this module |
| --- | --- |
| **V1 (weeks 1-6)** | Builder with all 14 blueprint field types plus `acknowledgement` (health declarations and waivers), sections, show/hide, skip, branch, conditional sections and endings, multiple conditions. Scoring: weighted answers, dimensions, category and total scores, ranges, thresholds, custom formulas (safe evaluator), outcomes by total, category or answer combinations. Endings and personalised result pages (score, category, explanation, recommendation, CTAs to a booking, event, product, experience or URL). Per-form locales and publish-time completeness. Hosted page `/[locale]/f/[slug]`, embed script, public submit API with rate limits. Person linking (session, identity token, email), prefill and skip of known fields. Started, partial, abandoned (24 h), completed tracking; optional same-browser resume. Result links by token. Sensitive routing to `form_sensitive_answers`. Consent per purpose with wording version; transactional result email. Lead attribution (source, campaign, medium, funnel, UTM, landing path, referrer, partner, tracked link key) written once to `persons.acquisition` in crm's `Acquisition` shape. Activity events for every step, including `assessment.result_generated` and `assessment.cta_clicked`. Staff-assisted entry at reception (source `manual`). Health declaration validity check for reception (`hasValidSubmission`). Seeded forms `contact`, `newsletter`, `health-declaration` and `recovery-check`. ScoreApp/Typeform webhook import plus CSV backfill (stopgap). Funnel and conversion report. Admin list, builder, scoring, preview, versions, submissions list and detail, links, imports. Health signals for the daily digest and alerts. |
| **Release 2 (weeks 9-10)** | Portal page "My results" (`/[locale]/account/results`). Cross-device resume for logged-in customers. CTA kind `webinar` (the webinar module ships in R2). Per-person form history tab data for the B2C pipeline view. |
| **Release 3 (weeks 11-12)** | QR code download (SVG and PNG) for tracked links. Referral links (`form_links.referrer_person_id`) and partner attribution report. Campaign attribution per form (leads, completions, bookings and revenue per `utm_campaign`, cost per lead joined to `ad_spend_daily`). Form KPIs for the marketing dashboard. Contact-form submissions open a thread in the unified inbox. `countLandingConversions()` for site insights. |
| **Release 4 (weeks 13-14)** | Non-sensitive form views exposed to the `ai` schema for natural-language questions and custom dashboards (`v_ai_form_funnel_daily`, `v_ai_form_outcomes`). No AI on answers. |
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
| created_by_user_id | uuid | no | | FK `users.id` |
| archived_at | timestamptz | yes | | set when status becomes `archived` |
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
| published_by_user_id | uuid | yes | | FK `users.id`; check `(published_at is null) = (published_by_user_id is null)` |
| created_by_user_id | uuid | no | | FK `users.id` |
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

- **F1** `FormDefinition = { title: LocalizedText, intro?: LocalizedText, settings: FormSettings, sections: Section[], fields: Record<FieldKey, Field>, logic: LogicRule[], endings: Ending[] }`. `FormSettings = { resumeEnabled: boolean (default false), resumeDays: 1..30 (default 7), skipKnownFields: boolean (default true), capturePartialLeads: boolean (default false), showProgress: boolean (default true), sendResultEmail: boolean (default true for assessment, false otherwise), submitLabel: LocalizedText, createInboxThread: boolean (R3, default false) }`.
- **F2** Field types: `single_choice`, `multiple_choice`, `yes_no`, `rating` (scale 5 or 10), `number` (min, max, step), `short_text` (max 255 chars), `long_text` (max 5,000 chars), `dropdown`, `date` (min/max, ISO `YYYY-MM-DD`), `email`, `phone` (E.164 after normalisation, default region BE), `consent`, `hidden`, `utm`. Common properties: `key` (`^[a-z][a-z0-9_]{0,39}$`, unique in the form), `type`, `label`, `help?`, `required`, `visibleIf?: Condition`, `sensitive: boolean`, `sensitiveKind?: 'health'|'sleep'|'stress'|'recovery'|'wellbeing'`, `mapsTo?: 'person.email'|'person.first_name'|'person.last_name'|'person.phone'|'person.birth_on'`. Choice fields carry `options: [{ key, label, scores?: Record<DimensionKey, number> }]` (2 to 50 options). `multiple_choice` has `minSelected?`, `maxSelected?`. `consent` carries `purpose` and `wording: LocalizedText`. `hidden` carries `from: 'query'|'constant'`, `param?`, `value?`. `utm` carries `param: 'utm_source'|'utm_medium'|'utm_campaign'|'utm_term'|'utm_content'`.
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
- **L6** Conditions on a sensitive field are allowed; they are evaluated in memory and never stored.

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
- **P2** Completeness: every `LocalizedText` in definition and scoring (title, intro, labels, help, options, section titles and descriptions, ending texts, CTA labels, consent wording, submit label, dimension, range and outcome labels and texts, email subject and intro) passes `assertComplete(text, locales)`.
- **P3** Structure: unique keys; every field in one section; L3 and L4 hold; every referenced field, section, dimension, range, ending and outcome exists; formulas parse; no dimension cycle; at least one ending; `defaultOutcomeKey` exists when outcomes exist.
- **P4** Every kind except `survey` needs one required `email` field with `mapsTo: 'person.email'`. `sendResultEmail` needs that field and an `email` block on every `result` ending.
- **P5** A form with any sensitive field needs a required `consent` field with purpose `sensitive_processing` placed in the first section that holds a sensitive field or earlier.
- **P6** Consent fields: purpose in `newsletter|events|member_comms|b2b|sensitive_processing|ai_processing`; `newsletter`, `events`, `member_comms`, `b2b` and `ai_processing` fields must be `required: false` (freely given). `assessment_result` is never a field; it is recorded automatically (C3).
- **P7** Server-side checks at publish: CTA targets exist and are active (`products.is_active`, `session_templates.is_active`, session `status = 'open'` and in the future, webinar exists from R2); outcome `tagKeys` exist in `tags`; slug free and not reserved.
- **P8** Warnings (non-blocking): unreachable section or ending, outcome never selectable by its ranges, a long-text field unmarked sensitive on an assessment, a result ending without CTA.
- **P9** Publishing sets `published_at`, `published_by_user_id`, `forms.current_version_id`, `forms.status = 'published'` in one transaction. A new draft is created by copying the current version into `version + 1`. Restoring an old version copies it into a new draft.
- **P10** Archiving sets `status = 'archived'` and `archived_at`; the hosted page shows "This form is closed" and every public endpoint answers `410 form_closed`. Unarchiving restores `published` when a current version exists.
- **P11** A form can be deleted only while no version was ever published (no submissions exist).

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

### ID. Identity and prefill

- **ID1** Precedence: customer session (`identified_by = session`) > identity token `?pt=` (`token`) > resume token > typed email at submit (`email`) > none.
- **ID2** Session or token: known fields with `mapsTo` are prefilled; with `skipKnownFields` they are hidden and a summary line shows first name and masked email (`j•••@gmail.com`) with "Not you?", which drops the identification. With a session the email field is read-only; with a token, changing the email drops the token identification.
- **ID3** At submit the person is found or created by `crm.findOrCreatePersonByEmail` (lower-cased email). A new person gets `locale` = submission locale and `acquisition` from rule A2.
- **ID4** Profile updates: with `session` or `token` identification, submitted `mapsTo` values overwrite the person's fields. With `email` identification only empty person fields are filled; differing values are kept in `answers` and listed in the `form.completed` event `data.profileConflicts` (field names only). This stops anyone overwriting another person's data by typing their address, and still meets "existing customer record is updated".
- **ID5** Identity tokens: `pt = base64url(payload).base64url(hmac)`, payload `{ p: personId, f: formSlug|null, e: expiryEpochSeconds }`, HMAC-SHA256 with a key derived by HKDF-SHA256 from `AUTH_SECRET` (info `beam-forms-identity`). Default validity 30 days. They identify for prefill and linking only, never for portal access.
- **ID6** Result token = `base64url(HMAC-SHA256(key 'beam-forms-result', submission_id || ':' || result_token_version))`, 43 chars; only its sha256 is stored. Valid until `result_token_expires_at` (180 days). Bumping `result_token_version` revokes it.
- **ID7** The result page recognises the person: its CTAs carry a fresh identity token so a following form, booking or checkout page can prefill through `forms.api.verifyPersonToken()` without asking again.
- **ID8** An expired result link shows "This link has expired" with an email box; `requestResultLink` always answers "If we know this address, we sent you a new link" and, when a completed submission of that form exists for that email, sends a new link (max 3 per email per form per day).
- **ID9** `capturePartialLeads` (default off): when on, a saved section containing a valid email links the submission to a found-or-created person at that save, so `form.started` and `form.abandoned` reach the timeline. When off, an anonymous visitor who never submits leaves no person.

### C. Consent

- **C1** A checked consent field writes `crm.recordConsent` with `status = 'granted'`, `method = 'form'`, `source = 'form:<slug>'`, `wording_version = 'form:<slug>:v<version>:<fieldKey>'`, the request IP. An unchecked box records nothing (never a withdrawal).
- **C2** Consent is written only at submit (or at the save that links the person under ID9), and the snapshot goes into `consent_snapshot`.
- **C3** When the result email is sent, consent purpose `assessment_result` is recorded as `granted` with `wording_version = 'form:<slug>:v<version>:submit'`. It documents fulfilment of the request. No form path ever records `newsletter` unless the visitor ticks an optional newsletter field (acceptance test "a result does not create newsletter consent").
- **C4** The result email is transactional (`kind = transactional`, purpose null, template `form-result`): it is not gated on marketing consent, it is blocked by a suppression of scope `all`, and it never enrols the person in a marketing purpose.

### SE. Sensitive answers

- **SE1** Values of fields in `sensitive_field_keys` are never written to `form_submissions.answers`, `score`, `activity_events.data`, `audit_log`, logs or Sentry. They go only to `form_sensitive_answers`, encrypted with the current `SENSITIVE_DATA_KEY_V<n>`.
- **SE2** Before the `sensitive_processing` consent is checked, the server discards sensitive answers received in a save; the browser keeps them until consent is given. Submit without that consent fails with `validation`.
- **SE3** Decryption happens only in `readSensitive()`: staff with `persons.sensitive_read` on the submission detail (purpose `staff_view`), the subject on their own result page (purpose `subject_result`, system actor, token-verified) and the privacy export (purpose `privacy_export`). Each read writes `audit_log` action `sensitive.read`.
- **SE4** Sensitive fields and sensitive dimensions are never in `AI_ALLOWED_FIELDS` or `SEGMENT_ALLOWED_FIELDS`, never in staff CSV exports, never in the result email. `v_form_latest_results` exposes only outcome and non-sensitive total.
- **SE5** Anonymous `abandoned` submissions (no person) lose their sensitive answers after 30 days (`forms.retention_sweep`).

### A. Attribution and lead capture

- **A1** `start` reads the landing URL: `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`, `l` (tracked link key), `src` (explicit source), `ref` (embed referrer). Values are trimmed to 100 characters. Link UTM defaults fill only missing UTM values.
- **A2** `source` is derived by `deriveSource()` in `packages/core/src/forms/attribution.ts`, first match wins: explicit `src` from the allowed list; link channel `qr` → `qr`, `partner` → `partner`, `referral` → `referral`; `utm_medium` in (`cpc`,`paid`,`ppc`,`paid_social`) with `utm_source` in (`facebook`,`instagram`,`meta`) → `paid_social`; with `utm_source = google` → `paid_search`; `utm_medium = email` → `email`; embed → `embed`; otherwise `website`. `campaign` = `utm_campaign` or the link name.
- **A3** `persons.acquisition` is written once: at person creation through `findOrCreatePersonByEmail({ acquisition })`, or later through `crm.setAcquisitionIfEmpty` when it is still null. It is `{ source, campaign, medium, utm, referrer_person_id, partner_company_id }`. It never changes status, queue position or priority (blueprint 3).
- **A4** Every submission keeps its own source, campaign, UTM and link even when the person's acquisition was set earlier.
- **A5** Outcome `tagKeys` and an optional form-level tag `form:<slug>` are applied with `person_tags.source = 'form'` through `crm.applyTags`.

### E. Activity events (recorded with `ctx.recordEvent`, `is_sensitive = false`, `ref_type = 'form_submission'`)

| Kind | When | dedupe_key | data |
| --- | --- | --- | --- |
| `form.started` | person known at start, or backfilled at link time with `occurred_at = started_at` | `form:<submission_id>:started` | formId, formSlug, kind, version, source, campaign, utm, linkKey |
| `form.completed` | submit | `form:<submission_id>:completed` | the above + outcomeKey, total, non-sensitive dimensions with range keys, endingKey, profileConflicts, viaImport |
| `form.abandoned` | abandon job, person known | `form:<submission_id>:abandoned` | formId, formSlug, lastSectionKey, answeredCount |
| `form.result_viewed` | result page beacon | `form:<submission_id>:viewed:<YYYY-MM-DD>` | formSlug, outcomeKey |
| `form.cta_clicked` | CTA redirect | `form:<submission_id>:cta:<ctaKey>:<YYYY-MM-DD>` | formSlug, ctaKey, ctaKind, target id |

- **E1** Events without a person are not recorded (the timeline requires a person); funnel numbers come from `form_submissions` and `form_views_daily` instead.
- **E2** Events never contain answer values, only keys, counts, scores of non-sensitive dimensions and outcome.
- **E3** Booking and purchase after a form are not new form events; they are the booking and commerce events, joined in `v_form_conversions`.

### R. Rate limits and abuse

- **R1** Vercel WAF limits `/api/public/forms/*` to 20 requests per minute per IP (architecture).
- **R2** `start`: at most 30 per `ip_hash` per form per rolling hour; `submit`: at most 5 completions per email per form per rolling hour. Excess returns `429 rate_limited`.
- **R3** A honeypot field `website` and a minimum of 3 seconds between `start` and `submit`; a hit returns a normal-looking `200` thank-you, writes nothing and logs `forms.bot_dropped` (ids only).
- **R4** Request bodies above 64 KB return `413`.

### I. Import stopgap (ScoreApp and Typeform)

- **I1** `POST /api/public/forms/import/[sourceKey]/[secret]`: the sha256 of `secret` must equal `token_hash` (constant-time compare) and the source must be active, else `404`. The body is stored with `insert ... on conflict (source_id, external_id) do nothing`; `forms.process_import` is enqueued only when the insert happened. Response `200` within 2 seconds.
- **I2** `ImportMapping = { email: JsonPath, firstName?, lastName?, phone?, locale?, externalId: JsonPath, completedAt?: JsonPath, score?: JsonPath, outcome?: JsonPath, outcomeMap?: Record<string, OutcomeKey>, answers: Record<FieldKey, JsonPath>, sensitiveFieldKeys: FieldKey[], consents?: Record<Purpose, JsonPath> }`. JsonPath is a dotted path with `[n]` indexes; Typeform answers are addressed by `form_response.answers[field.ref=<ref>]`.
- **I3** Processing creates a `completed` submission on the mirror form's current version with `identified_by = 'import'`, `source = 'import'`, `external_ref`, finds or creates the person (ID3 and ID4 rules for `email`), stores sensitive mapped answers in `form_sensitive_answers`, writes `form.completed` with `viaImport: true`. A consent maps to granted only when the payload value is literally true; `newsletter` is never inferred.
- **I4** Imported results never send the result email (the external tool already did). A payload without a valid email is `skipped` with the reason.
- **I5** CSV backfill: staff upload a CSV export (max 2 MB, 5,000 rows) on the source page; each row becomes a `form_import_events` row with `external_id = sha256(row)` and the same job. Duplicate uploads are harmless.

## 4. Server surface

### Server actions (`apps/web/modules/forms/actions.ts`, all `audience: 'staff'` unless stated)

| Action (`name`) | Input (Zod summary) | Output | Permission | Audit action / events |
| --- | --- | --- | --- | --- |
| `createForm` (`forms.create`) | `{ slug, kind, name: LocalizedText, locales: Locale[], template?: 'blank'\|'lead'\|'assessment' }` | `{ formId, versionId }` | `forms.write` | `forms.created` |
| `updateFormMeta` (`forms.update_meta`) | `{ formId, slug?, name?, description? }`; slug change only while never published | `{ ok }` | `forms.write` | `forms.updated` |
| `saveDraft` (`forms.save_draft`) | `{ formId, versionId, definition: FormDefinition, scoring: FormScoring, locales, changeNote?, expectedHash }` | `{ definitionHash, issues: PublishIssue[] }`; `conflict` when `expectedHash` differs (another editor saved) | `forms.write` | `forms.draft_saved` (old and new `definition_hash` only, not the JSON) |
| `createDraft` (`forms.create_draft`) | `{ formId, fromVersionId? }` (default current) | `{ versionId }`; `conflict` if a draft exists | `forms.write` | `forms.draft_created` |
| `discardDraft` (`forms.discard_draft`) | `{ formId, versionId }` | `{ ok }` | `forms.write` | `forms.draft_discarded` |
| `publishVersion` (`forms.publish`) | `{ formId, versionId, changeNote }` | `{ version }` or `validation` with `PublishIssue[]` | `forms.publish` | `forms.published` (version, hash) |
| `archiveForm` / `unarchiveForm` | `{ formId }` | `{ ok }` | `forms.publish` | `forms.archived` / `forms.unarchived` |
| `deleteForm` (`forms.delete`) | `{ formId }`; only per P11 | `{ ok }` | `forms.publish` | `forms.deleted` |
| `duplicateForm` (`forms.duplicate`) | `{ formId, newSlug, name }` | `{ formId }` | `forms.write` | `forms.created` (with `duplicatedFrom`) |
| `createLink` / `updateLink` | `{ formId, name, channel, utm?, partnerCompanyId?, referrerPersonId? (R3) }` / `{ linkId, ...partial, isActive? }` | `{ linkId, key, url }` | `forms.write` | `forms.link_created` / `forms.link_updated` |
| `revealSensitiveAnswers` (`forms.reveal_sensitive`) | `{ submissionId }` | `{ answers: { fieldKey, label, value }[] }` | `persons.sensitive_read` | `sensitive.read` (written by `readSensitive`) |
| `resendResultEmail` (`forms.resend_result`) | `{ submissionId }`; max 3 per submission | `{ emailMessageId }` | `forms.write` | `forms.result_resent` |
| `revokeResultLink` (`forms.revoke_result_link`) | `{ submissionId }` | `{ ok }` | `forms.write` | `forms.result_link_revoked` |
| `deleteSubmission` (`forms.delete_submission`) | `{ submissionId, reason }` (spam, test) | `{ ok }` | `forms.publish` | `forms.submission_deleted` (reason, no answers) |
| `createImportSource` (`forms.create_import_source`) | `{ provider, name, mapping: ImportMapping, mirrorFields: Field[] }` | `{ sourceId, url }` (secret shown once) | `forms.publish` | `forms.import_source_created` |
| `updateImportSource` | `{ sourceId, name?, mapping?, isActive? }` | `{ ok }` | `forms.publish` | `forms.import_source_updated` |
| `rotateImportSecret` | `{ sourceId }` | `{ url }` | `forms.publish` | `forms.import_secret_rotated` |
| `uploadImportCsv` (`forms.upload_import_csv`) | `{ sourceId, csv: string (max 2 MB) }` | `{ inserted, duplicates }` | `forms.publish` | `forms.import_csv_uploaded` (counts) |
| `reprocessImportEvent` | `{ eventId }` (status `failed` or `skipped`) | `{ jobId }` | `forms.publish` | `forms.import_reprocessed` |
| `requestResultLink` (public, `audience: 'public'`) | `{ slug, email, locale }` | always `{ ok: true }` | none; rate-limited (ID8) | no audit; enqueues email when matched |

### Queries (`apps/web/modules/forms/queries.ts`)

- `listForms(db, { status?, kind?, q? }): FormListRow[]` with 30-day started, completed and completion rate from `v_form_funnel_daily` (`forms.write`).
- `getForm(db, formId): FormDetail` (form, current version, draft, link count) (`forms.write`).
- `getFormVersion(db, versionId): FormVersion`; `listVersions(db, formId): VersionRow[]`; `diffVersions(db, aId, bId): VersionDiff` (fields, logic, scoring added, removed, changed) (`forms.write`).
- `listSubmissions(db, { formId, status?, outcomeKey?, versionId?, source?, from?, to?, q?, cursor? }): Page<SubmissionRow>` (50 per page; `q` matches person email or name) (`forms.write` and `persons.read`).
- `getSubmission(db, submissionId): SubmissionDetail` (answers rendered against the pinned version, score, outcome, path, events, `hasSensitive`) (`forms.write` and `persons.read`).
- `getFormReport(db, { formId, from, to, groupBy: 'day'|'version'|'source'|'campaign'|'link' }): FormReport` (views, started, engaged, completed, abandoned, completion rate = completed / started, outcome distribution, conversion to booking and purchase within 30 days, revenue) (`reports.read` or `forms.write`).
- `listLinks(db, formId)`; `listImportSources(db)`; `listImportEvents(db, { sourceId, status?, cursor? })` (`forms.write`).
- Public (no permission, used by the hosted page): `getPublishedForm(db, slug, locale): PublicForm | { closed } | { unavailableLocale, locales } | null`, `getResultByToken(db, token): PublicResult | { expired } | null`.

### Route handlers (`apps/web/app/api/public/forms/`, `runtime = 'nodejs'`, `dynamic = 'force-dynamic'`, JSON, `cache-control: no-store` unless noted)

| Route | Body / params | Response | Effects |
| --- | --- | --- | --- |
| `POST /api/public/forms/[slug]/view` | `{ locale, linkKey? }` | `204` | upsert `form_views_daily` |
| `POST /api/public/forms/[slug]/start` | `{ locale, url, referrer?, embedHost?, identityToken?, honeypot }` | `{ submissionId, resumeToken?, prefill?: { firstName, maskedEmail, known: FieldKey[] } }` | insert submission; `form.started` when person known |
| `GET /api/public/forms/[slug]/resume?token=` | | `{ submissionId, answers (non-sensitive), currentSectionKey }` or `404` | status `abandoned` → `partial` |
| `POST /api/public/forms/[slug]/save` | `{ submissionId, resumeToken?, sectionKey, answers }` | `{ next: { sectionKey } \| { end: true } }` or `validation` | merge answers, sensitive split (SE2), ID9 |
| `POST /api/public/forms/[slug]/submit` | `{ submissionId, resumeToken?, answers, honeypot }` | `{ resultUrl?, redirectUrl?, endingKey }` | rule U3; the route named in the architecture |
| `POST /api/public/forms/result/[token]/viewed` | | `204` | `form.result_viewed` |
| `GET /api/public/forms/result/[token]/go/[ctaKey]` | | `302` to the CTA target with `pt=<identity token>` | `form.cta_clicked` |
| `POST /api/public/forms/import/[sourceKey]/[secret]` | provider payload | `200` | rule I1 |
| `GET /api/public/forms/embed.js` | | JavaScript, `cache-control: public, max-age=3600` | none |

Ownership of a submission on `save` and `submit`: the request must carry the `submissionId` plus either the resume token, or a session or identity token that matches the submission's person, or the signed `fsid` cookie (`HttpOnly`, `SameSite=None; Secure`, 24 hours, HMAC of the submission id) set by `start`. Otherwise `404`. Errors use the `action()` codes as JSON `{ ok: false, error: { code, message, fields? } }`; `410 form_closed`, `413`, `429 rate_limited`.

CTA targets for `go/[ctaKey]`: `booking` and `experience` → `/[locale]/account/book?template=<sessionTemplateId>`; `event` → `/[locale]/events/<sessionId>` (site); `product` → `/[locale]/account/shop/<productId>`; `webinar` (R2) → `/[locale]/webinars/<webinarId>`; `url` → the URL (https only, with `utm_source=beam_form&utm_medium=result&utm_campaign=<slug>` appended).

### Jobs (`apps/web/modules/forms/jobs.ts`, `defineJob`)

| Kind | Lane, priority | Input | Idempotency key | Retry | Behaviour |
| --- | --- | --- | --- | --- | --- |
| `forms.mark_abandoned` | fast, 5 | `{}` | `schedule:forms.mark_abandoned:<minute>` | default 6 attempts | updates up to 1,000 open submissions per run (`for update skip locked`), records `form.abandoned`; enqueues itself with key `forms.mark_abandoned:cont:<minute>:<n>` when 1,000 were updated |
| `forms.process_import` | fast, 5 | `{ importEventId }` | `forms-import:<import_event_id>` | 6 attempts; invalid mapping or missing email → `PermanentError`, event `skipped` | rule I3; a second run sees `status = processed` and returns |
| `forms.send_result_link` | fast, 1 | `{ submissionId, locale }` | `form-result-link:<submission_id>:<YYYY-MM-DD>:<n>` | 6 | calls `email.sendTransactional` with template `form-link` |
| `forms.retention_sweep` | bulk, 9 | `{}` | `schedule:forms.retention_sweep:<minute>` | 6 | per `retention_policies` keys `forms.*` (section 9), batches of 1,000 with self-continuation `forms.retention_sweep:cont:<date>:<n>` |

The result email itself is not a forms job: `submit` calls `email.sendTransactional` inside its transaction (key `form-result:<submission_id>`), which inserts `email_messages` and enqueues `email.send`; `after()` sends it within seconds.

### Schedules (`apps/web/modules/forms/schedules.ts`, cron in Europe/Brussels)

- `forms.mark_abandoned`: `*/10 * * * *`.
- `forms.retention_sweep`: `40 2 * * *` (after `files.purge_expired` at 02:00, before `jobs.prune` at 03:30).

### Event definitions (`apps/web/modules/forms/events.ts`, `defineEvent`)

`form.started`, `form.completed`, `form.abandoned`, `form.result_viewed`, `form.cta_clicked`, each with a Zod `data` schema matching the table in section 3 (E). Automation triggers may filter on `data.formSlug`, `data.kind`, `data.outcomeKey`, `data.source`.

### Cross-module API (`apps/web/modules/forms/api.ts`)

```ts
import type { DbOrTx } from '@beam/db';
import type { Locale, LocalizedText } from '@beam/core/i18n';

export type PublicFormRef = { id: string; slug: string; kind: FormKind; name: LocalizedText; locales: Locale[] };
export type PersonSubmissionSummary = { submissionId: string; formId: string; formSlug: string; formName: LocalizedText;
  version: number; status: SubmissionStatus; outcomeKey: string | null; outcomeLabel: LocalizedText | null;
  total: number | null; source: string; campaign: string | null; startedAt: Date; completedAt: Date | null; hasSensitive: boolean };
export type LatestOutcome = { formSlug: string; outcomeKey: string; totalScore: number | null; completedAt: Date };

/** Site pages and pickers (site, automation, email). */
export function listPublishedForms(db: DbOrTx): Promise<PublicFormRef[]>;
/** Outcome keys and labels of the current version (automation `where`, email content blocks). */
export function listOutcomes(db: DbOrTx, formSlug: string): Promise<{ key: string; label: LocalizedText }[]>;
/** Person page tab (crm) and portal. Never includes answer values. */
export function listPersonSubmissions(db: DbOrTx, personId: string): Promise<PersonSubmissionSummary[]>;
/** Latest outcome per form for many persons (email content blocks, ops profile). */
export function getLatestOutcomes(db: DbOrTx, personIds: string[]): Promise<Map<string, LatestOutcome[]>>;
/** Prefill links in emails and on result pages; identification only, never login. */
export function createPersonToken(personId: string, opts?: { formSlug?: string; ttlDays?: number }): string;
export function verifyPersonToken(token: string): { personId: string; formSlug: string | null; expiresAt: Date } | null;
/** Absolute hosted-form URL with optional identity token and UTM (email, automation, webinar). */
export function buildFormUrl(input: { slug: string; locale: Locale; personId?: string;
  utm?: Partial<Record<'source' | 'medium' | 'campaign' | 'term' | 'content', string>>; linkKey?: string }): string;
/** Server component for site page blocks: renders a published form inline (same origin). */
export { FormBlock } from './ui/public/form-block'; // props: { slug: string; locale: Locale; utm?: Record<string, string> }
```

## 5. Screens

All admin screens use `requirePermission()` and hide nav entries through `modules/forms/nav.ts` (entry "Forms" under Marketing, permission `forms.write`). Loading states use skeletons from `@beam/ui`; action errors show a toast with the error code's message; a missing translation renders `⟦forms.screen.element⟧`.

### Staff back-office (`apps/web/app/(admin)/admin/forms/`)

| Route | Shows | Actions | Empty / error states | Permission |
| --- | --- | --- | --- | --- |
| `/admin/forms` | DataTable: name, slug, kind, status, current version, locales, started and completed (30 days), completion rate; filters status and kind; search | New form, duplicate, archive, open | "No forms yet. Create a lead form or an assessment." with two template buttons | `forms.write` |
| `/admin/forms/new` | slug, kind, name (LocalizedInput), locales, template | `createForm` → builder | slug taken: inline field error | `forms.write` |
| `/admin/forms/[formId]` | overview: status, current version, draft badge, hosted URL with copy, embed snippet, last 7 days funnel, links count, import source if any | Edit draft, publish, archive or unarchive, delete (never published only) | archived banner | `forms.write` |
| `/admin/forms/[formId]/build` | three panes: section and field tree (drag to reorder), field editor (type, label, help, required, options with scores, `mapsTo`, sensitive toggle with kind, visibility condition builder), right pane tabs "Logic" (rules per section), "Endings" (ending editor with CTAs and email texts), "Settings" (F1 settings, locales). Issues panel from `validateForPublish` live; completeness badge per locale | autosave `saveDraft` 5 s after the last change; Publish (dialog with change note and the issue list) | no draft: "Create a draft from version n" button; save conflict: dialog "Someone else saved this draft" with reload | `forms.write`; Publish button needs `forms.publish` |
| `/admin/forms/[formId]/scoring` | dimensions (kind, formula editor with syntax check, ranges), total, outcomes (priority order, condition builder over scores, ranges and answers, ending, tags); formula tester with sample values | saved through `saveDraft` | "This form has no scoring. Add a dimension to score answers." | `forms.write` |
| `/admin/forms/[formId]/preview?version=&locale=` | the public renderer in an iframe with a "Preview, nothing is saved" bar; a side panel shows visited path, live scores, matched outcome, ending; locale switch | restart, jump to section | invalid draft: issue list with links to the builder | `forms.write` |
| `/admin/forms/[formId]/versions` | list: version, published at and by, change note, submissions count; read-only view; compare two versions (diff by field, logic, scoring) | Restore as draft | only a draft: "Not published yet" | `forms.write` |
| `/admin/forms/[formId]/submissions` | DataTable: started, completed, status, person (link to `/admin/persons/[id]`), outcome, total, version, source, campaign; filters status, outcome, version, source, date; cursor paging | Export CSV (non-sensitive columns only), open | "No submissions yet. Share the form link." | `forms.write` and `persons.read` |
| `/admin/forms/[formId]/submissions/[submissionId]` | answers per section as the visitor saw them (labels of the pinned version, in staff locale), hidden and UTM values, score per dimension with range, outcome, ending, path, consent snapshot, attribution, timeline of form events, result email status; sensitive answers as a locked card "n sensitive answers" | Reveal sensitive answers (audited), resend result email, revoke result link, delete submission | person null: "Anonymous submission"; deleted person: "Erased person" | view: `forms.write` and `persons.read`; reveal: `persons.sensitive_read`; delete: `forms.publish` |
| `/admin/forms/[formId]/submissions/export` (route handler `route.ts`) | CSV download | | | `forms.write` and `persons.read`, audit `forms.submissions_exported` |
| `/admin/forms/[formId]/links` | tracked links: name, channel, URL, partner, starts, completions; QR download (R3) | create, edit, deactivate, copy URL | "No tracked links. Create one per flyer, partner or ad." | `forms.write` |
| `/admin/forms/[formId]/report` | funnel (views, started, engaged, completed, abandoned), completion rate, outcome distribution, conversions to booking and purchase within 30 days with revenue; group by day, version, source, campaign, link; date range | CSV of the table | "Not enough data yet" below 1 started | `reports.read` or `forms.write` |
| `/admin/forms/imports` | import sources: provider, name, mirror form, last received, counts per status | create source (wizard: provider, field mapping, mirror fields), deactivate | "No import sources." | `forms.publish` |
| `/admin/forms/imports/[sourceId]` | webhook URL (secret masked), mapping, events table (received, status, error, submission link) | rotate secret, upload CSV, reprocess failed | | `forms.publish` |

The crm person page (`/admin/persons/[id]`) shows a "Forms" tab built by crm from `forms.api.listPersonSubmissions()`; it links to the submission detail.

### Public (`apps/web/app/[locale]/(site)/f/[slug]/`)

| Route | Shows | Audience |
| --- | --- | --- |
| `/[locale]/f/[slug]` | the hosted form: title, intro, one section per page, progress bar, prefill summary (ID2), resume offer (U5), localised validation, submit; on finish the ending (thank-you, result or redirect). Mobile first, WCAG 2.1 AA (labels, focus order, error summary). `?embed=1` renders without site header and footer and posts its height to the parent (`postMessage({ type: 'beam-form:height', h })`) | public |
| `/[locale]/f/[slug]/r/[token]` | personalised result: score (when `showScore`), dimensions with range labels and explanations, outcome label, explanation, recommendation, CTAs (BEAM experience, booking, event, product, webinar, URL); sensitive dimension values decrypted for the subject (SE3) | holder of the result token |

States: unknown slug → 404 page; archived → "This form is closed"; locale not in `locales` → "This form is not available in your language" with links to the available locales (never a mixed page); expired result → ID8 email box; revoked or unknown token → 404; network error on save → inline "Could not save, retrying" with three retries at 1, 3, 9 seconds, then a retry button; 429 → "Too many attempts, try again in a few minutes". Loading: the first section renders server-side; section transitions show a button spinner.

Embed script (`/api/public/forms/embed.js`, under 4 KB, no dependencies): finds `<div data-beam-form="<slug>" data-locale="nl|fr|en">`, creates an iframe to `/<locale>/f/<slug>?embed=1&embedHost=<location.host>&ref=<origin+path>` plus the parent page's `utm_*`, `l` and `src` query values, `loading="lazy"`, `title` from the form, and resizes on `beam-form:height` messages from the BEAM origin only. On the BEAM site itself the site module renders `FormBlock` inline instead.

### Customer portal (R2, `apps/web/app/[locale]/(portal)/account/results/`)

| Route | Shows | Audience |
| --- | --- | --- |
| `/[locale]/account/results` | the customer's completed submissions: form title, date, outcome label, "View result" (opens the result page through a fresh token), and open submissions with "Continue" | logged-in customer, filtered on `ctx.actor.personId` |

Empty: "You have not completed an assessment yet" with a link to the featured form (`settings` key none; the newest published assessment).

## 6. Integrations

This module calls no external provider directly. ScoreApp and Typeform call us (inbound webhook, rule I1); there is no outbound client, so there is no `packages/integrations` client and no `fake.ts` for them. Test fixtures with real-shaped payloads live in `apps/web/modules/forms/__fixtures__/{typeform,scoreapp}.json`.

- Email goes through `email.sendTransactional` (Resend behind it, owned by email).
- R3 inbox threads go through `crm.createInboxThread`; R3 ad cost is read from `ad_spend_daily`.
- Inbound import idempotency: unique `(source_id, external_id)` plus job key `forms-import:<id>`. Failure handling: a job that fails 6 times is `dead` and visible on `/admin/system/jobs` and on the source page with Reprocess. Typeform retries for up to 24 hours on non-2xx; we answer `200` as soon as the row is stored, so its retries only happen when our insert failed.

## 7. Permissions and audit

This module declares no new permission strings. `modules/forms/permissions.ts` registers `forms.write` and `forms.publish` (both in the architecture's list) and uses `persons.read`, `persons.sensitive_read` and `reports.read` from crm and ops.

| Capability | Permission | Default roles |
| --- | --- | --- |
| See forms, build drafts, preview, links, resend result email, revoke result link | `forms.write` | owner, technical_admin, management, marketing |
| Publish, archive, delete a never-published form, delete a submission, manage import sources and CSV backfill | `forms.publish` | owner, technical_admin, management, marketing |
| Submissions list, detail, CSV export | `forms.write` and `persons.read` | owner, technical_admin, management, marketing |
| Reveal sensitive answers | `persons.sensitive_read` | owner only by default (granted per role by the owner) |
| Form report | `reports.read` or `forms.write` | owner, technical_admin, management, marketing, customer_service, sales, finance |
| Forms tab on the person page (no answer values beyond non-sensitive answers) | `persons.read` | every staff role except external_partner |
| Partner counts per tracked link (R3) | `partner.own` | external_partner, only links with their `partner_company_id`, counts only |

Audited (`audit_log`, written by `action()` for every staff write; `entity_type` = `form`, `form_version`, `form_submission`, `form_link`, `form_import_source`): every action in section 4 with the listed action names, plus `forms.submissions_exported` (filters and row count) and `sensitive.read` (by `readSensitive`). Values in audit rows: form meta old and new values; `saveDraft` and `publishVersion` store only `definition_hash` and version numbers; `deleteSubmission` stores the reason and the submission id, never answers; import secrets are never logged. Public routes write no audit rows; their effects are traced by `activity_events` and `jobs`.

## 8. Multi-language and content

- Catalogue namespace `forms`, files `packages/core/src/i18n/messages/{en,nl-BE,fr-BE}/forms.json`, `en` the source. Key groups: `forms.list.*`, `forms.new.*`, `forms.builder.*` (field type names, condition operators, issue messages `forms.builder.issue.<code>`), `forms.scoring.*`, `forms.preview.*`, `forms.versions.*`, `forms.submissions.*`, `forms.report.*`, `forms.links.*`, `forms.imports.*`, `forms.public.*` (next, back, submit fallback, required, invalid email, invalid phone, number range, too long, saving, retry, closed, unavailable locale, resume offer, not you, expired link, link sent, rate limited, progress "Step {n} of {total}"), `forms.result.*` (your score, your profile, recommended for you), `forms.email.result.*` and `forms.email.link.*`, `forms.portal.results.*` (R2).
- `LocalizedText` content in `form_versions.definition` and `scoring`: title, intro, submit label, section title and description, field label and help, placeholder, option labels, consent wording, ending title and body, CTA labels, ending email subject and intro, dimension labels, range labels, explanations and recommendations, outcome labels, explanations and recommendations. `forms.name` is LocalizedText for staff and the portal list.
- Publish-time completeness is rule P2: `assertComplete()` over every content path listed above for every locale in `form_versions.locales`; the issue list names the path (for example `fields.sleep_hours.label: fr-BE missing`). Drafts may be incomplete. The builder shows a completeness badge per locale.
- A form may declare fewer locales than three. The hosted page for a locale outside `locales` shows the "not available in your language" page. `persons.locale` for a new person is the submission locale; the result email uses the submission locale (always in the version's locales, so it can never be blocked for translation). `form-link` emails use the submission locale too.
- Email templates `packages/email/src/templates/forms/form-result.tsx` (props: `firstName`, `formTitle`, `outcomeLabel`, `scoreLine` (non-sensitive total only), `explanation`, `recommendation`, `intro`, `resultUrl`, `ctas: { label, url }[]`) and `form-link.tsx` (`resultUrl`), static strings from `forms.email.*` through `t(locale, key)`.
- Dates in answers are shown with `Intl.DateTimeFormat(locale, { timeZone: 'Europe/Brussels' })`; numbers with `Intl.NumberFormat(locale)`.

## 9. Privacy

`apps/web/modules/forms/privacy.ts` registers into `GDPR_REGISTRY`:

```ts
export const formsPrivacy = {
  tables: ['form_submissions', 'form_sensitive_answers', 'form_links', 'form_import_events'],
  export: async (tx, personId) => ({ /* see below */ }),
  erase: async (tx, personId) => ({ /* see below */ }),
};
```

`NO_PII_TABLES` additions: `forms`, `form_versions` (definitions and staff user ids only), `form_views_daily`, `form_import_sources`.

| Table | Export (subject's GDPR export) | Erase | Why |
| --- | --- | --- | --- |
| `form_submissions` | every submission: form name, version, dates, status, answers with labels, score, outcome, source, campaign, UTM, consent snapshot | **deleted** | assessment answers and results are marketing and wellbeing data; no legal retention duty |
| `form_sensitive_answers` | decrypted with `readSensitive(ctx, personId, 'privacy_export')`, labelled per field | **deleted** (by `person_id` and by the person's submission ids) | special-category data |
| `form_import_events` | not exported (raw duplicates of the submissions already exported) | **deleted** where `email_hash` = sha256 of the person's email or `submission_id` belongs to the person | raw payloads hold the email and answers |
| `form_links` | not exported | `referrer_person_id` **set null** (anonymised) | link stays for the referring campaign's counts |
| `activity_events` `form.*` | exported by crm | handled by crm | append-only timeline owned by crm |
| `consent_records` from forms | exported by crm | retained by crm per its rules (proof of consent and withdrawal) | |

Erase runs inside `privacy.erase` under `SET LOCAL beam.allow_rewrite = 'on'` and returns `{ table, rows, action }` per table. It runs before crm's handler (forms rows reference `persons`). `privacy.test.ts` asserts that after erase no row in `form_submissions`, `form_sensitive_answers` or `form_import_events` references the person or their email hash, and that `form_links.referrer_person_id` is null.

Retention policies, seeded by `packages/db/src/seed/forms.ts` into `retention_policies` and run by `forms.retention_sweep` (ops' generic `privacy.retention_sweep` skips keys starting with `forms.`):

| key | table_name | days | action | Rule |
| --- | --- | --- | --- | --- |
| `forms.submissions` | `form_submissions` | 1095 | delete | completed or abandoned submissions older than 3 years by `coalesce(completed_at, abandoned_at)`, with their sensitive answers (cascade) |
| `forms.anonymous_abandoned` | `form_submissions` | 30 | delete | abandoned submissions without person (SE5) |
| `forms.sensitive_unlinked` | `form_sensitive_answers` | 30 | delete | sensitive rows with `person_id is null` whose submission is not completed |
| `forms.ip_hash` | `form_submissions` | 30 | anonymise | `ip_hash = null` |
| `forms.import_events` | `form_import_events` | 90 | delete | same as `webhook_events` |
| `forms.views` | `form_views_daily` | 1095 | delete | aggregates; no personal data, kept as long as submissions |

Other privacy guarantees: sensitive values never leave `form_sensitive_answers` except through `readSensitive` (SE1 to SE4); the unit test `forms-sensitive.test.ts` asserts that `form_sensitive_answers.value_enc` is in `SENSITIVE_COLUMNS` and that no forms column appears in `AI_ALLOWED_FIELDS` or `SEGMENT_ALLOWED_FIELDS` except `v_form_latest_results.outcome_key` and `total_score`. Logs carry submission ids only. The DPIA trigger of blueprint 66 ("sensitive assessment processing") is met by P5 (explicit consent) and the `settings.ai.sensitive_enabled = false` default, which forms never reads as permission to send answers to AI.

## 10. Dependencies

### Needs from other modules

| Module | What | Used for |
| --- | --- | --- |
| platform | `action()`, `defineJob`, `defineSchedule`, `defineEvent`, `enqueue`, `ctx.recordEvent`, `ctx.audit`, `requirePermission()`, `readSensitive()` with purposes `staff_view`, `subject_result`, `privacy_export` (and the overload `readSensitive(ctx, { table: 'form_sensitive_answers', submissionId }, purpose)`), `sensitive()` column helper, `encryptSensitive(value): { valueEnc, keyVersion }` from `@beam/core/privacy`, `users` table | every server path |
| crm | `findOrCreatePersonByEmail(tx, ctx, { email, firstName?, lastName?, phone?, locale, acquisition?, source: 'form' }): Promise<{ personId: string; created: boolean }>` | ID3 |
| crm | `updatePersonProfile(tx, ctx, personId, patch, { mode: 'overwrite' \| 'fill_empty' }): Promise<{ changed: string[]; conflicts: string[] }>` | ID4 |
| crm | `setAcquisitionIfEmpty(tx, ctx, personId, acquisition): Promise<boolean>` | A3 |
| crm | `recordConsent(tx, ctx, { personId, purpose, status, source, method, wordingVersion, ip }): Promise<void>` | C1, C3 |
| crm | `applyTags(tx, ctx, personId, tagKeys: string[], source: 'form'): Promise<void>`; `tags` table read at publish | A5, P7 |
| crm | `persons`, `companies` (FKs), `getPersonPrefill(db, personId): Promise<{ firstName, lastName, email, phone, birthOn }>` | ID2 |
| crm | merge calls `formsPrivacy.reassignPerson(tx, loserPersonId, winnerPersonId)` | edge case 25 |
| crm (R3) | `createInboxThread(tx, ctx, { channel: 'form', personId, subject, body, refType: 'form_submission', refId })` | contact forms in the unified inbox |
| email | `sendTransactional(tx, ctx, { personId, templateSlug: 'form-result' \| 'form-link', locale, data, idempotencyKey, purpose: 'assessment_result' }): Promise<{ emailMessageId: string }>`; the email module seeds an `email_templates` row for each component in `packages/email/src/templates/forms/` | C4, ID8 |
| booking | `session_templates`, `sessions` read (CTA targets, P7); `bookings` read in `v_form_conversions` | result CTAs, conversion |
| commerce | `products` read (CTA targets); `orders` read in `v_form_conversions` | result CTAs, conversion |
| ops | `retention_policies` read; generic sweep skips `forms.*` keys | section 9 |
| site | renders `FormBlock` inside its page blocks; routes `/[locale]/events/[id]` exist for event CTAs | site embedding |
| webinar (R2) | `webinars` read; `/[locale]/webinars/[id]` route | webinar CTA |
| ops (R3) | `ad_spend_daily` read | cost per lead |
| orchestrator | `next.config.ts` header for `/:locale/f/:path*`: `Content-Security-Policy: frame-ancestors *` (embedding on partner and landing-page sites); all other routes keep the frame restriction | embed script |

### Provides to other modules

| Module | What |
| --- | --- |
| crm | `listPersonSubmissions()` for the person page Forms tab; `form.*` events on the timeline |
| automation | events `form.started`, `form.completed`, `form.abandoned`, `form.result_viewed`, `form.cta_clicked` with `formSlug`, `kind`, `outcomeKey`, `source` in `data`; `listOutcomes()` and `listPublishedForms()` for trigger pickers; `buildFormUrl()` for invitation steps |
| email | `getLatestOutcomes()` for "assessment outcome" content blocks; `buildFormUrl()` and `createPersonToken()` for links in templates |
| ops | `v_form_funnel_daily`, `v_form_conversions`, `v_form_latest_results` (the latter joined into `v_person_profile` as `latest_outcomes`), form KPIs for the marketing dashboard (R3), `v_ai_form_*` (R4) |
| site | `FormBlock`, `listPublishedForms()` |
| booking, commerce | `verifyPersonToken()` to prefill guest checkout and booking pages from result-page CTAs |
| webinar (R2) | `buildFormUrl()` for post-webinar assessments |

## 11. Edge cases and failure modes

1. **Two staff edit the same draft.** `saveDraft` carries `expectedHash`; the second save gets `conflict` and a reload dialog. No silent overwrite.
2. **Publish while visitors are mid-form.** Their submissions stay pinned to the old version (U6) and complete with its scoring; reports group by version.
3. **A visitor answers, goes back and changes an answer that hides a later section.** At submit the server recomputes visibility (L1, L5) and drops answers of now-hidden fields before scoring.
4. **Logic sends the visitor to an ending before required fields of later sections.** Only fields on the visited path are required; the path is recomputed on the server, so a forged path fails `validation`.
5. **Formula divides by zero or uses an unanswered field.** The dimension is `null` (S3); no range or outcome matches it; `defaultOutcomeKey` applies; the result page hides the null dimension.
6. **Typed email belongs to an existing customer.** The submission links to that person; only empty fields are filled (ID4); conflicts are listed by name in the event; acquisition is not overwritten (A3).
7. **Typed email differs from the logged-in customer's email.** Impossible: the field is read-only with a session (ID2). With an identity token, changing the email drops the token and the typed email is used.
8. **Email belongs to an erased person.** `findOrCreatePersonByEmail` creates a new person (the partial unique index excludes erased rows); the suppression with reason `erased` still blocks marketing, the transactional result email is still sent because the person asked for it now.
9. **Email is suppressed with scope `all` (hard bounce or complaint).** The submission completes and the result page works; `email.send` blocks the result email (`suppressed`); the result page is the fallback.
10. **Visitor never gives consent for sensitive processing.** Sensitive answers are not stored at saves (SE2) and submit fails with a field error on the consent box; nothing sensitive reaches the database.
11. **Anonymous visitor abandons.** Submission becomes `abandoned`, no event (E1), no person; sensitive rows and the submission are deleted after 30 days (section 9).
12. **Abandoned submission is resumed and completed on day 3.** Status returns to `partial` then `completed`; `form.completed` fires once; an automation started on `form.abandoned` exits only if its `exit_on` lists `form.completed`; the builder's help text for `form.abandoned` triggers tells marketing to add it.
13. **Double click on submit or network retry.** U7: the second call returns the same result URL; the result email key `form-result:<submission_id>` prevents a second email; event dedupe keys prevent duplicate timeline rows.
14. **Bot floods the start endpoint.** WAF 20/min per IP, 30 starts per IP per form per hour, honeypot and minimum fill time (R1 to R3). Bot submissions write nothing.
15. **Form archived while visitors are mid-form.** `save` and `submit` answer `410 form_closed`; the page shows "This form is closed"; open submissions become abandoned after 24 h.
16. **Locale removed in a new version.** Visitors with that locale see the "not available" page; existing submissions in that locale keep their result pages (they use their pinned version).
17. **CTA target disappears after publish (product deactivated, session cancelled).** The `go` route checks the target: inactive or past targets fall back to the ending's first `url` CTA or to `/[locale]` and still record the click with `data.fallback = true`; the builder shows a warning on the form overview from a nightly check in `forms.retention_sweep`.
18. **Result token leaked or forwarded.** The result page shows only the result, first name and CTAs, never email, phone or raw answers; staff can revoke the link (`revokeResultLink`); tokens expire after 180 days.
19. **Identity token forwarded to another person.** It prefills only first name and masked email; "Not you?" clears it; with token identification the profile overwrite (ID4) applies, so the forwarded-link risk is accepted and limited to the person's own name and phone fields; tokens expire in 30 days.
20. **ScoreApp sends the same result twice, or a CSV is uploaded twice.** Unique `(source_id, external_id)` drops the duplicate; the job key prevents double processing.
21. **Import payload shape changes (Typeform field renamed).** The JsonPath for a required mapping key (`email`, `externalId`) resolves to nothing: `PermanentError`, event `skipped` with reason `mapping:email`; the source page shows the count and a Reprocess button after the mapping is fixed.
22. **Third-party cookies blocked inside the embed iframe.** The `fsid` cookie may be dropped; the client then sends the resume token (always issued for embedded forms, even with resume off, but stored only in memory) to prove ownership of the submission.
23. **Encryption key rotation during a submission.** New rows use the current `key_version`; `security.rekey` re-encrypts old rows; decrypt reads the row's version.
24. **Very large multiple-choice or long-text payloads.** Zod caps per type (U9) and the 64 KB body limit (R4) reject them with field errors.
25. **Person merged after submitting.** crm's merge moves `form_submissions.person_id` and `form_sensitive_answers.person_id` to the winner through forms' registered merge hook `reassignPerson(tx, loserId, winnerId)` in `privacy.ts` (exported alongside export and erase).

## 12. Build packages

Order: forms-P1 and forms-P2 run in parallel (no shared files). forms-P3 to forms-P7 are strictly sequential in that order because they share `apps/web/modules/forms/{api.ts,actions.ts,queries.ts,jobs.ts}` and the three `forms.json` catalogues; each package below names the shared files it edits. forms-P8 to forms-P10 follow in their releases. No package edits `package.json`, the lockfile, migrations, `packages/db/src/schema/index.ts` or any `registry/*.generated.ts`. Every package's done-definition includes: `pnpm gen:indexes && pnpm typecheck && pnpm lint` clean, its Vitest suites green (integration tests with `createTestDb()` and the Wave 0 factories), `pnpm i18n:check` green when it touched catalogues.

### forms-P1 (V1): schema and views

- **Goal:** every forms table, enum, index, check and view from section 2.
- **Files:** edit `packages/db/src/schema/forms.ts` (complete the Wave 0 stub, keeping its columns); create `packages/db/src/schema/forms.views.ts`, `packages/db/src/schema/forms.test.ts`.
- **Interfaces:** exported tables `forms`, `formVersions`, `formSubmissions`, `formSensitiveAnswers`, `formLinks`, `formViewsDaily`, `formImportSources`, `formImportEvents`; enums `formsKind`, `formsStatus`, `formSubmissionsStatus`, `formSubmissionsIdentifiedBy`, `formLinksChannel`, `formImportSourcesProvider`, `formImportEventsStatus`; views `vFormFunnelDaily`, `vFormConversions`, `vFormLatestResults`; inferred types `Form`, `FormVersionRow`, `FormSubmissionRow`.
- **Depends on:** `platform:users`, `crm:persons`, `crm:companies`, `booking:bookings`, `commerce:orders`, `email:email_messages` (Wave 0 contract tables).
- **Tests (`forms.test.ts`):** slug check rejects `Bad Slug` and `result`; `status = 'published'` without `current_version_id` fails; second draft per form violates `form_versions_one_draft_uq`; published row check `(published_at is null) = (published_by_user_id is null)`; `completed` without `completed_at` fails; unique result and resume token hashes; `form_import_events` duplicate `(source_id, external_id)` ignored with `on conflict do nothing`; `v_form_funnel_daily` counts views and statuses on the right Brussels day (23:30 UTC case); `v_form_conversions` sees a booking on day 29 and ignores day 31; `v_form_latest_results` returns the newest completion; `value_enc` is in `SENSITIVE_COLUMNS`.
- **Done:** the common done-definition.

### forms-P2 (V1): core engine (pure)

- **Goal:** definition schemas, logic, safe expression evaluator, scoring, outcomes, publish validation, attribution, sample seed.
- **Files:** create `packages/core/src/forms/{definition.ts,expression.ts,logic.ts,scoring.ts,validate.ts,attribution.ts,index.ts}` and tests `{definition,expression,logic,scoring,validate,attribution}.test.ts` beside them; create `packages/db/src/seed/forms.ts` (retention policy rows of section 9; sample forms "BEAM Recovery Check" (assessment: 3 sections, 12 fields, 3 dimensions, 4 outcomes, sensitive sleep and stress fields) and "Contact BEAM" (lead)).
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
  export function deriveSource(input: { src?: string; utm: Utm; linkChannel?: FormLinkChannel; embedded: boolean }): { source: FormSource; campaign: string | null };
  ```
- **Depends on:** `platform:@beam/core/i18n assertComplete, LocalizedText` (Wave 0).
- **Tests:** `expression.test.ts`: precedence, functions, `contains`, division by zero → null, rejects `constructor`, `__proto__`, `a.b.c` beyond allowed roots, 501-char input, depth 33; `logic.test.ts`: show/hide, skip, branch, conditional section, conditional ending, multiple conditions (`all`/`any`/`not`), forward-only, hidden answers dropped; `scoring.test.ts`: weighted options, rating weights, `avg` ignores unanswered, ranges inclusive and exclusive edges, formula dimension, total by sum and by formula, S4 outcome by total, by category range, by answer combination, default outcome, S6 sensitive dimension detection; `validate.test.ts`: one case per P2 to P6 and P8 code, including missing `fr-BE` label path, newsletter consent required → error, sensitive field without consent → error, cycle → error; `attribution.test.ts`: each A2 branch; `definition.test.ts`: limits F7, key regex, seeded sample forms validate with zero errors.
- **Done:** the common done-definition; coverage of `packages/core/src/forms` at least 90 %.

### forms-P3 (V1): submission pipeline, jobs, privacy and api

- **Goal:** the server logic of rules U, ID, C, SE, A, E and R, without HTTP: start, save, complete, abandon, tokens, sensitive storage, result email, retention, privacy, cross-module API.
- **Files:** create `apps/web/modules/forms/service/{tokens.ts,identity.ts,submissions.ts,sensitive.ts,rate-limit.ts,public-queries.ts,versions.ts}`; edit the Wave 0 files `apps/web/modules/forms/{api.ts,jobs.ts,schedules.ts,events.ts,permissions.ts,privacy.ts}`; create `packages/email/src/templates/forms/{form-result.tsx,form-link.tsx}`; tests `apps/web/modules/forms/service/{tokens,submissions,sensitive,rate-limit}.test.ts`, `apps/web/modules/forms/{jobs,privacy,api}.test.ts`.
- **Interfaces:**
  ```ts
  startSubmission(tx: Tx, ctx: PublicCtx, i: { slug: string; locale: Locale; url: string; referrer?: string; embedHost?: string; identityToken?: string; ip: string }): Promise<{ submissionId: string; resumeToken: string | null; prefill: Prefill | null }>;
  saveSection(tx: Tx, ctx: PublicCtx, i: { submissionId: string; proof: SubmissionProof; sectionKey: string; answers: Answers }): Promise<{ next: { sectionKey: string } | { end: true } }>;
  completeSubmission(tx: Tx, ctx: PublicCtx, i: { submissionId: string; proof: SubmissionProof; answers: Answers; ip: string }): Promise<{ resultUrl: string | null; redirectUrl: string | null; endingKey: string | null }>;
  markAbandoned(tx: Tx, ctx: JobCtx, limit: number): Promise<number>;
  createResultToken(submissionId: string, version: number): string; hashToken(t: string): string;
  publishVersion(tx: Tx, ctx: StaffCtx, i: { formId: string; versionId: string; changeNote: string }): Promise<{ version: number }>; // used by P5 actions
  ```
  plus every `api.ts` function of section 4 except `FormBlock`, and `privacy.ts` `{ tables, export, erase, reassignPerson }`.
- **Depends on:** forms-P1, forms-P2; `platform:action/defineJob/defineSchedule/defineEvent/recordEvent/readSensitive/encryptSensitive`; `crm:findOrCreatePersonByEmail`, `crm:updatePersonProfile`, `crm:setAcquisitionIfEmpty`, `crm:recordConsent`, `crm:applyTags`, `crm:getPersonPrefill`; `email:sendTransactional`. Stubs that still throw `NotImplementedError` are mocked with `vi.mock('@/modules/crm/api')` in unit tests; integration tests use the real crm functions once crm's Wave 1 package has merged.
- **Tests:** `submissions.test.ts`: U1 to U10 and ID1 to ID9, C1 to C4 (no `newsletter` consent row after an assessment with an unticked newsletter box; `assessment_result` row written), A3 (acquisition written once, second form keeps the first), E1 to E2 (no answer values in `activity_events.data`), existing customer updated (fill-empty vs overwrite), abandoned never emits `form.completed`, resume of abandoned → `partial`; `sensitive.test.ts`: SE1 (no sensitive key in `answers`, `score`, event data), SE2 (discarded before consent), sensitive dimension stored as `score:<key>`, decrypt via `readSensitive` writes `sensitive.read`; `tokens.test.ts`: identity token tamper, expiry, result token determinism and revocation by version; `rate-limit.test.ts`: R2 thresholds and R3 honeypot and 3-second rule; `jobs.test.ts`: `forms.mark_abandoned` and `forms.retention_sweep` run twice with the same payload give the same state; `privacy.test.ts`: export includes decrypted sensitive answers, erase leaves no referencing rows, `reassignPerson`; `api.test.ts`: `getLatestOutcomes`, `listPersonSubmissions` has no answer values.
- **Done:** the common done-definition.

### forms-P4 (V1): public routes, hosted page, result page and embed

- **Goal:** HTTP surface and the visitor UI: route handlers of section 4, `/[locale]/f/[slug]`, the result page, `embed.js`, `FormBlock`, public and email strings.
- **Files:** create `apps/web/app/api/public/forms/[slug]/{view,start,resume,save,submit}/route.ts`, `apps/web/app/api/public/forms/result/[token]/viewed/route.ts`, `apps/web/app/api/public/forms/result/[token]/go/[ctaKey]/route.ts`, `apps/web/app/api/public/forms/embed.js/route.ts`, `apps/web/app/[locale]/(site)/f/[slug]/{page.tsx,not-found.tsx}`, `apps/web/app/[locale]/(site)/f/[slug]/r/[token]/page.tsx`, `apps/web/modules/forms/ui/public/{form-renderer.tsx,field-inputs.tsx,form-block.tsx,result-view.tsx,embed-script.ts,http.ts}`; edit `apps/web/modules/forms/api.ts` (add the `FormBlock` export; sequential after forms-P3) and `packages/core/src/i18n/messages/{en,nl-BE,fr-BE}/forms.json` (keys `forms.public.*`, `forms.result.*`, `forms.email.*`); tests `apps/web/modules/forms/ui/public/{http,embed-script}.test.ts`, `apps/web/app/api/public/forms/routes.test.ts`, create `e2e/forms.spec.ts`.
- **Interfaces:** `FormBlock({ slug, locale, utm? }): Promise<JSX.Element>`; `embedScript(origin: string): string`; `handlePublic(req: Request, fn): Promise<Response>` in `http.ts` (body limit, JSON errors, IP extraction from `x-forwarded-for`, `fsid` cookie).
- **Depends on:** forms-P3; `site:(site) layout` (Wave 0 shell); `platform:proxy locale routing`; orchestrator: the `frame-ancestors` header of section 10.
- **Tests:** `routes.test.ts` (handlers called with `new Request()` on `createTestDb()`): happy path start → save → submit; 410 on archived; 404 without proof; 413; 429; honeypot returns 200 and writes nothing; `go/[ctaKey]` records `form.cta_clicked` once per day and redirects with `pt`; result `viewed` dedupes; `embed-script.test.ts`: iframe src carries UTM from the parent, ignores messages from other origins; `e2e/forms.spec.ts` against `beam_dev`: the seeded "BEAM Recovery Check" in `fr-BE` with branching to a conditional ending, result page shows score and CTA, the person exists with `acquisition.source = 'paid_social'` for `?utm_source=facebook&utm_medium=paid_social`, no newsletter consent, unavailable-locale page for a `nl-BE`-only form.
- **Done:** the common done-definition plus `e2e/forms.spec.ts` green at the wave checkpoint.

### forms-P5 (V1): admin builder, preview and versions

- **Goal:** staff create, edit, preview, publish, archive, duplicate and version forms; links management.
- **Files:** edit `apps/web/modules/forms/actions.ts` (form, draft, publish, archive, delete, duplicate, link actions), `apps/web/modules/forms/queries.ts` (`listForms`, `getForm`, `getFormVersion`, `listVersions`, `diffVersions`, `listLinks`), `apps/web/modules/forms/nav.ts`, the three `forms.json` catalogues (keys `forms.list.*`, `forms.new.*`, `forms.builder.*`, `forms.scoring.*`, `forms.preview.*`, `forms.versions.*`, `forms.links.*`; sequential after forms-P4); create `apps/web/app/(admin)/admin/forms/{page.tsx,new/page.tsx}`, `apps/web/app/(admin)/admin/forms/[formId]/{page.tsx,build/page.tsx,scoring/page.tsx,preview/page.tsx,versions/page.tsx,links/page.tsx}`, `apps/web/modules/forms/ui/admin/{form-list.tsx,field-tree.tsx,field-editor.tsx,condition-builder.tsx,logic-editor.tsx,ending-editor.tsx,scoring-editor.tsx,formula-input.tsx,issues-panel.tsx,preview-frame.tsx,version-diff.tsx,link-table.tsx}`, `apps/web/modules/forms/service/diff.ts`; tests `apps/web/modules/forms/{actions,permissions}.test.ts`, `apps/web/modules/forms/service/diff.test.ts`.
- **Interfaces:** the actions of section 4 rows `createForm` to `updateLink`; `diffVersions(a: FormVersionRow, b: FormVersionRow): VersionDiff`.
- **Depends on:** forms-P3 (`service/versions.ts`), forms-P4 (renderer reused by preview); `platform:@beam/ui LocalizedInput, DataTable`; `crm:tags` read; `booking:session_templates`, `booking:sessions`, `commerce:products` read for P7 checks.
- **Tests:** `actions.test.ts`: create → save → publish → edit creates `version + 1` draft; published row never updated (direct update attempt through the service throws); `expectedHash` conflict; publish fails with the issue list on a missing `fr-BE` label and on an inactive product CTA; restore old version as draft; delete refused after publish; archive → public `getPublishedForm` returns `closed`; audit rows carry hashes only; `permissions.test.ts`: every action denies without its permission (marketing allowed, reception denied, publish needs `forms.publish`); `diff.test.ts`: added, removed, changed field, logic and outcome.
- **Done:** the common done-definition; manual check in `pnpm dev` that the builder autosaves and the preview reflects branching.

### forms-P6 (V1): submissions, detail, export and report

- **Goal:** submissions list and detail with sensitive reveal, result email resend, link revoke, submission delete, CSV export, the funnel and conversion report.
- **Files:** edit `apps/web/modules/forms/actions.ts` (`revealSensitiveAnswers`, `resendResultEmail`, `revokeResultLink`, `deleteSubmission`, `requestResultLink`; sequential after forms-P5), `apps/web/modules/forms/queries.ts` (`listSubmissions`, `getSubmission`, `getFormReport`; sequential after forms-P5), the three `forms.json` catalogues (`forms.submissions.*`, `forms.report.*`); create `apps/web/app/(admin)/admin/forms/[formId]/submissions/{page.tsx,[submissionId]/page.tsx,export/route.ts}`, `apps/web/app/(admin)/admin/forms/[formId]/report/page.tsx`, `apps/web/modules/forms/ui/admin/{submission-table.tsx,submission-detail.tsx,sensitive-card.tsx,funnel-chart.tsx,report-table.tsx}`, `apps/web/modules/forms/service/export-csv.ts`; edit `apps/web/app/[locale]/(site)/f/[slug]/r/[token]/page.tsx` (expired state with the `requestResultLink` form; sequential after forms-P4); tests `apps/web/modules/forms/{submissions-admin,report}.test.ts`, `apps/web/modules/forms/service/export-csv.test.ts`.
- **Interfaces:** `toSubmissionCsv(rows: SubmissionExportRow[], version: FormVersionRow, locale: Locale): string`; `getFormReport` of section 4.
- **Depends on:** forms-P3, forms-P5; `platform:readSensitive`; `email:sendTransactional`, `email:email_messages` read; `booking:bookings`, `commerce:orders` through `v_form_conversions`.
- **Tests:** `submissions-admin.test.ts`: list filters and cursor; detail renders labels of the pinned version after a newer version changed the label; reveal requires `persons.sensitive_read` and writes `sensitive.read`; resend limited to 3 with distinct idempotency keys; revoke makes the old token 404; delete removes sensitive rows (cascade) and audits without answers; `requestResultLink` returns the same response for known and unknown emails and sends at most 3 per day; `export-csv.test.ts`: no sensitive column, CSV injection guard (cells starting with `=`, `+`, `-`, `@` prefixed with `'`); `report.test.ts`: completion rate, outcome distribution, conversion within 30 days, group by source and version.
- **Done:** the common done-definition.

### forms-P7 (V1): ScoreApp and Typeform import stopgap

- **Goal:** rules I1 to I5: import sources, webhook route, processing job, CSV backfill, admin screens.
- **Files:** create `apps/web/app/api/public/forms/import/[sourceKey]/[secret]/route.ts`, `apps/web/modules/forms/service/import.ts`, `apps/web/modules/forms/service/json-path.ts`, `apps/web/app/(admin)/admin/forms/imports/{page.tsx,[sourceId]/page.tsx}`, `apps/web/modules/forms/ui/admin/{import-wizard.tsx,import-events-table.tsx}`, `apps/web/modules/forms/__fixtures__/{typeform.json,scoreapp.json,scoreapp.csv}`; edit `apps/web/modules/forms/jobs.ts` (add `forms.process_import`; sequential after forms-P3), `apps/web/modules/forms/actions.ts` (import source actions; sequential after forms-P6), `apps/web/modules/forms/queries.ts` (`listImportSources`, `listImportEvents`; sequential after forms-P6), the three `forms.json` catalogues (`forms.imports.*`); tests `apps/web/modules/forms/service/{import,json-path}.test.ts`, `apps/web/modules/forms/jobs-import.test.ts`.
- **Interfaces:** `resolvePath(obj: unknown, path: string): unknown`; `processImportEvent(tx: Tx, ctx: JobCtx, eventId: string): Promise<'processed' | 'skipped'>`; `ingestCsv(tx: Tx, ctx: StaffCtx, sourceId: string, csv: string): Promise<{ inserted: number; duplicates: number }>` (uses `csv-parse/sync`, installed in Wave 0).
- **Depends on:** forms-P3 (`completeSubmission` internals for linking, consent and events); `crm:findOrCreatePersonByEmail`.
- **Tests:** wrong secret → 404 and nothing stored; duplicate event ignored; Typeform fixture creates a completed submission with mapped outcome and a sensitive answer only in `form_sensitive_answers`; no result email enqueued; missing email → `skipped`; `newsletter` consent never inferred from a non-true value; job run twice → same state; CSV uploaded twice → second upload `duplicates = n`; JsonPath `answers[field.ref=sleep].number`.
- **Done:** the common done-definition.

### forms-P8 (R2): portal results, cross-device resume, webinar CTA

- **Goal:** `/[locale]/account/results`, U5 for logged-in customers on any device, CTA kind `webinar`.
- **Files:** create `apps/web/app/[locale]/(portal)/account/results/page.tsx`, `apps/web/modules/forms/ui/portal/results-list.tsx`; edit `apps/web/modules/forms/service/submissions.ts` (session resume lookup), `apps/web/modules/forms/nav.ts` (portal entry), `packages/core/src/forms/validate.ts` (accept `webinar` CTAs), `apps/web/app/api/public/forms/result/[token]/go/[ctaKey]/route.ts` (webinar target), the three `forms.json` catalogues (`forms.portal.results.*`); tests `apps/web/modules/forms/portal-results.test.ts`, extend `packages/core/src/forms/validate.test.ts`.
- **Depends on:** forms-P1 to forms-P7; `webinar:webinars` table and `/[locale]/webinars/[id]` route.
- **Tests:** portal list shows only the actor's submissions; "View result" issues a fresh token; logged-in resume from a second session continues the same submission; webinar CTA validates against an existing webinar and redirects.
- **Done:** the common done-definition; `ff_forms_portal_results` flag gates the portal entry until BEAM switches it on.

### forms-P9 (R3): QR codes, referral and partner attribution, campaign report, inbox

- **Goal:** QR SVG and PNG per tracked link; referral links; partner view of counts; campaign attribution with cost per lead; contact forms into the unified inbox; marketing KPI view.
- **Files:** create `apps/web/modules/forms/service/qr.ts`, `apps/web/app/(admin)/admin/forms/[formId]/links/[linkId]/qr/route.ts`, `apps/web/app/(admin)/admin/forms/attribution/page.tsx`, `apps/web/modules/forms/ui/admin/attribution-table.tsx`; edit `packages/db/src/schema/forms.views.ts` (add `v_form_kpis_daily`: per day leads created by forms, completions, CTA clicks, conversions; and `v_form_campaign_attribution`: per `utm_campaign` leads, completions, bookings, revenue 30 d, joined to `ad_spend_daily` spend for cost per lead), `apps/web/modules/forms/service/submissions.ts` (inbox thread when `settings.createInboxThread`; referral `referrer_person_id` into acquisition), `apps/web/modules/forms/actions.ts`, `apps/web/modules/forms/queries.ts`, the three `forms.json` catalogues (`forms.attribution.*`); tests `apps/web/modules/forms/service/qr.test.ts`, `apps/web/modules/forms/attribution.test.ts`.
- **Depends on:** forms-P8; `crm:createInboxThread` (R3); `ops:ad_spend_daily` (R3); dependency request `qrcode@1.5.4` written to `docs/build/dependency-requests.md` before this wave.
- **Tests:** QR encodes the link URL (decode round-trip with a fixture); referral link sets `acquisition.referrer_person_id` for a new person only; partner user sees counts for their links only and no PII; attribution totals match fixtures; inbox thread created once per submission.
- **Done:** the common done-definition.

### forms-P10 (R4): AI-safe views and dashboard sources

- **Goal:** non-sensitive form data for natural-language questions and custom dashboards.
- **Files:** edit `packages/db/src/schema/forms.views.ts` (add `pgSchema('ai')` views `ai.v_ai_form_funnel_daily` (from `v_form_funnel_daily`) and `ai.v_ai_form_outcomes` (form slug, version, outcome key, Brussels day, count; no person ids)); create `apps/web/modules/forms/dashboard-sources.ts` (widget sources `forms.funnel`, `forms.outcomes`, `forms.conversion`); tests `apps/web/modules/forms/ai-views.test.ts`.
- **Depends on:** forms-P9; `ops:custom dashboards widget registry` (R4); `platform:beam_ai_ro role grants on schema ai` (custom migration by the orchestrator).
- **Tests:** the `ai` views expose no column that references `persons.id` and no sensitive column; outcome counts below 5 per day are merged into `other` (no re-identification); dashboard sources return the same totals as `getFormReport`.
- **Done:** the common done-definition.

## 13. Decisions made

Additions to the architecture:

1. **Four tables added:** `form_links` (tracked links and QR attribution), `form_views_daily` (page views for the funnel), `form_import_sources` and `form_import_events` (ScoreApp and Typeform stopgap; platform's `webhook_events.provider` enum is frozen and has no value for them).
2. **Columns added to `forms`:** `description`, `created_by_user_id`, `archived_at`, `updated_at`. **To `form_versions`:** `definition_hash`, `change_note`, `published_by_user_id`, `updated_at`; drafts are `form_versions` rows with `published_at is null`, one per form (partial unique index); immutability applies from publish on.
3. **Columns added to `form_submissions`:** `form_id`, `identified_by`, `ending_key`, `path`, `current_section_key`, `campaign`, `link_id`, `referrer_url`, `embed_host`, `result_token_version`, `result_token_expires_at`, `resume_token_hash`, `ip_hash`, `consent_snapshot`, `import_event_id`, `external_ref`, `result_email_message_id`, `abandoned_at`, `updated_at`; `person_id` is nullable (anonymous surveys and not-yet-identified visitors).
4. **`form_sensitive_answers.person_id` is nullable** until the submission is linked; columns `created_at`, `updated_at`; unique `(submission_id, field_key)`; sensitive dimension scores stored there as `score:<key>`.
5. **Three views:** `v_form_funnel_daily`, `v_form_conversions` (30-day booking and purchase window), `v_form_latest_results`; R3 adds `v_form_kpis_daily` and `v_form_campaign_attribution`; R4 adds two `ai` schema views.
6. **New routes beyond the architecture's `public/forms/[slug]/submit`:** `view`, `start`, `resume`, `save`, `result/[token]/viewed`, `result/[token]/go/[ctaKey]`, `import/[sourceKey]/[secret]`, `embed.js`; slugs `result` and `import` are reserved. Portal route `/[locale]/account/results` (R2) is added to forms' ownership.
7. **New job kinds:** `forms.mark_abandoned`, `forms.process_import`, `forms.send_result_link`, `forms.retention_sweep`; schedules `*/10 * * * *` and `40 2 * * *`. Forms runs its own retention for `forms.*` policy keys; ops' generic sweep skips them.
8. **Email templates** `form-result` and `form-link` live in `packages/email/src/templates/forms/`; the email module seeds their `email_templates` rows. Result emails use consent purpose `assessment_result` for the record and are transactional.
9. **`readSensitive()` needs two more purposes** (`staff_view`, `subject_result`) and an overload for `form_sensitive_answers`; requested from the Wave 0 owner of `packages/core/src/privacy/`.
10. **crm functions forms relies on beyond the Wave 0 contract:** `updatePersonProfile`, `setAcquisitionIfEmpty`, `recordConsent`, `applyTags`, `getPersonPrefill`, `createInboxThread` (R3), and crm's merge calling `formsPrivacy.reassignPerson`.
11. **Orchestrator change:** `next.config.ts` sends `frame-ancestors *` for `/:locale/f/:path*` only, so forms can be embedded on landing pages and partner sites.
12. **No new permission strings:** `forms.write` and `forms.publish` cover the module; submissions also need `persons.read`; reveal needs `persons.sensitive_read`.

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
30. Embedding uses an iframe plus a 4 KB script with height messages; the BEAM site renders forms inline through `FormBlock`.
31. Import credential is a 32-byte secret in the URL path (ScoreApp has no signature); Typeform's own HMAC is not checked in the stopgap. Imported results never trigger the result email, and consent is imported only from literal `true`.
32. CSV backfill of past ScoreApp and Typeform results runs through the same import pipeline (max 2 MB, 5,000 rows) instead of ops' import kinds.
33. Submissions are kept 3 years, anonymous abandoned ones 30 days, import payloads 90 days.
34. Erasure deletes submissions and sensitive answers outright (no legal retention duty); referral links lose their `referrer_person_id`.
35. Staff CSV exports never contain sensitive answers; cells are guarded against CSV injection.
36. Preview never persists anything.
37. QR image generation waits for R3 (needs the `qrcode` dependency); V1 tracked links are copyable URLs that staff may turn into a QR code with any tool.
38. A result CTA whose target disappeared falls back to the first URL CTA or the home page and records the click with `fallback = true`.
