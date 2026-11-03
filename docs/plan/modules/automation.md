# Module spec: automation (Automation engine and journeys)

Owner module id: `automation`. Blueprint sections 20, 21, 31, 51, with requirements also taken from sections 5, 6, 18, 19, 22, 29, 30, 37, 47, 48, 56, 72, 76 and 87. This spec follows `docs/plan/00-decisions.md` and `docs/plan/01-architecture.md` (section 7 is the engine contract). Everything below is decided.

## 1. Purpose and release mapping

The automation module turns facts into follow-up. It reads `activity_events`, enrols people into journeys, plans every step from the enrolment or from an anchor (a webinar start, a session start, an offer expiry), checks everything again at send time, and writes one append-only log row for every decision. It never sends email itself; it hands messages to the `email` module and tasks to `crm`. Rules come before AI: no step in this module calls Claude.

| Release | What ships in this module |
| --- | --- |
| **V1 (weeks 1-6)** | Tables, views and the JSON definition format with all 12 step types (`email`, `wait`, `condition`, `task`, `tag`, `untag`, `set_field`, `status_override`, `enrol`, `exit`, `notify_slack`, `webhook`). Triggers by event with `where` filter, `segment_enter` and `manual`. Evaluator job every minute with gap-safe cursor; enrolment under a person row lock; audience, re-entry and exit rules; exclusive groups with priority (engine rule, seeded groups); late-entry skip at enrolment (scenario 1); send-time re-evaluation; pause and resume; versioning with optional migration; `automation.exit_for_suppression` (scenario 2). Staff controls on the person page (exit, enrol, move, preview, timeline). Admin screens: list, detail, form-based step editor with a JSON tab, versions, enrolments, run log. Seeded editable sequences: `welcome-lead`, `lead-sales-follow-up`, `event-registration`, `after-first-booking`, `after-first-visit`, `package-usage`, `inactivity`, `membership-renewal`, `review-request`, `waitlist-offer`. Seeded as `draft` for later activation: `abandoned-checkout` and the webinar set. |
| **Release 2 (weeks 9-10)** | "Automation conflict rules" as BEAM-editable configuration: group editor (exclusive, lane, priority), frequency caps and quiet hours for marketing steps (`settings.automation_rules`), the conflict report. Activation of the webinar behaviour sequences (registration, no attendance, attended, 15 min, 30 min, 50 %, end, replay, on-demand, poll answer, CTA click), `abandoned-checkout`, `waitlist-follow-up`, and the B2C pipeline playbook automations driven by `person.b2c_stage_changed`. |
| **Release 3 (weeks 11-12)** | B2B follow-up task journeys on `opportunity.stage_changed` (tasks and Slack only, no outbound B2B email); `b2b` purpose support in the editor; automation sends included in campaign attribution through `email_messages.enrolment_id` (read by `ops`). |
| **Release 4 (weeks 13-14)** | Visual workflow builder at `/admin/automations/[id]/builder` over the same JSON: trigger, condition, delay, branch, send email, create task, apply tag, change status, add or remove sequence, notify team member, update field, trigger webhook. No new engine. |
| **Later (out of scope)** | Automated B2B prospecting and personalised outbound email, voice AI, predictive send-time or churn-driven automation, SMS or WhatsApp steps, gamification. Each needs BEAM's GDPR and ePrivacy review first. |

## 2. Domain model

Schema file `packages/db/src/schema/automation.ts`, views in `packages/db/src/schema/automation.views.ts`. Conventions from architecture section 2: uuid keys with `gen_random_uuid()`, `created_at timestamptz not null default now()`, `updated_at` on mutable tables, enums `pgEnum('<table>_<column>')`. No column in this module is sensitive in the Article 9 sense; columns holding personal data are marked **PD**. Events with `activity_events.is_sensitive = true` never trigger, exit or enter context (rule A-7), so no sensitive value can reach these tables.

### 2.1 Enums

| Enum | Values |
| --- | --- |
| `automations_status` | `draft`, `active`, `paused`, `archived` |
| `automations_purpose` | `newsletter`, `events`, `member_comms`, `b2b` (the marketing purposes of `consent_records_purpose`) |
| `automation_enrolments_status` | `active`, `completed`, `exited` |
| `automation_enrolments_source` | `trigger`, `segment`, `staff`, `staff_move`, `enrol_step`, `migration`, `api` |
| `automation_runs_outcome` | `entered`, `scheduled`, `sent`, `task_created`, `tag_applied`, `tag_removed`, `field_set`, `status_set`, `enrolled`, `notified`, `webhook_called`, `branched`, `skipped_late_entry`, `skipped_condition`, `skipped_unreachable`, `skipped_translation`, `skipped_exclusive`, `skipped_paused`, `skipped_stale`, `skipped_frequency_cap`, `exited`, `completed`, `failed` |

### 2.2 `automation_groups` (mutable, small)

| Column | Type | Null | Default | Check / note |
| --- | --- | --- | --- | --- |
| `id` | uuid | no | `gen_random_uuid()` | PK |
| `key` | text | no | | unique; `key ~ '^[a-z][a-z0-9_]*$'` |
| `name` | text | no | | staff-facing label |
| `description` | text | yes | | |
| `is_exclusive` | boolean | no | `false` | at most one active enrolment per person in the exclusivity domain |
| `lane` | text | yes | | addition. Groups with the same non-null `lane` form one exclusivity domain; null means the domain is the group key. `lane ~ '^[a-z][a-z0-9_]*$'` |
| `priority` | smallint | no | `100` | `between 0 and 1000`; lower wins |
| `created_at`, `updated_at` | timestamptz | no | `now()` | |

Seed (key, exclusive, lane, priority): `customer_journey` (yes, `sales_journey`, 10), `webinar` (yes, `sales_journey`, 20), `waitlist` (yes, `sales_journey`, 25), `lead_nurture` (yes, `sales_journey`, 30), `package` (no, -, 100), `inactivity` (no, -, 100), `membership` (no, -, 100), `transactional` (no, -, 100), plus additions `review` (no, -, 100), `sales` (no, -, 100), `checkout` (no, -, 100). The exclusivity domain of an exclusive group is `coalesce(lane, key)`.

### 2.3 `automations` (mutable)

| Column | Type | Null | Default | Check / note |
| --- | --- | --- | --- | --- |
| `id` | uuid | no | `gen_random_uuid()` | PK |
| `slug` | text | no | | unique; `slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'` |
| `name` | text | no | | staff-facing |
| `description` | text | yes | | |
| `group_id` | uuid | no | | FK `automation_groups.id` on delete restrict |
| `priority` | smallint | no | `100` | addition; tie-breaker inside a domain after group priority; `between 0 and 1000` |
| `current_version_id` | uuid | yes | | FK `automation_versions.id` (null until first publish) |
| `status` | `automations_status` | no | `'draft'` | `status = 'draft' or current_version_id is not null` |
| `is_marketing` | boolean | no | `true` | |
| `purpose` | `automations_purpose` | yes | | `is_marketing = false or purpose is not null` |
| `draft_definition` | jsonb | yes | | addition: the working copy edited in the admin; publishing copies it into a version |
| `draft_updated_at` | timestamptz | yes | | addition |
| `draft_updated_by_user_id` | uuid | yes | | addition; FK `users.id` |
| `activated_at` | timestamptz | yes | | addition; first activation |
| `paused_at` | timestamptz | yes | | addition; set on pause, cleared on resume |
| `last_resumed_at` | timestamptz | yes | | addition |
| `created_by_user_id` | uuid | yes | | FK `users.id`; null for seed |
| `created_at`, `updated_at` | timestamptz | no | `now()` | |

Indexes: `(status)`, `(group_id)`. Invariant: `paused_at is not null` exactly when `status = 'paused'` (check constraint).

### 2.4 `automation_versions` IMMUTABLE

| Column | Type | Null | Default | Check / note |
| --- | --- | --- | --- | --- |
| `id` | uuid | no | `gen_random_uuid()` | PK |
| `automation_id` | uuid | no | | FK `automations.id` on delete restrict |
| `version` | integer | no | | `version > 0` |
| `definition` | jsonb | no | | parsed by `AutomationDefinition` (section 2.8) |
| `definition_hash` | text | no | | addition; sha256 of canonical JSON, so "publish" of an unchanged draft is refused |
| `change_note` | text | yes | | addition |
| `published_at` | timestamptz | no | `now()` | |
| `created_by_user_id` | uuid | yes | | FK `users.id`; null for seed |
| `created_at` | timestamptz | no | `now()` | |

Unique `(automation_id, version)`. Rows exist only once published (drafts live in `automations.draft_definition`), so no update or delete path exists in code; the package PR asks the orchestrator to add the table to the append-only trigger list of the wave's custom migration.

### 2.5 `automation_enrolments` (mutable, PD)

| Column | Type | Null | Default | Check / note |
| --- | --- | --- | --- | --- |
| `id` | uuid | no | `gen_random_uuid()` | PK |
| `automation_id` | uuid | no | | FK `automations.id` restrict |
| `automation_version_id` | uuid | no | | FK `automation_versions.id` restrict |
| `person_id` | uuid | no | | FK `persons.id` restrict. PD |
| `subject_key` | text | no | `''` | addition; `''` or `<ref_type>:<ref_id>` when the definition sets `"subject": "ref"` (one journey per webinar, booking, grant, checkout) |
| `group_id` | uuid | no | | addition; copy of `automations.group_id` at entry |
| `exclusive_domain` | text | yes | | addition; `coalesce(lane, key)` of an exclusive group, else null |
| `source` | `automation_enrolments_source` | no | | addition |
| `trigger_event_id` | bigint | yes | | addition; FK `activity_events.id` |
| `anchor_at` | timestamptz | yes | | null when the anchor is `enrolment` |
| `status` | `automation_enrolments_status` | no | `'active'` | |
| `next_step_key` | text | yes | | |
| `next_step_at` | timestamptz | yes | | |
| `entered_at` | timestamptz | no | `now()` | |
| `ended_at` | timestamptz | yes | | |
| `end_reason` | text | yes | | one of: `completed`, `exit_event:<kind>`, `unsubscribed`, `consent_withdrawn:<purpose>`, `manual`, `moved`, `superseded`, `migrated`, `exit_step`, `erased`, `merged`, `archived`, `anchor_passed` |
| `plan` | jsonb | no | `'[]'` | addition; `[{ key, type, due_at, state }]`, `state` in `pending|done|skipped|not_taken` |
| `context` | jsonb | no | `'{}'` | PD; `{ trigger: { event_id, kind, ref_type, ref_id, mode, data }, subject, vars }` |
| `entered_by_user_id` | uuid | yes | | addition; FK `users.id` for staff entries |
| `migrated_from_enrolment_id` | uuid | yes | | addition; FK self |
| `created_at`, `updated_at` | timestamptz | no | `now()` | |

Checks: `(status = 'active') = (ended_at is null)`; `status = 'active' or next_step_at is null`; `status <> 'exited' or end_reason is not null`.
Indexes and constraints:
- Partial unique `uq_enrolment_active` on `(automation_id, person_id, subject_key) where status = 'active'` (the architecture's `(automation_id, person_id)` rule, widened by `subject_key`; identical when `subject_key = ''`).
- Partial unique `uq_enrolment_domain` on `(person_id, exclusive_domain) where status = 'active' and exclusive_domain is not null`: the database itself guarantees one active journey per person per exclusive domain.
- Partial unique `uq_enrolment_trigger` on `(automation_id, trigger_event_id) where trigger_event_id is not null`: re-reading an event never enrols twice.
- `ix_enrolment_due` on `(next_step_at) where status = 'active'`; `(person_id, status)`; `(automation_id, status, entered_at desc)`; `(person_id, automation_id, entered_at desc)` for re-entry checks.

### 2.6 `automation_runs` APPEND (PD)

| Column | Type | Null | Default | Check / note |
| --- | --- | --- | --- | --- |
| `id` | uuid | no | `gen_random_uuid()` | PK |
| `enrolment_id` | uuid | yes | | FK `automation_enrolments.id`; null for `skipped_exclusive` and entry `failed` rows that create no enrolment |
| `person_id` | uuid | no | | FK `persons.id`. PD |
| `automation_id` | uuid | no | | FK `automations.id` |
| `automation_version_id` | uuid | yes | | addition; FK `automation_versions.id` |
| `step_key` | text | yes | | null for `entered`, `exited`, `completed`, `skipped_exclusive` |
| `outcome` | `automation_runs_outcome` | no | | |
| `reason` | text | yes | | machine reason, for example `due 2026-11-01T10:00Z before entry`, `unless:has_future_booking`, `purpose newsletter not reachable`, `locale fr-BE missing in template webinar-confirm v3` |
| `data` | jsonb | no | `'{}'` | addition; `{ due_at, branch, target, template_slug, template_version_id, event_id, superseded_enrolment_id }`. PD |
| `email_message_id` | uuid | yes | | FK `email_messages.id` |
| `task_id` | uuid | yes | | FK `tasks.id` |
| `actor` | jsonb | no | | addition; `{kind: job|staff|system, id}` |
| `dedupe_key` | text | yes | | addition; unique; `run:<enrolment_id>:<step_key>:<outcome>` for step outcomes, `entry:<automation_id>:<event_id>` for entry skips |
| `occurred_at` | timestamptz | no | `now()` | |
| `created_at` | timestamptz | no | `now()` | |

Indexes: `(person_id, occurred_at desc)`, `(enrolment_id, occurred_at)`, `(automation_id, occurred_at desc)`, partial `(occurred_at desc) where outcome in ('failed','skipped_translation')` for the digest. Insert-only through `reject_update_delete()` (the table is in `APPEND_ONLY_TABLES` from Wave 0); erasure deletes under `SET LOCAL beam.allow_rewrite = 'on'`.

### 2.7 Views (`automation.views.ts`, Drizzle `pgView` with `.as(sql)`)

```sql
create view v_automation_stats as
with e as (select automation_id,
             count(*) filter (where status = 'active')    as active_count,
             count(*) filter (where status = 'completed') as completed_count,
             count(*) filter (where status = 'exited')    as exited_count,
             count(*) filter (where entered_at > now() - interval '7 days') as entered_7d
           from automation_enrolments group by automation_id),
     r as (select automation_id,
             count(*) filter (where outcome = 'sent')        as sent_7d,
             count(*) filter (where outcome::text like 'skipped_%') as skipped_7d,
             count(*) filter (where outcome = 'failed')      as failed_7d,
             max(occurred_at) as last_run_at
           from automation_runs where occurred_at > now() - interval '7 days' group by automation_id)
select a.id as automation_id, a.slug, a.status,
       coalesce(e.active_count,0) active_count, coalesce(e.completed_count,0) completed_count,
       coalesce(e.exited_count,0) exited_count, coalesce(e.entered_7d,0) entered_7d,
       coalesce(r.sent_7d,0) sent_7d, coalesce(r.skipped_7d,0) skipped_7d,
       coalesce(r.failed_7d,0) failed_7d, r.last_run_at
from automations a left join e on e.automation_id = a.id left join r on r.automation_id = a.id;

create view v_automation_due as
select en.id as enrolment_id, en.automation_id, en.person_id, en.next_step_key, en.next_step_at
from automation_enrolments en join automations a on a.id = en.automation_id
where en.status = 'active' and a.status = 'active' and en.next_step_at <= now();

create view v_person_automation_timeline as
select r.id, r.person_id, r.occurred_at, r.outcome, r.step_key, r.reason, r.enrolment_id,
       a.slug as automation_slug, a.name as automation_name, en.end_reason,
       r.email_message_id, m.status as email_status, r.task_id
from automation_runs r join automations a on a.id = r.automation_id
left join automation_enrolments en on en.id = r.enrolment_id
left join email_messages m on m.id = r.email_message_id;
```

### 2.8 The definition (`packages/core/src/automation/definition.ts`, Zod)

```ts
type Definition = {
  schema_version: 1;
  trigger: { event: string; where?: Filter } | { segment_enter: string /* segment uuid */ } | { manual: true };
  anchor: 'enrolment' | `data.${string}`;           // path into the trigger event data, ISO timestamp
  subject?: 'ref';                                   // one enrolment per trigger ref_type:ref_id
  audience?: { status?: ('lead'|'customer'|'member')[]; segment_id?: string; exclude_segment_ids?: string[];
               locales?: ('nl-BE'|'fr-BE'|'en')[]; require_reachable?: boolean /* default = is_marketing */ };
  re_entry: 'never' | 'always' | `after_days:${number}`;
  exit_on: (string | { event: string; where?: Filter; same_subject?: boolean })[]; // "kind" or "kind:qualifier"
  steps: Step[];                                     // 1..40 steps, keys unique, ^[a-z0-9_]{1,40}$
};
type At = { from: 'enrolment' | 'anchor' | 'previous'; minutes: number; snap_to?: `${number}:${number}` /* HH:mm Brussels */ };
type StepBase = { key: string; at?: At; unless?: Condition; late_entry?: 'skip' | 'send_now' };
type Step = StepBase & (
  | { type: 'email'; template: string /* email_templates.slug */ }
  | { type: 'wait'; minutes: number }
  | { type: 'condition'; if: Condition; then: string | 'end'; else: string | 'end' }   // forward targets only
  | { type: 'task'; title: string; kind: 'call'|'follow_up'|'payment'|'proposal'|'review'|'other';
      owner_role: string; due_in_minutes: number; priority: 'low'|'normal'|'high' }
  | { type: 'tag' | 'untag'; tag: string /* tags.key */ }
  | { type: 'set_field'; field: 'preferred_channel'; value: 'email'|'phone'|'whatsapp' }
  | { type: 'status_override'; value: 'lead'|'customer'|'member'|null; reason: string }
  | { type: 'enrol'; automation: string /* slug */ }
  | { type: 'exit'; automation?: string /* slug; omitted = this enrolment */ }
  | { type: 'notify_slack'; text: string /* placeholders {{first_name}} {{person_url}} {{automation}} only */ }
  | { type: 'webhook'; url: string /* https, host in settings.automation_rules.webhook_hosts */ } );
type Filter = Record<string /* dotted path: data.x, mode, ref_type */, Literal | { eq?; ne?; in?; nin?; gt?; gte?; lt?; lte?; exists?: boolean }>;
type Condition =
  | { all: Condition[] } | { any: Condition[] } | { not: Condition }
  | { has_future_booking: true | { kind?: 'day'|'night'|'event'; within_days?: number } }
  | { status_in: ('lead'|'customer'|'member')[] } | { has_tag: string } | { in_segment: string }
  | { has_active_membership: true } | { membership_cancelling: true }
  | { has_other_active_grant: { credit_kind: 'day'|'night'|'euro' | '{{trigger.data.credit_kind}}' } }
  | { event_since_enrolment: string /* kind */ } | { booking_status_in: ('attended'|'no_show'|'confirmed'|'cancelled')[] /* trigger booking */ }
  | { trigger: Filter /* matches the trigger event */ } | { task_open: string /* step key of a task step */ }
  | { sent_within_days: { template: string; days: number } };
```

`Literal` is string, number, boolean or null. `{{trigger.data.x}}` interpolation is allowed only inside `has_other_active_grant.credit_kind`. The parser rejects unknown keys (`.strict()`).

### 2.9 Tables of other modules this module reads or writes

| Module | Table or view | Access |
| --- | --- | --- |
| crm | `activity_events` | read (evaluator source; index on `id` is the PK) |
| crm | `persons` | read and `SELECT ... FOR UPDATE` lock; `status_override` written only through `crm` api |
| crm | `suppressions`, `segment_members`, `tags`, `person_tags`, `tasks` | read; writes through `crm` api (`applyTag`, `removeTag`, `createTask`, `setStatusOverride`, `setPreferredChannel`) |
| credits | `v_person_status`, `v_person_credits`, `credit_grants`, `memberships` | read |
| booking | `v_person_bookings`, `bookings` | read |
| email | `v_marketing_reachability`, `email_templates`, `email_template_versions`, `email_messages` | read; messages created through `email` api |
| commerce | `checkouts` | read (R2); `recovery_message_id` written through `commerce` api |
| platform | `settings` (`automation_cursor`, `automation_rules`), `users`, `roles`, `feature_flags`, `jobs`, `audit_log` | read; `settings.automation_cursor` written by the evaluator; jobs via `enqueue()`; audit via `ctx.audit` |

## 3. Business rules

Each rule has an id used by tests (`it('A-12 ...')`).

### 3.1 Definitions, versions and status

- **A-1** A definition is valid only if `AutomationDefinition.parse` succeeds and `validateDefinition` returns no issues: step keys unique; `condition.then/else` point to a later step or `end` (no loops); every `email.template` is a published template; every `enrol`/`exit` slug exists and is not the automation itself for `enrol`; every `tag` key exists; `owner_role` is a seeded role key; `webhook.url` is `https` and its host is in `settings.automation_rules.webhook_hosts`; anchor-relative `at` requires `anchor <> 'enrolment'`; an exclusive-group automation must not set `subject`.
- **A-2** Publishing inserts `automation_versions.version = max + 1` with the draft, sets `current_version_id`, and is refused (`conflict`) when `definition_hash` equals the current version's hash. Published versions are never edited or deleted.
- **A-3** Publish-time translation check: every template referenced by an `email` step must have a published version whose `locales` contain every locale in `audience.locales` (default all three). Missing locales fail the publish with the list (`assertComplete` semantics).
- **A-4** A marketing step (template `kind = marketing`) inside an automation with `is_marketing = false` is allowed; its reachability is still checked per step (A-31). A `marketing` template whose `purpose` differs from the automation `purpose` fails validation.
- **A-5** Status moves: `draft -> active` (activate, needs a published version), `active <-> paused`, any `-> archived`. Archiving exits all active enrolments with reason `archived`. An archived automation cannot be reactivated; staff duplicate it instead.
- **A-6** New enrolments always use `current_version_id`. Existing enrolments keep their version unless staff tick "migrate active enrolments" on publish (A-40).

### 3.2 Evaluation and enrolment

- **A-7** The evaluator ignores events with `is_sensitive = true` and events whose kind starts with `automation.`; such events never trigger, exit or enter `context`.
- **A-8** The evaluator processes events in `id` order after `settings.automation_cursor.last_event_id`, at most 1,000 per batch and 5 batches or 40 seconds per run. It also re-reads ids listed as gaps in the cursor (ids between processed ids that were not visible yet); a gap older than 10 minutes is dropped (rolled-back transaction). Re-reading is harmless because of `uq_enrolment_trigger` and idempotent exits.
- **A-9** Per event the order is fixed: (1) built-in exits, (2) `exit_on` matches of that person's active enrolments, (3) trigger matches of `active` automations sorted by group priority, then automation priority, then slug. A purchase therefore ends lead nurture before the customer journey is considered.
- **A-10** A trigger matches when the kind is equal and every `where` path matches (`eq` for literals, operators as declared; a missing path fails every operator except `exists: false`). `segment_enter` matches `segment.entered` with `data.segment_id` equal. `manual` never matches an event.
- **A-11** Enrolment runs inside one transaction holding `SELECT id FROM persons WHERE id = $1 FOR UPDATE`. A person with `erased_at` or `merged_into_person_id` set is never enrolled.
- **A-12** Audience check at entry: `status` against `v_person_status`, `segment_id` and `exclude_segment_ids` against `segment_members`, `locales` against `persons.locale`. A failed audience check writes no run row (it is not a journey decision, and logging it would flood the log).
- **A-13** Re-entry: `never` refuses if any enrolment of this automation exists for the person and subject; `after_days:N` refuses if the latest `entered_at` for the person and subject is less than N days ago; `always` allows. An active enrolment for the same automation, person and subject always refuses the new one.
- **A-14** Marketing entry check: when `require_reachable` (default `is_marketing`) is true, `v_marketing_reachability` must be reachable for the automation `purpose`; otherwise the run `skipped_unreachable` is written with `enrolment_id` null and nothing is enrolled.
- **A-15** Exclusivity: for an exclusive group, if no active enrolment exists in the domain, enrol. If one exists and the candidate has a lower `(group.priority, automation.priority)` pair, the existing enrolment exits with `superseded` (run `exited`, `data.superseded_by`) and the candidate enrols. Otherwise the candidate writes `skipped_exclusive` (reason names the blocking automation) and does not enrol. Equal pairs keep the existing enrolment. `uq_enrolment_domain` enforces the result.
- **A-16** The anchor is read from the trigger event path (ISO timestamp). A missing or unparsable anchor writes `failed` with reason `anchor_missing` and no enrolment. An anchor already in the past at entry is allowed; steps planned before entry are skipped (A-18). If every step would be skipped, the enrolment completes at once with `end_reason = anchor_passed`.
- **A-17** `planSteps` computes `due_at` per step along the default path: `from: enrolment` = `entered_at + minutes`; `from: anchor` = `anchor_at + minutes`; `from: previous` or no `at` = due of the previous planned step that is not skipped (or `entered_at`) plus any `wait` minutes in between; `snap_to` sets the Brussels local time on that date (DST-safe). A step after a `condition` is planned on the default path and re-planned when the branch is taken.
- **A-18** Late-entry skip (scenario 1): at enrolment every step with an `at` of `from: enrolment|anchor` whose `due_at < entered_at` gets `skipped_late_entry` with `data.due_at`, unless the step has `late_entry: send_now`, in which case it becomes due at `entered_at`. Steps relative to the previous step are never late. A Friday 10:00 registration for a Sunday 10:00 event in `event-registration` logs `skipped_late_entry` for `reminder_7d` and `reminder_3d` and keeps `confirm` and `reminder_day_of`.
- **A-19** After planning, the run `entered` (with `data.trigger_event_id`) and one `scheduled` row for the first pending step (with `data.due_at`) are written; `next_step_key` and `next_step_at` are set.
- **A-20** The evaluator enqueues `automation.step` for every row of `v_automation_due` (at most 500 per run, oldest first). The job key `automation:<enrolment_id>:<step_key>` makes double enqueueing harmless.

### 3.3 Exits

- **A-21** Built-in exits apply to every automation regardless of `exit_on`: `person.erased` (reason `erased`), `person.merged` for the loser (reason `merged`), `suppression.added` (marketing automations whose purpose is in scope, reason `unsubscribed`), `consent.withdrawn` with `data.purpose` equal to the automation purpose (reason `consent_withdrawn:<purpose>`).
- **A-22** `exit_on` entries: `"kind"` matches the kind; `"kind:q"` also needs `data.purpose = q` or `data.scope = q` or `data.product_kind = q`; the object form adds `where` and `same_subject` (event `ref_type:ref_id` equals `subject_key`). Matching enrolments end `exited` with `exit_event:<kind>`.
- **A-23** `automation.exit_for_suppression` (scenario 2) loads the suppression, finds persons whose `sha256(lower(email))` equals `email_hash`, and in one transaction ends every active enrolment of a marketing automation whose purpose is covered by the scope (`all` covers every purpose) with `unsubscribed`. It runs in the `after()` kick of the suppressing action, so marketing journeys end within seconds; the per-minute evaluator and the send-time check are the safety nets, well inside 15 minutes.
- **A-24** Transactional automations (`is_marketing = false`) are not exited by suppressions or consent withdrawal; their marketing steps are still skipped by A-31.
- **A-25** Ending an enrolment sets `status`, `ended_at`, `end_reason`, clears `next_step_*`, marks pending plan entries `not_taken`, and writes exactly one `exited` or `completed` run. Pending `automation.step` jobs find the enrolment ended and finish as no-ops.

### 3.4 Step execution (send-time re-evaluation)

- **A-26** `automation.step` locks the enrolment `FOR UPDATE` and checks in this order, writing one run row for the first failing check: enrolment active and `next_step_key` equals the job's step (else no-op, no row); automation not `paused` (no row; the step waits for resume); person not erased (exit `erased`); overdue rule A-28; `unless` true (`skipped_condition`, reason `unless:<predicate>`); step-specific checks A-31 to A-33.
- **A-27** Conditions are evaluated against fresh facts loaded at step time inside the job transaction (`loadFacts`), never against values copied at entry.
- **A-28** Overdue rule: an `email`, `notify_slack` or `webhook` step processed more than 24 hours after `due_at` is skipped: `skipped_paused` when the automation was paused during that window, else `skipped_stale`. `task`, `tag`, `untag`, `set_field`, `status_override`, `enrol` and `exit` steps still run late.
- **A-29** On resume, `automation.resume` writes `skipped_paused` for every active enrolment whose `next_step_at` is more than 24 hours before the resume time and whose step is time-sensitive (A-28), advances them, and leaves the rest to run normally.
- **A-30** `has_future_booking` is true when `v_person_bookings` has a booking in status `reserved|confirmed` with `starts_at > now()` (optionally filtered by kind and `within_days`). Inactivity steps use it so nobody with a relevant booking gets "we miss you".
- **A-31** Email step: resolve the template's current published version; for a marketing template require `v_marketing_reachability.is_reachable` for its purpose (`skipped_unreachable`); require `persons.locale` in the version's `locales` (`skipped_translation`, plus a Slack alert line in the daily digest); then call `email.queueAutomationEmail` with key `automation:<enrolment_id>:<step_key>` and write `sent` with `email_message_id`. `email.send` checks suppressions once more before Resend.
- **A-32** Frequency cap (R2, marketing templates only): more than `max_marketing_per_day` (default 1) or `max_marketing_per_week` (default 3) automation marketing emails to the person in the trailing window gives `skipped_frequency_cap`. Quiet hours (default 21:00-08:00 Brussels) move a due marketing email to 08:00 the next morning instead of skipping (a new `scheduled` row).
- **A-33** Other steps: `task` creates a `crm` task (`source = automation`, `ref_type = automation_enrolment`) owned by the active staff user with that role and the fewest open tasks (ties by name), due `now + due_in_minutes` -> `task_created`; `tag`/`untag` -> `tag_applied`/`tag_removed` (no row change if already in that state, still logged); `set_field` -> `field_set`; `status_override` -> `status_set` with the reason, written through `crm.setStatusOverride`; `enrol` enrols into the target (all entry rules apply, source `enrol_step`) -> `enrolled` or the target's skip row; `exit` ends this or the named enrolment -> `exited` with `exit_step`; `notify_slack` enqueues `notify.slack` -> `notified`; `webhook` enqueues `automation.webhook` -> `webhook_called` when it returns 2xx, `failed` when dead.
- **A-34** After a step, the next step is the `then`/`else` target for a condition (run `branched` with `data.result` and `data.target`), else the next planned step that is not skipped. The next step is re-planned if its due was computed on the other branch. No next step: `completed`.
- **A-35** A step job that throws a `RetryableError` retries with the platform backoff; when it goes `dead` the run `failed` is written by the job's `onDead` hook, the enrolment advances past the step, and the dead job alerts Slack (blueprint 72, failed automations).

### 3.5 Staff controls, preview and timeline

- **A-36** Exit (person page): ends one active enrolment with `manual`; needs `automations.move_person`; one audit row `automation.person_exit`.
- **A-37** Enrol: staff enrol a person into any `active` automation; re-entry and exclusivity priority are overridden (a blocking enrolment in the domain exits with `moved`), the audience mismatch is shown as a warning but allowed, the anchor must be given when the definition has a data anchor, marketing reachability is still enforced per step. Audit `automation.person_enrol`.
- **A-38** Move: exit one enrolment (`moved`) and enrol into another automation in one transaction and one audit row `automation.person_move` with old and new automation slugs. Both appear on the timeline.
- **A-39** Preview: `previewEnrolment` runs `planSteps` and the step checks read-only and returns each step with `due_at` and the predicted outcome (`will_send`, `late_entry`, `condition_false`, `unreachable`, `translation_missing`, `frequency_cap`). It writes nothing.
- **A-40** Migration on publish (`automation.migrate_enrolments`, bulk lane, 500 per chunk): each active enrolment of older versions exits `migrated` and a new enrolment with the same anchor, subject and `migrated_from_enrolment_id` enters the new version. Steps whose key was already executed in the old enrolment are marked `done` without a run; other steps planned before now get `skipped_late_entry` with reason `migrated`.
- **A-41** The person timeline shows every run row with automation name, step, outcome, reason and email status, newest first; the blueprint list "entered, trigger, step, skipped step, condition, branch, exit, exit reason" maps to `entered` (+ `data.trigger_event_id`), `sent`/`task_created`/..., `skipped_*`, `branched`, `exited` + `end_reason`.

### 3.6 Seeded sequences (editable by marketing; seed never overwrites an existing slug)

Times are minutes in the definition; shown here in readable form. "T" = transactional template (no consent check), "M" = marketing template (purpose `newsletter` unless stated).

| Slug (group, marketing) | Trigger, anchor, subject, re-entry | Steps | Exit on |
| --- | --- | --- | --- |
| `welcome-lead` (lead_nurture, yes) | `person.created` where `data.origin in [form, site, portal, webinar]` and audience `status: [lead]`; anchor enrolment; `never` | `welcome` M +0; `edu_1` M +2 d 10:00; `edu_2` M +5 d 10:00; `webinar_invite` M +7 d 10:00; `engaged` condition `event_since_enrolment: email.clicked` then `tag_engaged` else `experience_invite`; `tag_engaged` tag `engaged`; `experience_invite` M +10 d 10:00; `edu_3` M +14 d 10:00 | `order.paid`, `booking.attended`, `membership.activated` |
| `lead-sales-follow-up` (sales, no) | `person.created` same filter, status lead; `never` | `call_1` task "Bel nieuwe lead: BEAM Experience voorstellen" owner sales, +2 d, due 1 d, unless `any[has_future_booking, status_in[customer, member]]`; `call_2` task +9 d same unless | `order.paid`, `booking.confirmed` |
| `event-registration` (transactional, no) | `booking.confirmed` where `data.session_kind = event`; anchor `data.starts_at`; subject ref; `always` | `confirm` T +0; `reminder_7d` T anchor -7 d; `reminder_3d` T anchor -3 d; `reminder_day_of` T anchor -180 min | `booking.cancelled` same subject |
| `after-first-booking` (transactional, no) | `booking.confirmed` where `data.is_first_booking = true` and `data.session_kind in [day, night]`; anchor `data.starts_at`; subject ref; `never` | `confirm` T +0 ("your first visit"); `preparation` T anchor -2 d, `late_entry: send_now`; `reminder` T anchor -1 d 18:00 | `booking.cancelled` same subject |
| `after-first-visit` (customer_journey, no) | `booking.attended` where `data.is_first_visit = true`; `never` | `follow_up` T +1 d 10:00; `feedback` T +2 d 10:00; `package_offer` M +4 d 10:00 unless `any[has_other_active_grant: day, has_active_membership]`; `sales_task` task "Opvolging na eerste bezoek" owner sales +5 d unless `event_since_enrolment: order.paid` | `membership.activated` |
| `package-usage` (package, no) | `credits.threshold_reached` (`data.pct` in 50, 75, 80, 90, 100 = last unit); subject ref (`credit_grant:<id>`); `always` (each threshold enrolment completes within minutes, except `last`, which is the final one) | condition on `trigger: data.pct` -> `p50` T, `p75` T, `p80` tag `package_nearly_used`, `p90` M "almost done, repurchase", `last` M "last session" then `last_task` task "Pakket bijna op: bel klant" owner customer_service +3 d; every email step unless `has_other_active_grant: {{trigger.data.credit_kind}}` | `order.paid:package`, `membership.activated` (stop on repurchase) |
| `inactivity` (inactivity, yes) | `person.inactive_days` where `data.days in [30, 60, 90]`; audience status customer, member; no subject; `always` (ops emits each threshold once per inactivity period) | condition on `data.days` -> `d30` M, `d60` M, `d90` M + `d90_task` task owner customer_service; every step unless `any[has_future_booking, has_active_membership]` for d30, `has_future_booking` for the others | `booking.confirmed`, `order.paid` |
| `membership-renewal` (membership, no) | `membership.renewal_due` where `data.days in [30, 7]`; subject ref (`membership:<id>`); `always` | condition `data.days = 30` -> `r30` T else `r7` T; both unless `membership_cancelling` | `membership.cancelled`, `membership.renewed` |
| `review-request` (review, yes) | `booking.attended`; `after_days:30` | `ask` M +1 d 11:00 unless `any[booking_status_in[no_show, cancelled], has_tag: reviewed]` | `booking.no_show` same subject |
| `waitlist-offer` (transactional, no) | `waitlist.offered`; anchor `data.offer_expires_at`; subject ref; `always` | `expiring` T anchor -30 min (link to `/[locale]/account/waitlist`) | `waitlist.confirmed`, `waitlist.expired`, `waitlist.released`, `waitlist.withdrawn`, all `same_subject` |
| `abandoned-checkout` (checkout, no), draft until R2 | `checkout.abandoned`; subject ref; `after_days:7` | `remind_1h` T +60; `remind_24h` M +24 h; `high_value_task` condition `trigger: data.total_cents gte 30000` then task owner sales +48 h | `order.paid`, `checkout.completed` same subject |

The claim email itself (with the single-use token) is sent by `booking` in the offer transaction, because only that transaction holds the raw token; the automation sends the expiry reminder. A review request never follows a no-show because the trigger is `booking.attended` only and A-27 re-checks the booking status at send time; "at most once per 30 days" is `after_days:30`.

R2 seeds (status `draft` in V1, activated in R2): `webinar-registration` (transactional; `webinar.registered`, anchor `data.starts_at`, subject ref; steps as `event-registration`), and the behaviour journeys in the exclusive `webinar` group, all with `where mode = live` unless named, anchor `data.ends_at`, first step at anchor +60 min: `webinar-cta-click` (priority 10: task owner sales due 1 business day + offer email), `webinar-watched-end` (20), `webinar-watched-30` (30, triggers `webinar.watched_30m` and `webinar.watched_50pct`), `webinar-watched-15` (40), `webinar-attended` (50), `webinar-replay` (55, `webinar.replay_viewed`, mode replay), `webinar-on-demand` (60, mode on_demand), `webinar-no-show` (70, `webinar.no_show`, replay link). `webinar-poll-answer` lives in `sales` (non-exclusive) and only tags (`poll:<poll_key>:<option>`). `waitlist-follow-up` (waitlist group) on `waitlist.expired`: "other dates" email M. B2C playbook (sales group): one automation per stage on `person.b2c_stage_changed` where `data.to = <stage>`, see 3.7.

### 3.7 B2C pipeline (Release 2)

- **A-42** The stage is computed by `ops` (`person_stats.b2c_stage`), never typed. Automations drive stage changes by producing the facts the stage rule reads: tag `engaged` (applied by `welcome-lead` on a click, by webinar journeys on 15 minutes watched) makes a lead `engaged_lead`; bookings, attendance and orders do the rest. `ops` emits `person.b2c_stage_changed { from, to }` when the nightly or on-demand refresh changes it.
- **A-43** Each stage of blueprint 20 has one seeded playbook automation (blueprint 29: required action, owner, deadline, automated and human communication, escalation): `engaged_lead` -> task "Nodig uit voor BEAM Experience" sales, 2 d, escalation `notify_slack` after 4 d if `task_open`; `experienced` -> task "Plan eerste bezoek" sales 2 d; `first_visit` -> handled by `after-first-visit`; `first_purchase` -> task "Welkomstgesprek" customer_service 3 d; `repeat` -> tag `repeat`; `member` -> exit step for `welcome-lead` and `after-first-visit`; `retention` -> task "Reactiveringscall" customer_service 2 d, escalation after 5 d; `lost` -> tag `lost`. KPIs per stage are reported by `ops`.

## 4. Server surface

All files under `apps/web/modules/automation/`. Pure logic lives in `packages/core/src/automation/`; the engine runtime (database work) lives in `apps/web/modules/automation/engine/`.

### 4.1 Server actions (`actions.ts`, all `audience: 'staff'`)

| Action (`name`) | Input (Zod summary) | Output | Permission | Audit action |
| --- | --- | --- | --- | --- |
| `createAutomation` (`automation.create`) | `{ slug, name, description?, groupKey, isMarketing, purpose?, priority?, duplicateOfId? }` | `{ id }` | `automations.write` | `automation.create` |
| `saveDraft` (`automation.save_draft`) | `{ automationId, definition: unknown, name?, description?, groupKey?, priority?, isMarketing?, purpose? }` | `{ issues: DefinitionIssue[] }` (saved even with issues) | `automations.write` | `automation.update_draft` |
| `publishVersion` (`automation.publish`) | `{ automationId, changeNote?, migrateActive: boolean }` | `{ versionId, version, migrationJobId? }` | `automations.publish` | `automation.publish` (+ `automation.migrate_enrolments` when ticked) |
| `activateAutomation` (`automation.activate`) | `{ automationId }` | `{ status }` | `automations.publish` | `automation.activate` |
| `pauseAutomation` (`automation.pause`) | `{ automationId }` | `{ status }` | `automations.publish` | `automation.pause` |
| `resumeAutomation` (`automation.resume`) | `{ automationId }` | `{ status, jobId }` | `automations.publish` | `automation.resume` |
| `archiveAutomation` (`automation.archive`) | `{ automationId, confirmSlug }` (must equal slug) | `{ jobId }` | `automations.publish` | `automation.archive` |
| `exitEnrolment` (`automation.person_exit`) | `{ enrolmentId, note? }` | `{ ok }` | `automations.move_person` | `automation.person_exit` |
| `enrolPerson` (`automation.person_enrol`) | `{ personId, automationId, anchorAt?: iso, subjectKey? }` | `EnrolResult` | `automations.move_person` | `automation.person_enrol` |
| `movePerson` (`automation.person_move`) | `{ personId, fromEnrolmentId, toAutomationId, anchorAt? }` | `{ exitedEnrolmentId, enrolment: EnrolResult }` | `automations.move_person` | `automation.person_move` (one row, old and new slugs) |
| `enrolSegment` (`automation.enrol_segment`) | `{ automationId, segmentId }` | `{ jobId, estimatedCount }` | `automations.publish` | `automation.enrol_segment` |
| `upsertGroup` (R2, `automation.group_upsert`) | `{ id?, key, name, description?, isExclusive, lane?, priority }` | `{ id }` | `automations.publish` | `automation.group_update` |
| `updateAutomationRules` (R2, `automation.rules_update`) | `{ maxMarketingPerDay: 0..10, maxMarketingPerWeek: 0..30, quietStart: 'HH:mm', quietEnd: 'HH:mm', webhookHosts: string[] }` | `{ ok }` | `settings.write` | `automation.rules_update` |
| `saveBuilderGraph` (R4, `automation.save_builder`) | `{ automationId, graph: BuilderGraph }` (converted by `graphToDefinition`, then same path as `saveDraft`) | `{ issues }` | `automations.write` | `automation.update_draft` |

Every staff action writes `audit_log` with old and new values (definitions as `definition_hash` plus version numbers, not the whole JSON). The person-page actions (`exitEnrolment`, `enrolPerson`, `movePerson`) pass `person_id` to the audit row so they show in the person's audit trail (blueprint 56, "automation manually moved/stopped"). After commit the wrapper's `after()` runs the enqueued jobs, so a staff enrol sends the first step within seconds.

### 4.2 Queries (`queries.ts`)

| Query | Input | Output | Permission |
| --- | --- | --- | --- |
| `listAutomations` | `{ status?, groupKey?, q? }` | rows of `automations` + group + `v_automation_stats` | `automations.write` or `reports.read` |
| `getAutomation` | `{ id }` | automation, group, current version, draft, draft issues, stats | same |
| `listVersions` / `getVersion` | `{ automationId }` / `{ versionId }` | versions with author and change note; `getVersion` adds `diffDefinitions(prev, this)` | same |
| `listEnrolments` | `{ automationId, status?, cursor?, limit<=100 }` | enrolments with person first name, last name, next step | same + `persons.read` |
| `listRuns` | `{ automationId?, personId?, outcome?, from?, to?, cursor?, limit<=100 }` | `v_person_automation_timeline` rows | same + `persons.read` |
| `getPersonAutomations` | `{ personId }` | active enrolments with remaining plan, ended enrolments (last 20), runs (last 100) | `persons.read` |
| `previewEnrolment` | `{ personId, automationId, anchorAt? }` | `PreviewStep[]` (A-39) | `persons.read` |
| `listGroups` | `{}` | groups with automation counts | `automations.write` or `reports.read` |
| `getConflictReport` (R2) | `{ days: 7|30 }` | per pair (blocked automation, blocking automation): `skipped_exclusive` count, `superseded` count, sample persons | `automations.publish` |
| `listTemplateOptions` | `{ q? }` | published templates (slug, kind, purpose, locales) via `email.listPublishedTemplates` | `automations.write` |

### 4.3 Route handlers and webhooks

None. The module has no inbound HTTP surface: the tick (`/api/cron/tick`) belongs to `platform`, unsubscribe and preference routes to `email` and `crm`. Outbound webhooks are sent by the `automation.webhook` job (section 6).

### 4.4 Jobs (`jobs.ts`, `defineJob`)

| Kind | Lane, priority | Input | Idempotency key | Retry, timeout | Behaviour |
| --- | --- | --- | --- | --- | --- |
| `automation.evaluate` | fast, 3 | `{}` | `schedule:automation.evaluate:<YYYY-MM-DDTHH:mm>` | `maxAttempts: 2`, 55 s | Locks the `settings` row `automation_cursor` with `FOR UPDATE SKIP LOCKED` (a second evaluator exits at once), processes events (A-8, A-9), then enqueues due steps (A-20). One transaction per 100 events; an event whose processing throws is logged as a `failed` run (reason `evaluate:<message>`, `dedupe_key entry:<automation_id>:<event_id>`) and skipped, so one bad definition cannot stall the cursor. |
| `automation.step` | fast, 2 (transactional automation) or 5 (marketing) | `{ enrolmentId, stepKey }` | `automation:<enrolment_id>:<step_key>` | 6, 30 s; `onDead` writes `failed` and advances (A-35) | A-26 to A-34. |
| `automation.exit_for_suppression` | fast, 1 | `{ suppressionId }` | `supp:<suppression_id>` | 6, 20 s | A-23. |
| `automation.resume` | bulk, 5 | `{ automationId, resumedAt, after? }` | `automation-resume:<automation_id>:<resumed_at ms>:<after or start>` | 6, 60 s | A-29, 500 enrolments per job, enqueues its continuation. |
| `automation.migrate_enrolments` | bulk, 5 | `{ automationId, toVersionId, after? }` | `automation-migrate:<to_version_id>:<after or start>` | 6, 60 s | A-40, 500 per job. |
| `automation.end_enrolments` | bulk, 5 | `{ automationId, reason: 'archived', after? }` | `automation-end:<automation_id>:archived:<after or start>` | 6, 60 s | A-5, 500 per job. |
| `automation.enrol_segment` | bulk, 9 | `{ automationId, segmentId, requestId, after? }` | `automation-enrol-segment:<automation_id>:<segment_id>:<request_id>:<after or start>` | 6, 60 s | Enrols `segment_members` in person-id order, 500 per job, source `segment`, all entry rules apply. |
| `automation.webhook` | fast, 5 | `{ enrolmentId, stepKey }` | `automation-webhook:<enrolment_id>:<step_key>` | 6, 15 s; HTTP 4xx = `PermanentError` | Section 6; writes `webhook_called` on 2xx. |
| `automation.sweep` | bulk, 9 | `{}` | `schedule:automation.sweep:<YYYY-MM-DDTHH:mm>` | 3, 120 s | Completes active enrolments with no next step and no pending plan entry; alerts (`notify.slack`, fingerprint `automation-stuck`) when any enrolment of an active automation is more than 60 minutes past `next_step_at`. |

Every handler passes the double-run test: a second run with the same payload changes nothing (enrolment ended or step already advanced; run rows carry `dedupe_key`).

### 4.5 Schedules (`schedules.ts`, cron in Europe/Brussels)

- `automation.evaluate`: `* * * * *`.
- `automation.sweep`: `45 4 * * *` (after `ops.refresh_person_stats` at 04:00, which emits the inactivity events).

### 4.6 Activity events

The module emits **no** `activity_events` (A-7 prevents feedback loops); `events.ts` exports an empty list. The timeline shows journeys through `automation_runs` via `getTimelineItems`. Event kinds it consumes are listed in section 10.

### 4.7 Cross-module API (`apps/web/modules/automation/api.ts`)

```ts
import type { Tx, DbOrTx } from '@beam/db';
import type { Actor } from '@/lib/ctx';

export type EnrolResult =
  | { status: 'enrolled'; enrolmentId: string }
  | { status: 'skipped'; outcome: 'skipped_exclusive' | 'skipped_unreachable' | 'audience' | 're_entry' | 'inactive' | 'anchor_missing' };

export type AutomationTimelineItem = {
  id: string; occurredAt: Date; automationSlug: string; automationName: string; stepKey: string | null;
  outcome: AutomationRunOutcome; reason: string | null; endReason: string | null;
  emailMessageId: string | null; emailStatus: string | null; taskId: string | null };

export type PersonEnrolmentSummary = {
  enrolmentId: string; automationSlug: string; automationName: string; status: 'active' | 'completed' | 'exited';
  enteredAt: Date; endedAt: Date | null; endReason: string | null; nextStepKey: string | null; nextStepAt: Date | null };

/** Called by crm and email in the same transaction that inserts a suppression (scenario 2). */
export function requestSuppressionExit(tx: Tx, input: { suppressionId: string }): Promise<{ jobId: string | null }>;
/** Called by crm merge (loser, 'merged') and by privacy erase ('erased'). */
export function exitPersonEnrolments(tx: Tx, input: { personId: string; reason: 'erased' | 'merged' | 'manual'; onlyMarketing?: boolean; actor: Actor }): Promise<{ exited: number }>;
/** Enrol into a manual-trigger automation from another module (forms R2 outcomes, site). */
export function enrolPersonBySlug(tx: Tx, input: { slug: string; personId: string; anchorAt?: Date; subjectKey?: string; context?: Record<string, string | number | boolean | null> }): Promise<EnrolResult>;
export function listPersonEnrolments(db: DbOrTx, personId: string): Promise<PersonEnrolmentSummary[]>;
/** Merged into the crm person timeline. */
export function getTimelineItems(db: DbOrTx, personId: string, opts?: { before?: Date; limit?: number }): Promise<AutomationTimelineItem[]>;
export function hasActiveEnrolment(db: DbOrTx, personId: string, slug: string): Promise<boolean>;
/** Read by ops.daily_digest. */
export function countAutomationIssues(db: DbOrTx, since: Date): Promise<{ failed: number; skippedTranslation: number; stuck: number }>;
/** Server component rendered by crm in the person page "Automations" tab. */
export { PersonAutomationsPanel } from './ui/person-automations-panel';
```

## 5. Screens

All staff screens live under `apps/web/app/(admin)/admin/automations/`, use `DataTable` and shadcn components from `@beam/ui`, and render text from the `automation` catalogue in `users.locale`. Loading states are route-level `loading.tsx` skeletons; errors render `error.tsx` with the request id and a Retry button; a missing id renders `not-found.tsx`. Nav entry "Automations" (`nav.ts`) is visible with `automations.write` or `reports.read`.

| Route | Shows | Actions | Empty state | Who |
| --- | --- | --- | --- | --- |
| `/admin/automations` | Table: name, slug, group (with exclusive badge), status, current version, active, entered 7 d, sent 7 d, skipped 7 d, failed 7 d (red when > 0), last run. Filters: status, group, search. | New automation, open row | "No automations yet" with a New button (never shown after seed) | `automations.write` or `reports.read`; New needs `automations.write` |
| `/admin/automations/new` | Form: name, slug (auto from name), group, marketing toggle and purpose, priority, "duplicate from" picker | Create -> redirect to editor | n/a | `automations.write` |
| `/admin/automations/[id]` | Overview: status with Activate / Pause / Resume / Archive, trigger summary in plain words ("When a booking is confirmed for an event"), steps as a vertical list with planned offsets, stats tiles from `v_automation_stats`, latest 20 runs, draft-differs-from-published banner | Activate, Pause, Resume, Archive (type slug to confirm), Enrol segment (segment picker with count), Edit draft | "Draft, not yet published" banner with a link to the editor | view: as list; status buttons and Enrol segment: `automations.publish` |
| `/admin/automations/[id]/edit` | V1 form-based editor over `draft_definition`: trigger card (event kind picker from the registry of event kinds, `where` rows path/operator/value; or segment picker; or manual), anchor picker, audience card, re-entry select, exit-on list, steps list with one form per step type (template picker showing locales and purpose, condition builder with all/any/not, task fields, tag picker, Slack text, webhook URL). Live validation issues beside each field. Tab "JSON" with a code textarea for the same draft. | Save draft, Validate, Publish (dialog: change note, "migrate N active enrolments" checkbox, missing-translation list blocks the button), Preview for a person | New automation starts with one `email` step at +0 | `automations.write`; Publish button `automations.publish` |
| `/admin/automations/[id]/versions` | Versions table (version, published at, by, note); select two to see a JSON diff from `diffDefinitions` | Restore into draft (copies a version's definition into the draft) | "Not published yet" | as list |
| `/admin/automations/[id]/enrolments` | Enrolments: person (link to person page), status, entered, next step and due, end reason; filter by status | Exit (per row), open person | "Nobody enrolled yet" | as list + `persons.read`; Exit `automations.move_person` |
| `/admin/automations/[id]/runs` | Run log: time, person, step, outcome badge (colour per outcome family), reason, email status, task link; filters outcome, date range | Open person, open email message | "No runs in this period" | as list + `persons.read` |
| `/admin/automations/groups` | V1 read-only table of groups (key, exclusive, lane, priority, automations); R2 editable | R2: New group, Edit | n/a (seeded) | view: `automations.write`; edit (R2) `automations.publish` |
| `/admin/automations/rules` (R2) | Frequency caps, quiet hours, webhook host allow-list | Save | n/a | `settings.write` |
| `/admin/automations/conflicts` (R2) | `getConflictReport`: which journeys block or supersede which, counts, sample persons | Open person, open automation | "No conflicts in this period" | `automations.publish` |
| `/admin/automations/[id]/builder` (R4) | Visual workflow builder: vertical flow canvas of blocks (Trigger, Condition, Delay, Branch with two lanes, Send email, Create task, Apply tag, Change status, Add/remove sequence, Notify team member, Update field, Trigger webhook), side panel with the same field forms as the V1 editor, drag to reorder within a lane, validation badges per block | Save (as draft), Publish (same dialog), switch to form editor | New automation shows a Trigger block and a "+" | `automations.write`; Publish `automations.publish` |

**Person page panel** (`PersonAutomationsPanel`, rendered by `crm` in the "Automations" tab of `/admin/persons/[id]`, needs `persons.read`): active journeys with next step and due time; "Preview next steps" drawer (A-39); per-enrolment Exit; "Enrol in..." dialog (automation picker, anchor input when needed, audience warnings); "Move to..." dialog (from enrolment, to automation); ended journeys with end reason; the automation timeline (A-41) with outcome filters. Exit, Enrol and Move are hidden without `automations.move_person`. Empty: "This person is in no journey".

**Customer portal and public screens:** none. Customers control marketing through the preference centre and unsubscribe links owned by `email` and `crm`; the waitlist reminder links to `booking`'s `/[locale]/account/waitlist`.

## 6. Integrations

| Service | Client | Calls | Failure handling | Idempotency |
| --- | --- | --- | --- | --- |
| Generic HTTPS webhook (step type `webhook`) | `packages/integrations/src/webhook/client.ts` (`postWebhook({ url, body, secret }): Promise<{ status: number }>`), `fake.ts` records calls in memory and returns a configurable status | `POST` JSON `{ event: 'automation.step', automation, step_key, enrolment_id, person: { id, first_name, locale, status, tags }, occurred_at }` with headers `X-Beam-Signature: sha256=<HMAC of body with AUTOMATION_WEBHOOK_SECRET>`, `X-Beam-Idempotency-Key: automation-webhook:<enrolment_id>:<step_key>`; 10 s timeout; no redirects followed | 5xx and timeouts retry with the platform backoff; 4xx is `PermanentError` (dead at once); dead -> `failed` run and Slack alert. Each call writes `integration_calls` (provider `webhook`, host only, no body). | Job key plus the idempotency header; receivers deduplicate. |
| Slack | none directly: enqueues the platform job `notify.slack` with `{ text, fingerprint: 'automation:<automation_id>:<step_key>:<enrolment_id>' }` | message text with only `{{first_name}}`, `{{person_url}}` (`/admin/persons/<id>`), `{{automation}}` | owned by `platform` | fingerprint |
| Resend | none directly: `email.queueAutomationEmail` creates the message and the `email.send` job | | owned by `email` | `automation:<enrolment_id>:<step_key>` passed as the message idempotency key |

The webhook payload uses `WEBHOOK_ALLOWED_FIELDS` (`id`, `first_name`, `locale`, `status`, `tags`), declared in `packages/core/src/automation/webhook.ts`; a unit test asserts it contains no `SENSITIVE_COLUMNS` member, no email and no phone. The secret `AUTOMATION_WEBHOOK_SECRET` is a new environment variable listed in `.env.example` by the orchestrator (requested in the package PR).

## 7. Permissions and audit

`permissions.ts` declares `automations.write`, `automations.publish`, `automations.move_person` (the architecture's strings; no new permission). Reading uses `reports.read` or `automations.write`; person data on these screens additionally needs `persons.read`; the rules page uses `settings.write`.

| Role (default set) | What it can do here |
| --- | --- |
| owner, technical_admin, management | everything |
| marketing | create, edit, publish, activate, pause, resume, archive, enrol segments, exit, enrol and move persons, view everything |
| customer_service, sales, reception, finance | view the person-page panel and timeline (`persons.read`); sales, customer_service and finance also see the automation list read-only (`reports.read`); no changes |
| external_partner | nothing |

Customer service has no `automations.move_person` by default; the owner can grant it at `/admin/settings/roles`. Audited actions (`audit_log.action`, entity type `automation`, `automation_enrolment` or `automation_group`): `automation.create`, `automation.update_draft`, `automation.publish`, `automation.migrate_enrolments`, `automation.activate`, `automation.pause`, `automation.resume`, `automation.archive`, `automation.enrol_segment`, `automation.person_exit`, `automation.person_enrol`, `automation.person_move`, `automation.group_update` (R2), `automation.rules_update` (R2). Job-made decisions are not audited (they are in `automation_runs`, whose `actor` is the job). `permissions.test.ts` proves each action is refused without its permission.

## 8. Multi-language and content

- Catalogue namespace `automation` in `packages/core/src/i18n/messages/{en,nl-BE,fr-BE}/automation.json`, keys `automation.<screen>.<element>`: `automation.list.*`, `automation.detail.*`, `automation.editor.*` (one label and help text per trigger, step type, condition predicate, operator and field), `automation.versions.*`, `automation.enrolments.*`, `automation.runs.*`, `automation.groups.*`, `automation.rules.*`, `automation.conflicts.*`, `automation.builder.*`, `automation.panel.*`, `automation.outcome.<outcome>` (all 23 outcomes), `automation.end_reason.<reason>` (all 13 reasons), `automation.issue.<code>` (every validation issue code), `automation.preview.<prediction>`. `en` is the source; `pnpm i18n:check` enforces parity.
- No `LocalizedText` field exists in this module. Automation names, descriptions, task titles and Slack texts are staff-facing and typed by BEAM in one language. Every customer-facing word goes out through `email` templates, which carry the three locales.
- Publish-time completeness (A-3): every template referenced by an email step must have a published version covering `audience.locales` (default `nl-BE`, `fr-BE`, `en`); the publish dialog lists missing locales per template and the action fails with `validation`.
- Send time (A-31): the person's `persons.locale` decides the language; a missing locale is `skipped_translation`, never a fallback; `countAutomationIssues` feeds the daily digest so marketing fixes the template.
- Seed content: `seed.ts` creates the email templates of section 3.6 through `email.seedTemplate` with short placeholder copy in all three locales (subject, preheader, one text block, CTA). BEAM replaces the copy before go-live (content creation is outside the proposal's scope); the seed never overwrites an edited template.

## 9. Privacy

`apps/web/modules/automation/privacy.ts` registers into `GDPR_REGISTRY`:

```ts
export const automationPrivacy = {
  tables: ['automation_enrolments', 'automation_runs'],
  export: (tx, personId) => /* { enrolments: [...], runs: [...] } */,
  erase: (tx, personId) => /* [{ table, rows, action }] */,
};
```

| Table | Person data | Export includes | Erase does | Why |
| --- | --- | --- | --- | --- |
| `automation_enrolments` | `person_id`, `context` (trigger event data), `subject_key` | automation slug and name, version, status, entered, ended, end reason, anchor, plan (keys, due times, states), context | **deleted** (after `exitPersonEnrolments(... 'erased')` has ended active ones in the same transaction) | journey state has no legal retention need |
| `automation_runs` | `person_id`, `reason`, `data` | every run: time, automation, step, outcome, reason, email message id, task id | **deleted** under `SET LOCAL beam.allow_rewrite = 'on'`, before enrolments (FK order) | an append-only log, but it is marketing profile data; the erasure report keeps counts only |
| `automations`, `automation_versions`, `automation_groups` | none (staff user ids only) | not included | untouched | configuration, listed in `NO_PII_TABLES` |

- Order: `automation` erase runs after `email` (whose `email_messages.enrolment_id` is nulled or deleted by `email`) and before `crm` anonymises `persons`. Pending `automation.step` jobs for the erased person find no enrolment and finish as no-ops.
- Aggregate numbers on `/admin/automations` are computed from the tables, so erased people drop out of counts; this is accepted.
- `automation_enrolments.context` never holds sensitive data (A-7). Exports go to the subject only through `ops`'s `privacy.export`; staff exports of runs show ids and outcomes only.
- Retention (rows in `retention_policies`, seeded by `ops`; enforced by `privacy.retention_sweep` calling `purgeAutomationHistory(tx, policy)` exported from `privacy.ts`): `automation_runs` older than 730 days -> delete; `automation_enrolments` with `ended_at` older than 1,095 days -> delete (runs first). `re_entry: never` is therefore "never within three years". Active enrolments are never purged.
- `privacy.test.ts`: after `erase`, no row in either table references the person; `export` returns every enrolment and run; `gdpr-coverage` finds both tables registered.

## 10. Dependencies

### 10.1 What this module needs

| Module | Capability (api.ts function, table, view or event) | Used for |
| --- | --- | --- |
| platform | `enqueue`, `defineJob`, `defineSchedule`, `action()`, `ctx.audit`, `getSetting` / `setSetting` (`automation_cursor`, `automation_rules`), `listActiveStaffByRole(tx, roleKey): Promise<{ userId; name }[]>`, job `notify.slack`, `flag()` | runtime, cursor, task owners, Slack |
| crm | tables `activity_events`, `persons`, `suppressions`, `segment_members`; `applyTag(tx, { personId, tagKey, source: 'automation' })`, `removeTag(tx, { personId, tagKey })`, `createTask(tx, CreateTaskInput): Promise<{ taskId }>`, `setStatusOverride(tx, { personId, status, reason, actor })`, `setPreferredChannel(tx, { personId, channel, actor })`, `findPersonIdsByEmailHash(tx, emailHash): Promise<string[]>`; events `person.created { origin }`, `person.merged`, `person.erased`, `consent.withdrawn { purpose }`, `suppression.added { suppression_id, scope }`, `segment.entered { segment_id }`, `email.clicked` is emitted by email | triggers, exits, steps |
| crm (calls into this module) | `requestSuppressionExit` in every suppression-inserting transaction; renders `PersonAutomationsPanel`; merges `getTimelineItems` into the timeline; calls `exitPersonEnrolments(... 'merged')` on merge | scenario 2, person page |
| email | `queueAutomationEmail(tx, { personId, templateSlug, enrolmentId, idempotencyKey }): Promise<{ status: 'queued' \| 'blocked_translation' \| 'suppressed'; emailMessageId: string \| null; templateVersionId: string }>`, `getPublishedTemplateInfo(db, slugs): Promise<Map<string, { templateVersionId; kind; purpose; locales }>>`, `listPublishedTemplates(db, q?)`, `seedTemplate(tx, SeedTemplateInput)`; view `v_marketing_reachability`; `email_messages.enrolment_id`; events `email.clicked`, `email.opened`; `requestSuppressionExit` call from its unsubscribe, preference and complaint paths | email steps, scenario 2 |
| booking | view `v_person_bookings`, table `bookings` (status of the trigger booking); events `booking.confirmed { session_kind, starts_at, is_first_booking }`, `booking.cancelled`, `booking.attended { is_first_visit }`, `booking.no_show`, `waitlist.offered { offer_expires_at }`, `waitlist.confirmed`, `waitlist.expired`, `waitlist.released`, `waitlist.withdrawn` | triggers, conditions |
| credits | views `v_person_status`, `v_person_credits`; table `memberships`; events `credits.threshold_reached { pct, credit_kind, grant_id }`, `membership.activated`, `membership.renewal_due { days }`, `membership.renewed`, `membership.cancelled` | package, membership journeys |
| commerce | events `order.paid { product_kinds }`, `checkout.abandoned { total_cents }`, `checkout.completed`; R2 `markCheckoutRecoveryMessage(tx, { checkoutId, emailMessageId })` | exits, abandoned checkout |
| ops | events `person.inactive_days { days }`, R2 `person.b2c_stage_changed { from, to }` with the `engaged` tag in the stage rule; retention rows for section 9; reads `countAutomationIssues` for the digest | inactivity, B2C pipeline |
| webinar (R2) | events `webinar.registered { starts_at, ends_at }`, `webinar.attended`, `webinar.watched_15m`, `webinar.watched_30m`, `webinar.watched_50pct`, `webinar.watched_to_end`, `webinar.replay_viewed`, `webinar.on_demand_viewed`, `webinar.poll_answered { poll_key, option }`, `webinar.cta_clicked { cta_key }`, `webinar.no_show`, each with `mode` | webinar journeys |
| crm (R3) | event `opportunity.stage_changed { from, to, owner_user_id }` | B2B follow-up tasks |

Event data fields named above are the minimum this module reads; the owning module defines them in its `events.ts`. Until an owner lands, tests insert `activity_events` rows directly with factories.

### 10.2 What this module provides

`requestSuppressionExit` (crm, email), `exitPersonEnrolments` (crm merge, ops privacy), `enrolPersonBySlug` (forms, site, webinar), `listPersonEnrolments`, `getTimelineItems`, `PersonAutomationsPanel` (crm), `hasActiveEnrolment` (ops retention lists, to hide people already in a reactivation journey), `countAutomationIssues` (ops digest), `GDPR_REGISTRY` entry and `purgeAutomationHistory` (ops), and the `automation_runs` table for the timeline and `email_messages.enrolment_id` attribution (ops R3).

## 11. Edge cases and failure modes

| # | Case | Decided behaviour |
| --- | --- | --- |
| 1 | Two ticks overlap and both start `automation.evaluate` | The second fails to get `FOR UPDATE SKIP LOCKED` on the cursor row and returns at once; the job keys per minute also prevent duplicates. |
| 2 | A transaction commits event 105 before event 104 becomes visible | 104 is recorded as a gap and re-read on the next passes; it is processed when it appears, or dropped after 10 minutes (rolled back). |
| 3 | The same event is processed twice (gap re-read, retry) | `uq_enrolment_trigger` rejects the second enrolment (`on conflict do nothing`); exits find no active enrolment; run `dedupe_key` rejects duplicate log rows. |
| 4 | An event both exits and triggers for the same person (purchase ends lead nurture and starts nothing, attended ends `welcome-lead` and starts `after-first-visit`) | Exits run first (A-9), so the domain is free and the new journey enrols without `superseded`. |
| 5 | A person attends a webinar and the 15-, 30-minute and end events arrive in one batch | Processed in id order; each higher-priority journey supersedes the previous before its first step (anchor +60 min) is due; the timeline shows `entered` and `exited: superseded` for each. |
| 6 | Unsubscribe arrives while `automation.step` for that person is running | Both lock the enrolment row; whichever runs second sees the other's result. If the step already queued the email, `email.send` sees the suppression and marks the message `suppressed`. |
| 7 | A marketing step is due but the person withdrew `newsletter` consent without a suppression | The built-in `consent.withdrawn` exit ends marketing journeys with that purpose; any remaining marketing step in a transactional journey is `skipped_unreachable`. |
| 8 | The template lacks the person's locale (French template missing for an `fr-BE` person) | `skipped_translation`, the journey continues with the next step, the daily digest counts it; nothing is sent in another language. |
| 9 | A template referenced by an active automation is archived | Publish validation prevents new versions with it; at send time no published version exists -> `failed` with reason `template_unavailable` and an alert; the journey continues. |
| 10 | The anchor moves (the event session is rescheduled) | Running enrolments keep their planned times; `booking` emits `booking.cancelled` + `booking.confirmed` for a moved booking, so `event-registration` exits and re-enters with the new anchor (subject-scoped, `always`). |
| 11 | The automation is paused for 3 days, then resumed | During the pause no step runs and no one enrols; exits still apply. On resume, time-sensitive steps more than 24 h overdue are `skipped_paused`; later steps run on time. |
| 12 | The platform was down 30 hours (no ticks) | Email, Slack and webhook steps more than 24 h late are `skipped_stale`; tasks and tags still apply; the sweep alerts on the backlog. |
| 13 | Staff publish v2 while 400 people are in v1 without ticking migrate | v1 enrolments run to the end on v1; new entries use v2; the enrolments screen shows the version per row. |
| 14 | A migrated enrolment's v2 renamed a step key | The renamed step counts as new: if its due time is past it is `skipped_late_entry` (reason `migrated`), otherwise it runs. Keys are the identity of a step; the editor warns when a key changes on an automation with active enrolments. |
| 15 | A `task` step's role has no active staff user | The owner falls back to the active `management` user with the fewest open tasks, then to an `owner`; run `task_created` with reason `owner_fallback:<role>`. With no staff at all the step is `failed` (`no_staff_user`). |
| 16 | An `enrol` step points at an automation that is paused or archived | Entry refused: run on the source enrolment is `skipped_condition` with reason `target_inactive:<slug>`; journeys never chain into dead ones. |
| 17 | Two automations `enrol` each other | Allowed only through re-entry rules; `never` or `after_days` stop loops. Validation refuses an `enrol` step targeting an automation whose `re_entry` is `always` and which itself enrols back (direct cycle). |
| 18 | The person is merged while enrolled | The loser's active enrolments exit `merged`; the winner keeps its own; history stays on the loser id and `crm` shows merged persons' timelines on the winner. |
| 19 | The person is erased while a step job is queued | The erase deletes enrolments and runs; the job loads no enrolment and succeeds as a no-op; `email.send` refuses erased persons. |
| 20 | A staff member enrols someone into a marketing journey who is unsubscribed | Enrolment succeeds (staff override of entry rules) but every marketing step is `skipped_unreachable`; the dialog warns before confirming. Consent can never be bypassed. |
| 21 | A segment of 20,000 people is enrolled at once | `automation.enrol_segment` on the bulk lane, 500 per job; first steps spread over about 40 ticks; marketing sends stay subject to the R2 frequency cap and the email warm-up limits owned by `email`. |
| 22 | A definition with an invalid `where` path is published | Paths are validated against a typed list of known event data paths when the kind is in the event registry; unknown kinds or paths produce a warning (not an error) so new events from other modules work; at run time a missing path simply does not match. |
| 23 | A person with an existing future booking reaches 30 days inactivity | `d30` is `skipped_condition` with reason `unless:has_future_booking`. |
| 24 | A grant hits 90 % and the customer buys a new package the same day | `order.paid:package` exits `package-usage`; if the 90 % email was not yet sent it never goes; if it was, nothing follows. |
| 25 | `booking.attended` is later corrected to `no_show` by staff before the review request is sent | `booking.no_show` with the same subject exits the enrolment; the send-time `booking_status_in` check catches it even if the exit event is late. |

## 12. Build packages

Every package works in its own worktree on `build/<id>`, never edits `package.json`, the lockfile, migrations or `registry/*.generated.ts`, and finishes with `pnpm typecheck`, `pnpm lint` and its Vitest suites green (integration suites use `createTestDb()` and the Wave 0 factories; external services only through `fake.ts`). Files shared between two packages are edited strictly in the order given (the later package depends on the earlier one, so they are never in the same wave).

### automation-P1 (V1): schema and pure engine core

- **Goal:** all tables, enums, constraints and views of section 2; the definition schema and every pure function the engine needs.
- **Files:** `packages/db/src/schema/automation.ts` (completes the Wave 0 stub; adds columns, never renames contract columns), `packages/db/src/schema/automation.views.ts`, `packages/core/src/automation/{index.ts, definition.ts, filter.ts, conditions.ts, plan.ts, time.ts, exclusivity.ts, re-entry.ts, exits.ts, validate.ts, diff.ts, webhook.ts}`.
- **Interfaces:**
  ```ts
  export const AutomationDefinition: z.ZodType<Definition>;
  export function parseDefinition(json: unknown): { ok: true; value: Definition } | { ok: false; issues: DefinitionIssue[] };
  export function validateDefinition(def: Definition, ref: ValidationRefs): DefinitionIssue[]; // A-1, A-3, A-4
  export function matchesFilter(where: Filter | undefined, ev: EventView): boolean;              // A-10
  export function matchesExit(exitOn: Definition['exit_on'], ev: EventView, subjectKey: string): boolean; // A-22
  export function planSteps(def: Definition, input: { enteredAt: Date; anchorAt: Date | null }): PlannedStep[]; // A-17, A-18
  export function nextStep(def: Definition, plan: PlannedStep[], fromKey: string, branch?: { target: string | 'end' }, now?: Date): { plan: PlannedStep[]; next: PlannedStep | null };
  export function evaluateCondition(c: Condition, facts: PersonFacts, scope: ConditionScope): { result: boolean; predicate: string };
  export function resolveExclusivity(candidate: Rank, active: (Rank & { enrolmentId: string }) | null): 'enrol' | 'supersede' | 'skip'; // A-15
  export function canReEnter(policy: Definition['re_entry'], h: { lastEnteredAt: Date | null; hasActive: boolean; everEntered: boolean }, now: Date): boolean;
  export function overdueOutcome(type: StepType, dueAt: Date, now: Date, pausedDuring: boolean): 'run' | 'skipped_paused' | 'skipped_stale'; // A-28
  export function brusselsAt(day: Date, hhmm: string): Date;                                     // DST-safe, Intl only
  export function diffDefinitions(a: Definition, b: Definition): DefinitionChange[];
  export const WEBHOOK_ALLOWED_FIELDS: readonly ['id', 'first_name', 'locale', 'status', 'tags'];
  ```
- **Depends on:** Wave 0 (`_shared.ts` helpers; `crm` contract tables `persons`, `activity_events`; `email:email_messages`; `crm:tasks` stub).
- **Tests:** `packages/core/src/automation/plan.test.ts` (A-17, A-18: Friday 10:00 registration for Sunday 10:00 event skips `reminder_7d` and `reminder_3d`, keeps `confirm` and `reminder_day_of`; `send_now`; `previous` never late; `snap_to` across the October and March DST changes; branch re-planning), `filter.test.ts` (each operator, missing paths), `conditions.test.ts` (every predicate with all/any/not), `exclusivity.test.ts` (lower wins, equal keeps existing, empty domain), `re-entry.test.ts`, `exits.test.ts` (qualifiers, `same_subject`), `validate.test.ts` (each issue code, cycle in enrol, backward branch), `definition.test.ts` (strict keys, round trip), `webhook.test.ts` (no `SENSITIVE_COLUMNS`, no email or phone), `packages/db/src/schema/automation.test.ts` (createTestDb: the three partial unique indexes, the check constraints, view queries return rows).
- **Done:** typecheck, lint, tests green; `packages/core/src/automation` coverage above 90 %.

### automation-P2 (V1): evaluator, enrolment, exits and fast unsubscribe

- **Goal:** `automation.evaluate` with the gap-safe cursor, enrolment under the person lock with audience, re-entry, reachability and exclusivity, built-in and `exit_on` exits, `automation.exit_for_suppression`, privacy registration and the read side of `api.ts`.
- **Files:** `apps/web/modules/automation/engine/{cursor.ts, evaluate.ts, enrol.ts, exits.ts, runs.ts}`, `apps/web/modules/automation/{jobs.ts, schedules.ts, events.ts, permissions.ts, privacy.ts, api.ts}`.
- **Interfaces:** `evaluateBatch(tx: Tx, now: Date): Promise<{ processed: number; enrolled: number; exited: number; dueEnqueued: number }>`; `enrol(tx: Tx, input: EnrolInput): Promise<EnrolResult>`; `endEnrolment(tx: Tx, enrolmentId: string, outcome: 'exited' | 'completed', reason: string, actor: Actor): Promise<boolean>`; `writeRun(tx: Tx, row: NewRun): Promise<void>` (on conflict on `dedupe_key` do nothing); the api.ts functions of section 4.7 except `PersonAutomationsPanel`; jobs `automation.evaluate`, `automation.exit_for_suppression`; schedule `automation.evaluate`.
- **Depends on:** automation-P1; `crm:activity_events`, `crm:persons`, `crm:suppressions`, `crm:segment_members`, `crm:findPersonIdsByEmailHash`, `credits:v_person_status`, `email:v_marketing_reachability`, `platform:getSetting/setSetting`.
- **Tests:** `engine/evaluate.test.ts` (A-7 to A-10, cursor gaps: insert ids out of order with two connections simulated by explicit ids; batch limits; one throwing definition does not stall), `engine/enrol.test.ts` (A-11 to A-19: erased and merged refused, audience, re-entry, unreachable, exclusivity supersede and skip, anchor missing, all-past anchor completes), `engine/exits.test.ts` (A-21, A-22, A-25, order of A-9), `scenario-2-unsubscribe.test.ts` (suppression inserted -> `requestSuppressionExit` -> job ends marketing journeys with `unsubscribed`, transactional journey keeps running, total under 1 s of job time), `jobs.test.ts` (each job twice, same state), `privacy.test.ts` (export complete, erase leaves no rows).
- **Done:** typecheck, lint, suites green.

### automation-P3 (V1): step execution, bulk jobs and webhook client

- **Goal:** `automation.step` with all 12 step types and the send-time checks, branching, overdue rules, and the bulk jobs `resume`, `migrate_enrolments`, `end_enrolments`, `enrol_segment`, `sweep`, plus `automation.webhook`.
- **Files:** `apps/web/modules/automation/engine/{facts.ts, step.ts, advance.ts, bulk.ts, webhook.ts}`, `packages/integrations/src/webhook/{client.ts, fake.ts}`; edits `apps/web/modules/automation/jobs.ts` and `schedules.ts` (strictly after automation-P2).
- **Interfaces:** `loadFacts(tx: Tx, personId: string, needs: FactNeeds): Promise<PersonFacts>`; `runStep(tx: Tx, input: { enrolmentId: string; stepKey: string; now: Date }): Promise<RunStepResult>`; `postWebhook(input: { url: string; body: unknown; secret: string; idempotencyKey: string }): Promise<{ status: number }>`.
- **Depends on:** automation-P2; `email:queueAutomationEmail`, `email:getPublishedTemplateInfo`, `crm:applyTag/removeTag/createTask/setStatusOverride/setPreferredChannel`, `platform:listActiveStaffByRole`, `platform:notify.slack`, `booking:v_person_bookings`, `credits:v_person_credits`, `credits:memberships`.
- **Tests:** `engine/step.test.ts` (A-26 order of checks, each step type's outcome, A-31 unreachable and translation, A-33 owner selection and fallback, A-34 branching, A-35 dead handling), `engine/overdue.test.ts` (A-28, A-29 resume), `engine/bulk.test.ts` (migration keeps done steps, archive ends all, segment enrol chunking and continuation keys), `engine/webhook.test.ts` (signature, 4xx permanent, 5xx retry, payload allow-list), additions to `jobs.test.ts` for every new job.
- **Done:** typecheck, lint, suites green.

### automation-P4 (V1): seeded groups, sequences and templates

- **Goal:** the 11 groups and every sequence of section 3.6 (V1 ones `active`, R2 ones `draft` with a published version), their templates in three locales through `email.seedTemplate`; seed is idempotent and never overwrites edited rows.
- **Files:** `packages/core/src/automation/seeds/{index.ts, groups.ts, lead.ts, booking.ts, customer.ts, package.ts, inactivity.ts, membership.ts, review.ts, waitlist.ts, checkout.ts, webinar.ts}`, `packages/db/src/seed/automation.ts`, `apps/web/modules/automation/seed.ts`.
- **Interfaces:** `export const SEED_GROUPS: SeedGroup[]`; `export const SEED_AUTOMATIONS: SeedAutomation[]` (`{ slug, name, groupKey, priority, isMarketing, purpose, status, definition, templates: SeedTemplateInput[] }`); `seedAutomation(tx: Tx): Promise<{ groups: number; automations: number; templates: number }>`.
- **Depends on:** automation-P3; `email:seedTemplate`.
- **Tests:** `seeds/seeds.test.ts` (every seed parses and validates against its templates; slugs unique; V1 active, R2 draft), `apps/web/modules/automation/seeded-journeys.test.ts` (scenario 1 with the real `event-registration` seed end to end through evaluate and step jobs; `welcome-lead` exits on `order.paid`; `after-first-visit` after attendance; package 90 % email not sent after `order.paid:package`; inactivity skipped with a future booking; review request never after no-show and once per 30 days; `waitlist-offer` exits on `waitlist.confirmed`; reseed changes nothing).
- **Done:** typecheck, lint, suites green; `pnpm seed` on a fresh `createTestDb()` loads the module seed.

### automation-P5 (V1): admin screens, actions and queries

- **Goal:** every V1 admin screen of section 5 except the person panel; the actions and queries of sections 4.1 and 4.2 marked V1 except the person controls; navigation and the `automation` catalogue.
- **Files:** `apps/web/modules/automation/{actions.ts, queries.ts, nav.ts}`, `apps/web/modules/automation/ui/{automation-table.tsx, status-controls.tsx, definition-editor.tsx, trigger-card.tsx, step-forms.tsx, condition-builder.tsx, publish-dialog.tsx, version-diff.tsx, run-log.tsx, outcome-badge.tsx}`, `apps/web/app/(admin)/admin/automations/{page.tsx, loading.tsx, error.tsx, new/page.tsx, groups/page.tsx, [id]/{page.tsx, not-found.tsx, edit/page.tsx, versions/page.tsx, enrolments/page.tsx, runs/page.tsx}}`, `packages/core/src/i18n/messages/{en,nl-BE,fr-BE}/automation.json`, `e2e/automation.spec.ts`.
- **Interfaces:** actions `createAutomation`, `saveDraft`, `publishVersion`, `activateAutomation`, `pauseAutomation`, `resumeAutomation`, `archiveAutomation`, `enrolSegment`; queries `listAutomations`, `getAutomation`, `listVersions`, `getVersion`, `listEnrolments`, `listRuns`, `listGroups`, `listTemplateOptions`.
- **Depends on:** automation-P4; `email:listPublishedTemplates`; `crm:segments`.
- **Tests:** `actions.test.ts` (publish increments version and refuses an unchanged hash; missing locale blocks publish; pause/resume enqueue; archive enqueues `end_enrolments`; migrate checkbox enqueues migration; audit rows written), `permissions.test.ts` (every action refused without its permission), `e2e/automation.spec.ts` (marketing user edits a seeded journey's step offset in the form editor, publishes v2, pauses and resumes, opens the run log).
- **Done:** typecheck, lint, suites green, `pnpm i18n:check` green, e2e passes against `beam_dev`.

### automation-P6 (V1): person page controls, preview and timeline

- **Goal:** the person-page panel with exit, enrol, move, preview and the automation timeline (A-36 to A-41), and the V1 acceptance spec for scenario 1.
- **Files:** edits `apps/web/modules/automation/actions.ts` and `queries.ts` (strictly after automation-P5) and `api.ts` (strictly after automation-P2); creates `apps/web/modules/automation/ui/{person-automations-panel.tsx, enrol-dialog.tsx, move-dialog.tsx, preview-drawer.tsx, automation-timeline.tsx}`, `apps/web/modules/automation/engine/preview.ts`, `e2e/scenario-1-late-entry.spec.ts`, `e2e/automation-person.spec.ts`.
- **Interfaces:** actions `exitEnrolment`, `enrolPerson`, `movePerson`; queries `getPersonAutomations`, `previewEnrolment`; `previewSteps(tx: DbOrTx, input: { personId: string; automationId: string; anchorAt?: Date; now: Date }): Promise<PreviewStep[]>`; `export { PersonAutomationsPanel }` from `api.ts` with props `{ personId: string }`.
- **Depends on:** automation-P5; `crm:person page` renders the panel (crm adds the tab in its own package; until then the e2e opens the panel through the crm route when present, else skips with a message).
- **Tests:** `person-controls.test.ts` (exit writes `manual` and one audit row; enrol overrides re-entry and exclusivity with `moved`; move is one transaction and one audit row; staff enrol into marketing journey of an unsubscribed person sends nothing), `engine/preview.test.ts` (predictions match what the step job does for the same facts; preview writes no rows), `e2e/scenario-1-late-entry.spec.ts` (create an event session for Sunday 10:00, book it on Friday 10:00 with a frozen clock, run ticks, assert the timeline shows `entered`, `sent` for `confirm`, `skipped_late_entry` for `reminder_7d` and `reminder_3d`, and later `sent` for `reminder_day_of` in the email sink), `e2e/automation-person.spec.ts` (staff moves a person from `welcome-lead` to `after-first-visit`).
- **Done:** typecheck, lint, suites green, both e2e specs pass against `beam_dev`.

### automation-P7 (R2): automation conflict rules

- **Goal:** BEAM-editable groups, lanes and priorities, frequency caps and quiet hours (A-32), the webhook host allow-list editor and the conflict report.
- **Files:** creates `apps/web/app/(admin)/admin/automations/{rules/page.tsx, conflicts/page.tsx}`, `apps/web/modules/automation/ui/{group-form.tsx, rules-form.tsx, conflict-report.tsx}`, `packages/core/src/automation/frequency.ts`; edits (strictly after automation-P6) `actions.ts`, `queries.ts`, `apps/web/app/(admin)/admin/automations/groups/page.tsx`, the three `automation.json` catalogues, and (strictly after automation-P3) `engine/step.ts`.
- **Interfaces:** actions `upsertGroup`, `updateAutomationRules`; query `getConflictReport`; `applyFrequencyRules(input: { now: Date; recentMarketingSends: Date[]; rules: AutomationRules }): { action: 'send' } | { action: 'defer'; until: Date } | { action: 'skip' }`.
- **Depends on:** automation-P6; `platform:settings` key `automation_rules`; `email:email_messages` (recent automation marketing sends per person).
- **Tests:** `packages/core/src/automation/frequency.test.ts` (day and week caps, quiet hours across midnight and DST), `engine/step-frequency.test.ts` (`skipped_frequency_cap`, deferral writes a new `scheduled` row, transactional exempt), `actions.test.ts` cases for the new actions and audit rows, `permissions.test.ts` cases, `conflicts.test.ts` (report counts `skipped_exclusive` and `superseded` pairs).
- **Done:** typecheck, lint, suites green.

### automation-P8 (R2): webinar, checkout, waitlist and B2C pipeline journeys

- **Goal:** activate the R2 sequences of section 3.6 and add the B2C playbook automations of section 3.7; link abandoned-checkout messages to `checkouts.recovery_message_id`.
- **Files:** creates `packages/core/src/automation/seeds/b2c.ts`, `apps/web/modules/automation/seeded-journeys-r2.test.ts`; edits (strictly after automation-P4) `packages/core/src/automation/seeds/{index.ts, webinar.ts, checkout.ts, waitlist.ts}` and `packages/db/src/seed/automation.ts`; edits (strictly after automation-P7) `engine/step.ts` for the recovery link.
- **Interfaces:** `activateReleaseSequences(tx: Tx, release: 'R2' | 'R3'): Promise<{ activated: string[] }>` (activates seeded drafts of that release whose `activated_at` is null, so a journey BEAM switched off stays off).
- **Depends on:** automation-P7; `webinar:events` (section 10.1), `commerce:markCheckoutRecoveryMessage`, `ops:person.b2c_stage_changed`.
- **Tests:** `seeded-journeys-r2.test.ts` (webinar registration Friday for Sunday skips the 7-day and 3-day reminders; attended then watched-to-end supersedes `webinar-attended`; replay events never trigger live journeys (scenario 5 separation); no-show journey only for `webinar.no_show`; CTA click creates a sales task; abandoned checkout stops on `order.paid` and writes the recovery message id; stage `engaged_lead` creates the playbook task and escalates after 4 days when the task is still open; activation is idempotent and respects deactivated journeys).
- **Done:** typecheck, lint, suites green; `e2e/scenario-5-replay-separation.spec.ts` (owned by webinar) still green.

### automation-P9 (R3): B2B follow-up task journeys

- **Goal:** seeded task-only journeys on `opportunity.stage_changed` (`b2b-qualified`: discovery call task owner sales due 2 d; `b2b-proposal`: follow-up task 5 d after `proposal`, escalation Slack after 10 d if open; `b2b-won`: account-management task 7 d) and `b2b` purpose support in the editor's purpose select.
- **Files:** creates `packages/core/src/automation/seeds/b2b.ts`, `apps/web/modules/automation/seeded-journeys-r3.test.ts`; edits (strictly after automation-P8) `seeds/index.ts`; edits (strictly after automation-P7) `ui/definition-editor.tsx` and the three `automation.json` catalogues.
- **Interfaces:** none new; `activateReleaseSequences(tx, 'R3')`.
- **Depends on:** automation-P8; `crm:opportunity.stage_changed` (R3).
- **Tests:** `seeded-journeys-r3.test.ts` (each stage creates its task with the opportunity owner when present, else the sales role; no email step exists in any B2B journey; escalation only when the task is open).
- **Done:** typecheck, lint, suites green.

### automation-P10 (R4): visual workflow builder

- **Goal:** `/admin/automations/[id]/builder`, a visual editor over the same JSON with the twelve blocks of blueprint 51; no new engine and no new npm dependency (plain React, Tailwind and native drag and drop).
- **Files:** creates `packages/core/src/automation/builder.ts`, `apps/web/app/(admin)/admin/automations/[id]/builder/page.tsx`, `apps/web/modules/automation/ui/builder/{canvas.tsx, block.tsx, block-palette.tsx, side-panel.tsx, branch-lane.tsx}`, `e2e/automation-builder.spec.ts`; edits (strictly after automation-P9) `actions.ts` (`saveBuilderGraph`), `ui/definition-editor.tsx` (link to the builder), the three `automation.json` catalogues.
- **Interfaces:** `definitionToGraph(def: Definition): BuilderGraph`; `graphToDefinition(g: BuilderGraph): { ok: true; value: Definition } | { ok: false; issues: DefinitionIssue[] }`; block mapping: Trigger -> `trigger`, Condition -> `unless` or `condition`, Delay -> `wait`, Branch -> `condition` with `then`/`else`, Send email -> `email`, Create task -> `task`, Apply tag -> `tag`/`untag`, Change status -> `status_override`, Add/remove sequence -> `enrol`/`exit`, Notify team member -> `notify_slack`, Update field -> `set_field`, Trigger webhook -> `webhook`.
- **Depends on:** automation-P9.
- **Tests:** `packages/core/src/automation/builder.test.ts` (round trip `graphToDefinition(definitionToGraph(d))` equals `d` for every seeded definition; branch lanes produce forward targets only; invalid graphs return issues), `e2e/automation-builder.spec.ts` (build trigger -> delay -> branch -> email and task, publish, enrol a test person, see the run log).
- **Done:** typecheck, lint, suites green, e2e passes against `beam_dev`.

## 13. Decisions made

Additions to the architecture (tables, columns, enum values, settings keys):

1. `automation_groups.lane` (text, null): groups sharing a lane form one exclusivity domain. Seeded lane `sales_journey` joins `customer_journey` (10), `webinar` (20), `waitlist` (25) and `lead_nurture` (30), so lead, customer, waitlist and webinar sales journeys never run at the same time (blueprint 21), while the architecture's per-group rule still holds when `lane` is null.
2. Extra seeded groups `review`, `sales`, `checkout` (non-exclusive), so review requests, task-only journeys and checkout recovery neither block nor supersede sales journeys.
3. `automations.priority`, `draft_definition`, `draft_updated_at`, `draft_updated_by_user_id`, `activated_at`, `paused_at`, `last_resumed_at`. Drafts live on the automation, so every `automation_versions` row is a published, immutable version.
4. `automation_versions.definition_hash` and `change_note`.
5. `automation_enrolments.subject_key`, `group_id`, `exclusive_domain`, `source`, `trigger_event_id`, `plan`, `entered_by_user_id`, `migrated_from_enrolment_id`. The architecture's partial unique `(automation_id, person_id) where active` is widened to `(automation_id, person_id, subject_key)`; with `subject_key = ''` it is the same rule. Without it a person registered for two events would get only one confirmation.
6. Two more partial unique indexes: one active enrolment per person per exclusive domain, and one enrolment per `(automation_id, trigger_event_id)` (idempotent re-reading).
7. `automation_runs.automation_version_id`, `data`, `actor`, `dedupe_key`; `enrolment_id` nullable for entry decisions that create no enrolment.
8. Outcome values added: `tag_removed`, `status_set`, `enrolled`, `notified`, `webhook_called` (one per step type that the architecture's list lacked), `skipped_stale` (overdue after an outage, not a pause), `skipped_frequency_cap` (R2).
9. `settings` key `automation_rules` = `{ max_marketing_per_day: 1, max_marketing_per_week: 3, quiet_start: '21:00', quiet_end: '08:00', webhook_hosts: [] }`; `settings.automation_cursor` = `{ last_event_id, gaps: [{ id, first_seen_at }] }`.
10. Views `v_automation_stats`, `v_automation_due`, `v_person_automation_timeline`.
11. New environment variable `AUTOMATION_WEBHOOK_SECRET` and a new integrations client `packages/integrations/src/webhook/` with `fake.ts`.

Engine choices:

12. Gap-safe cursor: missing identity ids are remembered and re-read for 10 minutes, because identity values commit out of order; idempotent enrolment makes re-reading safe.
13. Fixed per-event order: built-in exits, `exit_on` exits, then triggers by priority. Built-in exits (erased, merged, suppression, consent withdrawal) apply even when a definition forgets them.
14. Late-entry skip applies only to steps timed from the enrolment or the anchor; steps timed from the previous step are never late. `late_entry: send_now` exists for steps that must still go (first-visit preparation).
15. `event-registration` reminders are 7 days, 3 days and 3 hours before the start (no 1-day reminder), so a Friday registrant for a Sunday event receives exactly the confirmation and the day-of reminder, as the proposal states for scenario 1. In V1 scenario 1 runs on event sessions (`booking.confirmed` of kind `event`), because the native webinar is Release 2; the same journey shape is seeded as `webinar-registration` for R2.
16. Overdue rule: communication steps more than 24 hours late are skipped (`skipped_paused` or `skipped_stale`); tasks, tags and field changes still apply.
17. A paused automation still processes exits, so an unsubscribe ends a paused journey too.
18. Conditions are evaluated on fresh facts at step time; nothing is cached at entry except the trigger context.
19. Templates are resolved at send time to their current published version, so marketing fixes a typo without republishing the journey; `email_messages.template_version_id` keeps history exact.
20. Reachability is per step by the template's kind and purpose; an automation's `is_marketing` and `purpose` decide the entry check and which suppressions and consent withdrawals end it.
21. Failed audience and re-entry checks are not logged (noise); `skipped_exclusive`, `skipped_unreachable` at entry and `failed` (anchor missing) are logged with `enrolment_id` null.
22. Staff enrol and move override re-entry, audience and exclusivity (a blocking journey exits `moved`) but never consent or suppression.
23. Task owner: active staff user of the role with the fewest open tasks, then `management`, then `owner`.
24. Webhook payloads carry only `WEBHOOK_ALLOWED_FIELDS`, signed with HMAC SHA-256, https only, hosts on an allow-list editable with `settings.write`.
25. Slack texts may only use `{{first_name}}`, `{{person_url}}`, `{{automation}}`; no email, phone or sensitive data leaves through Slack.
26. The module emits no `activity_events`; the timeline reads `automation_runs`, and the evaluator ignores `automation.*` kinds, which rules out feedback loops.
27. Names, task titles and Slack texts are plain staff-facing text, not `LocalizedText`; every customer-facing word is in an email template.
28. Read access to automation screens uses `reports.read` or `automations.write`; pause, resume, activate, archive and segment enrolment need `automations.publish`; the rules page needs `settings.write`. No new permission strings.

Release and content choices:

29. Group exclusivity and priority are enforced by the engine in V1 (needed so V1 journeys do not contradict each other); the proposal's Release 2 item "automation conflict rules" ships as the editable groups, frequency caps, quiet hours and the conflict report.
30. R2 journeys (webinar set, `abandoned-checkout`, `waitlist-follow-up`) are seeded in V1 as `draft` with a published version and switched on by `activateReleaseSequences` in automation-P8; a journey BEAM deactivated is never re-activated by a seed.
31. The waitlist claim email with the single-use token is sent by `booking`, which alone holds the raw token; the automation sends the 30-minute expiry reminder linking to the portal waitlist page.
32. `review-request` is a marketing journey with purpose `newsletter` (conservative reading of ePrivacy); BEAM can change the purpose in the editor. The trigger is `booking.attended` only, re-entry `after_days:30`, and the booking status is re-checked at send time.
33. Package usage covers 50, 75, 80, 90 % and the last unit (blueprint 21 and 31 combined): emails at 50, 75, 90 and last, a tag at 80; every step stops on repurchase (`order.paid:package` exit plus `has_other_active_grant`).
34. B2C pipeline: the stage stays computed by `ops`; automations drive changes by producing the facts (tag `engaged`, bookings, orders) and react to `person.b2c_stage_changed` with one playbook journey per stage (task, owner, deadline, escalation).
35. B2B journeys in R3 create tasks and Slack messages only; automated B2B outbound email is "Later".
36. The R4 builder is a vertical flow editor built without a graph library, so no dependency request is needed.
37. Retention: runs 730 days, ended enrolments 1,095 days (aligned with the 3-year marketing profile rule); `re_entry: never` means never within that window.
38. Seed copy for every template is placeholder text in nl-BE, fr-BE and en, replaced by BEAM before go-live; seeds never overwrite edited rows.
39. Requirements placed on other modules (recorded in their PRs): `crm` emits `person.created { origin }`, `segment.entered`, `suppression.added`, calls `requestSuppressionExit` in every suppression transaction and renders `PersonAutomationsPanel`; `booking` emits `booking.confirmed` with `session_kind`, `starts_at`, `is_first_booking`, `booking.attended` with `is_first_visit`, and models a reschedule as cancel plus confirm; `ops` emits `person.inactive_days` and `person.b2c_stage_changed` and seeds the two retention rows; `email` exposes `queueAutomationEmail`, `getPublishedTemplateInfo`, `listPublishedTemplates`, `seedTemplate`; `platform` exposes `listActiveStaffByRole`; `commerce` exposes `markCheckoutRecoveryMessage` (R2).
40. The orchestrator adds `automation_versions` to the append-only trigger list in the wave's custom migration (packages cannot write migrations).
