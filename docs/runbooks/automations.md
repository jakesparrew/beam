# Runbook: automations

Owner: Sidestream; BEAM marketing (role `marketing`, permission `automations.publish`) can pause,
resume and enrol on `/admin/automations`. Source: automation spec A-26 to A-35 and A-45.

The engine runs as jobs: `automation.evaluate` every minute reads new `activity_events` and
enqueues due steps; `automation.step` runs one step of one enrolment; `automation.sweep_enrolments`
runs every 15 minutes, completes finished enrolments, records dead step jobs whose `onDead` hook
failed, and raises the health alerts below. Every decision is one row in `automation_runs` (the
run log on `/admin/automations/[id]/runs` and the person page timeline).

## Alerts (Slack `#beam-alerts`, at most one line per fingerprint per hour)

| Fingerprint | Severity | Meaning |
| --- | --- | --- |
| `automation-stuck` | high | An enrolment of an active automation is more than 30 minutes past its next step. |
| `automation-lag` | high | The oldest unprocessed activity event is more than 5 minutes old. |
| `automation-failures` | high | More than 20 `failed` runs in the last hour. |
| `automation-translation:<template>` | normal | Emails skipped because the template lacks the recipient's language. |
| `dead:automation.step`, `dead:automation.call_webhook` | high | Platform's dead-job alert (see `dead-jobs.md`). |

`countAutomationIssues` shows the same numbers on `/admin/system` and in the daily digest.

## Stuck journey (`automation-stuck`)

1. Check that ticks run: `/admin/system` shows the last tick; if it is older than 3 minutes, see
   `incident.md` (the cron or the database is down). Steps catch up on their own once ticks run;
   email, Slack and webhook steps more than 24 hours late are skipped as `skipped_stale`.
2. Check `/admin/system/jobs` for `automation.step` jobs: many `pending` jobs mean a backlog (they
   drain at 20 per tick per lane); many `dead` ones mean a bug (next section).
3. A single enrolment that stays due while its automation is `active`: open the person page,
   Automations tab. If its step job succeeded without effect (the automation was paused in that
   minute), Resume enqueues it again with the `:resume:` key; otherwise exit and re-enrol the
   person (below).

## Dead step job (`dead:automation.step`)

A step job is dead after 6 attempts (or at once on a permanent error such as an unknown template).
Its `onDead` hook writes a `failed` run with the error and moves the enrolment to the next step,
so the rest of the journey continues. If the hook itself failed, the sweep does the same within
15 minutes.

1. Read the error on `/admin/system/jobs` and the `failed` run on the automation's run log.
2. Fix the cause (template, data, code). A Retry of the dead job is harmless: the step re-checks
   the enrolment and finds it already moved on; the email key `automation:<enrolment>:<step>`
   prevents a second send.
3. `failed` with `template_unavailable`: the template was archived or never published. Publish it,
   or publish a new automation version without that step.

`automation.call_webhook` dies at once on a 4xx answer (the receiver refused the payload) and after
6 attempts on 5xx or timeouts. The enrolment already continued; only the `failed` run is written.
Check the receiver, then Retry the job.

## Evaluator lag (`automation-lag`)

1. `/admin/system/jobs`: is `automation.evaluate` running every minute and finishing within 45
   seconds? A burst of events (a campaign's `email.opened`) is processed 1,000 per run with
   continuation jobs and catches up by itself.
2. A failing evaluator (dead `automation.evaluate`, repeated Sentry errors) blocks every journey:
   treat it as an incident. One bad definition cannot stall it (each event is processed in its own
   savepoint and writes a `failed` run with reason `evaluate:<message>`).
3. Unsubscribes never wait for the evaluator: `automation.exit_for_suppression` ends marketing
   journeys from the suppressing action itself.

## Pausing every marketing journey during an incident

Use this when marketing email must stop at once (a wrong template, a deliverability problem).

1. On `/admin/automations`, filter status `active`, and Pause each automation that is marketing
   (or all of them). Pause is audited (`automation.pause`); during a pause no step runs and nobody
   enrols, exits still apply.
2. Alternatively stop sending in `email` (see `email-dns.md`); journeys then keep running but
   messages are not sent.
3. When the incident is over, Resume each automation. `automation.resume_enrolments` skips email,
   Slack and webhook steps more than 24 hours overdue (`skipped_paused`) and enqueues the other due
   steps at once; later steps run on time.

## Re-sending a skipped step by staff enrol

A step that was skipped (`skipped_stale`, `skipped_paused`, `failed`) is never retried by the
engine. To give a person the journey again:

1. Person page, Automations tab: Exit the enrolment (reason `manual`, audited).
2. "Enrol in..." the same automation (staff enrol overrides re-entry and exclusivity, audited
   `automation.person_enrol`); give the anchor when the automation needs one. Steps planned before
   now are logged as `skipped_late_entry` unless the step sends on late entry; to send a specific
   message now, enrol into a manual automation built for it.
3. Marketing consent is still checked per step: an unreachable person gets `skipped_unreachable`.

## Switching on a release's journeys (go-live of R2 and R3)

The seed (`pnpm seed`, profile `defaults`) writes the R2 and R3 journeys as drafts with a
published version 1. At the go-live of a release, run the activation once on the production
database (decision 30, A-5a). It switches on every seeded journey of that release that is still a
draft and was never activated; a journey BEAM paused, archived or edited back to draft after an
activation keeps its status, and a DPIA-gated journey (`requires_dpia`) stays draft until its DPIA
is approved on `/admin/privacy/dpia`. Every activation is audited (`automation.activate`, system
actor). Running it again is safe: it activates nothing new.

1. Set `DATABASE_URL_UNPOOLED` (direct connection) and, where TCP 5432 is blocked,
   `DATABASE_DRIVER=neon-ws`, as for `pnpm db:migrate`.
2. From the repository root (replace `R2` by `R3` for release 3):

   ```bash
   pnpm release:activate R2
   ```

3. Read the output: `R2: <n> journey(s) activated: <slugs>`, then one line per journey that
   waits for a DPIA. After the DPIA is approved, run step 2 again.
4. Check `/admin/automations` (filter status `active`): the release's journeys are active.
