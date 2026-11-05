# Core workflows

Five everyday flows, step by step, with the tables each step touches. They show how the modules
work together on one customer record. Table names are explained in
[data-model.generated.md](data-model.generated.md); the general model (actions, jobs, the tick) is
on [architecture.md](architecture.md).

A reminder of the pattern you will see in every flow: **a click writes rows and queues jobs in one
transaction; jobs do the outside work afterwards** (email, payment, Billit), usually within seconds.

## 1. From sign-up to a booking

A new visitor creates an account, books a day session with a package, comes, and is checked in.

| # | What happens | Module | Tables touched |
| --- | --- | --- | --- |
| 1 | The visitor enters their email on `/nl/account/login`. A single-use sign-in link (valid 15 minutes) is created and the email job is queued | platform, email | `auth_verification_tokens`, `rate_limits`, `email_messages`, `jobs` |
| 2 | `email.send` sends the link from `mail.beam.be` | email | `jobs`, `email_messages`, `integration_calls` |
| 3 | The visitor clicks the link. Their person record is found or created (one person per email address), their account and session are created | platform, crm | `users`, `auth_sessions`, `persons`, `activity_events` (`person.created`) |
| 4 | The portal shows the open sessions and free places | booking | `sessions`, `v_session_availability` |
| 5 | The customer books. Under a lock on the session, capacity is checked again; credits are used from the package that expires first | booking, credits | `sessions` (lock), `bookings` (`confirmed`), `credit_entries` (`consume`), `activity_events` (`booking.confirmed`, `credits.consumed`) |
| 6 | The confirmation email is queued in the same transaction and sent right after | booking, email | `email_messages`, `jobs` |
| 7 | Without enough credits, the booking is held as `reserved` and an order is created instead; see flow 2. The booking is confirmed when the order is paid | booking, commerce | `bookings` (`reserved`), `orders`, `order_lines` |
| 8 | The day before, `bookings.send_reminders` sends a reminder; the `after-first-booking` journey sends preparation emails | booking, automation | `email_messages`, `automation_enrolments`, `automation_runs` |
| 9 | At the desk, reception checks the customer in | booking | `bookings` (`attended`), `activity_events` (`booking.attended`), `audit_log` |
| 10 | The first visit starts `after-first-visit` and, the next day, `review-request`; the nightly `ops.refresh_person_stats` updates visits and last visit | automation, ops | `automation_enrolments`, `person_stats` |

Cancelling inside the free window releases the credit (`credit_entries` `release`) and frees the
place for the waitlist (`waitlist.offer_next`). See [business-rules.md](business-rules.md#bookings-and-cancellation).

## 2. From a purchase to an invoice in Billit

A customer buys a 10-session package online with Bancontact.

| # | What happens | Module | Tables touched |
| --- | --- | --- | --- |
| 1 | The customer opens the checkout. The price is quoted (best single discount) and saved with its trace | commerce | `checkouts`, `products`, `price_versions`, `promotions` |
| 2 | The customer accepts the terms and pays. An order is created as `pending_payment` with a unique client key (a double click creates nothing twice) | commerce, site | `orders`, `order_lines`, `terms_acceptances` |
| 3 | The Mollie payment is created inline (one of the three allowed exceptions) and the customer is redirected to Mollie | commerce | `payments`, `jobs` (`payments.create`), `integration_calls` |
| 4 | Mollie calls `/api/webhooks/mollie` with the payment id. The message is stored once and a job is queued | platform, commerce | `webhook_events`, `jobs` (`webhook.process`, `payments.sync`) |
| 5 | `payments.sync` fetches the payment from Mollie. That fetch is the proof; the message itself is never trusted | commerce | `payments`, `integration_calls` |
| 6 | **The paid transaction**, all at once: order `paid`; the package is granted; any reserved bookings are confirmed; the invoice is issued with the next number; the timeline gets `order.paid` | commerce, credits, booking, finance, crm | `orders`, `credit_grants`, `credit_entries` (`grant`), `bookings`, `invoices`, `invoice_sequences`, `activity_events` |
| 7 | In the same transaction, the follow-up jobs are queued: the invoice PDF, the Billit push and the receipt email | finance, email | `jobs` (`finance.render_pdf`, `billit.push_customer`, `billit.push_invoice`, `email.send`) |
| 8 | `finance.render_pdf` stores the PDF; the receipt email attaches it | finance | `files`, `email_messages` |
| 9 | `billit.push_invoice` sends the invoice to Billit with BEAM's number as reference and stores Billit's id; Belgian company invoices also go over Peppol | finance | `invoices` (`billit_id`, `billit_status`), `billit_parties`, `integration_calls` |
| 10 | Meanwhile the return page reads the order status from the database every 2 seconds and shows "paid" | commerce | `orders` |

If the customer never pays, `payments.scan_expired` expires the payment and the order after 30
minutes and releases any reserved place. If Billit is down, the invoice is still valid; the push
retries and finance shows a Retry button. A refund later creates a credit note (`CN-...`) and
revokes the unused credits.

## 3. From a form to a person, an automation and an email

A visitor fills in the website contact form, ticks "keep me informed", and gets the welcome journey.

| # | What happens | Module | Tables touched |
| --- | --- | --- | --- |
| 1 | The visitor starts the form; the published version is pinned to the submission | forms | `form_submissions` (`started`), `form_versions` |
| 2 | Each page is saved as they go | forms | `form_submissions` (`partial`) |
| 3 | On submit, answers are checked, scores and outcome computed (assessments), the person is found or created by email, and only empty profile fields are filled | forms, crm | `form_submissions` (`completed`), `persons`, `activity_events` (`person.created`, `form.completed`) |
| 4 | The ticked box records consent for that purpose, with the exact wording version; answers marked sensitive are stored encrypted, apart from the rest | crm, forms | `consent_records`, `form_sensitive_answers` |
| 5 | Outcome tags are added; for an assessment, `assessment.result_generated` is written and the result link is emailed | crm, forms, email | `person_tags`, `activity_events`, `email_messages`, `jobs` |
| 6 | Within a minute, `automation.evaluate` reads the new events and enrols the person in `welcome-lead` after checking audience, re-entry, group and marketing reachability | automation | `automation_enrolments`, `automation_runs` (`entered`, `scheduled`) |
| 7 | When a step is due, `automation.step` checks everything again (still active, not paused, consent, suppressions, translation) and queues the email | automation, email | `automation_runs` (`sent` or a skip reason), `email_messages`, `jobs` (`email.send`) |
| 8 | `email.send` checks the suppression list once more and sends from `news.beam.be` with a personal unsubscribe link | email | `email_messages`, `integration_calls` |
| 9 | Resend reports delivered, opened, clicked; a click can tag the person `engaged` and branch the journey | email, automation | `webhook_events`, `email_events`, `activity_events` |

## 4. Unsubscribing

A customer clicks "unsubscribe" in a marketing email (or uses the preference centre, or staff do it,
or Resend reports a spam complaint).

| # | What happens | Module | Tables touched |
| --- | --- | --- | --- |
| 1 | The link carries a fresh, random token per message; only its hash is stored. Opening the link changes nothing; the one-click POST (or the button on the page) does | email, crm | `email_messages` (`link_token_hash`) |
| 2 | `crm.addSuppression` records the withdrawal and the suppression for that purpose (or for everything) | crm | `consent_records` (`withdrawn`), `suppressions`, `activity_events` (`consent.withdrawn`, `suppression.added`), `audit_log` for staff |
| 3 | In the same transaction it queues `automation.exit_for_suppression`, which runs right after the click | automation | `jobs` |
| 4 | Every running marketing journey for that address ends with `unsubscribed`, within seconds | automation | `automation_enrolments` (`exited`), `automation_runs` |
| 5 | Campaign chunks and `email.send` check the suppression list again just before sending, so nothing already queued goes out | email | `campaign_recipients`, `email_messages` |
| 6 | Transactional mail (booking confirmations, receipts) still arrives; marketing steps inside transactional journeys are skipped | email, automation | `automation_runs` (`skipped_unreachable`) |

A suppression is never deleted, and an import can never undo it. The person can come back only by
giving fresh consent and confirming it by email (crm rule 3.21).

## 5. Deleting a customer (GDPR erasure)

A customer asks to be forgotten, from `/nl/account/privacy` or through staff.

| # | What happens | Module | Tables touched |
| --- | --- | --- | --- |
| 1 | The request is recorded and verified (by the customer's session, or by staff with `privacy.run` with a note). A confirmation email goes out now, because no address will exist afterwards | ops | `privacy_requests`, `email_messages` |
| 2 | The erasure is scheduled 24 hours later; until then it can be cancelled. Staff see warnings (active membership, remaining credits, future bookings, open invoices) and acknowledge them | ops | `privacy_requests` |
| 3 | `privacy.erase_external` first tells the outside services, while the address is still known: Billit anonymises the customer, payment mandates are revoked, Resend deletes the contact | ops, finance, commerce, email | `jobs`, `integration_calls` |
| 4 | `privacy.erase` runs each module's handler in a fixed order, allowed to rewrite append-only rows for this transaction only | all modules | per module (below) |
| 5 | The person becomes "Deleted person" without email; sensitive fields, sensitive form answers, AI requests, waitlist entries, journeys and webinar registrations are deleted | crm, forms, platform, booking, automation, webinar | `persons`, `person_sensitive_fields`, `form_sensitive_answers`, `ai_requests`, `waitlist_entries`, `automation_enrolments`, `webinar_registrations` |
| 6 | What the law requires is kept: invoices stay with only the legal name and address, the suppression keeps only the hashed email (so the address is never mailed again), audit rows are reduced to digests | finance, crm, platform | `invoices` (`customer_snapshot`), `suppressions`, `audit_log` (`is_redacted`) |
| 7 | A report without personal data is stored (tables, row counts, actions, provider outcomes); payment providers keep payment data under their own legal duties | ops | `privacy_requests`, `audit_log` (`privacy.erased`) |

A failing outside call never blocks the local erasure; it is marked for manual follow-up in the
report. An export request works the same way in reverse: one zip per person, with a JSON and CSV
file per module and the person's own sensitive data, available for 7 days.
