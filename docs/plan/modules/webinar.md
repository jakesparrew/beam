# Module spec: webinar (Webinars on YouTube Live)

Owner module id: `webinar`. Schema file `packages/db/src/schema/webinar.ts` (+ `webinar.views.ts`), core `packages/core/src/webinar/`, app `apps/web/modules/webinar/`, email `packages/email/src/templates/webinar/`, catalogue namespace `webinar`. Blueprint sources: section 18 (primary), 21 (webinar behaviour triggers), 34 (webinar KPIs), plus 3 (webinar as origin), 5 (timeline), 6 (segmentation), 15 (webinars as events), 31 (webinar sequences), 50 and 53 (current tool and migration), 58, 62, 63, 66 (privacy), 76 and 87 (acceptance, scenario 5).

## 1. Purpose and release mapping

A webinar in BEAM is a sales step, not just a lead source. People register on the website or in the portal, watch inside BEAM (YouTube Live unlisted video in an embedded player), answer polls, click CTAs and ask questions. Every action lands on the person's timeline with its mode (`live`, `replay`, `on_demand`), so reports and automations can treat each mode separately (scenario 5). Presenters work in Google Meet and stream to the YouTube broadcast that BEAM created.

| Release | What ships in this module |
| --- | --- |
| **V1 (weeks 1-6)** | Stopgap only, as the proposal promises ("you keep your current webinar tool, and registrations are imported into the customer record"). CSV import (WebinarGeek and Zoom presets plus a generic mapping) and a signed webhook (for Zapier) that turn registrations and attendance of the current tool into `persons` (found or created) and `activity_events` of kinds `webinar.registered`, `webinar.attended` and `webinar.threshold_reached`. Tables `external_webinars`, `webinar_imports`. Screen `/admin/webinars/import`. The current tool is documented as a temporary subprocessor (section 9). |
| **Release 2 (weeks 9-10)** | The native module. Webinars linked to a `sessions` row of kind `event`; modes `live`, `simulive`, `on_demand`; one-off and recurring (series); YouTube unlisted broadcasts created through the Data API v3; Google Meet space for presenters; separate host and participant links; registration from site and portal with personal access tokens; embedded IFrame player; heartbeat every 15 s writing `watch_segments`; watch time per mode with the 15 min, 30 min, 50 % and end thresholds; started, attended and missed facts; polls, CTAs, chat and questions in live, replay and on-demand with the mode on every row; moderation (hide message, block viewer); gated replays with expiry and view limits; tags and automation events from poll answers and CTA clicks; seeded reminder and follow-up automations; reporting split by lead, customer and member with conversion within a configurable period; privacy registration. Acceptance tests of proposal section 12: registration is not attendance, watch time is captured, replay activity and replay polls are stored apart from live. |
| **Release 3 (weeks 11-12)** | Webinar in campaign attribution and marketing dashboards: registrations per UTM source and campaign, cost per registration and registration rate from `ad_spend_daily` clicks, the funnel campaign -> registration -> attendance -> first visit -> first purchase, and `getWebinarKpis()` consumed by the ops marketing dashboard. |
| **Release 4 (weeks 13-14)** | AI and flexibility hooks: a non-personal aggregate view `v_webinar_performance_daily` for natural-language questions, webinar facts for the weekly management summary, and webinar engagement fields offered to the churn and repurchase indicators. The custom workflow builder (automation, R4) uses this module's event kinds unchanged. |
| **Later (out of scope)** | Native video streaming or recording infrastructure; in-browser presenter studio (presenters use Google Meet); paid webinar tickets (paid events stay booking tickets); breakout rooms; webinar certificates; native mobile app; AI-generated webinar summaries or automatic transcripts; automated behavioural scoring of viewers beyond the fixed thresholds. |

## 2. Domain model

All tables live in `packages/db/src/schema/webinar.ts` and follow the architecture conventions (`id uuid pk default gen_random_uuid()`, `created_at timestamptz not null default now()`, `updated_at` on mutable tables, enums `pgEnum('<table>_<column>')`, `LocalizedText` jsonb via `localized()`). Views live in `webinar.views.ts`.

### 2.1 Enums

| Enum | Values |
| --- | --- |
| `external_webinars_provider` | `webinargeek`, `zoom`, `other` |
| `webinar_imports_source` | `csv`, `webhook` |
| `webinar_imports_preset` | `webinargeek_registrants`, `webinargeek_attendees`, `zoom_registrants`, `zoom_attendees`, `generic`, `webhook` |
| `webinar_imports_status` | `uploaded`, `dry_run`, `running`, `done`, `failed` |
| `webinars_mode` | `live`, `simulive`, `on_demand` |
| `webinars_status` | `draft`, `published`, `live`, `ended`, `cancelled`, `archived` |
| `webinar_presenters_role` | `host`, `presenter`, `moderator` |
| `webinar_registrations_registered_mode` | `live`, `replay`, `on_demand` |
| `webinar_registrations_status` | `registered`, `cancelled`, `blocked` |
| `webinar_registrations_source` | `site`, `portal`, `admin`, `automation` |
| `webinar_registrations_person_status` | `lead`, `customer`, `member` |
| `watch_segments_mode` and `webinar_interactions_mode` | `live`, `replay`, `on_demand` (one shared TS const `WATCH_MODES`) |
| `webinar_interactions_kind` | `started`, `poll_answer`, `cta_shown`, `cta_clicked`, `chat`, `question`, `ended` (exactly the architecture list) |
| `webinar_moderation_actions_action` | `hide_message`, `unhide_message`, `mark_answered`, `block_viewer`, `unblock_viewer` |

### 2.2 V1 tables

**`external_webinars`** (mutable; no person data). One row per webinar held in the current tool.

| Column | Type | Null | Default / check |
| --- | --- | --- | --- |
| id | uuid | no | `gen_random_uuid()` |
| provider | `external_webinars_provider` | no | |
| external_id | text | no | check `length(external_id) between 1 and 200` |
| title | text | no | check `length(title) <= 300` (not localised: the old tool has one title) |
| starts_at | timestamptz | yes | |
| duration_sec | integer | yes | check `duration_sec > 0` |
| created_at, updated_at | timestamptz | no | `now()` |

Unique `(provider, external_id)`.

**`webinar_imports`** (mutable; no person data in any column).

| Column | Type | Null | Default / check |
| --- | --- | --- | --- |
| id | uuid | no | |
| source | `webinar_imports_source` | no | |
| preset | `webinar_imports_preset` | no | |
| external_webinar_id | uuid -> `external_webinars.id` on delete restrict | no | |
| file_id | uuid -> `files.id` on delete set null | yes | check `source <> 'csv' or file_id is not null` at insert (enforced in action; the FK may be nulled when the file expires) |
| external_event_id | text | yes | webhook delivery id; check `source <> 'webhook' or external_event_id is not null` |
| payload | jsonb | yes | webhook records; set to `null` once processed (they contain emails) |
| mapping | jsonb | no | `{}`; column name -> field for `generic` |
| is_dry_run | boolean | no | `false` |
| status | `webinar_imports_status` | no | `uploaded` |
| counts | jsonb | no | `{"rows":0,"persons_created":0,"persons_matched":0,"registered":0,"attended":0,"thresholds":0,"skipped":0,"errors":0}` |
| report | jsonb | no | `[]`; array of `{row:int, code:text}`, max 500 entries, never an email or name |
| created_by_user_id | uuid -> `users.id` | yes | null for webhook |
| finished_at | timestamptz | yes | |
| created_at, updated_at | timestamptz | no | |

Partial unique `(external_webinar_id, external_event_id) where external_event_id is not null`. Index `(status, created_at desc)`.

### 2.3 Release 2 tables

**`webinars`** (mutable, optimistic `version`).

| Column | Type | Null | Default / check |
| --- | --- | --- | --- |
| id | uuid | no | |
| slug | text | no | unique; check `slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'` and `length(slug) <= 80` |
| session_id | uuid -> `sessions.id` on delete restrict | yes | unique; required for `live`/`simulive` once not draft (check below) |
| series_key | text | yes | groups recurring occurrences; check `series_key ~ '^[a-z0-9-]{3,60}$'` |
| title | jsonb `LocalizedText` | no | |
| description | jsonb `LocalizedText` | no | `{}` |
| locales | text[] | no | `{nl-BE,fr-BE,en}`; check `locales <@ array['nl-BE','fr-BE','en'] and cardinality(locales) >= 1` |
| spoken_locale | `locale` enum (from `_shared.ts`) | no | `nl-BE` |
| mode | `webinars_mode` | no | |
| status | `webinars_status` | no | `draft` |
| starts_at | timestamptz | yes | check `mode <> 'on_demand' or starts_at is null` |
| planned_duration_minutes | smallint | no | `60`; check `between 5 and 480` |
| duration_sec | integer | yes | real length from YouTube (recording) or the simulive video; check `> 0` |
| youtube_video_id | text | yes | live broadcast id (= video id); check `youtube_video_id ~ '^[A-Za-z0-9_-]{11}$'` |
| youtube_stream_id | text | yes | bound liveStream id |
| youtube_lifecycle | text | yes | last `lifeCycleStatus` seen (`created`, `ready`, `testing`, `live`, `complete`, `revoked`) |
| recording_video_id | text | yes | VOD for replay, simulive and on-demand; same 11-char check |
| host_meet_url | text | yes | check `host_meet_url like 'https://meet.google.com/%'` |
| meet_space_name | text | yes | Meet API resource name `spaces/...` |
| publish_requested_at | timestamptz | yes | set by `publishWebinar` while the broadcast is created |
| broadcast_error | text | yes | last YouTube error shown to staff; cleared on success |
| published_at | timestamptz | yes | |
| live_started_at | timestamptz | yes | from YouTube `actualStartTime` (live) or `starts_at` (simulive) |
| live_ended_at | timestamptz | yes | |
| finalised_at | timestamptz | yes | set once by `webinar.finalise` |
| is_replay_enabled | boolean | no | `true` |
| is_replay_gated | boolean | no | `true`: replay only for people registered before `live_ended_at`; `false`: anyone may register for the replay |
| replay_until_at | timestamptz | yes | null = no expiry; check `replay_until_at is null or starts_at is null or replay_until_at > starts_at` |
| replay_view_limit | smallint | yes | views per registration in `replay`/`on_demand`; check `between 1 and 50` |
| on_demand_access_days | smallint | yes | on-demand: days of access after registering; check `between 1 and 365` |
| attended_min_sec | integer | no | `300`; check `between 60 and 3600` |
| conversion_window_days | smallint | no | `30`; check `between 1 and 365` |
| is_chat_enabled | boolean | no | `true` |
| is_questions_enabled | boolean | no | `true` |
| owner_user_id | uuid -> `users.id` | no | receives question tasks and alerts |
| created_by_user_id | uuid -> `users.id` | no | |
| cancelled_reason | text | yes | |
| version | integer | no | `1` |
| created_at, updated_at | timestamptz | no | |

Checks: `ck_webinars_scheduled`: `status in ('draft','cancelled') or mode = 'on_demand' or (starts_at is not null and session_id is not null)`; `ck_webinars_video`: `status = 'draft' or mode = 'live' or recording_video_id is not null`; `ck_webinars_live_video`: `status in ('draft','cancelled') or mode <> 'live' or youtube_video_id is not null`. Indexes: `(status, starts_at)`, `(series_key) where series_key is not null`, `(mode, status) where status in ('published','live','ended')`.

**`webinar_presenters`** (mutable). A presenter is a staff user or a CRM person (principle 1: no identity outside `persons`/`users`).

| Column | Type | Null | Default / check |
| --- | --- | --- | --- |
| id | uuid | no | |
| webinar_id | uuid -> `webinars.id` on delete cascade | no | |
| user_id | uuid -> `users.id` | yes | |
| person_id | uuid -> `persons.id` | yes | |
| display_name | text | no | public stage name; check `length between 1 and 120` |
| role | `webinar_presenters_role` | no | `presenter` |
| sort_order | smallint | no | `0` |
| created_at, updated_at | timestamptz | no | |

Check `num_nonnulls(user_id, person_id) = 1`. Partial unique `(webinar_id, user_id) where user_id is not null`, `(webinar_id, person_id) where person_id is not null`.

**`webinar_registrations`** (mutable status; one per person per webinar).

| Column | Type | Null | Default / check |
| --- | --- | --- | --- |
| id | uuid | no | |
| webinar_id | uuid -> `webinars.id` on delete restrict | no | |
| person_id | uuid -> `persons.id` on delete restrict | no | |
| access_token_hash | text | no | unique; `sha256(token)` hex (section 3, rule 9) |
| token_version | smallint | no | `1`; bumped to revoke links |
| registered_mode | `webinar_registrations_registered_mode` | no | |
| status | `webinar_registrations_status` | no | `registered` |
| source | `webinar_registrations_source` | no | |
| locale | `locale` | no | from the form or URL; drives emails for this registration |
| person_status | `webinar_registrations_person_status` | no | snapshot of `crm.getPersonStatus` at registration; reporting splits on it |
| utm | jsonb | no | `{}`; `{source, medium, campaign, content, term}` |
| access_emails_sent | smallint | no | `0`; resend throttle counter |
| last_access_email_at | timestamptz | yes | |
| cancelled_at | timestamptz | yes | |
| blocked_at | timestamptz | yes | |
| blocked_by_user_id | uuid -> `users.id` | yes | |
| created_at (= registered at), updated_at | timestamptz | no | |

Unique `(webinar_id, person_id)`. Indexes `(person_id)`, `(webinar_id, status)`, `(webinar_id, person_status)`.

**`webinar_polls`** (mutable until answered; then only `is_active`, `live_*` change).

| Column | Type | Null | Default / check |
| --- | --- | --- | --- |
| id | uuid | no | |
| webinar_id | uuid -> `webinars.id` on delete cascade | no | |
| key | text | no | check `key ~ '^[a-z0-9_]{1,40}$'`; unique `(webinar_id, key)` |
| question | jsonb `LocalizedText` | no | |
| options | jsonb | no | `[{key, label: LocalizedText}]`, 2 to 8 options, keys `^[a-z0-9_]{1,20}$`, validated by Zod `PollOptions` |
| allow_multiple | boolean | no | `false` |
| show_at_sec | integer | yes | position where replay, simulive and on-demand show it; check `>= 0` |
| show_for_sec | integer | no | `120`; check `between 15 and 1800` |
| live_launched_at | timestamptz | yes | set by the host in live; writes `show_at_sec` if it was null |
| live_closed_at | timestamptz | yes | |
| tag_rules | jsonb | no | `[]`; `[{option_keys: string[], tag_key: string, modes: WatchMode[]}]` |
| is_active | boolean | no | `true` |
| sort_order | smallint | no | `0` |
| created_at, updated_at | timestamptz | no | |

**`webinar_ctas`** (same lifecycle as polls).

| Column | Type | Null | Default / check |
| --- | --- | --- | --- |
| id | uuid | no | |
| webinar_id | uuid -> `webinars.id` on delete cascade | no | |
| key | text | no | unique `(webinar_id, key)`, same pattern as polls |
| label | jsonb `LocalizedText` | no | |
| url | text | no | check `url like 'https://%'` and `length(url) <= 2000` |
| show_at_sec | integer | yes | check `>= 0` |
| show_for_sec | integer | no | `300`; check `between 15 and 7200` |
| live_shown_at, live_hidden_at | timestamptz | yes | |
| is_active | boolean | no | `true` |
| sort_order | smallint | no | `0` |
| created_at, updated_at | timestamptz | no | |

**`watch_segments`** APPEND (trigger `reject_update_delete()`, listed in `APPEND_ONLY_TABLES`).

| Column | Type | Null | Default / check |
| --- | --- | --- | --- |
| id | uuid | no | |
| registration_id | uuid -> `webinar_registrations.id` on delete cascade | no | |
| webinar_id | uuid -> `webinars.id` | no | denormalised for reporting indexes |
| mode | `watch_segments_mode` | no | |
| view_id | uuid | no | one player view (page load to close) |
| from_sec | integer | no | check `from_sec >= 0` |
| to_sec | integer | no | check `to_sec > from_sec and to_sec - from_sec <= 30` |
| recorded_at | timestamptz | no | `now()` |
| created_at | timestamptz | no | |

Indexes `(registration_id, mode, from_sec)`, `(webinar_id, mode, recorded_at)`. Positions are seconds from the start of the video: for `live` and simulive, `now - live_started_at` computed on the server.

**`webinar_interactions`** APPEND.

| Column | Type | Null | Default / check |
| --- | --- | --- | --- |
| id | uuid | no | |
| registration_id | uuid -> `webinar_registrations.id` on delete cascade | no | |
| webinar_id | uuid -> `webinars.id` | no | |
| mode | `webinar_interactions_mode` | no | stored on every row (scenario 5) |
| kind | `webinar_interactions_kind` | no | |
| poll_id | uuid -> `webinar_polls.id` | yes | check `(kind = 'poll_answer') = (poll_id is not null)` |
| cta_id | uuid -> `webinar_ctas.id` | yes | check `(kind in ('cta_shown','cta_clicked')) = (cta_id is not null)` |
| view_id | uuid | yes | |
| payload | jsonb | no | `{}`; `poll_answer`: `{option_keys}`; `chat`/`question`: `{text}` (1-500 chars); `started`: `{player_notice_version}`; `cta_clicked`: `{url}` |
| at_sec | integer | yes | video position; check `>= 0` |
| occurred_at | timestamptz | no | `now()` |
| created_at | timestamptz | no | |

Partial unique `uq_poll_answer_once (registration_id, poll_id, mode) where kind = 'poll_answer'` and `uq_cta_shown_once (registration_id, cta_id, mode) where kind = 'cta_shown'`. Indexes `(webinar_id, kind, mode)`, `(webinar_id, occurred_at) where kind in ('chat','question')`, `(registration_id, kind, mode)`. Sensitive: `payload.text` is free text written by the viewer. It is personal data but not special-category by design; the composer warns "do not share health details". It is excluded from AI context and segment fields.

**`webinar_moderation_actions`** APPEND.

| Column | Type | Null | Default / check |
| --- | --- | --- | --- |
| id | uuid | no | |
| webinar_id | uuid -> `webinars.id` | no | |
| interaction_id | uuid -> `webinar_interactions.id` on delete cascade | yes | for message actions |
| registration_id | uuid -> `webinar_registrations.id` on delete cascade | no | the viewer concerned |
| action | `webinar_moderation_actions_action` | no | check message actions have `interaction_id` |
| by_user_id | uuid -> `users.id` | no | |
| created_at | timestamptz | no | |

Index `(webinar_id, created_at)`. The current visibility of a message is the latest `hide_message`/`unhide_message` row.

### 2.4 Views (`webinar.views.ts`, Drizzle `pgView(...).as(sql\`...\`)`)

**`v_webinar_watch`**: merged watch time per registration per mode (gaps and islands, overlapping and touching intervals merged, so two tabs never double count).

```sql
with s as (
  select ws.registration_id, ws.webinar_id, ws.mode, ws.from_sec, ws.to_sec, ws.recorded_at,
         max(ws.to_sec) over (partition by ws.registration_id, ws.mode order by ws.from_sec, ws.to_sec
                              rows between unbounded preceding and 1 preceding) as prev_max
  from watch_segments ws),
g as (select s.*, sum(case when prev_max is null or from_sec > prev_max then 1 else 0 end)
         over (partition by registration_id, mode order by from_sec, to_sec) as grp from s),
islands as (select registration_id, webinar_id, mode, grp, min(from_sec) f, max(to_sec) t,
                   min(recorded_at) first_at, max(recorded_at) last_at from g group by 1,2,3,4),
agg as (select registration_id, webinar_id, mode, sum(t - f)::int as watched_sec, max(t) as max_position_sec,
               min(first_at) as first_watched_at, max(last_at) as last_watched_at from islands group by 1,2,3)
select a.*, w.attended_min_sec,
       coalesce(w.duration_sec, w.planned_duration_minutes * 60) as duration_sec,
       a.watched_sec >= w.attended_min_sec as is_attended,
       a.watched_sec >= 900 as is_15m,
       a.watched_sec >= 1800 as is_30m,
       a.watched_sec * 2 >= coalesce(w.duration_sec, w.planned_duration_minutes * 60) as is_half,
       a.max_position_sec >= coalesce(w.duration_sec, w.planned_duration_minutes * 60) - 60 as is_end
from agg a join webinars w on w.id = a.webinar_id;
```

**`v_webinar_registration_facts`**: one row per registration: `registration_id, webinar_id, person_id, person_status, registered_mode, status, registered_at, anchor_at` (`coalesce(w.starts_at, r.created_at)` when `registered_mode = 'live'`, else `r.created_at`), per mode (`live_`, `replay_`, `od_`) `started` (exists `started` interaction), `watched_sec`, `attended`, `is_15m`, `is_30m`, `is_half`, `is_end`, plus `poll_answers_live|replay|od`, `cta_clicks_live|replay|od`, `questions`, `chats`, `first_cta_click_at`.

**`v_webinar_conversions`**: per registration `first_booking_at` = min `bookings.created_at` of the person with status in (`confirmed`,`attended`) and `created_at > anchor_at`; `first_paid_order_at`, `first_paid_order_cents` = earliest `orders.paid_at`/`total_cents` with status `paid` after `anchor_at`; `revenue_365d_cents` = sum of paid orders in 365 days after anchor. The report filters on `conversion_window_days` (or the period the user picks), so the view itself has no window.

**`v_person_webinar_stats`**: per person `webinars_registered, webinars_attended_live, replays_watched, on_demand_watched, watch_sec_total, poll_answers, cta_clicks, last_webinar_registered_at, last_webinar_attended_at`. Ops joins it into `v_person_profile` (section 10) so segments can use webinar registration, attendance, watch time, poll and CTA activity.

**`v_webinar_performance_daily`** (R4): per webinar per day: registrations, live attendees, replay viewers, on-demand viewers, average watch minutes per mode, poll answers, CTA clicks. No person ids; exposed to the `ai` schema.

### 2.5 Tables of other modules this module reads or writes

| Table (module) | Access | Why |
| --- | --- | --- |
| `persons`, `activity_events`, `v_consent_current`, `tags`, `person_tags`, `tasks` (crm) | write only through `crm` api / `recordEvent()`; read `persons.first_name, last_name, locale` and `activity_events` in queries | person identity, timeline facts, chat display names, poll tags, question tasks |
| `sessions` (booking) | read; written only through `booking.upsertWebinarSession` | link to the event calendar |
| `bookings` (booking), `orders` (commerce) | read in `v_webinar_conversions` | booking and purchase after the webinar or a CTA |
| `files`, `users`, `jobs`, `audit_log`, `feature_flags` (platform) | read; `files` written for CSV uploads | imports, owners, jobs, audit |
| `email_messages` (email) | written only through `email.sendTransactional` | access link, reschedule and cancel notices |
| `automations`, `automation_versions`, `email_templates`, `email_template_versions`, `retention_policies` | written by the seed `packages/db/src/seed/webinar.ts` only | seeded webinar sequences, templates and retention defaults |
| `ad_spend_daily` (ops, R3) | read | cost per registration |

## 3. Business rules

Each rule names its test file (section 12). Times are UTC in storage and `Europe/Brussels` in display and schedules.

**V1 import**
1. An import row needs a valid email. Rows without one are `skipped` with code `missing_email`; rows with an invalid one are `errors` with code `invalid_email`. The report holds row numbers and codes only.
2. Each row resolves the person with `crm.findOrCreatePersonByEmail` (`lower(email)` match). A new person gets `acquisition = {source: 'webinar', campaign: <external title>}` and `locale` from the row if it is one of the three locales, else `nl-BE`. An existing person's acquisition is never changed.
3. An import never writes `consent_records` or `suppressions`, even if the file has an opt-in column. A suppressed or erased person is still matched for history but an erased person (`erased_at` set) is skipped with code `erased`.
4. Imported facts are `activity_events` with `ref_type = 'external_webinar'`, `ref_id = external_webinars.id`, `data.source = 'import'`, `dedupe_key = extwebinar:<external_webinar_id>:<person_id>:<kind>[:<threshold>]`. Importing the same file twice adds nothing (counts show `skipped`).
5. A registrant row gives `webinar.registered` (mode `live`, `occurred_at` = registered at or the webinar start). An attendee row additionally gives `webinar.attended` (mode `live`, or `replay` when the row says so) and `webinar.threshold_reached` for `15m` and `30m` when watched minutes are given, and `50pct`/`end` when the external webinar has `duration_sec`.
6. A dry run parses, resolves persons read-only and fills `counts` and `report` without writing persons or events.
7. The webhook accepts at most 500 records per call, needs a valid `x-beam-signature` HMAC, and a repeated `event_id` for the same external webinar returns 200 without a second import.

**Webinar lifecycle (R2)**
8. A webinar of mode `live` or `simulive` has `starts_at` and a linked `sessions` row of kind `event` once it leaves `draft`. Publishing calls `booking.upsertWebinarSession`, which keeps the session title and times equal to the webinar's. An `on_demand` webinar has no `starts_at` and no session.
9. Publishing requires: `assertComplete()` for `title`, `description`, every active poll question and option label and every active CTA label over `webinars.locales`; `spoken_locale` in `locales`; a future `starts_at` (live, simulive); `recording_video_id` (simulive, on-demand). A `live` webinar becomes `published` only after `webinar.create_broadcast` succeeded; while it runs `publish_requested_at` is set and the screen shows "creating YouTube broadcast"; if the job is dead, `broadcast_error` is shown and the status stays `draft`.
10. Status moves `draft -> published -> live -> ended -> archived`, or to `cancelled` from `draft`/`published`. `live` is set from YouTube `lifeCycleStatus = live` (live) or `now >= starts_at` (simulive); `ended` from `complete` (live) or `now >= starts_at + duration_sec` (simulive). Staff can force `live`/`ended` from the host console when YouTube status is unavailable.
11. Changing `starts_at` or `title` of a published webinar bumps `version`, updates the broadcast and the session, and emails every `registered` registrant once per version (`webinar-rescheduled`, only when `starts_at` changed by more than 5 minutes). Cancelling emails `webinar-cancelled`, writes `webinar.cancelled` per registration (seeded automations exit on it), deletes the broadcast and cancels the session.
12. A recurring webinar is a series: `duplicateWebinar` copies title, description, locales, mode, polls, CTAs, presenters and settings to up to 26 new `draft` occurrences with the same `series_key` and new slugs `<slug>-<yyyy-mm-dd>`. Each occurrence has its own registrations, broadcast and report.
13. Host and participant links are separate: hosts use the Meet link and `/admin/webinars/[id]/host` (needs `webinars.host`); participants use their personal access link or the portal. A participant link never reveals the Meet URL.

**Registration and access**
14. One registration per person per webinar. Registering again returns the existing registration (status `cancelled` becomes `registered` again) and resends the access email, at most 3 access emails per registration per hour.
15. `registered_mode` is `live` when registering before `live_ended_at` (or before `starts_at + planned duration` when not yet live), `replay` after that, `on_demand` for on-demand webinars. Registration is refused (`webinar.register.closed`) for cancelled or archived webinars, for an ended webinar with replay disabled or expired, and for an ended webinar with `is_replay_gated = true` (gated replays are for people who registered before the end).
16. `person_status` is snapshotted from `crm.getPersonStatus` at registration and never recomputed; reporting splits on this snapshot.
17. Registration is not attendance: registering writes `webinar.registered` only. Nothing in reports or automations treats a registration as attended (acceptance test).
18. Registering never grants marketing consent. The site form shows optional, unticked checkboxes for `events` and `newsletter`; a ticked box writes `consent_records` through `crm.recordConsent` with method `form` and the wording version shown.
19. The access token is `<registration_id>.<token_version>.<mac>` with `mac = base64url(HMAC-SHA256(k, registration_id + '.' + token_version))[0..32]` and `k = HKDF-SHA256(AUTH_SECRET, 'beam-webinar-access-v1')`. `access_token_hash = sha256(token)` is stored for lookup. Verification recomputes the MAC in constant time and checks the hash. Bumping `token_version` revokes old links. Raw tokens are never stored or logged.
20. A token grants viewing and interacting for that one webinar only. It never signs the person into the portal. A logged-in customer reaches the same player at `/[locale]/account/webinars/[id]` without a token.
21. A `blocked` or `cancelled` registration gets `403 webinar.access.blocked` / `webinar.access.cancelled` on every viewer endpoint; a blocked viewer's open player stops at the next heartbeat.

**Modes, watch time and thresholds**
22. The server decides the mode (`resolveMode()` in core): `live` when the webinar is `live` (live) or `now` is within `[starts_at, starts_at + duration_sec)` (simulive); `replay` after the end when the replay is enabled, unexpired and not over its view limit; `on_demand` for on-demand webinars. Before `starts_at - 15 min` the player shows a countdown. A client heartbeat with another mode gets `409 mode_changed` and reloads.
23. Simulive is presented as live: interactions and segments during the scheduled showing carry mode `live`; the player starts at `seekTo(now - starts_at)`, hides seek controls and resyncs when drift exceeds 10 s. After the showing, the same video is a replay.
24. The player sends a heartbeat every 15 s while playing. The server writes one `watch_segments` row per heartbeat. For `live`, `to_sec = floor(now - live_started_at)` and `from_sec = max(0, to_sec - min(15, seconds since the previous heartbeat of this view))`; client positions are ignored. For `replay` and `on_demand`, client positions are clamped to `[0, duration_sec]`, and the span is cut to at most `seconds since the previous heartbeat of this view + 5` and never above 30.
25. Heartbeats of one registration faster than every 10 s are rejected with `429` and write nothing. Paused, buffering and ended states write no segment.
26. Watch time per mode is the merged length of that mode's segments (`v_webinar_watch`, and `mergeIntervals()` in core for the heartbeat; a test asserts both give the same seconds). Watch time of one mode never adds to another (scenario 5).
27. Thresholds per mode: `15m` at 900 s, `30m` at 1,800 s, `50pct` at half of `duration_sec` (or the planned duration while the real one is unknown), `end` when the merged coverage reaches `duration_sec - 60`. `attended` at `attended_min_sec` (default 300 s). Each emits one `activity_events` row per registration per mode (`webinar.attended`; `webinar.threshold_reached` with `data.threshold`), deduped by `webinar:<registration_id>:<mode>:<fact>`, written in the heartbeat transaction.
28. "Started" is the first playing heartbeat or `startView` of a mode: interaction `started` (one per view) and event `webinar.started` (one per registration per mode). Registered, started, attended and watched (thresholds) are four distinct facts.
29. `webinar.finalise` runs once per live or simulive webinar 30 minutes after `live_ended_at`. It writes `webinar.missed` (mode `live`) for every `registered` live registrant without a live `webinar.attended`, and back-fills any live threshold events not yet written. If the webinar never went live by `starts_at + 2 h`, it writes no `webinar.missed`, sets `broadcast_error = 'never_live'` and creates a task for `owner_user_id`.

**Replay and on-demand access**
30. Replay is available from `live_ended_at` once `recording_video_id` is set, until `replay_until_at` (null = no expiry), only when `is_replay_enabled`. On-demand access ends `on_demand_access_days` after the registration when set, and at `replay_until_at` when set, whichever is first.
31. A view is counted when `startView` is called for `replay` or `on_demand` and no `started` interaction of the same registration and mode exists in the last 30 minutes (a reload does not count). When `replay_view_limit` is reached, `startView` returns `webinar.access.limit_reached` and the page says so.
32. Expiry during a view: the next heartbeat returns `stop: 'expired'`; segments up to then are kept.

**Polls, CTAs, chat and questions**
33. A poll accepts one answer per registration per mode (partial unique index). A replay answer and a live answer of the same person are two rows with their own modes and both count, each in its own mode (acceptance: replay poll stored separately). Option keys must exist on the poll; `allow_multiple = false` accepts exactly one key.
34. In live, polls and CTAs appear when the host launches them (`live_launched_at`, `live_shown_at`) and the launch position becomes `show_at_sec` if it was empty, so the replay shows them at the same moment. In simulive, replay and on-demand they appear at `show_at_sec` for `show_for_sec`. A poll without `show_at_sec` never appears outside live.
35. A poll answer writes interaction `poll_answer` and event `webinar.poll_answered` (`data: {poll_key, option_keys}`, mode). For each `tag_rules` entry whose `option_keys` intersect the answer and whose `modes` include the mode, `crm.tagPerson` applies `tag_key` with source `automation`. Tag keys are validated against `tags` when the poll is saved.
36. A CTA shown writes `cta_shown` once per registration per CTA per mode (no timeline event). A click goes through `/api/webinar/cta/[ctaId]`, writes `cta_clicked` and event `webinar.cta_clicked` (first per registration, CTA and mode; `data: {cta_key, url}`), and redirects 302 to the URL with `utm_source=beam-webinar&utm_medium=<mode>&utm_campaign=<slug>&utm_content=<cta_key>` added when absent.
37. Chat and questions: 1-500 characters, at most one message per 3 s and 60 per hour per registration. Live chat is visible to every live viewer unless hidden; questions are visible only to hosts. In replay and on-demand there is no chat; questions are allowed, and each one creates a `tasks` row (kind `follow_up`, source `system`, owner `owner_user_id`, `ref_type = 'webinar_interaction'`). Every question writes event `webinar.question_asked`; the first chat message per registration per mode writes `webinar.chatted`.
38. Chat display name is the first name plus the initial of the last name, read at display time; an erased person's messages disappear with the registration.

**Reporting**
39. Reports split by `person_status` snapshot (`lead`, `customer`, `member`) and total. Per mode they show registered, started, attended or watched, 15m, 30m, 50 %, end, average watch minutes, poll responses, CTA shown and clicked; then booked and purchased within the period, revenue in the period and conversion rate = persons with a first booking or paid order within the period ÷ registrations.
40. The period defaults to `webinars.conversion_window_days` and can be set in the report to 7, 14, 30, 60, 90 or 180 days. Conversion is counted from `anchor_at` (rule-defined in `v_webinar_registration_facts`); "booking after CTA" and "purchase after CTA" are counted from the first click of that CTA.
41. The aggregate report CSV contains no personal data. The registrant CSV (name, email, status, per-mode facts) needs `persons.export` in addition to `webinars.host` and is audited (`webinar.registrants_exported`).

## 4. Server surface

Files: `apps/web/modules/webinar/{actions,queries,api,jobs,schedules,events,permissions,nav,privacy,seed,merge-fields}.ts`; internals split into `apps/web/modules/webinar/server/{import,lifecycle,registration,viewer,interactions,report}.ts` re-exported by the barrel files. Zod inputs live in `packages/core/src/webinar/schemas.ts`. All actions use `action({ name, audience, permission, input, audit })`; staff writes are audited with `audit: 'webinars'`.

### 4.1 Event kinds (`events.ts`, `defineEvent`)

| Kind | `mode` column | `data` | Written by |
| --- | --- | --- | --- |
| `webinar.registered` | registered_mode | `{webinar_id, slug, title, webinar_mode, starts_at, registration_id, session: {id, kind: 'event'} \| null, person_status, source, utm}`; import: `{external_webinar_id, title, source: 'import'}` | register paths, import |
| `webinar.registration_cancelled` | registered_mode | `{webinar_id, registration_id, by: 'customer'\|'staff'}` | cancel actions |
| `webinar.started` | mode | `{webinar_id, registration_id}` | first view of a mode |
| `webinar.attended` | mode | `{webinar_id, registration_id, watched_sec}`; import adds `source` | heartbeat, finalise, import |
| `webinar.threshold_reached` | mode | `{webinar_id, registration_id, threshold: '15m'\|'30m'\|'50pct'\|'end', watched_sec}` | heartbeat, finalise, import |
| `webinar.missed` | `live` | `{webinar_id, registration_id}` | finalise |
| `webinar.poll_answered` | mode | `{webinar_id, registration_id, poll_key, option_keys}` | interact route |
| `webinar.cta_clicked` | mode | `{webinar_id, registration_id, cta_key, url}` | CTA redirect |
| `webinar.question_asked` | mode | `{webinar_id, registration_id, interaction_id}` (no text) | interact route |
| `webinar.chatted` | mode | `{webinar_id, registration_id}` | interact route |
| `webinar.cancelled` | null | `{webinar_id, registration_id, reason}` | cancelWebinar |
| `webinar.rescheduled` | null | `{webinar_id, registration_id, starts_at, previous_starts_at}` | updateWebinar |

`ref_type = 'webinar_registration'`, `ref_id = registration id` on every native event; `actor` is the customer, staff user or `system`. None is `is_sensitive`.

### 4.2 Server actions

| Action (`name`) | Audience / permission | Input (Zod summary) | Output | Writes |
| --- | --- | --- | --- | --- |
| `uploadWebinarImport` (`webinar.import_upload`) V1 | staff / `webinars.host` | `{file: File(csv, <= 10 MB), preset, externalWebinar: {provider, externalId, title, startsAt?, durationSec?}, mapping?: Record<string, ImportField>, dryRun: boolean}` | `{importId}` | `files` (kind `import`, expires 30 d), `external_webinars` upsert, `webinar_imports`; enqueue `webinar.process_import` chunk 0; audit `webinar.import_started` |
| `commitWebinarImport` (`webinar.import_commit`) V1 | staff / `webinars.host` | `{importId}` (a finished dry run) | `{importId}` | new non-dry `webinar_imports` row with the same file; audit `webinar.import_committed` |
| `createWebinar` | staff / `webinars.host` | `{slug, mode, title, description, locales, spokenLocale, startsAt?, plannedDurationMinutes, ownerUserId}` | `{webinarId}` | `webinars` (draft); audit `webinar.created` |
| `updateWebinar` | staff / `webinars.host` | `{webinarId, version, ...partial settings}` | `{version}` | `webinars`; when published: `booking.upsertWebinarSession`, jobs `webinar.update_broadcast`, `webinar.notify_registrants` (reason `rescheduled`), events `webinar.rescheduled`; audit `webinar.updated` with old/new |
| `publishWebinar` | staff / `webinars.host` | `{webinarId, version}` | `{status: 'published'\|'publishing'}` | checks rule 9; live: `publish_requested_at`, jobs `webinar.create_broadcast`, `webinar.create_meet_space`; others: status `published`, `published_at`, session upsert; audit `webinar.published` |
| `cancelWebinar` | staff / `webinars.host` | `{webinarId, reason (3-500), notify: boolean}` | `{cancelledRegistrations}` | status `cancelled`; jobs `webinar.delete_broadcast`, `webinar.notify_registrants` (reason `cancelled`) when notify; `booking.cancelWebinarSession`; events `webinar.cancelled`; audit |
| `archiveWebinar` | staff / `webinars.host` | `{webinarId}` | `{}` | status `archived` (only from `ended`, `cancelled`, or on-demand `published`); audit |
| `duplicateWebinar` | staff / `webinars.host` | `{webinarId, startsAt: Date[] (1-26), seriesKey?}` | `{webinarIds}` | new drafts with copies; audit `webinar.duplicated` |
| `setWebinarVideo` | staff / `webinars.host` | `{webinarId, field: 'youtube_video_id'\|'recording_video_id', videoId}` | `{}` | override (e.g. Meet created its own broadcast); enqueues `webinar.fetch_recording` with key `webinar:<id>:recording:set:<videoId>` to validate the id and read `duration_sec`; audit `webinar.video_set` |
| `upsertPoll`, `deletePoll` | staff / `webinars.host` | `{webinarId, pollId?, key, question, options, allowMultiple, showAtSec?, showForSec, tagRules, sortOrder}` / `{pollId}` | `{pollId}` | `webinar_polls`; delete only without answers, else `is_active = false`; audit |
| `upsertCta`, `deleteCta` | staff / `webinars.host` | `{webinarId, ctaId?, key, label, url, showAtSec?, showForSec, sortOrder}` / `{ctaId}` | `{ctaId}` | `webinar_ctas`; same delete rule; audit |
| `upsertPresenter`, `removePresenter` | staff / `webinars.host` | `{webinarId, presenterId?, userId? \| email?, displayName, role}` | `{presenterId}` | external email -> `crm.findOrCreatePersonByEmail` (no consent); audit |
| `launchPoll`, `closePoll`, `showCta`, `hideCta` | staff / `webinars.host` | `{pollId}` / `{ctaId}` | `{}` | `live_*` columns; `show_at_sec` when empty |
| `moderate` | staff / `webinars.host` | `{webinarId, action, interactionId?, registrationId}` | `{}` | `webinar_moderation_actions`; block/unblock also sets `webinar_registrations.status`, `blocked_at`, `blocked_by_user_id`; audit `webinar.moderated` |
| `forceLiveState` | staff / `webinars.host` | `{webinarId, to: 'live'\|'ended'}` | `{}` | `live_started_at` / `live_ended_at`, status; audit |
| `registerPersonByStaff` | staff / `webinars.host` + `persons.read` | `{webinarId, personId, sendAccessEmail}` | `{registrationId}` | as rule 14, source `admin`; audit |
| `cancelRegistrationByStaff`, `resendAccessLink`, `revokeAccessLink` | staff / `webinars.host` | `{registrationId}` | `{}` | status / email / `token_version + 1`; audit |
| `registerForWebinar` | customer | `{webinarId, locale, consents: {events?: boolean, newsletter?: boolean}, wordingVersion}` | `{registrationId, watchPath}` | registration (source `portal`), event, consent, email `webinar-access` |
| `cancelMyRegistration` | customer | `{registrationId}` (must be own) | `{}` | status `cancelled`, `cancelled_at`, event |
| `exportWebinarRegistrants` | staff / `webinars.host` + `persons.export` | `{webinarId}` | `{fileId}` (kind `export`, 7-day expiry) | `files`; audit `webinar.registrants_exported` |

Every registration path calls one core-backed function `registerPerson(tx, ctx, {webinarId, personId, source, locale, utm, consents})` in `server/registration.ts`, which enqueues `email.send` through `email.sendTransactional(tx, ctx, {template: 'webinar-access', personId, locale, variables: {webinarId, registrationId}, key: 'webinar:<registration_id>:access:<n>'})`.

### 4.3 Queries (`queries.ts`)

`listWebinars({status?, mode?, q?, page})`, `getWebinar(id)`, `getWebinarBySlug(slug, locale)` (public: published, live, ended with replay only), `listRegistrations(webinarId, {status?, personStatus?, q?, page})` (needs `persons.read`), `getHostConsoleState(webinarId)`, `getWebinarReport(webinarId, {periodDays})`, `getPollResults(webinarId)` (per option per mode), `getCtaResults(webinarId, {periodDays})`, `listMyWebinars(personId)` (portal: upcoming, replays available, on-demand library), `listImports({page})`, `getImport(id)`. Report queries read only the views of section 2.4.

### 4.4 Route handlers (all `runtime = 'nodejs'`, `dynamic = 'force-dynamic'`)

| Route | Method | Auth | Input | Output | Writes |
| --- | --- | --- | --- | --- | --- |
| `/api/public/webinars/[slug]/register` | POST | public, rate limit 20/min/IP, honeypot field | `{email, firstName, lastName?, locale, consents, wordingVersion, utm}` | always `202 {ok: true}` (no account enumeration) | person (`crm.findOrCreatePersonByEmail`, acquisition `webinar`), registration (source `site`), event, consents, access email |
| `/api/webinar/view` | POST | viewer (token header `x-webinar-token` or customer session) | `{webinarId}` | `{viewId, mode, videoId, startSec, durationSec, controls: boolean, polls, ctas, chatEnabled, questionsEnabled}` or `{error: 'not_started'\|'expired'\|'limit_reached'\|'blocked'\|'cancelled'}` | `started` interaction, `webinar.started` |
| `/api/webinar/heartbeat` | POST | viewer | `{webinarId, viewId, mode, fromSec, toSec, state: 'playing'\|'paused'\|'buffering'\|'ended'}` | `{ok, nextMs: 15000, stop?: 'blocked'\|'expired'\|'mode_changed'}` | `watch_segments`, threshold and attended events; `ended` interaction on state `ended` |
| `/api/webinar/state` | GET | viewer | `?webinarId&after=<ISO>` | `{status, activePoll?, activeCta?, chat: [{id, name, text, at}], myAnswers}`; shared part memoised 2 s per webinar per instance | none |
| `/api/webinar/interact` | POST | viewer | discriminated union `{type: 'poll_answer', pollId, optionKeys}` \| `{type: 'chat'\|'question', text}` \| `{type: 'cta_shown', ctaId}` plus `{webinarId, viewId, atSec}` | `{ok}` / `409 already_answered` / `429` | interactions, events, tags, tasks |
| `/api/webinar/cta/[ctaId]` | GET | viewer token in `?t=` or session | | 302 to the CTA URL | `cta_clicked`, `webinar.cta_clicked` |
| `/api/webhooks/webinar-import` V1 | POST | HMAC `x-beam-signature: sha256=<hex>` over the raw body with `WEBINAR_IMPORT_WEBHOOK_SECRET` | `{provider, event_id, webinar: {external_id, title, starts_at?, duration_sec?}, records: [{email, first_name?, last_name?, locale?, registered_at?, attended?, joined_at?, watched_minutes?, mode?: 'live'\|'replay'}] (1-500)}` | 200 within 2 s | `external_webinars` upsert, `webinar_imports` (source `webhook`, payload), job `webinar.process_import` |

The viewer resolver `resolveViewer(req, webinarId)` (`server/viewer.ts`) returns `{registration, webinar, via: 'token'|'session'}` or a typed error; it never accepts a token for another webinar. The heartbeat route is exempt from the 60/min per-IP WAF rule (a group in the centre shares one IP) and is limited per registration instead (rule 25).

### 4.5 Jobs (`jobs.ts`, `defineJob`)

| Kind | Lane, priority | Key | Retry | Does |
| --- | --- | --- | --- | --- |
| `webinar.process_import` | bulk, 9 | `webinar_import:<import_id>:chunk:<n>` | default 6; bad file -> `PermanentError`, import `failed` | 500 rows per chunk, enqueues chunk n+1; last chunk sets `done`, `finished_at`, nulls `payload` |
| `webinar.create_broadcast` | fast, 3 | `webinar:<id>:broadcast` | 6; 4xx -> `PermanentError` with `broadcast_error` | finds an existing broadcast by description marker `beam-webinar:<id>` before creating; inserts unlisted broadcast + stream, binds, stores ids, sets `published` and `published_at` |
| `webinar.update_broadcast` | fast, 3 | `webinar:<id>:broadcast_update:v<version>` | 6 | title, description, scheduled start |
| `webinar.delete_broadcast` | fast, 5 | `webinar:<id>:broadcast_delete` | 6; 404 = success | deletes an unstarted broadcast; a completed one is kept for the recording |
| `webinar.create_meet_space` | fast, 5 | `webinar:<id>:meet` | 6; failure leaves `host_meet_url` empty and staff paste one | Meet REST v2 `spaces.create`, stores `host_meet_url`, `meet_space_name` |
| `webinar.sync_status` | fast, 2 | `webinar:<id>:status:<YYYY-MM-DDTHH:mm>` | 2 (the next minute retries anyway) | live: `liveBroadcasts.list(id)`; sets `youtube_lifecycle`, `live_started_at`, `live_ended_at`, status. Simulive: pure time rule, no API call |
| `webinar.fetch_recording` | fast, 5 | `webinar:<id>:recording:<YYYY-MM-DDTHH:mm>` | 3 | `videos.list(id, contentDetails,processingDetails)`; when processed sets `recording_video_id` (if empty) and `duration_sec` |
| `webinar.finalise` | fast, 5 | `webinar:<id>:finalise` | 6 | rule 29; sets `finalised_at` |
| `webinar.notify_registrants` | bulk, 5 | `webinar:<id>:notify:<reason>:v<version>:chunk:<n>` | 6 | 200 registrations per chunk; `email.sendTransactional` with key `webinar:<registration_id>:notice:<reason>:v<version>` |

Every handler is idempotent: a second run with the same payload leaves the same state (`jobs.test.ts`).

### 4.6 Schedules (`schedules.ts`, cron in `Europe/Brussels`)

| Schedule | Cron | Enqueues |
| --- | --- | --- |
| `webinar.scan_live` | `* * * * *` | `webinar.sync_status` for webinars with mode `live`/`simulive`, status `published` and `starts_at` within the next 30 min or past, or status `live` |
| `webinar.scan_recordings` | `*/10 * * * *` | `webinar.fetch_recording` for `live` webinars `ended` less than 48 h ago without `duration_sec` |
| `webinar.scan_finalise` | `*/5 * * * *` | `webinar.finalise` for webinars `ended` with `live_ended_at <= now() - 30 min`, or `published` with `starts_at + 2 h <= now()`, and `finalised_at is null` |

### 4.7 Cross-module API (`apps/web/modules/webinar/api.ts`)

```ts
import type { DbOrTx, Tx } from '@beam/db';
import type { Locale, LocalizedText } from '@beam/core/i18n';
import type { WatchMode, WebinarMode, WebinarStatus } from '@beam/core/webinar';

export type WebinarSummary = { id: string; slug: string; title: LocalizedText; mode: WebinarMode;
  status: WebinarStatus; startsAt: Date | null; sessionId: string | null; spokenLocale: Locale; landingPath: string };
export type PersonWebinarRow = { registrationId: string; webinarId: string; title: LocalizedText; mode: WebinarMode;
  registeredMode: WatchMode; status: 'registered' | 'cancelled' | 'blocked'; startsAt: Date | null;
  watchedSec: Record<WatchMode, number>; attended: Record<WatchMode, boolean> };
export type PersonWebinarStats = { webinarsRegistered: number; webinarsAttendedLive: number; replaysWatched: number;
  onDemandWatched: number; watchSecTotal: number; pollAnswers: number; ctaClicks: number;
  lastRegisteredAt: Date | null; lastAttendedAt: Date | null };
export type WebinarKpis = { webinars: number; registrations: number; liveAttendanceRate: number; replayViewRate: number;
  conversionRate: number; revenueCents: number;
  bySegment: Record<'lead' | 'customer' | 'member', { registrations: number; attended: number; converted: number }>;
  byUtmCampaign: Array<{ campaign: string | null; registrations: number; attended: number; converted: number }> };

export function getWebinarForSession(db: DbOrTx, sessionId: string): Promise<WebinarSummary | null>;
export function listPublicWebinars(db: DbOrTx, opts: { locale: Locale; from: Date; limit: number }): Promise<WebinarSummary[]>;
export function listPersonWebinars(db: DbOrTx, personId: string): Promise<PersonWebinarRow[]>;
export function getPersonWebinarStats(db: DbOrTx, personId: string): Promise<PersonWebinarStats>;
export function getAccessUrl(db: DbOrTx, registrationId: string, locale: Locale): Promise<string>; // absolute https URL /<l>/w/<token>
export function mergePersons(tx: Tx, winnerPersonId: string, loserPersonId: string): Promise<{ moved: number; collapsed: number }>;
export function getWebinarKpis(db: DbOrTx, input: { from: Date; to: Date; periodDays: number }): Promise<WebinarKpis>; // R3
export function getWebinarWeeklyFacts(db: DbOrTx, weekStart: Date): Promise<Array<{ fact: string; value: number }>>; // R4
export function countWebinarLeadsWithoutBooking(db: DbOrTx, input: { attendedSince: Date }): Promise<number>; // ops action dashboard
```

### 4.8 Seeds (`packages/db/src/seed/webinar.ts`, `apps/web/modules/webinar/seed.ts`)

| Automation (slug) | Group | Marketing | Status | Trigger | Steps |
| --- | --- | --- | --- | --- | --- |
| `webinar-reminders` | `transactional` | no | active | `webinar.registered` where `mode = 'live'` and `data.source` is not `import` (imported history never enrols), anchor `data.starts_at` | `d7` -10080 min `webinar-reminder-7d`; `d1` -1440 min `webinar-reminder-1d`; `h1` -60 min `webinar-reminder-1h`; `now` 0 min `webinar-starting-now`; `re_entry: "after_days:0"`; exit on `webinar.cancelled`, `webinar.registration_cancelled`, `webinar.rescheduled` (edge case 9). The access email is not a step: it is sent immediately by the registration (rule 14). A Friday registrant for a Sunday webinar gets `d1`, `h1` and `now`; `d7` is `skipped_late_entry` (scenario 1) |
| `webinar-follow-up-attended` | `webinar` | yes, purpose `events` | paused | `webinar.attended` where `mode = 'live'` | +1440 min `webinar-follow-up`; +2880 min task "Call webinar attendee" for role sales `unless has_future_booking`; exit on `order.paid` |
| `webinar-follow-up-missed` | `webinar` | yes, purpose `events` | paused | `webinar.missed` | +120 min `webinar-missed` (replay link) when the replay is enabled; exit on `webinar.attended` |
| `webinar-cta-sales-task` | `webinar` | no | paused | `webinar.cta_clicked` | +2880 min task "Follow up CTA click" `unless has_future_booking`; exit on `order.paid` |

Also seeded: the seven email templates of section 8, the four retention policies of section 9.2, flag `ff_webinar_portal = off`, and in non-production one demo webinar of each mode with polls, CTAs and fake YouTube ids.

`merge-fields.ts` exports `{ 'webinar.access_url': ({tx, context, locale}) => getAccessUrl(tx, context.registration_id, locale), 'webinar.title': ..., 'webinar.starts_at_local': ... }` for the email renderer (section 10).

## 5. Screens

All lists use `DataTable` from `@beam/ui`; loading states are skeleton rows from `loading.tsx`; errors render the shared `error.tsx` with the request id and a Retry button; every string comes from the `webinar` catalogue.

### 5.1 Staff back-office (`app/(admin)/admin/webinars/...`, nav entry "Webinars", needs `webinars.host`)

| Route | Shows | Actions | Empty state | Permission |
| --- | --- | --- | --- | --- |
| `/admin/webinars` | Tabs Upcoming, Live now, Ended, On-demand, Drafts, Cancelled. Columns: title (staff locale), mode, starts (Brussels time), status badge, registrations, live attendees, replay viewers | New webinar, Import from current tool (V1 link) | "No webinars yet. Create one or import from your current tool." | `webinars.host` |
| `/admin/webinars/import` (V1) | Upload form (preset, external webinar id, title, start, duration, dry-run checkbox), last 20 imports with counts | Upload, open import | "No imports yet." | `webinars.host` |
| `/admin/webinars/import/[importId]` (V1) | Status, counts, report rows (row number + code), webhook payload size | Commit (after a dry run), Back | "Processing..." while `running` (page polls every 3 s) | `webinars.host` |
| `/admin/webinars/new` | Mode picker, slug, title and description (`LocalizedInput`), locales, spoken language, start, planned duration, owner | Save draft | n/a | `webinars.host` |
| `/admin/webinars/[id]` | Details form with completeness badges; broadcast panel (YouTube video id, lifecycle, `broadcast_error` in red, "creating YouTube broadcast" spinner while `publish_requested_at` is set); Meet link; replay settings (enabled, gated, until, view limit, on-demand days); thresholds (attended minutes, conversion window); presenters list; series occurrences | Save, Publish (lists missing locales on failure), Cancel (reason, notify), Archive, Duplicate to dates, Use different YouTube video | n/a | `webinars.host` |
| `/admin/webinars/[id]/interactive` | Polls and CTAs with key, texts, timing (`mm:ss`), tag rules, answer counts per mode | Add, edit, deactivate, reorder | "No polls or CTAs. Add one to engage viewers." | `webinars.host` |
| `/admin/webinars/[id]/registrations` | Registrants: name, email, status snapshot, registered mode, source, live/replay/on-demand watch minutes, thresholds, last activity | Register a person, Cancel, Resend link, Revoke link, Block, Export CSV (`persons.export`) | "Nobody registered yet. Share the landing page: <url>." | `webinars.host` + `persons.read` |
| `/admin/webinars/[id]/host` | Host console. Left: Meet link (host link), YouTube Studio link, live status, viewer count (registrations with a segment in the last 30 s), elapsed time. Middle: polls and CTAs with Launch/Close/Show/Hide and live results. Right: chat stream and questions queue | Launch poll, Show CTA, Hide message, Mark answered, Block viewer, Force live, Force ended | "Waiting for the stream. Start streaming from Meet: Activities > Live streaming." | `webinars.host` |
| `/admin/webinars/[id]/report` | Period selector (7, 14, 30, 60, 90, 180 days; default the webinar's window); summary cards; table by lead/customer/member/total and by mode (rule 39); poll results per option per mode; CTA table (shown, clicked, CTR, booked after, purchased after); UTM table (source, campaign, registrations, attended, converted) | Download aggregate CSV, Download registrants CSV (`persons.export`) | "No registrations yet." | `webinars.host` or `reports.read` |

The person page timeline (crm) shows the webinar events with a mode badge; this module provides `listPersonWebinars()` for a "Webinars" card there.

### 5.2 Customer portal (`app/[locale]/(portal)/account/webinars/...`, behind flag `ff_webinar_portal`)

| Route | Shows | Actions | Empty / error |
| --- | --- | --- | --- |
| `/[locale]/account/webinars` | Three lists: Upcoming (registered, with countdown and "add to calendar" .ics), Watch again (replays still available, with expiry and views left), On-demand library (published on-demand webinars in the visitor's locale list) | Register (one click, consent checkboxes shown once), Cancel registration, Watch | "You have no webinars yet." plus the public list |
| `/[locale]/account/webinars/[id]` | The player page (component `WebinarPlayer` shared with `/w/[token]`) | Watch, answer polls, click CTAs, chat, ask questions | not registered -> register card; `not_started` -> countdown; `expired` / `limit_reached` / `blocked` -> message with contact link |

### 5.3 Public (`app/[locale]/(site)/...`, behind `ff_webinar_portal`)

| Route | Shows | Actions | States |
| --- | --- | --- | --- |
| `/[locale]/webinars` | Upcoming and on-demand webinars available in the URL locale | Open | "No webinars planned right now." |
| `/[locale]/webinars/[slug]` | Landing page: title, description, date in Brussels time, spoken language ("This webinar is in Dutch"), presenters' display names, registration form (email, first name, last name, unticked consent boxes for `events` and `newsletter` with versioned wording) | Register -> confirmation "Check your inbox" | not in this locale -> "not available in your language" with a locale switch; cancelled -> notice; ended without replay -> "This webinar has ended" |
| `/[locale]/webinars/[slug]/join` | Lost-link page: enter email; if a registration exists the access email is resent (same 202 answer either way) | Send my link | rate limited as registration |
| `/[locale]/w/[token]` | Token player: same `WebinarPlayer`; header shows the person's first name and "not you?" (link to the landing page) | as portal player | invalid or revoked token -> "This link is no longer valid" with the join page link |

`WebinarPlayer` (`apps/web/modules/webinar/ui/webinar-player.tsx`, client component): first shows a click-to-load notice (Google/YouTube processes connection data; wording version `player_notice_v1`), then loads the IFrame Player API from `https://www.youtube-nocookie.com` with `rel=0`, `modestbranding=1`, `playsinline=1`, `controls` off for live and simulive. It calls `/api/webinar/view`, sends heartbeats every 15 s via `navigator.sendBeacon` on page hide, polls `/api/webinar/state` every 5 s in live (every 30 s otherwise), renders the poll card, CTA button, chat and question box, and on player error shows the unlisted `youtube.com/watch?v=` link with a note that it leaves BEAM.

## 6. Integrations

All calls go through `packages/integrations/src/youtube/` (`client.ts`, `fake.ts`, `types.ts`), constructed with `{ clientId, clientSecret, refreshToken: GOOGLE_OAUTH_REFRESH_TOKEN, onCall }`. `onCall` writes `integration_calls` (provider `youtube`; operation names below; never bodies). Called only from the jobs of section 4.5. OAuth scopes: `https://www.googleapis.com/auth/youtube` and `https://www.googleapis.com/auth/meetings.space.created` on BEAM's own Google account (Workspace).

| Operation | API | Used by | Failure handling | Idempotency |
| --- | --- | --- | --- | --- |
| `findBroadcastByMarker(marker)` | YouTube Data v3 `liveBroadcasts.list?mine=true&broadcastStatus=upcoming&maxResults=50`, match on description | `create_broadcast` | retryable | the marker `beam-webinar:<id>` makes a retry after a lost response reuse the broadcast |
| `createBroadcast({title, description, scheduledStartAt})` | `liveBroadcasts.insert` with `privacyStatus: unlisted`, `enableAutoStart: true`, `enableAutoStop: true`, `recordFromStart: true`, `enableDvr: false`, `latencyPreference: low`, `enableEmbed: true`, `madeForKids: false`; then `liveStreams.insert` and `liveBroadcasts.bind` | `create_broadcast` | 400/403 -> `PermanentError`, message stored in `broadcast_error`; 5xx/429 -> retry with backoff | marker search first; ids stored before the job returns |
| `updateBroadcast(id, patch)` | `liveBroadcasts.update` | `update_broadcast` | 404 -> `PermanentError` and `broadcast_error`; others retry | update is a full PUT of the same values |
| `deleteBroadcast(id)` | `liveBroadcasts.delete` | `delete_broadcast` | 404 counts as done | |
| `getBroadcast(id)` | `liveBroadcasts.list?id=` (`status`, `snippet.actualStartTime`, `actualEndTime`) | `sync_status` | retry next minute; after 10 consecutive failures during a live window a Slack line via `notify.slack` | read-only |
| `getVideo(id)` | `videos.list?part=contentDetails,processingDetails,status` | `fetch_recording` (also validates an id set by `setWebinarVideo`: the action only stores it, the next scan checks it and writes `broadcast_error = 'video_not_found'` when YouTube does not know it) | not processed yet -> try again at the next scan for 48 h | read-only |
| `createMeetSpace()` | Google Meet REST v2 `spaces.create` (`accessType: TRUSTED`) | `create_meet_space` | permanent -> staff paste a Meet URL | key `webinar:<id>:meet`; a stored `meet_space_name` short-circuits |

Quota: a published live webinar costs about 150 units for creation and about 1 unit per minute of status sync in its window, far below the default 10,000 units per day. `fake.ts` keeps broadcasts, streams, videos and spaces in memory, lets tests script lifecycle transitions (`fake.setLifecycle(id, 'live', at)`), processing (`fake.markProcessed(id, durationSec)`) and failures (`fake.failNext(op, {status: 403})`).

Browser side: the YouTube IFrame Player API is loaded by the viewer's browser only after the click-to-load notice; the server never calls YouTube in a request. The CSP in `next.config.ts` (platform) must allow `frame-src https://www.youtube-nocookie.com` and `script-src https://www.youtube.com/iframe_api https://www.youtube.com/s/player/` (requested from platform, section 10).

V1 stopgap integration: no outbound calls. WebinarGeek or Zoom data arrives as CSV upload or through the signed webhook (Zapier "Webhooks by Zapier" POST) described in section 4.4. Email delivery uses the email module (Resend) through `email.sendTransactional`; this module never calls Resend directly.

## 7. Permissions and audit

This module declares one permission in `permissions.ts`: `webinars.host` (already in the architecture list). It reuses `persons.read`, `persons.export` and `reports.read`. Default holders follow the architecture role table: owner, technical_admin, management and marketing have `webinars.host`; customer_service, sales and reception do not.

| Capability | Permission |
| --- | --- |
| See `/admin/webinars`, create, edit, publish, cancel, archive, duplicate, set videos | `webinars.host` |
| Polls, CTAs, presenters | `webinars.host` |
| Host console, launch polls and CTAs, moderate chat, block viewers, force live state | `webinars.host` |
| V1 import (upload, commit) | `webinars.host` |
| Registrant list, register a person, resend or revoke a link | `webinars.host` + `persons.read` (second check with `ctx.require('persons.read')`) |
| Registrant CSV export | `webinars.host` + `persons.export` |
| Webinar report (aggregate, no PII) | `webinars.host` or `reports.read` (sales and customer_service see reports) |
| Customer: register, cancel own registration, watch own webinars | customer session (own `personId` only) or a valid access token |
| external_partner | nothing in this module |

Audited actions (`audit_log`, `entity_type` in parentheses): `webinar.import_started`, `webinar.import_committed` (`webinar_import`); `webinar.created`, `webinar.updated` (old and new values of changed columns), `webinar.published`, `webinar.cancelled`, `webinar.archived`, `webinar.duplicated`, `webinar.video_set`, `webinar.live_forced` (`webinar`); `webinar.poll_saved`, `webinar.poll_deleted`, `webinar.cta_saved`, `webinar.cta_deleted`, `webinar.presenter_saved`, `webinar.presenter_removed`; `webinar.moderated` (`webinar_registration`, with the action); `webinar.registration_added_by_staff`, `webinar.registration_cancelled_by_staff`, `webinar.access_link_resent`, `webinar.access_link_revoked`; `webinar.registrants_exported` (`webinar`, with the row count). Launching and closing polls or CTAs in the host console are not audited (they are visible in the data through `live_*` columns). Customer actions are not audited; they are timeline events.

`permissions.test.ts` asserts every staff action refuses without its permission, `registerPersonByStaff` refuses without `persons.read`, and `exportWebinarRegistrants` refuses without `persons.export`.

## 8. Multi-language and content

- Catalogue namespace `webinar` in `packages/core/src/i18n/messages/{en,nl-BE,fr-BE}/webinar.json`; `en` is the source; `pnpm i18n:check` enforces parity. Key groups: `webinar.admin.list.*`, `webinar.admin.form.*`, `webinar.admin.import.*`, `webinar.admin.interactive.*`, `webinar.admin.registrations.*`, `webinar.admin.host.*`, `webinar.admin.report.*`, `webinar.portal.list.*`, `webinar.player.*` (countdown, notice, poll, cta, chat, question, errors `not_started|expired|limit_reached|blocked|cancelled|mode_changed`), `webinar.public.landing.*`, `webinar.public.join.*`, `webinar.public.token.*`, `webinar.register.*` (form labels, consent wording per version, errors `closed|rate_limited`), `webinar.errors.*`, `webinar.enum.mode.*`, `webinar.enum.status.*`, `webinar.enum.threshold.*`.
- `LocalizedText` fields: `webinars.title`, `webinars.description`, `webinar_polls.question`, `webinar_polls.options[].label`, `webinar_ctas.label`. Edited with `LocalizedInput` limited to `webinars.locales`.
- Not localised by design: `external_webinars.title` (one title in the old tool), presenter `display_name`, chat and question text (shown as written), the video itself (one `spoken_locale`, shown on the landing page and in the portal list).
- Publish-time check (rule 9): `assertComplete(text, webinar.locales)` for every field above on active polls and CTAs; adding a poll or CTA to a published webinar runs the same check on save. The publish error lists `{field, missing: Locale[]}`.
- A visitor on a locale outside `webinars.locales` sees the "not available in your language" page with a locale switch; the registration's `locale` drives every email for it.
- Transactional react-email templates in `packages/email/src/templates/webinar/`: `webinar-access.tsx` (confirmation with personal link, date, `.ics` attachment, spoken language), `webinar-rescheduled.tsx`, `webinar-cancelled.tsx`. Subjects and bodies come from the `webinar` catalogue (`webinar.email.access.*`, ...), so a missing key fails `i18n:check` before deploy.
- Seeded block templates (rows in `email_templates`, purpose shown): `webinar-reminder-7d`, `webinar-reminder-1d`, `webinar-reminder-1h`, `webinar-starting-now` (transactional, purpose null), `webinar-replay-available`, `webinar-missed`, `webinar-follow-up` (marketing, purpose `events`). They use merge fields `{{webinar.title}}`, `{{webinar.starts_at_local}}`, `{{webinar.access_url}}`. All three locales are seeded complete.
- Dates use `Intl.DateTimeFormat(locale, {timeZone: 'Europe/Brussels'})`; the `.ics` file carries UTC times and `TZID=Europe/Brussels`.

## 9. Privacy

### 9.1 `privacy.ts` registration

```ts
export const webinarPrivacy = {
  tables: ['webinar_registrations', 'watch_segments', 'webinar_interactions', 'webinar_moderation_actions', 'webinar_presenters'],
  export: (tx, personId) => Promise<Record<string, unknown[]>>,
  erase: (tx, personId) => Promise<Array<{ table: string; rows: number; action: 'deleted' | 'anonymised' | 'retained_legal' }>>,
};
```

`NO_PII_TABLES` additions: `external_webinars`, `webinar_imports` (report holds row numbers and codes only; webhook `payload` is nulled after processing and covered by a 30-day retention), `webinars`, `webinar_polls`, `webinar_ctas`.

| Table | Person data | Export includes | Erase does | Why |
| --- | --- | --- | --- | --- |
| `webinar_registrations` | person_id, utm, locale, status snapshot | one row per webinar: title (registration locale), mode, registered mode, status, source, registered and cancelled dates, utm | **deleted** | architecture: registrations are deleted on erasure; no legal retention applies |
| `watch_segments` | viewing behaviour | per webinar per mode: merged watch seconds and thresholds (from `v_webinar_watch`) plus the raw segments CSV | **deleted** (cascade from registration, under `SET LOCAL beam.allow_rewrite = 'on'`) | profiling data, no retention ground |
| `webinar_interactions` | poll answers, CTA clicks, chat and question text | every row with webinar title, mode, kind, poll question and chosen option labels, CTA label, text, time | **deleted** (cascade) | free text and behaviour; no retention ground |
| `webinar_moderation_actions` | refers to the person's registration | actions taken on the person's messages (without the staff name) | **deleted** (cascade) | |
| `webinar_presenters` | person_id of external presenters | presenter roles and display names | **deleted** | |

Erase runs before crm anonymises `persons` (dependency order in `GDPR_REGISTRY`: webinar before crm). Aggregate counts in past reports drop by the erased person; that is accepted. `activity_events` with kind `webinar.*` are erased by crm with the rest of the timeline. Tags applied from poll answers are `person_tags` rows erased by crm. Tasks created from questions carry only `ref_id` and the generic title "Webinar question from a viewer"; the question text is never copied into the task. YouTube receives no BEAM identity, so there is nothing to delete at Google; the report states "Google/YouTube: no personal data sent by BEAM".

### 9.2 Retention policies (seeded rows in `retention_policies`)

| key | table | days | action |
| --- | --- | --- | --- |
| `webinar_watch_segments` | `watch_segments` | 730 | delete |
| `webinar_interactions` | `webinar_interactions` | 730 | delete |
| `webinar_registrations` | `webinar_registrations` | 1095 (counted from `created_at`) | delete (cascades segments, interactions, moderation) |
| `webinar_imports` | `webinar_imports` | 30 | delete (the CSV file expires through `files.expires_at` = 30 days) |

Watch segments and interactions follow the architecture (2 years); registrations follow the marketing profile and form submission rule (3 years).

### 9.3 Google as subprocessor (blueprint 18 "GDPR/subprocessor implications", 58, 66)

- **Roles.** Google Ireland Ltd provides YouTube (video delivery) and Google Workspace (Meet). For Meet, Google is BEAM's processor under the Workspace Data Processing Amendment. For the embedded YouTube player, Google acts as an independent controller for the connection data it collects under the YouTube terms; BEAM is controller for everything stored in BEAM.
- **Data Google receives.** Viewers: IP address, user agent, player interaction and device identifiers set by the embed (localStorage), the unlisted video id. No name, email, BEAM id, poll answer or chat text is ever sent: chat, polls, CTAs and watch time are native, and video titles and descriptions contain no personal data. Presenters and staff: name, email and video/audio in Meet.
- **Location and transfer.** EU and US. Transfer mechanism: EU-US Data Privacy Framework (Google LLC is certified) with Standard Contractual Clauses as fallback. Entry in the subprocessor register: "Google (YouTube Live / Meet) - webinar video - EU/US - viewer connection data while watching; presenter account data".
- **Measures.** Privacy-enhanced embed domain `youtube-nocookie.com`; the player loads only after a click-to-load notice (wording `player_notice_v1`, its version stored on the `started` interaction); videos are unlisted; YouTube live chat is not used; the fallback `youtube.com` link says it leaves BEAM.
- **DPIA.** Automations that act on watch thresholds are watch-time profiling (blueprint 66). The seeded marketing follow-ups `webinar-follow-up-attended`, `webinar-follow-up-missed` and `webinar-cta-sales-task` ship `paused`; BEAM activates them after recording its DPIA note. Reminder automations (service messages about a registration) ship `active`.
- **V1 stopgap.** Until R2 the current tool (WebinarGeek or Zoom) stays a subprocessor holding registrant name, email and attendance; the import copies only email, name, locale, registration time, attendance, mode and watched minutes. At switch-over BEAM exports the remaining history once, imports it, and closes the account (runbook `docs/runbooks/webinar-switch-over.md`, written by webinar-P1).
- The document `docs/privacy/webinar-google.md` (written by webinar-P5) holds this text for the DPA annex and the privacy notice.

## 10. Dependencies

### 10.1 Needs from other modules

| Module | Capability (api.ts function or table) | Used for |
| --- | --- | --- |
| platform | `action()`, `defineJob`, `defineSchedule`, `defineEvent`, `recordEvent`, `audit`, `enqueue`, `runJobs`, `flag('ff_webinar_portal')`, `requirePermission()`; tables `files`, `users`, `integration_calls`; job `notify.slack` | everything |
| platform | CSP `frame-src`/`script-src` entries for YouTube (section 6), WAF exemption of `/api/webinar/heartbeat` and `/api/webinar/state` from the per-IP rule, env vars `WEBINAR_IMPORT_WEBHOOK_SECRET` and the existing `GOOGLE_OAUTH_REFRESH_TOKEN` plus `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` in `.env.example` | requested in `docs/build/dependency-requests.md` (frozen files) |
| crm | `findOrCreatePersonByEmail(tx, ctx, {email, firstName?, lastName?, locale, acquisition})`, `getPersonStatus(tx, personId)`, `recordConsent(tx, ctx, {personId, purpose, status, source, method, wordingVersion, ip})`, `tagPerson(tx, ctx, {personId, tagKey, source})`, `getTagByKey(tx, key)`, `createTask(tx, ctx, {ownerUserId, personId, title, kind, source, refType, refId, dueAt})`; reads `persons` names, `activity_events` | persons, consent, tags, tasks, timeline |
| crm | merge calls `webinar.mergePersons(tx, winner, loser)` inside `mergePersons` | person merge |
| booking | `upsertWebinarSession(tx, ctx, {webinarId, sessionId?, title, startsAt, endsAt}): Promise<{sessionId}>` (creates or updates a `sessions` row of kind `event`, `capacity_seats = 0`, `webinar_id` set, not bookable through the booking engine) and `cancelWebinarSession(tx, ctx, sessionId)`; reads `sessions`, `bookings` | event calendar link, conversion |
| commerce | reads `orders` (`person_id`, `status`, `paid_at`, `total_cents`) | purchase conversion |
| email | `sendTransactional(tx, ctx, {template, personId, locale, variables, key})`; merge-field providers: the renderer resolves `{{webinar.*}}` through `modules/webinar/merge-fields.ts` collected into `registry/merge-fields.generated.ts` | access, reminders, follow-ups |
| automation | evaluates this module's event kinds with `where` on `data.*` and `mode`; group `webinar` (exclusive) and `transactional`; the seed inserts automation rows | reminders, follow-ups, poll and CTA triggers |
| ops | `retention_policies` table (seeded rows), privacy request runner calls `privacy.ts`; R3 `ad_spend_daily` | retention, erasure, cost per registration |
| site | links to `/[locale]/webinars` and uses `listPublicWebinars()` on event pages | public discovery |

### 10.2 Provides to other modules

| To | What |
| --- | --- |
| crm | timeline events `webinar.*` with `mode`; `listPersonWebinars()` for the person page card; `mergePersons()` |
| automation | triggers for blueprint 21: registered/no attendance (`webinar.missed`), attended (`webinar.attended` mode `live`), 15 minutes, 30 minutes, 50 %, watched to end (`webinar.threshold_reached` with `data.threshold`), replay viewed (`webinar.attended` mode `replay`), on-demand viewed (mode `on_demand`), poll answer (`webinar.poll_answered` with `data.poll_key`/`option_keys`), CTA click (`webinar.cta_clicked`); exit events `webinar.cancelled`, `webinar.registration_cancelled` |
| ops | `v_person_webinar_stats` for `v_person_profile` and `SEGMENT_ALLOWED_FIELDS` (webinar registration, attendance, watch time, poll and CTA counts); `getWebinarKpis()` (R3 marketing dashboard: registrations, attendance rate, webinar conversion); action-dashboard count "webinar leads have not booked" = `lead` registrations attended in the last 30 days without a booking (query `countWebinarLeadsWithoutBooking()` in `api.ts`); R4 `getWebinarWeeklyFacts()` and `v_webinar_performance_daily` |
| booking, site | `getWebinarForSession()` so an event session linked to a webinar shows "Register for the webinar" instead of a booking button |
| email | merge fields `webinar.access_url`, `webinar.title`, `webinar.starts_at_local` |

## 11. Edge cases and failure modes

| # | Case | Decided behaviour |
| --- | --- | --- |
| 1 | A viewer joins a live webinar 20 minutes late | Position comes from the server clock; their segments start at about 1,200 s. Thresholds count only what they watched; `50pct` and `end` can still be reached if they stay. |
| 2 | Two tabs or two devices of the same registration play at once | Both write segments; merged intervals count each second once per mode. The rate limit (rule 25) applies per registration, so the second tab's heartbeats inside 10 s are dropped with `429`; the player keeps playing and retries. |
| 3 | A client sends inflated replay positions (seeks to the end, fakes `toSec`) | Spans are capped by elapsed wall time since the previous heartbeat of the view plus 5 s and by 30 s; seeking to the end and watching the last minute does reach `end` (accepted: it is what "watched to the end" can mean in a replay) but not `50pct`. |
| 4 | Network loss for several minutes | No segments for the gap; the next heartbeat's span is capped, so the gap is not back-filled. Lost telemetry never affects the registration. |
| 5 | The live webinar ends while someone watches | `sync_status` sets `ended`; the next heartbeat with mode `live` gets `409 mode_changed`; the player reloads in `replay` if allowed, otherwise shows "This webinar has ended". Live segments stay `live`. |
| 6 | YouTube broadcast creation fails (quota, revoked token, 403) | `PermanentError`, `broadcast_error` shown on the webinar page, status stays `draft`, dead job alert in Slack. Staff fix the cause and click Publish again (a new job key suffix `:retry:<n>` is used by the action). |
| 7 | Meet's built-in YouTube streaming creates its own broadcast instead of using BEAM's | The host uses "Use different YouTube video" (`setWebinarVideo`) before or during the live; the player picks up the new id on its next `/api/webinar/state` call (`videoId` changed -> reload). Fallback path: stream with any RTMP encoder to BEAM's broadcast from YouTube Studio. |
| 8 | Nobody starts the stream | Viewers see "Waiting for the host" after `starts_at`. At `starts_at + 2 h` finalise writes no `webinar.missed`, sets `broadcast_error = 'never_live'` and creates a task for the owner; staff then cancel (emails registrants) or reschedule. |
| 9 | Webinar rescheduled after people registered | Only a `starts_at` change of more than 5 minutes counts. Registrations stay. Per registrant, in the update transaction: event `webinar.rescheduled` (which is in `exit_on` of `webinar-reminders`, so the old reminder enrolment exits), then a fresh `webinar.registered` with `data.rescheduled = true`, the new `data.starts_at` and dedupe key `webinar:<registration_id>:registered:v<version>`; `webinar-reminders` has `re_entry: "after_days:0"`, so it re-enrols with reminders anchored on the new time and late-entry skips applied. One `webinar-rescheduled` email per registrant per version. Reports count registrations, not events, so nothing doubles. |
| 10 | The same person registers twice (site, then portal) | Same registration (unique index); a second access email at most 3 times an hour; no second `webinar.registered` event (dedupe `webinar:<registration_id>:registered:v<version>`). |
| 11 | Two different people share one access link | The link works for whoever has it; activity is attributed to the registrant. The landing header shows the registrant's first name with "not you?" leading to registration. Staff can revoke the link (`token_version + 1`). |
| 12 | Replay view limit reached in one tab while another tab is open | The open tab keeps playing; the limit applies at `startView`. A reload after 30 minutes of inactivity counts as a new view and is refused at the limit. |
| 13 | Replay expires during playback | Next heartbeat returns `stop: 'expired'`, player shows the expiry message; segments up to then remain. |
| 14 | A poll answered twice in the same mode (double click, two tabs) | The partial unique index rejects the second insert; the API returns `409 already_answered` and the UI shows the first answer. Tags and events are written once. |
| 15 | A poll is edited after answers exist | Options and question cannot change (`conflict`); staff deactivate it and create a new poll with a new key. Reports keep the old poll's answers. |
| 16 | A tag rule names a tag that is later deleted | `crm.tagPerson` throws `not_found`; the answer is still stored, the tag step is skipped, and the error is logged to Sentry with the poll id. The poll edit screen flags the broken rule. |
| 17 | Chat spam or abuse | 3 s and 60/h limits; hosts hide messages or block the viewer; a blocked viewer's registration is `blocked`, their player stops, their old messages remain hidden only if hidden explicitly (block also hides all their chat messages with one `hide_message` row each). |
| 18 | Person erased between registering and the webinar | Registration and its rows deleted; the access link no longer resolves ("This link is no longer valid"); reminder enrolments are deleted by automation's erase; YouTube holds nothing to delete. |
| 19 | Two persons merged who both registered for the same webinar | `mergePersons` keeps the earlier registration, moves the loser's segments and interactions to it (append-only bypass inside the merge transaction under `SET LOCAL beam.allow_rewrite = 'on'`), deletes the loser registration, and returns `collapsed = 1`. Poll answers in the same mode keep the earliest answer. |
| 20 | A lead registers, then buys a package before the webinar | `person_status` stays `lead` on the registration (snapshot), so the purchase counts as a lead conversion only if it falls after `anchor_at`; buying before the webinar is not a webinar conversion. |
| 21 | Daylight-saving change between scheduling and the webinar | Times are stored in UTC; the landing page and emails format in `Europe/Brussels`; reminders are anchored on the UTC instant. |
| 22 | The recording is not processed 48 h after the end | `fetch_recording` stops; the webinar page shows "Recording not available yet" with "Use different YouTube video"; replay stays unavailable and `webinar-follow-up-missed` steps are `skipped_condition` (the step's `unless` checks `replay_available`). |
| 23 | V1 CSV with a duplicate email in two rows | Same person, same dedupe keys; the second row counts as `skipped` with code `duplicate`. |
| 24 | V1 webhook retried by Zapier with the same `event_id` | Unique index on `(external_webinar_id, external_event_id)`: 200, nothing new. A different `event_id` with the same records produces no new events because of the activity dedupe keys. |
| 25 | Heartbeat for a webinar with `ff_webinar_portal` switched off mid-webinar | Viewer endpoints check only the registration and webinar state, not the flag, so a running webinar continues; the flag hides only discovery pages and the portal menu. |

## 12. Build packages

Order and sequencing: `webinar-P1` ships in V1 (Wave 1). `webinar-P2` to `webinar-P7` are Release 2 and are **strictly sequential in that order**: they all edit the module barrel files (`actions.ts`, `queries.ts`, `jobs.ts`, `events.ts`, `api.ts`, `privacy.ts`, `nav.ts`, the three `webinar.json` catalogues), each one starting from the merged result of the previous one. `webinar-P8` (R3) and `webinar-P9` (R4) follow P7. `packages/db/src/schema/webinar.ts` is edited by P1 then P2; `webinar.views.ts` by P2 and P9, sequentially. No package edits `package.json`, the lockfile, migrations, `registry/*.generated.ts`, `packages/db/src/schema/index.ts` or frozen files; requests for frozen files (CSP, WAF, env vars, merge-field registry) go to `docs/build/dependency-requests.md`. Every package's done-definition includes: `pnpm typecheck` and `pnpm lint` clean, `pnpm i18n:check` clean, its Vitest suites green using `createTestDb()` and the YouTube `fake.ts`, and the module `jobs.test.ts`, `permissions.test.ts` and `privacy.test.ts` green.

### webinar-P1: V1 stopgap import (V1, about 90 min)

- **Goal.** Registrations and attendance of the current webinar tool reach the customer record before R2 (rules 1-7).
- **Creates or edits.** `packages/db/src/schema/webinar.ts` (edit the Wave 0 stub: V1 enums, `external_webinars`, `webinar_imports`); `packages/core/src/webinar/index.ts`, `packages/core/src/webinar/import.ts`, `packages/core/src/webinar/import.test.ts`; `apps/web/modules/webinar/server/import.ts`; edit stubs `apps/web/modules/webinar/{actions,queries,jobs,events,permissions,nav,privacy}.ts`; `apps/web/app/(admin)/admin/webinars/page.tsx` (V1: list of imported external webinars with counts and the import button), `apps/web/app/(admin)/admin/webinars/import/page.tsx`, `apps/web/app/(admin)/admin/webinars/import/[importId]/page.tsx`; `apps/web/app/api/webhooks/webinar-import/route.ts`; `packages/core/src/i18n/messages/{en,nl-BE,fr-BE}/webinar.json`; `docs/runbooks/webinar-switch-over.md`; tests below.
- **Interfaces.** `parseWebinarCsv(text: string, preset: ImportPreset, mapping?: Record<string, ImportField>): { rows: NormalisedRecord[]; errors: Array<{ row: number; code: string }> }`; `WebinarImportWebhookPayload` (Zod); `NormalisedRecord = { row: number; email: string; firstName?: string; lastName?: string; locale?: Locale; registeredAt?: Date; attended: boolean; joinedAt?: Date; watchedMinutes?: number; mode: 'live' | 'replay' }`; `factsForRecord(rec, externalWebinar): Array<{ kind; mode; occurredAt; dedupeSuffix; data }>` (pure); actions `uploadWebinarImport`, `commitWebinarImport`; job `webinar.process_import`; events `webinar.registered`, `webinar.attended`, `webinar.threshold_reached`; permission `webinars.host`.
- **Depends on.** `platform:action`, `platform:defineJob`, `platform:recordEvent`, `platform:files`, `crm:findOrCreatePersonByEmail`, `crm:persons.erased_at` (read).
- **Tests.** `packages/core/src/webinar/import.test.ts`: WebinarGeek and Zoom header presets, generic mapping, invalid and missing email codes, minutes to thresholds (14 min none, 15 min `15m`, 31 min `15m`+`30m`, with duration `50pct`/`end`). `apps/web/modules/webinar/import.test.ts`: import creates persons with acquisition `webinar` and events with dedupe keys; second import adds nothing; dry run writes nothing; no `consent_records` row even with an opt-in column; erased person skipped; duplicate row `duplicate`. `apps/web/app/api/webhooks/webinar-import/route.test.ts`: bad signature 401, 501 records 422, same `event_id` twice imports once, payload nulled after processing. `jobs.test.ts` (double run of a chunk), `permissions.test.ts`, `privacy.test.ts` (tables in `NO_PII_TABLES`). `apps/web/e2e/webinar-import.spec.ts`: staff uploads a 3-row CSV, sees counts, the person timeline shows "Webinar registered (imported)".
- **Done.** Common done-definition plus the e2e spec green against `beam_dev`.

### webinar-P2: Native schema, views and core logic (R2, about 90 min)

- **Goal.** Every R2 table, enum, index, check and view of section 2, and the pure rules for modes, watch time, tokens and polls.
- **Creates or edits.** `packages/db/src/schema/webinar.ts` (edit: R2 enums and tables, `APPEND_ONLY` markers for `watch_segments`, `webinar_interactions`, `webinar_moderation_actions`); `packages/db/src/schema/webinar.views.ts` (`v_webinar_watch`, `v_webinar_registration_facts`, `v_webinar_conversions`, `v_person_webinar_stats`); `packages/db/src/schema/webinar.test.ts`; `packages/core/src/webinar/{types,watch,access,token,polls,schemas}.ts` and `{watch,access,token,polls}.test.ts`; edit `packages/core/src/webinar/index.ts`; `apps/web/modules/webinar/test/factories.ts` (`makeWebinar`, `makeRegistration`, `makeSegments`).
- **Interfaces.** `mergeIntervals(segs: Array<{ fromSec: number; toSec: number }>): { watchedSec: number; maxPositionSec: number }`; `factsReached(input: { watchedSec; maxPositionSec; durationSec; attendedMinSec }): Array<'attended' | '15m' | '30m' | '50pct' | 'end'>`; `clampSegment(input: { mode; clientFrom; clientTo; now; liveStartedAt?; lastHeartbeatAt?; durationSec }): { fromSec; toSec } | null`; `resolveMode(w: WebinarState, now: Date): { mode: WatchMode } | { blocked: 'not_started' | 'ended_no_replay' | 'expired' }`; `registeredModeFor(w, now): WatchMode`; `canRegister(w, now): { ok: true } | { ok: false; code: 'closed' }`; `replayAccess(input: { w; registration; viewsInMode; now }): { ok: true } | { ok: false; code: 'expired' | 'limit_reached' }`; `signAccessToken(key: Uint8Array, registrationId: string, version: number): string`; `verifyAccessToken(key, token): { registrationId: string; version: number } | null`; `deriveAccessKey(authSecret: string): Uint8Array`; `validatePollAnswer(poll, optionKeys): Result`; `tagsForAnswer(poll, optionKeys, mode): string[]`; `visibleAt(items, positionSec)`; Zod inputs of section 4 in `schemas.ts`.
- **Depends on.** webinar-P1; `booking:sessions` (FK target, Wave 0 contract table), `crm:persons`, `platform:users`, `platform:files`.
- **Tests.** `watch.test.ts`: overlap, touching, nested, two tabs, unsorted input; thresholds at 899/900, 1799/1800, half of odd durations, end at `duration - 60`. `access.test.ts`: live window, simulive window and position, replay gated before and after end, expiry, view limit, on-demand access days. `token.test.ts`: round trip, tampered MAC, old version, constant-time compare used. `polls.test.ts`: single vs multiple, unknown key, tag rules by mode. `webinar.test.ts` (PGlite): every check constraint rejects a bad row; partial uniques for poll answer per mode and CTA shown; a live and a replay answer of the same poll coexist; `v_webinar_watch` seconds equal `mergeIntervals` on 200 random segment sets; `v_webinar_conversions` picks the first booking after the anchor only.
- **Done.** Common done-definition; core coverage above 90 % for `webinar/watch.ts` and `webinar/access.ts`.

### webinar-P3: YouTube and Meet, webinar lifecycle and admin editing (R2, about 120 min)

- **Goal.** Staff create, edit, publish, reschedule, cancel, archive and duplicate webinars; broadcasts and Meet spaces are created by jobs; live status and recordings sync (rules 8-13, 34 storage side, section 6).
- **Creates or edits.** `packages/integrations/src/youtube/{types,client,fake}.ts` and `client.test.ts` (extend the Wave 0 fake); `apps/web/modules/webinar/server/lifecycle.ts`; edit `actions.ts`, `queries.ts`, `jobs.ts`, `events.ts`, `nav.ts`, `schedules.ts`; `apps/web/app/(admin)/admin/webinars/page.tsx` (edit: native list with tabs, imported webinars move to an "Imported" tab), `.../webinars/new/page.tsx`, `.../webinars/[id]/page.tsx`, `.../webinars/[id]/interactive/page.tsx`, `apps/web/modules/webinar/ui/admin/{webinar-form,poll-editor,cta-editor,presenter-list,broadcast-panel}.tsx`; `packages/email/src/templates/webinar/{webinar-rescheduled,webinar-cancelled}.tsx`; catalogue keys `webinar.admin.*`, `webinar.email.rescheduled.*`, `webinar.email.cancelled.*`.
- **Interfaces.** `YouTubeClient` with `findBroadcastByMarker`, `createBroadcast`, `updateBroadcast`, `deleteBroadcast`, `getBroadcast`, `getVideo`, `createMeetSpace` (section 6) and `FakeYouTube` with `setLifecycle`, `markProcessed`, `failNext`; actions `createWebinar`, `updateWebinar`, `publishWebinar`, `cancelWebinar`, `archiveWebinar`, `duplicateWebinar`, `setWebinarVideo`, `upsertPoll`, `deletePoll`, `upsertCta`, `deleteCta`, `upsertPresenter`, `removePresenter`, `forceLiveState`; jobs `webinar.create_broadcast`, `update_broadcast`, `delete_broadcast`, `create_meet_space`, `sync_status`, `fetch_recording`, `notify_registrants`; schedules `webinar.scan_live`, `webinar.scan_recordings`.
- **Depends on.** webinar-P2; `booking:upsertWebinarSession`, `booking:cancelWebinarSession`; `email:sendTransactional`; `crm:findOrCreatePersonByEmail` (external presenters), `crm:getTagByKey` (tag rule validation); `platform:integration_calls` callback.
- **Tests.** `lifecycle.test.ts`: publish refuses missing locales with the list; live publish stays `draft` until the job succeeds; 403 from the fake sets `broadcast_error` and dead job; a lost response retried reuses the broadcast by marker; simulive goes `live` and `ended` by time only; reschedule by 3 min sends nothing, by 30 min emails each registrant once; cancel writes events and enqueues delete; duplicate creates N drafts with copied polls; poll with answers cannot change options. `client.test.ts`: Zod validation of fake responses, error mapping retryable vs permanent. `jobs.test.ts` (edit: every new job twice). `permissions.test.ts` (edit).
- **Done.** Common done-definition.

### webinar-P4: Registration, access links, portal list and seeds (R2, about 120 min)

- **Goal.** People register from the site, the portal or by staff; they get a personal link at once and reminders through automation (rules 14-20, seeds of 4.8).
- **Creates or edits.** `apps/web/modules/webinar/server/registration.ts`; edit `actions.ts`, `queries.ts`, `api.ts`, `events.ts`, `privacy.ts` (registrations export and erase), `nav.ts` (portal entry behind `ff_webinar_portal`); `apps/web/modules/webinar/merge-fields.ts`; `apps/web/modules/webinar/seed.ts`; `packages/db/src/seed/webinar.ts`; `apps/web/app/api/public/webinars/[slug]/register/route.ts`; `apps/web/app/[locale]/(site)/webinars/page.tsx`, `.../webinars/[slug]/page.tsx`, `.../webinars/[slug]/join/page.tsx`; `apps/web/app/[locale]/(portal)/account/webinars/page.tsx`; `apps/web/app/(admin)/admin/webinars/[id]/registrations/page.tsx`; `apps/web/modules/webinar/ui/{registration-form,webinar-card,registrations-table}.tsx`; `packages/email/src/templates/webinar/webinar-access.tsx` (with `.ics`); catalogue keys `webinar.public.*`, `webinar.register.*`, `webinar.portal.list.*`, `webinar.email.access.*`, `webinar.admin.registrations.*`.
- **Interfaces.** `registerPerson(tx: Tx, ctx: Ctx, input: { webinarId: string; personId: string; source: RegistrationSource; locale: Locale; utm: Utm; consents?: { events?: boolean; newsletter?: boolean }; wordingVersion?: string }): Promise<{ registrationId: string; created: boolean }>`; actions `registerForWebinar`, `cancelMyRegistration`, `registerPersonByStaff`, `cancelRegistrationByStaff`, `resendAccessLink`, `revokeAccessLink`; api `getWebinarForSession`, `listPublicWebinars`, `listPersonWebinars`, `getAccessUrl`, `mergePersons`; merge fields `webinar.access_url`, `webinar.title`, `webinar.starts_at_local`.
- **Depends on.** webinar-P3; `crm:findOrCreatePersonByEmail`, `crm:getPersonStatus`, `crm:recordConsent`; `email:sendTransactional`, `email:merge-field registry` (orchestrator generator change requested); `automation:automations` and `automation:automation_versions` tables (seed rows); `ops:retention_policies` (seed rows); `platform:feature_flags` (seed row).
- **Tests.** `registration.test.ts`: register creates person with acquisition `webinar`, snapshot status `lead`/`customer`/`member`, event with `session.kind = 'event'`, no consent unless ticked, ticked box writes one `consent_records` row with the wording version; second registration is the same row and a 4th access email in an hour is not sent; cancelled then re-registered; closed webinar refused; gated replay refuses after the end; open replay registers with `registered_mode = 'replay'`; public route always answers 202. `merge.test.ts`: two registrations collapse into the earlier one with segments and interactions moved and duplicate poll answers in one mode reduced to the earliest. `seed.test.ts`: seeded automations validate against the automation definition schema; the reminder sequence for a Friday registration and a Sunday webinar plans `d1`, `h1`, `now` and skips `d7` (uses `@beam/core/automation` `planSteps`). `privacy.test.ts` (edit). `apps/web/e2e/webinar-register.spec.ts`: register on `/nl/webinars/<slug>`, the sink mailbox has the access email, the link opens `/nl/w/<token>`.
- **Done.** Common done-definition plus the e2e spec.

### webinar-P5: Player, heartbeat, watch time and replay access (R2, about 120 min)

- **Goal.** Watching inside BEAM with server-side mode decisions, watch segments, started, attended, threshold and missed facts, and gated replays (rules 21-32, 9.3).
- **Creates or edits.** `apps/web/modules/webinar/server/{viewer,watch}.ts`; `apps/web/app/api/webinar/view/route.ts`, `apps/web/app/api/webinar/heartbeat/route.ts`; `apps/web/modules/webinar/ui/webinar-player.tsx`, `apps/web/modules/webinar/ui/player-notice.tsx`; `apps/web/app/[locale]/(portal)/account/webinars/[id]/page.tsx`; `apps/web/app/[locale]/(site)/w/[token]/page.tsx`; edit `jobs.ts` (`webinar.finalise`), `schedules.ts` (`webinar.scan_finalise`), `events.ts`, `privacy.ts` (segments export); `docs/privacy/webinar-google.md`; catalogue keys `webinar.player.*`, `webinar.public.token.*`.
- **Interfaces.** `resolveViewer(req: Request, webinarId: string): Promise<{ registration; webinar; via: 'token' | 'session' } | ViewerError>`; `startView(tx, viewer, now): Promise<ViewStart | ViewRefusal>`; `recordHeartbeat(tx, viewer, input: HeartbeatInput, now): Promise<HeartbeatResult>`; `finaliseWebinar(tx, ctx, webinarId, now): Promise<{ missed: number; backfilled: number }>`.
- **Depends on.** webinar-P4; `platform:recordEvent` (dedupe keys), `crm:createTask` (never-live task), `platform:notify.slack`; CSP and WAF requests of section 10 (the e2e runs with them merged).
- **Tests.** `heartbeat.test.ts`: live positions from the server clock ignore client values; replay span capped by elapsed time and 30 s; paused writes nothing; two heartbeats within 10 s -> 429; client mode `live` after the end -> 409; blocked registration -> 403; `webinar.started` once per mode; `attended` at 300 s; `15m` and `30m` once each; live and replay watch kept apart (live 20 min plus replay 20 min gives `30m` in neither). `replay-access.test.ts`: view counted once per 30 min, limit reached, expiry stop. `finalise.test.ts`: missed only for live registrants without live attendance; replay viewers still missed for live; never-live writes no missed and creates a task; double run identical. `apps/web/e2e/webinar-watch.spec.ts` (fake player stub): open token link, accept notice, wait 3 heartbeats, admin registrations page shows watch minutes.
- **Done.** Common done-definition plus the e2e spec.

### webinar-P6: Polls, CTAs, chat, questions, host console and moderation (R2, about 120 min)

- **Goal.** Interactions in live, replay and on-demand with the mode on every row; tags, automation events and tasks from them; the host console (rules 33-38, scenario 5).
- **Creates or edits.** `apps/web/modules/webinar/server/interactions.ts`; `apps/web/app/api/webinar/state/route.ts`, `apps/web/app/api/webinar/interact/route.ts`, `apps/web/app/api/webinar/cta/[ctaId]/route.ts`; `apps/web/app/(admin)/admin/webinars/[id]/host/page.tsx`; `apps/web/modules/webinar/ui/{poll-card,cta-button,chat-panel,question-box}.tsx` and `apps/web/modules/webinar/ui/host/{host-console,live-poll-controls,chat-moderation}.tsx`; edit `webinar-player.tsx` (mount the panels), `actions.ts` (`launchPoll`, `closePoll`, `showCta`, `hideCta`, `moderate`), `queries.ts` (`getHostConsoleState`), `events.ts`, `privacy.ts` (interactions export); catalogue keys `webinar.player.poll.*`, `webinar.player.chat.*`, `webinar.admin.host.*`.
- **Interfaces.** `answerPoll(tx, viewer, { pollId; optionKeys; atSec; viewId }): Promise<{ ok: true } | { ok: false; code: 'already_answered' | 'invalid' | 'closed' }>`; `postMessage(tx, viewer, { kind: 'chat' | 'question'; text; atSec }): Promise<...>`; `recordCtaShown`, `recordCtaClick(tx, viewer, ctaId, atSec): Promise<{ redirectUrl: string }>`; `getLiveState(db, webinarId, after: Date, viewer): Promise<LiveState>`.
- **Depends on.** webinar-P5; `crm:tagPerson`, `crm:createTask`; `platform:audit`.
- **Tests.** `interactions.test.ts`: poll answer once per mode, live and replay answers both stored with their modes; tag rules apply only for listed modes; CTA shown once per mode, click redirect adds UTM without overwriting existing UTM; chat limits 3 s and 60/h; question in replay creates a task without the text; hidden messages vanish from state; block stops the player and hides messages; launch in live sets `show_at_sec`. `apps/web/modules/webinar/scenario-5.test.ts` (PGlite): one person answers the same poll live and in replay and clicks the CTA in both; `v_webinar_registration_facts` shows `poll_answers_live = 1`, `poll_answers_replay = 1`, events carry the right `mode`. `apps/web/e2e/scenario-5-replay-separation.spec.ts` (architecture name; skipped until R2): the same flow through the UI and the report.
- **Done.** Common done-definition plus both e2e specs.

### webinar-P7: Reporting, exports, person stats and privacy completion (R2, about 90 min)

- **Goal.** Reports split by lead, customer and member with conversion within the chosen period; registrant export; full privacy registration; ops-facing stats (rules 39-41, section 9).
- **Creates or edits.** `apps/web/modules/webinar/server/report.ts`; `apps/web/app/(admin)/admin/webinars/[id]/report/page.tsx`; `apps/web/modules/webinar/ui/report/{summary-cards,segment-table,poll-results,cta-table,utm-table}.tsx`; edit `queries.ts` (`getWebinarReport`, `getPollResults`, `getCtaResults`), `actions.ts` (`exportWebinarRegistrants`), `api.ts` (`getPersonWebinarStats`, `countWebinarLeadsWithoutBooking`), `privacy.ts` (complete), `nav.ts`; `apps/web/modules/webinar/privacy.test.ts` (complete); catalogue keys `webinar.admin.report.*`.
- **Interfaces.** `getWebinarReport(db, webinarId, { periodDays: 7 | 14 | 30 | 60 | 90 | 180 }): Promise<WebinarReport>` with `WebinarReport = { totals: SegmentRow; bySegment: Record<'lead'|'customer'|'member', SegmentRow>; byMode: Record<WatchMode, ModeRow>; polls: PollResult[]; ctas: CtaResult[]; utm: UtmRow[] }`; `buildReportCsv(report): string`; `buildRegistrantsCsv(rows): string`.
- **Depends on.** webinar-P6; `booking:bookings`, `commerce:orders` (read through `v_webinar_conversions`); `platform:files` (export); `ops:privacy runner` calls `webinarPrivacy`.
- **Tests.** `report.test.ts`: seeded lead, customer and member registrants; registered never counted as attended; booking 10 days after counts in 14-day and 30-day periods but not 7; purchase before the webinar not counted; CTA "booked after" counts only bookings after the click; aggregate CSV contains no email. `privacy.test.ts`: export lists registrations, merged watch and raw segments, poll answers with labels, chat text; erase leaves no row referencing the person in all five tables (gdpr-coverage passes) and returns per-table counts; a second erase is a no-op. `permissions.test.ts` (edit: export needs `persons.export`). `apps/web/e2e/acceptance-r2-webinar.spec.ts`: the three R2 webinar acceptance tests (registration is not attendance, watch time captured, replay and replay polls separate).
- **Done.** Common done-definition plus the acceptance spec.

### webinar-P8: Campaign attribution and marketing KPIs (R3, about 60 min)

- **Goal.** Webinars inside the campaign funnel and the marketing dashboard (blueprint 33, 34).
- **Creates or edits.** `apps/web/modules/webinar/server/kpis.ts`; edit `api.ts` (`getWebinarKpis`), `server/report.ts` and `ui/report/utm-table.tsx` (cost per registration and registration rate when `ad_spend_daily` has the campaign); `apps/web/modules/webinar/kpis.test.ts`; catalogue keys `webinar.admin.report.utm.*`.
- **Interfaces.** `getWebinarKpis` (section 4.7); `funnelByCampaign(db, { from; to; periodDays }): Promise<Array<{ campaign: string | null; registrations; attended; firstVisit; firstPurchase; spendCents: number | null; costPerRegistrationCents: number | null; registrationRate: number | null }>>` where registration rate = registrations ÷ `ad_spend_daily.clicks` of the same `utm_campaign` and period.
- **Depends on.** webinar-P7; `ops:ad_spend_daily` (R3); `ops:marketing dashboard` consumes `getWebinarKpis`.
- **Tests.** `kpis.test.ts`: attendance rate and conversion per segment; campaign join on `utm.campaign` = `campaign_name`; null spend gives null cost; periods respected.
- **Done.** Common done-definition.

### webinar-P9: AI and summary hooks (R4, about 45 min)

- **Goal.** Non-personal webinar aggregates for natural-language questions, the weekly summary and churn and repurchase indicators.
- **Creates or edits.** `packages/db/src/schema/webinar.views.ts` (edit: `v_webinar_performance_daily`); edit `api.ts` (`getWebinarWeeklyFacts`); `apps/web/modules/webinar/server/ai-facts.ts`, `apps/web/modules/webinar/ai-facts.test.ts`; request in `docs/build/dependency-requests.md`: expose `v_webinar_performance_daily` in the `ai` schema (custom migration by the orchestrator) and add `webinars_attended_live` and `watch_sec_total` from `v_person_webinar_stats` to `AI_ALLOWED_FIELDS` (platform-owned file).
- **Interfaces.** `getWebinarWeeklyFacts` (section 4.7) returning facts `registrations`, `live_attendees`, `replay_viewers`, `on_demand_viewers`, `avg_live_watch_min`, `cta_clicks`, `conversions_30d`.
- **Depends on.** webinar-P8; `ops:ai.weekly_summary` (R4) consumes the facts.
- **Tests.** `ai-facts.test.ts`: facts for a seeded week; the view has no `person_id`, `email` or text column (asserted from `information_schema`); no member of `SENSITIVE_COLUMNS` involved.
- **Done.** Common done-definition.

## 13. Decisions made

Additions to the architecture (to be reflected in `01-architecture.md` section 2 and the route list by the plan integrator):

1. **New V1 tables** `external_webinars` and `webinar_imports`, so the stopgap import has a reference for `activity_events.ref_id` and an idempotent webhook inbox without changing the platform-owned `webhook_events.provider` enum.
2. **New R2 tables** `webinar_presenters` (multiple presenters, identity through `users` or `persons` only) and `webinar_moderation_actions` APPEND (mute/remove from the blueprint, as hide message and block viewer, without editing append-only interactions).
3. **New columns on `webinars`:** `slug`, `series_key`, `description`, `locales`, `spoken_locale`, `status`, `planned_duration_minutes`, `duration_sec`, `youtube_stream_id`, `youtube_lifecycle`, `meet_space_name`, `publish_requested_at`, `broadcast_error`, `published_at`, `live_started_at`, `live_ended_at`, `finalised_at`, `is_replay_enabled`, `on_demand_access_days`, `attended_min_sec`, `conversion_window_days`, `is_chat_enabled`, `is_questions_enabled`, `owner_user_id`, `created_by_user_id`, `cancelled_reason`, `version`.
4. **New columns on `webinar_registrations`:** `token_version`, `status`, `source`, `locale`, `person_status` (snapshot), `utm`, `access_emails_sent`, `last_access_email_at`, `cancelled_at`, `blocked_at`, `blocked_by_user_id`. **On `webinar_polls`:** `allow_multiple`, `show_for_sec`, `live_launched_at`, `live_closed_at`, `is_active`, `sort_order`. **On `webinar_ctas`:** `live_shown_at`, `live_hidden_at`, `is_active`, `sort_order`. **On `watch_segments` and `webinar_interactions`:** denormalised `webinar_id` and `view_id`.
5. **New views** `v_webinar_registration_facts`, `v_webinar_conversions`, `v_person_webinar_stats`, and (R4) `v_webinar_performance_daily`, beside the architecture's `v_webinar_watch`.
6. **New routes** beyond `api/webinar/heartbeat`: `api/webinar/view`, `api/webinar/state`, `api/webinar/interact`, `api/webinar/cta/[ctaId]`, `api/public/webinars/[slug]/register`, `api/webhooks/webinar-import` (V1). Token viewers have no session, so these are route handlers, not server actions.
7. **New pages owned by this module inside `(site)`:** `/[locale]/webinars`, `/[locale]/webinars/[slug]`, `/[locale]/webinars/[slug]/join`, `/[locale]/w/[token]`. The architecture gives `(site)/*` to `site`; webinar pages are carved out the same way forms own `(site)/f/[slug]`.
8. **New cross-module API requests:** `booking.upsertWebinarSession` and `booking.cancelWebinarSession`; `crm.recordConsent`, `crm.tagPerson`, `crm.getTagByKey`, `crm.createTask`; crm's merge calls `webinar.mergePersons`; an email merge-field registry (`modules/<m>/merge-fields.ts` collected by `pnpm gen:indexes`).
9. **New event kinds:** `webinar.registered`, `webinar.registration_cancelled`, `webinar.started`, `webinar.attended`, `webinar.threshold_reached`, `webinar.missed`, `webinar.poll_answered`, `webinar.cta_clicked`, `webinar.question_asked`, `webinar.chatted`, `webinar.cancelled`, `webinar.rescheduled`. **New job kinds** and **schedules** as listed in sections 4.5 and 4.6.
10. **Platform requests (frozen files):** CSP entries for YouTube, WAF exemption for the heartbeat and state routes, env vars `WEBINAR_IMPORT_WEBHOOK_SECRET`, `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`; integration provider name `youtube` in `integration_calls`.

Choices the inputs left open:

11. The V1 stopgap is a CSV upload plus a signed generic JSON webhook (fed by Zapier from WebinarGeek or Zoom). No direct WebinarGeek or Zoom API client, because the tool is retired in week 10 and the webhook covers both.
12. Imports and registrations never create marketing consent; the registration form offers optional unticked `events` and `newsletter` boxes.
13. Webinars are free in R2. Paid events stay `ticket_types` in booking. A webinar session has `capacity_seats = 0` and is not bookable through the booking engine; registration is the only entry.
14. Every live or simulive webinar has exactly one `sessions` row of kind `event`, owned by booking and written only through `booking.upsertWebinarSession`; the webinar's `starts_at` is authoritative. On-demand webinars have no session.
15. Recurring webinars are a series of independent occurrences grouped by `series_key`, created by "duplicate to dates" (up to 26 at once). No recurrence rule engine.
16. Simulive is presented as live: during the scheduled showing its rows carry mode `live`; afterwards the same video is a replay. Reports can still filter by `webinars.mode = 'simulive'`.
17. The server decides the mode and, for live and simulive, the position. Client positions are trusted only in replay and on-demand, and then capped by elapsed time.
18. Thresholds: attended at 300 s by default (configurable per webinar, 60-3,600 s), 15 min at 900 s, 30 min at 1,800 s, 50 % of the real duration (planned duration until YouTube reports it), end when coverage reaches `duration - 60` s. One event kind `webinar.threshold_reached` with `data.threshold`, like `credits.threshold_reached`.
19. "Replay watched" and "on-demand watched" are `webinar.attended` with that mode; "registered/no attendance" is `webinar.missed`, written 30 minutes after the live ends.
20. Access token = registration id, version and an HMAC with a key derived from `AUTH_SECRET` (HKDF), so reminder emails can rebuild the link without storing it; `access_token_hash` is still stored for lookup and revocation is by `token_version`. A token never signs anyone into the portal.
21. `is_replay_gated = true` (default) means only people registered before the end may watch the replay; `false` lets anyone register for the replay. A replay view is counted per 30 minutes of inactivity.
22. Polls and CTAs launched live get their `show_at_sec` from the launch moment, so the replay matches the live timing.
23. Live chat is public to live viewers; questions go only to hosts; replay and on-demand have questions only, each creating a task for the webinar owner. Chat display name is first name plus last initial.
24. Poll tags are applied with `person_tags.source = 'automation'` (rule-based) instead of adding an enum value to crm.
25. CTA clicks pass through a BEAM redirect that records the click and appends UTM parameters (`utm_source=beam-webinar`), so booking and purchase after a CTA can also be attributed by commerce's UTM capture.
26. Reporting splits on the status snapshot at registration, not the current status; conversion counts from `anchor_at` (webinar start for live registrants, registration time otherwise) within a selectable period (7-180 days, default 30 per webinar).
27. One permission `webinars.host` covers editing, hosting, moderating and importing; `reports.read` also opens the aggregate report; the registrant list needs `persons.read` and its CSV `persons.export`.
28. Reminders run through the seeded automation `webinar-reminders` in group `transactional` (active); marketing follow-ups in the exclusive group `webinar` ship paused until BEAM records its DPIA note on watch-time profiling.
29. Retention: watch segments and interactions 2 years (architecture), registrations 3 years, import records 30 days. Erasure deletes all webinar rows of the person.
30. Google: Meet as processor under the Workspace DPA, YouTube embed as independent controller for connection data; `youtube-nocookie.com`, click-to-load notice with a stored wording version, no BEAM identity sent to Google; DPF with SCC fallback.
31. Meet spaces are created by the Meet REST API with a staff override; if Meet's own YouTube streaming creates a separate broadcast, staff switch the video id with one action.
32. The player polls `/api/webinar/state` every 5 s in live (30 s otherwise), with a 2-second in-process memo per webinar; no websockets or new realtime vendor.
33. Feature flag `ff_webinar_portal` gates discovery and the portal menu only; running viewers are never cut off by the flag.
