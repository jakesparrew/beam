# Module spec: webinar (Webinars on YouTube Live)

Owner module id: `webinar`. Schema file `packages/db/src/schema/webinar.ts` (+ `webinar.views.ts`), core `packages/core/src/webinar/`, app `apps/web/modules/webinar/`, email `packages/email/src/templates/webinar/`, catalogue namespace `webinar`. Blueprint sources: section 18 (primary), 21 (webinar behaviour triggers), 34 (webinar KPIs), plus 3 (webinar as origin), 5 (timeline), 6 (segmentation), 15 (webinars as events), 17 (assessment result CTA to a webinar), 31 (webinar sequences; with 21 for conflict rules), 23 ("webinar leads have not booked"), 33 (campaign funnel), 50 and 53 (current tool and migration), 58, 62, 63, 66 (privacy), 76 and 87 (acceptance; scenarios 1, 5 and 7).

## 1. Purpose and release mapping

A webinar in BEAM is a sales step, not just a lead source. People register on the website or in the portal, watch inside BEAM (YouTube Live unlisted video in an embedded player), answer polls, click CTAs and ask questions. Every action lands on the person's timeline with its mode (`live`, `replay`, `on_demand`), so reports and automations can treat each mode separately (scenario 5). Presenters work in Google Meet and stream to the YouTube broadcast that BEAM created.

| Release | What ships in this module |
| --- | --- |
| **V1 (weeks 1-6)** | No webinar code ships in V1: the architecture lists `webinar` as an R2 module and Wave 1 has eleven packages without it. The proposal's stopgap ("you keep your current webinar tool, and registrations are imported into the customer record") is delivered by **ops** imports: source `webinar_tool`, history kinds `webinar_registration` and `webinar_attendance` in `imported_history`, one `ops.history_imported` timeline event per row. Rules 1-7 are the requirements this module places on that import; ops owns the code and the tests. Wave 0 already creates the empty stub files of this module, the `webinar.ts` schema stub and the YouTube `frame-src` CSP entry (platform). The current tool (WebinarGeek or Zoom) stays a subprocessor until the R2 switch-over (section 9.3). |
| **Release 2 (weeks 9-10)** | The native module. Webinars linked to a `sessions` row of kind `event`; modes `live`, `simulive`, `on_demand`; one-off and recurring (series); YouTube unlisted broadcasts created through the Data API v3; Google Meet space for presenters (multiple presenters, screen sharing and presenter mute/remove are Meet features); automatic recording (`recordFromStart: true`) that becomes the replay; separate host and participant links; registration from site and portal with personal access tokens; embedded IFrame player; heartbeat every 15 s writing `watch_segments`; watch time per mode with the 15 min, 30 min, 50 % and end thresholds; started, attended, watched and no-show facts; polls, CTAs, chat and questions in live, replay and on-demand with the mode on every row; moderation (hide message, mute viewer, remove viewer by blocking); gated replays with expiry and view limits; tags and automation events from poll answers and CTA clicks; event kinds and email templates for the reminder and follow-up journeys that automation seeds (section 4.8); a pre-flight check that alerts staff when a live webinar is not ready 15 minutes before start; an accessible player (WCAG 2.1 AA, captions); the switch-over from the current tool; reporting split by lead, customer and member with conversion within a configurable period; privacy registration. Acceptance tests of proposal section 12: registration is not attendance, watch time is captured, replay activity and replay polls are stored apart from live. |
| **Release 3 (weeks 11-12)** | Webinar in campaign attribution and marketing dashboards: registrations per UTM source and campaign, cost per registration and click-to-registration rate from `ad_spend_daily` (the invitation-based registration rate is computed by ops, rule 75 of ops), the funnel campaign -> registration -> attendance -> first visit -> first purchase, and `getWebinarKpis()` consumed by the ops marketing dashboard. |
| **Release 4 (weeks 13-14)** | AI and flexibility hooks: a non-personal aggregate view `v_webinar_performance_daily` for natural-language questions, webinar facts for the weekly management summary, and webinar engagement fields offered to the churn and repurchase indicators. The custom workflow builder (automation, R4) uses this module's event kinds unchanged. |
| **Later (proposal) and not built (decided here)** | Proposal "Later": native mobile app, predictive analytics (no predictive viewer scoring beyond the fixed thresholds). Not built by decision, because the proposal promises video through YouTube Live and Meet: native streaming or recording infrastructure; an in-browser presenter studio; paid webinar tickets (paid events stay booking tickets; webinars are free); breakout rooms; certificates; BEAM-generated captions, transcripts or AI summaries; an API or webhook sync with WebinarGeek or Zoom. |

## 2. Domain model

All tables live in `packages/db/src/schema/webinar.ts` and follow the architecture conventions (`id uuid pk default gen_random_uuid()`, `created_at timestamptz not null default now()`, `updated_at` on mutable tables, enums `pgEnum('<table>_<column>')`, `LocalizedText` jsonb via `localized()`). Views live in `webinar.views.ts`. Foreign keys point only at this module's tables and the Wave 0 contract tables (`sessions`, `persons`, `users`, `files`); `sessions.webinar_id` on the booking side is a plain uuid without FK (booking spec), so there is no schema import cycle.

### 2.1 Enums

| Enum | Values |
| --- | --- |
| `webinars_mode` | `live`, `simulive`, `on_demand` |
| `webinars_status` | `draft`, `published`, `live`, `ended`, `cancelled`, `archived` |
| `webinar_presenters_role` | `host`, `presenter`, `moderator` |
| `webinar_registrations_registered_mode` | `live`, `replay`, `on_demand` |
| `webinar_registrations_status` | `registered`, `cancelled`, `blocked` |
| `webinar_registrations_source` | `site`, `portal`, `admin`, `automation` |
| `webinar_registrations_person_status` | `lead`, `customer`, `member` |
| `watch_segments_mode` and `webinar_interactions_mode` | `live`, `replay`, `on_demand` (one shared TS const `WATCH_MODES`) |
| `webinar_interactions_kind` | `started`, `poll_answer`, `cta_shown`, `cta_clicked`, `chat`, `question`, `ended` (exactly the architecture list) |
| `webinar_moderation_actions_action` | `hide_message`, `unhide_message`, `mark_answered`, `mute_viewer`, `unmute_viewer`, `block_viewer`, `unblock_viewer` |

### 2.2 V1: no tables in this module

V1 webinar history lives in ops' `imported_history` (kinds `webinar_registration`, `webinar_attendance`, source `webinar_tool`). This module adds no V1 table, so nothing in V1 depends on the webinar schema. `v_person_webinar_stats` (section 2.4) reads those imported rows so segments and the person card keep the old tool's history after R2.

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

Webinar states (each arrow has a case in `lifecycle.test.ts`; every other move returns `conflict`):

| From | To | When | Modes |
| --- | --- | --- | --- |
| `draft` | `published` | `publishWebinar` passes rule 9 (live: after `webinar.create_broadcast` succeeds) | all |
| `draft`, `published` | `cancelled` | `cancelWebinar` | all |
| `published` | `live` | `webinar.sync_status` (YouTube `live`, or simulive `now >= starts_at`) or `forceLiveState` | live, simulive |
| `live` | `ended` | `webinar.sync_status` (YouTube `complete`, or simulive `now >= starts_at + duration_sec`) or `forceLiveState` | live, simulive |
| `ended`, `cancelled` | `archived` | `archiveWebinar` | all |
| `published` | `archived` | `archiveWebinar` | on_demand only |

`ended` keeps serving replays; `archived` serves nothing and hides the webinar from every list except the admin "Archived" tab. An on-demand webinar never passes through `live` or `ended`. A `published` live webinar that never went live stays `published` with `broadcast_error = 'never_live'` until staff reschedule (rule 11) or cancel it, so no state is a dead end.

Read contract for other modules: `webinars.id`, `slug` and `status` (with the `webinars_status` values above) are a stable read surface. forms (CTA kind `webinar`, R2) reads exactly these three columns to validate a CTA and build `/[locale]/webinars/<slug>`; a webinar is a linkable target while `status in ('published','live','ended')`, and any other status is forms' `missing_webinar` warning. Renaming or dropping one of these columns or values needs a forms change.

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
| muted_at | timestamptz | yes | set by `mute_viewer`: the viewer keeps watching but cannot chat or ask questions; cleared by `unmute_viewer` |
| muted_by_user_id | uuid -> `users.id` | yes | |
| created_at (= registered at), updated_at | timestamptz | no | |

Unique `(webinar_id, person_id)`. Indexes `(person_id)`, `(webinar_id, status)`, `(webinar_id, person_status)`. Checks: `status <> 'blocked' or blocked_at is not null`; `status <> 'cancelled' or cancelled_at is not null`.

Registration states (tested in `registration.test.ts` and `interactions.test.ts`, one case per arrow):

| From | To | By |
| --- | --- | --- |
| (none) | `registered` | `registerPerson` (site, portal, staff) |
| `registered` | `cancelled` | `cancelMyRegistration`, `cancelRegistrationByStaff` |
| `cancelled` | `registered` | registering again (rule 14) |
| `registered` | `blocked` | `moderate` with `block_viewer` |
| `blocked` | `registered` | `moderate` with `unblock_viewer` |

Registering again while `blocked` returns `webinar.access.blocked` and changes nothing. A cancelled registration cannot be blocked (the action returns `conflict`). Mute is a flag (`muted_at`), not a state, and works only on `registered`.

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

**`webinar_moderation_actions`** APPEND (already named in Wave 0's `APPEND_ONLY_TABLES`, platform decision 69; its trigger comes from the `select beam_protect_append_only();` custom migration the orchestrator adds after the wave that creates the table, so no frozen-file request is needed).

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

**`v_person_webinar_stats`**: per person `webinars_registered, webinars_attended_live, replays_watched, on_demand_watched, watch_sec_total, poll_answers, cta_clicks, last_webinar_registered_at, last_webinar_attended_at, imported_webinars_registered, imported_webinars_attended` (the last two count ops `imported_history` rows of kinds `webinar_registration` and `webinar_attendance`, and the two `last_*` columns also consider their `occurred_at`). Ops joins it into `v_person_profile` (section 10) so segments can use webinar registration, attendance, watch time, poll and CTA activity.

**`v_webinar_performance_daily`** (R4): per webinar per day: registrations, live attendees, replay viewers, on-demand viewers, average watch minutes per mode, poll answers, CTA clicks. No person ids; exposed to the `ai` schema.

### 2.5 Tables of other modules this module reads or writes

| Table (module) | Access | Why |
| --- | --- | --- |
| `persons`, `activity_events`, `v_consent_current`, `tags`, `person_tags`, `tasks` (crm) | write only through `crm` api / `recordEvent()`; read `persons.first_name, last_name, locale` and `activity_events` in queries | person identity, timeline facts, chat display names, poll tags, question tasks |
| `sessions` (booking) | read; written only through `booking.upsertWebinarSession` | link to the event calendar |
| `bookings` (booking), `orders` (commerce) | read in `v_webinar_conversions` | booking and purchase after the webinar or a CTA |
| `files`, `users`, `jobs`, `audit_log`, `feature_flags` (platform) | read; `files` written for registrant CSV exports | exports, owners, jobs, audit |
| `email_messages` (email) | written only through `email.sendTransactional` | access link, reschedule and cancel notices |
| `email_templates`, `email_template_versions` (email) | written only through `email.seedTemplate` from the seed `packages/db/src/seed/webinar.ts` (the marketing row `webinar-follow-up`); the five transactional system rows are created by email's own seed from the template registry | rows automation email steps reference by slug (section 8) |
| `automations`, `automation_versions` (automation), `retention_policies` (ops) | never written here | the webinar journeys are seeded by automation and the retention rows by ops (sections 4.8, 9.2) |
| `ad_spend_daily` (ops, R3) | read | cost per registration |
| `imported_history` (ops) | read in `v_person_webinar_stats` | V1 webinar history of the old tool |
| `tags` (crm) | read (`key`, `id`) when a poll's tag rules are saved | tag rule validation |

## 3. Business rules

Each rule names its test file (section 12). Times are UTC in storage and `Europe/Brussels` in display and schedules.

**V1 stopgap: requirements on the ops import (ops owns code and tests; listed in ops' `import.test.ts`)**
1. ops offers column-mapping presets `webinargeek_registrants`, `webinargeek_attendees`, `zoom_registrants`, `zoom_attendees` for import source `webinar_tool`, plus the generic mapping. Every row needs a valid email; rows without one are skipped with code `missing_email`, invalid ones are errors `invalid_email`. Reports hold row numbers and codes only.
2. Each row resolves the person with `crm.findOrCreatePersonByEmail` (`lower(email)`). A new person gets `acquisition = {source: 'webinar', campaign: <webinar title in the old tool>}` and `locale` from the row when it is one of the three locales, else `nl-BE`. An existing person's acquisition is never changed (crm rule 3).
3. The import never writes `consent_records` or `suppressions`, even when the file has an opt-in column. A row whose email hash is in `suppressions` with reason `erased` is skipped with code `erased`, so an erased person is never re-created.
4. A registrant row writes `imported_history` kind `webinar_registration`; an attendee row also writes kind `webinar_attendance` with `data = {provider, external_webinar_id, title, starts_at, mode: 'live'|'replay', watched_minutes}`. `external_id = <provider>:<external_webinar_id>:<first 16 hex of sha256(lower(email))>`, so the unique `(source, kind, external_id)` makes a re-import add nothing. Each row writes `ops.history_imported` (dedupe `import:webinar_tool:<kind>:<external_id>`), shown on the timeline as "Webinar registered (imported)" or "Webinar attended (imported)".
5. Imported history never triggers automations and never writes `webinar.*` events, so no reminder or follow-up fires for the past and native reports stay native.
6. A dry run parses and resolves persons read-only and writes only the report.
7. BEAM re-imports a fresh export every week until the R2 switch-over; the switch-over runbook `docs/runbooks/webinar-switch-over.md` (written by webinar-P6) lists the last import, the freeze of the old tool and the account closure.

**Webinar lifecycle (R2)**
8. A webinar of mode `live` or `simulive` has `starts_at` and a linked `sessions` row of kind `event` once it leaves `draft`. Publishing (and every later change of title, `starts_at` or duration) calls `booking.upsertWebinarSession(tx, ctx, { webinarId, title, startsAt, endsAt })` with `endsAt = starts_at + (duration_sec ?? planned_duration_minutes * 60)`; booking keys the row on `webinar_id`, returns `{ sessionId, created }`, and the webinar stores `sessionId` in `webinars.session_id` in the same transaction. For `simulive` the call is in `publishWebinar`; for `live` it is in the success transaction of `webinar.create_broadcast` that sets `published`, so a webinar whose broadcast fails never puts an event on the calendar. Cancelling calls `booking.cancelWebinarSession(tx, ctx, { webinarId, reason: cancelled_reason })`. The session has `capacity_seats = 0` and booking refuses every booking action on it (booking R64); registration here is the only entry. An `on_demand` webinar has no `starts_at` and no session.
9. Publishing requires: `assertComplete()` for `title`, `description`, every active poll question and option label and every active CTA label over `webinars.locales`; `spoken_locale` in `locales`; a future `starts_at` (live, simulive); `recording_video_id` with a known `duration_sec` (simulive, on-demand; `setWebinarVideo` enqueues `webinar.fetch_recording`, which fills `duration_sec`; until then Publish says "video still processing"). A `live` webinar becomes `published` only after `webinar.create_broadcast` succeeded; while it runs `publish_requested_at` is set and the screen shows "creating YouTube broadcast"; if the job is dead, `broadcast_error` is shown and the status stays `draft`.
10. Status moves `draft -> published -> live -> ended -> archived`, or to `cancelled` from `draft`/`published`. `live` is set from YouTube `lifeCycleStatus = live` (live) or `now >= starts_at` (simulive); `ended` from `complete` (live) or `now >= starts_at + duration_sec` (simulive). Staff can force `live`/`ended` from the host console when YouTube status is unavailable.
11. Changing `starts_at` or `title` of a published webinar bumps `version`, updates the broadcast and the session, and emails every `registered` registrant once per version (template `webinar.rescheduled`, only when `starts_at` changed by more than 5 minutes). A reschedule also clears `finalised_at` and `broadcast_error`, so `webinar.finalise` and the pre-flight check run again for the new time. Cancelling emails `webinar.cancelled`, writes `webinar.cancelled` per registration (the reminder journey exits on it), deletes the broadcast and cancels the session.
12. A recurring webinar is a series: `duplicateWebinar` copies title, description, locales, mode, polls, CTAs, presenters and settings to up to 26 new `draft` occurrences with the same `series_key` and new slugs `<slug>-<yyyy-mm-dd>`. Each occurrence has its own registrations, broadcast and report.
13. Host and participant links are separate: hosts use the Meet link and `/admin/webinars/[id]/host` (needs `webinars.host`); participants use their personal access link or the portal. A participant link never reveals the Meet URL.

**Registration and access**
14. One registration per person per webinar. `registerPerson` does `insert ... on conflict (webinar_id, person_id) do nothing`, then `select ... for update` of the row, so two concurrent registrations of one person end in one row and one `webinar.registered` event. Registering again returns the existing registration (status `cancelled` becomes `registered` again; `blocked` stays blocked and returns `webinar.access.blocked`) and resends the access email; a re-registration after a cancellation also writes a new `webinar.registered` (dedupe `webinar_reg:<registration_id>:registered:v<version>:after:<epoch ms of the previous cancelled_at>`) so the reminder journey, which exited on the cancellation, enrols again. At most 3 access emails per registration per rolling hour (`access_emails_sent` and `last_access_email_at` are updated under the same row lock; the counter resets when `last_access_email_at` is more than an hour old).
15. `registered_mode` is `live` when registering before `live_ended_at` (or before `starts_at + planned duration` when not yet live), `replay` after that, `on_demand` for on-demand webinars. Registration is refused (`webinar.register.closed`) for cancelled or archived webinars, for an ended webinar with replay disabled or expired, and for an ended webinar with `is_replay_gated = true` (gated replays are for people who registered before the end).
16. `person_status` is snapshotted from `crm.getPersonStatus` at registration and never recomputed; reporting splits on this snapshot.
17. Registration is not attendance: registering writes `webinar.registered` only. Nothing in reports or automations treats a registration as attended (acceptance test).
18. Registering never grants marketing consent. The site form shows optional, unticked checkboxes for `events` and `newsletter`; a ticked box writes `consent_records` through `crm.recordConsent` with method `form`, `source = 'webinar:<slug>'`, `ref = {type: 'webinar_registration', id}` and the wording version shown. The form links the privacy notice (site page `/[locale]/privacy`) under the button (GDPR art. 13 information at collection); no terms or waiver checkbox is needed because the webinar is free and online. Reminders and the access email are service messages about the registration (lawful basis contract), so they need no consent.
19. The access token is `<registration_id>.<token_version>.<mac>` with `mac = base64url(HMAC-SHA256(k, registration_id + '.' + token_version))[0..32]` and `k = HKDF-SHA256(AUTH_SECRET, 'beam-webinar-access-v1')`. `access_token_hash = sha256(token)` is stored for lookup. Verification recomputes the MAC in constant time and checks the hash. Bumping `token_version` revokes old links. Raw tokens are never stored or logged.
20. A token grants viewing and interacting for that one webinar only. It never signs the person into the portal. A logged-in customer reaches the same player at `/[locale]/account/webinars/[id]` without a token.
21. A `blocked` or `cancelled` registration gets `403 webinar.access.blocked` / `webinar.access.cancelled` on every viewer endpoint; a blocked viewer's open player stops at the next heartbeat (this is "remove" of blueprint 18). A muted registration (`muted_at` set) keeps watching and answering polls, but `chat` and `question` return `403 webinar.chat.muted` and the composer shows "The host has paused your chat".

**Modes, watch time and thresholds**
22. The server decides the mode (`resolveMode()` in core): `live` when the webinar is `live` (live) or `now` is within `[starts_at, starts_at + duration_sec)` (simulive); `replay` after the end when the replay is enabled, unexpired and not over its view limit; `on_demand` for on-demand webinars. Before `starts_at - 15 min` the player shows a countdown. A client heartbeat with another mode gets `409 mode_changed` and reloads.
23. Simulive is presented as live: interactions and segments during the scheduled showing carry mode `live`; the player starts at `seekTo(now - starts_at)`, hides seek controls and resyncs when drift exceeds 10 s. After the showing, the same video is a replay.
24. The player sends a heartbeat every 15 s while playing. The server writes one `watch_segments` row per heartbeat. For `live`, `to_sec = floor(now - live_started_at)` and `from_sec = max(0, to_sec - min(15, seconds since the previous heartbeat of this view))`; client positions are ignored. For `replay` and `on_demand`, client positions are clamped to `[0, duration_sec]`, and the span is cut to at most `seconds since the previous heartbeat of this view + 5` and never above 30.
25. A heartbeat of a view that arrives less than 10 s after that view's previous heartbeat is rejected with `429` and writes nothing; on top, platform's `rate_limits` bucket `webinar_heartbeat` allows 8 heartbeats per registration per minute, and bucket `webinar_state` allows 30 `/api/webinar/state` polls per registration per minute (platform PL-68 and decision 83: the player polls every 5 s while live, so two tabs make 24). Both routes are exempt from the 60/min per-IP rule in the app and in the Vercel WAF (platform's `security-controls.md`), because a room of viewers behind one venue NAT shares one IP. Paused, buffering and ended states write no segment. Every heartbeat and `startView` takes `select ... for no key update` on the registration row first, so two tabs of one registration are serialised: thresholds, view counts and the rate limit see each other's writes.
26. Watch time per mode is the merged length of that mode's segments (`v_webinar_watch`, and `mergeIntervals()` in core for the heartbeat; a test asserts both give the same seconds). Watch time of one mode never adds to another (scenario 5).
27. Thresholds per mode: `15m` at 900 s, `30m` at 1,800 s, `50pct` at half of `duration_sec` (or the planned duration while the real one is unknown), `end` when the furthest merged position (`max_position_sec`) reaches `duration_sec - 60` (edge case 3). `attended` at `attended_min_sec` (default 300 s). Each emits one `activity_events` row per registration per mode (`webinar.attended`; `webinar.watched` with `data.threshold`), deduped by `webinar_reg:<registration_id>:<mode>:<fact>`, written in the heartbeat transaction. A threshold once written is never retracted, even when the real `duration_sec` arrives later and is longer than the planned one; `webinar.finalise` only adds thresholds that the real duration makes reachable.
28. "Started" is the first playing heartbeat or `startView` of a mode: interaction `started` (one per view) and event `webinar.started` (one per registration per mode). Registered, started, attended and watched (thresholds) are four distinct facts.
29. `webinar.finalise` runs once per live or simulive webinar, at the first scan where `live_ended_at <= now() - 30 min` and the replay situation is known: `recording_video_id` and `duration_sec` are set, or `is_replay_enabled = false`, or `live_ended_at <= now() - 48 h`. It writes `webinar.no_show` (mode `live`, `data: {webinar_id, registration_id, replay_available: boolean, replay_until_at}`) for every `registered` registrant with `registered_mode = 'live'` and no live `webinar.attended` (a person who started but watched less than `attended_min_sec` is a no-show), and back-fills any live threshold events not yet written. `replay_available` lets the no-show journey send the replay link only when there is one. If the webinar never went live by `starts_at + 2 h`, it writes no `webinar.no_show`, sets `broadcast_error = 'never_live'` and creates a task for `owner_user_id`.

**Replay and on-demand access**
30. Replay is available from `live_ended_at` once `recording_video_id` is set, until `replay_until_at` (null = no expiry), only when `is_replay_enabled`. On-demand access ends `on_demand_access_days` after the registration when set, and at `replay_until_at` when set, whichever is first.
31. A view is counted when `startView` is called for `replay` or `on_demand` and no `started` interaction of the same registration and mode exists in the last 30 minutes (a reload does not count). When `replay_view_limit` is reached, `startView` returns `webinar.access.limit_reached` and the page says so.
32. Expiry during a view: the next heartbeat returns `stop: 'expired'`; segments up to then are kept.

**Polls, CTAs, chat and questions**
33. A poll accepts one answer per registration per mode (partial unique index). A replay answer and a live answer of the same person are two rows with their own modes and both count, each in its own mode (acceptance: replay poll stored separately). Option keys must exist on the poll; `allow_multiple = false` accepts exactly one key.
34. In live, polls and CTAs appear when the host launches them (`live_launched_at`, `live_shown_at`) and the launch position becomes `show_at_sec` if it was empty, so the replay shows them at the same moment. In simulive, replay and on-demand they appear at `show_at_sec` for `show_for_sec`. A poll without `show_at_sec` never appears outside live.
35. A poll answer writes interaction `poll_answer` and event `webinar.poll_answered` (`data: {poll_key, option_keys, option_key}`, mode; `option_key` is the single chosen key, or null for a multiple-choice answer with more than one key, so crm's segment rules on `option_key` work). For each `tag_rules` entry whose `option_keys` intersect the answer and whose `modes` include the mode, `crm.applyTag(tx, ctx, personId, tag_key, 'automation')` (crm's published function; there is no `crm.tagPerson`) applies the tag in the same transaction. Tag keys are validated by reading `tags.key` when the poll is saved (`validation` error listing unknown keys). Segments use the tags or the `webinar.poll_answered` event; automations trigger on the event.
36. A CTA shown writes `cta_shown` once per registration per CTA per mode (no timeline event). A click goes through `/api/webinar/cta/[ctaId]?r=<registration_id>&m=<mode>&s=<sig>`, where `sig = base64url(HMAC-SHA256(k_cta, registration_id + '.' + cta_id + '.' + mode))[0..22]` and `k_cta = HKDF-SHA256(AUTH_SECRET, 'beam-webinar-cta-v1')`. The signature only records a click; it grants no viewing access, so the access token never appears in a redirect URL. The route writes `cta_clicked` and event `webinar.cta_clicked` (first per registration, CTA and mode; `data: {cta_key, url}`), and redirects 302 to the URL with `utm_source=beam-webinar&utm_medium=<mode>&utm_campaign=<slug>&utm_content=<cta_key>` added when absent.
37. Chat and questions: 1-500 characters, at most one message per 3 s and 60 per hour per registration. Live chat is visible to every live viewer unless hidden; questions are visible only to hosts. In replay and on-demand there is no chat; questions are allowed, and each one creates a task through `crm.createTask(tx, ctx, {title: 'Webinar question from a viewer', kind: 'follow_up', source: 'system', ownerUserId: owner_user_id, personId, dueAt: now + 24 h, ref: {type: 'webinar_interaction', id}, dedupeKey: 'webinar_question:<interaction_id>'})`. A muted or blocked registration cannot post (rule 21). Every question writes event `webinar.question_asked`; the first chat message per registration per mode writes `webinar.chat_posted`.
38. Chat display name is the first name plus the initial of the last name, read at display time; an erased person's messages disappear with the registration.

**Reporting**
39. Reports split by `person_status` snapshot (`lead`, `customer`, `member`) and total. Per mode they show registered, started, attended or watched, 15m, 30m, 50 %, end, average watch minutes, poll responses, CTA shown and clicked; then booked and purchased within the period, revenue in the period and conversion rate = persons with a first booking or paid order within the period ÷ registrations.
40. The period defaults to `webinars.conversion_window_days` and can be set in the report to 7, 14, 30, 60, 90 or 180 days. Conversion is counted from `anchor_at` (rule-defined in `v_webinar_registration_facts`); "booking after CTA" and "purchase after CTA" are counted from the first click of that CTA.
41. The aggregate report CSV contains no personal data. The registrant CSV (name, email, status, per-mode facts) needs `persons.export` in addition to `webinars.host` and is audited (`webinar.registrants_exported`).

**Pre-flight, monitoring and accessibility**
42. Pre-flight (`webinar.preflight`, every 5 minutes): for a `published` live webinar starting within 60 minutes without `youtube_video_id` or with `broadcast_error`, it sends `notify.slack` (High, key `webinar:<id>:preflight:t60`) and creates an owner task (dedupe `webinar_preflight:<id>:t60`). At 15 minutes before start, a `youtube_lifecycle` outside `ready`, `testing`, `live` sends `notify.slack` "stream not connected" (key `webinar:<id>:preflight:t15`) and shows a red banner in the host console. A simulive webinar without a processed recording 60 minutes before start gets the same t60 alert. Each alert fires once per webinar per stage.
43. Monitoring for the SLA (99.5 % uptime, proposal section 7): viewer routes log `{route, webinarId, ms, status}` without tokens or personal data; `webinar.sync_status` failing 10 times in a row during a live window alerts (section 6); a webinar `live` for more than 5 minutes that had live segments earlier but none in the last 3 minutes (heartbeat ingestion stopped) sends a Slack alert "heartbeats failing" (checked by `webinar.sync_status`, key `webinar:<id>:alert:heartbeat`). The ops daily digest lists webinars of the next 48 hours with their broadcast state through `listUpcomingWebinarHealth()` (section 4.7).
44. Accessibility (WCAG 2.1 AA) of the landing page, the player page and the host console: every control is keyboard reachable with a visible focus ring; a new poll or CTA is announced through one `aria-live="polite"` region and never steals focus; the poll card is a `fieldset` with a `legend`; captions are one toggle that reloads the player with `cc_load_policy=1` and `cc_lang_pref` set to the spoken language (`nl`, `fr`, `en`); text contrast comes from `@beam/ui` tokens (4.5:1); the countdown and the live status are text, not only colour; `prefers-reduced-motion` stops the countdown animation.

## 4. Server surface

Files: `apps/web/modules/webinar/{actions,queries,api,jobs,schedules,events,permissions,nav,privacy,seed,config,merge-fields}.ts` (the Wave 0 stubs; `config.ts` declares the flag `ff_webinar_portal`); internals split into `apps/web/modules/webinar/server/{lifecycle,registration,viewer,watch,interactions,report,preflight,kpis,ai-facts}.ts` re-exported by the barrel files. Zod inputs live in `packages/core/src/webinar/schemas.ts`. All actions use `action({ name, audience, permission, input, audit }, handler)`; `name` is `webinar.` plus the snake_case verb of the export (`createWebinar` -> `webinar.create`, `registerPersonByStaff` -> `webinar.register_person_by_staff`); staff writes are audited with `audit: 'webinars'`. Inputs are Zod schemas named `<Action>Input` (`CreateWebinarInput`, ...).

### 4.1 Event kinds (`events.ts`, `defineEvent`)

| Kind | `mode` column | `data` | Written by |
| --- | --- | --- | --- |
| `webinar.registered` | registered_mode | `{webinar_id, slug, title, webinar_mode, starts_at, ends_at, registration_id, session: {id, kind: 'event'} \| null, person_status, source, utm, rescheduled?: true}` (`ends_at = starts_at + planned or real duration`; both null for on-demand) | register paths, reschedule (edge case 9) |
| `webinar.registration_cancelled` | registered_mode | `{webinar_id, registration_id, by: 'customer'\|'staff'}` | cancel actions |
| `webinar.started` | mode | `{webinar_id, registration_id}` | first view of a mode |
| `webinar.attended` | mode | `{webinar_id, registration_id, watched_sec}`; mode `replay` = blueprint "replay viewed", `on_demand` = "on-demand viewed" | heartbeat, finalise |
| `webinar.watched` | mode | `{webinar_id, registration_id, threshold: '15m'\|'30m'\|'50pct'\|'end', watched_sec}` | heartbeat, finalise |
| `webinar.no_show` | `live` | `{webinar_id, registration_id, replay_available, replay_until_at}` | finalise |
| `webinar.poll_answered` | mode | `{webinar_id, registration_id, poll_key, option_keys, option_key}` (rule 35) | interact route |
| `webinar.cta_clicked` | mode | `{webinar_id, registration_id, cta_key, url}` | CTA redirect |
| `webinar.question_asked` | mode | `{webinar_id, registration_id, interaction_id}` (no text) | interact route |
| `webinar.chat_posted` | mode | `{webinar_id, registration_id}` | interact route |
| `webinar.cancelled` | null | `{webinar_id, registration_id, reason}` | cancelWebinar |
| `webinar.rescheduled` | null | `{webinar_id, registration_id, starts_at, previous_starts_at}` | updateWebinar |

`ref_type = 'webinar_registration'`, `ref_id = registration id` on every native event; `actor` is the customer, staff user or `system`. None is `is_sensitive`.

### 4.2 Server actions

| Action (`name`) | Audience / permission | Input (Zod summary) | Output | Writes |
| --- | --- | --- | --- | --- |
| `createWebinar` | staff / `webinars.host` | `{slug, mode, title, description, locales, spokenLocale, startsAt?, plannedDurationMinutes, ownerUserId}` | `{webinarId}` | `webinars` (draft); audit `webinar.created` |
| `updateWebinar` | staff / `webinars.host` | `{webinarId, version, ...partial settings}` | `{version}` | `webinars`; when published: `booking.upsertWebinarSession(tx, ctx, {webinarId, title, startsAt, endsAt})`, jobs `webinar.update_broadcast`, `webinar.notify_registrants` (reason `rescheduled`), events `webinar.rescheduled`; audit `webinar.updated` with old/new |
| `publishWebinar` | staff / `webinars.host` | `{webinarId, version}` | `{status: 'published'\|'publishing'}` | checks rule 9; live: `publish_requested_at`, jobs `webinar.create_broadcast` (which upserts the session when it sets `published`, rule 8), `webinar.create_meet_space`; simulive: status `published`, `published_at`, `booking.upsertWebinarSession` and `session_id`; on-demand: status `published`, `published_at`, no session; audit `webinar.published` |
| `cancelWebinar` | staff / `webinars.host` | `{webinarId, reason (3-500), notify: boolean}` | `{cancelledRegistrations}` | status `cancelled`; jobs `webinar.delete_broadcast`, `webinar.notify_registrants` (reason `cancelled`) when notify; `booking.cancelWebinarSession(tx, ctx, {webinarId, reason})` (live and simulive; returns `{sessionId: null}` when no session exists, so a draft cancel is safe); events `webinar.cancelled`; audit |
| `archiveWebinar` | staff / `webinars.host` | `{webinarId}` | `{}` | status `archived` (only from `ended`, `cancelled`, or on-demand `published`); audit |
| `duplicateWebinar` | staff / `webinars.host` | `{webinarId, startsAt: Date[] (1-26), seriesKey?}` | `{webinarIds}` | new drafts with copies; audit `webinar.duplicated` |
| `setWebinarVideo` | staff / `webinars.host` | `{webinarId, field: 'youtube_video_id'\|'recording_video_id', videoId}` | `{}` | override (e.g. Meet created its own broadcast); enqueues `webinar.fetch_recording` with key `webinar:<id>:recording:set:<videoId>` to validate the id and read `duration_sec`; audit `webinar.video_set` |
| `upsertPoll`, `deletePoll` | staff / `webinars.host` | `{webinarId, pollId?, key, question, options, allowMultiple, showAtSec?, showForSec, tagRules, sortOrder}` / `{pollId}` | `{pollId}` | `webinar_polls`; delete only without answers, else `is_active = false`; audit |
| `upsertCta`, `deleteCta` | staff / `webinars.host` | `{webinarId, ctaId?, key, label, url, showAtSec?, showForSec, sortOrder}` / `{ctaId}` | `{ctaId}` | `webinar_ctas`; same delete rule; audit |
| `upsertPresenter`, `removePresenter` | staff / `webinars.host` | `{webinarId, presenterId?, userId? \| email?, displayName, role}` | `{presenterId}` | external email -> `crm.findOrCreatePersonByEmail` (no consent); audit |
| `launchPoll`, `closePoll`, `showCta`, `hideCta` | staff / `webinars.host` | `{pollId}` / `{ctaId}` | `{}` | `live_*` columns; `show_at_sec` when empty |
| `moderate` | staff / `webinars.host` | `{webinarId, action, interactionId?, registrationId}` | `{}` | `webinar_moderation_actions`; block/unblock also sets `webinar_registrations.status`, `blocked_at`, `blocked_by_user_id`; mute/unmute sets or clears `muted_at`, `muted_by_user_id`; audit `webinar.moderated` |
| `forceLiveState` | staff / `webinars.host` | `{webinarId, to: 'live'\|'ended'}` | `{}` | `live_started_at` / `live_ended_at`, status; audit |
| `registerPersonByStaff` | staff / `webinars.host` + `persons.read` | `{webinarId, personId, sendAccessEmail}` | `{registrationId}` | as rule 14, source `admin`; audit |
| `cancelRegistrationByStaff`, `revokeAccessLink` | staff / `webinars.host` | `{registrationId}` | `{}` | status / `token_version + 1`; audit |
| `resendAccessLink` | staff / `persons.read` (so customer service, sales and reception can answer "I lost my link" from the person page) | `{registrationId}` | `{}` | access email (throttle of rule 14); audit `webinar.access_link_resent` |
| `registerForWebinar` | customer | `{webinarId, locale, consents: {events?: boolean, newsletter?: boolean}, wordingVersion}` | `{registrationId, watchPath}` | registration (source `portal`), event, consent, email `webinar.access` |
| `cancelMyRegistration` | customer | `{registrationId}` (must be own) | `{}` | status `cancelled`, `cancelled_at`, event |
| `exportWebinarRegistrants` | staff / `webinars.host` + `persons.export` | `{webinarId}` | `{fileId}` (kind `export`, 7-day expiry) | `files`; audit `webinar.registrants_exported` |

Every registration path calls one core-backed function `registerPerson(tx, ctx, {webinarId, personId, source, locale, utm, consents})` in `server/registration.ts`, which sends the access email (the registration confirmation) through `email.sendTransactional(ctx, {template: 'webinar.access', personId, locale, data: {webinarId, registrationId, accessUrl, startsAt, spokenLocale}, context: {webinar_id, registration_id}, key: 'webinar_reg:<registration_id>:access:<n>'})` (email's signature, email decision 6: ids travel in `context` and `data`, never in a `variables` field; result `{emailMessageId, jobId}`; it writes `email_messages` and enqueues `email.send` in the same transaction, so the transactional outbox holds; `<n>` is the new `access_emails_sent`). A new person also gets `acquisition = {source: 'webinar', campaign: <slug>, webinar_id, utm}` from `crm.findOrCreatePersonByEmail` (crm's `Acquisition` already has `webinar_id`).

### 4.3 Queries (`queries.ts`)

`listWebinars({status?, mode?, q?, page})`, `getWebinar(id)`, `getWebinarBySlug(slug, locale)` (public: published, live, ended with replay only), `listRegistrations(webinarId, {status?, personStatus?, q?, page})` (needs `persons.read`), `getHostConsoleState(webinarId)`, `getWebinarReport(webinarId, {periodDays})`, `getPollResults(webinarId)` (per option per mode), `getCtaResults(webinarId, {periodDays})`, `listMyWebinars(personId)` (portal: upcoming, replays available, on-demand library). Report queries read only the views of section 2.4.

### 4.4 Route handlers (all `runtime = 'nodejs'`, `dynamic = 'force-dynamic'`)

| Route | Method | Auth | Input | Output | Writes |
| --- | --- | --- | --- | --- | --- |
| `/api/public/webinars/[slug]/register` | POST | public, rate limit 20/min/IP, honeypot field | `{email, firstName, lastName?, locale, consents, wordingVersion, utm}` | always `202 {ok: true}` (no account enumeration) | person (`crm.findOrCreatePersonByEmail`, acquisition `webinar`), registration (source `site`), event, consents, access email |
| `/api/public/webinars/[slug]/ics` | GET | public | `?locale` | `text/calendar` with title, start, end and the landing URL (never the personal link); `Cache-Control: public, max-age=300` | none |
| `/api/webinar/view` | POST | viewer (token header `x-webinar-token` or customer session) | `{webinarId}` | `{viewId, mode, videoId, startSec, durationSec, controls: boolean, polls, ctas, chatEnabled, questionsEnabled}` or `{error: 'not_started'\|'expired'\|'limit_reached'\|'blocked'\|'cancelled'}` | `started` interaction, `webinar.started` |
| `/api/webinar/heartbeat` | POST | viewer | `{webinarId, viewId, mode, fromSec, toSec, state: 'playing'\|'paused'\|'buffering'\|'ended'}` | `{ok, nextMs: 15000, stop?: 'blocked'\|'expired'\|'mode_changed'}` | `watch_segments`, threshold and attended events; `ended` interaction on state `ended` |
| `/api/webinar/state` | GET | viewer; bucket `webinar_state` 30 per registration per minute | `?webinarId&after=<ISO>` | `{status, videoId, activePoll?, activeCta?, chat: [{id, name, text, at}], myAnswers, muted: boolean}`; shared part memoised 2 s per webinar per instance | none |
| `/api/webinar/interact` | POST | viewer | discriminated union `{type: 'poll_answer', pollId, optionKeys}` \| `{type: 'chat'\|'question', text}` \| `{type: 'cta_shown', ctaId}` plus `{webinarId, viewId, atSec}` | `{ok}` / `409 already_answered` / `403 muted` / `429` | interactions, events, tags, tasks |
| `/api/webinar/cta/[ctaId]` | GET | signed click parameters `?r&m&s` (rule 36); no access token | | 302 to the CTA URL; a bad signature still redirects but records nothing | `cta_clicked`, `webinar.cta_clicked` |

The viewer resolver `resolveViewer(req, webinarId)` (`server/viewer.ts`) returns `{registration, webinar, via: 'token'|'session'}` or a typed error; it never accepts a token for another webinar. The heartbeat and state routes are exempt from the 60/min per-IP rule in both layers (app `rate_limits` and Vercel WAF, platform PL-68; a group in the centre shares one IP) and are limited per registration instead (rule 25). The other routes of this table fall under the 60/min per-IP rule, plus their own limits listed above.

### 4.5 Jobs (`jobs.ts`, `defineJob`)

| Kind | Lane, priority | Key | Retry | Does |
| --- | --- | --- | --- | --- |
| `webinar.create_broadcast` | fast, 3 | `webinar:<id>:broadcast` | 6; 4xx -> `PermanentError` with `broadcast_error`; a booking `conflict` (`webinar_session_mismatch`) is permanent too | finds an existing broadcast by description marker `beam-webinar:<id>` before creating; inserts unlisted broadcast + stream, binds; then in one transaction stores ids, calls `booking.upsertWebinarSession(tx, ctx, {webinarId, title, startsAt, endsAt})`, stores `session_id`, sets `published` and `published_at` |
| `webinar.update_broadcast` | fast, 3 | `webinar:<id>:broadcast_update:v<version>` | 6 | title, description, scheduled start |
| `webinar.delete_broadcast` | fast, 5 | `webinar:<id>:broadcast_delete` | 6; 404 = success | deletes an unstarted broadcast; a completed one is kept for the recording |
| `webinar.create_meet_space` | fast, 5 | `webinar:<id>:meet` | 6; failure leaves `host_meet_url` empty and staff paste one | Meet REST v2 `spaces.create`, stores `host_meet_url`, `meet_space_name` |
| `webinar.sync_status` | fast, 2 | `webinar:<id>:status:<YYYY-MM-DDTHH:mm>` | 2 (the next minute retries anyway) | live: `liveBroadcasts.list(id)`; sets `youtube_lifecycle`, `live_started_at`, `live_ended_at`, status. Simulive: pure time rule, no API call |
| `webinar.fetch_recording` | fast, 5 | `webinar:<id>:recording:<YYYY-MM-DDTHH:mm>` | 3 | `videos.list(id, contentDetails,processingDetails)`; when processed sets `recording_video_id` (if empty) and `duration_sec` |
| `webinar.finalise` | fast, 5 | `webinar:<id>:finalise:v<version>` (a reschedule bumps `version`, so the new time gets its own finalise) | 6 | rule 29; sets `finalised_at` |
| `webinar.preflight_check` | fast, 2 | `webinar:<id>:preflight:<t60\|t15>` | 3 | rule 42: checks one webinar, sends `notify.slack`, creates the owner task |
| `webinar.scan_live`, `webinar.scan_recordings`, `webinar.scan_finalise`, `webinar.preflight` | fast, 2 | `schedule:<kind>:<YYYY-MM-DDTHH:mm>` (set by the tick) | 2 | the schedule handlers of 4.6: one indexed select, then `enqueue` of the per-webinar jobs; a schedule entry is a job kind like any other |
| `webinar.notify_registrants` | bulk, 5 | `webinar:<id>:notify:<reason>:v<version>:chunk:<n>` | 6 | 200 registrations per chunk; `email.sendTransactional(ctx, {template: 'webinar.rescheduled' \| 'webinar.cancelled', personId, locale, data, context: {webinar_id, registration_id}, key: 'webinar_reg:<registration_id>:notice:<reason>:v<version>'})` |

Every handler is idempotent: a second run with the same payload leaves the same state (`jobs.test.ts`).

### 4.6 Schedules (`schedules.ts`, cron in `Europe/Brussels`)

| Schedule | Cron | Enqueues |
| --- | --- | --- |
| `webinar.scan_live` | `* * * * *` | `webinar.sync_status` for webinars with mode `live`/`simulive`, status `published` and `starts_at` within the next 30 min or past, or status `live` |
| `webinar.scan_recordings` | `*/10 * * * *` | `webinar.fetch_recording` for `live` webinars `ended` less than 48 h ago without `duration_sec`, and for any webinar whose `recording_video_id` is set without `duration_sec` and was updated less than 48 h ago (simulive and on-demand uploads still processing) |
| `webinar.scan_finalise` | `*/5 * * * *` | `webinar.finalise` for webinars `ended` with `live_ended_at <= now() - 30 min` and the replay situation known (rule 29), or `published` with `starts_at + 2 h <= now()`, and `finalised_at is null` |
| `webinar.preflight` | `*/5 * * * *` | `webinar.preflight_check` for `published` live and simulive webinars with `starts_at` in the next 60 minutes (stage `t60`) or the next 15 minutes (stage `t15`) |

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
export function countWebinarLeadsWithoutBooking(db: DbOrTx, input: { startedSince: Date }): Promise<number>; // ops card `webinar_leads_not_booked` (ops rule 29)
export function listWebinarLeadsWithoutBooking(db: DbOrTx, input: { startedSince: Date; limit: number }): Promise<Array<{
  personId: string; webinarId: string; registeredAt: Date }>>;    // same definition, newest registrations first (ops card rows)
export type WebinarCard = { id: string; slug: string; title: string; mode: WebinarMode; startsAt: Date | null;
  spokenLocale: Locale; landingUrl: string };                       // title resolved in the requested locale
export function getWebinarCards(tx: DbOrTx, ids: string[], locale: Locale): Promise<WebinarCard[]>; // email `webinar` block (email-P8 `resolveCards.webinars`); unknown, draft, cancelled or archived ids are left out; order follows `ids`
export function listUpcomingRegistrationsForPerson(db: DbOrTx, personId: string): Promise<PersonWebinarRow[]>; // site account home card
export function listUpcomingWebinarHealth(db: DbOrTx, within: { hours: 48 }): Promise<Array<{ webinarId: string; title: string;
  startsAt: Date; mode: WebinarMode; youtubeLifecycle: string | null; broadcastError: string | null; registrations: number }>>; // ops daily digest
export { WebinarSignup } from './ui/webinar-signup'; // server component { webinarId, locale } for site's `webinar_signup` block
```

`countWebinarLeadsWithoutBooking` counts registrations with `person_status = 'lead'` of webinars whose `starts_at` (or, for on-demand, the registration) is after `startedSince`, whose person has no `bookings` row created after the registration; ops passes `now - settings.retention_defaults.webinar_lead_window_days`. It is the one definition of "webinar leads have not booked" (blueprint 23), so ops uses it instead of its own SQL; `listWebinarLeadsWithoutBooking` returns the rows of the same predicate for the card's first 10 lines (requested by ops rule 29).

### 4.8 Seeds and the webinar journeys

The automation rows are seeded by **automation** (`packages/core/src/automation/seeds/webinar.ts`, automation-P4 drafts and automation-P8 activation; the architecture gives seeded sequences to automation), never by this module, and this module does not call `automation.seedAutomations` either: that function is internal to automation (`engine/seed-automations.ts`, not in its `api.ts`), and one owner of the journey definitions avoids two seeds of the same slug (section 13, decision 43). This module seeds, in `packages/db/src/seed/webinar.ts` and `apps/web/modules/webinar/seed.ts`: the one marketing `email_templates` row `webinar-follow-up` through `email.seedTemplate` (section 8; the five transactional system rows come from email's registry seed), and in non-production one demo webinar of each mode with polls, CTAs and fake YouTube ids. The flag `ff_webinar_portal` (default `off`) is declared in `config.ts`; platform's flag seed creates the row. The retention rows are ops' (section 9.2).

What this module requires of the seeded journeys (automation tests them in `seeded-journeys-r2.test.ts`; this module's events make them possible):

| Journey (slug) | Group, priority | Status at R2 | Trigger | Required behaviour |
| --- | --- | --- | --- | --- |
| `webinar-registration` | `transactional` (not exclusive) | active | `webinar.registered` where `mode = 'live'`, subject ref, anchor `data.starts_at` | no confirmation step (the access email of rule 14 is the confirmation); steps `d7` -10080 min, `d3` -4320 min, `h3` -180 min with the code-backed transactional template `webinar.reminder` (one template; `loadProps` takes the variant from the step key); `re_entry: "after_days:0"`; exit on `webinar.cancelled`, `webinar.registration_cancelled`, `webinar.rescheduled`. A Friday registrant for a Sunday webinar gets the access email and the `h3` day-of reminder only; `d7` and `d3` are `skipped_late_entry` (scenario 1, as the proposal states it) |
| `webinar-watched-end` | `webinar` (exclusive), 10 | draft until ops records the DPIA decision `watch_time_profiling` (`ops.isDpiaApproved`), then active (this applies to every row marked DPIA) | `webinar.watched` where `data.threshold = 'end'` and `mode = 'live'` | `follow_up` marketing email +60 min (`webinar-follow-up`, purpose `events`); sales task +1 d `unless has_future_booking`; exit on `order.paid` |
| `webinar-cta-click` | `webinar` (exclusive), 15 | DPIA | `webinar.cta_clicked` where `mode = 'live'` | `follow_up` email +60 min only (the sales task moved to `webinar-cta-sales-task`); exit on `order.paid` |
| `webinar-watched-30` | `webinar` (exclusive), 20 | DPIA | `webinar.watched` where `data.threshold in ('30m','50pct')` and `mode = 'live'` | `follow_up` email +60 min (BEAM Experience invitation); exit on `order.paid` |
| `webinar-watched-15` | `webinar` (exclusive), 40 | DPIA | `webinar.watched` where `data.threshold = '15m'` and `mode = 'live'` | tag `engaged`; `follow_up` email +60 min; exit on `order.paid` |
| `webinar-replay` | `webinar` (exclusive), 50 | DPIA | `webinar.attended` where `mode = 'replay'` | `follow_up` email +60 min; exit on `order.paid` |
| `webinar-on-demand` | `webinar` (exclusive), 55 | DPIA | `webinar.attended` where `mode = 'on_demand'` | `follow_up` email +60 min; exit on `order.paid` |
| `webinar-attended` | `webinar` (exclusive), 60 | DPIA | `webinar.attended` where `mode = 'live'` | `follow_up` email +60 min; exit on `order.paid`; any later live threshold or CTA journey (lower number) supersedes it before its step is due |
| `webinar-no-show` | `webinar` (exclusive), 70 | active at R2 (no watch-time profiling: it reacts to absence) | `webinar.no_show` where `data.replay_available = true` | +60 min the code-backed transactional template `webinar.replay_available` (`loadProps` builds the access link from `context.registration_id`); exit on `webinar.attended`; superseded by `webinar-replay` when the person watches the replay |
| `webinar-cta-sales-task` | `sales` (not exclusive) | DPIA | `webinar.cta_clicked` (any mode), subject ref `webinar_registration:<id>` with `re_entry: "never"`, so one task per registration whatever the mode or number of clicks | one sales task +0 `unless has_future_booking` ("Webinar CTA clicked: <cta_key>"); being outside the exclusive lane, it fires even while the person is in a `customer_journey` or another lane journey |
| `webinar-poll-answer` | `sales` (not exclusive) | active | `webinar.poll_answered` | optional extra tags; the poll's own `tag_rules` already tag in the answer transaction (rule 35) |

Every journey whose trigger is live behaviour filters `mode = 'live'`, so replay and on-demand facts never enter a live journey (scenario 5). Priorities are automation's seeded values (lower wins inside the exclusive `webinar` group, lane `sales_journey`); this table restates them so both specs test the same order.

`apps/web/modules/webinar/merge-fields.ts` exports `mergeFields: Record<string, (args: { tx; personId; context; locale }) => Promise<string | null>>` with the fields `access_url` (`getAccessUrl(tx, context.registration_id, locale)`), `title` (the webinar title in `locale`, from `context.webinar_id` or the registration's webinar) and `starts_at_local` (Brussels time, `Intl.DateTimeFormat(locale)`); `pnpm gen:indexes` keys them `webinar.access_url`, `webinar.title`, `webinar.starts_at_local` in `MERGE_FIELDS` (platform's collector, Wave 0). A resolver reads only the message's `context` ids (`webinar_id`, `registration_id`), which every send of this module and every webinar journey enrolment (subject ref `webinar_registration:<id>`) carries; a missing id returns `null`, which email renders as the token's fallback or an empty string (email rule 23).

## 5. Screens

All lists use `DataTable` from `@beam/ui`; loading states are skeleton rows from `loading.tsx`; errors render the shared `error.tsx` with the request id and a Retry button; every string comes from the `webinar` catalogue.

### 5.1 Staff back-office (`app/(admin)/admin/webinars/...`, nav entry "Webinars", needs `webinars.host`)

| Route | Shows | Actions | Empty state | Permission |
| --- | --- | --- | --- | --- |
| `/admin/webinars` | Tabs Upcoming, Live now, Ended, On-demand, Drafts, Cancelled, Archived. Columns: title (staff locale), mode, starts (Brussels time), status badge, registrations, live attendees, replay viewers | New webinar | "No webinars yet. Create your first webinar." (the old tool's history is on each person's timeline through ops imports) | `webinars.host` |
| `/admin/webinars/new` | Mode picker, slug, title and description (`LocalizedInput`), locales, spoken language, start, planned duration, owner | Save draft | n/a | `webinars.host` |
| `/admin/webinars/[id]` | Details form with completeness badges; broadcast panel (YouTube video id, lifecycle, `broadcast_error` in red, "creating YouTube broadcast" spinner while `publish_requested_at` is set); Meet link; replay settings (enabled, gated, until, view limit, on-demand days); thresholds (attended minutes, conversion window); presenters list; series occurrences | Save, Publish (lists missing locales on failure), Cancel (reason, notify), Archive, Duplicate to dates, Use different YouTube video | n/a | `webinars.host` |
| `/admin/webinars/[id]/interactive` | Polls and CTAs with key, texts, timing (`mm:ss`), tag rules, answer counts per mode | Add, edit, deactivate, reorder | "No polls or CTAs. Add one to engage viewers." | `webinars.host` |
| `/admin/webinars/[id]/registrations` | Registrants: name, email, status snapshot, registered mode, source, live/replay/on-demand watch minutes, thresholds, last activity | Register a person, Cancel, Resend link, Revoke link, Mute, Block, Export CSV (`persons.export`) | "Nobody registered yet. Share the landing page: <url>." | `webinars.host` + `persons.read` |
| `/admin/webinars/[id]/host` | Host console. Left: Meet link (host link), YouTube Studio link, live status, viewer count (registrations with a segment in the last 30 s), elapsed time. Middle: polls and CTAs with Launch/Close/Show/Hide and live results. Right: chat stream and questions queue | Launch poll, Show CTA, Hide message, Mark answered, Mute viewer, Block viewer, Force live, Force ended; red pre-flight banner when the stream is not connected 15 minutes before start (rule 42) | "Waiting for the stream. Start streaming from Meet: Activities > Live streaming." | `webinars.host` |
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
| `/[locale]/webinars/[slug]` | Landing page: title, description, date in Brussels time, spoken language ("This webinar is in Dutch"), presenters' display names, registration form (email, first name, last name, unticked consent boxes for `events` and `newsletter` with versioned wording) | Register -> confirmation "Check your inbox". The route also accepts a webinar id and answers 308 to the slug URL (a fallback for hand-made links; forms' CTA kind `webinar` resolves the slug itself from `webinars.id, slug, status`, section 2.3) | not in this locale -> "not available in your language" with a locale switch; cancelled -> notice; ended without replay -> "This webinar has ended" |
| `/[locale]/webinars/[slug]/join` | Lost-link page: enter email; if a registration exists the access email is resent (same 202 answer either way) | Send my link | rate limited as registration |
| `/[locale]/w/[token]` | Token player: same `WebinarPlayer`; header shows the person's first name and "not you?" (link to the landing page) | as portal player | invalid or revoked token -> "This link is no longer valid" with the join page link |

`WebinarPlayer` (`apps/web/modules/webinar/ui/webinar-player.tsx`, client component): first shows a click-to-load notice (Google/YouTube processes connection data; wording version `player_notice_v1`), then loads the IFrame Player API script (`https://www.youtube.com/iframe_api`) through `next/script` (`strategy="afterInteractive"`, mounted only after the click) with the request nonce read from the `x-nonce` header set by `proxy.ts`, so platform's CSP (`'nonce-<n>' 'strict-dynamic'`, PL-67) admits it and the player scripts it loads without host lists; the player iframe uses `host: 'https://www.youtube-nocookie.com'` (allowed by PL-67's `frame-src`) with `rel=0`, `modestbranding=1`, `playsinline=1`, `controls` off for live and simulive. It calls `/api/webinar/view`, sends heartbeats every 15 s via `navigator.sendBeacon` on page hide, polls `/api/webinar/state` every 5 s in live (every 30 s otherwise), renders the poll card, CTA button, chat and question box, and on player error shows the unlisted `youtube.com/watch?v=` link with a note that it leaves BEAM. CTA buttons are plain links to the signed click URL of rule 36. The token pages send `Referrer-Policy: no-referrer` so the access token never reaches YouTube or a CTA target in a `Referer` header. Accessibility follows rule 44 (captions toggle, `aria-live` announcements, keyboard operation); every screen in this section meets WCAG 2.1 AA and the e2e specs drive the poll and CTA by keyboard.

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

Browser side: the YouTube IFrame Player API is loaded by the viewer's browser only after the click-to-load notice; the server never calls YouTube in a request. The CSP is platform's `buildCsp()` in `proxy.ts` (PL-67), not `next.config.ts`: its `frame-src` already lists `https://www.youtube-nocookie.com https://www.youtube.com`, and `script-src` has no YouTube host because the IFrame API is loaded through `next/script` with the request nonce and `'strict-dynamic'` admits the scripts it loads. No CSP change is requested.

V1 stopgap integration: none in this module. WebinarGeek or Zoom exports reach BEAM as weekly CSV imports through ops (rules 1-7); there is no API client or webhook for the old tool, because it is retired at the R2 switch-over. Email delivery uses the email module (Resend) through `email.sendTransactional`; this module never calls Resend directly.

## 7. Permissions and audit

This module declares one permission in `permissions.ts`: `webinars.host` (already in the architecture list). It reuses `persons.read`, `persons.export` and `reports.read`. Default holders follow the architecture role table: owner, technical_admin, management and marketing have `webinars.host`; customer_service, sales and reception do not.

| Capability | Permission |
| --- | --- |
| See `/admin/webinars`, create, edit, publish, cancel, archive, duplicate, set videos | `webinars.host` |
| Polls, CTAs, presenters | `webinars.host` |
| Host console, launch polls and CTAs, moderate chat, block viewers, force live state | `webinars.host` |
| Registrant list, register a person, revoke a link | `webinars.host` + `persons.read` (second check with `ctx.require('persons.read')`) |
| Resend a person's access link (person page card or registrant list) | `persons.read` (every staff role but external_partner; the email only goes to the registrant's own address) |
| Mute or unmute a viewer | `webinars.host` |
| Registrant CSV export | `webinars.host` + `persons.export` |
| Webinar report (aggregate, no PII) | `webinars.host` or `reports.read` (sales and customer_service see reports) |
| Customer: register, cancel own registration, watch own webinars | customer session (own `personId` only) or a valid access token |
| external_partner | nothing in this module |

Audited actions (`audit_log`, `entity_type` in parentheses): `webinar.created`, `webinar.updated` (old and new values of changed columns), `webinar.published`, `webinar.cancelled`, `webinar.archived`, `webinar.duplicated`, `webinar.video_set`, `webinar.live_forced` (`webinar`); `webinar.poll_saved`, `webinar.poll_deleted`, `webinar.cta_saved`, `webinar.cta_deleted`, `webinar.presenter_saved`, `webinar.presenter_removed`; `webinar.moderated` (`webinar_registration`, with the action); `webinar.registration_added_by_staff`, `webinar.registration_cancelled_by_staff`, `webinar.access_link_resent`, `webinar.access_link_revoked`; `webinar.registrants_exported` (`webinar`, with the row count). Launching and closing polls or CTAs in the host console are not audited (they are visible in the data through `live_*` columns). Customer actions are not audited; they are timeline events.

`permissions.test.ts` asserts every staff action refuses without its permission, `registerPersonByStaff` refuses without `persons.read`, `exportWebinarRegistrants` refuses without `persons.export`, `resendAccessLink` works for a `customer_service` user (who has `persons.read` but not `webinars.host`), and the report query refuses a user with neither `webinars.host` nor `reports.read`.

## 8. Multi-language and content

- Catalogue namespace `webinar` in `packages/core/src/i18n/messages/{en,nl-BE,fr-BE}/webinar.json`; `en` is the source; `pnpm i18n:check` enforces parity. Key groups: `webinar.admin.list.*`, `webinar.admin.form.*`, `webinar.admin.interactive.*`, `webinar.admin.registrations.*`, `webinar.admin.host.*`, `webinar.admin.report.*`, `webinar.portal.list.*`, `webinar.player.*` (countdown, notice, poll, cta, chat, question, errors `not_started|expired|limit_reached|blocked|cancelled|mode_changed|muted`, captions toggle), `webinar.public.landing.*`, `webinar.public.join.*`, `webinar.public.token.*`, `webinar.register.*` (form labels, consent wording per version, errors `closed|rate_limited`), `webinar.errors.*`, `webinar.enum.mode.*`, `webinar.enum.status.*`, `webinar.enum.threshold.*`.
- `LocalizedText` fields: `webinars.title`, `webinars.description`, `webinar_polls.question`, `webinar_polls.options[].label`, `webinar_ctas.label`. Edited with `LocalizedInput` limited to `webinars.locales`.
- Not localised by design: presenter `display_name`, chat and question text (shown as written), the video itself (one `spoken_locale`, shown on the landing page and in the portal list).
- Publish-time check (rule 9): `assertComplete(text, webinar.locales)` for every field above on active polls and CTAs; adding a poll or CTA to a published webinar runs the same check on save. The publish error lists `{field, missing: Locale[]}`.
- A visitor on a locale outside `webinars.locales` sees the "not available in your language" page with a locale switch; the registration's `locale` drives every email for it.
- Transactional react-email templates in `packages/email/src/templates/webinar/` (the architecture gives `templates/<m>/` to module `<m>`; this module writes these files). `index.ts` exports `templates = [defineTemplate({ name, component, props, slots, attachments?, loadProps? }), ...]` (email rule 15a), collected by `pnpm gen:indexes` into `TEMPLATE_REGISTRY` with the dotted keys of email decision 1, which are also the `email_templates.slug` of the system rows email's seed creates: `access.tsx` name `access`, key `webinar.access` (the registration confirmation: personal link, date in Brussels time, spoken language, "Add to calendar" link to `/api/public/webinars/[slug]/ics`; `attachments(props, locale)` adds the same `.ics` as a file); `reminder.tsx` key `webinar.reminder` (props `variant: 'd7' | 'd3' | 'h3'`; declares `loadProps(tx, { personId, locale, context, stepKey })` that reads the registration from `context.registration_id` and takes the variant from `stepKey`, so automation can send it); `rescheduled.tsx` key `webinar.rescheduled`; `cancelled.tsx` key `webinar.cancelled`; `replay-available.tsx` key `webinar.replay_available` (declares `loadProps`, builds the access link and `replay_until_at`). Files stay kebab-case, names snake_case. `slots` default to the catalogue keys `webinar.email.<name>.<slot>` (`webinar.email.access.subject`, ...), so a missing key fails `i18n:check` before deploy; at send time a missing locale is `blocked_translation`, never another language. Direct sends pass ids in `context` (`webinar_id`, `registration_id`) and the rendered values in `data`; nothing uses a `variables` field.
- Seeded marketing template: `packages/db/src/seed/webinar.ts` calls `email.seedTemplate(tx, { slug: 'webinar-follow-up', name: 'Webinar follow-up', kind: 'marketing', purpose: 'events', subject, preheader, document })` with a block document of text and button blocks using the merge fields `{{webinar.title}}`, `{{webinar.starts_at_local}}` and `{{webinar.access_url}}` (resolved from the enrolment's subject `registration_id`). It holds no `webinar` block: that block (email-P8, `{ webinarId, ctaLabel }`) names one fixed webinar and is for staff-built invitation campaigns, which call `getWebinarCards`; all three locales complete; `seedTemplate` never touches an existing slug, so BEAM's edits survive a re-seed. Marketing slugs are hyphenated `webinar-<name>`; no transactional row is seeded by this module (email decision 50: automation names the system rows `webinar.reminder` and `webinar.replay_available`).
- Dates use `Intl.DateTimeFormat(locale, {timeZone: 'Europe/Brussels'})`; the `.ics` file carries UTC times and `TZID=Europe/Brussels`.
- Captions: the player offers YouTube's captions in the spoken language (automatic captions for `nl`, `fr` and `en`); staff can upload a corrected caption file in YouTube Studio. BEAM does not generate or translate captions (Later).

## 9. Privacy

### 9.1 `privacy.ts` registration

```ts
export const webinarPrivacy = {
  tables: ['webinar_registrations', 'watch_segments', 'webinar_interactions', 'webinar_moderation_actions', 'webinar_presenters'],
  export: (tx, personId) => Promise<Record<string, unknown[]>>,
  erase: (tx, personId) => Promise<Array<{ table: string; rows: number; action: 'deleted' | 'anonymised' | 'retained_legal' }>>,
};
```

`NO_PII_TABLES` additions: `webinars`, `webinar_polls`, `webinar_ctas` (no column references `persons.id`; `owner_user_id` and `created_by_user_id` are staff). `export` and `erase` take every id from `crm.resolvePersonIds(tx, personId)`, so the rows of persons merged into the subject are included.

| Table | Person data | Export includes | Erase does | Why |
| --- | --- | --- | --- | --- |
| `webinar_registrations` | person_id, utm, locale, status snapshot | one row per webinar: title (registration locale), mode, registered mode, status, source, registered and cancelled dates, utm | **deleted** | architecture: registrations are deleted on erasure; no legal retention applies |
| `watch_segments` | viewing behaviour | per webinar per mode: merged watch seconds and thresholds (from `v_webinar_watch`) plus the raw segments CSV | **deleted** (cascade from registration, under `SET LOCAL beam.allow_rewrite = 'on'`) | profiling data, no retention ground |
| `webinar_interactions` | poll answers, CTA clicks, chat and question text | every row with webinar title, mode, kind, poll question and chosen option labels, CTA label, text, time | **deleted** (cascade) | free text and behaviour; no retention ground |
| `webinar_moderation_actions` | refers to the person's registration | actions taken on the person's messages (without the staff name) | **deleted** (cascade) | |
| `webinar_presenters` | person_id of external presenters | presenter roles and display names | **deleted** | |

Erase runs before crm anonymises `persons` (dependency order in `GDPR_REGISTRY`: webinar before crm). Aggregate counts in past reports drop by the erased person; that is accepted. `activity_events` with kind `webinar.*` are erased by crm with the rest of the timeline. Tags applied from poll answers are `person_tags` rows erased by crm. Tasks created from questions carry only `ref_id` and the generic title "Webinar question from a viewer"; the question text is never copied into the task. YouTube receives no BEAM identity, so there is nothing to delete at Google; the report states "Google/YouTube: no personal data sent by BEAM".

### 9.2 Retention

ops seeds and owns every `retention_policies` row; this module seeds none. ops already has `watch_segments` (730 days) and `webinar_interactions` (730 days). This module asks ops for one more row, `webinar_registrations` (1095 days from `created_at`, delete; the marketing-profile and form-submission period), and registers sweep handlers in `privacy.ts` keyed by policy key:

```ts
sweep: {
  watch_segments: (tx, cutoff: Date) => Promise<{ rows: number }>,          // delete where recorded_at < cutoff
  webinar_interactions: (tx, cutoff: Date) => Promise<{ rows: number }>,    // delete where occurred_at < cutoff
  webinar_registrations: (tx, cutoff: Date) => Promise<{ rows: number }>,   // delete where created_at < cutoff and the webinar ended or was archived before cutoff; cascades
}
```

Each handler runs in its own transaction under `SET LOCAL beam.allow_rewrite = 'on'` (the cascades reach APPEND tables), deletes at most 5,000 rows per call and returns the count; ops' sweep calls it again until it returns 0. `v_webinar_watch` totals for old webinars shrink after two years; that is accepted and the report shows "detail removed after 2 years" when a webinar's segments are gone.

### 9.3 Google as subprocessor (blueprint 18 "GDPR/subprocessor implications", 58, 66)

- **Roles.** Google Ireland Ltd provides YouTube (video delivery) and Google Workspace (Meet). For Meet, Google is BEAM's processor under the Workspace Data Processing Amendment. For the embedded YouTube player, Google acts as an independent controller for the connection data it collects under the YouTube terms; BEAM is controller for everything stored in BEAM.
- **Data Google receives.** Viewers: IP address, user agent, player interaction and device identifiers set by the embed (localStorage), the unlisted video id. No name, email, BEAM id, poll answer or chat text is ever sent: chat, polls, CTAs and watch time are native, and video titles and descriptions contain no personal data. Presenters and staff: name, email and video/audio in Meet.
- **Location and transfer.** EU and US. Transfer mechanism: EU-US Data Privacy Framework (Google LLC is certified) with Standard Contractual Clauses as fallback. Entry in the subprocessor register: "Google (YouTube Live / Meet) - webinar video - EU/US - viewer connection data while watching; presenter account data".
- **Measures.** Privacy-enhanced embed domain `youtube-nocookie.com`; the player loads only after a click-to-load notice (wording `player_notice_v1`, its version stored on the `started` interaction); videos are unlisted; YouTube live chat is not used; the fallback `youtube.com` link says it leaves BEAM.
- **DPIA.** Automations that act on watch thresholds are watch-time profiling (blueprint 66). The behaviour journeys that act on watch thresholds, attendance or CTA clicks (section 4.8) stay draft until ops' `dpia_records` holds an approved `watch_time_profiling` entry (`ops.isDpiaApproved`); automation's activation checks it. The reminder journey and the no-show replay email (service messages about a registration, no profiling) are active from R2. The same gate keeps watch-time fields out of segments (ops).
- **V1 stopgap.** Until R2 the current tool (WebinarGeek or Zoom) stays a subprocessor holding registrant name, email and attendance; the ops import copies only email, name, locale, registration time, attendance, mode and watched minutes. Answers to the blueprint 18 questions for the interim: platform that remains = WebinarGeek (or Zoom); integration = weekly CSV export imported through ops; data synchronised = registrants and attendees with the fields above, one way into BEAM; GDPR = the old tool stays in the subprocessor register until its account is closed. At switch-over BEAM exports the remaining history once, imports it, stops creating webinars in the old tool, and closes the account after 30 days (runbook `docs/runbooks/webinar-switch-over.md`, written by webinar-P6).
- The document `docs/privacy/webinar-google.md` (written by webinar-P4) holds this text for the DPA annex and the privacy notice.

## 10. Dependencies

### 10.1 Needs from other modules

| Module | Capability (api.ts function or table) | Used for |
| --- | --- | --- |
| platform | `action()`, `defineJob`, `defineSchedule`, `defineEvent`, `recordEvent`, `audit`, `enqueue`, `runJobs`, `flag('ff_webinar_portal')`, `requirePermission()`; tables `files`, `users`, `integration_calls`; job `notify.slack` | everything |
| platform | everything already in platform's own packages, so this module files no frozen-file request: the CSP of PL-67 (YouTube in `frame-src`, nonce plus `'strict-dynamic'` for the `next/script` IFrame API); the PL-68 buckets `webinar_heartbeat` (8 per registration per minute) and `webinar_state` (30 per registration per minute) with both routes exempt from the per-IP rule in the app and in the Vercel WAF (`security-controls.md`, platform-P8); env vars `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REFRESH_TOKEN` in `.env.example` (platform-P1); `webinar_moderation_actions` in Wave 0's `APPEND_ONLY_TABLES`; provider `youtube` in the `integration_calls` enum; the `gen:indexes` collectors for `templates/webinar/index.ts` and `modules/webinar/merge-fields.ts` (platform-P1); R4: `ai.webinar_performance_daily` over `v_webinar_performance_daily` and `webinars_attended_live`, `watch_sec_total` in `AI_ALLOWED_FIELDS` (platform-P10) | security headers, rate limits, YouTube credentials, registries, R4 AI access |
| crm | `findOrCreatePersonByEmail(tx, ctx, {email, firstName?, lastName?, locale, acquisition?})`, `getPersonStatus(tx, personId)` (its `.status`), `resolvePersonIds(tx, personId)`, `recordConsent(tx, ctx, {personId, purpose, status, method, source, wordingVersion, ip?, ref?})`, `applyTag(tx, ctx, personId, tagKey, 'automation')`, `createTask(tx, ctx, {title, kind, ownerUserId, personId, dueAt, source, ref, dedupeKey})` (crm's published signatures); reads `persons` names, `tags.key`, `activity_events` | persons, consent, tags, tasks, timeline |
| crm | crm's merge must call `webinar.mergePersons(tx, winnerId, loserId)` before its generic FK repointing and must skip `webinar_registrations` in that repointing: deleting the loser's registration generically would cascade into append-only `watch_segments` and `webinar_interactions` (edge case 19) | person merge |
| booking | `upsertWebinarSession(tx, ctx, { webinarId, title, startsAt, endsAt }): Promise<{ sessionId; created }>` (booking R64: creates or updates the one `sessions` row keyed by `webinar_id`, kind `event`, `event_category = webinar`, `capacity_seats = 0`, refused by every booking action; this module never passes the optional `sessionId`) and `cancelWebinarSession(tx, ctx, { webinarId, reason }): Promise<{ sessionId: string \| null }>` (idempotent, keyed by `webinarId`); reads `sessions`, `bookings` | event calendar link, conversion |
| commerce | reads `orders` (`person_id`, `status`, `paid_at`, `total_cents`) | purchase conversion |
| email | `sendTransactional(ctx, { template, personId, locale, data, context, key }): Promise<{ emailMessageId; jobId }>` (email decision 6) with the five dotted keys of section 8 in `TEMPLATE_REGISTRY`; `defineTemplate()` with `loadProps` and `attachments`; `seedTemplate(tx, input)` for the marketing row `webinar-follow-up`; the `webinar` block (email-P8) calling `getWebinarCards`; the renderer resolves `{{webinar.*}}` through `modules/webinar/merge-fields.ts` (`MERGE_FIELDS`, platform's collector) | access, reminders, follow-ups, invitations |
| automation | evaluates this module's event kinds with `where` on `data.*` and `mode`; seeds (in its own `seeds/webinar.ts`), activates and tests the journeys of section 4.8 with the slugs, groups and priorities listed there, including `webinar-cta-sales-task` in the non-exclusive `sales` group; names the transactional system rows `webinar.reminder` and `webinar.replay_available` and the marketing row `webinar-follow-up` | reminders, follow-ups, poll and CTA triggers |
| ops | V1 import source `webinar_tool` with the presets and behaviour of rules 1-7; `imported_history` (read); the `webinar_registrations` retention row (section 9.2); privacy runner calls `privacy.ts` (`ERASE_ORDER` has `webinar` first); `isDpiaApproved('watch_time_profiling')`; R3 `ad_spend_daily` | V1 stopgap, retention, erasure, DPIA gate, cost per registration |
| forms | reads `webinars.id`, `slug`, `status` (the read contract of section 2.3) to validate its CTA kind `webinar` and link to `/[locale]/webinars/<slug>` | assessment result pages recommending a webinar (blueprint 17) |
| site | links to `/[locale]/webinars`, uses `listPublicWebinars()` on event pages, renders `WebinarSignup` in its `webinar_signup` block and `listUpcomingRegistrationsForPerson()` on the account home | public discovery |

### 10.2 Provides to other modules

| To | What |
| --- | --- |
| crm | timeline events `webinar.*` with `mode`; `listPersonWebinars()` for the person page card; `mergePersons()` |
| automation | triggers for blueprint 21: registered/no attendance (`webinar.no_show`), attended (`webinar.attended` mode `live`), 15 minutes, 30 minutes, 50 %, watched to end (`webinar.watched` with `data.threshold`), replay viewed (`webinar.attended` mode `replay`), on-demand viewed (mode `on_demand`), poll answer (`webinar.poll_answered` with `data.poll_key`, `option_keys`, `option_key`), CTA click (`webinar.cta_clicked` with `data.cta_key`); exit events `webinar.cancelled`, `webinar.registration_cancelled`, `webinar.rescheduled`. These names replace the per-threshold kinds (`webinar.watched_15m`, `webinar.replay_viewed`, ...) of an earlier automation draft (automation's spec now uses these names); one kind with `data.threshold` keeps the catalogue small and matches crm's `webinar.watched` |
| ops | `v_person_webinar_stats` for `v_person_profile` and `SEGMENT_ALLOWED_FIELDS` (webinar registration, attendance, watch time, poll and CTA counts); `getWebinarKpis()` (R3 marketing dashboard: registrations, attendance rate, webinar conversion); action-dashboard card "webinar leads have not booked" (`countWebinarLeadsWithoutBooking()` and its rows `listWebinarLeadsWithoutBooking()`, section 4.7); `listUpcomingWebinarHealth()` for the daily digest; sweep handlers of section 9.2; R4 `getWebinarWeeklyFacts()` and `v_webinar_performance_daily` |
| booking, site | `getWebinarForSession()` so an event session linked to a webinar shows "Register for the webinar" instead of a booking button |
| email | merge fields `webinar.access_url`, `webinar.title`, `webinar.starts_at_local` (`mergeFields` in `merge-fields.ts`); `getWebinarCards(tx, ids, locale)` for the `webinar` block; the five registry templates `webinar.access`, `webinar.reminder`, `webinar.rescheduled`, `webinar.cancelled`, `webinar.replay_available` and the seeded marketing row `webinar-follow-up` |
| site | `WebinarSignup`, `listUpcomingRegistrationsForPerson()`, `listPublicWebinars()` |
| forms | read access to `webinars.id`, `slug`, `status` (linkable while `published`, `live` or `ended`) and the `/[locale]/webinars/[slug]` route (plus its id-to-slug 308 fallback) |

## 11. Edge cases and failure modes

| # | Case | Decided behaviour |
| --- | --- | --- |
| 1 | A viewer joins a live webinar 20 minutes late | Position comes from the server clock; their segments start at about 1,200 s. Thresholds count only what they watched; `50pct` and `end` can still be reached if they stay. |
| 2 | Two tabs or two devices of the same registration play at once | Both write segments; merged intervals count each second once per mode. Each tab is its own view, so the 10 s spacing applies per tab; two tabs at 15 s each send 8 heartbeats a minute, exactly the registration bucket of rule 25. A third tab exceeds it: its heartbeats get `429`, it keeps playing and retries, and nothing is double counted. The registration row lock serialises the writes. |
| 3 | A client sends inflated replay positions (seeks to the end, fakes `toSec`) | Spans are capped by elapsed wall time since the previous heartbeat of the view plus 5 s and by 30 s; seeking to the end and watching the last minute does reach `end` (accepted: it is what "watched to the end" can mean in a replay) but not `50pct`. |
| 4 | Network loss for several minutes | No segments for the gap; the next heartbeat's span is capped, so the gap is not back-filled. Lost telemetry never affects the registration. |
| 5 | The live webinar ends while someone watches | `sync_status` sets `ended`; the next heartbeat with mode `live` gets `409 mode_changed`; the player reloads in `replay` if allowed, otherwise shows "This webinar has ended". Live segments stay `live`. |
| 6 | YouTube broadcast creation fails (quota, revoked token, 403) | `PermanentError`, `broadcast_error` shown on the webinar page, status stays `draft`, dead job alert in Slack. Staff fix the cause and click Publish again (a new job key suffix `:retry:<n>` is used by the action). |
| 7 | Meet's built-in YouTube streaming creates its own broadcast instead of using BEAM's | The host uses "Use different YouTube video" (`setWebinarVideo`) before or during the live; the player picks up the new id on its next `/api/webinar/state` call (`videoId` changed -> reload). Fallback path: stream with any RTMP encoder to BEAM's broadcast from YouTube Studio. |
| 8 | Nobody starts the stream | Viewers see "Waiting for the host" after `starts_at`. At `starts_at + 2 h` finalise writes no `webinar.no_show`, sets `broadcast_error = 'never_live'` and creates a task for the owner; staff then cancel (emails registrants) or reschedule. |
| 9 | Webinar rescheduled after people registered | Only a `starts_at` change of more than 5 minutes counts. Registrations stay. Per registrant, in the update transaction: event `webinar.rescheduled` (which is in `exit_on` of `webinar-registration`, so the old reminder enrolment exits), then a fresh `webinar.registered` with `data.rescheduled = true`, the new `data.starts_at` and dedupe key `webinar_reg:<registration_id>:registered:v<version>`; `webinar-registration` has `re_entry: "after_days:0"`, so it re-enrols with reminders anchored on the new time and late-entry skips applied. One `webinar.rescheduled` email per registrant per version (sent by `webinar.notify_registrants` in chunks of 200, after commit). Reports count registrations, not events, so nothing doubles. |
| 10 | The same person registers twice (site, then portal) | Same registration (unique index); a second access email at most 3 times an hour; no second `webinar.registered` event (dedupe `webinar_reg:<registration_id>:registered:v<version>`). |
| 11 | Two different people share one access link | The link works for whoever has it; activity is attributed to the registrant. The landing header shows the registrant's first name with "not you?" leading to registration. Staff can revoke the link (`token_version + 1`). |
| 12 | Replay view limit reached in one tab while another tab is open | The open tab keeps playing; the limit applies at `startView`. A reload after 30 minutes of inactivity counts as a new view and is refused at the limit. |
| 13 | Replay expires during playback | Next heartbeat returns `stop: 'expired'`, player shows the expiry message; segments up to then remain. |
| 14 | A poll answered twice in the same mode (double click, two tabs) | The partial unique index rejects the second insert; the API returns `409 already_answered` and the UI shows the first answer. Tags and events are written once. |
| 15 | A poll is edited after answers exist | Options and question cannot change (`conflict`); staff deactivate it and create a new poll with a new key. Reports keep the old poll's answers. |
| 16 | A tag rule names a tag that is later deleted | The answer transaction reads `tags.key` for the rule's tags first and skips unknown keys before calling `crm.applyTag`, so nothing aborts the answer; the skip is logged to Sentry with the poll id, and the poll edit screen flags the broken rule. |
| 17 | Chat spam or abuse | 3 s and 60/h limits; hosts hide messages or block the viewer; a blocked viewer's registration is `blocked`, their player stops, their old messages remain hidden only if hidden explicitly (block also hides all their chat messages with one `hide_message` row each). |
| 18 | Person erased between registering and the webinar | Registration and its rows deleted; the access link no longer resolves ("This link is no longer valid"); reminder enrolments are deleted by automation's erase; YouTube holds nothing to delete. |
| 19 | Two persons merged who both registered for the same webinar | `mergePersons` keeps the earlier registration, moves the loser's segments and interactions to it (append-only bypass inside the merge transaction under `SET LOCAL beam.allow_rewrite = 'on'`), deletes the loser registration, and returns `collapsed = 1`. Poll answers in the same mode keep the earliest answer. |
| 20 | A lead registers, then buys a package before the webinar | `person_status` stays `lead` on the registration (snapshot), so the purchase counts as a lead conversion only if it falls after `anchor_at`; buying before the webinar is not a webinar conversion. |
| 21 | Daylight-saving change between scheduling and the webinar | Times are stored in UTC; the landing page and emails format in `Europe/Brussels`; reminders are anchored on the UTC instant. |
| 22 | The recording is not processed 48 h after the end | `fetch_recording` stops; the webinar page shows "Recording not available yet" with "Use different YouTube video"; replay stays unavailable. `webinar.finalise` runs at the 48-hour mark and writes `webinar.no_show` with `replay_available = false`, so the no-show journey (which filters on `replay_available = true`) does not enrol. A recording set later makes the replay available, but no second no-show event is written. |
| 23 | A host mutes a viewer during the live | `muted_at` is set; the viewer keeps watching and answering polls; their next chat or question returns `403 muted` and the composer says so; their earlier messages stay visible unless hidden. Unmute clears it at once. |
| 24 | The stream is not connected 15 minutes before a live webinar | The pre-flight check (rule 42) posts one Slack line and shows the red banner in the host console; nothing is sent to registrants; if the stream starts late, `live_started_at` is YouTube's `actualStartTime` and positions count from there. |
| 25 | Two staff members edit the same webinar | `updateWebinar` checks `version`; the second save gets `conflict` with "changed by someone else, reload". |
| 26 | A tampered or replayed CTA click URL | A bad signature redirects to the CTA URL without recording; a valid URL clicked twice records one `webinar.cta_clicked` (first per registration, CTA and mode) and two `cta_clicked` interactions are allowed (every click is an interaction row). |
| 27 | Heartbeat for a webinar with `ff_webinar_portal` switched off mid-webinar | Viewer endpoints check only the registration and webinar state, not the flag, so a running webinar continues; the flag hides only discovery pages and the portal menu. |

## 12. Build packages

Order and sequencing: nothing ships in V1 (the stopgap is ops' import, rules 1-7). `webinar-P1` to `webinar-P6` are Release 2 and are **strictly sequential in that order**: they all edit the module barrel files (`actions.ts`, `queries.ts`, `jobs.ts`, `events.ts`, `api.ts`, `privacy.ts`, `nav.ts`, the three `webinar.json` catalogues), each one starting from the merged result of the previous one. `webinar-P7` (R3) and `webinar-P8` (R4) follow `webinar-P6`. `packages/db/src/schema/webinar.ts` is edited only by `webinar-P1` (it replaces the Wave 0 stub); `webinar.views.ts` by `webinar-P1` and `webinar-P8`, sequentially. Packages of other modules that this module waits for are named as `<module>:<capability>`; none of them waits for a webinar package except automation-P8, email-P8, site-P8 and forms-P8, which depend on `webinar:events`, `webinar:getWebinarCards`, `webinar:WebinarSignup` and `webinar:webinars`, so the graph stays acyclic. No package edits `package.json`, the lockfile, migrations, `registry/*.generated.ts`, `packages/db/src/schema/index.ts` or frozen files, and none files a frozen-file request: the CSP, WAF exemption, rate-limit buckets, env vars, append-only list, `youtube` provider, registry collectors and the R4 `ai` view grants are all in platform's own packages (section 10.1). Every package's done-definition includes: `pnpm typecheck` and `pnpm lint` clean, `pnpm i18n:check` clean, its Vitest suites green using `createTestDb()` and the YouTube `fake.ts`, and the module `jobs.test.ts`, `permissions.test.ts` and `privacy.test.ts` green.

### webinar-P1: Native schema, views and core logic (R2, about 90 min)

- **Goal.** Every R2 table, enum, index, check and view of section 2, and the pure rules for modes, watch time, tokens and polls.
- **Creates or edits.** `packages/db/src/schema/webinar.ts` (replaces the Wave 0 stub: R2 enums and tables, the registration and webinar state checks of section 2.3, no edit of the frozen `_shared.ts`: `watch_segments`, `webinar_interactions` and `webinar_moderation_actions` are already in Wave 0's `APPEND_ONLY_TABLES`, and the orchestrator's post-wave `select beam_protect_append_only();` migration adds their triggers); `packages/db/src/schema/webinar.views.ts` (`v_webinar_watch`, `v_webinar_registration_facts`, `v_webinar_conversions`, `v_person_webinar_stats`); `packages/db/src/schema/webinar.test.ts`; `packages/core/src/webinar/{types,watch,access,token,polls,schemas}.ts` and `{watch,access,token,polls}.test.ts`; edit `packages/core/src/webinar/index.ts`; `apps/web/modules/webinar/test/factories.ts` (`makeWebinar`, `makeRegistration`, `makeSegments`).
- **Interfaces.** `mergeIntervals(segs: Array<{ fromSec: number; toSec: number }>): { watchedSec: number; maxPositionSec: number }`; `factsReached(input: { watchedSec; maxPositionSec; durationSec; attendedMinSec }): Array<'attended' | '15m' | '30m' | '50pct' | 'end'>`; `clampSegment(input: { mode; clientFrom; clientTo; now; liveStartedAt?; lastHeartbeatAt?; durationSec }): { fromSec; toSec } | null`; `resolveMode(w: WebinarState, now: Date): { mode: WatchMode } | { blocked: 'not_started' | 'ended_no_replay' | 'expired' }`; `registeredModeFor(w, now): WatchMode`; `canRegister(w, now): { ok: true } | { ok: false; code: 'closed' }`; `replayAccess(input: { w; registration; viewsInMode; now }): { ok: true } | { ok: false; code: 'expired' | 'limit_reached' }`; `signAccessToken(key: Uint8Array, registrationId: string, version: number): string`; `verifyAccessToken(key, token): { registrationId: string; version: number } | null`; `deriveAccessKey(authSecret: string): Uint8Array`; `validatePollAnswer(poll, optionKeys): Result`; `tagsForAnswer(poll, optionKeys, mode): string[]`; `visibleAt(items, positionSec)`; Zod inputs of section 4 in `schemas.ts`.
- **Depends on.** `platform:schema stubs` (Wave 0 `webinar.ts` stub and `_shared.ts` helpers), `booking:sessions` (FK target, Wave 0 contract table), `crm:persons`, `platform:users`, `platform:files`, `ops:imported_history` (read by `v_person_webinar_stats`; ops V1).
- **Tests.** `watch.test.ts`: overlap, touching, nested, two tabs, unsorted input; thresholds at 899/900, 1799/1800, half of odd durations, end at `duration - 60`. `access.test.ts`: live window, simulive window and position, replay gated before and after end, expiry, view limit, on-demand access days. `token.test.ts`: round trip, tampered MAC, old version, constant-time compare used. `polls.test.ts`: single vs multiple, unknown key, tag rules by mode. `webinar.test.ts` (PGlite): every check constraint rejects a bad row (including `blocked` without `blocked_at`); an UPDATE or DELETE on `watch_segments`, `webinar_interactions` and `webinar_moderation_actions` is rejected unless `beam.allow_rewrite = 'on'`; partial uniques for poll answer per mode and CTA shown; a live and a replay answer of the same poll coexist; `v_webinar_watch` seconds equal `mergeIntervals` on 200 random segment sets; `v_webinar_conversions` picks the first booking after the anchor only; `v_person_webinar_stats` counts imported history rows.
- **Done.** Common done-definition; core coverage above 90 % for `webinar/watch.ts` and `webinar/access.ts`.

### webinar-P2: YouTube and Meet, webinar lifecycle and admin editing (R2, about 120 min)

- **Goal.** Staff create, edit, publish, reschedule, cancel, archive and duplicate webinars; broadcasts and Meet spaces are created by jobs; live status and recordings sync (rules 8-13, 34 storage side, section 6).
- **Creates or edits.** `packages/integrations/src/youtube/{types,client,fake}.ts` and `client.test.ts` (extend the Wave 0 fake); `apps/web/modules/webinar/server/lifecycle.ts`; edit `actions.ts`, `queries.ts`, `jobs.ts`, `events.ts`, `nav.ts`, `schedules.ts`; `apps/web/app/(admin)/admin/webinars/page.tsx` (replaces the Wave 0 stub: native list with tabs), `.../webinars/new/page.tsx`, `.../webinars/[id]/page.tsx`, `.../webinars/[id]/interactive/page.tsx`, `apps/web/modules/webinar/ui/admin/{webinar-form,poll-editor,cta-editor,presenter-list,broadcast-panel}.tsx`; `packages/email/src/templates/webinar/{rescheduled,cancelled}.tsx` and `packages/email/src/templates/webinar/index.ts` (`defineTemplate` entries, keys `webinar.rescheduled`, `webinar.cancelled`); catalogue keys `webinar.admin.*`, `webinar.email.rescheduled.*`, `webinar.email.cancelled.*`.
- **Interfaces.** `YouTubeClient` with `findBroadcastByMarker`, `createBroadcast`, `updateBroadcast`, `deleteBroadcast`, `getBroadcast`, `getVideo`, `createMeetSpace` (section 6) and `FakeYouTube` with `setLifecycle`, `markProcessed`, `failNext`; actions `createWebinar`, `updateWebinar`, `publishWebinar`, `cancelWebinar`, `archiveWebinar`, `duplicateWebinar`, `setWebinarVideo`, `upsertPoll`, `deletePoll`, `upsertCta`, `deleteCta`, `upsertPresenter`, `removePresenter`, `forceLiveState`; jobs `webinar.create_broadcast`, `update_broadcast`, `delete_broadcast`, `create_meet_space`, `sync_status`, `fetch_recording`, `notify_registrants`; schedules `webinar.scan_live`, `webinar.scan_recordings`.
- **Depends on.** webinar-P1; `booking:upsertWebinarSession`, `booking:cancelWebinarSession`; `email:sendTransactional`; `crm:findOrCreatePersonByEmail` (external presenters), `crm:tags` (read for tag rule validation); `platform:integration_calls` callback.
- **Tests.** `lifecycle.test.ts`: one case per arrow of the webinar state table (section 2.3) and a refusal for a move that is not in it (for example `ended -> live`, `cancelled -> published`); publish refuses missing locales with the list; simulive and on-demand publish refuse while `duration_sec` is unknown; a reschedule clears `finalised_at` and `broadcast_error` and the next finalise uses key `:v<version>`; live publish stays `draft` until the job succeeds; 403 from the fake sets `broadcast_error` and dead job; a lost response retried reuses the broadcast by marker; simulive goes `live` and `ended` by time only; reschedule by 3 min sends nothing, by 30 min emails each registrant once; simulive publish calls `booking.upsertWebinarSession` with `{webinarId, title, startsAt, endsAt}` and stores the returned `sessionId`; a live publish calls it only in the successful `create_broadcast` transaction (a 403 leaves no session); cancel calls `booking.cancelWebinarSession` with `{webinarId, reason}`; a booking `conflict` makes `create_broadcast` permanent; cancel writes events and enqueues delete; duplicate creates N drafts with copied polls; poll with answers cannot change options. `client.test.ts`: Zod validation of fake responses, error mapping retryable vs permanent. `jobs.test.ts` (edit: every new job twice). `permissions.test.ts` (edit).
- **Done.** Common done-definition.

### webinar-P3: Registration, access links, portal list and template seeds (R2, about 120 min)

- **Goal.** People register from the site, the portal or by staff; they get a personal link at once, and the events and templates the automation journeys of 4.8 need (rules 14-20).
- **Creates or edits.** `apps/web/modules/webinar/server/registration.ts`; edit `actions.ts`, `queries.ts`, `api.ts`, `events.ts`, `privacy.ts` (registrations export and erase), `nav.ts` (portal entry behind `ff_webinar_portal`); `apps/web/modules/webinar/merge-fields.ts`; `apps/web/modules/webinar/seed.ts`; `packages/db/src/seed/webinar.ts`; `apps/web/app/api/public/webinars/[slug]/register/route.ts`, `apps/web/app/api/public/webinars/[slug]/ics/route.ts`; `apps/web/app/[locale]/(site)/webinars/page.tsx`, `.../webinars/[slug]/page.tsx`, `.../webinars/[slug]/join/page.tsx`; `apps/web/app/[locale]/(portal)/account/webinars/page.tsx`; `apps/web/app/(admin)/admin/webinars/[id]/registrations/page.tsx`; `apps/web/modules/webinar/ui/{registration-form,webinar-card,registrations-table,webinar-signup}.tsx`; `packages/email/src/templates/webinar/{access,reminder,replay-available}.tsx` and edit `index.ts`; catalogue keys `webinar.public.*`, `webinar.register.*`, `webinar.portal.list.*`, `webinar.email.access.*`, `webinar.admin.registrations.*`.
- **Interfaces.** `registerPerson(tx: Tx, ctx: Ctx, input: { webinarId: string; personId: string; source: RegistrationSource; locale: Locale; utm: Utm; consents?: { events?: boolean; newsletter?: boolean }; wordingVersion?: string }): Promise<{ registrationId: string; created: boolean }>`; actions `registerForWebinar`, `cancelMyRegistration`, `registerPersonByStaff`, `cancelRegistrationByStaff`, `resendAccessLink`, `revokeAccessLink`; api `getWebinarForSession`, `listPublicWebinars`, `listPersonWebinars`, `listUpcomingRegistrationsForPerson`, `getWebinarCards`, `WebinarSignup`, `getAccessUrl`, `mergePersons`; merge fields `webinar.access_url`, `webinar.title`, `webinar.starts_at_local`.
- **Depends on.** webinar-P2; `crm:findOrCreatePersonByEmail`, `crm:getPersonStatus`, `crm:recordConsent`; `email:sendTransactional`, `email:defineTemplate` (with `loadProps` and `attachments`), `email:seedTemplate`, `email:system rows seeded from TEMPLATE_REGISTRY`; `platform:gen:indexes` template and merge-field collectors (Wave 0); `crm:resolvePersonIds`; `platform:flags` (the flag declared in `config.ts`).
- **Tests.** `registration.test.ts`: register creates person with acquisition `webinar`, snapshot status `lead`/`customer`/`member`, event with `session.kind = 'event'`, no consent unless ticked, ticked box writes one `consent_records` row with the wording version; two concurrent `registerPerson` calls (`Promise.all`) give one row and one event; second registration is the same row and a 4th access email in an hour is not sent; cancelled then re-registered; blocked stays blocked; one case per arrow of the registration state table; `webinar.registered` carries `starts_at` and `ends_at`; `resendAccessLink` by a `customer_service` user; closed webinar refused; gated replay refuses after the end; open replay registers with `registered_mode = 'replay'`; public route always answers 202. `merge.test.ts`: two registrations collapse into the earlier one with segments and interactions moved and duplicate poll answers in one mode reduced to the earliest. `seed.test.ts`: `templates/webinar/index.ts` declares exactly the names `access`, `reminder`, `rescheduled`, `cancelled`, `replay_available` (registry keys `webinar.<name>`), each renders in three locales with fake props, `reminder` and `replay_available` build props through `loadProps` from `context.registration_id` and `stepKey`, `access` attaches the `.ics`; the seed calls `email.seedTemplate` once, for `webinar-follow-up` (marketing, purpose `events`), and a second run leaves it unchanged; `merge-fields.ts` resolves `access_url`, `title` and `starts_at_local` from `context` and returns `null` without it; `getWebinarCards` leaves out draft, cancelled and archived ids; the id URL of a landing page answers 308 to the slug; the `.ics` route contains no personal link. The Friday-for-Sunday reminder test (scenario 1) belongs to automation's `seeded-journeys-r2.test.ts`, which uses this package's event shape. `privacy.test.ts` (edit). `apps/web/e2e/webinar-register.spec.ts`: register on `/nl/webinars/<slug>`, the sink mailbox has the access email, the link opens `/nl/w/<token>`.
- **Done.** Common done-definition plus the e2e spec.

### webinar-P4: Player, heartbeat, watch time and replay access (R2, about 120 min)

- **Goal.** Watching inside BEAM with server-side mode decisions, watch segments, started, attended, watched and no-show facts, and gated replays (rules 21-32, 44, 9.3).
- **Creates or edits.** `apps/web/modules/webinar/server/{viewer,watch}.ts`; `apps/web/app/api/webinar/view/route.ts`, `apps/web/app/api/webinar/heartbeat/route.ts`; `apps/web/modules/webinar/ui/webinar-player.tsx`, `apps/web/modules/webinar/ui/player-notice.tsx`; `apps/web/app/[locale]/(portal)/account/webinars/[id]/page.tsx`; `apps/web/app/[locale]/(site)/w/[token]/page.tsx`; edit `jobs.ts` (`webinar.finalise`), `schedules.ts` (`webinar.scan_finalise`), `events.ts`, `privacy.ts` (segments export); `docs/privacy/webinar-google.md`; `apps/web/scripts/load/webinar-heartbeat.ts` (a plain `fetch` load script, no new dependency); catalogue keys `webinar.player.*`, `webinar.public.token.*`.
- **Interfaces.** `resolveViewer(req: Request, webinarId: string): Promise<{ registration; webinar; via: 'token' | 'session' } | ViewerError>`; `startView(tx, viewer, now): Promise<ViewStart | ViewRefusal>`; `recordHeartbeat(tx, viewer, input: HeartbeatInput, now): Promise<HeartbeatResult>`; `finaliseWebinar(tx, ctx, webinarId, now): Promise<{ noShows: number; backfilled: number } | { deferred: 'replay_unknown' }>`.
- **Depends on.** webinar-P3; `platform:recordEvent` (dedupe keys), `crm:createTask` (never-live task), `platform:notify.slack`; `platform:PL-67 CSP` and `platform:PL-68 buckets webinar_heartbeat, webinar_state` (V1, already merged).
- **Tests.** `heartbeat.test.ts`: live positions from the server clock ignore client values; replay span capped by elapsed time and 30 s; paused writes nothing; two heartbeats of one view within 10 s -> 429; a ninth heartbeat of one registration in a minute -> 429; 24 `/api/webinar/state` polls of one registration in a minute pass and the 31st -> 429; neither route is counted against the per-IP bucket (31 registrations behind one IP all pass); two tabs heartbeating concurrently (`Promise.all`) write both segments and exactly one `15m` event (row lock); muted registration keeps writing segments; client mode `live` after the end -> 409; blocked registration -> 403; `webinar.started` once per mode; `attended` at 300 s; `15m` and `30m` once each; live and replay watch kept apart (live 20 min plus replay 20 min gives `30m` in neither). `replay-access.test.ts`: view counted once per 30 min, limit reached, expiry stop. `finalise.test.ts`: `webinar.no_show` only for live registrants without live attendance (a 4-minute live viewer is a no-show at the default 300 s); replay viewers still no-show for live; finalise defers while the recording is unknown and runs at 48 h with `replay_available = false`; `replay_available = true` once the fake marks the recording processed; never-live writes no no-show and creates a task; double run identical. The load script, run against a preview deployment before R2 acceptance, drives 300 simulated viewers at one heartbeat per 15 s for 10 minutes and must show p95 below 300 ms and no 5xx (result pasted into the PR). `apps/web/e2e/webinar-watch.spec.ts` (fake player stub): open token link, accept notice, the IFrame API `<script>` carries the response's CSP nonce and no CSP violation is reported, wait 3 heartbeats, admin registrations page shows watch minutes; the notice, play and captions toggle are operable by keyboard only.
- **Done.** Common done-definition plus the e2e spec.

### webinar-P5: Polls, CTAs, chat, questions, host console and moderation (R2, about 120 min)

- **Goal.** Interactions in live, replay and on-demand with the mode on every row; tags, automation events and tasks from them; the host console (rules 33-38, scenario 5).
- **Creates or edits.** `apps/web/modules/webinar/server/interactions.ts`; `apps/web/app/api/webinar/state/route.ts`, `apps/web/app/api/webinar/interact/route.ts`, `apps/web/app/api/webinar/cta/[ctaId]/route.ts`; `apps/web/app/(admin)/admin/webinars/[id]/host/page.tsx`; `apps/web/modules/webinar/ui/{poll-card,cta-button,chat-panel,question-box}.tsx` and `apps/web/modules/webinar/ui/host/{host-console,live-poll-controls,chat-moderation}.tsx`; edit `webinar-player.tsx` (mount the panels, the `aria-live` region of rule 44), `actions.ts` (`launchPoll`, `closePoll`, `showCta`, `hideCta`, `moderate` with mute and block), `queries.ts` (`getHostConsoleState`), `events.ts`, `privacy.ts` (interactions export); catalogue keys `webinar.player.poll.*`, `webinar.player.chat.*`, `webinar.admin.host.*`.
- **Interfaces.** `answerPoll(tx, viewer, { pollId; optionKeys; atSec; viewId }): Promise<{ ok: true } | { ok: false; code: 'already_answered' | 'invalid' | 'closed' }>`; `postMessage(tx, viewer, { kind: 'chat' | 'question'; text; atSec }): Promise<...>`; `recordCtaShown`, `signCtaClick(key, registrationId, ctaId, mode): string`, `recordCtaClick(tx, input: { registrationId; ctaId; mode; sig; atSec? }): Promise<{ redirectUrl: string; recorded: boolean }>`; `getLiveState(db, webinarId, after: Date, viewer): Promise<LiveState>`.
- **Depends on.** webinar-P4; `crm:applyTag`, `crm:createTask`, `crm:tags` (read); `platform:audit`.
- **Tests.** `interactions.test.ts`: poll answer once per mode, live and replay answers both stored with their modes; tag rules apply only for listed modes; CTA shown once per mode, click redirect adds UTM without overwriting existing UTM; chat limits 3 s and 60/h; muted viewer gets `403 muted` for chat and question but can answer a poll, unmute restores; one case per moderation action; a CTA click with a bad signature redirects and records nothing; `poll_answered` carries `option_key` for a single choice and null for two keys; an unknown tag in a rule does not abort the answer; question in replay creates a task without the text (dedupe on the interaction id); hidden messages vanish from state; block stops the player and hides messages; launch in live sets `show_at_sec`. `apps/web/modules/webinar/scenario-5.test.ts` (PGlite): one person answers the same poll live and in replay and clicks the CTA in both; `v_webinar_registration_facts` shows `poll_answers_live = 1`, `poll_answers_replay = 1`, events carry the right `mode`. `apps/web/e2e/scenario-5-replay-separation.spec.ts` (architecture name; skipped until R2): the same flow through the UI and the report.
- **Done.** Common done-definition plus both e2e specs.

### webinar-P6: Reporting, exports, pre-flight, privacy completion and switch-over (R2, about 120 min)

- **Goal.** Reports split by lead, customer and member with conversion within the chosen period; registrant export; pre-flight alerts and SLA monitoring; full privacy registration with sweep handlers; ops-facing stats; the switch-over runbook (rules 39-43, sections 9 and 9.3).
- **Creates or edits.** `apps/web/modules/webinar/server/{report,preflight}.ts`; edit `jobs.ts` (`webinar.preflight_check`, the `webinar.preflight` schedule job, the heartbeat-stopped check inside `webinar.sync_status`), `schedules.ts` (`webinar.preflight`); `docs/runbooks/webinar-switch-over.md`; `apps/web/app/(admin)/admin/webinars/[id]/report/page.tsx`; `apps/web/modules/webinar/ui/report/{summary-cards,segment-table,poll-results,cta-table,utm-table}.tsx`; edit `queries.ts` (`getWebinarReport`, `getPollResults`, `getCtaResults`), `actions.ts` (`exportWebinarRegistrants`), `api.ts` (`getPersonWebinarStats`, `countWebinarLeadsWithoutBooking`, `listWebinarLeadsWithoutBooking`, `listUpcomingWebinarHealth`), `privacy.ts` (complete, with the `sweep` handlers of 9.2), `nav.ts`; `apps/web/modules/webinar/privacy.test.ts` (complete); catalogue keys `webinar.admin.report.*`.
- **Interfaces.** `getWebinarReport(db, webinarId, { periodDays: 7 | 14 | 30 | 60 | 90 | 180 }): Promise<WebinarReport>` with `WebinarReport = { totals: SegmentRow; bySegment: Record<'lead'|'customer'|'member', SegmentRow>; byMode: Record<WatchMode, ModeRow>; polls: PollResult[]; ctas: CtaResult[]; utm: UtmRow[] }`; `buildReportCsv(report): string`; `buildRegistrantsCsv(rows): string`.
- **Depends on.** webinar-P5; `booking:bookings`, `commerce:orders` (read through `v_webinar_conversions`); `platform:files` (export); `platform:notify.slack`; `crm:createTask`; `ops:privacy runner` calls `webinarPrivacy`; `ops:retention_policies` row `webinar_registrations` (requested).
- **Tests.** `report.test.ts`: seeded lead, customer and member registrants; registered never counted as attended; booking 10 days after counts in 14-day and 30-day periods but not 7; purchase before the webinar not counted; CTA "booked after" counts only bookings after the click; aggregate CSV contains no email; `countWebinarLeadsWithoutBooking` counts a lead without a later booking and not one who booked after registering, and `listWebinarLeadsWithoutBooking` returns the same persons (count equals rows without a limit). `preflight.test.ts`: t60 alert for a live webinar without a broadcast, t15 alert for lifecycle `created`, none for `ready`, each alert once (double run), simulive without a processed recording alerts; heartbeat-stopped alert fires once. `privacy.test.ts`: export lists registrations, merged watch and raw segments, poll answers with labels, chat text; erase leaves no row referencing the person in all five tables (gdpr-coverage passes) and returns per-table counts; a second erase is a no-op; export and erase include the rows of a person merged into the subject; each sweep handler deletes only rows older than the cutoff and works through the append-only trigger. `permissions.test.ts` (edit: export needs `persons.export`). `apps/web/e2e/acceptance-r2-webinar.spec.ts`: the three R2 webinar acceptance tests (registration is not attendance, watch time captured, replay and replay polls separate).
- **Done.** Common done-definition plus the acceptance spec.

### webinar-P7: Campaign attribution and marketing KPIs (R3, about 60 min)

- **Goal.** Webinars inside the campaign funnel and the marketing dashboard (blueprint 33, 34).
- **Creates or edits.** `apps/web/modules/webinar/server/kpis.ts`; edit `api.ts` (`getWebinarKpis`), `server/report.ts` and `ui/report/utm-table.tsx` (cost per registration and click-to-registration rate when `ad_spend_daily` has the campaign); `apps/web/modules/webinar/kpis.test.ts`; catalogue keys `webinar.admin.report.utm.*`.
- **Interfaces.** `getWebinarKpis` (section 4.7); `funnelByCampaign(db, { from; to; periodDays }): Promise<Array<{ campaign: string | null; registrations; attended; firstVisit; firstPurchase; spendCents: number | null; costPerRegistrationCents: number | null; clickToRegistrationRate: number | null }>>` where click-to-registration rate = registrations ÷ `ad_spend_daily.clicks` of the same `utm_campaign` and period (ops keeps the blueprint 34 "registration rate" = registrations ÷ delivered invitation emails, ops rule 75). `liveAttendanceRate` = registrations with live `attended` ÷ registrations with `registered_mode = 'live'` (registration is never attendance).
- **Depends on.** webinar-P6; `ops:ad_spend_daily` (R3); `ops:marketing dashboard` consumes `getWebinarKpis`.
- **Tests.** `kpis.test.ts`: attendance rate and conversion per segment; campaign join on `utm.campaign` = `campaign_name`; null spend gives null cost; periods respected.
- **Done.** Common done-definition.

### webinar-P8: AI and summary hooks (R4, about 45 min)

- **Goal.** Non-personal webinar aggregates for natural-language questions, the weekly summary and churn and repurchase indicators.
- **Creates or edits.** `packages/db/src/schema/webinar.views.ts` (edit: `v_webinar_performance_daily`); edit `api.ts` (`getWebinarWeeklyFacts`); `apps/web/modules/webinar/server/ai-facts.ts`, `apps/web/modules/webinar/ai-facts.test.ts`. No request is filed: platform-P10, which depends on `webinar:v_webinar_performance_daily` from this package, places `ai.webinar_performance_daily` (`select * from public.v_webinar_performance_daily`, granted to `beam_ai_ro`) and adds `webinars_attended_live` and `watch_sec_total` of `v_person_webinar_stats` to `AI_ALLOWED_FIELDS` in its own files.
- **Interfaces.** `getWebinarWeeklyFacts` (section 4.7) returning facts `registrations`, `live_attendees`, `replay_viewers`, `on_demand_viewers`, `avg_live_watch_min`, `cta_clicks`, `conversions_30d`.
- **Depends on.** webinar-P7; `ops:ai.weekly_summary` (R4) consumes the facts.
- **Tests.** `ai-facts.test.ts`: facts for a seeded week; the view has no `person_id`, `email` or text column (asserted from `information_schema`); no member of `SENSITIVE_COLUMNS` involved.
- **Done.** Common done-definition.

## 13. Decisions made

Additions to the architecture (to be reflected in `01-architecture.md` section 2 and the route list by the plan integrator):

1. **No V1 tables or packages.** The architecture makes `webinar` an R2 module and gives imports to ops, so the V1 stopgap is ops' import (source `webinar_tool`, `imported_history`); an earlier draft's `external_webinars`, `webinar_imports`, CSV screens and Zapier webhook are dropped.
2. **New R2 tables** `webinar_presenters` (multiple presenters, identity through `users` or `persons` only) and `webinar_moderation_actions` APPEND (blueprint "mute/remove": mute = `mute_viewer`, chat and questions off while watching continues; remove = `block_viewer`; plus hide message; without editing append-only interactions). Presenter mute/remove and screen sharing are Meet's own controls.
3. **New columns on `webinars`:** `slug`, `series_key`, `description`, `locales`, `spoken_locale`, `status`, `planned_duration_minutes`, `duration_sec`, `youtube_stream_id`, `youtube_lifecycle`, `meet_space_name`, `publish_requested_at`, `broadcast_error`, `published_at`, `live_started_at`, `live_ended_at`, `finalised_at`, `is_replay_enabled`, `on_demand_access_days`, `attended_min_sec`, `conversion_window_days`, `is_chat_enabled`, `is_questions_enabled`, `owner_user_id`, `created_by_user_id`, `cancelled_reason`, `version`.
4. **New columns on `webinar_registrations`:** `token_version`, `status`, `source`, `locale`, `person_status` (snapshot), `utm`, `access_emails_sent`, `last_access_email_at`, `cancelled_at`, `blocked_at`, `blocked_by_user_id`, `muted_at`, `muted_by_user_id`. **On `webinar_polls`:** `allow_multiple`, `show_for_sec`, `live_launched_at`, `live_closed_at`, `is_active`, `sort_order`. **On `webinar_ctas`:** `live_shown_at`, `live_hidden_at`, `is_active`, `sort_order`. **On `watch_segments` and `webinar_interactions`:** denormalised `webinar_id` and `view_id`.
5. **New views** `v_webinar_registration_facts`, `v_webinar_conversions`, `v_person_webinar_stats`, and (R4) `v_webinar_performance_daily`, beside the architecture's `v_webinar_watch`.
6. **New routes** beyond `api/webinar/heartbeat`: `api/webinar/view`, `api/webinar/state`, `api/webinar/interact`, `api/webinar/cta/[ctaId]`, `api/public/webinars/[slug]/register`, `api/public/webinars/[slug]/ics`. Token viewers have no session, so these are route handlers, not server actions.
7. **New pages owned by this module inside `(site)`:** `/[locale]/webinars`, `/[locale]/webinars/[slug]`, `/[locale]/webinars/[slug]/join`, `/[locale]/w/[token]`. The architecture gives `(site)/*` to `site`; webinar pages are carved out the same way forms own `(site)/f/[slug]`.
8. **New cross-module API requests:** booking `upsertWebinarSession(tx, ctx, {webinarId, title, startsAt, endsAt})` and `cancelWebinarSession(tx, ctx, {webinarId, reason})` (booking R64, decision 42); crm's merge calls `webinar.mergePersons` and skips `webinar_registrations` in generic repointing; email registers this module's five dotted template keys from `templates/webinar/index.ts` and renders `{{webinar.*}}` merge fields from `modules/webinar/merge-fields.ts` collected by `pnpm gen:indexes` (decision 44); ops adds the `webinar_registrations` retention row and the four `webinar_tool` presets and uses `countWebinarLeadsWithoutBooking` / `listWebinarLeadsWithoutBooking`; automation seeds the journeys of 4.8 with this module's event names (decision 43); forms reads `webinars.id, slug, status` (decision 45). This module uses crm's published `applyTag`, `createTask`, `recordConsent`, `resolvePersonIds` unchanged.
9. **New event kinds:** `webinar.registered`, `webinar.registration_cancelled`, `webinar.started`, `webinar.attended`, `webinar.watched` (with `data.threshold`), `webinar.no_show`, `webinar.poll_answered`, `webinar.cta_clicked`, `webinar.question_asked`, `webinar.chat_posted`, `webinar.cancelled`, `webinar.rescheduled`. This list is authoritative: `webinar.watched` and `webinar.chat_posted` follow crm's catalogue, `webinar.no_show` follows automation's; crm's `webinar.cta_shown` is not an event (CTA impressions stay in `webinar_interactions`), and automation's per-threshold kinds (`webinar.watched_15m`, `webinar.replay_viewed`, ...) are expressed as `where` filters on these kinds. **New job kinds** and **schedules** as listed in sections 4.5 and 4.6.
10. **No platform requests remain (frozen files).** Everything this module needs from frozen files is already in platform's spec: the WAF and app exemption of the heartbeat and state routes with their per-registration buckets (PL-68), the env vars `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` (platform-P1 `.env.example`), provider `youtube` in `integration_calls`, `webinar_moderation_actions` in `APPEND_ONLY_TABLES`, the YouTube CSP (PL-67) and the R4 `ai` view and `AI_ALLOWED_FIELDS` entries (platform-P10). See decision 41.

Choices the inputs left open:

11. The V1 stopgap is a weekly CSV export of the old tool imported through ops. No WebinarGeek or Zoom API client and no webhook, because the tool is retired at the R2 switch-over (week 10) and imported history must not trigger automations.
12. Imports and registrations never create marketing consent; the registration form offers optional unticked `events` and `newsletter` boxes.
13. Webinars are free in R2. Paid events stay `ticket_types` in booking. A webinar session has `capacity_seats = 0` and is not bookable through the booking engine; registration is the only entry. So gift vouchers, deferred revenue, invoices and terms acceptance do not apply to webinars; a free online webinar needs no waiver or health disclaimer beyond the chat warning "do not share health details", and no check-in or reception flow (attendance is measured by watch time). Webinars may be scheduled outside the centre's opening hours and on closed days; `settings.business_hours` and booking's exceptions are not consulted.
14. Every live or simulive webinar has exactly one `sessions` row of kind `event`, owned by booking and written only through `booking.upsertWebinarSession`; the webinar's `starts_at` is authoritative. On-demand webinars have no session.
15. Recurring webinars are a series of independent occurrences grouped by `series_key`, created by "duplicate to dates" (up to 26 at once). No recurrence rule engine.
16. Simulive is presented as live: during the scheduled showing its rows carry mode `live`; afterwards the same video is a replay. Reports can still filter by `webinars.mode = 'simulive'`.
17. The server decides the mode and, for live and simulive, the position. Client positions are trusted only in replay and on-demand, and then capped by elapsed time.
18. Thresholds: attended at 300 s by default (configurable per webinar, 60-3,600 s), 15 min at 900 s, 30 min at 1,800 s, 50 % of the real duration (planned duration until YouTube reports it), end when the furthest watched position reaches `duration - 60` s. One event kind `webinar.watched` with `data.threshold`, like `credits.threshold_reached`.
19. "Replay watched" and "on-demand watched" are `webinar.attended` with that mode; "registered/no attendance" is `webinar.no_show`, written at least 30 minutes after the live ends, once the replay situation is known (decision 36). "Replay registered" and "on-demand registered" are `webinar.registered` with that `mode`; "replay started" and "on-demand started" are `webinar.started` with that mode.
20. Access token = registration id, version and an HMAC with a key derived from `AUTH_SECRET` (HKDF), so reminder emails can rebuild the link without storing it; `access_token_hash` is still stored for lookup and revocation is by `token_version`. A token never signs anyone into the portal.
21. `is_replay_gated = true` (default) means only people registered before the end may watch the replay; `false` lets anyone register for the replay. A replay view is counted per 30 minutes of inactivity.
22. Polls and CTAs launched live get their `show_at_sec` from the launch moment, so the replay matches the live timing.
23. Live chat is public to live viewers; questions go only to hosts; replay and on-demand have questions only, each creating a task for the webinar owner. Chat display name is first name plus last initial.
24. Poll tags are applied with `crm.applyTag(..., 'automation')` (`person_tags.source = 'automation'`, rule-based) instead of adding an enum value to crm.
25. CTA clicks pass through a BEAM redirect that records the click and appends UTM parameters (`utm_source=beam-webinar`), so booking and purchase after a CTA can also be attributed by commerce's UTM capture.
26. Reporting splits on the status snapshot at registration, not the current status; conversion counts from `anchor_at` (webinar start for live registrants, registration time otherwise) within a selectable period (7-180 days, default 30 per webinar).
27. One permission `webinars.host` covers editing, hosting and moderating (imports of the old tool use ops' import permission); `reports.read` also opens the aggregate report; the registrant list needs `persons.read` and its CSV `persons.export`.
28. Reminders run through automation's seeded `webinar-registration` journey (group `transactional`, active) at 7 days, 3 days and 3 hours before the start, with the access email as the confirmation, so a Friday registrant for a Sunday webinar gets the confirmation and the day-of reminder only (scenario 1 as the proposal words it). A 1-day reminder and a "starting now" email are left out for that reason. Watch-threshold journeys in the exclusive group `webinar` stay draft until ops records the DPIA decision on watch-time profiling; the no-show replay email is active from R2.
29. Retention: watch segments and interactions 2 years (architecture, ops rows), registrations 3 years (ops row requested); this module provides sweep handlers and seeds no policy. Erasure deletes all webinar rows of the person.
30. Google: Meet as processor under the Workspace DPA, YouTube embed as independent controller for connection data; `youtube-nocookie.com`, click-to-load notice with a stored wording version, no BEAM identity sent to Google; DPF with SCC fallback.
31. Meet spaces are created by the Meet REST API with a staff override; if Meet's own YouTube streaming creates a separate broadcast, staff switch the video id with one action.
32. The player polls `/api/webinar/state` every 5 s in live (30 s otherwise), with a 2-second in-process memo per webinar; no websockets or new realtime vendor.
33. Feature flag `ff_webinar_portal` gates discovery and the portal menu only; running viewers are never cut off by the flag.
34. Access links are multi-use per registration (one person opens the reminder link on a phone and a laptop), unlike the architecture's single-use claim and magic links; they stay safe because they are scoped to one webinar, never sign into the portal, are stored only as a hash, are revocable by `token_version`, and token pages send `Referrer-Policy: no-referrer`. CTA clicks use a separate signed click URL that records a click and grants nothing.
35. Templates under `packages/email/src/templates/webinar/` are written by this module, following the architecture's per-module template folders; the email spec's decision that email writes every template folder is overridden for this folder, and email-P8 creates no file in it.
36. `webinar.finalise` waits for the replay situation (recording processed, replay disabled, or 48 hours) so the no-show event can say whether a replay link exists; the no-show journey filters on it.
37. A pre-flight check at 60 and 15 minutes before a live or simulive start alerts staff in Slack and on the host console; the SLA-relevant signals are the pre-flight alerts, the sync failure alert and the heartbeat-stopped alert of rule 43.
38. Resending an access link needs only `persons.read`, so customer service, sales and reception can help a caller; everything else that changes a webinar needs `webinars.host`.
39. One definition of "webinar leads have not booked" (`countWebinarLeadsWithoutBooking`), used by ops' action dashboard.
40. The player, landing page and host console meet WCAG 2.1 AA with captions from YouTube in the spoken language; BEAM generates no captions.

Cross-module review items (R2 alignment round):

41. **Platform (applied).** The IFrame API loads through `next/script` with the request nonce (`x-nonce` from `proxy.ts`), admitted by PL-67's `'nonce-<n>' 'strict-dynamic'`; `frame-src` already lists `youtube-nocookie.com`. Heartbeat and state are exempt from the per-IP limit in the app and the WAF and limited per registration (PL-68), so this module files no frozen-file request (decision 10). The review note put both routes at 8 per registration per minute; this spec follows platform's own decision 83 instead: `webinar_heartbeat` 8 per minute, `webinar_state` 30 per minute, because the player polls state every 5 s while live and an 8/min state bucket would block every live viewer (rule 25).
42. **Booking (applied).** `upsertWebinarSession(tx, ctx, { webinarId, title, startsAt, endsAt })` and `cancelWebinarSession(tx, ctx, { webinarId, reason })` exactly as booking publishes them; booking keys both on `webinar_id`, so the webinar never passes `sessionId` and stores the returned `sessionId` in `webinars.session_id`. For a live webinar the upsert runs in the success transaction of `webinar.create_broadcast`, so a failed broadcast puts nothing on the calendar. Webinar sessions have `capacity_seats = 0` and booking refuses every booking action on them (booking R64 and booking decision 43). The stale note about `linkWebinarSession` is dropped.
43. **Automation (partly applied).** Declined: seeding the journeys through `automation.seedAutomations` from this module. The architecture gives seeded sequences to automation, automation's own spec seeds every webinar journey in `packages/core/src/automation/seeds/webinar.ts`, and `seed-automations.ts` is internal (not in automation's `api.ts`); two seeders of one slug would race. Applied: the priorities, under automation's slugs (the request's `webinar-follow-up-attended` and `webinar-follow-up-missed` do not exist): `webinar-attended` 60 and `webinar-no-show` 70, with the full order of section 4.8. Applied: a separate `webinar-cta-sales-task` journey in the non-exclusive `sales` group creates the CTA sales task, so the task is created even while the person is in another journey of the `sales_journey` lane (for example `customer_journey`, priority 10, which would otherwise block the exclusive `webinar` group); `webinar-cta-click` keeps only its follow-up email, so no person gets two tasks for one click. It is DPIA-gated like the other CTA journey. The integrator aligns automation (conflict list).
44. **Email (partly applied).** Applied: `getWebinarCards(tx, ids, locale)`; `merge-fields.ts` exporting `mergeFields` with email's resolver signature; `email.seedTemplate` for the marketing row `webinar-follow-up` (hyphenated `webinar-<name>`); ids passed in `context` and `data` (no `variables`); `key` instead of `idempotencyKey`. Declined: the slash keys `webinar/webinar-access` and slugs `webinar/<name>` for transactional templates, because email's own decision 1 (the stronger, owning requirement) replaced that form with dotted keys `<m>.<snake_name>` equal to the system row slug (`webinar.access`, `webinar.reminder`, `webinar.rescheduled`, `webinar.cancelled`, `webinar.replay_available`), and email decision 50 says webinar seeds no transactional row because `queueAutomationEmail` sends registry templates that declare `loadProps`. So this module no longer seeds `webinar-reminder` or `webinar-replay-available`; `reminder` and `replay_available` declare `loadProps`. The follow-up template uses merge fields, not the `webinar` block, because that block names one fixed webinar.
45. **Forms (applied).** `webinars.id`, `slug` and `status` are a documented read contract (section 2.3); forms builds `/[locale]/webinars/<slug>` itself and treats only `published`, `live` and `ended` as linkable. The id-to-slug 308 of the landing route stays as a fallback for hand-made links.
46. **crm (applied, no change needed).** Poll tags already use `crm.applyTag(tx, ctx, personId, tagKey, 'automation')`, crm's published signature; no `crm.tagPerson` call exists in this spec.
47. **ops (applied, from ops' spec rule 29).** `listWebinarLeadsWithoutBooking(db, { startedSince, limit })` returns the rows of the same predicate as `countWebinarLeadsWithoutBooking`, so ops' card writes no SQL over `webinar_registrations`.
