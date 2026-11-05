# V1 acceptance map (platform-P12)

Every V1 row of the proposal's section 12 checklist, plus blueprint 76 "Email sends correctly"
(gap G1, platform decision 115), mapped to its case in `apps/web/e2e/acceptance-v1.spec.ts`, the
module tests that prove it in depth (the "Test that proves it" column of `05-coverage.md` Part
D), the portal and admin pages the case visits (each one in `apps/web/test/routes-v1.test.ts`,
PL-95) and the seam test, where one applies (`apps/web/test/seams-v1.test.ts`).

The acceptance spec runs at the wave 11 checkpoint against a production build on `beam_dev` with
the demo seed and the provider fakes (runbook 3.6); coding agents only list it
(`pnpm --filter @beam/web exec playwright test --list`). Seam failures and their fix packages are
in `docs/build/seam-issues-v1.md`.

## Core

| # | Proposal test | `acceptance-v1.spec.ts` case | Pages visited (`routes-v1.test.ts`) | Module tests and other specs |
| --- | --- | --- | --- | --- |
| D-1 | Customer can register | Core › "A customer can register, book, pay and cancel" (magic-link sign-in of a new address creates the person and portal user); Core › "A visitor starts on the public site and reaches booking through sign-in" | `/nl`, `/nl/events/<id>` (site-P2), `/nl/account/login`, `/check-email`, `/verify` (platform-P6) | `modules/crm/persons/persons.test.ts`; `e2e/booking.spec.ts` (register by magic link) |
| D-2 | Customer can book | Core › "A customer can register, book, pay and cancel" (day session with a credit) | `/nl/account/book/<id>`, `/nl/account/bookings/<id>` (booking-P6) | `modules/booking/server/book.test.ts`; `e2e/booking.spec.ts`; seam 1 |
| D-3 | Customer can pay | Core › "A customer can register, book, pay and cancel" (5-day package with the fake provider) | `/nl/account/shop/PKG-5-DAYS`, `/nl/account/checkout`, `/nl/account/checkout/return/<id>` (commerce-P5), `/api/dev/fake-pay/<id>` | `modules/commerce/server/paid.test.ts`, `webhook.test.ts`; `e2e/commerce.spec.ts`; seam 1 |
| D-4 | Package balance updates | Core › "The package balance updates" (5 left, book, 4 left, on the booking form and in the ledger view; reschedule keeps 4) | `/nl/account/book/<id>`, `/nl/account/packages` (credits-P7) | `e2e/commerce.spec.ts`, `e2e/credits.spec.ts`; seam 1 (grant, booking, cancel, credit back) |
| D-5 | Member discount works | Core › "The member discount applies automatically" | `/en/account/shop` (commerce-P5) | `e2e/commerce.spec.ts` (member price); `modules/commerce/quote.test.ts` |
| D-9 | Customer can cancel | Core › "A customer can register, book, pay and cancel" (from `/nl/account/bookings/<id>`: open Cancel, confirm, credit back); Core › "The package balance updates" (Reschedule from the same page, pick a target) | `/nl/account/bookings`, `/nl/account/bookings/<id>`, `/nl/account/bookings/<id>/reschedule` (booking-P6, with `loading.tsx` and `error.tsx`, gap G11) | `modules/booking/server/cancel.test.ts`, `reschedule.test.ts`; `e2e/booking.spec.ts`; seam 1 |
| D-7 | Administrator can modify booking | Core › "An administrator can change a booking" | `/admin/login`, `/admin/mfa/verify` (platform-P6), `/admin/bookings/<id>` (booking-P4) | `e2e/booking.spec.ts` (staff part) |
| D-8 | CRM reflects activity | Core › "The CRM shows the activity" (`order.paid`, `booking.confirmed`, `booking.cancelled` rows on the 360 timeline) | `/admin/persons/<id>` (crm-P7) | `modules/crm/ui/timeline/timeline.test.ts`; `e2e/crm.spec.ts`; seam 1 (the three facts) |
| D-10 | Reporting reflects transaction | Core › "Reports reflect the transaction" (a package paid while the report is open raises today's revenue tile by at least its total; the CSV lists the package) | `/admin/reports/revenue` (ops-P3), handler `/admin/reports/revenue/csv` | `modules/ops/reports/revenue.test.ts`; `e2e/ops.spec.ts` |
| D-11 | Data can be exported | Core › "Data can be exported" (persons export zip with `persons-1.csv`) | `/admin/reports/exports` (ops-P6), handler `/admin/reports/exports/<id>/download` | `modules/ops/exports/*.test.ts`; `e2e/ops-exports.spec.ts` |

## Email

| # | Proposal test | `acceptance-v1.spec.ts` case | Pages visited | Module tests and other specs |
| --- | --- | --- | --- | --- |
| D-6 | Email sends correctly (blueprint 76, not in the proposal's V1 row) | Email › "Email sends correctly: ..." (the confirmation of the core booking: one `email_messages` row for `booking:<id>:confirmed`, locale `nl-BE`, `from_domain = mail.beam.be`, status `sent` (a message without plain text ends `failed` with `missing_text_part`), the rendered HTML with the legal footer; one `email.sent` event and its timeline row; a second run of the `email:<id>` job adds no file, event or Resend id) | `/admin/persons/<id>` | seam 1 (the Resend fake receives HTML and plain text with the legal footer, through `EMAIL_SINK`); seam 3; `modules/email/*send*.test.ts`; `test/wave0-email.test.ts` |
| D-12 | Late-entry reminders are skipped | Email › "Late-entry reminders are skipped" (a free event 48 hours away: `reminder_7d` and `reminder_3d` are `skipped_late_entry`, the next step is `reminder_day_of`, no reminder in the sink) | `/nl/account/book/<id>` | `e2e/scenario-1-late-entry.spec.ts` (with the fake clock and the day-of send); `packages/core/src/automation/plan.test.ts`; `modules/automation/seeded-journeys.test.ts` |
| D-13 | Unsubscribe stops marketing within the agreed timeframe (15 minutes) | Email › "An unsubscribe stops marketing within 15 minutes" (one-click POST: suppression at once, the newsletter purpose unreachable) | handler `/api/public/unsubscribe/<token>` | `e2e/scenario-2-fast-unsubscribe.spec.ts` (journey exit and queued message suppressed within 60 s); `modules/automation/scenario-2-unsubscribe.test.ts` |
| D-14 | Hard-bounced address is suppressed | Email › "Hard bounces are suppressed" (signed fake Resend `email.bounced` Permanent: message `bounced`, `hard_bounce` suppression, unreachable) | handler `/api/webhooks/resend` | `modules/email/server/process-event.test.ts`; `modules/crm/consent/consent.test.ts`; `e2e/email.spec.ts` part 3 |
| D-15 | Member, customer and lead dynamic blocks display correctly | Email › "Lead, customer and member content blocks display correctly" (one dynamic block with three variants, previewed as each persona: only its own variant shows) | `/admin/templates/<id>/preview` (email-P5) | `packages/email/src/blocks/compile.test.ts`; `e2e/email.spec.ts` part 1 |

## Assessment

| # | Proposal test | `acceptance-v1.spec.ts` case | Pages visited | Module tests and other specs |
| --- | --- | --- | --- | --- |
| D-20 | Weighted and branched assessment works | Assessment › "A weighted, branched assessment works" (`recovery-check` in `fr-BE`: the stress branch appears at 8, the result page shows the score and a CTA, the submission has a score and an outcome) | `/fr/f/recovery-check`, `/fr/f/recovery-check/r/<token>` (forms-P4), handlers `/api/public/forms/<slug>/save` and `/submit` | `packages/core/src/forms/scoring.test.ts`, `logic.test.ts`; `e2e/forms.spec.ts` |
| D-21 | Existing customer record is updated | Assessment › "An existing customer record is updated" (the existing person without a first name gets it; no second person) | as above | `modules/forms/service/submissions.test.ts` (fill-empty and overwrite); `e2e/forms.spec.ts` (phone filled) |
| D-22 | Result does not create newsletter consent | Assessment › "A result does not create newsletter consent" | as above | `modules/forms/service/submissions.test.ts` (rule C3); `modules/automation/seeded-journeys.test.ts` (A-14) |
| D-23 | Sensitive health free text excluded from AI unless enabled | Assessment › "Sensitive free text is excluded from AI" (sensitive answers only in `form_sensitive_answers`, never in the plain answers, the AI context or any `ai_requests.fields_sent`) | none (database and `toAiContext`) | `e2e/scenario-6-sensitive-ai.spec.ts` (sensitive note, owner-only enable with audit); `packages/core/src/ai/*.test.ts`; `apps/web/lib/ai.test.ts` |

## Waitlist

| # | Proposal test | `acceptance-v1.spec.ts` case | Pages visited | Module tests and other specs |
| --- | --- | --- | --- | --- |
| D-25 | Duplicate does not take a second seat | Waitlist › "The same person cannot take a second seat" | `/nl/account/book/<id>` | `modules/booking/actions/waitlist.test.ts`; `e2e/booking.spec.ts` (V1 acceptance) |
| D-26 | Claim window expires correctly | Waitlist › "The claim window expires correctly" | `/nl/claim/<token>` (booking-P5) | `modules/booking/jobs/waitlist.test.ts`; `e2e/scenario-4-seat-claim.spec.ts` |
| D-27 | Confirmed seat is protected | Waitlist › "A confirmed seat is protected" | `/nl/claim/<token>` | `e2e/scenario-4-seat-claim.spec.ts` (forced expiry run) |

## GDPR

| # | Proposal test | `acceptance-v1.spec.ts` case | Pages visited | Module tests and other specs |
| --- | --- | --- | --- | --- |
| D-29 | Export works | GDPR › "Export works" (subject export request created, verified and run from the privacy screens; the zip downloads) | `/admin/privacy/new`, `/admin/privacy/<id>` (ops-P5), handler `/admin/privacy/<id>/download` | `modules/ops/privacy/export.test.ts`; `e2e/ops-exports.spec.ts` |
| D-30 | Deletion propagates correctly | GDPR › "Deletion propagates" (person anonymised, bookings and email messages gone, `erased` suppression hash kept, no address in the report) | as above | `e2e/scenario-7-deletion.spec.ts` (every module and the Billit, Mollie and Resend fakes); `test/gdpr-coverage.test.ts`; each module's `privacy.test.ts` |
| D-31 | Consent history is retained correctly | GDPR › "Consent history is kept" (portal grant then withdrawal: both rows kept, current status withdrawn) | `/nl/account/preferences` (crm-P3) | `modules/crm/consent/consent.test.ts` |
| D-32 | Marketing suppression survives import | GDPR › "Suppression survives an import" (one-click unsubscribe, then a Mailchimp `subscribed` import row is skipped `suppressed`; no import consent; still unreachable) | handler `/api/public/unsubscribe/<token>` | `modules/ops/imports/suppression-survives.test.ts` |

## The V1 seams

| Seam | Test | Rows it backs |
| --- | --- | --- |
| Checkout -> credits -> booking | `seams-v1.test.ts` › seam 1 | D-2, D-3, D-4, D-6, D-8, D-9 |
| Order -> invoice -> Billit | `seams-v1.test.ts` › seam 2 (`BEAM-2026-000001`, one Billit fake document) | D-3 (the paid order's invoice) |
| Form -> person -> automation -> email | `seams-v1.test.ts` › seam 3 | D-6, D-21 |
| Route reach (PL-95, gap G11) | `routes-v1.test.ts` | every page and handler named above |
| Runtime rules (CONVENTIONS 12, OD-18) | `routes-v1.test.ts` › runtime rules | every page (a non-function `"use server"` export or a server `createContext` breaks it at runtime only) |
