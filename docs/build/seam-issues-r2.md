# Seam issues, R2 (platform-P13)

Seam failures found by the R2 acceptance package (platform spec section 12, platform-P13; PL-95,
PL-96, gap G15). Handled as in platform-P12 (`docs/build/seam-issues-v1.md`): each open issue
names the package whose files hold the fix; the orchestrator runs one fix package per issue
(`fix-<module>-<n>`, owning only that module's files) before wave 19 starts, then turns the
marked case back into a plain test (`it.fails` -> `it` in Vitest, `test.fixme` -> `test` in
Playwright). This package edits no other module.

## Result of the R2 seams

`apps/web/test/seams-r2.test.ts` runs on PGlite after `seedDefaults` and email's registry system
rows, switched over to Release 2 with `activateReleaseSequences(tx, 'R2', { isDpiaApproved })`
(ops' real `isDpiaApproved`) and `ff_commerce_checkout_recovery` on. No module function is
mocked; only `next/headers` and `next/server`, and every provider is the fake of
`createFakeIntegrations()`. Jobs run through the real runner (`runJobs`) with a pinned clock that
always lies ahead of the real one.

| Seam | Result |
| --- | --- |
| The R2 switch-over activates `webinar-registration` and `abandoned-checkout` | passes |
| `webinar.registered` -> `webinar-registration`: `d7` and `d3` `skipped_late_entry`, only `h3` sent, `webinar.reminder` delivered once to the sink from `mail.beam.be`, a later evaluation adds nothing | passes |
| `checkout.abandoned` -> 1-hour `commerce.checkout_recovery` (marketing, `news.beam.be`) with the resume link -> paid through `placeOrder` and the Mollie webhook -> `checkout.completed` ends the journey before the 24-hour reminder -> the next `checkouts.mark_abandoned` attributes the recovery (`recovered_order_id`, `checkout.recovered`) to the first email | passes |
| `runStep` (one home, `apps/web/modules/automation/engine/step.ts`): 22:30 Brussels with quiet hours 21:00-08:00 is deferred to 08:00 with one new `scheduled` row and the `:defer:` job, and sends then | passes |
| `runStep`: the third marketing step of a day with `maxMarketingPerDay = 2` ends `skipped_frequency_cap` (`cap_day:2`) | passes |
| `runStep`: the abandoned-checkout email carries `getCheckoutRecoveryProps().resumeUrl`; `recovery_message_id` is set once over a re-run and the 24-hour reminder | passes |
| Exactly one `step.ts` exports `runStep`; none under `packages/db/src/` or `packages/core/src/i18n/` | passes |

`apps/web/test/routes-r2.test.ts` (PL-95): `/admin/automations/rules`, `/conflicts` and `/groups`
resolve to automation-P7's pages, and every page and handler `acceptance-r2.spec.ts` visits
resolves under `apps/web/app/`: passes.

No seam blocks wave 19.

## Open issues

None.

## Notes for the orchestrator (not seam failures)

| Id | Owner | Note |
| --- | --- | --- |
| N-1 | platform (owner of `apps/web/scripts/`) or automation (owner of `packages/db/src/seed/automation.ts`) | The R2 switch-over has no caller outside tests: nothing in `apps/web/scripts/`, the runbooks or the deploy runs `activateReleaseSequences(tx, 'R2', { isDpiaApproved })` from `@beam/db/seed/automation`, so on `beam_dev` the R2 journeys stay drafts after `pnpm seed`. Until a caller exists (for example a `release:activate R2` script, or the R2 step of the go-live runbook), the wave 18 checkpoint must run it once; `acceptance-r2.spec.ts` activates the `abandoned-checkout` journey itself for its run when it finds it a draft and restores it afterwards. |
| N-2 | none (test harness) | On PGlite (one connection) `flag()` of `apps/web/lib/flags.ts` reads its row through the app database handle while the job runner holds the job's transaction, so an uncached flag read inside a job waits forever. Production has a connection pool and is not affected. `seams-r2.test.ts` fills the 60-second flag cache before each runner call (`warmFlags`); a test that drives `automation.evaluate` or `automation.step` through `runJobs` on PGlite needs the same step. |

## Closed issues

None yet.
