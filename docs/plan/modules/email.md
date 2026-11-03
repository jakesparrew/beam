# Module `email`: Email platform

Owner paths: `packages/db/src/schema/email.ts`, `packages/db/src/schema/email.views.ts`, `packages/core/src/email/`, `packages/email/src/` (all of it, including every `templates/<m>/` folder), `packages/integrations/src/resend/`, `apps/web/modules/email/`, `apps/web/app/(admin)/admin/{email,templates,campaigns}/`, `apps/web/app/api/webhooks/resend/`, `apps/web/app/api/public/{unsubscribe,preferences,track}/`, `apps/web/app/[locale]/(site)/preferences/`, `apps/web/app/[locale]/(portal)/account/preferences/`, `packages/core/src/i18n/messages/<locale>/email.json`, `packages/db/src/seed/email.ts`, `e2e/email.spec.ts`, `e2e/scenario-2-fast-unsubscribe.spec.ts`.

Blueprint sections: 30, 31 (sending side), 32; requirements also taken from 4, 5, 6, 7, 8, 10, 12, 15, 17, 21, 33, 34, 53, 56, 59, 62, 63, 72, 76, 84.

## 1. Purpose and release mapping

The email module replaces Mailchimp. It sends every email the platform produces, through Resend, from two BEAM-owned domains. It owns templates (transactional and marketing), the block editor, campaigns, chunked sending, delivery events, the token-based preference centre, one-click unsubscribe, tracking, reporting and, in Release 4, AI-drafted campaigns. Automations (blueprint 31) are owned by `automation`; this module renders and delivers their email steps and exposes reachability.

| Release | What ships in `email` |
| --- | --- |
| **V1 (weeks 1-6)** | Resend integration with fake client; `mail.beam.be` (transactional) and `news.beam.be` (marketing) with SPF, DKIM, DMARC documented; warm-up caps; one-click unsubscribe headers; plain-text versions; legal footer for Vibrant Lifestyle Collective BV per locale with the reason for receiving; `email_templates` and immutable `email_template_versions`; the 17 transactional react-email templates; the block editor (JSON block document per locale, 10 block types, dynamic block by lead/customer/member/assessment outcome, personalisation tokens) rendered to MJML then HTML with BEAM branding and preview; campaigns with segment targeting and exclusions, audience snapshot, preview as a real contact and as lead, customer and member, test sends, recipient preview and removal, scheduling, pause, resume, stop, role-based sending, translation completeness check, chunked sending (500 per chunk, Resend batch 100) with per-chunk reachability and suppression re-check; `email_messages` and `email_events` from the Svix-signed Resend webhook; hard bounce and complaint suppression; soft bounce retry; open and click tracking routes; preference centre by token (newsletter, events, member communication, B2B) and in the portal; one-click unsubscribe effective within seconds (target 15 minutes) including `automation.exit_for_suppression`; bounce-rate auto-pause and complaint alerts; `email.send` with idempotency and final suppression check; campaign history per customer; per-campaign performance reporting; `EMAIL_SINK` outside production. |
| **Release 2 (weeks 9-10)** | Email support for the commercial engine: `webinar` block, lead-window aware `event` block ("Opens for you on ..." per recipient status, scenario 3), templates for webinar registration, reminders, replay availability, abandoned checkout recovery and lead-window opening. |
| **Release 3 (weeks 11-12)** | Campaign attribution for email: view `v_email_attribution` (orders paid within 7 days after a campaign click, last click wins), revenue and first-purchase columns on the campaign report, `getCampaignAttribution()` for `ops` marketing dashboards. |
| **Release 4 (weeks 13-14)** | AI-assisted campaign creation: Claude (`claude-opus-5-5`) drafts subject, preview text, block body in three locales, segment suggestion and send timing from BEAM tone of voice, brand guidelines, previous campaigns and event information; a human edits and approves; the system never schedules an AI draft by itself. |
| **Later (out of scope)** | SMS channel (noted in the proposal as optional per-message cost; not built); automated B2B prospecting and cold outbound email (blueprint 26, 27); personalised outbound email at scale; predictive send-time optimisation; A/B subject testing. |

## 2. Domain model

All tables live in `packages/db/src/schema/email.ts`; views in `packages/db/src/schema/email.views.ts`. Conventions from architecture section 2 apply (`id uuid pk default gen_random_uuid()`, `created_at timestamptz not null default now()`, `updated_at` on mutable tables, `pgEnum('<table>_<column>')`). `LocalizedText` = jsonb `{ "nl-BE"?: string, "fr-BE"?: string, "en"?: string }`. Wave 0 created stub `email_templates` and `email_messages`; this module completes them with additive columns only.

### Enums

| Enum | Values |
| --- | --- |
| `email_templates_kind` | `transactional`, `marketing` |
| `email_templates_purpose` | `newsletter`, `events`, `member_comms`, `b2b` |
| `email_templates_status` | `draft`, `published`, `archived` |
| `campaigns_purpose` | `newsletter`, `events`, `member_comms`, `b2b` |
| `campaigns_status` | `draft`, `planning`, `scheduled`, `sending`, `paused`, `sent`, `stopped`, `cancelled` |
| `campaigns_paused_reason` | `manual`, `bounce_rate` |
| `campaign_recipients_status` | `planned`, `sent`, `skipped_suppressed`, `skipped_consent`, `skipped_translation`, `skipped_unreachable`, `removed`, `failed` |
| `email_messages_kind` | `transactional`, `campaign`, `automation`, `test` |
| `email_messages_purpose` | `newsletter`, `events`, `member_comms`, `b2b` |
| `email_messages_status` | `queued`, `blocked_translation`, `suppressed`, `sent`, `delivered`, `bounced`, `complained`, `failed` |
| `email_messages_bounce_type` | `hard`, `soft` |
| `email_messages_from_domain` | `mail.beam.be`, `news.beam.be` |
| `email_events_type` | `sent`, `delivered`, `delayed`, `bounced`, `complained`, `opened`, `clicked`, `failed` |
| `email_events_source` | `resend`, `tracking` |
| `email_ai_drafts_status` (R4) | `queued`, `ready`, `failed`, `accepted`, `discarded` |

### `email_templates` (mutable)

| Column | Type | Null | Default / check |
| --- | --- | --- | --- |
| `id` | uuid | no | `gen_random_uuid()` |
| `slug` | text | no | unique; check `slug ~ '^[a-z0-9][a-z0-9._-]{2,79}$'`. Transactional slugs equal the template key (`booking.confirmation`) |
| `name` | text | no | staff-facing name |
| `description` | text | yes | |
| `kind` | `email_templates_kind` | no | |
| `purpose` | `email_templates_purpose` | yes | check `(kind = 'marketing') = (purpose is not null)` |
| `current_version_id` | uuid | yes | FK `email_template_versions.id` on delete restrict; points only at a published version |
| `status` | `email_templates_status` | no | `'draft'` |
| `is_system` | boolean | no | `false`; seeded transactional templates are `true` and cannot be archived |
| `created_by_user_id` | uuid | yes | FK `users.id` |
| `created_at`, `updated_at` | timestamptz | no | `now()` |

Indexes: unique `slug`; `(kind, status)`.

### `email_template_versions` (IMMUTABLE once `published_at` is set)

| Column | Type | Null | Default / check |
| --- | --- | --- | --- |
| `id` | uuid | no | |
| `template_id` | uuid | no | FK `email_templates.id` on delete restrict |
| `version` | integer | no | check `version > 0` |
| `subject` | jsonb `LocalizedText` | no | `'{}'` |
| `preheader` | jsonb `LocalizedText` | no | `'{}'` |
| `document` | jsonb `BlockDocument` | yes | marketing only: `{ schemaVersion: 1, locales: { [locale]: Block[] } }` (section 3, rule 20) |
| `copy` | jsonb `Record<slotKey, LocalizedText>` | yes | transactional only: editable text slots of the react-email component |
| `react_component` | text | yes | transactional only: the template key in `TEMPLATE_REGISTRY`; check `(react_component is null) = (copy is null)` |
| `html_by_locale` | jsonb | yes | marketing: compiled HTML per locale and dynamic variant, tokens left as placeholders; written at publish |
| `text_by_locale` | jsonb | yes | marketing: plain text per locale and variant; written at publish |
| `locales` | text[] | no | `'{}'`; check `locales <@ array['nl-BE','fr-BE','en']`; the locales complete at publish |
| `published_at` | timestamptz | yes | null = the one editable draft |
| `created_by_user_id` | uuid | yes | FK `users.id` |
| `ai_draft_id` | uuid | yes | FK `email_ai_drafts.id` (R4) |
| `created_at`, `updated_at` | timestamptz | no | `updated_at` changes only while draft |

Constraints: unique `(template_id, version)`; partial unique `(template_id) where published_at is null` (one draft per template). Invariant: rows with `published_at is not null` are never updated; the guard `assertDraftVersion()` in `packages/core/src/email/versions.ts` is called by every write and covered by a test. Editing a published template inserts a new draft `version = max + 1` copied from the current version.

### `campaigns` (mutable)

| Column | Type | Null | Default / check |
| --- | --- | --- | --- |
| `id` | uuid | no | |
| `name` | text | no | check `length(name) between 1 and 160` |
| `template_id` | uuid | no | FK `email_templates.id`; a marketing template created with the campaign (or chosen) |
| `template_version_id` | uuid | yes | FK `email_template_versions.id`; set to the published version when scheduled |
| `segment_id` | uuid | yes | `segments.id` (crm); no FK because `segments` is not a Wave 0 contract table; existence checked by the actions; required to schedule |
| `exclude_segment_ids` | uuid[] | no | `'{}'` |
| `purpose` | `campaigns_purpose` | no | must equal the template's purpose |
| `status` | `campaigns_status` | no | `'draft'` |
| `scheduled_at` | timestamptz | yes | |
| `audience_snapshot_at` | timestamptz | yes | |
| `recipients_count` | integer | no | `0` |
| `sent_count` | integer | no | `0` |
| `chunk_count` | integer | no | `0` |
| `run_no` | smallint | no | `1`; incremented on every resume (part of the chunk job key) |
| `paused_reason` | `campaigns_paused_reason` | yes | check `(status = 'paused') = (paused_reason is not null)` |
| `test_sent_at` | timestamptz | yes | last test send of the current draft |
| `started_at`, `finished_at`, `stopped_at`, `cancelled_at` | timestamptz | yes | |
| `last_error` | text | yes | |
| `stats_snapshot` | jsonb | yes | frozen `v_campaign_stats` row, written 30 days after `finished_at` |
| `ai_draft_id` | uuid | yes | FK `email_ai_drafts.id` (R4) |
| `created_by_user_id` | uuid | no | FK `users.id` |
| `updated_by_user_id` | uuid | yes | FK `users.id` |
| `version` | integer | no | `1`; optimistic lock, every action passes the version it read |
| `created_at`, `updated_at` | timestamptz | no | |

Indexes: partial `(scheduled_at) where status = 'scheduled'`; `(status, created_at desc)`.

### `campaign_recipients` (mutable, the audience snapshot)

| Column | Type | Null | Default / check |
| --- | --- | --- | --- |
| `id` | uuid | no | |
| `campaign_id` | uuid | no | FK `campaigns.id` on delete cascade |
| `person_id` | uuid | no | FK `persons.id` |
| `locale` | text | no | `persons.locale` at snapshot; check in the three locales |
| `chunk_no` | integer | no | `0`-based; `floor((row_number - 1) / 500)` at snapshot |
| `status` | `campaign_recipients_status` | no | `'planned'` |
| `email_message_id` | uuid | yes | FK `email_messages.id`, unique |
| `removed_by_user_id` | uuid | yes | FK `users.id`; check `(status = 'removed') = (removed_by_user_id is not null)` |
| `removed_at` | timestamptz | yes | |
| `created_at`, `updated_at` | timestamptz | no | |

Constraints: unique `(campaign_id, person_id)`; index `(campaign_id, chunk_no, status)`; index `(person_id)`.

### `email_messages` (mutable status, one row per email)

| Column | Type | Null | Default / check |
| --- | --- | --- | --- |
| `id` | uuid | no | |
| `person_id` | uuid | yes | FK `persons.id`; null only for test sends to a staff address |
| `to_email` | text | yes | **person data**; real address even when the sink rewrites it; nulled on erasure |
| `kind` | `email_messages_kind` | no | |
| `purpose` | `email_messages_purpose` | yes | check `kind not in ('campaign','automation') or purpose is not null` (marketing messages carry a purpose) |
| `template_version_id` | uuid | no | FK `email_template_versions.id` |
| `campaign_id` | uuid | yes | FK `campaigns.id` |
| `enrolment_id` | uuid | yes | `automation_enrolments.id` (no FK, automation's table) |
| `locale` | text | no | |
| `subject` | text | yes | rendered subject, **person data** (may contain first name) |
| `props` | jsonb | yes | transactional props for rendering, **person data**; nulled 30 days after `sent_at` |
| `attachments` | jsonb | no | `'[]'`: `[{ fileId, filename }]` |
| `from_domain` | `email_messages_from_domain` | no | `mail.beam.be` for transactional and test of transactional, `news.beam.be` otherwise |
| `idempotency_key` | text | no | unique |
| `resend_id` | text | yes | unique |
| `status` | `email_messages_status` | no | `'queued'` |
| `bounce_type` | `email_messages_bounce_type` | yes | |
| `attempt` | smallint | no | `1`; check `attempt between 1 and 2` |
| `retry_of_message_id` | uuid | yes | FK `email_messages.id` (soft-bounce retry) |
| `link_token_hash` | text | yes | unique; hex sha256 of the per-message link token (unsubscribe, preferences, tracking) |
| `links` | jsonb | yes | array of target URLs; click tracking redirects to `links[i]` only |
| `rendered_file_id` | uuid | yes | FK `files.id`; non-production only |
| `error` | text | yes | last error code, never personal data |
| `queued_at` | timestamptz | no | `now()` |
| `sent_at`, `delivered_at`, `opened_at`, `clicked_at`, `bounced_at`, `complained_at`, `unsubscribed_at`, `last_event_at` | timestamptz | yes | first occurrence of each |
| `created_at`, `updated_at` | timestamptz | no | |

Indexes: unique `idempotency_key`; unique `resend_id`; unique `link_token_hash`; `(person_id, created_at desc)`; `(campaign_id, status)`; partial `(created_at) where status in ('queued','blocked_translation')`; `(from_domain, sent_at)` (warm-up counting).

### `email_events` (APPEND)

| Column | Type | Null | Default / check |
| --- | --- | --- | --- |
| `id` | uuid | no | |
| `email_message_id` | uuid | no | FK `email_messages.id` on delete cascade (only the erasure job deletes, under `beam.allow_rewrite`) |
| `type` | `email_events_type` | no | |
| `source` | `email_events_source` | no | |
| `resend_event_id` | text | yes | unique (the `svix-id`); null for tracking events |
| `url` | text | yes | clicked URL |
| `link_index` | smallint | yes | |
| `payload` | jsonb | no | `'{}'`: only `{ bounce: { type, subType, message } }`, `{ ua_family }` or `{ reason }`; never addresses or IP |
| `occurred_at` | timestamptz | no | |
| `created_at` | timestamptz | no | |

Indexes: `(email_message_id, type)`; `(type, occurred_at)`. Listed in `APPEND_ONLY_TABLES`.

### `email_ai_drafts` (R4, mutable)

`id`; `campaign_id` uuid null FK `campaigns.id`; `brief` text not null (check length 10..4000); `inputs` jsonb not null `{ sessionIds: uuid[], segmentId: uuid|null, purpose, locales }`; `status` `email_ai_drafts_status` not null default `'queued'`; `output` jsonb null (`AiCampaignDraft`, section 4); `ai_request_id` uuid null FK `ai_requests.id` on delete set null; `error` text null; `created_by_user_id` uuid not null FK `users.id`; `decided_by_user_id` uuid null; `decided_at` timestamptz null; `created_at`, `updated_at`. Index `(created_by_user_id, created_at desc)`. Contains no person data: drafts are built from aggregates only.

### Views (`email.views.ts`, Drizzle `pgView(...).as(sql...)`)

`v_marketing_reachability`: one row per person and marketing purpose.

```sql
create view v_marketing_reachability as
with base as (
  select p.id as person_id, pu.purpose,
    case
      when p.erased_at is not null or p.merged_into_person_id is not null then 'erased'
      when p.email is null then 'no_email'
      when exists (select 1 from suppressions s
                   where s.email_hash = encode(sha256(convert_to(lower(p.email), 'UTF8')), 'hex')
                     and s.scope in ('all', pu.purpose)
                     and not (s.reason = 'unsubscribe' and c.status = 'granted'
                              and c.recorded_at > s.created_at
                              and c.method in ('preference_centre', 'portal', 'form'))) then 'suppressed'
      when c.status = 'withdrawn' then 'withdrawn'
      when c.status = 'granted' then null
      when pu.purpose = 'member_comms' and ps.status = 'member' then null
      when pu.purpose = 'b2b' and exists (select 1 from company_contacts cc where cc.person_id = p.id) then null
      else 'no_consent'
    end as blocked_reason
  from persons p
  cross join (values ('newsletter'), ('events'), ('member_comms'), ('b2b')) as pu(purpose)
  left join v_consent_current c on c.person_id = p.id and c.purpose = pu.purpose
  left join v_person_status ps on ps.person_id = p.id
)
select person_id, purpose, blocked_reason, blocked_reason is null as is_reachable from base;
```

`blocked_reason` values: `erased`, `no_email`, `suppressed`, `withdrawn`, `no_consent`. The hash expression must equal `emailHash()` from `@beam/core/crm` (lower-case, sha256, hex); a test asserts they agree.

`v_campaign_stats`: per campaign, from `campaign_recipients` and `email_messages`: `campaign_id`, `recipients`, `planned`, `removed`, `skipped` (all `skipped_*`), `sent` (messages with `sent_at`), `delivered`, `hard_bounced`, `soft_bounced`, `complained`, `unique_opens` (`opened_at` not null), `unique_clicks`, `unsubscribed`, and the rates `open_rate = unique_opens / nullif(delivered,0)`, `click_rate = unique_clicks / nullif(delivered,0)`, `click_to_open_rate`, `bounce_rate = hard_bounced / nullif(sent,0)`, `complaint_rate`, `unsubscribe_rate = unsubscribed / nullif(delivered,0)` as `numeric(6,4)`.

`v_email_attribution` (R3): per `campaign_id`, `person_id`, `order_id`, `paid_at`, `total_cents`, `is_first_purchase`: paid `orders` whose `paid_at` falls within 7 days after `email_messages.clicked_at` for a campaign message of the same person; when several campaigns qualify, the latest click before `paid_at` wins (`distinct on (order_id) ... order by order_id, clicked_at desc`).

### Tables of other modules this module reads or writes

| Table | Module | Access |
| --- | --- | --- |
| `persons`, `v_consent_current`, `suppressions`, `consent_records`, `segments`, `segment_members`, `company_contacts`, `activity_events` | crm | read; writes to `consent_records`, `suppressions` and `activity_events` only through `crm` api and `platform.recordEvent` |
| `v_person_status`, `memberships`, `v_person_credits` | credits | read (dynamic blocks, tokens) |
| `form_submissions`, `forms` | forms | read through `forms.listLatestOutcomes()` |
| `products`, `price_versions`; `sessions` | commerce; booking | read through `commerce.getProductCards()`, `booking.getSessionCards()` |
| `orders` | commerce | read (R3 attribution view) |
| `automation_enrolments` | automation | id only (`email_messages.enrolment_id`) |
| `settings`, `files`, `jobs`, `audit_log`, `webhook_events`, `integration_calls`, `ai_requests`, `users` | platform | read and write through platform helpers |
| `tasks` | crm | write through `crm.createTask()` (auto-pause review task) |
| `retention_policies` | ops | seed rows for email tables |

## 3. Business rules

Each rule is testable; the test file that proves it is named in section 12.

**Domains, senders and headers**

1. Transactional templates send from `mail.beam.be` (`BEAM <hello@mail.beam.be>`); marketing templates, campaigns and automation marketing steps send from `news.beam.be` (`BEAM <news@news.beam.be>`). Reply-To for both is `info@beam.be`. Values live in `settings.email_config.senders` and are editable by `settings.write`.
2. Every marketing message carries `List-Unsubscribe: <https://beam.be/api/public/unsubscribe/<token>>` (https only, no mailto) and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058). Transactional messages carry neither; they carry the legal footer only.
3. Every message is sent with both an HTML and a plain-text part. A message without a text part is a programming error and fails the render with `PermanentError('missing_text_part')`.
4. Every message ends with the legal footer: legal name Vibrant Lifestyle Collective BV, address and VAT number from `settings.company`, and a reason sentence from `settings.email_footer.reasons[<purpose or 'transactional'>][locale]` with `{date}` replaced by the consent `recorded_at` date (marketing) or omitted (transactional). Marketing footers add the links "Manage preferences" and "Unsubscribe from <category>".
5. A campaign cannot be scheduled and a marketing template cannot be published while `settings.company.legal_name`, `address` or `vat_number` is empty, or any reason text for the purpose is missing in a template locale.

**Warm-up and volume**

6. `settings.warmup_schedule = { domain: 'news.beam.be', start_on: <go-live date>, daily_caps: [1000, 2000, 4000, 8000] }`. Week `w = floor((today - start_on) / 7)`; the cap for a Brussels calendar day is `daily_caps[w]`; from week 4 on there is no cap. `mail.beam.be` has no cap.
7. A chunk counts `email_messages` with `from_domain = 'news.beam.be'` and `sent_at` today (Brussels). When the cap is reached mid-chunk, the chunk stops, leaves the rest `planned`, and enqueues itself again for the next day at 09:00 Brussels with the same key qualifier `:d<YYYYMMDD>`.
8. While a warm-up cap applies, `campaign.plan` orders recipients by most recent `opened_at` across their messages (most engaged first, never-opened last) before assigning `chunk_no`; outside warm-up it orders by `person_id`.

**Templates and versions**

9. A template has at most one draft version and any number of published versions; `current_version_id` points to the latest published one.
10. Publishing a version requires `assertComplete()` for `subject`, `preheader` and every text slot (`copy` or block text) in every locale listed in `locales`; marketing templates must list all three locales; transactional templates must list all three locales. The action fails with the list of missing `locale:path` items.
11. A published version is never updated. Saving changes to a published template creates a new draft copied from the current version.
12. Publishing a marketing version compiles MJML once per locale and per dynamic variant path and stores the result in `html_by_locale` and `text_by_locale`; compile errors (MJML `validationLevel: 'strict'`) block publishing and are shown per block.
13. A version's personalisation tokens must all be in `EMAIL_TOKENS` (rule 23); an unknown token blocks publishing.
14. Seeded transactional templates (`is_system = true`) cannot be archived; their copy can be edited and republished by `email.send` without a deploy.
15. Archiving a marketing template is refused while a campaign in `scheduled`, `sending` or `paused` or an active automation version references it.

**Block document**

16. Block types: `heading` (`level` 1-3, `text`), `text` (limited Markdown: bold, italic, links, bullet and numbered lists), `image` (`fileId` of a public `files` row of kind `image`, `alt` required, optional `href`, `width` 100-600), `button` (`label`, `href` https or token URL, `style` `primary|secondary`), `divider`, `spacer` (`height` 8-64), `columns` (2 or 3 columns, widths summing to 100, `stackOnMobile` default true), `product` (`productId`, `showPrice`, `ctaLabel`), `event` (`sessionId`, `ctaLabel`), `dynamic` (`variants: [{ when, blocks }]`, `fallback: Block[]`).
17. `columns` may not contain `columns` or `dynamic`; `dynamic` may not contain `dynamic`. A document has at most 200 blocks per locale and at most 256 KB of JSON.
18. A `dynamic` block evaluates variants in order and renders the first match; `when` is `{ status: 'lead'|'customer'|'member' }` (from `v_person_status`) or `{ assessmentOutcome: { formSlug, outcomeKeys: string[] } }` (latest completed submission of that form); no match renders `fallback` (may be empty).
19. `product` blocks render the product name, the public price at send time and a link to `/<locale>/shop/<sku>`; `event` blocks render title, Brussels date and time, and a link to `/<locale>/book/<sessionId>`. Both are resolved once per chunk; an inactive product or a cancelled or past session makes the block render nothing and the publish preview shows a warning.
20. The document shape is `{ schemaVersion: 1, locales: { 'nl-BE': Block[], 'fr-BE': Block[], 'en': Block[] } }`; each block has a stable `id` (nanoid 10). Locales may differ in structure.
21. The HTML of one message must stay under 102 KB (Gmail clipping); above that the editor shows a warning and publishing still succeeds.
22. Images are referenced by absolute URL `https://beam.be/api/public/files/<id>`; uploading through the editor creates a public `files` row (max 2 MB, `image/png|jpeg|gif|webp`).

**Personalisation**

23. Tokens: `{{first_name}}`, `{{last_name}}`, `{{full_name}}`, `{{status}}`, `{{credits_remaining}}`, `{{next_booking_at}}`, `{{membership_period_end_on}}`, `{{portal_url}}`, `{{preferences_url}}`, `{{unsubscribe_url}}`. Syntax `{{token|fallback}}`; the fallback is plain text written in that locale. A missing value without fallback renders an empty string. Values are HTML-escaped. `EMAIL_TOKENS` contains no `SENSITIVE_COLUMNS` member (unit test).
24. Token values come only from `persons` (names), `v_person_status`, `v_person_credits`, `memberships` and `bookings` via `booking.getNextBooking()`. Sensitive fields are never read.

**Campaign lifecycle**

25. States move only along: `draft → planning → scheduled → sending → sent`; `sending ↔ paused`; `sending|paused → stopped`; `draft|scheduled → cancelled`; `scheduled → draft` (unschedule); `planning → draft` on plan failure with `last_error`. `canTransition(from, to)` in `packages/core/src/email/campaign-state.ts` is the single check.
26. Scheduling requires: permission `campaigns.send`; a segment; the template's draft or current version complete for every locale present in the audience (counted by `getAudienceEstimate`); a test send of the current content after its last edit (`test_sent_at > draft.updated_at`); `scheduled_at` at least 5 minutes in the future and at most 90 days ahead, or "send now"; rule 5 satisfied.
27. Scheduling publishes the draft version (if one exists), sets `template_version_id`, moves to `planning` and enqueues `campaign.plan`. The audience snapshot inserts one `campaign_recipients` row per person in `segment_members` of `segment_id` (refreshed in the same job) minus members of every `exclude_segment_ids` segment, minus persons whose reachability for the purpose is false at snapshot time (those are not inserted), and sets `recipients_count`, `chunk_count`, `audience_snapshot_at`, status `scheduled`.
28. While `scheduled` or `paused`, staff with `campaigns.send` may remove a `planned` recipient (status `removed`, audited) and restore a removed one (back to `planned`). Removed recipients stay removed through refreshes.
29. "Refresh audience" (only in `scheduled`) inserts newly qualifying persons, marks `planned` rows that no longer qualify as `skipped_unreachable`, never touches `removed` or sent rows, and recomputes chunks for `planned` rows.
30. A campaign whose recipient locale is not in the version's `locales` is impossible to schedule (rule 26); if it still happens (a person changed locale after the snapshot), the chunk writes `skipped_translation` for that recipient.
31. At `scheduled_at` the minute schedule `email.dispatch_due_campaigns` sets `sending`, `started_at`, and enqueues one `campaign.send_chunk` per chunk number on the `bulk` lane, priority 9, key `campaign:<id>:chunk:<n>:r<run_no>`.
32. Each chunk, before every batch of 100: reloads the campaign and exits (job succeeds) if the status is not `sending`; then per recipient re-reads `v_marketing_reachability` and the suppressions for scope `all` and the purpose: unreachable for reason `suppressed` → `skipped_suppressed`; `withdrawn` or `no_consent` → `skipped_consent`; `erased` or `no_email` → `skipped_unreachable`.
33. A chunk inserts `email_messages` (key `campaign:<id>:person:<person_id>`, `kind = campaign`), renders per recipient from the precompiled HTML, sends through `ResendClient.sendBatch()` (max 100 per call, `Idempotency-Key: campaign:<id>:chunk:<n>:batch:<k>`), stores `resend_id` per message in returned order, sets recipient `sent` and increments `sent_count`.
34. When no `planned` recipient remains and no chunk job for this run is pending or running, the last chunk sets `sent` and `finished_at`.
35. Pause sets `paused` with reason `manual`; running chunks exit at the next batch boundary. Resume increments `run_no`, sets `sending` and enqueues chunks that still have `planned` recipients.
36. Stop sets `stopped`; chunks exit at the next batch; remaining `planned` rows stay `planned` and the report shows them as "not sent (stopped)". Messages already accepted by Resend cannot be recalled; the stop dialog says so.
37. Bounce-rate auto-pause: after each chunk and after each processed bounce event of a campaign message, if `sent >= settings.email_config.bounce_min_sent` (100) and `hard_bounced / sent > bounce_pause_pct / 100` (2 %), the campaign moves to `paused` with reason `bounce_rate`, an alert goes to Slack `#beam-alerts` and to every user with `campaigns.send` as a staff task (`crm.createTask`, kind `review`). Resuming after an auto-pause requires typing the campaign name in the confirm dialog.
38. Complaint alert: every 15 minutes `email.watch_complaints` computes complaints / delivered for `news.beam.be` over the last 24 hours; above 0.1 % (with at least 500 delivered) it enqueues `notify.slack` (key per hour) and shows a red banner on `/admin/email`.

**Single messages (`email.send`)**

39. `sendTransactional()` and `queueMarketingEmail()` insert an `email_messages` row with the caller's idempotency key and enqueue `email.send` (`fast` lane; priority 1 for transactional, 5 for automation) with key `email:<message_id>`. A second call with the same idempotency key returns the existing message and enqueues nothing new.
40. `email.send` re-checks just before calling Resend: the person is not erased; for marketing messages `v_marketing_reachability.is_reachable` for the purpose; for all messages a suppression of scope `all` with reason `hard_bounce`, `complaint` or `erased`. Exception: `platform.magic_link` and `platform.password_reset` ignore `complaint` suppressions (the person asked for them). A failed check sets status `suppressed` and the job succeeds.
41. A missing translation (`MissingTranslationError`) sets status `blocked_translation`, records `email.blocked` on the person's timeline and is a `PermanentError`; there is no fallback language. The daily digest and `/admin/email` list blocked messages.
42. The locale is `persons.locale` unless the caller passes `locale` (magic link before a person locale exists uses the URL locale).
43. Outside production (`VERCEL_ENV !== 'production'`), every recipient is rewritten to `EMAIL_SINK`, the subject is prefixed with `[<env> → <real address>]`, and the rendered HTML is stored in `files` (kind `rendered_email`, `expires_at = now() + 14 days`) linked by `rendered_file_id`. If `EMAIL_SINK` is unset outside production the job fails with `PermanentError('email_sink_missing')`.
44. Attachments (invoice and credit-note PDFs, receipts) are read from `files` and sent by single send only; batch never carries attachments. Total attachment size above 10 MB fails permanently.

**Events, bounces and complaints**

45. The Resend webhook is accepted only with a valid Svix signature (HMAC-SHA256 over `<svix-id>.<svix-timestamp>.<body>` with `RESEND_WEBHOOK_SECRET`) and a timestamp within 5 minutes; otherwise 401 and nothing is stored.
46. Event mapping: `email.sent` → `sent`; `email.delivered` → `delivered`; `email.delivery_delayed` → `delayed`; `email.bounced` → `bounced` (`bounce.type = 'Permanent'` → hard, otherwise soft); `email.complained` → `complained`; `email.opened`, `email.clicked` → stored with source `resend` (domain tracking is off; counted only if our own tracking missed it); `email.failed` → `failed`. Unknown types are stored in `webhook_events` and ignored.
47. Message status moves forward only by rank `queued(0) < sent(1) < delivered(2) < bounced(3) = complained(3) = failed(3)`; a `complained` event after `bounced` still sets `complained_at`. First-occurrence timestamps are set once.
48. A hard bounce inserts suppression scope `all`, reason `hard_bounce`, source `resend:<resend_id>`; a complaint inserts scope `all`, reason `complaint`, plus consent `withdrawn` for every marketing purpose with method `complaint`. Both enqueue `automation.exit_for_suppression`.
49. A soft bounce of a transactional message is retried once: a new message row (`attempt = 2`, `retry_of_message_id`, key `<original key>:retry`) is sent after 1 hour. A soft bounce of a marketing message is not retried. Three soft bounces for the same address within 30 days insert suppression scope `all`, reason `hard_bounce`, source `soft_bounce_x3`.
50. Opens are recorded by the pixel `GET /api/public/track/open?t=<token>` (marketing messages only); clicks by `GET /api/public/track/click?t=<token>&l=<index>`, which 302-redirects to `links[index]` of that message and to `https://beam.be/<locale>` when the token or index is invalid (no open redirect). Every hit appends an `email_events` row; `opened_at` and `clicked_at` keep the first. A click also sets `opened_at` when it is null.
51. Transactional messages carry no tracking pixel and no click rewriting.
52. Timeline events (via `platform.recordEvent`): `email.sent` (`dedupe_key = email:<id>:sent`, data `{ templateSlug, campaignId, subject }`), `email.opened` (first only), `email.clicked` (first per link index), `email.bounced`, `email.complained`, `email.blocked`, `email.unsubscribed`, `email.preferences_updated`. Test sends write no events.

**Preference centre and unsubscribe**

53. Every marketing message gets a fresh 32-byte random link token; only its sha256 hex is stored (`link_token_hash`). The token identifies the message, hence the person and purpose. Tokens older than 365 days are refused; the page then offers "send me a new link" (rule 57).
54. One-click unsubscribe (`POST /api/public/unsubscribe/<token>` with body `List-Unsubscribe=One-Click`) in one transaction: inserts suppression scope = message purpose, reason `unsubscribe`, source `one_click:<message_id>` (on conflict nothing); records consent `withdrawn` for that purpose with method `unsubscribe_link`; sets `unsubscribed_at`; records `email.unsubscribed`; enqueues `automation.exit_for_suppression` (key `supp:<suppression_id>`, lane `fast`); `after()` runs it at once. Response 200 with an empty body. A `GET` of the same URL writes nothing and shows a one-button confirmation page; the footer link "Unsubscribe from <category>" points there. After unsubscribing, the page offers "Undo", which re-grants consent with method `preference_centre`.
55. The preference centre shows four categories (newsletter, events, member communication, B2B) with their current state and lets the person switch each on or off, or "unsubscribe from all marketing" (suppression scope `all`, reason `unsubscribe`). Switching a category off writes consent `withdrawn` and a suppression of that scope; switching on writes consent `granted` with method `preference_centre` and the current wording version from `settings.email_footer.consent_wording_version`, which lifts an earlier `unsubscribe` suppression (view rule) but never a `hard_bounce`, `complaint`, `manual` or `erased` one; those categories show "blocked, contact BEAM".
56. Unsubscribing from one category never changes other categories and never blocks transactional email.
57. "Send me a new link" takes an email address, always answers "If this address is known, we sent a link", and at most 3 times per address per hour sends `email.preference_link` (transactional) with a fresh token.
58. Logged-in customers manage the same four categories at `/[locale]/account/preferences` with method `portal`.
59. Imports never lift suppressions: only consent rows with method `preference_centre`, `portal` or `form` written after the suppression lift an `unsubscribe` suppression (proposal acceptance "suppression survives an import").
60. An unsubscribe must stop marketing within 15 minutes; by construction it stops at the next `email.send` or chunk batch, and running enrolments exit within seconds (scenario 2).

**Reporting and history**

61. The campaign report shows recipients, skipped by reason, sent, delivered, unique opens, unique clicks, hard and soft bounces, complaints, unsubscribes, and the rates of `v_campaign_stats`; clicks per link index; and per-locale counts.
62. 30 days after `finished_at`, `email.freeze_campaign_stats` stores the `v_campaign_stats` row in `stats_snapshot`; reports read the snapshot when present, so retention deletes do not change historic numbers.
63. The person page shows every message to that person (campaign, automation, transactional) with status, open and click times, newest first, 50 per page.

## 4. Server surface

All mutations use `action({ name, audience, permission, input, audit }, handler)` in `apps/web/modules/email/actions.ts`; staff writes are audited by the wrapper with the `audit` entity type shown. Inputs are Zod schemas named `<Action>Input` in `packages/core/src/email/inputs.ts`. Every campaign and template action that edits a row takes `expectedVersion` (campaigns) or `draftUpdatedAt` (versions) and fails with `conflict` when stale.

### Server actions (staff)

| Action (`name`) | Input (summary) | Output | Permission | Audit action / activity |
| --- | --- | --- | --- | --- |
| `createTemplate` (`email.template_create`) | `{ name, kind: 'marketing', purpose, slug? }` | `{ templateId, draftVersionId }` | `email.write` | `email.template_create` |
| `saveTemplateDraft` (`email.template_save`) | `{ templateId, draftUpdatedAt, subject: LocalizedText, preheader: LocalizedText, document?: BlockDocument, copy?: Record<string, LocalizedText> }` | `{ draftVersionId, updatedAt, completeness: { locale, missing: string[] }[] }` | `email.write` | none (drafts are not audited; publish is) |
| `publishTemplateVersion` (`email.template_publish`) | `{ templateId, draftUpdatedAt }` | `{ versionId, version }` or `validation` with missing items | `email.send` | `email.template_publish` (old and new version ids) |
| `archiveTemplate` | `{ templateId }` | `{ ok }` | `email.send` | `email.template_archive` |
| `duplicateTemplate` | `{ templateId, name }` | `{ templateId }` | `email.write` | `email.template_create` |
| `uploadEmailImage` | `{ name, mime, bytesBase64 }` (max 2 MB) | `{ fileId, url }` | `email.write` | none |
| `sendTestEmail` (`email.test_send`) | `{ templateId, use: 'draft'|'current', locales: Locale[] (1-3), to: email[] (1-5, must be staff `users` emails), as: { personId } | { sample: 'lead'|'customer'|'member', assessmentOutcome?: string }, campaignId? }` | `{ messageIds }` | `email.write` (`persons.read` too when `as.personId`) | `email.test_send`; sets `campaigns.test_sent_at` |
| `createCampaign` (`email.campaign_create`) | `{ name, purpose, templateId? }` (creates a marketing template `campaign-<yyyymmdd>-<slug>` when absent) | `{ campaignId }` | `email.write` | `email.campaign_create` |
| `updateCampaign` | `{ campaignId, expectedVersion, name?, segmentId?, excludeSegmentIds?, scheduledAt? }` (only in `draft`) | `{ version }` | `email.write` | `email.campaign_update` |
| `scheduleCampaign` (`email.campaign_schedule`) | `{ campaignId, expectedVersion, scheduledAt: Date | 'now' }` | `{ status: 'planning' }` or `validation` listing failed rule-26 checks | `campaigns.send` | `email.campaign_schedule` (blueprint 56 "Campaign sent") |
| `unscheduleCampaign` | `{ campaignId, expectedVersion }` | `{ status: 'draft' }` (deletes `planned` and `removed` recipients) | `campaigns.send` | `email.campaign_unschedule` |
| `refreshAudience` | `{ campaignId, expectedVersion }` | `{ added, skipped }` | `campaigns.send` | `email.campaign_refresh` |
| `removeRecipient` / `restoreRecipient` | `{ campaignId, personId }` | `{ ok }` | `campaigns.send` | `email.recipient_remove` / `email.recipient_restore` (person_id set) |
| `pauseCampaign` / `resumeCampaign` | `{ campaignId, expectedVersion, confirmName? }` | `{ status }` | `campaigns.send` | `email.campaign_pause` / `email.campaign_resume` |
| `stopCampaign` | `{ campaignId, expectedVersion }` | `{ status: 'stopped', notSent }` | `campaigns.send` | `email.campaign_stop` |
| `cancelCampaign` | `{ campaignId, expectedVersion }` | `{ status: 'cancelled' }` | `campaigns.send` | `email.campaign_cancel` |
| `duplicateCampaign` | `{ campaignId }` | `{ campaignId }` (new draft, content copied into a new draft version) | `email.write` | `email.campaign_create` |
| `resendMessage` | `{ messageId }` (transactional, status `sent|delivered|bounced|failed`) | `{ messageId }` (key `<original>:manual:<n>`) | `email.send` | `email.message_resend` |
| `addManualSuppression` | `{ email, scope, note }` | `{ suppressionId }` | `email.send` | `email.suppression_add`; activity `email.unsubscribed` with `method = staff` |
| `requestAiDraft` (R4) | `{ brief, sessionIds: uuid[] (0-3), segmentId?, purpose, campaignId? }` | `{ draftId }` | `email.write` + `ai.use` | `email.ai_draft_request` |
| `acceptAiDraft` (R4) | `{ draftId, campaignName }` | `{ campaignId }` (draft campaign with the AI content in a draft version) | `email.write` + `ai.use` | `email.ai_draft_accept` |
| `discardAiDraft` (R4) | `{ draftId }` | `{ ok }` | `email.write` | `email.ai_draft_discard` |

### Server actions (public and customer)

| Action | Audience | Input | Effect |
| --- | --- | --- | --- |
| `updatePreferencesByToken` | public (token) | `{ token, categories: Record<Purpose, boolean>, unsubscribeAll: boolean }` | rule 55; audit actor `{ kind: 'customer' }` with `person_id`; activity `email.preferences_updated` |
| `requestPreferenceLink` | public | `{ email, locale }` | rule 57; rate-limited (`rate_limited`) |
| `updateMyPreferences` | customer | `{ categories, unsubscribeAll }` | same as by token, method `portal`, person from `ctx.actor.personId` |

### Queries (`queries.ts`)

`listTemplates({ kind?, status?, q?, page })`, `getTemplate(templateId)` (template, draft, current version, completeness, references), `getPreview({ templateId, use, locale, as })` → `{ subject, preheader, html, text, sizeBytes, warnings }`, `listCampaigns({ status?, q?, page })`, `getCampaign(campaignId)`, `getAudienceEstimate({ segmentId, excludeSegmentIds, purpose })` → `{ total, reachable, byLocale: Record<Locale, number>, blockedByReason }`, `listCampaignRecipients({ campaignId, status?, q?, page, pageSize: 50 })`, `getCampaignReport(campaignId)` → stats plus `clicksByLink`, `byLocale`, R3 `attribution`, `listMessages({ status?, kind?, q?, from?, to?, page })`, `getMessage(messageId)` (with events), `listPersonEmails({ personId, page })`, `getDeliverability()` → domains, warm-up day and cap, sent today, 7-day bounce and complaint rates, blocked messages, recent suppressions, `getPreferencesByToken(token)` → `{ firstName, locale, categories, blocked, expired }`, `getMyPreferences()`, `listAiDrafts()` (R4). Staff queries call `requirePermission('email.write')`, except `getDeliverability` and reports which accept `reports.read` as well.

### Route handlers

| Route | Method | Behaviour |
| --- | --- | --- |
| `app/api/webhooks/resend/route.ts` | POST | Verify Svix (rule 45); `insert into webhook_events (provider 'resend', external_event_id = svix-id)` on conflict nothing; when inserted, enqueue `webhook.process` key `webhook:resend:<svix-id>`; 200 in under 2 s. Platform's `webhook.process` calls `email.processResendEvent()` |
| `app/api/public/unsubscribe/[token]/route.ts` | POST | one-click (rule 54); always 200 (unknown tokens too, nothing written) |
| same | GET | writes nothing; 303 to `/<locale>/preferences/<token>?confirm=<purpose>`, where one button performs the unsubscribe (link scanners that prefetch GET never unsubscribe anyone) |
| `app/api/public/preferences/[token]/route.ts` | GET | JSON of `getPreferencesByToken` for the page; 404 for unknown token |
| `app/api/public/track/open/route.ts` | GET `?t=` | rule 50; returns a 43-byte transparent GIF, `cache-control: no-store`, always 200 |
| `app/api/public/track/click/route.ts` | GET `?t=&l=` | rule 50; 302 |

No mailto unsubscribe address exists: the https one-click URL satisfies RFC 8058 and the Gmail and Yahoo bulk-sender rules.

### Jobs (`jobs.ts`, `defineJob`)

| Kind | Lane, priority | Key | Attempts and errors | Does |
| --- | --- | --- | --- | --- |
| `email.send` | fast, 1 (transactional) or 5 | `email:<message_id>` | 6, standard backoff; `IntegrationError.retryable=false` (Resend 4xx except 429) → `PermanentError` → status `failed`; 429 and 5xx retry | rules 40-44: final check, render, sink, `ResendClient.send()` with `Idempotency-Key: email:<message_id>`, status `sent`, `email.sent` event |
| `campaign.plan` | bulk, 9 | `campaign:<id>:plan:<scheduled ms>` | 3; failure → campaign `draft` with `last_error` | rule 27 in one transaction (`crm.refreshSegment`, `insert ... select`) |
| `campaign.send_chunk` | bulk, 9 | `campaign:<id>:chunk:<n>:r<run_no>` (warm-up continuation adds `:d<YYYYMMDD>`) | 6; per-recipient render errors mark that recipient `failed` and continue | rules 32-37 |
| `email.retry_soft_bounce` | fast, 5 | `email:<message_id>:retry` | 3 | rule 49, run at `bounced_at + 1 h` |
| `email.freeze_campaign_stats` | bulk, 9 | `campaign:<id>:freeze` | 3 | rule 62 |
| `email.erase_provider_data` | fast, 5 | `privacy:<request_id>:resend` | 6 | `ResendClient.deleteContact(email)`; 404 counts as done |
| `ai.draft_email` (R4) | fast, 5 | `ai:draft:<draft_id>` | 2; budget exhaustion → draft `failed` reason `budget` | section 6, Claude |

Resend events are not a separate job: `processResendEvent(ctx, webhookEventId)` (rules 46-49 and 37) runs inside platform's `webhook.process` job transaction. Every handler is idempotent: running it twice with the same payload leaves the same state (`jobs.test.ts`).

### Schedules (`schedules.ts`, cron in Europe/Brussels)

| Schedule kind | Cron | Does |
| --- | --- | --- |
| `email.dispatch_due_campaigns` | `* * * * *` | rule 31 for campaigns with `status = 'scheduled' and scheduled_at <= now()` |
| `email.watch_complaints` | `*/15 * * * *` | rule 38; also re-evaluates rule 37 for campaigns `sending` |
| `email.check_domains` | `10 5 * * *` | `ResendClient.getDomain()` for both domains; any record not `verified` → Slack alert (High) |
| `email.freeze_due_stats` | `40 4 * * *` | enqueues `email.freeze_campaign_stats` for campaigns finished 30 days ago without snapshot |
| `email.purge_props` | `20 2 * * *` | sets `props = null` on messages sent more than 30 days ago (batches of 5,000) |

### Activity event kinds (`events.ts`)

`email.sent`, `email.opened`, `email.clicked`, `email.bounced`, `email.complained`, `email.blocked`, `email.unsubscribed`, `email.preferences_updated`. All `is_sensitive = false`, `ref_type = 'email_message'`, `ref_id = message id`.

### Cross-module API (`apps/web/modules/email/api.ts`)

```ts
export type Locale = 'nl-BE' | 'fr-BE' | 'en';
export type MarketingPurpose = 'newsletter' | 'events' | 'member_comms' | 'b2b';
export type TransactionalTemplateKey = keyof typeof TEMPLATE_REGISTRY; // e.g. 'booking.confirmation'
export type TransactionalProps<K extends TransactionalTemplateKey> = z.infer<(typeof TEMPLATE_REGISTRY)[K]['props']>;

export function sendTransactional<K extends TransactionalTemplateKey>(ctx: Ctx, input: {
  template: K; personId: string | null; toEmail?: string; locale?: Locale;
  props: TransactionalProps<K>; idempotencyKey: string;
  attachments?: { fileId: string; filename: string }[];
}): Promise<{ messageId: string; status: 'queued' | 'suppressed'; created: boolean }>;

export function queueMarketingEmail(ctx: Ctx, input: {
  templateSlug: string; personId: string; enrolmentId: string | null; idempotencyKey: string;
}): Promise<{ messageId: string | null; status: 'queued' | 'skipped_unreachable' | 'skipped_translation'; created: boolean }>;

export function getReachability(tx: Tx, personId: string, purpose: MarketingPurpose):
  Promise<{ isReachable: boolean; blockedReason: 'erased' | 'no_email' | 'suppressed' | 'withdrawn' | 'no_consent' | null }>;

export function getTemplateInfo(tx: Tx, slug: string):
  Promise<{ templateId: string; kind: 'transactional' | 'marketing'; purpose: MarketingPurpose | null;
            currentVersionId: string | null; locales: Locale[] } | null>;

export function listPersonEmails(tx: Tx, personId: string, page?: number):
  Promise<{ items: PersonEmailRow[]; nextPage: number | null }>;

export function processResendEvent(ctx: Ctx, webhookEventId: string): Promise<void>;
export function getCampaignStats(tx: Tx, campaignIds: string[]): Promise<CampaignStats[]>;
export function countBlockedMessages(tx: Tx, since: Date): Promise<number>;           // ops daily digest
export function getCampaignAttribution(tx: Tx, input: { from: Date; to: Date }):     // R3, ops dashboards
  Promise<{ campaignId: string; name: string; orders: number; revenueCents: number; firstPurchases: number }[]>;
```

`sendTransactional` and `queueMarketingEmail` only write rows and enqueue; they never call Resend. `queueMarketingEmail` is what `automation.step` calls after its own checks; it repeats the reachability and translation checks and returns the skip outcome instead of throwing, so the automation run logs `skipped_unreachable` or `skipped_translation`.

`R4` output schema of `ai.draft_email` (`AiCampaignDraft`, Zod in `packages/core/src/email/ai.ts`): `{ subject: LocalizedText, preheader: LocalizedText, document: BlockDocument, segment: { segmentId: string | null, description: string }, suggestedSendAt: string (ISO), timingRationale: string, notes: string }`, all three locales required.

## 5. Screens

All admin screens use `packages/ui` (`DataTable`, `LocalizedInput`), show a skeleton while loading, and render errors as an inline alert with the `requestId` and a Retry button. Navigation entries (`nav.ts`): "Email" group with Overview, Campaigns, Templates, Messages, shown when the user has `email.write` or `reports.read`.

| Route | Shows | Actions | Empty state | Who |
| --- | --- | --- | --- | --- |
| `/admin/email` | KPI tiles for the last 30 days (sent, delivered %, open rate, click rate, hard bounce %, complaint %, unsubscribes); domain status for `mail.beam.be` and `news.beam.be` (SPF, DKIM, DMARC, last check); warm-up week, today's cap and sent count; complaint banner (rule 38); blocked-translation messages; last 20 suppressions added (email masked `j***@gmail.com`) | Add manual suppression (`email.send`); open blocked message | "No email sent yet" with links to Templates and Campaigns | `email.write` or `reports.read` |
| `/admin/campaigns` | Table: name, status badge, purpose, segment, scheduled or sent date, recipients, open rate, click rate | New campaign, filter by status, search, duplicate | "No campaigns yet. Create your first campaign" | `email.write` or `reports.read` (read-only) |
| `/admin/campaigns/new` | Name, purpose, start from blank or an existing marketing template; R4 tab "Draft with AI" (brief, events, segment hint) | Create, Request AI draft | | `email.write` (AI tab also `ai.use`) |
| `/admin/campaigns/[id]` | Stepper: Content (block editor of the campaign template, section below), Audience (segment picker, exclusion segments, live estimate with per-locale counts and blocked reasons), Review (completeness per locale, footer check, test send panel, preview switcher), Schedule (date and time in Brussels, Send now), then Report once sending | Save, test send, schedule, unschedule, refresh audience, pause, resume, stop, cancel, duplicate | Audience: "Pick a segment"; Review lists every blocking check with a link to fix it | edit `email.write`; schedule and controls `campaigns.send` (buttons hidden and server-refused otherwise) |
| `/admin/campaigns/[id]/recipients` | Paginated recipients (50): name, masked email, locale, status, chunk, message status; filters by status; search by name or email | Remove, restore (in `scheduled` or `paused`) | "Audience not prepared yet" | `campaigns.send` for actions, `email.write` to view |
| `/admin/campaigns/[id]/report` | `v_campaign_stats` tiles and rates, timeline of sends per 15 minutes, clicks per link, per-locale table, bounces and complaints list, R3 revenue, orders and first purchases | Export CSV (ids, status, open and click times; `reports.read`) | "No data yet, sending starts at <time>" | `email.write` or `reports.read` |
| `/admin/templates` | Tabs Transactional and Marketing: name, slug, status, current version, locales badges, last published | New marketing template, duplicate, archive | "No marketing templates yet" | `email.write` |
| `/admin/templates/[id]` | Marketing: three-pane block editor (block palette, canvas per locale tab with completeness badge, inspector for the selected block); token picker; dynamic block editor with variant list. Transactional: list of copy slots per locale with `LocalizedInput`, live preview of the react-email component with sample props | Save draft (autosave every 10 s), publish (`email.send`), preview, test send, version history (read-only previous versions) | | `email.write`; publish `email.send` |
| `/admin/templates/[id]/preview` | Desktop (600 px) and mobile (375 px) frames, HTML and plain-text tabs, subject and preheader, size warning, "Preview as": a person search (real contact), Lead, Customer, Member, assessment outcome picker | Switch locale, switch persona | "Select a person or a sample" | `email.write`; real contact also `persons.read` |
| `/admin/email/messages` | Message log: time, recipient (masked unless `persons.read`), template, kind, status, campaign; filters | Open message | "No messages match" | `email.write` |
| `/admin/email/messages/[id]` | Message detail: headers summary, status history from `email_events`, rendered HTML (non-production from `rendered_file_id`; production re-rendered from the version and props while props exist) | Resend (transactional, `email.send`) | | `email.write` |
| Person page tab "Emails" (rendered by `crm`'s `/admin/persons/[id]`, component `PersonEmailHistory` from `apps/web/modules/email/ui/`) | Every message to the person with campaign or automation name, status, opened and clicked times; reachability per purpose with reason | Resend transactional (`email.send`), open message | "No emails sent to this person" | `persons.read` |
| `/[locale]/preferences/[token]` (public, `(site)` group, owned by `email`) | BEAM-branded page: greeting by first name, four category toggles with one-line explanations, "Unsubscribe from all marketing", note that service emails about bookings and payments continue; after one-click a banner "You will no longer receive <category>" with Undo | Save, unsubscribe all, undo | Expired or unknown token: form "Send me a new link" | anyone with the token |
| `/[locale]/account/preferences` (portal) | Same component bound to the logged-in person | Save | | customer |

Loading states: the block editor shows the canvas skeleton and disables Publish until the draft loads; previews show a spinner inside the frame; estimates show "counting..." and time out after 10 s with "Estimate unavailable, try again". Error states: publish validation lists `locale: block path: problem` items and scrolls to the first; a version conflict shows "Someone else changed this; reload" with a diff count.

## 6. Integrations

**Resend** (`packages/integrations/src/resend/client.ts` and `fake.ts`), EU region (`eu-west-1`), API key `RESEND_API_KEY`, webhook secret `RESEND_WEBHOOK_SECRET`.

```ts
export interface ResendClient {
  send(msg: OutgoingEmail, opts: { idempotencyKey: string }): Promise<{ id: string }>;
  sendBatch(msgs: OutgoingEmail[] /* 1..100, no attachments */, opts: { idempotencyKey: string }): Promise<{ ids: string[] }>;
  getDomain(name: 'mail.beam.be' | 'news.beam.be'): Promise<{ status: 'verified' | 'pending' | 'failed' | 'not_started'; records: { type: string; name: string; status: string }[] }>;
  deleteContact(email: string): Promise<{ deleted: boolean }>;
}
export type OutgoingEmail = { from: string; to: string; replyTo: string; subject: string; html: string; text: string;
  headers: Record<string, string>; tags: { name: string; value: string }[]; attachments?: { filename: string; content: Buffer }[] };
export function verifyResendWebhook(input: { id: string; timestamp: string; signature: string; body: string; secret: string; now: Date }): boolean;
```

- Calls: `POST /emails`, `POST /emails/batch`, `GET /domains/{id}` (domain ids in `settings.email_config.resend_domain_ids`), `DELETE /contacts/{email}` (we never create Resend contacts or audiences; the call is defensive). Tags on every message: `message_id`, `kind`, `campaign_id` when present. Open and click tracking are disabled on both Resend domains; our routes track.
- Failure handling: the client throws `IntegrationError { provider: 'resend', retryable }`; `retryable` for network errors, 429 and 5xx. Every call writes `integration_calls` (operation, status, duration, never bodies). A batch that fails as a whole is retried by the job with the same idempotency key, so Resend deduplicates for 24 hours; a batch never partially succeeds at Resend.
- `fake.ts`: in-memory store; deterministic ids `re_fake_<n>`; `failNext(kind: 'retryable' | 'permanent')`; `emitWebhook(type, messageResendId, extra)` returns a signed request body for webhook tests; records every sent message for assertions; idempotency keys honoured.

**Domains and DNS (owned by BEAM, documented in `docs/runbooks/email-dns.md`, created by email-P3).** Both domains are added in BEAM's Resend account, region EU. Records per domain `<d>` in {`mail.beam.be`, `news.beam.be`}:

| Record | Name | Value |
| --- | --- | --- |
| MX (return path) | `send.<d>` | `feedback-smtp.eu-west-1.amazonses.com`, priority 10 |
| TXT SPF | `send.<d>` | `v=spf1 include:amazonses.com ~all` |
| TXT DKIM | `resend._domainkey.<d>` | the public key Resend shows for that domain |
| TXT DMARC | `_dmarc.<d>` | weeks 1-4: `v=DMARC1; p=quarantine; pct=100; rua=mailto:dmarc@beam.be; adkim=r; aspf=r`; from week 5 with clean aggregate reports: `p=reject` |

`beam.be` itself keeps its Google Workspace SPF and MX; `dmarc@beam.be` is a Google group read by Sidestream. `email.check_domains` alerts when any record stops verifying.

**Claude (R4)** through platform's AI gateway `platform.callClaude()` (`ai_requests` row, budget, allow-list). Job `ai.draft_email`, model `claude-opus-5-5`, structured output `AiCampaignDraft`. Input context, all non-personal: `settings.email_brand` (`tone_of_voice`, `guidelines`, `do_not_say`, sample phrases per locale), the subjects, preheaders and plain text (`nl-BE`) of the last 5 sent campaigns of the same purpose with their open and click rates, event info from `booking.getSessionCards()` for the chosen sessions, segment names and counts from `crm` (no members), purpose and locale list. `fields_sent` lists exactly these keys. Failure: draft `failed` with the error code; the UI shows "AI unavailable, write manually". Humans approve: acceptance only creates a draft campaign.

**Slack** via platform's `notify.slack` job for auto-pause, complaint and domain alerts (key `alert:<fingerprint>:<YYYY-MM-DDTHH>`).

## 7. Permissions and audit

Permissions declared in `apps/web/modules/email/permissions.ts`: `email.write`, `email.send`, `campaigns.send` (strings from the architecture; no new ones).

| Permission | Allows | Default roles |
| --- | --- | --- |
| `email.write` | create and edit templates and campaign drafts, upload images, preview, test sends to staff addresses, view message log, request and accept AI drafts (with `ai.use`) | owner, technical_admin, management, marketing, customer_service |
| `email.send` | publish template versions (they go live in automations and transactional sends), archive templates, resend a transactional message, add a manual suppression | owner, technical_admin, management, marketing |
| `campaigns.send` | schedule, unschedule, refresh audience, remove and restore recipients, pause, resume, stop, cancel campaigns | owner, technical_admin, management, marketing |
| `persons.read` (crm) | preview as a real contact, see unmasked addresses | per crm |
| `reports.read` (ops) | read campaign reports and `/admin/email` overview without editing | per architecture |
| `ai.use` (platform) | R4 AI drafts | sales, marketing, owner, management, technical_admin |

Audited actions (`audit_log.action`, entity type in brackets): `email.template_create`, `email.template_publish`, `email.template_archive` (`email_template`); `email.campaign_create`, `email.campaign_update`, `email.campaign_schedule`, `email.campaign_unschedule`, `email.campaign_refresh`, `email.campaign_pause`, `email.campaign_resume`, `email.campaign_stop`, `email.campaign_cancel` (`campaign`, old and new status); `email.recipient_remove`, `email.recipient_restore` (`campaign_recipient`, with `person_id`); `email.test_send` (`campaign` or `email_template`); `email.message_resend` (`email_message`); `email.suppression_add` (`suppression`, email stored as hash only); `email.preferences_update` (`person`, old and new category states, actor customer or public token); `email.campaign_auto_pause` (actor system); `email.ai_draft_request`, `email.ai_draft_accept`, `email.ai_draft_discard` (`email_ai_draft`). `permissions.test.ts` asserts each staff action refuses without its permission.

## 8. Multi-language and content

- Catalogue namespace `email` in `packages/core/src/i18n/messages/{nl-BE,fr-BE,en}/email.json`, keys `email.<screen>.<element>`: admin screens (`email.campaigns.*`, `email.templates.*`, `email.editor.*`, `email.preview.*`, `email.report.*`, `email.deliverability.*`, `email.messages.*`), public pages (`email.preferences.*`, `email.unsubscribed.*`), category names and descriptions (`email.categories.newsletter.title|description`, `events`, `member_comms`, `b2b`), and the default copy seeds for transactional templates (`email.tpl.<template_key>.<slot>`). `en` is the source; `pnpm i18n:check` enforces parity.
- `LocalizedText` content fields: `email_template_versions.subject`, `preheader`, every `copy` slot, every text field inside the block document per locale (heading text, text markdown, image alt, button label, product and event CTA labels, token fallbacks), `settings.email_footer.reasons.*`, `settings.email_brand.sample_phrases`.
- Seed: the transactional copy slots are seeded from `email.tpl.*` catalogue keys into version 1 of each system template, so copy is editable by staff afterwards without a deploy.
- Publish-time checks: `publishTemplateVersion` calls `assertComplete()` for subject, preheader and all slots or block texts in all three locales (rule 10), validates tokens (rule 13) and the footer (rule 5). `scheduleCampaign` repeats the completeness check for the audience locales (rule 26).
- Send-time: `renderEmail()` throws `MissingTranslationError` (a `PermanentError`) when the locale is missing; no fallback language (rule 41). Dates and money in emails use `Intl.DateTimeFormat(locale, { timeZone: 'Europe/Brussels' })` and `Intl.NumberFormat(locale, { style: 'currency', currency: 'EUR' })`.
- Admin UI locale is `users.locale`; preview locale is chosen per tab; public preference pages use the URL locale, defaulting to the message locale in links.

## 9. Privacy

`apps/web/modules/email/privacy.ts` registers:

```ts
export const emailPrivacy = {
  tables: ['email_messages', 'email_events', 'campaign_recipients', 'campaigns', 'email_templates', 'email_template_versions', 'email_ai_drafts'],
  export: async (tx, personId) => ({ messages: [...], events: [...], campaignRecipients: [...], preferences: {...} }),
  erase: async (tx, personId) => [{ table, rows, action }],
};
```

| Table | Person data | Export includes | Erase does | Why |
| --- | --- | --- | --- | --- |
| `email_messages` | `person_id`, `to_email`, `subject`, `props`, tokens | every message: date, template name, kind, purpose, subject, status, opened and clicked times | **delete** the person's rows (cascades `email_events`; `campaign_recipients.email_message_id` set null first) | no legal duty to keep email logs; campaign totals survive in `stats_snapshot` or are recomputed without the person |
| `email_events` | via message | type and time per message | deleted by cascade under `beam.allow_rewrite` | append-only, erased only by the erasure job |
| `campaign_recipients` | `person_id` | campaign name, status | **delete** | same |
| `campaigns`, `email_templates`, `email_template_versions` | none (staff user ids only) | not included | nothing | `NO_PII_TABLES` for persons; staff user references follow platform's user erasure |
| `email_ai_drafts` | none | not included | nothing | aggregates only by construction |
| Resend | delivery logs (30 days, US) | not exportable via API; the export report states it | enqueue `email.erase_provider_data` | subprocessor register |

Suppressions are crm's table: erasure keeps `suppressions.email_hash` with reason `erased` (crm), which `email.send` honours. Retention policies seeded by `email`'s `seed.ts` into `retention_policies` and enforced by `ops`' `privacy.retention_sweep`: `email_events` 730 days delete; `email_messages` 730 days delete (only rows whose campaign is frozen or that have no campaign); `campaign_recipients` 730 days after the campaign's `finished_at` delete; `files` of kind `rendered_email` 14 days (via `expires_at`); `email_ai_drafts` 365 days delete; `props` nulled after 30 days (schedule `email.purge_props`). Sensitive columns: none in this module; `EMAIL_TOKENS` and the AI context exclude every `SENSITIVE_COLUMNS` member (tests). Tracking stores no IP addresses and only a user-agent family (`apple_mpp`, `gmail_proxy`, `other`) so opens from privacy proxies can be shown separately.

## 10. Dependencies

**Needs from other modules**

| Module | What | Used for |
| --- | --- | --- |
| platform | `action()`, `defineJob`, `defineSchedule`, `enqueue`, `runJobs`, `recordEvent`, `audit`, `getSetting(tx, key)`, `storeFile(tx, {...})`, `readFile(tx, id)`, `callClaude()` (R4), `notify.slack` job, `webhook.process` job dispatching provider `resend` to `email.processResendEvent`, tables `settings`, `files`, `webhook_events`, `integration_calls`, `users` | everything |
| crm | `crm.addSuppression(ctx, { email, scope, reason, source }): Promise<{ suppressionId: string; created: boolean }>` (also emits `suppression.added`), `crm.recordConsent(ctx, { personId, purpose, status, source, method, wordingVersion, ip }): Promise<{ consentId: string }>` (emits `consent.granted|withdrawn`), `crm.refreshSegment(tx, segmentId): Promise<{ count: number }>`, `crm.getSegmentSummaries(tx): Promise<{ id; name; lastCount }[]>`, `crm.createTask(ctx, {...})`, `emailHash()` from `@beam/core/crm`; tables `persons`, `segments`, `segment_members`, `company_contacts`, view `v_consent_current` | reachability, campaigns, preference centre, alerts |
| credits | views `v_person_status`, `v_person_credits`; table `memberships` | dynamic blocks, tokens, `member_comms` reachability |
| booking | `booking.getSessionCards(tx, sessionIds, locale): Promise<SessionCard[]>`, `booking.getNextBooking(tx, personId): Promise<{ startsAt: Date } | null>` | `event` block, tokens, R4 context |
| commerce | `commerce.getProductCards(tx, productIds, locale): Promise<ProductCard[]>`; table `orders` (R3 view) | `product` block, attribution |
| forms | `forms.listLatestOutcomes(tx, personIds: string[], formSlug: string): Promise<Map<string, string>>` | `dynamic` assessment-outcome variant |
| automation | job kind `automation.exit_for_suppression` (payload `{ suppressionId }`) | fast unsubscribe |
| ops | `retention_policies` table (rows seeded by email), `privacy.retention_sweep` | retention |

**Provides to other modules**

- `sendTransactional()` with these registered templates (owner module of the triggering flow in brackets): `platform.magic_link`, `platform.password_reset`, `platform.mfa_changed`, `platform.staff_invite` (platform); `booking.confirmation`, `booking.reminder`, `booking.cancellation`, `booking.claim_offer` (booking); `commerce.receipt`, `commerce.payment_failed`, `commerce.payment_link` (commerce); `finance.invoice`, `finance.credit_note` (finance, PDF attachment); `forms.result` (forms, result link, never newsletter consent); `credits.membership_renewal` (30 and 7 days), `credits.membership_past_due` (credits); `email.preference_link` (email). R2 adds `webinar.registered`, `webinar.reminder`, `webinar.replay_available`, `commerce.checkout_recovery`, `booking.lead_window_open`. Each template's props schema is exported from `@beam/email/templates/<m>/<name>` and inferred in `TransactionalProps<K>`.
- `queueMarketingEmail()`, `getReachability()`, `getTemplateInfo()` to `automation`.
- `listPersonEmails()` and the `PersonEmailHistory` component to `crm`'s person page; `email.*` activity events to the timeline and as automation triggers (`email.opened`, `email.clicked`).
- `getCampaignStats()`, `countBlockedMessages()`, `getCampaignAttribution()` (R3) and views `v_campaign_stats`, `v_email_attribution` to `ops`.
- `v_marketing_reachability` to `automation`, `crm` (person page) and `ops` (management counts).
- `emailPrivacy` to `ops`' privacy workflows.

## 11. Edge cases and failure modes

| # | Case | Decided behaviour |
| --- | --- | --- |
| 1 | Resend webhook delivered twice | `webhook_events` unique `(provider, external_event_id)` drops the second; `email_events.resend_event_id` unique as a second guard |
| 2 | Webhook events arrive out of order (`delivered` before `sent`) | forward-only status by rank (rule 47); `sent_at` still set from the `sent` event when it arrives |
| 3 | Webhook for an unknown `resend_id` (sent before a restore, or another environment) | stored in `webhook_events`, processing logs `unknown_message` and succeeds; no row created |
| 4 | The person unsubscribes while chunk 37 of 100 is running | the chunk re-checks reachability per batch of 100 (rule 32); at most the current batch (already submitted to Resend) goes out; everything after is `skipped_suppressed` |
| 5 | Resend times out after accepting a batch | the retry uses the same `Idempotency-Key`; Resend returns the original ids; no duplicate send |
| 6 | Job crashes after Resend accepted but before the transaction committed | retry with same key returns the same ids; message rows are inserted again in the new transaction from the same deterministic keys |
| 7 | Campaign scheduled, then the template's purpose segment shrinks because consents were withdrawn | per-chunk re-check skips them as `skipped_consent`; the report shows the count |
| 8 | A recipient's locale changed after the snapshot to a locale the version lacks | rule 30: `skipped_translation`, listed on the report and in the digest |
| 9 | Two staff edit the same draft | `draftUpdatedAt` optimistic check; the second save gets `conflict` and the editor offers reload |
| 10 | Staff pauses while the warm-up cap already deferred chunks to tomorrow | deferred jobs see `paused` and exit; resume re-enqueues with a new `run_no` |
| 11 | Bounce rate trips during the first chunk of a list with old addresses | auto-pause after 100 sent at above 2 % hard bounces; resume requires confirming the name; the hard-bounced addresses are already suppressed |
| 12 | Same address on two persons (one merged) | reachability excludes merged persons; suppressions are by `email_hash`, so the unsubscribe applies to both rows |
| 13 | Person has no email | not inserted at snapshot (`no_email`); `sendTransactional` with no `toEmail` and no person email throws `validation` to the caller |
| 14 | Link token reused after 365 days | page shows "link expired" and the new-link form; one-click POST returns 200 and writes nothing, logged as `expired_token` |
| 15 | Mail scanner pre-fetches the one-click URL with GET | GET writes nothing (section 4 route table); only the POST from the mail client or the confirm button unsubscribes |
| 16 | Apple Mail Privacy Protection opens every email | opens with `ua_family = apple_mpp` are counted but the report shows "of which privacy-proxy opens"; clicks are the reliable metric |
| 17 | `EMAIL_SINK` missing on a preview deployment | `email.send` fails permanently with `email_sink_missing`; nothing leaves; System page shows dead jobs |
| 18 | Resend returns 422 for an invalid recipient address | `PermanentError`; message `failed` with `error = 'invalid_recipient'`; campaign recipient `failed`; no suppression (address may be fixed in crm) |
| 19 | Product in a `product` block deactivated after scheduling | the block renders nothing for later chunks; earlier recipients already got it |
| 20 | Erasure while a campaign is sending to that person | erasure deletes recipient and message rows under `allow_rewrite`; the chunk finds no recipient row and skips; `persons.erased_at` blocks any later `email.send` |
| 21 | Magic link requested by someone whose address hard-bounced | not sent: the hard-bounce suppression blocks it (rule 40 exempts only complaints); the login page says "We could not deliver to this address; contact BEAM" after the job sets `suppressed` |
| 22 | A transactional template's copy is edited and republished while messages are queued | queued messages keep the `template_version_id` they were created with; new messages use the new current version |
| 23 | Campaign `scheduled_at` passes while the tick is down | `email.dispatch_due_campaigns` picks it up at the next tick; the report shows actual `started_at` |
| 24 | Click tracking link index out of range or token forged | 302 to the BEAM home page for the locale; nothing recorded |

## 12. Build packages

Order and sharing: the packages run strictly in the order P1 → P10. P1 and P2 touch only `packages/*`. From P3 on, the module barrel files `apps/web/modules/email/{actions,queries,jobs,schedules,events,api,nav,permissions,privacy,seed}.ts`, `packages/core/src/email/inputs.ts`, `packages/core/src/i18n/messages/*/email.json` and `packages/db/src/seed/email.ts` are edited by several packages; those packages are strictly sequential (each starts from the merged result of the previous one). No package edits `package.json`, the lockfile, migrations or `registry/*.generated.ts`. Every package ends with: `pnpm typecheck`, `pnpm lint`, its Vitest suites green (integration tests on `createTestDb()` and the shared factories, Resend through `fake.ts`), `pnpm i18n:check` when it adds keys.

### email-P1 (V1): schema, core logic and Resend client

- **Goal**: every email table and enum, the pure domain logic, and the Resend client with its fake.
- **Files**: edit `packages/db/src/schema/email.ts` (complete the Wave 0 stubs `email_templates`, `email_messages`; add `email_template_versions`, `campaigns`, `campaign_recipients`, `email_events`, `email_ai_drafts` and all enums of section 2; add `email_events` to the module's `APPEND_ONLY_TABLES` export); create `packages/core/src/email/{blocks.ts,tokens.ts,completeness.ts,versions.ts,campaign-state.ts,message-status.ts,warmup.ts,links.ts,reachability.ts,inputs.ts,index.ts}`; create `packages/integrations/src/resend/{client.ts,fake.ts,webhook.ts,types.ts}` (Wave 0's `fake.ts` is replaced by the full fake).
- **Interfaces**: `BlockDocumentSchema`, `BlockSchema` (Zod, rules 16-20); `validateDocument(doc): { ok: true } | { ok: false; issues: DocIssue[] }`; `EMAIL_TOKENS: readonly TokenKey[]`; `parseTokens(text): TokenUse[]`; `templateCompleteness(version, locales): { locale; missing: string[] }[]`; `assertDraftVersion(row): void`; `canTransition(from: CampaignStatus, to: CampaignStatus): boolean`; `nextMessageStatus(current, eventType): MessageStatus`; `warmupCap(schedule, day: Date): number | null`; `newLinkToken(): { token: string; hash: string }`, `hashLinkToken(token): string`; `resolveReachability(input: { erased; hasEmail; suppressions: {scope; reason; createdAt}[]; consent: {status; method; recordedAt} | null; isMember; isCompanyContact }, purpose): BlockedReason | null`; `ResendClient`, `createResendClient(opts)`, `createFakeResendClient()`, `verifyResendWebhook()` (section 6).
- **Depends on**: Wave 0 (`_shared.ts`, contract tables `persons`, `users`, `files`, `ai_requests`).
- **Tests**: `packages/core/src/email/blocks.test.ts` (valid document, nesting rules, 200-block and 256 KB limits, image alt required, button URL scheme); `tokens.test.ts` (parse, fallback syntax, unknown token, no sensitive column in `EMAIL_TOKENS`); `completeness.test.ts` (missing subject per locale, missing block text, transactional slots); `campaign-state.test.ts` (every allowed and every refused transition of rule 25); `message-status.test.ts` (rank order, out-of-order events, complaint after bounce); `warmup.test.ts` (weeks 0-3 caps, week 4 unlimited, Brussels day boundary); `reachability.test.ts` (matrix: unsubscribe lifted only by later preference_centre/portal/form consent, never by import or staff; hard bounce never lifted; member_comms for members; b2b for company contacts); `packages/integrations/src/resend/webhook.test.ts` (valid signature, wrong secret, stale timestamp, multiple `v1` signatures); `client.test.ts` (fake idempotency, batch of 101 refused, retryable mapping of 429 and 5xx); `packages/db/src/schema/email.test.ts` (createTestDb builds the schema; unique and partial unique constraints: second draft per template refused, duplicate `(campaign_id, person_id)` refused, check constraints on purpose and paused_reason).
- **Done**: typecheck, lint, the suites above green.

### email-P2 (V1): renderer, branding and transactional templates

- **Goal**: block document → MJML → HTML and plain text with personalisation, BEAM layout and footer, `renderEmail()` for both kinds, all 17 V1 transactional react-email templates and their registry.
- **Files**: create `packages/email/src/blocks/{to-mjml.ts,to-text.ts,compile.ts,personalise.ts,markdown.ts,index.ts}`; create `packages/email/src/layout/{brand.ts,footer.ts,MarketingShell.ts}`; edit Wave 0 `packages/email/src/layout/BaseLayout.tsx` and `packages/email/src/render-email.ts`; create `packages/email/src/resend.ts` (`buildOutgoingEmail()`); create `packages/email/src/templates/{platform,booking,commerce,finance,forms,credits,email}/<name>.tsx` for the 17 templates of section 10, `packages/email/src/templates/<m>/index.ts` for all twelve module ids (empty arrays where no template exists) and `packages/email/src/templates/registry.ts`.
- **Interfaces**: `compileMarketing(doc, locale, ctx: { footer; brand; resolveCards }): { variants: Record<VariantPath, { html: string; text: string }> }`; `personalise(htmlOrText, values: TokenValues, opts: { escape: boolean }): string`; `selectVariant(doc, locale, recipient: { status; outcomes }): VariantPath`; `renderEmail(input: RenderInput): Promise<{ subject: string; html: string; text: string; links: string[] }>` throwing `MissingTranslationError`; `TEMPLATE_REGISTRY: Record<TemplateKey, { component; props: ZodSchema; slots: string[]; ownerModule; attachments: boolean }>`; `buildOutgoingEmail(msg, { kind, from, replyTo, token, sinkRewrite? }): OutgoingEmail` (headers of rule 2, tags).
- **Depends on**: email-P1 (`BlockDocumentSchema`, tokens, `LocalizedText`).
- **Tests**: `packages/email/src/blocks/to-mjml.test.ts` (every block type compiles with `validationLevel: 'strict'`; columns stack; snapshot of a sample newsletter); `to-text.test.ts` (headings, links as `text (url)`, lists, dynamic variants); `personalise.test.ts` (escaping, fallback, empty value); `compile.test.ts` (dynamic lead, customer, member and assessment outcome variants render the right blocks: acceptance "lead, customer and member content blocks display correctly"; size warning above 102 KB); `render-email.test.ts` (missing locale throws, footer reason per purpose and transactional, footer company details present); `templates/registry.test.ts` (every template renders in nl-BE, fr-BE and en with its sample props, has a text part, contains the footer, contains no tracking pixel); `resend.test.ts` (List-Unsubscribe headers only for marketing, sink rewrite of `to` and subject prefix).
- **Done**: typecheck, lint, suites green.

### email-P3 (V1): sending pipeline, webhook, tracking, privacy

- **Goal**: `email.send`, the cross-module API, the reachability view, the Resend webhook and event processing with suppression, soft-bounce retry, open and click tracking, the sink, privacy registration, permissions and events.
- **Files**: create `packages/db/src/schema/email.views.ts` (`v_marketing_reachability`, `v_campaign_stats`); edit `apps/web/modules/email/{api.ts,jobs.ts,events.ts,permissions.ts,privacy.ts,schedules.ts,seed.ts}`; create `apps/web/modules/email/server/{send.ts,process-event.ts,tracking.ts,sink.ts,context.ts}`; create `apps/web/app/api/webhooks/resend/route.ts`, `apps/web/app/api/public/track/open/route.ts`, `apps/web/app/api/public/track/click/route.ts`; create `packages/db/src/seed/email.ts` (system templates version 1 from catalogue copy, `settings.email_config`, `email_footer`, `warmup_schedule`, `retention_policies` rows); create `docs/runbooks/email-dns.md`.
- **Interfaces**: section 4 `api.ts` signatures `sendTransactional`, `queueMarketingEmail`, `getReachability`, `getTemplateInfo`, `listPersonEmails`, `processResendEvent`, `countBlockedMessages`; jobs `email.send`, `email.retry_soft_bounce`, `email.erase_provider_data`; schedules `email.purge_props`, `email.check_domains`; `emailPrivacy`.
- **Depends on**: email-P1, email-P2; `platform:action/defineJob/enqueue/recordEvent/getSetting/storeFile/webhook.process`; `crm:addSuppression`, `crm:recordConsent`, `crm:v_consent_current`, `crm:company_contacts`; `credits:v_person_status`; `automation:automation.exit_for_suppression` (job kind only); `booking:getNextBooking`.
- **Tests**: `apps/web/modules/email/send.test.ts` (idempotent `sendTransactional`; erased person suppressed; hard-bounce suppression blocks; complaint does not block magic link; marketing unreachable → `suppressed`; missing locale → `blocked_translation` and timeline event; attachment path uses single send; sink rewrite and `rendered_file_id` outside production; `email_sink_missing`); `process-event.test.ts` (hard bounce → suppression `all` + exit job enqueued: acceptance "hard bounces are suppressed"; complaint → suppression and consent withdrawn for four purposes; soft bounce transactional → retry once; three soft bounces → suppression; out-of-order events; unknown resend id); `tracking.test.ts` (open pixel sets `opened_at` once; click redirect to `links[i]`; forged token and bad index redirect home; click sets `opened_at`); `webhook-route.test.ts` (bad signature 401; duplicate svix-id stored once); `reachability-view.test.ts` (the SQL view equals `resolveReachability` on the P1 matrix; hash expression equals `emailHash()`); `jobs.test.ts` (every handler twice → same state); `privacy.test.ts` (export lists messages; erase leaves no row referencing the person; Resend erase job enqueued); `permissions.test.ts`.
- **Done**: typecheck, lint, suites green; `pnpm gen:indexes` picks up the job, schedule, event and permission registrations.

### email-P4 (V1): preference centre and one-click unsubscribe

- **Goal**: the token preference centre, one-click unsubscribe, new-link flow and portal preferences, with scenario 2 proved end to end.
- **Files**: create `apps/web/app/api/public/unsubscribe/[token]/route.ts`, `apps/web/app/api/public/preferences/[token]/route.ts`, `apps/web/app/[locale]/(site)/preferences/[token]/page.tsx`, `apps/web/app/[locale]/(portal)/account/preferences/page.tsx`, `apps/web/modules/email/ui/PreferenceCentreForm.tsx`, `apps/web/modules/email/server/preferences.ts`; edit `apps/web/modules/email/{actions.ts,queries.ts,api.ts}`, `packages/core/src/email/inputs.ts`, `packages/core/src/i18n/messages/*/email.json` (`email.preferences.*`, `email.unsubscribed.*`, `email.categories.*`); create `e2e/scenario-2-fast-unsubscribe.spec.ts`.
- **Interfaces**: actions `updatePreferencesByToken`, `requestPreferenceLink`, `updateMyPreferences`; queries `getPreferencesByToken`, `getMyPreferences`; `unsubscribeByToken(ctx, token, method: 'one_click' | 'confirm_button'): Promise<{ suppressionId: string | null }>`.
- **Depends on**: email-P3; `crm:addSuppression`, `crm:recordConsent`; `automation:automation.exit_for_suppression`.
- **Tests**: `apps/web/modules/email/preferences.test.ts` (one-click writes suppression for the message purpose, consent withdrawn, `unsubscribed_at`, exit job key `supp:<id>`; GET writes nothing; category off leaves other categories reachable; unsubscribe-all → scope `all`; re-opt-in lifts an unsubscribe but not a hard bounce; import consent after suppression does not lift it: acceptance "suppression survives an import"; expired token; new-link rate limit 3 per hour, same answer for unknown addresses); `e2e/scenario-2-fast-unsubscribe.spec.ts` (person enrolled in a marketing automation and in a scheduled campaign clicks one-click; within 60 s the enrolment is `exited` with `unsubscribed`, the campaign chunk skips the person, no further marketing message reaches the sink; transactional booking confirmation still arrives).
- **Done**: typecheck, lint, suites green, the scenario-2 spec green against `beam_dev`.

### email-P5 (V1): template editor, preview and test sends

- **Goal**: staff create, edit, preview, test and publish marketing and transactional templates.
- **Files**: create `apps/web/app/(admin)/admin/templates/page.tsx`, `apps/web/app/(admin)/admin/templates/[id]/page.tsx`, `apps/web/app/(admin)/admin/templates/[id]/preview/page.tsx`; create `apps/web/modules/email/ui/editor/{BlockEditor.tsx,BlockPalette.tsx,BlockCanvas.tsx,BlockInspector.tsx,DynamicBlockEditor.tsx,TokenPicker.tsx,CopySlotsEditor.tsx,PreviewFrame.tsx,TestSendDialog.tsx,VersionHistory.tsx}`; create `apps/web/modules/email/server/{templates.ts,preview.ts}`; edit `apps/web/modules/email/{actions.ts,queries.ts,nav.ts}`, `packages/core/src/email/inputs.ts`, `packages/core/src/i18n/messages/*/email.json` (`email.templates.*`, `email.editor.*`, `email.preview.*`).
- **Interfaces**: actions `createTemplate`, `saveTemplateDraft`, `publishTemplateVersion`, `archiveTemplate`, `duplicateTemplate`, `uploadEmailImage`, `sendTestEmail`; queries `listTemplates`, `getTemplate`, `getPreview`; `samplePersona(kind: 'lead' | 'customer' | 'member', outcome?: string): RecipientContext`.
- **Depends on**: email-P4; `commerce:getProductCards`, `booking:getSessionCards`, `forms:listLatestOutcomes`, `platform:storeFile`.
- **Tests**: `apps/web/modules/email/templates.test.ts` (draft created on first edit of a published template; published row never updated; publish refuses incomplete locales with the exact missing list; unknown token refused; footer incomplete refused; archive refused while referenced; system template cannot be archived; MJML compile stored per locale and variant); `preview.test.ts` (preview as real person uses their status and outcome; as lead, customer, member samples choose the matching variant; no sensitive fields read); `test-send.test.ts` (only staff addresses accepted; `test_sent_at` set; no timeline events); `e2e/email.spec.ts` part 1 (marketing builds a newsletter with a dynamic block, previews as lead and member, publishes).
- **Done**: typecheck, lint, suites green, e2e part 1 green.

### email-P6 (V1): campaigns engine and campaign screens

- **Goal**: the full campaign lifecycle from draft to sent with snapshot, recipient control, scheduling, chunked bulk sending, warm-up caps, pause, resume, stop and bounce-rate auto-pause.
- **Files**: create `apps/web/modules/email/server/{campaigns.ts,plan.ts,send-chunk.ts,auto-pause.ts}`; create `apps/web/app/(admin)/admin/campaigns/page.tsx`, `apps/web/app/(admin)/admin/campaigns/new/page.tsx`, `apps/web/app/(admin)/admin/campaigns/[id]/page.tsx`, `apps/web/app/(admin)/admin/campaigns/[id]/recipients/page.tsx`; create `apps/web/modules/email/ui/campaign/{CampaignStepper.tsx,AudiencePicker.tsx,ReviewChecklist.tsx,SchedulePanel.tsx,CampaignControls.tsx,RecipientsTable.tsx}`; edit `apps/web/modules/email/{actions.ts,queries.ts,jobs.ts,schedules.ts,nav.ts}`, `packages/core/src/email/inputs.ts`, `packages/core/src/i18n/messages/*/email.json` (`email.campaigns.*`); edit `e2e/email.spec.ts` (after P5).
- **Interfaces**: actions `createCampaign`, `updateCampaign`, `scheduleCampaign`, `unscheduleCampaign`, `refreshAudience`, `removeRecipient`, `restoreRecipient`, `pauseCampaign`, `resumeCampaign`, `stopCampaign`, `cancelCampaign`, `duplicateCampaign`; queries `listCampaigns`, `getCampaign`, `getAudienceEstimate`, `listCampaignRecipients`; jobs `campaign.plan`, `campaign.send_chunk`; schedule `email.dispatch_due_campaigns`; `evaluateBounceRate(tx, campaignId): Promise<'ok' | 'paused'>`.
- **Depends on**: email-P5; `crm:refreshSegment`, `crm:segment_members`, `crm:createTask`; `platform:notify.slack`.
- **Tests**: `apps/web/modules/email/campaigns.test.ts` (schedule refused without segment, without test send after last edit, with a missing audience locale, with incomplete footer, without `campaigns.send`; snapshot excludes exclusion segments and unreachable persons; `chunk_no` of 1,234 recipients = 0..2; warm-up ordering by engagement; remove and restore recipient; refresh keeps removed rows; unschedule deletes planned rows; optimistic version conflict); `send-chunk.test.ts` (1,050 recipients send as 3 chunks and 11 batches through the fake; a suppression added between chunks skips that person: `skipped_suppressed`; withdrawn consent → `skipped_consent`; recipient locale missing → `skipped_translation`; pause between batches leaves the rest planned; resume uses `r2` keys and finishes; stop leaves planned rows; warm-up cap stops mid-chunk and re-enqueues next day 09:00; last chunk sets `sent`; batch retried with the same idempotency key does not double-send); `auto-pause.test.ts` (3 hard bounces of 120 sent pauses with `bounce_rate`, alert and task created; 1 of 120 does not; fewer than 100 sent never pauses); `jobs.test.ts` extended (plan and chunk twice → same state); `e2e/email.spec.ts` part 2 (campaign to a 3-person segment, remove one recipient, test send, send now, two messages in the sink).
- **Done**: typecheck, lint, suites green, e2e part 2 green.

### email-P7 (V1): reporting, deliverability, message log and person history

- **Goal**: per-campaign performance, the email overview with domain and warm-up status, complaint alerts, the message log, resend, manual suppression, stats freezing and the person-page email history.
- **Files**: create `apps/web/app/(admin)/admin/email/page.tsx`, `apps/web/app/(admin)/admin/email/messages/page.tsx`, `apps/web/app/(admin)/admin/email/messages/[id]/page.tsx`, `apps/web/app/(admin)/admin/campaigns/[id]/report/page.tsx`; create `apps/web/modules/email/ui/{PersonEmailHistory.tsx,CampaignReport.tsx,DeliverabilityPanel.tsx,KpiTiles.tsx}`; create `apps/web/modules/email/server/{reports.ts,complaints.ts,freeze.ts}`; edit `apps/web/modules/email/{actions.ts,queries.ts,api.ts,jobs.ts,schedules.ts,nav.ts}`, `packages/core/src/i18n/messages/*/email.json` (`email.report.*`, `email.deliverability.*`, `email.messages.*`); edit `e2e/email.spec.ts` (after P6).
- **Interfaces**: queries `getCampaignReport`, `listMessages`, `getMessage`, `listPersonEmails`, `getDeliverability`; actions `resendMessage`, `addManualSuppression`; `getCampaignStats(tx, ids)`; jobs `email.freeze_campaign_stats`; schedules `email.watch_complaints`, `email.freeze_due_stats`; component `PersonEmailHistory({ personId })` for `crm`.
- **Depends on**: email-P6; `crm:addSuppression`; `ops:reports.read` permission string (declared by ops).
- **Tests**: `reports.test.ts` (open, click, bounce and unsubscribe rates on a fixture campaign equal hand-computed values; per-link clicks; snapshot used after freeze and unchanged after retention delete); `complaints.test.ts` (0.2 % complaints over 600 delivered alerts once per hour; 0.05 % does not); `resend-message.test.ts` (new message with `:manual:1` key, refused for marketing); `person-history.test.ts` (newest first, pagination, masked email without `persons.read`); `e2e/email.spec.ts` part 3 (report shows the sent campaign; fake webhook bounce shows on the person page and the address becomes unreachable).
- **Done**: typecheck, lint, suites green, full `e2e/email.spec.ts` green.

### email-P8 (R2): commercial-engine email support

- **Goal**: webinar and lead-window email content for Release 2.
- **Files**: edit `packages/core/src/email/blocks.ts` (add `webinar` block `{ webinarId, ctaLabel }`; `event` block option `showLeadWindow: boolean`); edit `packages/email/src/blocks/{to-mjml.ts,to-text.ts,compile.ts}`; create `packages/email/src/templates/webinar/{registered.tsx,reminder.tsx,replay-available.tsx}`, `packages/email/src/templates/commerce/checkout-recovery.tsx`, `packages/email/src/templates/booking/lead-window-open.tsx`; edit `packages/email/src/templates/{webinar,commerce,booking}/index.ts`; edit `apps/web/modules/email/ui/editor/{BlockPalette.tsx,BlockInspector.tsx}`; edit `packages/db/src/seed/email.ts`, `packages/core/src/i18n/messages/*/email.json`.
- **Interfaces**: `WebinarBlock`; `resolveCards` gains `webinars: (ids, locale) => Promise<WebinarCard[]>`; the event card renders "Opens for you on <date time>" when the recipient's status is outside the session's current lead window (from `booking.getSessionCards()` field `opensForCustomersAt`).
- **Depends on**: email-P7; `webinar:getWebinarCards(tx, ids, locale)`; `booking:getSessionCards` with `opensForCustomersAt`; `commerce:checkouts`.
- **Tests**: `packages/email/src/blocks/webinar-block.test.ts` (render, missing webinar renders nothing); `event-lead-window.test.ts` (lead inside window sees the booking button, customer sees "Opens for you on ...", after release both see the button: scenario 3 email side); `templates/registry.test.ts` extended to the five new templates in three locales.
- **Done**: typecheck, lint, suites green.

### email-P9 (R3): campaign attribution

- **Goal**: revenue and first purchases per campaign for the campaign report and the `ops` marketing dashboards.
- **Files**: edit `packages/db/src/schema/email.views.ts` (add `v_email_attribution`); create `apps/web/modules/email/server/attribution.ts`; edit `apps/web/modules/email/{api.ts,queries.ts}`, `apps/web/modules/email/ui/CampaignReport.tsx`, `packages/core/src/i18n/messages/*/email.json`.
- **Interfaces**: `getCampaignAttribution(tx, { from, to })` (section 4); `getCampaignReport` gains `attribution: { orders; revenueCents; firstPurchases }`.
- **Depends on**: email-P8; `commerce:orders` (`paid_at`, `total_cents`, `status`).
- **Tests**: `attribution.test.ts` (order 3 days after a click attributed; 8 days not; two campaigns clicked → latest click before payment wins; refunded order excluded; first purchase flag).
- **Done**: typecheck, lint, suites green.

### email-P10 (R4): AI-assisted campaign creation

- **Goal**: staff describe a campaign; Claude drafts subject, preview text, three-locale body, segment and timing; a human edits and approves; nothing is scheduled automatically.
- **Files**: create `packages/core/src/email/ai.ts` (`AiCampaignDraftSchema`, `buildDraftPrompt()`); create `apps/web/modules/email/server/ai-draft.ts`; create `apps/web/modules/email/ui/campaign/AiDraftPanel.tsx`; edit `apps/web/app/(admin)/admin/campaigns/new/page.tsx`, `apps/web/modules/email/{actions.ts,queries.ts,jobs.ts}`, `packages/db/src/seed/email.ts` (`settings.email_brand` defaults), `packages/core/src/i18n/messages/*/email.json`.
- **Interfaces**: actions `requestAiDraft`, `acceptAiDraft`, `discardAiDraft`; query `listAiDrafts`; job `ai.draft_email`; `buildDraftPrompt(input: { brand; previousCampaigns; sessions; segments; purpose; brief }): { system: string; user: string; fieldsSent: string[] }`.
- **Depends on**: email-P9; `platform:callClaude` (AI gateway, budget, `ai_requests`); `crm:getSegmentSummaries`; `booking:getSessionCards`.
- **Tests**: `ai-draft.test.ts` with the Anthropic `fake.ts` (draft `ready` with valid three-locale document; invalid model output → `failed`; budget exceeded → `failed` with `budget`; `fieldsSent` contains no person-level field and no `SENSITIVE_COLUMNS` member; accept creates a `draft` campaign and draft version with `ai_draft_id`, never `scheduled`; discard; permission requires `ai.use` and `email.write`).
- **Done**: typecheck, lint, suites green.

## 13. Decisions made

**Ownership and boundaries**

1. `email` owns every file under `packages/email/src/templates/**` in all releases, including the folders named after other modules; other modules request new templates from `email` and call `sendTransactional()` with the typed key. This refines the architecture's per-module template folders so one registry stays consistent.
2. `email` owns the token preference centre (`/[locale]/preferences/[token]`, carved out of `site`'s `(site)/*`) and the portal page `/[locale]/account/preferences`, plus their API routes. The architecture's `crm` row "preference centre pages" is superseded; `crm` keeps ownership of consent and suppression writes, which `email` calls through `crm.addSuppression()` and `crm.recordConsent()`.
3. Resend webhook events are processed by `email.processResendEvent()` called from platform's generic `webhook.process` job, not by a separate email job.
4. No foreign keys to tables outside the Wave 0 contract set: `campaigns.segment_id` and `email_messages.enrolment_id` are plain uuids validated in code.
5. Published-version immutability is enforced in code by `assertDraftVersion()` with tests, not by a database trigger (custom triggers are reserved for APPEND tables).
6. Cross-module functions this spec requires from their owners: `crm.addSuppression`, `crm.recordConsent`, `crm.refreshSegment`, `crm.getSegmentSummaries`, `crm.createTask`; `booking.getSessionCards` (with `opensForCustomersAt` in R2), `booking.getNextBooking`; `commerce.getProductCards`; `forms.listLatestOutcomes`; `webinar.getWebinarCards` (R2); `platform.getSetting`, `platform.storeFile`, `platform.readFile`, `platform.callClaude` (R4).

**Additions to the architecture's data model**

7. `email_templates`: `name`, `description`, `is_system`, `created_by_user_id`, `updated_at`.
8. `email_template_versions`: `copy` (transactional text slots, so staff edit transactional wording without a deploy), `ai_draft_id`, `updated_at`; partial unique one draft per template.
9. `campaigns`: `name`, `template_id`, `chunk_count`, `run_no`, `paused_reason`, `test_sent_at`, `started_at`, `finished_at`, `stopped_at`, `cancelled_at`, `last_error`, `stats_snapshot`, `ai_draft_id`, `updated_by_user_id`, `version`, `updated_at`.
10. `campaign_recipients`: `chunk_no`, `removed_by_user_id`, `removed_at`, `created_at`, `updated_at`.
11. `email_messages`: `props`, `attachments`, `from_domain`, `bounce_type`, `attempt`, `retry_of_message_id`, `link_token_hash`, `links`, `error`, `queued_at`, `delivered_at`, `opened_at`, `clicked_at`, `bounced_at`, `complained_at`, `unsubscribed_at`, `last_event_at`, `updated_at`; enum `email_messages_kind` = `transactional|campaign|automation|test`.
12. `email_events`: `source` (`resend|tracking`), `link_index`, type value `failed` (Resend `email.failed`).
13. New table `email_ai_drafts` (R4); new views `v_campaign_stats` (V1) and `v_email_attribution` (R3).
14. New settings keys seeded by `email`: `email_config` (`senders`, `resend_domain_ids`, `bounce_pause_pct: 2`, `bounce_min_sent: 100`, `complaint_alert_pct: 0.1`, `complaint_min_delivered: 500`) and `email_brand` (tone of voice, guidelines, do-not-say list, sample phrases; R4). `email_footer` holds `reasons` per purpose and `transactional` per locale and `consent_wording_version`; company details come from `settings.company`.
15. Idempotency key formats beyond the architecture: chunk `campaign:<id>:chunk:<n>:r<run_no>` (resume-safe), warm-up continuation `...:d<YYYYMMDD>`, plan `campaign:<id>:plan:<scheduled ms>`, message `campaign:<id>:person:<person_id>`, Resend batch header `campaign:<id>:chunk:<n>:batch:<k>`, retry `<key>:retry`, manual resend `<key>:manual:<n>`, AI `ai:draft:<draft_id>`.

**Consent, reachability and unsubscribe**

16. `newsletter` and `events` require granted consent. `member_comms` is also reachable for current members without a withdrawal, and `b2b` for company contacts without a withdrawal (contract and legitimate interest); BEAM's legal review can change this in one view.
17. An `unsubscribe` suppression is lifted only by a later `granted` consent with method `preference_centre`, `portal` or `form`; `hard_bounce`, `complaint`, `manual` and `erased` suppressions are never lifted. Imports and staff can never re-subscribe someone.
18. Three soft bounces within 30 days become a suppression with reason `hard_bounce` and source `soft_bounce_x3`, avoiding a new crm enum value. Transactional soft bounces are retried once after 1 hour; marketing soft bounces are not retried.
19. Transactional mail is blocked only by `hard_bounce`, `complaint` and `erased` suppressions of scope `all`; magic link and password reset ignore `complaint`.
20. One random link token per marketing message, stored as a sha256 hash, valid 365 days, reusable (unsubscribe links must keep working); it serves unsubscribe, preferences and tracking.
21. One-click unsubscribe is https POST only (no mailto); a GET never changes data, so link scanners cannot unsubscribe anyone.
22. Unsubscribing one category never blocks other categories or transactional email; "unsubscribe from all marketing" writes scope `all`.

**Sending**

23. Senders `BEAM <hello@mail.beam.be>` and `BEAM <news@news.beam.be>`, Reply-To `info@beam.be`.
24. DNS per domain: Resend `send.` MX and SPF, `resend._domainkey` DKIM, DMARC `p=quarantine` for 4 weeks then `p=reject`, reports to `dmarc@beam.be`; daily domain verification check at 05:10.
25. Warm-up caps count per Brussels calendar day on `news.beam.be` only; overflow continues the next day at 09:00; during warm-up the most engaged recipients go first.
26. The audience snapshot is taken when scheduling (status `planning`), not at send time; "Refresh audience" is manual. This makes recipient preview and removal possible before sending.
27. Scheduling requires a test send of the current content after its last edit and a `scheduled_at` between 5 minutes and 90 days ahead (or "send now").
28. Bounce-rate auto-pause counts hard bounces only, after at least 100 sent; complaints alert but do not auto-pause. Resuming after an auto-pause requires typing the campaign name.
29. Stop leaves unsent recipients `planned` and reports them as "not sent (stopped)"; no new recipient status.
30. Outside production a missing `EMAIL_SINK` is a permanent job failure, never a real send; rendered HTML is kept 14 days.
31. Marketing templates must be complete in all three locales to publish; transactional templates too.
32. `product` blocks show the public price at send time; member pricing in email is out of scope.

**Tracking, reporting and retention**

33. Open and click tracking are our own routes, marketing only; Resend tracking is off. Clicks redirect only to URLs stored on the message (`links[i]`), so there is no open redirect. No IP is stored; only a user-agent family to flag privacy-proxy opens.
34. Rates use delivered as the denominator for opens, clicks and unsubscribes and sent for bounces.
35. Campaign stats are frozen into `stats_snapshot` 30 days after finishing so retention deletes never change history.
36. Retention: `email_messages` and `email_events` 2 years, `campaign_recipients` 2 years after finish, `props` 30 days, rendered sink files 14 days, `email_ai_drafts` 1 year. Erasure deletes the person's message rows instead of anonymising them.
37. R3 attribution is last click within 7 days before payment; refunded orders are excluded.

**Releases**

38. Release 2 email work is the `webinar` block, the lead-window aware `event` block and five templates; Release 3 is attribution; Release 4 is AI drafting; SMS, cold outbound email and send-time prediction stay "Later".
39. AI drafts use only aggregate and brand context (no person-level data), `claude-opus-5-5`, and acceptance creates a draft campaign; scheduling stays a human action with `campaigns.send`.
