# Runbook: go-live

Owner: Sidestream (prepares), BEAM owner or technical_admin (confirms). Source: platform spec
PL-77, PL-75a, PL-85. The gate is on `/admin/system/go-live`: 13 items, each confirmed by an owner
or technical_admin with a note. While it is incomplete in production the admin shows a red banner
and ops refuses non-dry-run imports.

## The 13 items

| Item | What to check | Reference |
| --- | --- | --- |
| <a id="dpa"></a>`dpa_signed` | The data processing agreement between BEAM and Sidestream is signed, with the subprocessor annex. | `subprocessors.md` |
| `subprocessors_confirmed` | BEAM confirmed the subprocessor list. | `subprocessors.md` |
| `region_confirmed` | Neon in AWS eu-central-1 (Frankfurt), Vercel functions in fra1, backups in Scaleway fr-par. | `subprocessors.md#locations` |
| `transfers_documented` | Transfers outside the EEA are listed with their mechanism. | `subprocessors.md#transfers` |
| `ai_no_training_confirmed` | The Anthropic organisation is in BEAM's name and API data is not used for training. | `subprocessors.md#anthropic` |
| <a id="retention"></a>`retention_agreed` | BEAM agreed the retention policies on the privacy screen (`retention_policies`). | architecture section 10 |
| <a id="export"></a>`export_tested` | A privacy export of a test person produced the zip with every module's data. | privacy screen |
| <a id="deletion"></a>`deletion_tested` | An erasure of a test person anonymised every table and reported each external step. | privacy screen |
| `security_confirmed` | Ethical-hacking test at most 30 days old, no open critical or high incident, WAF rules in place. The server refuses the confirmation otherwise. | `security-testing.md`, `security-controls.md` |
| `backup_confirmed` | The daily backup ran and shows OK on `/admin/system/security`. | `backup.md` |
| `recovery_confirmed` | A restore drill passed. | `restore.md` |
| `permissions_configured` | Every staff account has the right role; MFA coverage is 100 %; roles reviewed. | `access.md`, `add-role-permission.md` |
| <a id="acceptance"></a>`acceptance_passed` | The V1 acceptance spec passed on staging and BEAM signed the acceptance. | `docs/plan/acceptance-v1.md` |

Withdrawing a confirmation is possible (with a note) and makes the gate incomplete again.

## Monitoring to create in Better Stack before go-live

| Monitor | Target | Frequency | Alert |
| --- | --- | --- | --- |
| Health | `GET https://<production host>/api/health`, expect 200 | every minute | Slack `#beam-alerts` and phone call to the on-call founder |
| Tick heartbeat | heartbeat URL in `BETTERSTACK_HEARTBEAT_URL`, pinged by every `/api/cron/tick` | expected every minute, grace 3 minutes | Slack `#beam-alerts` and phone call |
| Contact form keyword | `GET https://<production host>/nl/f/contact`, expect 200 and the form title in the HTML | every 5 minutes | Slack `#beam-alerts` |

Also set `BETTERSTACK_MONITOR_ID` to the health monitor's id, so the monthly report reads its SLA.

## Production configuration (checked by `/api/health`)

`SENSITIVE_DATA_KEY_V<current>` present; `EMAIL_SINK` not set; `PAYMENTS_FAKE` and
`INTEGRATIONS=fake` not set; Mollie live key (not `test_`); both database URLs with
`sslmode=require`.

## Day of go-live

1. All 13 items confirmed; the banner is gone.
2. Production deploy from `main`; `/api/health` 200; tick fresh on `/admin/system`.
3. Run `pnpm db:seed --profile defaults` (runs on every deploy) and never the demo profile.
4. Sidestream watches `/admin/system` and Slack for the first 48 hours.

## Go-live of release 2 and release 3

The seed writes the journeys of R2 and R3 as drafts. On the day a release goes live, after the
release's flags are switched on and its deploy is healthy:

5. Switch on the release's seeded journeys once on the production database, exactly as described
   in [`automations.md`, "Switching on a release's journeys"](automations.md#switching-on-a-releases-journeys-go-live-of-r2-and-r3)
   (`releaseActivationCli` in `packages/db/src/seed/automation.ts`, decision 30, A-5a). From the
   repository root, with `DATABASE_URL_UNPOOLED` set (and `DATABASE_DRIVER=neon-ws` where TCP
   5432 is blocked), replacing `R2` by `R3` for release 3:

   ```bash
   pnpm --filter @beam/db exec tsx --eval 'import("./src/seed/automation.ts").then((m) => m.releaseActivationCli(["R2"])).then((code) => process.exit(code))'
   ```

   The command prints `R2: <n> journey(s) activated: <slugs>` and one line per journey that waits
   for a DPIA; it exits 1 on an unknown release or a database error. It is idempotent: run it again
   after a DPIA is approved on `/admin/privacy/dpia`, and it activates only what is still a
   never-activated draft.
6. Check `/admin/automations` (status `active`): the release's journeys are active; a DPIA-gated
   journey stays draft until its DPIA is approved.
