# AI connections

The platform uses Anthropic's Claude for a few clearly limited tasks. **AI prepares, a person
approves, and only then does the system act.** No business flow depends on AI: when it is
unavailable, the screen says "unavailable, write it yourself" and everything else keeps working.

This page is the register asked for in blueprint 61. The source of truth is the code register
`AI_FEATURES` in `packages/core/src/ai/features.ts`; `/admin/system/ai` shows the same register,
the month's spend and the switch for sensitive data. The rules are PL-51 to PL-61 in
[platform.md](../plan/modules/platform.md).

## How every AI call is made

1. Only a **job** (or the one inline exception, a live question in Release 4) may call Claude, and
   only through `callClaude()` in `apps/web/lib/ai.ts`. Importing the Anthropic SDK anywhere else
   fails lint (PL-51).
2. The call names a **feature** from the register. An unknown feature is refused (PL-52).
3. The fields sent must be in the feature's `allowedFields`, which must be in the global allow-list
   `AI_ALLOWED_FIELDS`. Otherwise the call is not made and an error is logged (PL-53).
4. Person data is built only by `toAiContext()` in `packages/core/src/ai/context.ts`, which uses
   the allow-list. Email, phone, notes and every sensitive field are never in it. A unit test fills
   every sensitive field and checks none of them reaches the prompt (PL-60).
5. The budget is checked before the call (PL-56).
6. Every call writes one row in `ai_requests`: feature, model, who asked, the prompt and output,
   tokens and cost. These rows are deleted after 30 days.
7. The output is stored as a **draft** by the module that asked. Claude never writes business rows
   itself (PL-61).

### The global allow-list (`AI_ALLOWED_FIELDS`)

`first_name`, `locale`, `status`, `is_member`, `b2c_stage`, `tags`, `acquisition.source`,
`first_visit_at`, `last_visit_at`, `visits`, `purchases`, `revenue_cents`, `credits_remaining`,
`grant_expires_at`, `membership_period_end_at`, `next_booking_at`, `open_tasks`,
`granted_purposes`, and (Release 4) `webinars_attended_live`, `watch_sec_total`.

Never sent: email address, phone number, last name, address, notes, form answers, and any
sensitive field (health, sleep, stress, recovery, wellbeing, medical).

## The register

Every feature has the same fixed values for the blueprint 61 fields that do not change per feature:

| Field | Value for every feature |
| --- | --- |
| Provider | Anthropic |
| Location | Anthropic API, US processing under the EU-US Data Privacy Framework and Standard Contractual Clauses; an EU endpoint is used once Anthropic offers one |
| Retention | 30 days in `ai_requests`; Anthropic API retention per its commercial terms |
| Training status | `not_used_for_training` |
| Prompt storage | `ai_requests.prompt` |
| Prompt retention | 30 days |
| Sensitive data allowed | No, for every feature (PL-54) |

Per feature:

| Feature | Module | Release | What it does | Model | Fields of a person it may see | Where the output waits for a person |
| --- | --- | --- | --- | --- | --- | --- |
| `site.propose_page` | site | V1 | Proposes a new version of a website page from its content and a staff instruction | `claude-opus-5-5` | none | A proposed `page_versions` row until someone with `site.publish` publishes it |
| `ai.classify` | crm | R3 | Sorts an incoming inbox message by topic and urgency | `claude-haiku-5-5` | `locale`, `status`, `is_member`, `b2c_stage` | Suggested classification on the thread, staff can change it |
| `ai.draft_reply` | crm | R3 | Drafts a reply to a customer message in the inbox | `claude-opus-5-5` | `first_name`, `locale`, `status`, `is_member`, `b2c_stage`, `tags`, `credits_remaining`, `grant_expires_at`, `membership_period_end_at`, `next_booking_at` | Draft on the thread until a staff member edits and sends it |
| `ai.draft_email` | email | R4 | Drafts a campaign (subject and blocks in three languages) from a staff brief | `claude-opus-5-5` | none | A draft campaign version that staff edit and approve; never scheduled automatically |
| `ai.weekly_summary` | ops | R4 | Summarises the week's management figures (totals only) | `claude-opus-5-5` | none | Weekly summary on the management dashboard |
| `ai.answer_question` | ops | R4 | Answers a staff question in plain language with read-only SQL over non-sensitive views | `claude-opus-5-5` | none | The question log, shown only to the person who asked |
| `site.audit_content` | site | R4 | Weekly SEO and broken-link review of published pages | `claude-haiku-5-5` | none | An audit report with suggestions for staff |

Questions in plain language (Release 4) run Claude's SQL under a separate read-only database role
(`beam_ai_ro`) with a 5-second limit, over an `ai` schema that only exposes non-sensitive views.

## No training on BEAM data

- The Anthropic organisation and its API key are in **BEAM's name** (see
  [ownership-and-exit.md](ownership-and-exit.md)). The API's commercial terms do not use customer
  data to train models, and no training opt-in is turned on.
- Data-sharing and research-preview settings in the Anthropic console stay off.
- No personal ChatGPT or Claude account is ever connected to BEAM data.
- `ANTHROPIC_API_KEY` exists only in the Vercel environment groups.
- Before go-live, an owner or technical_admin checks the console and confirms the go-live item
  `ai_no_training_confirmed` with who checked and when (PL-58, blueprint 61).

## Budget

The setting `ai` (edited on `/admin/settings/ai`) holds the limits:

| Setting | Default | Effect |
| --- | --- | --- |
| `monthly_budget_cents` | 10,000 (€100) | When the month's spend (Brussels month) reaches it, further calls are refused and the job ends as `dead` with reason `budget` |
| `daily_cap_calls` | 500 (100 outside production) | Maximum calls per day |
| `pricing` | Prices per million tokens | Used to calculate `cost_cents` per call (PL-57) |

At 80 % of the monthly budget Slack gets one line per month. The spend is on `/admin/system/ai` and
in the monthly report. Also set a matching monthly limit in the Anthropic console.

## The sensitive-data switch

`settings.ai.sensitive_enabled` is **off**, and no feature up to Release 4 is allowed to receive
sensitive data even if it were on. Turning it on is deliberately hard (PL-55, scenario 6):

1. Only the **owner** can do it.
2. A purpose of at least 20 characters and a DPIA reference are required.
3. The DPIA `sensitive_assessment_processing` must be approved in the ops DPIA register
   (`/admin/privacy/dpia`).
4. The change is audited (`ai.sensitive_enabled`).

An owner or technical_admin can turn it off at any time (audited `ai.sensitive_disabled`). A new
feature that needs sensitive data would also need a code change (`allowsSensitive: true`) and its
own DPIA.

## Adding or changing an AI feature

A new feature is a code change: an entry in `AI_FEATURES` with all blueprint 61 fields, the
smallest possible `allowedFields`, a job that calls `callClaude()`, and a place where a person
approves the result. Update this page in the same pull request.
