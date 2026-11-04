# Data migration and cut-over

How BEAM moves its customers, consents, package balances, memberships, future bookings and
history from SimplyBook, Lightspeed, Mailchimp, spreadsheets and the webinar tool into the
platform, and switches over (ops spec rules 42-53, screens `/admin/imports` and
`/admin/imports/cutover`). Owner: ops. Audience: the owner, management and the technical
administrator; reception and customer service may prepare files and dry runs.

## 1. The rules that protect the data

- **Dry run first.** Every import is uploaded, mapped and dry-run before it runs for real. A dry
  run processes every row and writes nothing outside `imports` and `import_rows`. The real run
  needs a finished dry run of exactly the same mapping (the mapping hash is compared), the
  `settings.write` permission, and in production the completed go-live gate
  (`/admin/system/go-live`).
- **Suppressions first.** Persons and consents imports are refused until a suppressions import is
  done, unless you confirm "no suppression source exists" (stored as a note on the step).
  An import never removes or overrides a suppression: a "subscribed" row for an address that
  unsubscribed is skipped with `suppressed`.
- **Erased people stay erased.** A row whose address belongs to an erased person is skipped with
  `erased`, whatever the old tool still holds.
- **Nothing twice.** Matching goes by the old tool's id (`import_external_ids`), then
  `lower(trim(email))`, then phone plus last name. A file imported twice reports `updated` or
  `skipped`. A second packages file with the same SHA-256 as a finished one is refused unless
  you tick that it is a different file.
- **Existing values win.** A matched person is filled only in empty fields unless "Overwrite filled
  fields" is on. Language, acquisition source and the creation date are never overwritten.
- **History is history.** Past visits, no-shows, purchases and webinar attendance are imported as
  `history` rows. They write only `ops.history_imported` on the timeline: no automation,
  reminder, review request or ledger entry fires for the past.

## 2. Freeze window

| When | What |
| --- | --- |
| Monday-Thursday before | Rehearse every step below on `beam_dev` with real exports; fix the mappings; keep the files. |
| Friday 18:00 | Old tools become **read-only**: no new bookings, sales or sign-ups in SimplyBook, Lightspeed or Mailchimp. Take the final exports (section 3). Tick `old_tools_frozen`. |
| Saturday | Imports in the order of section 5, each dry run checked before its real run. Reconcile and sign off the package balances. |
| Sunday | Recalculate customer statistics (the nightly `ops.refresh_person_stats` run, or start it from `/admin/system/jobs`). Switch DNS, then tick `dns_switched`. |
| Monday | Reception works in BEAM. Keep the exports for 30 days; the raw parts in BEAM expire 30 days after each import finishes and `import_rows` are purged after 30 days. |

## 3. Export settings per tool

Save every file as **CSV UTF-8**. A file in Windows-1252 (the Excel default in Belgium) fails the
parse with "save as CSV UTF-8" and writes nothing. Files up to 50 MB are uploaded in 3 MB parts.

**SimplyBook** (Reports → Export, delimiter `;`, dates `dd/mm/yyyy`)
- Clients: all clients, all fields (preset `simplybook_clients`).
- Bookings from today on: status approved, for future bookings (preset `simplybook_bookings`).
- Bookings before today: all statuses, for history (preset `simplybook_history`; `Status` maps to
  the history kind: approved/confirmed = visit, no show = no_show, cancelled = cancellation).
- Package instances with remaining balance (preset `simplybook_packages`).
- Memberships with "valid until" (preset `simplybook_memberships`).

**Lightspeed** (Reports → Customers and Sales, delimiter `,`, ISO dates)
- Customers (preset `lightspeed_customers`).
- Sales receipts with customer email, total incl. VAT and category (preset `lightspeed_sales`,
  history kind `purchase`).

**Mailchimp** (Audience → Export audience, delimiter `,`)
- Unsubscribed contacts (preset `mailchimp_unsubscribed`) and cleaned contacts
  (`mailchimp_cleaned`, imported as hard bounces): these are the **suppressions**.
- Subscribed contacts (preset `mailchimp_members` for persons, `mailchimp_consents` with consent
  purpose `newsletter` for consents). Only the status column creates consent; never map a "member
  rating" or any other column to a consent.
- Tags (preset `mailchimp_tags`); the tags must exist in `/admin/persons/tags` first.

**Webinar tool** (WebinarGeek `;` and `dd/mm/yyyy`; Zoom `,` and `mm/dd/yyyy`)
- Registrants and attendees per webinar (presets `webinargeek_registrants`,
  `webinargeek_attendees`, `zoom_registrants`, `zoom_attendees`). An attendee row also records
  the registration; map the watched minutes column to `watched_minutes` when the export has one.
  Re-importing the weekly export adds nothing twice. No consent or suppression is ever taken from
  a webinar file.

## 4. Column mapping per source

The presets fill the mapping; check every column before the dry run.

| Kind | Required | SimplyBook | Lightspeed | Mailchimp |
| --- | --- | --- | --- | --- |
| suppressions | email | n/a | n/a | Email Address, UNSUB_TIME / CLEAN_TIME |
| persons | email, or phone and last name | Client ID → external id, Email, Phone, Name → first name, Surname → last name, Zip, City, Created at | Customer ID, Email, Phone, First name, Last name, Zip code, City | LEID, Email Address, First Name, Last Name, Phone, Language |
| consents | email, status (+ purpose column or option) | n/a | n/a | Email Address, Status, CONFIRM_TIME, Source |
| tags | email, tag (column or option) | n/a | n/a | Email Address, TAGS (comma separated) |
| companies | name | n/a | n/a | n/a (B2B lists from a spreadsheet) |
| history | email, occurred at, history kind, external id | Booking ID, Client email, Status, Start date time, Service, Price | Receipt ID, Customer email, Date, Total incl. VAT, Category, Description | n/a |
| packages | email, units remaining, expires on, product | Package instance ID, Client email, Package code → product code, Remaining, Total, Expires | n/a | n/a |
| memberships | email, product code, period ends on | Membership ID, Client email, Membership code, Valid until, Start date, Status | n/a | n/a |
| bookings | email, session start | Booking ID, Client email, Start date time, Service → session kind, Payment method | n/a | n/a |

Amounts: a whole number is read as cents, a number with a decimal separator (`45,00`, `45.50`)
as euros. Dates without a time zone are Brussels time. Product codes are matched on the BEAM SKU
(upper-cased); create the packages and membership plans in BEAM before the import.

## 5. The cut-over checklist (17 steps)

`/admin/imports/cutover` shows each step with who ticked it and when.

1. `go_live_gate_complete`: mirrors platform's go-live gate (all 13 items confirmed).
2. `invoice_issuer_settings_complete` (by hand): finance's company and invoicing identity are
   complete, so invoice PDFs render.
3. `legal_texts_reviewed` (by hand): BEAM reviewed the terms page, the withdrawal notice, the terms
   checkbox label and the receipt footer in nl-BE, fr-BE and en.
4. `dpia_sensitive_processing_decided` (by hand): the DPIA `sensitive_assessment_processing` is
   `approved` or `not_required` and the `health-declaration` form is published.
5. `suppressions_imported`: Mailchimp unsubscribed and cleaned, plus any other opt-out list.
6. `persons_imported`: SimplyBook clients, then Lightspeed customers, then Mailchimp members.
7. `consents_imported`: Mailchimp subscribed contacts (purpose newsletter) and other consent lists.
8. `tags_imported`.
9. `companies_imported`: B2B lists.
10. `history_imported`: SimplyBook past bookings, Lightspeed sales, webinar exports.
11. `packages_imported`: opening balances (section 6).
12. `packages_reconciled`: an owner or management user signs the reconciliation off with a note.
13. `memberships_imported`: imported `active` with the file's period end and no mandate; credits
    then sends its payment-link renewal flow.
14. `future_bookings_imported`: bookings from today on, onto materialised sessions.
15. `stats_recomputed`: ticked when a person-stats run finished after the last import.
16. `old_tools_frozen` (by hand).
17. `dns_switched` (by hand).

Steps 5-14 tick themselves when a matching import is done; the manual steps need
`settings.write`.

## 6. Opening package balances

- Export the SimplyBook balance **after** the future bookings are deducted: the imported future
  bookings consume no credit (booking R65), so the balance in the file must already be net of
  them. Exporting the gross balance would let a customer use the same credit twice.
- Each row becomes one `import` grant with `units = units remaining`, the file's expiry at the end
  of that Brussels day, and the key `import:<import_id>:row:<row_number>`; a re-run never grants
  twice.
- The reconciliation lists per credit kind and product: rows, units in the file, units granted and
  the difference, plus every row whose customer's balance after the import differs from the file
  (typically a grant that already existed in BEAM). Resolve each difference, then sign off.

## 7. When a row or an import fails

- Download the rows with errors (`/admin/imports/<id>/rows.csv`), fix them in the source file and
  import that file as a new import. Row messages are codes such as `invalid_email`,
  `unknown_product`, `no_session`, `over_capacity` (imported, but reception must move one booking),
  `suppressed` and `erased`.
- A run that fails (a chunk failing six times) shows `failed`; fix the cause and press "Run import"
  again: only the rows still pending are processed. A parse failure is final: fix the file and
  create a new import.
- Cancelling a running import keeps the rows already imported; the report says "partial".
- Only one real run touches persons at a time; a second one is refused with "Another import is
  running".
