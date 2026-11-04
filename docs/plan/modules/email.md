# Module `email`: Email platform

Owner paths: `packages/db/src/schema/email.ts`, `packages/db/src/schema/email.views.ts`, `packages/core/src/email/`, `packages/email/src/` except the template folders of other modules (`packages/email/src/templates/<m>/` belongs to module `<m>`, as architecture section 1 says; `email` owns `templates/email/`, `templates/define.ts` and the shared layout, renderer and block compiler), `packages/integrations/src/resend/`, `apps/web/modules/email/` (including `config.ts`, created empty by Wave 0), `apps/web/app/(admin)/admin/{email,templates,campaigns}/`, `apps/web/app/api/webhooks/resend/`, `apps/web/app/api/public/track/`, `packages/core/src/i18n/messages/<locale>/email.json`, `packages/db/src/seed/email.ts`, `docs/runbooks/email-dns.md`, `e2e/email.spec.ts`, `e2e/scenario-2-fast-unsubscribe.spec.ts`.

Not owned here: the one-click unsubscribe route, the token preference centre and the portal preferences page (`app/api/public/{unsubscribe,preferences}/`, `app/[locale]/(site)/preferences/`, `app/[locale]/(portal)/account/preferences/`) belong to `crm` (architecture section 11, "preference centre pages"); `email` puts crm's links into every marketing message and owns the scenario-2 spec that proves the whole path.

Blueprint sections: 30, 31 (sending side), 32; requirements also taken from 4, 5, 6, 7, 8, 10, 12, 15, 17, 21, 33, 34, 53, 56, 59, 62, 63, 72, 76, 84.

## 1. Purpose and release mapping

The email module replaces Mailchimp. It sends every email the platform produces, through Resend, from two BEAM-owned domains. It owns the template store (transactional and marketing), the template registry and renderer, the block editor, campaigns, chunked sending, delivery events, bounce and complaint handling, tracking, deliverability monitoring, reporting and, in Release 4, AI-drafted campaigns. Automations (blueprint 31, including the pre-send control "Pause automation") are owned by `automation`; this module renders and delivers their email steps and exposes reachability. Consent, suppressions, one-click unsubscribe and the preference centre are owned by `crm`; this module calls crm to write them and links to crm's pages from every marketing message. Each module writes its own transactional react-email templates in `packages/email/src/templates/<m>/` with `defineTemplate()` from this module.

| Release | What ships in `email` |
| --- | --- |
| **V1 (weeks 1-6)** | Resend integration with fake client; `mail.beam.be` (transactional) and `news.beam.be` (marketing) with SPF, DKIM, DMARC documented in a BEAM-owned DNS runbook; warm-up caps; RFC 8058 one-click unsubscribe headers pointing at crm's unsubscribe route; plain-text versions; legal footer for Vibrant Lifestyle Collective BV per locale (Belgian company identification and the reason for receiving); `email_templates` and immutable `email_template_versions`; the transactional template framework (`defineTemplate()`, generated registry, editable copy slots, seeding of every module's templates as system rows); the block editor (JSON block document per locale, 10 block types, dynamic block by lead/customer/member/assessment outcome, personalisation tokens and module merge fields) rendered to MJML then HTML with BEAM branding, accessibility checks and preview; campaigns with segment targeting and exclusions, audience snapshot, preview as a real contact and as lead, customer and member, test sends, recipient preview and removal, scheduling, pause, resume, stop, role-based sending, translation completeness check, chunked sending (500 per chunk, Resend batch 100) with per-chunk reachability and suppression re-check; `email_messages` and `email_events` from the Svix-signed Resend webhook; hard bounce, soft bounce (retry, then suppression) and complaint suppression through crm; open and click tracking routes; scenario 2 end to end (crm's one-click route and preference centre, this module's headers, chunk and send-time checks); bounce-rate auto-pause, complaint alerts, domain checks and the delivery watch for the SLA "emails not sending" (High); `email.send` with idempotency and final suppression check; campaign history per customer; per-campaign performance reporting; `EMAIL_SINK` outside production. |
| **Release 2 (weeks 9-10)** | Email support for the commercial engine: `webinar` block, lead-window aware `event` block ("Opens for you on ..." per recipient status, scenario 3), `findLatestMessage()` for commerce's abandoned-checkout recovery attribution. The R2 templates themselves (webinar access, reminders, replay, checkout recovery, lead-window opening) are written by `webinar`, `commerce` and `booking` in their own template folders. |
| **Release 3 (weeks 11-12)** | Campaign attribution for email: view `v_email_attribution` (orders paid within 7 days after a campaign click, last click wins; automation sends included through `enrolment_id`), revenue and first-purchase columns on the campaign report, `getCampaignAttribution()` for `ops` marketing dashboards. Resend Inbound for `in.beam.be`: the Resend webhook handler dispatches `email.received` events to `crm.ingestInboundEmail()` for crm's unified inbox; replies leave through `sendTransactional` with `replyTo` and threading headers. |
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
| `slug` | text | no | unique; check `(kind = 'transactional' and slug ~ '^[a-z]+\.[a-z][a-z0-9_]{1,60}$') or (kind = 'marketing' and slug ~ '^[a-z0-9][a-z0-9-]{2,79}$')`. Code-backed transactional slugs equal the registry key `<module>.<name>` (`booking.booking_confirmed`, `commerce.order_confirmation`, `platform.magic_link`); block-backed transactional templates seeded by a module use the same form (`automation.event_reminder_7d`). A dot marks transactional, hyphens mark marketing, so the two never collide (decision 1; cross-module D1, D2) |
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
| `document` | jsonb `BlockDocument` | yes | block-backed templates (every marketing template; transactional templates seeded as blocks): `{ schemaVersion: 1, locales: { [locale]: Block[] } }` (section 3, rule 20) |
| `copy` | jsonb `Record<slotKey, LocalizedText>` | yes | code-backed transactional only: editable text slots of the react-email component |
| `react_component` | text | yes | code-backed transactional only: the registry key in `TEMPLATE_REGISTRY`; checks `(react_component is null) = (copy is null)`, `(react_component is null) = (document is not null)` (exactly one body source); marketing templates are always block-backed (enforced by the actions) |
| `html_by_locale` | jsonb | yes | block-backed: compiled HTML per locale and dynamic variant, tokens left as placeholders; written at publish |
| `text_by_locale` | jsonb | yes | block-backed: plain text per locale and variant; written at publish |
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
| `purpose` | `email_messages_purpose` | yes | check `kind <> 'campaign' or purpose is not null`; an `automation` message carries the template's purpose (set by `queueMarketingEmail`; `newsletter` when `queueMarketingEmail` sends a registry template, rule 39a; null when `queueAutomationEmail` sends a transactional template), a `test` message the purpose of the tested template (decision 50) |
| `template_version_id` | uuid | no | FK `email_template_versions.id` |
| `campaign_id` | uuid | yes | FK `campaigns.id` |
| `enrolment_id` | uuid | yes | `automation_enrolments.id` (no FK, automation's table) |
| `locale` | text | no | |
| `subject` | text | yes | rendered subject, **person data** (may contain first name) |
| `props` | jsonb | yes | transactional `data` for rendering, **person data**; nulled 30 days after `sent_at` |
| `context` | jsonb | yes | ids only for merge-field resolvers (`{ registration_id, session_id, order_id }`), never names or addresses |
| `attachments` | jsonb | no | `'[]'`: `[{ fileId, filename, inline? }]`; `inline = true` sends with `content_id = filename` for `cid:` images (booking QR) |
| `reply_to` | text | yes | overrides the sender's Reply-To (R3 inbox replies) |
| `extra_headers` | jsonb | yes | only `In-Reply-To` and `References` (R3 inbox threading); any other key is refused by the api |
| `send_at` | timestamptz | yes | earliest send moment (gift vouchers delivered on a chosen date); the `email.send` job's `run_at`; check `send_at <= created_at + interval '400 days'` |
| `from_domain` | `email_messages_from_domain` | no | `mail.beam.be` whenever the template is transactional (kinds `transactional`, `automation` through `queueAutomationEmail`, and `test` of a transactional template), `news.beam.be` whenever it is marketing or the message is sent through `queueMarketingEmail` (including a registry template such as `commerce.checkout_recovery`, rule 39a) |
| `idempotency_key` | text | no | unique |
| `resend_id` | text | yes | unique |
| `status` | `email_messages_status` | no | `'queued'` |
| `bounce_type` | `email_messages_bounce_type` | yes | |
| `attempt` | smallint | no | `1`; check `attempt between 1 and 2` |
| `retry_of_message_id` | uuid | yes | FK `email_messages.id` (soft-bounce retry) |
| `link_token_hash` | text | yes | unique; hex sha256 of the per-message link token (rule 53), set on every message except `test`: it serves the open pixel and click redirect (marketing only) and crm's unsubscribe and preference links (every message), resolved for crm by `resolveLinkToken()` |
| `links` | jsonb | yes | array of target URLs; click tracking redirects to `links[i]` only |
| `rendered_file_id` | uuid | yes | FK `files.id`; non-production only |
| `error` | text | yes | last error code, never personal data (`unknown_template`, `invalid_template_data`, `no_recipient`, `invalid_recipient`, `attachment_too_large`, `missing_text_part`, `email_sink_missing`, `resend_4xx:<status>`) |
| `queued_at` | timestamptz | no | `now()` |
| `sent_at`, `delivered_at`, `opened_at`, `clicked_at`, `bounced_at`, `complained_at`, `last_event_at` | timestamptz | yes | first occurrence of each |
| `created_at`, `updated_at` | timestamptz | no | |

Indexes: unique `idempotency_key`; unique `resend_id`; unique `link_token_hash`; `(person_id, created_at desc)`; `(person_id, template_version_id, created_at desc)` (`findLatestMessage`); `(campaign_id, status)`; partial `(queued_at) where status in ('queued','blocked_translation')` (delivery watch and digest); `(from_domain, sent_at)` (warm-up counting). `(lower(to_email) text_pattern_ops)` for the message-log prefix search. All lookups are B-tree indexes used over the pooled `DATABASE_URL`; no `pg_trgm` or full-text index is needed.

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
  select p.id as person_id, ss.purpose,
    case
      when p.erased_at is not null then 'erased'
      when p.email is null then 'no_email'
      when p.processing_restricted_at is not null then 'restricted'
      when ss.is_suppressed then 'suppressed'
      when c.status = 'withdrawn' then 'withdrawn'
      when c.status = 'granted' then null
      else 'no_consent'
    end as blocked_reason
  from persons p
  join v_suppression_status ss on ss.person_id = p.id          -- crm view: one row per person and marketing purpose, merged persons excluded
  left join v_consent_current c on c.person_id = p.id and c.purpose::text = ss.purpose
  where p.merged_into_person_id is null
)
select person_id, purpose, blocked_reason, blocked_reason is null as is_reachable from base;
```

This is exactly the architecture's definition (consent granted, not suppressed for `all` or the purpose, not erased, email present), with crm's processing restriction added. The suppression logic, including the rule that only a newer `form`, `portal` or `preference_centre` grant lifts a scoped `unsubscribe` suppression, lives once, in crm's `v_suppression_status`; this view never repeats it. A merged person has no row (their winner does). `blocked_reason` values: `erased`, `no_email`, `restricted`, `suppressed`, `withdrawn`, `no_consent`. B2B contacts are reachable for `b2b` only through a granted record, which crm allows staff to write with `lawful_basis = legitimate_interest` (crm rule 3.14).

`v_campaign_stats`: per campaign, from `campaign_recipients` and `email_messages`: `campaign_id`, `recipients`, `planned`, `removed`, `skipped` (all `skipped_*`), `sent` (messages with `sent_at`), `delivered`, `hard_bounced`, `soft_bounced`, `complained`, `unique_opens` (`opened_at` not null), `privacy_proxy_opens` (first open event with `ua_family = 'apple_mpp'`), `unique_clicks`, `unsubscribed` (campaign messages for which crm wrote a `suppressions` row with reason `unsubscribe` and `source = 'one_click:<email_message_id>'` of that message, plus, for unsubscribe paths whose source names no message, a row with reason `unsubscribe` and scope `all` or the campaign purpose for the person's `email_hash` between `sent_at` and `sent_at + 7 days`; decision 22), and the rates `open_rate = unique_opens / nullif(delivered,0)`, `click_rate = unique_clicks / nullif(delivered,0)`, `click_to_open_rate`, `bounce_rate = hard_bounced / nullif(sent,0)`, `complaint_rate`, `unsubscribe_rate = unsubscribed / nullif(delivered,0)` as `numeric(6,4)`.

`v_email_attribution` (R3): per `campaign_id`, `person_id`, `order_id`, `paid_at`, `total_cents`, `is_first_purchase`: `orders` with status `paid` or `partially_refunded` (fully `refunded` orders excluded) whose `paid_at` falls within 7 days after `email_messages.clicked_at` for a campaign or automation message of the same person (automation rows carry `campaign_id` null and `enrolment_id`, and are grouped under the automation for ops); when several messages qualify, the latest click before `paid_at` wins (`distinct on (order_id) ... order by order_id, clicked_at desc`).

### Tables of other modules this module reads or writes

| Table | Module | Access |
| --- | --- | --- |
| `persons` (`email`, `email_hash`, `first_name`, `last_name`, `locale`, `erased_at`, `merged_into_person_id`, `processing_restricted_at`), `v_consent_current`, `v_suppression_status`, `suppressions`, `segments`, `segment_members` | crm | read; writes to `consent_records` and `suppressions` only through `crm.addSuppression()`, and to `activity_events` only through `platform.recordEvent` |
| `v_person_status`, `memberships`, `v_person_credits` | credits | read (dynamic blocks, tokens) |
| `automation_enrolments.context` | automation | read only, when `queueAutomationEmail` gets no `context` (merge fields) |
| `form_submissions`, `forms` | forms | read through `forms.listLatestOutcomes()` |
| `products`, `price_versions`; `sessions` | commerce; booking | read through `commerce.getProductCards()`, `booking.getSessionCards()` |
| `orders` | commerce | read (R3 attribution view) |
| `automation_enrolments` | automation | id only (`email_messages.enrolment_id`) |
| `settings`, `files`, `jobs`, `audit_log`, `webhook_events`, `integration_calls`, `ai_requests`, `users` | platform | read and write through platform helpers |
| `tasks` | crm | write through `crm.createTask()` (auto-pause review task) |
| `retention_policies` | ops | seed rows for email tables; `sweep` functions in `privacy.ts` |
| pages and legal links | site | `site.getLegalLinks(locale)` (privacy, terms, cookies URLs) for the footer; `site.getEventPageUrl()` for `event` blocks |

## 3. Business rules

Each rule is testable; the test file that proves it is named in section 12.

**Domains, senders and headers**

1. Transactional templates send from `mail.beam.be` (`BEAM <hello@mail.beam.be>`); marketing templates, campaigns and automation marketing steps send from `news.beam.be` (`BEAM <news@news.beam.be>`). Reply-To for both is `info@beam.be`. Values live in `settings.email_config.senders` and are editable by `settings.write`.
2. Every marketing message carries `List-Unsubscribe: <oneClickPostUrl>` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058, https only, no mailto), where the URLs come from `crm.buildPreferenceUrls(linkToken, locale)` with the message's own link token (rule 53). Transactional messages carry neither header; their footer carries the legal block and one "Manage email preferences" link built from the same call (crm opens the centre without a pre-selected purpose because `resolveLinkToken` returns `purpose = null`).
3. Every message is sent with both an HTML and a plain-text part. A message without a text part is a programming error and fails the render with `PermanentError('missing_text_part')`.
4. Every message ends with the legal footer (Belgian Code of Companies article 2:20 and Code of Economic Law book XII): legal name and form "Vibrant Lifestyle Collective BV", trade name, registered office address, enterprise number (the VAT number formatted `BE 0123.456.789`), the register entry `settings.email_footer.rpr[locale]` ("RPR Gent" / "RPM Gand"), the support email from `settings.company`, the privacy and terms links from `site.getLegalLinks(locale)`, and a reason sentence from `settings.email_footer.reasons[<purpose or 'transactional'>][locale]` with `{date}` replaced by the consent `recorded_at` date (marketing) or omitted (transactional). Marketing footers add the links "Manage preferences" (`preferencesUrl`) and "Unsubscribe from <category>" (`unsubscribeUrl`, crm's confirmation page), and the subject of a marketing message is never disguised: the sender name is "BEAM" and the footer states "You receive this commercial message because ..." (identifiable advertising, XII.12).
5. A campaign cannot be scheduled and a marketing template cannot be published while `settings.company.legal_name`, `address` or `vat_number` is empty, `settings.email_footer.rpr` lacks a template locale, or any reason text for the purpose is missing in a template locale.

**Warm-up and volume**

6. `settings.warmup_schedule = { domain: 'news.beam.be', start_on: <go-live date>, daily_caps: [1000, 2000, 4000, 8000] }`. Week `w = floor((today - start_on) / 7)`; the cap for a Brussels calendar day is `daily_caps[w]`; from week 4 on there is no cap. `mail.beam.be` has no cap.
7. A chunk counts `email_messages` with `from_domain = 'news.beam.be'` and `sent_at` today (Brussels). When the cap is reached mid-chunk, the chunk stops, leaves the rest `planned`, and enqueues itself again for the next day at 09:00 Brussels with the key qualifier `:d<YYYY-MM-DD>` (the continuation day; dates in keys are `YYYY-MM-DD`, cross-module convention 5).
8. While a warm-up cap applies, `campaign.plan` orders recipients by most recent `opened_at` across their messages (most engaged first, never-opened last) before assigning `chunk_no`; outside warm-up it orders by `person_id`.

**Templates and versions**

9. A template has at most one draft version and any number of published versions; `current_version_id` points to the latest published one.
10. Publishing a version requires `assertComplete()` for `subject`, `preheader` and every text slot (`copy` or block text) in all three locales (`nl-BE`, `fr-BE`, `en`), for marketing and transactional templates alike, so `locales` of a published version is always the full set. The action fails with the list of missing `locale:path` items.
11. A published version is never updated. Saving changes to a published template creates a new draft copied from the current version.
12. Publishing a block-backed version compiles MJML once per locale and per dynamic variant path and stores the result in `html_by_locale` and `text_by_locale`; compile errors (MJML `validationLevel: 'strict'`) block publishing and are shown per block.
13. A version's personalisation tokens must all be in `EMAIL_TOKENS` or the merge-field registry (rule 23); an unknown token blocks publishing.
14. Seeded transactional templates (`is_system = true`) cannot be archived; staff with `email.send` edit their copy and republish without a deploy.
15. Archiving a template is refused while a campaign in `scheduled`, `sending` or `paused` or an active automation version references it (`automation.isTemplateInUse(tx, slug)`; until automation lands the stub's `NotImplementedError` counts as "in use").
15a. Transactional template registry. Each module declares its code-backed templates in `packages/email/src/templates/<m>/index.ts` as `export const templates = [defineTemplate({ name, component, props, slots, attachments?, loadProps? })]`; `pnpm gen:indexes` collects every folder into `packages/email/src/templates/registry.generated.ts` (git-ignored) as `TEMPLATE_REGISTRY`, keyed `<m>.<name>` where `<m>` is the folder and `name` the declared snake_case name (`booking.booking_confirmed`, `commerce.order_confirmation`, `webinar.replay_available`; the file stays kebab-case, `replay-available.tsx`). `<name>` equals the file basename with `-` replaced by `_`; one file is one key (cross-module D1). The generator refuses a `name` outside `^[a-z][a-z0-9_]{1,60}$`, a name whose kebab form does not match its file basename, a duplicate key and a slash; `templates/define.test.ts` asserts the same. A key outside the registry is never sendable. Variants inside one file (`webinar.reminder` `d7|d3|h3`) are a `variant` field of the template's own props schema, never a second key for the same file. `slots` lists the editable copy slots with their default catalogue keys `<m>.email.<name>.<slot>` (the owning module's catalogue), so wording is edited in the admin and the catalogue only seeds version 1. `attachments(props, locale)` may build generated attachments at send time (webinar `.ics`). `loadProps(tx, { personId, locale, context, stepKey })` is declared by templates that automation may send (rule 39a); it builds the props from ids, because an automation step has no `data`. The props schema, the component and the copy belong to the owning module; `email` never writes them. `email`'s seed creates one `email_templates` row (`kind = transactional`, `is_system = true`) and published version 1 per registry entry and never overwrites an edited one.
15b. Accessibility (EN 301 549 / WCAG 2.1 AA as far as email clients allow): the shell sets `<html lang="<locale>">` and `dir="ltr"`, layout tables carry `role="presentation"`, body text is at least 14 px, brand text and button colours have a contrast ratio of at least 4.5:1 (checked once in `brand.ts` by a unit test), every image has `alt` (decorative images use `alt=""` explicitly), buttons and links have descriptive text (the editor warns on "click here", "hier", "ici"), and headings keep their order. Publishing warns (does not block) when a locale's document has images but fewer than 50 words of text.

**Block document**

16. Block types: `heading` (`level` 1-3, `text`), `text` (limited Markdown: bold, italic, links, bullet and numbered lists), `image` (`fileId` of a public `files` row of kind `image`, `alt` required, optional `href`, `width` 100-600), `button` (`label`, `href` https or token URL, `style` `primary|secondary`), `divider`, `spacer` (`height` 8-64), `columns` (2 or 3 columns, widths summing to 100, `stackOnMobile` default true), `product` (`productId`, `showPrice`, `ctaLabel`), `event` (`sessionId`, `ctaLabel`), `dynamic` (`variants: [{ when, blocks }]`, `fallback: Block[]`).
17. `columns` may not contain `columns` or `dynamic`; `dynamic` may not contain `dynamic`. A document has at most 200 blocks per locale and at most 256 KB of JSON.
18. A `dynamic` block evaluates variants in order and renders the first match; `when` is `{ status: 'lead'|'customer'|'member' }` (from `v_person_status`) or `{ assessmentOutcome: { formSlug, outcomeKeys: string[] } }` (latest completed submission of that form); no match renders `fallback` (may be empty).
19. `product` blocks render the product name, the public price at send time and a link to `https://beam.be/<locale>/account/shop/<sku>` (commerce's product page; the portal asks for login only at checkout); `event` blocks render title, Brussels date and time, and the link from `site.getEventPageUrl(db, sessionId, locale)` (event page, or the portal booking URL when no page exists). Both are resolved once per chunk; an inactive product or a cancelled or past session makes the block render nothing and the publish preview shows a warning.
20. The document shape is `{ schemaVersion: 1, locales: { 'nl-BE': Block[], 'fr-BE': Block[], 'en': Block[] } }`; each block has a stable `id` (nanoid 10). Locales may differ in structure.
21. The HTML of one message must stay under 102 KB (Gmail clipping); above that the editor shows a warning and publishing still succeeds.
22. Images are referenced by absolute URL `https://beam.be/api/public/files/<id>`; the editor uploads through platform's `uploadImage` action (`files.upload_image`, public `files` row of kind `image`, `image/png|jpeg|gif|webp`). The editor refuses files above 2 MB before upload, and publishing warns for any referenced image above 1 MB.

**Personalisation**

23. Tokens: `{{first_name}}`, `{{last_name}}`, `{{full_name}}`, `{{status}}`, `{{credits_remaining}}`, `{{next_booking_at}}`, `{{membership_period_end_on}}`, `{{portal_url}}`, `{{preferences_url}}`, `{{unsubscribe_url}}`. Module merge fields use a dotted name `{{<module>.<field>}}` (for example `{{webinar.title}}`, `{{webinar.starts_at_local}}`, `{{webinar.access_url}}`), declared by the owning module in `apps/web/modules/<m>/merge-fields.ts` as `Record<string, (args: { tx; personId; context; locale }) => Promise<string | null>>` and collected by `pnpm gen:indexes` into `registry/merge-fields.generated.ts`; a resolver receives only the message's `context` ids. Syntax `{{token|fallback}}`; the fallback is plain text written in that locale. A missing value without fallback renders an empty string. Values are HTML-escaped. `EMAIL_TOKENS` contains no `SENSITIVE_COLUMNS` member (unit test).
24. Token values come only from `persons` (names), `v_person_status`, `v_person_credits`, `memberships`, `booking.getNextBooking()` and the merge-field resolvers. Sensitive fields are never read.

**Campaign lifecycle**

25. States move only along: `draft → planning → scheduled → sending → sent`; `sending ↔ paused`; `paused → sent` (resume when no `planned` recipient remains); `sending|paused → stopped`; `draft|scheduled → cancelled`; `scheduled → draft` (unschedule); `planning → draft` on plan failure with `last_error`. `sent`, `stopped` and `cancelled` are terminal. `canTransition(from, to)` in `packages/core/src/email/campaign-state.ts` is the single check; every status write is `update campaigns set status = $to ... where id = $id and status = $from` after `select ... for update`, so two concurrent transitions cannot both win.
26. Scheduling requires: permission `campaigns.send`; a segment; the template's draft or current version complete for every locale present in the audience (counted by `getAudienceEstimate`); a test send of the current content after its last edit (`test_sent_at > draft.updated_at`); `scheduled_at` at least 5 minutes in the future and at most 90 days ahead, or "send now"; rule 5 satisfied. A `scheduled_at` outside 08:00-21:00 Brussels, on a Sunday or on a Belgian public holiday (`belgianPublicHolidays(year)` in `packages/core/src/email/send-window.ts`: the ten legal holidays, Easter-based ones computed) needs an explicit "send anyway" confirmation (`confirmOutsideWindow: true`); it is a warning, not a block.
27. Scheduling publishes the draft version (if one exists), sets `template_version_id`, moves to `planning` and enqueues `campaign.plan`. The audience snapshot refreshes the segment (`crm.refreshSegment(tx, ctx, segmentId, 'campaign')`) and inserts one `campaign_recipients` row per person of `crm.segmentAudienceSql(segmentId, excludeSegmentIds)` (members minus every exclusion segment), minus persons whose reachability for the purpose is false at snapshot time (those are not inserted), and sets `recipients_count`, `chunk_count`, `audience_snapshot_at`, status `scheduled`.
28. While `scheduled` or `paused`, staff with `campaigns.send` may remove a `planned` recipient (status `removed`, audited) and restore a removed one (back to `planned`). Removed recipients stay removed through refreshes.
29. "Refresh audience" (only in `scheduled`) inserts newly qualifying persons, marks `planned` rows that no longer qualify as `skipped_unreachable`, never touches `removed` or sent rows, and recomputes chunks for `planned` rows.
30. A campaign whose recipient locale is not in the version's `locales` is impossible to schedule (rule 26); if it still happens (a person changed locale after the snapshot), the chunk writes `skipped_translation` for that recipient.
31. At `scheduled_at` the minute schedule `email.dispatch_due_campaigns` claims due campaigns with `select ... where status = 'scheduled' and scheduled_at <= now() for update skip locked`, sets `sending`, `started_at`, and enqueues one `campaign.send_chunk` per chunk number on the `bulk` lane, priority 9, key `campaign:<id>:chunk:<n>:r<run_no>`.
32. Each chunk, before every batch of 100: reloads the campaign and exits (job succeeds) if the status is not `sending`; then per recipient re-reads `v_marketing_reachability` for the purpose: `suppressed` → `skipped_suppressed`; `withdrawn` or `no_consent` → `skipped_consent`; `erased`, `no_email` or `restricted` → `skipped_unreachable`. Recipient rows are claimed with `select ... where campaign_id = $1 and chunk_no = $2 and status = 'planned' for update skip locked limit 100`, so a retried or overlapping chunk never sends a row twice.
33. A chunk inserts `email_messages` (key `campaign:<id>:person:<person_id>`, `kind = campaign`), renders per recipient from the precompiled HTML, sends through `ResendClient.sendBatch()` (max 100 per call, `Idempotency-Key: campaign:<id>:chunk:<n>:batch:<k>`), stores `resend_id` per message in returned order, sets recipient `sent` and increments `sent_count`.
34. At its end every chunk locks the campaign row (`for update`) and counts `planned` recipients; when the count is 0 it sets `sent` and `finished_at`. Because the count runs under the row lock after the chunk's own rows are committed, exactly one chunk (the last to finish) sees 0, whatever order chunks finish in. Recipients deferred by the warm-up cap stay `planned`, so the campaign stays `sending` until the next day's continuation.
35. Pause sets `paused` with reason `manual`; running chunks exit at the next batch boundary. Resume increments `run_no`, sets `sending` and enqueues chunks that still have `planned` recipients; when none remain, resume sets `sent` directly (rule 25).
36. Stop sets `stopped`; chunks exit at the next batch; remaining `planned` rows stay `planned` and the report shows them as "not sent (stopped)". Messages already accepted by Resend cannot be recalled; the stop dialog says so.
37. Bounce-rate auto-pause: after each chunk and after each processed bounce event of a campaign message, if the campaign is `sending`, `sent >= settings.email_config.bounce_min_sent` (100) and `hard_bounced / sent > bounce_pause_pct / 100` (2 %), the campaign moves to `paused` with reason `bounce_rate` (audit `email.campaign_auto_pause`, actor system), `notifySlack({ fingerprint: 'email:bounce:<campaign_id>', severity: 'high' })` posts to `#beam-alerts`, and one task (`crm.createTask(tx, ctx, { title, kind: 'review', ownerRole: 'marketing', priority: 'high', source: 'system', ref: { type: 'campaign', id }, dedupeKey: 'email:bounce:<campaign_id>' })`) is created. A campaign already `sent` gets the alert and the task but no status change. Resuming after an auto-pause requires typing the campaign name in the confirm dialog.
38. Complaint alert: every 15 minutes `email.watch_complaints` computes complaints / delivered for `news.beam.be` over the last 24 hours; above 0.1 % (with at least 500 delivered) it calls `notifySlack({ fingerprint: 'email:complaints', severity: 'high' })` (deduplicated per hour by platform) and shows a red banner on `/admin/email`.
38a. Delivery watch (proposal SLA: "emails not sending" is High, response within 4 business hours): every 5 minutes `email.watch_delivery` checks (a) a transactional message `queued` with `coalesce(send_at, queued_at) < now() - interval '10 minutes'`, (b) 5 or more `email.send` jobs that ended `dead` or `failed` in the last 15 minutes, (c) zero `email.sent` events in 60 minutes while 20 or more messages were queued in that hour. Any of them posts `notifySlack({ fingerprint: 'email:delivery:<check>', severity: 'high' })` and shows a red "Email delivery problem" banner on `/admin/email`. (d) Failed emails (platform PL-75a row "Failed emails", owned here): any message that became `blocked_translation` or `failed` (error other than `cancelled`) in the last 5 minutes posts `notifySlack({ fingerprint: 'email:failed:<error or blocked_translation>', severity: 'normal' })` with the count and the template keys, never addresses; platform deduplicates per fingerprint per hour, and the dead `email.send` job alert stays platform's (PL-29). `getEmailHealth()` returns the values of (a) to (d) for the daily digest and the System page. This module owns both PL-75a rows "Failed emails" and "Deliverability" (rules 37, 38, 38a and `email.check_domains`).

**Single messages (`email.send`)**

39. `sendTransactional()`, `queueMarketingEmail()` and `queueAutomationEmail()` insert an `email_messages` row with the caller's idempotency key (the `key` input) and enqueue `email.send` (`fast` lane; priority 1 for transactional, 5 for automation; `run_at = send_at` when given) with key `email:<message_id>`, inside the caller's transaction (transactional outbox). A second call with the same key returns the existing message and job ids and enqueues nothing new (`insert ... on conflict (idempotency_key) do nothing returning id`, then a select). Neither function ever throws for content problems, so an email problem never rolls back a booking or a payment: an unknown template key, `data` that fails the template's Zod schema, or no address (no `to` and no person email) is detected by `email.send`, which sets status `failed` with error `unknown_template`, `invalid_template_data` or `no_recipient` and raises a `PermanentError` (dead job, Slack alert). The functions throw only when called outside a transaction.
39a. Automation sends. `queueMarketingEmail(ctx, input)` accepts marketing templates and sets `purpose` from the template. It also accepts a code-backed registry template that declares `loadProps` when automation sends it as a commercial message (cross-module D54: `commerce.checkout_recovery`, props from commerce's `getCheckoutRecoveryProps`): such a message is rendered with the marketing footer, the `List-Unsubscribe` headers of rule 2 and tracking, is sent from `news.beam.be`, and takes purpose `newsletter`, so reachability for `newsletter` is checked. `queueAutomationEmail(ctx, input)` accepts only transactional templates (block-backed ones, and code-backed registry entries that declare `loadProps`) and leaves `purpose` null. Both write `kind = automation` with `enrolment_id`, repeat automation's reachability (marketing only) and translation checks, and return `skipped_unreachable` or `skipped_translation` with a message row in status `suppressed` or `blocked_translation` (so the person page shows it) instead of throwing. A code-backed template without `loadProps`, or `loadProps` output that fails the props schema, is `failed` with `invalid_template_data` by `email.send` (rule 39). `stepKey` and `context` (or, when absent, `automation_enrolments.context`) are passed to `loadProps` and to the merge-field resolvers.
40. `email.send` re-checks just before calling Resend: the person is not erased; for marketing messages `v_marketing_reachability.is_reachable` for the purpose; for all messages a suppression of scope `all` with reason `hard_bounce`, `complaint` or `erased` (`crm.isSuppressed` semantics, read from `suppressions` by `email_hash`). Exception: `platform.magic_link`, `platform.password_reset`, `platform.mfa_changed` and `ops.privacy_erasure_scheduled` ignore `complaint` suppressions (the person asked for them, or it is a security notice). A failed check sets status `suppressed` and the job succeeds. Scoped `unsubscribe` suppressions never block transactional mail, so crm's `crm.confirm_resubscribe` reaches someone who unsubscribed from a category.
41. A missing translation (`MissingTranslationError`) sets status `blocked_translation`, records `email.blocked` on the person's timeline and is a `PermanentError`; there is no fallback language. The daily digest and `/admin/email` list blocked messages.
42. The locale is the caller's required `locale` input; callers pass `persons.locale` (staff emails `users.locale`; a magic link before a person exists uses the URL locale). `queueMarketingEmail` and `queueAutomationEmail` use `persons.locale`.
43. Outside production (`APP_ENV !== 'production'`, platform's variable), every recipient is rewritten to `EMAIL_SINK`, the subject is prefixed with `[<env> → <real address>]`, and the rendered HTML is stored in `files` (kind `rendered_email`, `expires_at = now() + 30 days`, the platform retention for that kind) linked by `rendered_file_id`. If `EMAIL_SINK` is unset outside production the job fails with `PermanentError('email_sink_missing')`.
44. Attachments (invoice and credit-note PDFs, receipts, gift vouchers, booking QR codes, generated `.ics` files) are read from `files` or built by the template's `attachments()` and sent by single send only; batch never carries attachments. Total attachment size above 10 MB fails permanently with `attachment_too_large`.

**Events, bounces and complaints**

45. The Resend webhook is accepted only with a valid Svix signature (HMAC-SHA256 over `<svix-id>.<svix-timestamp>.<body>` with `RESEND_WEBHOOK_SECRET`) and a timestamp within 5 minutes; otherwise 401 and nothing is stored.
46. Event mapping: `email.sent` → `sent`; `email.delivered` → `delivered`; `email.delivery_delayed` → `delayed`; `email.bounced` → `bounced` (`bounce.type = 'Permanent'` → hard, otherwise soft); `email.complained` → `complained`; `email.opened`, `email.clicked` → stored with source `resend` (domain tracking is off; counted only if our own tracking missed it); `email.failed` → `failed`; R3: `email.received` (Resend Inbound on `in.beam.be`) is not an outbound event: the handler maps the payload to crm's input and calls `crm.ingestInboundEmail(tx, ctx, { messageId: <Message-ID header>, inReplyTo?, from, fromName?, subject, text, attachmentCount, receivedAt })` (returns `{ threadId }`; never a raw `{ payload }`, cross-module D10) in the `webhook.process` transaction, and stores nothing in `email_events`. Unknown types are stored in `webhook_events` and ignored.
47. Message status moves forward only by rank `queued(0) < sent(1) < delivered(2) < bounced(3) = complained(3) = failed(3)`; a `complained` event after `bounced` still sets `complained_at`. First-occurrence timestamps are set once.
48. A hard bounce calls `crm.addSuppression(tx, ctx, { email: to_email, scope: 'all', reason: 'hard_bounce', source: 'resend:<resend_id>', personId })`; a complaint calls it with reason `complaint`, and crm (rule 3.18) also writes consent `withdrawn` with method `complaint` for every marketing purpose. crm's `addSuppression` calls `automation.requestSuppressionExit` in the same transaction (which enqueues `automation.exit_for_suppression`); this module never enqueues that job itself and never writes `consent_records`.
49. A soft bounce of a transactional message is retried once: a new message row (`attempt = 2`, `retry_of_message_id`, key `<original key>:retry`) is sent after 1 hour. A soft bounce of a marketing message is not retried. Three soft bounces for the same address within 30 days call `crm.addSuppression` with scope `all`, reason `hard_bounce`, source `soft_bounce_x3`. The count runs under `select ... from email_messages where id = $1 for update`, and the suppression's unique `(email_hash, scope)` makes a concurrent fourth bounce harmless.
50. Opens are recorded by the pixel `GET /api/public/track/open?t=<token>` (marketing messages only); clicks by `GET /api/public/track/click?t=<token>&l=<index>`, which 302-redirects to `links[index]` of that message and to `https://beam.be/<locale>` when the token or index is invalid (no open redirect). Every hit appends an `email_events` row; `opened_at` and `clicked_at` keep the first. A click also sets `opened_at` when it is null.
51. Transactional messages carry no tracking pixel and no click rewriting.
52. Timeline events (via `platform.recordEvent`; `data` keys are snake_case, cross-module convention 2): `email.sent` (`dedupe_key = email:<id>:sent`, data `{ template_slug, campaign_id, enrolment_id }`; the subject is not copied to the timeline because it may contain a name), `email.opened` (first only), `email.clicked` (first per link index, data `{ link_index, url }`), `email.bounced` (`{ bounce_type }`), `email.complained`, `email.blocked` (`{ reason: 'translation' | 'suppressed' }`). Unsubscribes and preference changes appear through crm's `consent.withdrawn`, `consent.granted` and `suppression.added`. Test sends write no events.

**Preference centre and unsubscribe**

53. Every message except a test send gets a fresh 32-byte random link token (architecture section 10: random single-use tokens, sha256 hashes stored, no stateless signed tokens); only its sha256 hex is stored (`link_token_hash`), the raw token exists only in the rendered message. For marketing messages it serves the open pixel and click redirects, which record events for 365 days. For every message it is the token of crm's links: `crm.buildPreferenceUrls(linkToken, locale)` renders the `List-Unsubscribe` header (rule 2), the footer links and the `{{preferences_url}}` and `{{unsubscribe_url}}` tokens, and crm resolves it with `resolveLinkToken(db, token)` → `{ emailMessageId, personId, purpose, locale, sentAt } | null` (sha256 lookup on the unique index; `purpose` null for transactional and automation-transactional messages; null when the row is gone after retention or erasure, and crm then offers "email me a fresh link"). The token never unsubscribes by itself inside this module; crm's routes decide (crm decision 17: unsubscribe works while the row exists, other preference changes within 365 days).
54. One-click unsubscribe, the confirmation page, the token preference centre, "email me a fresh link", the portal preferences page and manual suppressions are crm's routes and actions (crm section 4); this module has no unsubscribe or preference logic of its own and emits no unsubscribe or preference events.
55. This module enforces the result at three moments without being told about the unsubscribe: `campaign.plan` leaves unreachable persons out, every chunk batch re-reads `v_marketing_reachability` (rule 32), and `email.send` re-reads it just before Resend (rule 40). Unsubscribing from one category leaves the other categories reachable and never blocks transactional email, because the view is per purpose and transactional sends ignore scoped `unsubscribe` suppressions.
56. A Resend complaint is the fourth unsubscribe path (scenario 2): rule 48 calls `crm.addSuppression` with reason `complaint`, which blocks every marketing purpose for that address forever.
57. Imports never lift suppressions: `v_suppression_status` lifts a scoped `unsubscribe` suppression only for a newer grant with method `form`, `portal` or `preference_centre`, and crm skips imported grants for suppressed addresses (proposal acceptance "suppression survives an import"; the email side is proved in `reachability-view.test.ts`).
58. An unsubscribe stops marketing within 15 minutes (blueprint 31, acceptance "unsubscribe stops marketing within 15 minutes"): by construction it stops at the next chunk batch or `email.send` (seconds), and at most the batch of 100 already handed to Resend can still arrive (edge case 4).
59. Scheduled single messages: a message with `send_at` in the future stays `queued` and its job waits until `run_at`; all checks of rule 40 run at that moment, not at creation. `cancelScheduledMessage(ctx, { messageId })` (used by commerce when a gift voucher is refunded before delivery) sets status `failed` with error `cancelled` while the message is still `queued`, under `select ... for update`; `email.send` skips a message that is no longer `queued`.
60. Test sends: `kind = test`, only to `users.email` addresses of active staff, subject prefixed `[TEST]`, from the template's domain, with headers and footer exactly as the real message but without link token, timeline events or stats. A test send is the one way to satisfy rule 26.

**Reporting and history**

61. The campaign report shows recipients, skipped by reason, not sent (stopped), sent, delivered, unique opens (and of which privacy-proxy opens), unique clicks, hard and soft bounces, complaints, unsubscribes, and the rates of `v_campaign_stats`; clicks per link index; and per-locale counts. The campaign list shows open rate and click rate per campaign (blueprint 30 "Open rate", "Click rate").
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
| `sendTestEmail` (`email.test_send`) | `{ templateId, use: 'draft'|'current', locales: Locale[] (1-3), to: email[] (1-5, must be staff `users` emails), as: { personId } | { sample: 'lead'|'customer'|'member', assessmentOutcome?: string }, campaignId? }` | `{ messageIds }` | `email.write` (`persons.read` too when `as.personId`) | `email.test_send`; sets `campaigns.test_sent_at` |
| `createCampaign` (`email.campaign_create`) | `{ name, purpose, templateId? }` (creates a marketing template `campaign-<yyyymmdd>-<slug>` when absent) | `{ campaignId }` | `email.write` | `email.campaign_create` |
| `updateCampaign` | `{ campaignId, expectedVersion, name?, segmentId?, excludeSegmentIds?, scheduledAt? }` (only in `draft`) | `{ version }` | `email.write` | `email.campaign_update` |
| `scheduleCampaign` (`email.campaign_schedule`) | `{ campaignId, expectedVersion, scheduledAt: Date | 'now', confirmOutsideWindow?: boolean }` | `{ status: 'planning' }` or `validation` listing failed rule-26 checks | `campaigns.send` | `email.campaign_schedule` (blueprint 56 "Campaign sent") |
| `unscheduleCampaign` | `{ campaignId, expectedVersion }` | `{ status: 'draft' }` (deletes `planned` and `removed` recipients) | `campaigns.send` | `email.campaign_unschedule` |
| `refreshAudience` | `{ campaignId, expectedVersion }` | `{ added, skipped }` | `campaigns.send` | `email.campaign_refresh` |
| `removeRecipient` / `restoreRecipient` | `{ campaignId, personId }` | `{ ok }` | `campaigns.send` | `email.recipient_remove` / `email.recipient_restore` (person_id set) |
| `pauseCampaign` / `resumeCampaign` | `{ campaignId, expectedVersion, confirmName? }` | `{ status }` | `campaigns.send` | `email.campaign_pause` / `email.campaign_resume` |
| `stopCampaign` | `{ campaignId, expectedVersion }` | `{ status: 'stopped', notSent }` | `campaigns.send` | `email.campaign_stop` |
| `cancelCampaign` | `{ campaignId, expectedVersion }` | `{ status: 'cancelled' }` | `campaigns.send` | `email.campaign_cancel` |
| `duplicateCampaign` | `{ campaignId }` | `{ campaignId }` (new draft, content copied into a new draft version) | `email.write` | `email.campaign_create` |
| `resendMessage` (`email.message_resend`) | `{ messageId }` (transactional, status `sent|delivered|bounced|failed`) | `{ messageId }` (key `<original>:manual:<n>`, same template version, `data` and attachments, sent to the person's current email) | `persons.write` (reception and customer service resend a booking confirmation or receipt at the desk); refused for marketing and test messages and while the address is suppressed | `email.message_resend` |
| `cancelScheduledMessage` (`email.message_cancel`) | `{ messageId }` (status `queued` with `send_at` in the future) | `{ ok }` | `email.send` | `email.message_cancel` |
| `requestAiDraft` (R4) | `{ brief, sessionIds: uuid[] (0-3), segmentId?, purpose, campaignId? }` | `{ draftId }` | `email.write` + `ai.use` | `email.ai_draft_request` |
| `acceptAiDraft` (R4) | `{ draftId, campaignName }` | `{ campaignId }` (draft campaign with the AI content in a draft version) | `email.write` + `ai.use` | `email.ai_draft_accept` |
| `discardAiDraft` (R4) | `{ draftId }` | `{ ok }` | `email.write` | `email.ai_draft_discard` |

### Server actions (public and customer)

None. The preference centre, one-click unsubscribe, fresh-link request, portal preferences and manual suppressions are crm actions and routes (`updatePreferencesByToken`, `updateMyPreferences`, `addManualSuppression`, crm section 4); this module declares none of them. Images are uploaded with platform's `uploadImage`; the `/admin/email` overview links to crm's suppression screen.

### Queries (`queries.ts`)

`listTemplates({ kind?, status?, q?, page })`, `getTemplate(templateId)` (template, draft, current version, completeness, references), `getPreview({ templateId, use, locale, as })` → `{ subject, preheader, html, text, sizeBytes, warnings }`, `listCampaigns({ status?, q?, page })`, `getCampaign(campaignId)`, `getAudienceEstimate({ segmentId, excludeSegmentIds, purpose })` → `{ total, reachable, byLocale: Record<Locale, number>, blockedByReason }`, `listCampaignRecipients({ campaignId, status?, q?, page, pageSize: 50 })`, `getCampaignReport(campaignId)` → stats plus `clicksByLink`, `byLocale`, R3 `attribution`, `listMessages({ status?, kind?, q?, from?, to?, page })`, `getMessage(messageId)` (with events), `listPersonEmails({ personId, page })`, `getDeliverability()` → domains, warm-up day and cap, sent today, 7-day bounce and complaint rates, blocked messages, recent suppressions, delivery watch state (`getEmailHealth`), `listAiDrafts()` (R4). Staff queries call `requirePermission('email.write')`, except `getDeliverability` and reports which accept `reports.read` as well.

### Route handlers

| Route | Method | Behaviour |
| --- | --- | --- |
| `app/api/webhooks/resend/route.ts` | POST | One line over platform's `handleWebhook(req, { provider: 'resend', verify: verifyResendWebhook })`: verify Svix (rule 45), insert `webhook_events` (`external_event_id` = `svix-id`, on conflict nothing), enqueue `webhook.process` with key `webhook:resend:<svix-id>` only when inserted; 200 in under 2 s. `webhook.process` dispatches to this module's `defineWebhookHandler({ provider: 'resend', handle })` in `jobs.ts`, which calls `processResendEvent()` |
| `app/api/public/track/open/route.ts` | GET `?t=` | rule 50; returns a 43-byte transparent GIF, `cache-control: no-store`, always 200 |
| `app/api/public/track/click/route.ts` | GET `?t=&l=` | rule 50; 302 |

No mailto unsubscribe address exists: crm's https one-click URL satisfies RFC 8058 and the Gmail and Yahoo bulk-sender rules. The unsubscribe and preference routes are crm's (crm section 4).

### Jobs (`jobs.ts`, `defineJob`)

| Kind | Lane, priority | Key | Attempts and errors | Does |
| --- | --- | --- | --- | --- |
| `email.send` | fast, 1 (transactional) or 5 | `email:<message_id>` | 6, standard backoff; `IntegrationError.retryable=false` (Resend 4xx except 429) → `PermanentError` → status `failed`; 429 and 5xx retry; `unknown_template`, `invalid_template_data`, `no_recipient`, `attachment_too_large`, `email_sink_missing` → `PermanentError` | rules 39-44 and 59: skip unless `queued`, registry and Zod check, final check, render, sink, `ResendClient.sendEmail()` with `Idempotency-Key: email:<message_id>`, status `sent`, `email.sent` event. Wave 0's working handler (platform-P7) is taken over and replaced by email-P3 behind the same kind, key and payload |
| `campaign.plan` | bulk, 9 | `campaign:<id>:plan:<version>` (the campaign `version` written by the schedule action; an integer counter, never a timestamp, cross-module convention 5) | 3; failure → campaign `draft` with `last_error` | rule 27 in one transaction (`crm.refreshSegment`, `insert ... select`) |
| `campaign.send_chunk` | bulk, 9 | `campaign:<id>:chunk:<n>:r<run_no>` (warm-up continuation adds `:d<YYYY-MM-DD>`) | 6; per-recipient render errors mark that recipient `failed` and continue | rules 32-37 |
| `email.retry_soft_bounce` | fast, 5 | `email:<message_id>:retry` | 3 | rule 49, run at `bounced_at + 1 h` |
| `email.freeze_campaign_stats` | bulk, 9 | `campaign:<id>:freeze` | 3 | rule 62 |
| `ai.draft_email` (R4) | fast, 5 | `ai:draft:<draft_id>` | 2; budget exhaustion → draft `failed` reason `budget` | section 6, Claude |

There is no email job for provider-side erasure: ops' `privacy.erase_external` calls `ResendClient.deleteContact(email)` (this module's client) before any local erasure step (decision 51). Resend events are not a separate job: `processResendEvent(ctx, { id, payload })` (rules 46-49 and 37) is the `handle` of the `defineWebhookHandler({ provider: 'resend' })` registration in `jobs.ts` and runs inside platform's `webhook.process` job transaction. Every handler is idempotent: running it twice with the same payload leaves the same state (`jobs.test.ts`, with platform's `runJobTwice`).

### Schedules (`schedules.ts`, cron in Europe/Brussels)

| Schedule kind | Cron | Does |
| --- | --- | --- |
| `email.dispatch_due_campaigns` | `* * * * *` | rule 31 for campaigns with `status = 'scheduled' and scheduled_at <= now()` |
| `email.watch_complaints` | `*/15 * * * *` | rule 38; also re-evaluates rule 37 for campaigns `sending` |
| `email.check_domains` | `10 5 * * *` | `ResendClient.getDomain()` for both domains; any record not `verified` → Slack alert (High) |
| `email.freeze_due_stats` | `40 4 * * *` | enqueues `email.freeze_campaign_stats` for campaigns finished 30 days ago without snapshot |
| `email.purge_props` | `20 2 * * *` | sets `props = null` on messages sent more than 30 days ago (batches of 5,000) |
| `email.watch_delivery` | `*/5 * * * *` | rule 38a |

### Activity event kinds (`events.ts`)

`email.sent`, `email.opened`, `email.clicked`, `email.bounced`, `email.complained`, `email.blocked`, declared with `defineEvent` in `events.ts`. All `is_sensitive = false`, `ref_type = 'email_message'`, `ref_id = message id`. `email.opened` and `email.clicked` are available as automation triggers.

### Cross-module API (`apps/web/modules/email/api.ts`)

`sendTransactional` keeps the exact Wave 0 stub signature of platform section 4.9 (`template`, `personId?`, `to?`, `locale`, `data`, `key` → `{ emailMessageId, jobId }`); the optional fields after `key` are additive and requested from platform for the stub (section 13, decision 6).

```ts
export type Locale = 'nl-BE' | 'fr-BE' | 'en';
export type MarketingPurpose = 'newsletter' | 'events' | 'member_comms' | 'b2b';
export type TransactionalTemplateKey = keyof typeof TEMPLATE_REGISTRY; // '<module>.<name>', e.g. 'booking.booking_confirmed', 'commerce.order_confirmation'

export function sendTransactional(ctx: Ctx, input: {
  template: string;                 // a TransactionalTemplateKey or the slug of a block-backed transactional template
  personId?: string; to?: string;   // at least one; `to` wins over the person's email (company billing address, guest)
  locale: Locale; data: Record<string, unknown>; key: string;           // `key` is the message idempotency key
  attachments?: { fileId: string; filename: string; inline?: boolean }[];
  context?: Record<string, string>; // ids for merge fields
  sendAt?: Date; replyTo?: string; headers?: { 'In-Reply-To'?: string; References?: string };
}): Promise<{ emailMessageId: string; jobId: string }>;

export type AutomationEmailInput = {
  templateSlug: string; personId: string; enrolmentId: string; idempotencyKey: string;   // key: automation:<enrolment_id>:<step_key>
  context?: Record<string, string>; stepKey?: string;                                     // optional, rule 39a
};
export type AutomationEmailResult = {
  messageId: string; status: 'queued' | 'skipped_unreachable' | 'skipped_translation'; created: boolean; templateVersionId: string;
};
export function queueMarketingEmail(ctx: Ctx, input: AutomationEmailInput): Promise<AutomationEmailResult>;   // marketing templates
export function queueAutomationEmail(ctx: Ctx, input: AutomationEmailInput): Promise<AutomationEmailResult>;  // transactional templates

export type TemplateInfo = { templateVersionId: string; kind: 'transactional' | 'marketing'; purpose: MarketingPurpose | null; locales: Locale[] };
export function getTemplateInfo(db: DbOrTx, slug: string): Promise<TemplateInfo | null>;                 // current published version
export function getPublishedTemplateInfo(db: DbOrTx, slugs: string[]): Promise<Map<string, TemplateInfo>>;  // batch form
export function resolveLinkToken(db: DbOrTx, token: string):                                              // crm preference and unsubscribe routes
  Promise<{ emailMessageId: string; personId: string; purpose: MarketingPurpose | null; locale: Locale; sentAt: Date } | null>;
export function listPublishedTemplates(db: DbOrTx, q?: string):
  Promise<{ slug: string; name: string; kind: 'transactional' | 'marketing'; purpose: MarketingPurpose | null; locales: Locale[] }[]>;
export function seedTemplate(tx: Tx, input: SeedTemplateInput): Promise<{ templateId: string; created: boolean }>;
// SeedTemplateInput = { slug; name; kind; purpose: MarketingPurpose | null; subject: LocalizedText; preheader: LocalizedText; document: BlockDocument }
// creates the template and a published version 1 when the slug is absent; never touches an existing slug.

export function getReachability(tx: DbOrTx, personId: string, purpose: MarketingPurpose):
  Promise<{ isReachable: boolean; blockedReason: 'erased' | 'no_email' | 'restricted' | 'suppressed' | 'withdrawn' | 'no_consent' | null }>;
export function findLatestMessage(db: DbOrTx, input: { personId: string; templateSlug: string; after: Date }):   // R2, commerce
  Promise<{ emailMessageId: string; status: MessageStatus; sentAt: Date | null; clickedAt: Date | null } | null>;
export function cancelScheduledMessage(ctx: Ctx, input: { messageId: string }): Promise<{ cancelled: boolean }>;
export function isSegmentInUse(db: DbOrTx, segmentId: string): Promise<boolean>;   // crm archive guard: campaigns not terminal using it as segment or exclusion
export function listPersonEmails(db: DbOrTx, personId: string, page?: number):
  Promise<{ items: PersonEmailRow[]; nextPage: number | null }>;
export function getCampaignStats(db: DbOrTx, campaignIds: string[]): Promise<CampaignStats[]>;
export function countBlockedMessages(db: DbOrTx, since: Date): Promise<number>;           // ops daily digest
export function getEmailHealth(db: DbOrTx): Promise<{ oldestQueuedMinutes: number | null; deadSends15m: number; sent60m: number; failed5m: number; blockedTranslation5m: number }>;
export function getCampaignAttribution(db: DbOrTx, input: { from: Date; to: Date }):     // R3, ops dashboards
  Promise<{ campaignId: string | null; automationId: string | null; name: string; orders: number; revenueCents: number; firstPurchases: number }[]>;
```

`sendTransactional`, `queueMarketingEmail` and `queueAutomationEmail` only write rows and enqueue inside the caller's transaction (`ctx.tx`); they never call Resend. The two queue functions are what `automation.step` calls after its own checks (automation rule A-31, rule 39a); `created` is false when the idempotency key already existed. `resolveLinkToken` reads only `email_messages` (sha256 of the token on the unique `link_token_hash` index), returns null for test sends, unknown or erased rows, and never writes. Resend events are handled by the `defineWebhookHandler` registration, not by an exported function.

`R4` output schema of `ai.draft_email` (`AiCampaignDraft`, Zod in `packages/core/src/email/ai.ts`): `{ subject: LocalizedText, preheader: LocalizedText, document: BlockDocument, segment: { segmentId: string | null, description: string }, suggestedSendAt: string (ISO), timingRationale: string, notes: string }`, all three locales required.

## 5. Screens

All admin screens use `packages/ui` (`DataTable`, `LocalizedInput`), show a skeleton while loading, and render errors as an inline alert with the `requestId` and a Retry button. Navigation entries (`nav.ts`): "Email" group with Overview, Campaigns, Templates, Messages, shown when the user has `email.write` or `reports.read`.

| Route | Shows | Actions | Empty state | Who |
| --- | --- | --- | --- | --- |
| `/admin/email` | KPI tiles for the last 30 days (sent, delivered %, open rate, click rate, hard bounce %, complaint %, unsubscribes); domain status for `mail.beam.be` and `news.beam.be` (SPF, DKIM, DMARC, last check); warm-up week, today's cap and sent count; complaint banner (rule 38) and delivery banner (rule 38a); blocked-translation messages; last 20 suppressions added (email masked `j***@gmail.com`) | Open blocked message; link "Add manual suppression" to crm's suppression screen (crm's `addManualSuppression`) | "No email sent yet" with links to Templates and Campaigns | `email.write` or `reports.read` |
| `/admin/campaigns` | Table: name, status badge, purpose, segment, scheduled or sent date, recipients, open rate, click rate | New campaign, filter by status, search, duplicate | "No campaigns yet. Create your first campaign" | `email.write` or `reports.read` (read-only) |
| `/admin/campaigns/new` | Name, purpose, start from blank or an existing marketing template; R4 tab "Draft with AI" (brief, events, segment hint) | Create, Request AI draft | | `email.write` (AI tab also `ai.use`) |
| `/admin/campaigns/[id]` | Stepper: Content (block editor of the campaign template, section below), Audience (segment picker, exclusion segments, live estimate with per-locale counts and blocked reasons), Review (completeness per locale, footer check, test send panel, preview switcher), Schedule (date and time in Brussels, Send now), then Report once sending | Save, test send, schedule, unschedule, refresh audience, pause, resume, stop, cancel, duplicate | Audience: "Pick a segment"; Review lists every blocking check with a link to fix it | edit `email.write`; schedule and controls `campaigns.send` (buttons hidden and server-refused otherwise) |
| `/admin/campaigns/[id]/recipients` | Paginated recipients (50): name, masked email, locale, status, chunk, message status; filters by status; search by name or email | Remove, restore (in `scheduled` or `paused`) | "Audience not prepared yet" | `campaigns.send` for actions, `email.write` to view |
| `/admin/campaigns/[id]/report` | `v_campaign_stats` tiles and rates, timeline of sends per 15 minutes, clicks per link, per-locale table, bounces and complaints list, R3 revenue, orders and first purchases | Export CSV (ids, status, open and click times; `reports.read`) | "No data yet, sending starts at <time>" | `email.write` or `reports.read` |
| `/admin/templates` | Tabs Transactional and Marketing: name, slug, status, current version, locales badges, last published | New marketing template, duplicate, archive; filter by owning module (transactional) | "No marketing templates yet" | `email.write` |
| `/admin/templates/[id]` | Marketing: three-pane block editor (block palette, canvas per locale tab with completeness badge, inspector for the selected block); token and merge-field picker; accessibility warnings (rule 15b) per block; dynamic block editor with variant list. Transactional: list of copy slots per locale with `LocalizedInput`, live preview of the react-email component with sample props | Save draft (autosave every 10 s), publish (`email.send`), preview, test send, version history (read-only previous versions) | | `email.write`; publish `email.send` |
| `/admin/templates/[id]/preview` | Desktop (600 px) and mobile (375 px) frames, HTML and plain-text tabs, subject and preheader, size warning, "Preview as": a person search (real contact), Lead, Customer, Member, assessment outcome picker | Switch locale, switch persona | "Select a person or a sample" | `email.write`; real contact also `persons.read` |
| `/admin/email/messages` | Message log: time, recipient (masked unless `persons.read`), template, kind, status, campaign; filters | Open message | "No messages match" | `email.write` |
| `/admin/email/messages/[id]` | Message detail: headers summary, status history from `email_events`, rendered HTML (non-production from `rendered_file_id`; production re-rendered from the version and props while props exist) | Resend (transactional, `persons.write`) | | `email.write` |
| Person page tab "Emails" (rendered by `crm`'s `/admin/persons/[id]`, component `PersonEmailHistory` from `apps/web/modules/email/ui/`) | Every message to the person with campaign or automation name, status, opened and clicked times; reachability per purpose with reason | Resend transactional (`persons.write`), open message | "No emails sent to this person" | `persons.read` |
| `/[locale]/preferences/[token]` and `/[locale]/account/preferences` | Owned by crm (crm section 5). This module only links to them (footer, header, tokens) and reuses nothing else | | | |

Loading states: the block editor shows the canvas skeleton and disables Publish until the draft loads; previews show a spinner inside the frame; estimates show "counting..." and time out after 10 s with "Estimate unavailable, try again". Error states: publish validation lists `locale: block path: problem` items and scrolls to the first; a version conflict shows "Someone else changed this; reload" with a diff count.

## 6. Integrations

**Resend** (`packages/integrations/src/resend/client.ts` and `fake.ts`), EU region (`eu-west-1`), API key `RESEND_API_KEY`, webhook secret `RESEND_WEBHOOK_SECRET`.

Wave 0 (platform-P3) ships this client with `sendEmail` only; email-P1 takes the files over and completes them, keeping `sendEmail`'s name and its Wave 0 fields (a superset), so Wave 0's `email.send` keeps working until email-P3 replaces it.

```ts
export interface ResendClient {
  sendEmail(msg: OutgoingEmail & { idempotencyKey: string }): Promise<{ id: string }>;
  sendBatch(msgs: OutgoingEmail[] /* 1..100, no attachments */, opts: { idempotencyKey: string }): Promise<{ ids: string[] }>;
  getDomain(name: 'mail.beam.be' | 'news.beam.be'): Promise<{ status: 'verified' | 'pending' | 'failed' | 'not_started'; records: { type: string; name: string; status: string }[] }>;
  deleteContact(email: string): Promise<{ deleted: boolean }>;   // called only by ops' privacy.erase_external; 404 → { deleted: false }
}
export type OutgoingEmail = { from: string; to: string; replyTo: string; subject: string; html: string; text: string;
  headers: Record<string, string>; tags: { name: string; value: string }[]; attachments?: { filename: string; content: Buffer }[] };
export function verifyResendWebhook(input: { id: string; timestamp: string; signature: string; body: string; secret: string; now: Date }): boolean;
// adapter for platform's handleWebhook({ verify }): reads svix-id, svix-timestamp, svix-signature from headers
export function resendWebhookVerifier(secret: string): (raw: string, headers: Headers) => Promise<{ ok: true; externalEventId: string; payload: unknown } | { ok: false }>;
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

**Claude (R4)** through platform's AI gateway `callClaude(ctx, { feature: 'email.draft_email', model: 'opus', system, messages, fieldsSent, outputSchema: AiCampaignDraftSchema })` (`ai_requests` row, budget, allow-list, feature register entry `ai.draft_email`). Job `ai.draft_email` (the architecture's job kind, registered in this module's `jobs.ts`), model `claude-opus-5-5`, structured output `AiCampaignDraft`. Input context, all non-personal: `settings.email_brand` (`tone_of_voice`, `guidelines`, `do_not_say`, sample phrases per locale), the subjects, preheaders and plain text (`nl-BE`) of the last 5 sent campaigns of the same purpose with their open and click rates, event info from `booking.getSessionCards()` for the chosen sessions, segment names and counts from `crm` (no members) plus, for the chosen segment, aggregate CRM data only: count per status (lead, customer, member), per locale, and the median days since last visit (the blueprint's "CRM data" and "Customer segment"; no row-level data), purpose and locale list. `fields_sent` lists exactly these keys. Failure: draft `failed` with the error code; the UI shows "AI unavailable, write manually". Humans approve: acceptance only creates a draft campaign.

**Slack** through platform's `notifySlack(ctx, { fingerprint, severity, text })` for auto-pause, complaint, delivery-watch and domain alerts (platform deduplicates per fingerprint per hour).

**Resend Inbound (R3)** for crm's unified inbox: MX of `in.beam.be` points to Resend inbound (`inbound-smtp.eu-west-1.amazonaws.com`, priority 10, added to the DNS runbook in email-P9); `hello@beam.be` forwards to `inbox@in.beam.be` in Google Workspace. Inbound events arrive on the same webhook and secret; the handler maps the payload to crm's input (rule 46) and calls `crm.ingestInboundEmail(tx, ctx, { messageId, inReplyTo?, from, fromName?, subject, text, attachmentCount, receivedAt })` (returns `{ threadId }`; cross-module D10), and never stores the body in `email_*` tables.

## 7. Permissions and audit

Permissions declared in `apps/web/modules/email/permissions.ts`: `email.write`, `email.send`, `campaigns.send` (strings from the architecture; no new ones).

| Permission | Allows | Default roles |
| --- | --- | --- |
| `email.write` | create and edit templates and campaign drafts, upload images (platform's `uploadImage` accepts `email.write`), preview, test sends to staff addresses, view message log, request and accept AI drafts (with `ai.use`) | owner, technical_admin, management, marketing, customer_service |
| `email.send` | publish template versions (they go live in automations and transactional sends), archive templates, cancel a scheduled message | owner, technical_admin, management, marketing |
| `persons.write` (crm) | resend a transactional message to the person's current address (reception desk flow) | per architecture: customer_service, sales, reception, management, owner, technical_admin |
| `campaigns.send` | schedule, unschedule, refresh audience, remove and restore recipients, pause, resume, stop, cancel campaigns | owner, technical_admin, management, marketing |
| `persons.read` (crm) | preview as a real contact, see unmasked addresses | per crm |
| `reports.read` (ops) | read campaign reports and `/admin/email` overview without editing | per architecture |
| `ai.use` (platform) | R4 AI drafts | sales, marketing, owner, management, technical_admin |

Audited actions (`audit_log.action`, entity type in brackets): `email.template_create`, `email.template_publish`, `email.template_archive` (`email_template`); `email.campaign_create`, `email.campaign_update`, `email.campaign_schedule`, `email.campaign_unschedule`, `email.campaign_refresh`, `email.campaign_pause`, `email.campaign_resume`, `email.campaign_stop`, `email.campaign_cancel` (`campaign`, old and new status); `email.recipient_remove`, `email.recipient_restore` (`campaign_recipient`, with `person_id`); `email.test_send` (`campaign` or `email_template`); `email.message_resend`, `email.message_cancel` (`email_message`); `email.campaign_auto_pause` (actor system). Suppression and preference changes are audited by crm; `email.ai_draft_request`, `email.ai_draft_accept`, `email.ai_draft_discard` (`email_ai_draft`). `permissions.test.ts` asserts each staff action refuses without its permission.

## 8. Multi-language and content

- Catalogue namespace `email` in `packages/core/src/i18n/messages/{nl-BE,fr-BE,en}/email.json`, keys `email.<screen>.<element>`: admin screens (`email.campaigns.*`, `email.templates.*`, `email.editor.*`, `email.preview.*`, `email.report.*`, `email.deliverability.*`, `email.messages.*`), footer strings (`email.footer.*`: commercial-message sentence, link labels "Manage preferences" and "Unsubscribe from {category}", company line labels), category names used in footers and reports (`email.categories.newsletter|events|member_comms|b2b`), the shell strings of the marketing layout, and accessibility warnings (`email.a11y.*`). Transactional copy is not here: each owning module keeps it in its own catalogue under `<m>.email.<name>.<slot>` (for example `platform.email.magic_link.*`, `credits.email.membership_started.*`, `finance.email.invoice_reminder.*`; never in `email.json`); the preference-centre wording is crm's. `en` is the source; `pnpm i18n:check` enforces parity.
- `LocalizedText` content fields: `email_template_versions.subject`, `preheader`, every `copy` slot, every text field inside the block document per locale (heading text, text markdown, image alt, button label, product and event CTA labels, token fallbacks), `settings.email_footer.reasons.*`, `settings.email_footer.rpr`, `settings.email_brand.sample_phrases`.
- Seed: the copy slots of every registry template are seeded from the owning module's `<m>.email.<name>.<slot>` keys into version 1 of its system template, so copy is editable by staff afterwards without a deploy; later catalogue changes never overwrite edited copy.
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
  sweep: { 'email.email_messages': (tx, cutoff) => ..., 'email.email_events': ..., 'email.campaign_recipients': ..., 'email.email_ai_drafts': ... },  // rows deleted; keys = retention_policies.key
};
```

| Table | Person data | Export includes | Erase does | Why |
| --- | --- | --- | --- | --- |
| `email_messages` | `person_id`, `to_email`, `subject`, `props`, tokens | every message: date, template name, kind, purpose, subject, status, opened and clicked times | **delete** the person's rows (cascades `email_events`; `campaign_recipients.email_message_id` set null first) | no legal duty to keep email logs; campaign totals survive in `stats_snapshot` or are recomputed without the person |
| `email_events` | via message | type and time per message | deleted by cascade under `beam.allow_rewrite` | append-only, erased only by the erasure job |
| `campaign_recipients` | `person_id` | campaign name, status | **delete** | same |
| `campaigns`, `email_templates`, `email_template_versions` | none (staff user ids only) | not included | nothing | `NO_PII_TABLES` for persons; staff user references follow platform's user erasure |
| `email_ai_drafts` | none | not included | nothing | aggregates only by construction |
| Resend | delivery logs (30 days) | not exportable via API; the export report states it | nothing here: ops' `privacy.erase_external` calls `ResendClient.deleteContact(email)` before the local steps | subprocessor register |

Suppressions are crm's table: erasure keeps `suppressions.email_hash` with reason `erased` (crm), which `email.send` honours. Retention policies seeded by `email`'s `seed.ts` into `retention_policies` and enforced by `ops`' `privacy.retention_sweep` through the `sweep` functions above (each deletes in batches of 5,000 under `SET LOCAL beam.allow_rewrite = 'on'` for the APPEND table `email_events`). Keys follow cross-module convention 4 (`<m>.<table>`, D37) and every row is inserted `on conflict (key) do nothing`: `email.email_events` 730 days delete; `email.email_messages` 730 days delete (only rows whose campaign has `stats_snapshot` or that have no campaign); `email.campaign_recipients` 730 days after the campaign's `finished_at` delete; `email.email_ai_drafts` 365 days delete; `props` nulled after 30 days (schedule `email.purge_props`, not a retention policy). Files of kind `rendered_email` (30 days, `platform.files_rendered_email`) and `webhook_events` holding Resend payloads (90 days, `platform.webhook_events`, plus deletion of the subject's rows at erasure) are platform's policies. Erasure order: ops' external step (Resend `deleteContact`) runs first while the address is still known; then `email` erases before `automation` (which reads `email_messages.enrolment_id`) and before `crm` anonymises `persons`. Erased message rows take their link tokens with them, so `resolveLinkToken` returns null for them. Sensitive columns: none in this module; `EMAIL_TOKENS` and the AI context exclude every `SENSITIVE_COLUMNS` member (tests). Tracking stores no IP addresses and only a user-agent family (`apple_mpp`, `gmail_proxy`, `other`) so opens from privacy proxies can be shown separately.

## 10. Dependencies

**Needs from other modules**

| Module | What | Used for |
| --- | --- | --- |
| platform | `action()`, `defineJob`, `defineSchedule`, `defineEvent`, `defineWebhookHandler`, `handleWebhook`, `enqueue`, `runJobs`, `recordEvent`, `audit`, `getSetting(tx, key)`, `storeFile(ctx, {...})`, `readFile(tx, id)`, `uploadImage` action, `callClaude()` (R4), `notifySlack()`, `rateLimit()`, `requirePermission`, `runJobTwice` and `makeCtx` test helpers, the Resend `fake.ts`, tables `settings`, `files`, `webhook_events`, `integration_calls`, `users`; generator support in `pnpm gen:indexes` for `packages/email/src/templates/*/index.ts` → `templates/registry.generated.ts` and `modules/*/merge-fields.ts` → `registry/merge-fields.generated.ts` | everything |
| crm | `addSuppression(tx, ctx, { email, scope, reason, source, personId? }): Promise<{ suppressionId; created }>` (also calls `automation.requestSuppressionExit`; for `complaint` also withdraws every marketing purpose), `isSuppressed(tx, email, purpose)`, `buildPreferenceUrls(linkToken, locale): { unsubscribeUrl; oneClickPostUrl; preferencesUrl }`, `refreshSegment(tx, ctx, segmentId, 'campaign')`, `segmentAudienceSql(segmentId, excludeSegmentIds)`, `getSegmentRef(tx, segmentId)`, `getSegmentSummaries(tx)` (R4), `createTask(tx, ctx, { ..., ref: { type, id } })`, `ingestInboundEmail(tx, ctx, { messageId, inReplyTo?, from, fromName?, subject, text, attachmentCount, receivedAt })` (R3), `emailHash()` from `@beam/core/crm`; tables `persons`, `segments`, `segment_members`, `suppressions`; views `v_consent_current`, `v_suppression_status`; the one-click route, preference centre and portal preferences pages | reachability, campaigns, headers and footers, alerts, inbox |
| credits | views `v_person_status`, `v_person_credits`; table `memberships` | dynamic blocks, tokens, `member_comms` reachability |
| booking | `booking.getSessionCards(tx, sessionIds, locale): Promise<SessionCard[]>`, `booking.getNextBooking(tx, personId): Promise<{ startsAt: Date } | null>` | `event` block, tokens, R4 context |
| commerce | `commerce.getProductCards(tx, productIds, locale): Promise<ProductCard[]>`; table `orders` (R3 view) | `product` block, attribution |
| forms | `forms.listLatestOutcomes(tx, personIds: string[], formSlug: string): Promise<Map<string, string>>` | `dynamic` assessment-outcome variant |
| automation | `isTemplateInUse(tx, slug): Promise<boolean>` (archive guard); `automation_enrolments.context` (read); the `automation.step` caller of `queueMarketingEmail` and `queueAutomationEmail` (passing `context` and `stepKey`) and the `pauseAutomation` control (blueprint 30 "Pause automation") | archive guard, merge fields, pre-send controls |
| ops | `privacy.erase_external` calls this module's `ResendClient.deleteContact` | provider-side erasure |
| site | `getLegalLinks(locale): Promise<{ privacy; terms; cookies }>`, `getEventPageUrl(db, sessionId, locale)` | legal footer, `event` block links |
| webinar (R2) | `getWebinarCards(tx, ids, locale)`; merge fields `webinar.title`, `webinar.starts_at_local`, `webinar.access_url` in `modules/webinar/merge-fields.ts` | `webinar` block, reminder templates |
| ops (retention) | `retention_policies` table (rows seeded by email), `privacy.retention_sweep` | retention |

**Provides to other modules**

- `sendTransactional()` for every module's registered templates. Each module owns `packages/email/src/templates/<m>/` (files, props schemas, components) and its copy catalogue; keys are `<m>.<name>` (`<name>` = file basename with `-` replaced by `_`; one file is one key). The registry, and therefore `email`'s seed (one editable system row per key), contains exactly these keys (cross-module D2; variants in brackets are `props.variant`, not keys):
  - platform: `platform.magic_link`, `platform.staff_invite`, `platform.password_reset`, `platform.mfa_changed`, `platform.monthly_report`;
  - crm: `crm.confirm_resubscribe`, `crm.preference_link`, R3 `crm.inbox_reply`;
  - booking (12): `booking.booking_confirmed`, `booking.booking_rescheduled`, `booking.seat_claimed`, `booking.guest_invited`, `booking.booking_cancelled`, `booking.booking_late_cancelled`, `booking.session_cancelled`, `booking.booking_reminder`, `booking.waitlist_joined`, `booking.seat_offered`, `booking.offer_expired`, R2 `booking.lead_window_open`; the QR code is an inline attachment `checkin-qr.png` shown as `cid:checkin-qr.png`;
  - commerce (8): `commerce.order_confirmation`, `commerce.pos_receipt`, `commerce.payment_failed`, `commerce.payment_link`, `commerce.gift_voucher` (with `sendAt`), `commerce.refund_confirmation`, `commerce.portal_invitation`, R2 `commerce.checkout_recovery` (declares `loadProps`; automation sends it through `queueMarketingEmail` as a marketing message, rule 39a, cross-module D54);
  - credits (8): `credits.membership_started`, `credits.membership_renewal_reminder`, `credits.membership_renewed`, `credits.membership_payment_failed`, `credits.membership_expired`, `credits.membership_cancel_confirmed`, R2 `credits.share_invitation`, R3 `credits.referral_reward`;
  - finance: `finance.invoice`, `finance.credit_note`, `finance.invoice_reminder`, `finance.company_request_decided` (PDF attachments on the first three; props including `isCourtesyCopy`, `decision`, `note` are finance's schemas);
  - forms: `forms.result` (props `FormResultProps` from `@beam/core/forms`, including `pendingConfirmation`), `forms.result_link` (props `FormResultLinkProps`);
  - ops: `ops.privacy_export_ready`, `ops.privacy_erasure_scheduled`;
  - R2 webinar: `webinar.access`, `webinar.reminder` (`d7|d3|h3` from `stepKey`, declares `loadProps` for automation), `webinar.rescheduled`, `webinar.cancelled`, `webinar.replay_available` (declares `loadProps`), plus webinar's marketing seed `webinar-follow-up` through `seedTemplate()`.
  A key used before its owner registers it is still accepted by `sendTransactional` and fails at `email.send` with `unknown_template` (rule 39), so callers' tests never depend on another module's template landing. `defineTemplate()` and its `TemplateDef` type come from `@beam/email/templates/define`.
- `queueMarketingEmail()`, `queueAutomationEmail()`, `getTemplateInfo()`, `getPublishedTemplateInfo()`, `listPublishedTemplates()`, `seedTemplate()` and `getReachability()` to `automation` (and `seedTemplate()` to `webinar`).
- `resolveLinkToken()` to `crm` for its unsubscribe and preference routes.
- `findLatestMessage()` (R2) and `cancelScheduledMessage()` to `commerce`; `isSegmentInUse()` to `crm`.
- `listPersonEmails()` and the `PersonEmailHistory` component to `crm`'s person page; `email.*` activity events to the timeline and as automation triggers (`email.opened`, `email.clicked`).
- `getCampaignStats()`, `countBlockedMessages()`, `getEmailHealth()`, `getCampaignAttribution()` (R3) and views `v_campaign_stats`, `v_email_attribution` to `ops`.
- `v_marketing_reachability` to `automation`, `crm` (person page) and `ops` (management counts).
- The Resend webhook route and its handler, which dispatch R3 inbound mail to `crm`.
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
| 13 | Person has no email | not inserted at snapshot (`no_email`); a `sendTransactional` with no `to` and no person email writes the message, and `email.send` marks it `failed` with `no_recipient` (dead job alert); the caller's transaction is never rolled back |
| 14 | Tracking token used after 365 days | the open pixel still returns the GIF and the click still redirects to `links[i]`, but no event is recorded; the same token keeps unsubscribing through crm while the message row exists (730 days), and after retention deletes the row `resolveLinkToken` returns null and crm offers "email me a fresh link" (crm decision 17) |
| 15 | Mail scanner pre-fetches the one-click URL with GET or follows tracked links | crm's GET writes nothing; clicks from scanners within 2 seconds of delivery with `ua_family = 'other'` are still recorded (no reliable signal), which the report notes beside the click rate |
| 16 | Apple Mail Privacy Protection opens every email | opens with `ua_family = apple_mpp` are counted but the report shows "of which privacy-proxy opens"; clicks are the reliable metric |
| 17 | `EMAIL_SINK` missing on a preview deployment | `email.send` fails permanently with `email_sink_missing`; nothing leaves; System page shows dead jobs |
| 18 | Resend returns 422 for an invalid recipient address | `PermanentError`; message `failed` with `error = 'invalid_recipient'`; campaign recipient `failed`; no suppression (address may be fixed in crm) |
| 19 | Product in a `product` block deactivated after scheduling | the block renders nothing for later chunks; earlier recipients already got it |
| 20 | Erasure while a campaign is sending to that person | erasure deletes recipient and message rows under `allow_rewrite`; the chunk finds no recipient row and skips; `persons.erased_at` blocks any later `email.send` |
| 21 | Magic link requested by someone whose address hard-bounced | not sent: the hard-bounce suppression blocks it (rule 40 exempts only complaints for `platform.magic_link`, `platform.password_reset`, `platform.mfa_changed` and `ops.privacy_erasure_scheduled`); the login page says "We could not deliver to this address; contact BEAM" after the job sets `suppressed` |
| 22 | A transactional template's copy is edited and republished while messages are queued | queued messages keep the `template_version_id` they were created with; new messages use the new current version |
| 23 | Campaign `scheduled_at` passes while the tick is down | `email.dispatch_due_campaigns` picks it up at the next tick; the report shows actual `started_at` |
| 24 | Click tracking link index out of range or token forged | 302 to the BEAM home page for the locale; nothing recorded |
| 25 | A gift voucher email is scheduled for a birthday in 3 weeks and the order is refunded | commerce calls `cancelScheduledMessage`; the queued message becomes `failed` with `cancelled`; the job then finds it not `queued` and succeeds without sending |
| 26 | Resend is down for 40 minutes | `email.send` jobs back off (60 s, 300 s, 900 s, 3600 s); after 10 minutes the delivery watch posts a High alert (proposal SLA "emails not sending"); when Resend recovers the queued messages leave in order of priority; campaign chunks retry their batch with the same `Idempotency-Key` |
| 27 | A module's template is called with data that no longer matches its Zod schema (deploy mismatch) | the message row is written; `email.send` marks it `failed` with `invalid_template_data` and the job goes `dead` with one Slack line; the booking or payment that triggered it stays committed; staff use "Resend" after the fix |
| 28 | Two staff press Schedule at the same moment | both send `expectedVersion`; the second gets `conflict`; only one `campaign.plan` job exists (key includes the campaign version written by the winning schedule) |
| 29 | Campaign scheduled for Easter Monday at 07:00 | rule 26 warning "outside the usual send window: public holiday, before 08:00"; scheduling succeeds only with `confirmOutsideWindow: true` |
| 30 | A person changes their email address in crm after a campaign snapshot | the chunk renders to the current `persons.email` (read per batch), and the suppression check uses the current `email_hash` |

## 12. Build packages

Order and sharing: the packages run strictly in the order P1 → P10. P1 and P2 touch only `packages/*`. From P3 on, the module barrel files `apps/web/modules/email/{actions,queries,jobs,schedules,events,api,nav,permissions,privacy,seed,config}.ts` (all created by Wave 0 as compiling stubs), `packages/core/src/email/inputs.ts`, `packages/core/src/i18n/messages/*/email.json` and `packages/db/src/seed/email.ts` are edited by several packages; those packages are strictly sequential (each starts from the merged result of the previous one). No package edits `package.json`, the lockfile, migrations, `registry/*.generated.ts`, `packages/email/src/templates/registry.generated.ts` or another module's template folder. The two `pnpm gen:indexes` collectors (platform-owned `apps/web/scripts/gen-indexes.ts`) for `packages/email/src/templates/*/index.ts` and `apps/web/modules/*/merge-fields.ts` are part of platform-P1 (Wave 0, cross-module D6); no orchestrator step is needed before Wave 1, and P2 and P3 rely on them as merged. P1 to P7 form one Wave 1 chain plus Wave 2 seams; P4 waits for crm-P3. Every package ends with: `pnpm typecheck`, `pnpm lint`, its Vitest suites green (integration tests on `createTestDb()` and the shared factories, Resend through `fake.ts`), `pnpm i18n:check` when it adds keys.

### email-P1 (V1): schema, core logic and Resend client

- **Goal**: every email table and enum, the pure domain logic, and the Resend client with its fake.
- **Files**: edit `packages/db/src/schema/email.ts` (complete the Wave 0 stubs `email_templates`, `email_messages`; add `email_template_versions`, `campaigns`, `campaign_recipients`, `email_events`, `email_ai_drafts` and all enums of section 2; add `email_events` to the module's `APPEND_ONLY_TABLES` export); create `packages/core/src/email/{blocks.ts,tokens.ts,completeness.ts,versions.ts,campaign-state.ts,message-status.ts,warmup.ts,send-window.ts,links.ts,reachability.ts,inputs.ts}` and edit Wave 0's `packages/core/src/email/{index.ts,types.ts}`; edit Wave 0's `packages/integrations/src/resend/{client.ts,fake.ts}` (platform-P3 wrote them with `sendEmail` only; this package takes them over, keeps `sendEmail` and adds `sendBatch`, `getDomain`, `deleteContact` and the full fake) and create `packages/integrations/src/resend/{webhook.ts,types.ts}`.
- **Interfaces**: `BlockDocumentSchema`, `BlockSchema` (Zod, rules 16-20); `validateDocument(doc): { ok: true } | { ok: false; issues: DocIssue[] }`; `EMAIL_TOKENS: readonly TokenKey[]`; `parseTokens(text): TokenUse[]`; `templateCompleteness(version, locales): { locale; missing: string[] }[]`; `assertDraftVersion(row): void`; `canTransition(from: CampaignStatus, to: CampaignStatus): boolean`; `nextMessageStatus(current, eventType): MessageStatus`; `warmupCap(schedule, day: Date): number | null`; `newLinkToken(): { token: string; hash: string }`, `hashLinkToken(token): string`; `resolveReachability(input: { erased; hasEmail; restricted; isSuppressed; consentStatus: 'granted' | 'withdrawn' | null }): BlockedReason | null` (mirrors the view's `case`); `belgianPublicHolidays(year): string[]` (ISO dates), `sendWindowWarnings(at: Date): ('before_8'|'after_21'|'sunday'|'public_holiday')[]`; `ResendClient`, `createResendClient(opts)`, `createFakeResendClient()`, `verifyResendWebhook()` (section 6).
- **Depends on**: Wave 0 (`_shared.ts`, contract tables `persons`, `users`, `files`, `ai_requests`).
- **Tests**: `packages/core/src/email/blocks.test.ts` (valid document, nesting rules, 200-block and 256 KB limits, image alt required, button URL scheme); `tokens.test.ts` (parse, fallback syntax, unknown token, no sensitive column in `EMAIL_TOKENS`); `completeness.test.ts` (missing subject per locale, missing block text, transactional slots); `campaign-state.test.ts` (every allowed and every refused transition of rule 25); `message-status.test.ts` (rank order, out-of-order events, complaint after bounce); `campaign-state.test.ts` also covers `paused → sent` and refuses every move out of `sent`, `stopped`, `cancelled`; `warmup.test.ts` (weeks 0-3 caps, week 4 unlimited, Brussels day boundary); `reachability.test.ts` (order of reasons: erased before no_email before restricted before suppressed before withdrawn before no_consent; granted and not suppressed is the only reachable case); `send-window.test.ts` (Easter Monday 2027-03-29, Ascension, Whit Monday, 11 November, 21:00 and 07:59 Brussels across the DST change); `packages/integrations/src/resend/webhook.test.ts` (valid signature, wrong secret, stale timestamp, multiple `v1` signatures); `client.test.ts` (fake idempotency, batch of 101 refused, retryable mapping of 429 and 5xx, Wave 0's `sendEmail` call shape still accepted, `deleteContact` 404 → `{ deleted: false }`); `packages/db/src/schema/email.test.ts` (createTestDb builds the schema; unique and partial unique constraints: second draft per template refused, duplicate `(campaign_id, person_id)` refused, check constraints on purpose (a `campaign` message without purpose refused, an `automation` message with null purpose accepted), paused_reason, transactional (`booking.booking_confirmed` accepted, `booking/booking-confirmed` refused) and marketing slug forms, and exactly one body source per version).
- **Done**: typecheck, lint, the suites above green.
- **Build order note (03-build-order.md, forward-call stubs):** this package also owns `apps/web/modules/email/api.ts` and declares in it every email function that another module calls (section 4 and section 10), with its final signature, as a typed stub that throws `NotImplementedError`; `sendTransactional` stays the working Wave 0 implementation. This is the one apps/web file email-P1 touches. Later email packages replace the stub bodies; no signature changes without a cross-module decision.

### email-P2 (V1): renderer, branding and template framework

- **Goal**: block document → MJML → HTML and plain text with personalisation, BEAM layout, accessibility rules and the legal footer; `renderEmail()` for code-backed and block-backed templates; `defineTemplate()` and the registry contract every module uses for its own templates.
- **Files**: create `packages/email/src/blocks/{to-mjml.ts,to-text.ts,compile.ts,personalise.ts,markdown.ts,a11y.ts,index.ts}`; create `packages/email/src/layout-parts/{brand.ts,footer.tsx,marketing-shell.ts}`; edit (not create) the Wave 0 files platform-P3 writes: `packages/email/src/{layout.tsx,render.ts,index.ts}` and `packages/email/src/templates/define.ts` (already carrying the final `defineTemplate({ name, component, props, slots, attachments?, loadProps? })` signature; cross-module D6); create `packages/email/src/resend.ts` (`buildOutgoingEmail()`); create `packages/email/src/templates/email/index.ts` (`export const templates = []`; email has no transactional template of its own). It does not create or edit any other module's template folder (`templates/platform/`, `templates/booking/`, `templates/webinar/` and the rest belong to their modules); platform writes its five templates with `defineTemplate()` in `templates/platform/` in Wave 0 (section 13, decision 1).
- **Interfaces**: `defineTemplate<P extends z.ZodTypeAny>(def: { name: string /* snake_case, key <m>.<name> */; component: (props: z.infer<P> & { copy: CopySlots; locale: Locale }) => ReactElement; props: P; sample: z.infer<P>; slots: Record<string, MessageKey>; attachments?: (props, locale) => Promise<{ filename: string; content: Uint8Array; contentType: string }[]>; loadProps?: (tx: Tx, args: { personId: string; locale: Locale; context: Record<string, string>; stepKey: string | null }) => Promise<z.infer<P>> }): TemplateDef`; `compileMarketing(doc, locale, ctx: { footer; brand; resolveCards }): { variants: Record<VariantPath, { html: string; text: string }>; warnings: Warning[] }`; `personalise(htmlOrText, values: TokenValues, opts: { escape: boolean }): string`; `selectVariant(doc, locale, recipient: { status; outcomes }): VariantPath`; `checkAccessibility(doc, locale): Warning[]`; `renderEmail(input: RenderInput): Promise<{ subject: string; html: string; text: string; links: string[] }>` throwing `MissingTranslationError` (keeps Wave 0's `renderEmail(component, { locale })` overload working); `buildFooter(input: { company; footerSettings; legalLinks; purpose | 'transactional'; consentDate?; preferenceUrls?; locale }): { html; text }`; `buildOutgoingEmail(msg, { kind, from, replyTo, listUnsubscribe?: { oneClickPostUrl }, sinkRewrite? }): OutgoingEmail` (headers of rule 2, tags).
- **Depends on**: email-P1 (`BlockDocumentSchema`, tokens, `LocalizedText`); Wave 0's `define.ts`, `layout.tsx`, `render.ts` (platform-P3) and `platform:gen-indexes templates collector` (platform-P1, Wave 0).
- **Tests**: `packages/email/src/blocks/to-mjml.test.ts` (every block type compiles with `validationLevel: 'strict'`; columns stack; snapshot of a sample newsletter); `to-text.test.ts` (headings, links as `text (url)`, lists, dynamic variants); `personalise.test.ts` (escaping, fallback, empty value, merge-field placeholder left for the resolver); `compile.test.ts` (dynamic lead, customer, member and assessment outcome variants render the right blocks: acceptance "lead, customer and member content blocks display correctly"; size warning above 102 KB); `a11y.test.ts` (missing alt, "click here" link text, heading order, image-only document warning, `lang` attribute per locale, brand colour contrast at least 4.5:1); `footer.test.ts` (legal name and form, enterprise number format, RPR per locale, legal links, reason per purpose and transactional, commercial-message sentence only for marketing); `render.test.ts` (missing locale throws; code-backed and block-backed paths; copy slot override beats catalogue default); `templates/define.test.ts` (every entry of the generated registry renders its `sample` in nl-BE, fr-BE and en, has a text part, contains the footer with the "Manage email preferences" link and no tracking pixel; every key matches `<m>.<snake_name>` with `<m>` equal to its folder and `<snake_name>` equal to the file basename with `-` replaced by `_` (one file is one key); a duplicate key, a kebab-case name, a name not matching its basename and a slash are refused; runs over whatever modules have registered); `resend.test.ts` (List-Unsubscribe headers only for marketing, sink rewrite of `to` and subject prefix).
- **Done**: typecheck, lint, suites green.

### email-P3 (V1): sending pipeline, webhook, tracking, privacy

- **Goal**: `email.send`, the cross-module API for single messages, the reachability view, the Resend webhook and event processing with suppression through crm, soft-bounce retry, open and click tracking, merge-field resolution, the sink, settings, privacy registration, permissions and events.
- **Files**: create `packages/db/src/schema/email.views.ts` (`v_marketing_reachability`, `v_campaign_stats`); edit `apps/web/modules/email/{api.ts,jobs.ts,events.ts,permissions.ts,privacy.ts,schedules.ts,seed.ts,config.ts}` (`api.ts` and `jobs.ts` hold Wave 0's working `sendTransactional` and `email.send` written by platform-P7; this package takes them over and replaces their bodies behind the same signature, kind, key and payload; `config.ts` declares `email_footer`, `warmup_schedule`, `email_config`, `email_brand` with Zod schemas and defaults); create `apps/web/modules/email/server/{send.ts,queue-automation.ts,templates-info.ts,process-event.ts,tracking.ts,link-token.ts,sink.ts,context.ts,merge-fields.ts}`; create `apps/web/app/api/webhooks/resend/route.ts`, `apps/web/app/api/public/track/open/route.ts`, `apps/web/app/api/public/track/click/route.ts`; edit Wave 0's `packages/db/src/seed/email.ts` (one system template and published version 1 per registry entry with copy from the owning catalogue, idempotent; settings defaults; `retention_policies` rows); create `docs/runbooks/email-dns.md`.
- **Interfaces**: section 4 `api.ts` signatures `sendTransactional`, `queueMarketingEmail`, `queueAutomationEmail`, `getTemplateInfo`, `getPublishedTemplateInfo`, `listPublishedTemplates`, `seedTemplate`, `getReachability`, `resolveLinkToken`, `listPersonEmails`, `countBlockedMessages`, `cancelScheduledMessage`; the `defineWebhookHandler({ provider: 'resend' })` registration; jobs `email.send`, `email.retry_soft_bounce`; schedules `email.purge_props`, `email.check_domains`; `resolveMergeFields(tx, { personId, context, locale, names }): Promise<Record<string, string | null>>`; `emailPrivacy` with `sweep`.
- **Depends on**: email-P1, email-P2; `platform:action/defineJob/defineSchedule/defineEvent/defineWebhookHandler/handleWebhook/enqueue/recordEvent/getSetting/storeFile/readFile/notifySlack/runJobTwice`; `platform:gen-indexes merge-fields collector` (platform-P1, Wave 0); `crm:addSuppression`, `crm:buildPreferenceUrls`, `crm:v_consent_current`, `crm:v_suppression_status`, `crm:persons.email_hash`, `crm:persons.processing_restricted_at`; `credits:v_person_status`; `site:getLegalLinks`; `booking:getNextBooking`. Unlanded functions are mocked with `vi.mock` until their owner merges.
- **Tests**: `apps/web/modules/email/send.test.ts` (idempotent `sendTransactional` returns the same ids; called inside a booking transaction that commits even when the template key is unknown, then `email.send` sets `failed` with `unknown_template`; invalid data → `invalid_template_data`; no address → `no_recipient`; erased person suppressed; hard-bounce suppression blocks; complaint does not block magic link; scoped unsubscribe does not block `crm.confirm_resubscribe`; every non-test message gets a `link_token_hash` and transactional ones get the preferences footer link but no `List-Unsubscribe`; marketing unreachable → `suppressed`; missing locale → `blocked_translation` and timeline event; `send_at` in the future sets `run_at`; cancelled scheduled message is not sent; attachment path uses single send and inline attachments get a `content_id`; sink rewrite and `rendered_file_id` outside production; `email_sink_missing`); `queue-automation.test.ts` (`queueMarketingEmail` returns `skipped_unreachable` and `skipped_translation` with a message row in `suppressed` or `blocked_translation`; `queueMarketingEmail` refuses a block-backed transactional template and a registry template without `loadProps`, and `queueAutomationEmail` a marketing one; `queueMarketingEmail` with `commerce.checkout_recovery` writes purpose `newsletter`, `from_domain = news.beam.be`, the marketing footer, `List-Unsubscribe` headers and tracking, and returns `skipped_unreachable` for a person not reachable for `newsletter` (cross-module D54); `queueAutomationEmail` writes `kind = automation`, `purpose` null, `from_domain = mail.beam.be`; a code-backed template with `loadProps` gets props built from `context` and `stepKey` (`webinar.reminder` variant `d3`), one without `loadProps` ends `failed` with `invalid_template_data`; context read from the enrolment when absent; same key twice → one message and `created: false`); `link-token.test.ts` (`resolveLinkToken` returns message id, person, purpose, locale and `sentAt`; `purpose` null for a transactional message; null for a test send, an unknown token and an erased row); `process-event.test.ts` (hard bounce → `crm.addSuppression` scope `all` reason `hard_bounce`, `automation.requestSuppressionExit` called through crm: acceptance "hard bounces are suppressed"; complaint → `addSuppression` reason `complaint`; soft bounce transactional → retry once; three soft bounces → suppression `soft_bounce_x3`; out-of-order events; unknown resend id); `tracking.test.ts` (open pixel sets `opened_at` once; click redirect to `links[i]`; forged token and bad index redirect home; click sets `opened_at`); `webhook-route.test.ts` (bad signature 401; duplicate svix-id stored once); `merge-fields.test.ts` (resolver receives only context ids; unknown merge field blocks publish; a resolver returning null uses the fallback); `reachability-view.test.ts` (the SQL view equals `resolveReachability` on fixtures built through crm's real functions: unsubscribe lifted only by a later preference_centre, portal or form grant, never by an import grant; hard bounce and scope `all` never lifted; restricted person unreachable; merged person has no row); `seed.test.ts` (a system row per registry entry; second run changes nothing; edited copy survives a reseed); `jobs.test.ts` (every handler twice → same state); `privacy.test.ts` (export lists messages; erase leaves no row referencing the person and enqueues no provider job; sweep deletes only rows past the cutoff; the `sweep` keys equal the seeded `retention_policies` keys `email.email_messages`, `email.email_events`, `email.campaign_recipients`, `email.email_ai_drafts`); `permissions.test.ts`.
- **Done**: typecheck, lint, suites green; `pnpm gen:indexes` picks up the job, schedule, event, webhook, settings and permission registrations.

### email-P4 (V1): unsubscribe integration and scenario 2

- **Goal**: prove the fast-unsubscribe path end to end across crm's routes and this module's headers, chunk and send-time checks; crm's archive guard.
- **Files**: create `apps/web/modules/email/server/unsubscribe-links.ts` (per-message `crm.buildPreferenceUrls(linkToken, locale)` call, header and footer wiring, `{{preferences_url}}` and `{{unsubscribe_url}}` values); create `apps/web/modules/email/server/segments.ts` (`isSegmentInUse`); edit `apps/web/modules/email/{api.ts,jobs.ts}`; edit Wave 0's `e2e/scenario-2-fast-unsubscribe.spec.ts` (replace the `test.fixme`).
- **Interfaces**: `unsubscribeLinksFor({ linkToken, kind: 'marketing' | 'transactional', locale }): { listUnsubscribe: string | null; unsubscribeUrl: string | null; preferencesUrl: string }` (pure over crm's pure `buildPreferenceUrls`); `isSegmentInUse(db, segmentId)`.
- **Depends on**: email-P3; `crm:buildPreferenceUrls`, crm's one-click route and preference centre (crm-P3); `automation:automation.exit_for_suppression` (job kind; the e2e needs automation-P3 merged, so the spec runs at the Wave 2 checkpoint).
- **Tests**: `apps/web/modules/email/unsubscribe-links.test.ts` (marketing messages carry `List-Unsubscribe` with crm's one-click URL built from that message's link token and `List-Unsubscribe-Post`; transactional carry neither header and only the preferences link; footer links per locale; crm's route given the token resolves through `resolveLinkToken` to the same message); `segments.test.ts` (segment used by a scheduled campaign or as an exclusion is in use; by a `sent` campaign is not); `e2e/scenario-2-fast-unsubscribe.spec.ts` (person enrolled in a marketing automation and in a scheduled campaign POSTs the one-click URL read from the sink's last message headers; within 60 s the enrolment is `exited` with `unsubscribed`, the campaign chunk marks the person `skipped_suppressed`, no further marketing message reaches the sink; a second person's fake Resend complaint has the same effect; a transactional booking confirmation still arrives).
- **Done**: typecheck, lint, suites green, the scenario-2 spec green against `beam_dev` at the Wave 2 checkpoint.

### email-P5 (V1): template editor, preview and test sends

- **Goal**: staff create, edit, preview, test and publish marketing and transactional templates.
- **Files**: create `apps/web/app/(admin)/admin/templates/page.tsx`, `apps/web/app/(admin)/admin/templates/[id]/page.tsx`, `apps/web/app/(admin)/admin/templates/[id]/preview/page.tsx`; create `apps/web/modules/email/ui/editor/{BlockEditor.tsx,BlockPalette.tsx,BlockCanvas.tsx,BlockInspector.tsx,DynamicBlockEditor.tsx,TokenPicker.tsx,CopySlotsEditor.tsx,PreviewFrame.tsx,TestSendDialog.tsx,VersionHistory.tsx}`; create `apps/web/modules/email/server/{templates.ts,preview.ts}`; edit `apps/web/modules/email/{actions.ts,queries.ts,nav.ts}`, `packages/core/src/email/inputs.ts`, `packages/core/src/i18n/messages/*/email.json` (`email.templates.*`, `email.editor.*`, `email.preview.*`).
- **Interfaces**: actions `createTemplate`, `saveTemplateDraft`, `publishTemplateVersion`, `archiveTemplate`, `duplicateTemplate`, `sendTestEmail` (images through platform's `uploadImage`); queries `listTemplates`, `getTemplate`, `getPreview`; `samplePersona(kind: 'lead' | 'customer' | 'member', outcome?: string): RecipientContext`.
- **Depends on**: email-P4; `commerce:getProductCards`, `booking:getSessionCards`, `forms:listLatestOutcomes`, `platform:uploadImage`, `automation:isTemplateInUse`.
- **Tests**: `apps/web/modules/email/templates.test.ts` (draft created on first edit of a published template; published row never updated; publish refuses incomplete locales with the exact missing list; unknown token refused; footer incomplete refused; archive refused while referenced; system template cannot be archived; MJML compile stored per locale and variant; accessibility warnings returned but publish succeeds; a block-backed transactional template publishes without tracking and without List-Unsubscribe); `preview.test.ts` (preview as real person uses their status and outcome; as lead, customer, member samples choose the matching variant; no sensitive fields read); `test-send.test.ts` (only staff addresses accepted; `test_sent_at` set; no timeline events); `e2e/email.spec.ts` part 1 (marketing builds a newsletter with a dynamic block, previews as lead and member, publishes).
- **Done**: typecheck, lint, suites green, e2e part 1 green.

### email-P6 (V1): campaigns engine and campaign screens

- **Goal**: the full campaign lifecycle from draft to sent with snapshot, recipient control, scheduling, chunked bulk sending, warm-up caps, pause, resume, stop and bounce-rate auto-pause.
- **Files**: create `apps/web/modules/email/server/{campaigns.ts,plan.ts,send-chunk.ts,auto-pause.ts}`; create `apps/web/app/(admin)/admin/campaigns/page.tsx`, `apps/web/app/(admin)/admin/campaigns/new/page.tsx`, `apps/web/app/(admin)/admin/campaigns/[id]/page.tsx`, `apps/web/app/(admin)/admin/campaigns/[id]/recipients/page.tsx`; create `apps/web/modules/email/ui/campaign/{CampaignStepper.tsx,AudiencePicker.tsx,ReviewChecklist.tsx,SchedulePanel.tsx,CampaignControls.tsx,RecipientsTable.tsx}`; edit `apps/web/modules/email/{actions.ts,queries.ts,jobs.ts,schedules.ts,nav.ts}`, `packages/core/src/email/inputs.ts`, `packages/core/src/i18n/messages/*/email.json` (`email.campaigns.*`); edit `e2e/email.spec.ts` (after P5).
- **Interfaces**: actions `createCampaign`, `updateCampaign`, `scheduleCampaign`, `unscheduleCampaign`, `refreshAudience`, `removeRecipient`, `restoreRecipient`, `pauseCampaign`, `resumeCampaign`, `stopCampaign`, `cancelCampaign`, `duplicateCampaign`; queries `listCampaigns`, `getCampaign`, `getAudienceEstimate`, `listCampaignRecipients`; jobs `campaign.plan`, `campaign.send_chunk`; schedule `email.dispatch_due_campaigns`; `evaluateBounceRate(tx, campaignId): Promise<'ok' | 'paused'>`.
- **Depends on**: email-P5; `crm:refreshSegment`, `crm:segmentAudienceSql`, `crm:getSegmentRef`, `crm:createTask`; `platform:notifySlack`.
- **Tests**: `apps/web/modules/email/campaigns.test.ts` (schedule refused without segment, without test send after last edit, with a missing audience locale, with incomplete footer, without `campaigns.send`; snapshot excludes exclusion segments and unreachable persons; `chunk_no` of 1,234 recipients = 0..2; warm-up ordering by engagement; remove and restore recipient; refresh keeps removed rows; unschedule deletes planned rows; optimistic version conflict; schedule on a public holiday or at 22:00 refused without `confirmOutsideWindow`, accepted with it; two concurrent schedule calls → one `conflict`; `dispatch_due_campaigns` run twice in parallel enqueues each chunk once); `send-chunk.test.ts` (1,050 recipients send as 3 chunks and 11 batches through the fake; a suppression added between chunks skips that person: `skipped_suppressed`; withdrawn consent → `skipped_consent`; recipient locale missing → `skipped_translation`; pause between batches leaves the rest planned; resume uses `r2` keys and finishes; stop leaves planned rows; warm-up cap stops mid-chunk and re-enqueues next day 09:00; last chunk sets `sent` whichever of two concurrently finishing chunks commits last; resume with no planned recipients sets `sent`; batch retried with the same idempotency key does not double-send; two overlapping runs of one chunk send each recipient once (`skip locked`)); `auto-pause.test.ts` (3 hard bounces of 120 sent pauses with `bounce_rate`, alert and task created; 1 of 120 does not; fewer than 100 sent never pauses; a bounce on an already `sent` campaign alerts without a status change); `jobs.test.ts` extended (plan and chunk twice → same state); `e2e/email.spec.ts` part 2 (campaign to a 3-person segment, remove one recipient, test send, send now, two messages in the sink).
- **Done**: typecheck, lint, suites green, e2e part 2 green.

### email-P7 (V1): reporting, deliverability, message log and person history

- **Goal**: per-campaign performance, the email overview with domain and warm-up status, complaint alerts, the message log, resend, manual suppression, stats freezing and the person-page email history.
- **Files**: create `apps/web/app/(admin)/admin/email/page.tsx`, `apps/web/app/(admin)/admin/email/messages/page.tsx`, `apps/web/app/(admin)/admin/email/messages/[id]/page.tsx`, `apps/web/app/(admin)/admin/campaigns/[id]/report/page.tsx`; create `apps/web/modules/email/ui/{PersonEmailHistory.tsx,CampaignReport.tsx,DeliverabilityPanel.tsx,KpiTiles.tsx}`; create `apps/web/modules/email/server/{reports.ts,complaints.ts,delivery-watch.ts,freeze.ts}`; edit `apps/web/modules/email/{actions.ts,queries.ts,api.ts,jobs.ts,schedules.ts,nav.ts}`, `packages/core/src/i18n/messages/*/email.json` (`email.report.*`, `email.deliverability.*`, `email.messages.*`); edit `e2e/email.spec.ts` (after P6).
- **Interfaces**: queries `getCampaignReport`, `listMessages`, `getMessage`, `listPersonEmails`, `getDeliverability`; actions `resendMessage`, `cancelScheduledMessage`; `getCampaignStats(db, ids)`, `getEmailHealth(db)`; jobs `email.freeze_campaign_stats`; schedules `email.watch_complaints`, `email.watch_delivery`, `email.freeze_due_stats`; component `PersonEmailHistory({ personId })` for `crm`.
- **Depends on**: email-P6; `platform:notifySlack`; `reports.read` permission string (declared in the architecture's permission list).
- **Tests**: `reports.test.ts` (open, click, bounce and unsubscribe rates on a fixture campaign equal hand-computed values; per-link clicks; snapshot used after freeze and unchanged after retention delete); `complaints.test.ts` (0.2 % complaints over 600 delivered alerts once per hour; 0.05 % does not); `delivery-watch.test.ts` (a transactional message queued 11 minutes alerts High; one queued 9 minutes does not; a future `send_at` never alerts; 5 dead sends in 15 minutes alerts; a message turning `blocked_translation` or `failed` posts one `normal` alert with fingerprint `email:failed:<error>` and no address in the text, a `cancelled` message none; `getEmailHealth` values); `resend-message.test.ts` (new message with `:manual:1` key and the current address; refused for marketing, test and suppressed; allowed for the `reception` role, refused for `marketing` without `persons.write`); `person-history.test.ts` (newest first, pagination, masked email without `persons.read`); `e2e/email.spec.ts` part 3 (report shows the sent campaign; fake webhook bounce shows on the person page and the address becomes unreachable).
- **Done**: typecheck, lint, suites green, full `e2e/email.spec.ts` green.

### email-P8 (R2): commercial-engine email support

- **Goal**: webinar and lead-window email content for Release 2, and the recovery lookup commerce needs.
- **Files**: edit `packages/core/src/email/blocks.ts` (add `webinar` block `{ webinarId, ctaLabel }`; `event` block option `showLeadWindow: boolean`); edit `packages/email/src/blocks/{to-mjml.ts,to-text.ts,compile.ts}`; edit `apps/web/modules/email/ui/editor/{BlockPalette.tsx,BlockInspector.tsx}`; create `apps/web/modules/email/server/latest-message.ts`; edit `apps/web/modules/email/api.ts`, `packages/core/src/i18n/messages/*/email.json`. The R2 templates (`webinar.access`, `webinar.reminder`, `webinar.rescheduled`, `webinar.cancelled`, `webinar.replay_available`, `commerce.checkout_recovery`, `booking.lead_window_open`, `credits.share_invitation`) are written by their owners in their own folders; this package creates no file under `packages/email/src/templates/webinar/` or any other module's folder (webinar decision 35).
- **Interfaces**: `WebinarBlock`; `resolveCards` gains `webinars: (ids, locale) => Promise<WebinarCard[]>`; the event card renders "Opens for you on <date time>" when the recipient's status is outside the session's current lead window (from `booking.getSessionCards()` field `opensForCustomersAt`); `findLatestMessage(db, { personId, templateSlug, after })`.
- **Depends on**: email-P7; `webinar:getWebinarCards(tx, ids, locale)`; `booking:getSessionCards` with `opensForCustomersAt`.
- **Tests**: `packages/email/src/blocks/webinar-block.test.ts` (render, missing webinar renders nothing); `event-lead-window.test.ts` (lead inside window sees the booking button, customer sees "Opens for you on ...", after release both see the button: scenario 3 email side); `latest-message.test.ts` (latest message after the cutoff for that person and template; none before it; uses the `(person_id, template_version_id, created_at)` index across versions of one template).
- **Done**: typecheck, lint, suites green.

### email-P9 (R3): campaign attribution and inbound dispatch

- **Goal**: revenue and first purchases per campaign and per automation for the campaign report and the `ops` marketing dashboards; Resend Inbound events passed to crm's unified inbox.
- **Files**: edit `packages/db/src/schema/email.views.ts` (add `v_email_attribution`); create `apps/web/modules/email/server/attribution.ts`; edit `apps/web/modules/email/server/process-event.ts` (dispatch `email.received`); edit `apps/web/modules/email/{api.ts,queries.ts}`, `apps/web/modules/email/ui/CampaignReport.tsx`, `packages/core/src/i18n/messages/*/email.json`, `docs/runbooks/email-dns.md` (the `in.beam.be` MX).
- **Interfaces**: `getCampaignAttribution(db, { from, to })` (section 4); `getCampaignReport` gains `attribution: { orders; revenueCents; firstPurchases }`; `process-event.ts` maps `email.received` to `crm.ingestInboundEmail(tx, ctx, { messageId, inReplyTo?, from, fromName?, subject, text, attachmentCount, receivedAt })` → `{ threadId }` (rule 46, cross-module D10).
- **Depends on**: email-P8; `commerce:orders` (`paid_at`, `total_cents`, `status`); `crm:ingestInboundEmail`.
- **Tests**: `attribution.test.ts` (order 3 days after a click attributed; 8 days not; two campaigns clicked → latest click before payment wins; fully refunded order excluded, partially refunded kept; automation click attributed to the automation; first purchase flag); `process-event.test.ts` extended (`email.received` calls `crm.ingestInboundEmail(tx, ctx, { messageId, inReplyTo?, from, fromName?, subject, text, attachmentCount, receivedAt })` once per svix id with `messageId` from the Message-ID header, never a raw `{ payload }`, and writes no `email_events` row).
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

1. Each module owns `packages/email/src/templates/<m>/` (architecture section 1 and 11) and writes its own react-email templates with `defineTemplate()`; `email` owns `defineTemplate()`, the shared layout, footer and renderer, the generated registry contract and the seeding of every template as an editable system row. Registry keys, and the `email_templates.slug` of every transactional template, are `<m>.<snake_name>` (this replaces the earlier `<m>/<file basename>` form; cross-module D1): `<name>` equals the file basename with `-` replaced by `_`, and one file is one key (`booking.booking_confirmed`, `commerce.order_confirmation`, `webinar.replay_available` from `replay-available.tsx`); `templates/define.test.ts` asserts it. Reason: email owns the registry and its slug check, and the dot keeps transactional slugs apart from hyphenated marketing slugs. Every owner uses the dotted keys listed in section 10 (cross-module D2); the earlier review requests for slash keys (`booking/<file>`, `commerce/<name>`, `credits/<name>`, `finance/invoice-issued`, `finance/credit-note-issued`, `ops/privacy-*`, `webinar/webinar-access`, `platform/magic-link`, `crm/*`, `automation/<name>`) are retracted and void (cross-module D68). Platform writes its five templates with `defineTemplate()` in its own folder in Wave 0 (cross-module D6); email's seed registers all five platform keys.
2. The one-click unsubscribe route, the token preference centre, the portal preferences page, manual suppressions and the unsubscribe and preference events (`consent.withdrawn`, `consent.granted`, `suppression.added`) are crm's, as the architecture says ("crm: preference centre pages"). `email` has no `updatePreferencesByToken`, `updateMyPreferences` or `addManualSuppression`, emits no `email.unsubscribed` or `email.preferences_updated`, puts crm's links (built from the message's link token) into headers and footers, enforces reachability at plan, chunk and send time, and owns the scenario-2 spec.
3. Resend webhook events are processed by this module's `defineWebhookHandler({ provider: 'resend' })` registration, which platform's generic `webhook.process` job dispatches to; the route is a one-liner over `handleWebhook()`.
4. No foreign keys to tables outside the Wave 0 contract set: `campaigns.segment_id` and `email_messages.enrolment_id` are plain uuids validated in code.
5. Published-version immutability is enforced in code by `assertDraftVersion()` with tests, not by a database trigger (custom triggers are reserved for APPEND tables).
6. `sendTransactional` keeps the Wave 0 stub signature from platform section 4.9 (`{ template, personId?, to?, locale, data, key } → { emailMessageId, jobId }`). The optional fields `attachments`, `context`, `sendAt`, `replyTo` and `headers` are additive; platform adds them to the stub (finance needs attachments, commerce `sendAt` for gift vouchers, crm R3 `replyTo` and `headers`, webinar `context`). Callers use `(ctx, input)`; specs that show `(tx, ...)`, `idempotencyKey`, `templateSlug`, `props`, `variables` or `toEmail` map to `ctx`, `key`, `template`, `data`, `data` and `to`, and the result is `{ emailMessageId, jobId }` (forms' `{ messageId, status, created }` is not returned: a suppression is decided later by `email.send`, rule 40). Forms' `purpose: 'assessment_result'` is not an input: a transactional message has no marketing purpose. The two automation functions keep automation's own input names (`templateSlug`, `idempotencyKey`) because automation is their only caller.
7. `sendTransactional` and `queueAutomationEmail` never throw for content problems; `email.send` turns them into `failed` messages and dead jobs, so an email fault never rolls back a booking, payment or form submission (booking rule R59, commerce section 8).
8. Cross-module functions this spec requires from their owners, called with the owners' signatures (crm's are `(tx, ctx, input)` for writes): crm `addSuppression`, `isSuppressed`, `buildPreferenceUrls(linkToken, locale)`, `refreshSegment`, `segmentAudienceSql`, `getSegmentRef`, `getSegmentSummaries` (R4), `createTask`, `ingestInboundEmail` (R3); booking `getSessionCards` (with `opensForCustomersAt` in R2), `getNextBooking`; commerce `getProductCards`; forms `listLatestOutcomes`; automation `isTemplateInUse`; site `getLegalLinks`; webinar `getWebinarCards` and its merge fields (R2); platform `getSetting`, `storeFile`, `readFile`, `notifySlack`, `callClaude` (R4) and the two `gen:indexes` collectors.

**Additions to the architecture's data model**

9. `email_templates`: `name`, `description`, `is_system`, `created_by_user_id`, `updated_at`.
10. `email_template_versions`: `copy` (transactional text slots, so staff edit transactional wording without a deploy), `ai_draft_id`, `updated_at`; partial unique one draft per template.
11. `campaigns`: `name`, `template_id`, `chunk_count`, `run_no`, `paused_reason`, `test_sent_at`, `started_at`, `finished_at`, `stopped_at`, `cancelled_at`, `last_error`, `stats_snapshot`, `ai_draft_id`, `updated_by_user_id`, `version`, `updated_at`.
12. `campaign_recipients`: `chunk_no`, `removed_by_user_id`, `removed_at`, `created_at`, `updated_at`.
13. `email_messages`: `props`, `context`, `attachments`, `reply_to`, `extra_headers`, `send_at`, `from_domain`, `bounce_type`, `attempt`, `retry_of_message_id`, `link_token_hash` (tracking and crm's preference links), `links`, `error`, `queued_at`, `delivered_at`, `opened_at`, `clicked_at`, `bounced_at`, `complained_at`, `last_event_at`, `updated_at`; enum `email_messages_kind` = `transactional|campaign|automation|test`. There is no `unsubscribed_at`: unsubscribes are crm facts, attributed to campaigns by time window in `v_campaign_stats`.
14. `email_events`: `source` (`resend|tracking`), `link_index`, type value `failed` (Resend `email.failed`).
15. New table `email_ai_drafts` (R4); new views `v_campaign_stats` (V1) and `v_email_attribution` (R3).
16. New settings keys seeded by `email`: `email_config` (`senders`, `resend_domain_ids`, `bounce_pause_pct: 2`, `bounce_min_sent: 100`, `complaint_alert_pct: 0.1`, `complaint_min_delivered: 500`) and `email_brand` (tone of voice, guidelines, do-not-say list, sample phrases; R4). `email_footer` holds `reasons` per purpose and `transactional` per locale and `rpr` per locale; company details come from `settings.company`. All four keys are declared with Zod schemas and defaults in `apps/web/modules/email/config.ts` (platform rule).
17. Idempotency key formats beyond the architecture: chunk `campaign:<id>:chunk:<n>:r<run_no>` (resume-safe), warm-up continuation `...:d<YYYY-MM-DD>`, plan `campaign:<id>:plan:<version>`, message `campaign:<id>:person:<person_id>`, Resend batch header `campaign:<id>:chunk:<n>:batch:<k>`, retry `<key>:retry`, manual resend `<key>:manual:<n>`, AI `ai:draft:<draft_id>`. All follow cross-module convention 5 (`<noun>:<id>[:<qualifier>...]`, dates `YYYY-MM-DD`, counters as integers, no timestamps); the message key passed to `sendTransactional` is `key` and its job is keyed `email:<message_id>`.

**Consent, reachability and unsubscribe**

18. Reachability is the architecture's definition: granted consent for the purpose, not suppressed for `all` or the purpose, not erased, email present; crm's processing restriction also blocks. There is no implicit reachability for members (`member_comms`) or company contacts (`b2b`) and no Belgian "soft opt-in" for existing customers in V1: service mail for members is transactional (renewals, payment failures), and B2B contacts become reachable through crm's staff grant with `legitimate_interest`. BEAM's legal review can add a soft opt-in later in one place, crm's `v_suppression_status` and consent model.
19. The lifting rule lives only in crm's `v_suppression_status`: a scoped `unsubscribe` suppression is lifted only by a later grant with method `preference_centre`, `portal` or `form`; scope `all`, `hard_bounce`, `complaint`, `manual` and `erased` suppressions are never lifted. Imports and staff can never re-subscribe someone.
20. Three soft bounces within 30 days become a suppression with reason `hard_bounce` and source `soft_bounce_x3`, avoiding a new crm enum value. Transactional soft bounces are retried once after 1 hour; marketing soft bounces are not retried.
21. Transactional mail is blocked only by `hard_bounce`, `complaint` and `erased` suppressions of scope `all`; `platform.magic_link`, `platform.password_reset`, `platform.mfa_changed` and `ops.privacy_erasure_scheduled` ignore `complaint` because the person asked for them or it is a security notice.
22. One random link token per message (every kind except `test`), stored only as a sha256 hash in `email_messages.link_token_hash`, as crm requested and as architecture section 10 prescribes for preference-centre tokens (random tokens, sha256 hashes stored). It records opens and clicks of marketing messages for 365 days, and it is the token of crm's unsubscribe and preference links on every message, resolved by `resolveLinkToken()`. This replaces the earlier design with crm-side stateless tokens, which stored nothing and so contradicted the architecture. Because crm's one-click source names the message (`one_click:<email_message_id>`), `v_campaign_stats.unsubscribed` attributes one-click unsubscribes exactly and uses the 7-day window only for paths whose source names no message.
23. One-click unsubscribe is crm's https POST (no mailto); a GET never changes data, so link scanners cannot unsubscribe anyone. This module only emits the RFC 8058 headers.
24. Unsubscribing one category never blocks other categories or transactional email; "unsubscribe from all marketing" writes scope `all`.

**Sending**

25. Senders `BEAM <hello@mail.beam.be>` and `BEAM <news@news.beam.be>`, Reply-To `info@beam.be`.
26. DNS per domain: Resend `send.` MX and SPF, `resend._domainkey` DKIM, DMARC `p=quarantine` for 4 weeks then `p=reject`, reports to `dmarc@beam.be`; daily domain verification check at 05:10.
27. Warm-up caps count per Brussels calendar day on `news.beam.be` only; overflow continues the next day at 09:00; during warm-up the most engaged recipients go first.
28. The audience snapshot is taken when scheduling (status `planning`), not at send time; "Refresh audience" is manual. This makes recipient preview and removal possible before sending.
29. Scheduling requires a test send of the current content after its last edit and a `scheduled_at` between 5 minutes and 90 days ahead (or "send now").
30. Bounce-rate auto-pause counts hard bounces only, after at least 100 sent; complaints alert but do not auto-pause. Resuming after an auto-pause requires typing the campaign name.
31. Stop leaves unsent recipients `planned` and reports them as "not sent (stopped)"; no new recipient status.
32. Outside production (`APP_ENV`) a missing `EMAIL_SINK` is a permanent job failure, never a real send; rendered HTML is kept 30 days (platform's `rendered_email` retention).
33. Marketing templates must be complete in all three locales to publish; transactional templates too.
34. `product` blocks show the public price at send time; member pricing in email is out of scope.
35. The legal footer carries the Belgian company identification (legal name and form, registered office, enterprise number, RPR) and marks marketing as a commercial message; privacy and terms links come from `site.getLegalLinks()`.
36. Accessibility checks (rule 15b) warn but never block publishing, except a missing `alt`, which blocks (blueprint requirement "alt required" in rule 16).
37. A campaign send outside 08:00-21:00 Brussels, on a Sunday or on a Belgian public holiday needs an explicit confirmation; BEAM's centre opening hours do not restrict email.
38. Delivery watch thresholds: transactional message queued 10 minutes, 5 dead sends in 15 minutes, or no sends for 60 minutes with 20 queued; each is a High alert, matching the proposal's SLA row "emails not sending".
39. Single messages may be scheduled (`sendAt`, at most 400 days ahead) and cancelled while queued; checks run at send time. This serves gift vouchers delivered on a chosen date.
40. Module merge fields (`{{<m>.<field>}}`) resolve through per-module `merge-fields.ts` files collected by `gen:indexes`, using only ids from the message `context`.

**Tracking, reporting and retention**

41. Open and click tracking are our own routes, marketing only; Resend tracking is off. Clicks redirect only to URLs stored on the message (`links[i]`), so there is no open redirect. No IP is stored; only a user-agent family to flag privacy-proxy opens.
42. Rates use delivered as the denominator for opens, clicks and unsubscribes and sent for bounces.
43. Campaign stats are frozen into `stats_snapshot` 30 days after finishing so retention deletes never change history.
44. Retention (keys `email.email_messages`, `email.email_events`, `email.campaign_recipients`, `email.email_ai_drafts`; cross-module D37): `email_messages` and `email_events` 2 years, `campaign_recipients` 2 years after finish, `props` 30 days, `email_ai_drafts` 1 year; rendered sink files 30 days and Resend `webhook_events` 90 days are platform's. Erasure deletes the person's message rows instead of anonymising them.
45. R3 attribution is last click within 7 days before payment, campaigns and automations alike; fully refunded orders are excluded, partially refunded ones count with their paid total.

**Releases**

46. Release 2 email work is the `webinar` block, the lead-window aware `event` block and `findLatestMessage()` (the R2 templates are their owners'); Release 3 is attribution and inbound dispatch to crm; Release 4 is AI drafting. SMS, automated B2B prospecting and cold outbound email (blueprint 26, 27), personalised outbound at scale, send-time prediction and A/B subject tests stay "Later", as the proposal lists them.
47. AI drafts use only aggregate and brand context (no person-level data), `claude-opus-5-5`, and acceptance creates a draft campaign; scheduling stays a human action with `campaigns.send`.

**Cross-module review outcomes**

48. Wave 0 hand-over (platform request): platform-P3 writes the `sendEmail`-only Resend client and the Wave 0 files `packages/email/src/{layout.tsx,render.ts,index.ts}` and `packages/email/src/templates/define.ts` (final `defineTemplate` signature, cross-module D6); platform-P7 writes the working `sendTransactional` in `apps/web/modules/email/api.ts` and the `email.send` handler in `jobs.ts`. From Wave 1 this module owns all of them: email-P1 completes the client (keeping `sendEmail`), email-P2 edits (never creates) these package files under those exact names, email-P3 replaces the api and job bodies behind the same signature, job kind, key `email:<message_id>` and payload. Platform's template folder `templates/platform/` stays platform's; email creates no file in it.
49. Monitoring (platform PL-75a): this module owns the rows "Failed emails" (rule 38a check d, plus `blocked_translation` in the daily digest through `countBlockedMessages`) and "Deliverability" (rules 37, 38, `email.check_domains`). Every alert goes through `notifySlack({ fingerprint, severity, text })`; this module never enqueues `notify.slack` and never builds a `slack:` or `alert:` key, because platform owns the key format and hourly dedupe. Dead `email.send` jobs keep platform's generic dead-job alert (PL-29), so a dead send is not alerted twice by this module.
50. Automation (automation request): `queueMarketingEmail(ctx, input)` and `queueAutomationEmail(ctx, input)` take automation's input `{ templateSlug, personId, enrolmentId, idempotencyKey }` (plus optional `context` and `stepKey`) and return automation's `{ messageId, status: 'queued' | 'skipped_unreachable' | 'skipped_translation', created }` (plus `templateVersionId`); `getTemplateInfo(db, slug)` is the single-slug form automation calls, beside the batch `getPublishedTemplateInfo`. The `email_messages` purpose check is relaxed to `kind <> 'campaign' or purpose is not null`, so an automation message from a transactional template has purpose null and sends from `mail.beam.be`. `queueAutomationEmail` also accepts code-backed registry templates that declare `loadProps` (needed by webinar's reminder and replay journeys); webinar therefore needs no extra seeded transactional rows (`webinar-reminder`, `webinar-replay-available`): automation names the system rows `webinar.reminder` and `webinar.replay_available` that email's seed already creates.
51. Provider-side erasure (ops request): the job `email.erase_provider_data` is removed. Ops' `privacy.erase_external` (key `privacy:<request_id>:r<run_attempt>:external:resend`, cross-module D35) calls this module's `ResendClient.deleteContact(email)` before any local step, so exactly one job deletes the Resend data and the address is still known; email's `erase()` handles only local rows. This supersedes this module's earlier request that ops rely on email's `erase()` for Resend.
52. Template content ownership: finance asked email to add props to "the finance template props schemas", and finance and forms state that email writes their templates in `templates/finance/` and `templates/forms/` and holds their copy under `email.tpl.<m>.*`. Declined as written: architecture sections 1 and 11 give `packages/email/src/templates/<m>/` to module `<m>`, so finance writes `finance.invoice_reminder` and `finance.company_request_decided` and adds `isCourtesyCopy`, `decision` and `note` to its own props schemas, forms writes `forms.result` (from `FormResultProps` with `pendingConfirmation`) and `forms.result_link` (from `FormResultLinkProps`), and their copy lives in `finance.email.*` and `forms.email.*`. The keys themselves are applied: they are in the registry list of section 10 and seeded as system rows.
53. Registered keys (requests from webinar, platform, finance, booking, forms, commerce and credits) are the list in section 10: webinar's five keys replace any `webinar.registered` template; booking's twelve keys (one per file, cross-module D2) replace `booking.confirmation`, `booking.cancellation`, `booking.reminder`, `booking.claim_offer` and `booking.waitlist_update`; commerce's eight keys replace `commerce.receipt` with `commerce.order_confirmation` and `commerce.pos_receipt` and add `commerce.gift_voucher`, `commerce.refund_confirmation`, `commerce.portal_invitation`; credits' eight membership, sharing (R2) and referral (R3) keys replace `credits.membership_renewal` and `credits.membership_past_due`; finance adds `finance.invoice_reminder` (PDF attachment) and `finance.company_request_decided`; forms adds `forms.result_link`; platform adds `platform.mfa_changed` and `platform.monthly_report`.
54. crm calls use crm's final signatures: `addSuppression(tx, ctx, input)`, `createTask(tx, ctx, { ..., ref: { type, id } })`, `buildPreferenceUrls(linkToken, locale)`, and R3 `ingestInboundEmail(tx, ctx, { messageId, inReplyTo?, from, fromName?, subject, text, attachmentCount, receivedAt })` returning `{ threadId }`, with the Resend Inbound payload mapped by this module's handler (rule 46) inside the `webhook.process` transaction; the earlier `ingestInboundEmail(ctx, { payload })` request and the stateless-preference-token request are void (cross-module D10, D68).
55. Transactional footers carry one "Manage email preferences" link (crm's preference centre opened with the message's token, no pre-selected purpose) besides the legal block; they still carry no `List-Unsubscribe` header, no tracking pixel and no click rewriting.

**Cross-module decisions (`_cross-module-decisions.md`)**

56. Cross-module decision 1 applied: transactional keys are `<m>.<name>`, `<name>` equals the file basename with `-` replaced by `_`, one file is one key; the generator and `templates/define.test.ts` refuse a basename mismatch, a duplicate and a slash (rule 15a, decision 1); the claim that booking and commerce already used dotted keys is dropped.
57. Cross-module decision 2 applied: the section 10 registry list carries booking's 12 and commerce's 8 keys; the examples in rule 15a, the `email_templates.slug` note, `TransactionalTemplateKey`, the P1 schema test and decisions 1 and 53 use `booking.booking_confirmed` and `commerce.order_confirmation`.
58. Cross-module decision 3 applied: no change beyond decision 2; `webinar.reminder` (variant from `stepKey`) and `webinar.replay_available` are code-backed with `loadProps`, and decision 50 stands.
59. Cross-module decision 6 applied: email-P2 edits (does not create) Wave 0's `templates/define.ts`, `layout.tsx` and `render.ts`; the `gen:indexes` collectors are platform-P1 (Wave 0) and the orchestrator step before Wave 1 is dropped (section 12 intro, P2, P3, decisions 1 and 48).
60. Cross-module decision 7 applied: no change; `queueMarketingEmail`, `queueAutomationEmail`, `AutomationEmailInput` and their statuses stand as in section 4.
61. Cross-module decision 9 applied: no change; rule 53 and `resolveLinkToken` stand.
62. Cross-module decision 10 applied: rule 46, section 6, email-P9 and decision 54 name the mapped fields of `crm.ingestInboundEmail(tx, ctx, { messageId, inReplyTo?, from, fromName?, subject, text, attachmentCount, receivedAt })` → `{ threadId }` (no `{ payload }`).
63. Cross-module decision 35 applied: no job change (decision 51 stands, `ResendClient.deleteContact` stays exported for ops); decision 51 names ops' key `privacy:<request_id>:r<run_attempt>:external:resend`.
64. Cross-module decision 37 applied: retention keys are `email.email_events`, `email.email_messages`, `email.campaign_recipients`, `email.email_ai_drafts` (section 9 `sweep` map and seed text, P3 privacy test, decision 44), inserted `on conflict (key) do nothing`.
65. Cross-module decision 54 applied: a registry template sent through `queueMarketingEmail` (`commerce.checkout_recovery`) is rendered with the marketing footer, `List-Unsubscribe` and tracking, sent from `news.beam.be` with purpose `newsletter` (rule 39a, `email_messages.purpose` and `from_domain` notes, section 10, P3 test).
66. Cross-module decision 64 applied: the owner paths list no `preferences/` route; crm owns `app/[locale]/(site)/preferences/` and `app/api/public/{unsubscribe,preferences}/` (header paragraph, unchanged).
67. Cross-module decision 68 applied: the earlier slash-key requests, the stateless-preference-token request and the `ingestInboundEmail(ctx, { payload })` request are retracted (decisions 1, 22 and 54).
68. Cross-module conventions applied: activity event `data` keys are snake_case (rule 52, convention 2); idempotency keys use `YYYY-MM-DD` dates and integer counters, so the warm-up continuation is `:d<YYYY-MM-DD>` and the plan key `campaign:<id>:plan:<version>` (rule 7, jobs table, edge case 28, decision 17, convention 5); settings keys `email_footer`, `warmup_schedule`, `email_config`, `email_brand` and their snake_case fields already match convention 3 and the D17 register.
