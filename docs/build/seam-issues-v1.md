# Seam issues, V1 (platform-P12)

Seam failures found by the V1 acceptance package (platform spec section 12, platform-P12). Each
open issue names the package whose files hold the fix; the orchestrator runs one fix package per
issue (`fix-<module>-<n>`, owning only that module's files) before wave 12 starts, then turns the
marked case back into a plain test (`it.fails` -> `it` in Vitest, `test.fixme` -> `test` in
Playwright).

## Result of the three V1 seams

`apps/web/test/seams-v1.test.ts` runs the three seams with real module code on PGlite (no module
function mocked; Next.js request APIs and the provider fakes only):

| Seam | Result |
| --- | --- |
| Checkout -> credits -> booking: fake Mollie `paid` through `POST /api/webhooks/mollie` and the job runner, 5 day credits granted, a day session booked with a credit (4 left), cancelled inside the rules (credit back, 5 left), `order.paid`, `booking.confirmed` and `booking.cancelled` on the timeline; the booking confirmation is sent once, `nl-BE`, from `mail.beam.be`, with HTML and plain-text parts holding the legal footer, through `EMAIL_SINK`, and `email.sent` is recorded | passes |
| Order -> invoice -> Billit: the paid order has invoice `BEAM-<year>-000001` (`BEAM-2026-000001` in the build year), `finance.render_pdf` and `billit.push_invoice` create exactly one matching document in the Billit fake and the invoice is `synced` | passes |
| Form -> person -> automation -> email: the seeded `contact` form submitted through the public `start` and `submit` routes creates the person and `form.completed`; an automation built with automation's staff actions (create, save draft, publish, activate) on a template seeded through email's `seedTemplate` enrols the person in `automation.evaluate`; `automation.step` queues the message and `email.send` delivers it to the sink; a second evaluation adds no enrolment and no message | passes |

`apps/web/test/routes-v1.test.ts` (PL-95, gap G11): every V1 URL and route handler the acceptance
spec calls resolves under `apps/web/app/`, the three booking portal pages are booking-P6's files
with `loading.tsx` and `error.tsx`, and no route file exists under `apps/web/modules/`: passes.
The same file checks the two OD-18 runtime rules over every source file (a `"use server"` file
exports only async functions; no `createContext`/`useContext` outside `"use client"` files):
passes.

No seam blocks wave 12.

## Open issues

| Id | Owner | Found by | Issue | Marked case |
| --- | --- | --- | --- | --- |
| SI-1 | email (fix package `fix-email-<n>`; files of email-P3: `apps/web/modules/email/server/send.ts`) | `seams-v1.test.ts` | A stored template document that fails the block-document validation at send time (`PermanentError: invalid_document: block id must be a 10-character nanoid`) kills `email.send` as a dead job but leaves the `email_messages` row `queued`. Email rule 39 and decision 7 say a content problem ends the message `failed` (here with an error such as `invalid_document`) and the job dead with one alert, so staff see it in the person's email history and can resend. Low risk in practice: the template editor validates documents on publish, and only seeds (`seedTemplate`, `insertSeededTemplate`) can store an invalid one; the delivery watch (rule 38a check a) still raises the "queued for 10 minutes" alert. Fix: catch the `invalid_document` error of the render step in `email.send` and call `failMessage(..., { status: "failed", error: "invalid_document" })` before rethrowing the `PermanentError`; optionally validate the document in `seedTemplate`. | `it.fails("SI-1: a message whose template document is invalid ends failed, not queued")` in `apps/web/test/seams-v1.test.ts` |

## Closed issues

None yet.
