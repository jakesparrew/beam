# R2 acceptance map (platform-P13)

Every Release 2 row of the proposal's section 12 checklist, plus the abandoned-checkout recovery
of the R2 scope (proposal section 2, commerce rules 49 to 52), mapped to its case in
`apps/web/e2e/acceptance-r2.spec.ts`, the module tests that prove it in depth, the pages and
route handlers the case visits (each one in `apps/web/test/routes-r2.test.ts`, PL-95) and the
seam test, where one applies (`apps/web/test/seams-r2.test.ts`).

The acceptance spec runs at the wave 18 checkpoint against a production build on `beam_dev` with
the demo seed and the provider fakes (runbook 3.6); coding agents only list it
(`pnpm --filter @beam/web exec playwright test --list`). The webinar cases skip themselves while
`ff_webinar_portal` is off; the lead-priority cases set `ff_booking_lead_priority` to `testers`
for their own tester persons and restore it; the abandoned-checkout case turns
`ff_commerce_checkout_recovery` on, activates the seeded `abandoned-checkout` journey when it is
still a draft, lifts the quiet hours and caps for its run, and restores all three. Seam failures
and their fix packages are in `docs/build/seam-issues-r2.md`.

## Webinar

| # | Proposal test | `acceptance-r2.spec.ts` case | Pages and handlers visited (`routes-r2.test.ts`) | Module tests and other specs |
| --- | --- | --- | --- | --- |
| R2-1 | Registration is not counted as attendance | Webinar › "Registration is not counted as attendance" (a registration through the public route writes only `webinar.registered`; `v_webinar_registration_facts` has no live start, attendance or watch seconds; the report counts 1 registered, 0 started, 0 attended) | handler `/api/public/webinars/<slug>/register`; `/admin/webinars/<id>/report` (webinar) | `modules/webinar/server/registration.test.ts`, `server/report.test.ts`; `e2e/acceptance-r2-webinar.spec.ts`, `e2e/webinar-register.spec.ts`; seam 1 (the registration enrols the reminder journey and nothing else) |
| R2-2 | Watch time is captured | Webinar › "Watch time is captured" (the personal link of an on-demand webinar, the simulated player, two 15-second heartbeats: `watch_segments` rows and seconds in `v_webinar_watch`; the report shows the viewer under on-demand, not live) | `/nl/w/<token>`; handlers `/api/webinar/view`, `/api/webinar/heartbeat`; `/admin/webinars/<id>/report` | `modules/webinar/heartbeat.test.ts`, `finalise.test.ts`; `e2e/webinar-watch.spec.ts` |
| R2-3 | Replay activity and replay polls are stored separately from live | Webinar › "Replay activity and replay polls are stored separately from live" (a live answer and a replay answer of the same person are two `webinar_interactions` rows with their own modes; the facts view counts one each and `live_started` stays false; the report's poll table shows them in their own columns) | `/nl/w/<token>`; handlers `/api/webinar/view`, `/api/webinar/interact`; `/admin/webinars/<id>/report` | `modules/webinar/scenario-5.test.ts`, `server/interactions.test.ts`, `replay-access.test.ts`; `e2e/scenario-5-replay-separation.spec.ts`; `modules/automation/seeded-journeys-r2.test.ts` (replay events never trigger live journeys) |

## Lead-priority waitlist

| # | Proposal test | `acceptance-r2.spec.ts` case | Pages visited | Module tests and other specs |
| --- | --- | --- | --- | --- |
| R2-4 | Lead and customer rules work | Lead-priority waitlist › "Lead and customer rules work on a Lead Magnet event" (a free Lead Magnet event in its lead window, 1 of 2 seats reserved for leads, the general seat taken: a lead books the reserved seat, `used_lead_seat = true`; a second lead joins the lead queue; a customer sees "Opent voor jou op ...", has no booking button and joins the customer queue) | `/nl/account/book/<id>`, `/nl/account/bookings/<id>` (booking) | `modules/booking/server/lead-book.test.ts`, `api/session-cards-lead.test.ts`; `e2e/scenario-3-lead-access.spec.ts` (release at window end and at the public opening) |
| R2-5 | A waiting lead who buys is reclassified correctly, without losing a confirmed seat | Lead-priority waitlist › "A waiting lead who buys is reclassified as a customer, and a seated lead who buys keeps the confirmed seat" (both leads buy the 5-day package in the portal: `v_person_status` says customer; the minute job `waitlist.expire_offers` moves the waiting entry to the customer queue with the same id and `joined_at`, one `waitlist.requeued`, still ahead of the customer who joined later; the seated lead's confirmed booking is unchanged and has no waitlist entry) | `/nl/account/shop/PKG-5-DAYS`, `/nl/account/checkout`, `/nl/account/checkout/return/<id>` (commerce); handler `/api/dev/fake-pay/<id>` | `modules/booking/jobs/lead-release.test.ts` (waiting lead who buys moves keeping `joined_at`; offered lead keeps the offer; confirmed lead stays confirmed; a double run gives the same state); `e2e/scenario-4-seat-claim.spec.ts` |

## Abandoned checkout (R2 scope, not a section 12 row)

| # | Test | `acceptance-r2.spec.ts` case | Pages visited | Module tests and seam |
| --- | --- | --- | --- | --- |
| R2-6 | The recovery email is sent once and the recovery is attributed | Abandoned checkout › "The recovery email is sent once, brings the customer back, and the paid checkout is attributed to it" (a portal checkout idle for 61 minutes, one `checkouts.mark_abandoned` run, the evaluator enrols the person in `abandoned-checkout`, the 1-hour reminder `commerce.checkout_recovery` reaches the sink with the checkout's resume link and becomes `recovery_message_id`; a second run adds no second email; the resume page continues to the same checkout, the customer pays, the enrolment exits and the next run sets `recovered_order_id` and keeps the first email) | `/nl/account/shop/PKG-5-DAYS`, `/nl/account/checkout`, `/nl/checkout/resume/<token>` (commerce), `/nl/account/checkout/return/<id>`; handler `/api/dev/fake-pay/<id>` | `modules/commerce/server/recovery.test.ts`, `server/checkouts.test.ts`; `modules/automation/seeded-journeys-r2.test.ts`, `engine/step.test.ts`; seam 2 and seam 3 |

## Seams (`seams-r2.test.ts`, real module code on PGlite)

| Seam | What it proves |
| --- | --- |
| 1. `webinar.registered` -> sequence with late-entry skip | `registerPerson` 48 hours before the start; `automation.evaluate` enrols the person in the seeded `webinar-registration` journey (activated by `activateReleaseSequences(tx, 'R2', { isDpiaApproved })`) with `d7` and `d3` `skipped_late_entry`; at `h3` the step queues `webinar.reminder` and `email.send` delivers it once to the sink from `mail.beam.be`. |
| 2. `checkout.abandoned` -> recovery email -> `checkout.completed` attribution | `startCheckout`, `checkouts.mark_abandoned` after 61 minutes, the seeded `abandoned-checkout` journey sends `commerce.checkout_recovery` (purpose `newsletter`, `news.beam.be`) after one hour with the resume link of `getCheckoutRecoveryProps`; `placeOrder` and the Mollie webhook pay the checkout, `checkout.completed` ends the journey before the 24-hour reminder, and the next `checkouts.mark_abandoned` sets `recovered_order_id` with the first email as `recovery_message_id`. |
| 3. The one executor (PL-96, gap G15) | `runStep` from `apps/web/modules/automation/engine/step.ts`: a marketing step due at 22:30 Brussels with quiet hours 21:00-08:00 (set through `updateAutomationRules`) returns `deferred` until 08:00 the next day, writes one new `scheduled` run (`quiet_hours`), moves `next_step_at` and enqueues the `:defer:` job, and sends at 08:00; with `maxMarketingPerDay = 2` the third marketing step of the day ends `skipped_frequency_cap` (`cap_day:2`); the abandoned-checkout email's `context.resume_url` is the `resumeUrl` of `commerce.getCheckoutRecoveryProps` and `checkouts.recovery_message_id` stays the first email over a re-run and the 24-hour reminder. A file scan finds exactly one `step.ts` exporting `runStep`, at that path, and none under `packages/db/src/` or `packages/core/src/i18n/`. |

## Routes (`routes-r2.test.ts`, PL-95)

`/admin/automations/rules`, `/admin/automations/conflicts` and `/admin/automations/groups`
resolve statically (not through `[id]`) to automation-P7's `page.tsx` files under the `(admin)`
shell. Every page and route handler in the tables above resolves to its file under
`apps/web/app/`, owned by the module named in the table.
