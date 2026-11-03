# Cross-module decisions (final)

These decisions settle every conflict and declined request in `_reconcile-conflicts.md`. They are binding: where a module spec or `01-architecture.md` says otherwise, the spec changes as listed under "Changes:". Duplicated conflicts are merged into one decision; conflicts that bundle unrelated points are split. Paths under "Changes:" are relative to `docs/plan/`. Nothing here is open.

How the choices were made: the owner's own `api.ts` wins for its module; the architecture wins unless a decision below shows it is outdated; where two owners crossed (each adopted the other's earlier proposal), the simplest rule that one sentence can state for every module wins.

## Conventions confirmed

Every module follows these rules. A spec that breaks one is corrected by the owner without further discussion.

1. **Transactional template keys** are `<m>.<name>`: `<m>` is the folder `packages/email/src/templates/<m>/` (the owning module), `<name>` is snake_case (`^[a-z][a-z0-9_]{1,60}$`) and equals the file basename with `-` replaced by `_` (`replay-available.tsx` -> `webinar.replay_available`). The registry key, the `sendTransactional` `template` value, the automation step `template` value and the `email_templates.slug` of the system row are the same string. Block-backed transactional templates seeded by a module use the same form (`automation.event_reminder_7d`). Marketing template slugs are kebab-case (`^[a-z0-9][a-z0-9-]{2,79}$`, e.g. `webinar-follow-up`). The slash form `<m>/<name>` is retired everywhere. Copy-slot catalogue keys are `<m>.email.<name>.<slot>` in the owning module's catalogue. One file = one key; a module may use `props.variant` inside one template instead of several files, but never two keys for one file. (D1)
2. **Event kinds** are `<entity>.<past_tense_or_fact>` (`booking.confirmed`, `waitlist.offered`, `order.paid`, `membership.past_due`, `credits.threshold_reached`, `person.inactive_days`). `<entity>` is the module id or an entity that module owns; each kind is declared once, in the owning module's `events.ts`, and the registry test rejects duplicates. `data` keys are snake_case; the credit kind is always `data.credit_kind`, never `data.kind`; booking's first-time flags are `data.is_first_booking` and `data.is_first_visit`. (D27, D53)
3. **Settings keys** are top-level snake_case keys (`^[a-z_]+$`) declared once in the owner's `apps/web/modules/<m>/config.ts` with a Zod schema and default, listed in platform's register, and edited only through platform's `updateSetting` (generic editor `/admin/settings/[key]` or the owner's screen submitting `updateSetting`). Every field inside a setting value is snake_case too (`settings.booking_rules.require_health_declaration`, `settings.ai.sensitive_enabled`). (D16, D17)
4. **Retention policy keys** are `<m>.<name>`: `<m>` is the module whose `privacy.ts` `sweep[key]` handler runs the policy, `<name>` is the table name, plus `_<qualifier>` when the table has more than one policy or the policy covers a subset (`finance.invoices`, `booking.bookings_free_text`, `crm.tasks_closed`, `platform.files_export`). The key alone tells who owns it; whoever seeds the row, it is inserted `on conflict (key) do nothing`. (D37)
5. **Idempotency keys** (job keys, email message keys, ledger keys, event `dedupe_key`) are deterministic strings `<noun>:<id>[:<qualifier>...]`: lowercase snake_case nouns, `:` separators, ids as stored (uuid), dates as `YYYY-MM-DD`, minutes as `YYYY-MM-DDTHH:mm` (schedule keys only), counters as integers (`:<n>`), never wall-clock timestamps otherwise. The architecture's list stands (`email:<message_id>`, `automation:<enrolment_id>:<step_key>`, `payment:<provider_payment_id>:<status>`, `privacy:<request_id>:<step>`, `supp:<suppression_id>`, ...). Credits' grant family `grant:<source>:<ref_id>[:<n>]` (`grant:order_line:<id>:<n>`, `grant:voucher:<id>`, `grant:refund:<refund_id>`) is a conforming instance. The message key passed to `sendTransactional` is the `key` field (never `idempotencyKey`), the job that sends it is keyed `email:<message_id>`. (D5)
6. **Feature flags** `ff_<module>_<name>`; **permissions** exactly the architecture section 4 list (no invented names); **job kinds** `<module_or_entity>.<verb_noun>`; **cross-module calls** only through `modules/<m>/api.ts` with the owner's signature, the caller's transaction first (`tx, ctx, input` or `ctx` carrying `ctx.tx`); no aliases are added for a name another module would prefer.
7. **One restriction flag**: `persons.processing_restricted_at` (crm) is the only column any module reads to know that processing is restricted (D12). **One sensitive reader**: `readSensitive(ctx, personId, purpose, scope?)` with platform's signature (D11). **One accounting horizon**: 10 years (3653 days) for every record kept for Belgian accounting law (D34).

## Decisions

### D1. Transactional template key format
- **Answer:** `<m>.<name>` exactly as Convention 1. `email_templates.slug` check stays `(kind = 'transactional' and slug ~ '^[a-z]+\.[a-z][a-z0-9_]{1,60}$') or (kind = 'marketing' and slug ~ '^[a-z0-9][a-z0-9-]{2,79}$')`. Platform's `gen:indexes` templates collector keys `TEMPLATE_REGISTRY` as `<folder>.<declared name>` and fails on a name whose kebab form does not match its file basename, on a duplicate key and on a slash.
- **Reason:** email owns the registry and its slug check, the dot keeps transactional and marketing slugs apart, and one mechanical rule ends the crossed proposals (booking and commerce moved to slashes while email moved to dots).
- **Changes:**
- `modules/email.md`: rule 15a and decision 1: add "`<name>` equals the file basename with `-` replaced by `_`; one file is one key"; `templates/define.test.ts` asserts it; drop the sentence claiming booking and commerce already use dotted keys.
- `modules/platform.md`: the templates collector (around line 825) and its fixture tests key `<m>.<name>` (not `<m>/<name>`); decision 48 and the section 8 slug list become `platform.magic_link`, `platform.staff_invite`, `platform.password_reset`, `platform.mfa_changed`, `platform.monthly_report`.
- `modules/booking.md`: R59 table header and every `booking/<file>` reference (R24, R31, R33, R42, R43, R45, R56, R59-R60, release table, decision 37) become the dotted keys of D2.
- `modules/commerce.md`: opening paragraph, rules 45a and 51, section 6 email row, section 10 email row, P4-P8 file lists and decisions 48 and 66 use the dotted keys of D2 (`commerce.order_confirmation`, ...); decision 48 says "email decision 1: `<m>.<snake_name>`".
- `modules/automation.md`: every `webinar/reminder`, `webinar/replay-available`, `commerce/checkout-recovery`, `booking/...` and `automation/<name>` reference becomes the dotted key; the declined item "email's slug check requires `<module>/<name>`" (decision 50) is reversed: transactional slugs are dotted.
- `modules/crm.md`: `crm/confirm-resubscribe`, `crm/preference-link`, `crm/inbox-reply` become `crm.confirm_resubscribe`, `crm.preference_link`, `crm.inbox_reply`.
- `modules/ops.md`: section 10 email row `ops/privacy-export-ready` and `ops/privacy-erasure-scheduled` become `ops.privacy_export_ready` and `ops.privacy_erasure_scheduled`.
- `modules/credits.md`: template names `membership-started` etc. become `credits.membership_started`, `credits.membership_renewal_reminder`, `credits.membership_renewed`, `credits.membership_payment_failed`, `credits.membership_expired`, `credits.membership_cancel_confirmed`, `credits.share_invitation` (R2), `credits.referral_reward` (R3).

### D2. The registry list of transactional keys
- **Answer:** email section 10 "Provides" lists exactly these keys (the owner's own template set; files kebab-case):
  - platform: `platform.magic_link`, `platform.staff_invite`, `platform.password_reset`, `platform.mfa_changed`, `platform.monthly_report`.
  - crm: `crm.confirm_resubscribe`, `crm.preference_link`, R3 `crm.inbox_reply`.
  - booking (12): `booking.booking_confirmed`, `booking.booking_rescheduled`, `booking.seat_claimed`, `booking.guest_invited`, `booking.booking_cancelled`, `booking.booking_late_cancelled`, `booking.session_cancelled`, `booking.booking_reminder`, `booking.waitlist_joined`, `booking.seat_offered`, `booking.offer_expired`, R2 `booking.lead_window_open`; the QR code is an inline attachment `checkin-qr.png` shown as `cid:checkin-qr.png`.
  - commerce (8): `commerce.order_confirmation`, `commerce.pos_receipt`, `commerce.payment_failed`, `commerce.payment_link`, `commerce.gift_voucher` (with `sendAt`), `commerce.refund_confirmation`, `commerce.portal_invitation`, R2 `commerce.checkout_recovery`.
  - credits (8): as in D1.
  - finance: `finance.invoice`, `finance.credit_note`, `finance.invoice_reminder`, `finance.company_request_decided`.
  - forms: `forms.result`, `forms.result_link`.
  - ops: `ops.privacy_export_ready`, `ops.privacy_erasure_scheduled`.
  - R2 webinar: `webinar.access`, `webinar.reminder` (variant `d7|d3|h3` from `stepKey`), `webinar.rescheduled`, `webinar.cancelled`, `webinar.replay_available`.
- **Reason:** each module owns its template folder and chooses its files; email only registers what the owners declare.
- **Changes:**
- `modules/email.md`: section 10 registry list: replace the booking entry (`booking.confirmation` with variants, `booking.cancellation`, `booking.reminder`, `booking.claim_offer`, `booking.waitlist_update`) by booking's 12 keys and the commerce entry (`commerce.receipt`, ...) by commerce's 8 keys; replace the examples `booking.confirmation` and `commerce.receipt` in rule 15a, decision 1 and the `email_templates.slug` note by `booking.booking_confirmed` and `commerce.order_confirmation`.
- `modules/booking.md`: R59 keys column lists the 12 dotted keys (same files, same variants in `data`, same idempotency keys).
- `modules/commerce.md`: section 6 email row lists the 8 dotted keys (same files).
- `modules/finance.md`: section 8 and every `finance/invoice-issued` / `finance/credit-note-issued` mention use `finance.invoice` and `finance.credit_note`.

### D3. Webinar transactional emails and automation steps
- **Answer:** webinar seeds no transactional `email_templates` rows. `webinar.reminder` and `webinar.replay_available` are code-backed registry templates whose `defineTemplate` declares `loadProps(tx, { personId, locale, context, stepKey })`; the reminder variant `d7|d3|h3` comes from `stepKey`. Automation steps name `webinar.reminder` and `webinar.replay_available` (email's seed creates those system rows). Webinar's only seeded row is the marketing template `webinar-follow-up` through `email.seedTemplate()`. Ids reach templates in `context` (never `variables`).
- **Reason:** email decision 50 and webinar decision 44 already agree; only automation and stale text still name the slash slugs.
- **Changes:**
- `modules/automation.md`: section 3.6 webinar table (`webinar-no-show` step `replay`), section 10 webinar row, automation-P4/P8 dependency lines: `webinar/reminder` -> `webinar.reminder`, `webinar/replay-available` -> `webinar.replay_available`; decision 50 rewritten to "transactional slugs are dotted (cross-module D1)".
- `modules/webinar.md`: remove any remaining mention of seeded rows `webinar-reminder` / `webinar-replay-available`; section 8 states the five dotted keys and the one marketing seed `webinar-follow-up`.
- `modules/email.md`: no change beyond D2 (decision 50 stands).

### D4. Who writes template code and copy
- **Answer:** module `<m>` writes every file in `packages/email/src/templates/<m>/` (components, props schemas, `index.ts` with `defineTemplate()` entries) and its copy in `<m>.email.*` of its own catalogue. Email owns `templates/email/`, `templates/define.ts`, the shared layout, footer, renderer, block compiler, the generated registry and the seeding of system rows. Finance adds `isCourtesyCopy`, `decision` and `note` to its own props schemas; forms writes `forms.result` (`FormResultProps` with `pendingConfirmation`) and `forms.result_link` (`FormResultLinkProps`).
- **Reason:** architecture sections 1 and 11 give each template folder to its module; email decision 52 confirms it.
- **Changes:**
- `modules/finance.md`: section 8: replace "templates owned by email, copy in `email.json` under `email.tpl.finance.*`, props exported by email" with "finance owns `templates/finance/`, its props schemas and its `finance.email.*` copy"; owner paths list `packages/email/src/templates/finance/`.
- `modules/forms.md`: sections 8 and 10: forms writes `forms.result` and `forms.result_link` in `packages/email/src/templates/forms/`; owner paths include that folder.

### D5. `sendTransactional` call shape
- **Answer:** `email.sendTransactional(ctx, { template, personId?, to?, locale, data, key, attachments?: { fileId, filename, inline? }[], context?, sendAt?, replyTo?, headers? }): Promise<{ emailMessageId: string; jobId: string }>` (the Wave 0 stub shape). Suppression and translation are decided later by `email.send`, so the call never returns a status. Callers use `data` (not `props`), `key` (not `idempotencyKey`), `to` (not `toEmail`), and no `purpose`.
- **Reason:** one published signature, already in platform section 4.9 and email section 4.
- **Changes:**
- `modules/forms.md`: section 10 email row and edge cases: expected result `{ messageId, status, created }` becomes `{ emailMessageId, jobId }`; every `props`/`idempotencyKey`/`toEmail` becomes `data`/`key`/`to`.
- `modules/finance.md`: every `sendTransactional` call text uses `data`, `key`, `to`, `attachments`.
- `modules/webinar.md`: every `sendTransactional` call text uses `data` and `key` (no `idempotencyKey`, no `variables`).
- `modules/commerce.md`: section 6 and 10 email rows add `context?`, `replyTo?`, `headers?` as optional and keep `{ emailMessageId }` as the stored result.

### D6. Wave 0 email framework files
- **Answer:** platform-P3 writes in Wave 0 `packages/email/src/templates/define.ts` with email's final `defineTemplate({ name, component, props, slots, attachments?, loadProps? })` signature, `packages/email/src/layout.tsx`, `packages/email/src/render.ts`, and platform's five templates in `templates/platform/`. email-P2 edits (does not create) these files. The `gen:indexes` collectors for templates and merge fields are part of platform-P1 (Wave 0); no orchestrator step is needed before Wave 1.
- **Reason:** platform's sign-in emails must work on night one and one owner per file per wave holds.
- **Changes:**
- `modules/email.md`: email-P2 "Files": `define.ts`, `layout.tsx`, `render.ts` are edits of the Wave 0 files, not creations; drop any orchestrator step for the collectors.
- `modules/platform.md`: section 10 and the seed list contain all five platform keys (D2).

### D7. Automation's email-step API
- **Answer:** email's signatures stand: `queueMarketingEmail(ctx, input)` for marketing templates and `queueAutomationEmail(ctx, input)` for transactional ones, `input: AutomationEmailInput = { templateSlug, personId, enrolmentId, idempotencyKey, context?, stepKey? }` (`idempotencyKey = automation:<enrolment_id>:<step_key>`), result `{ messageId, status: 'queued' | 'skipped_unreachable' | 'skipped_translation', created, templateVersionId }`. Automation picks the function from `getPublishedTemplateInfo(tx, [slug]).kind`, always passes `context` and `stepKey`, and writes the run outcome equal to the returned status (`sent` for `queued`). `getTemplateInfo` remains for single lookups.
- **Reason:** email owns the functions and its statuses already match `automation_runs.outcome`.
- **Changes:**
- `modules/automation.md`: section 10 email row, A-31, decision 55 and automation-P3 tests: replace `queueAutomationEmail(tx, {...})` returning `queued | blocked_translation | suppressed` with email's two functions and statuses above; the `suppressed -> skipped_unreachable` mapping test becomes "status passed through".
- `modules/email.md`: no change.

### D8. Suppression exit path
- **Answer:** `crm.addSuppression(tx, ctx, { email, scope, reason, source, personId? })` is the only writer of `suppressions`; in the same transaction it calls `automation.requestSuppressionExit(tx, { suppressionId })`, which enqueues `automation.exit_for_suppression` (lane `fast`, key `supp:<suppression_id>`). crm does not enqueue the job itself, and email never enqueues it (email's unsubscribe, complaint and bounce paths call `crm.addSuppression`).
- **Reason:** one code path for every source of a suppression; the owner of the job exposes the function.
- **Changes:**
- `modules/automation.md`: section 10 (the sentence "email's unsubscribe, complaint and bounce paths enqueue `automation.exit_for_suppression`") reads "`crm.addSuppression` calls `automation.requestSuppressionExit`; email never enqueues it"; drop "crm rule 16 already enqueues ... either path yields the same job".
- `modules/crm.md`: rule 16: call `automation.requestSuppressionExit(tx, { suppressionId })` instead of enqueueing the job.
- `01-architecture.md`: section 7 "Fast unsubscribe": "... insert `suppressions` through `crm.addSuppression`, which calls `automation.requestSuppressionExit` to enqueue `automation.exit_for_suppression` (key `supp:<suppression_id>`, lane `fast`) in the same transaction".

### D9. Preference and unsubscribe link tokens
- **Answer:** every non-test `email_messages` row has a fresh 32-byte link token whose sha256 hex is `email_messages.link_token_hash` (unique). crm's routes resolve it with `email.resolveLinkToken(db, token)`; URLs come from `crm.buildPreferenceUrls(linkToken, locale)`. No stateless signed tokens.
- **Reason:** architecture section 10 stores hashes of preference tokens; email already adopted crm's model.
- **Changes:**
- `modules/email.md`: none (rule 53 and `resolveLinkToken` stand).
- `modules/crm.md`: section 4.4: remove the request text that email "must add" `resolveLinkToken` (done); decisions 17 and 57 stand.

### D10. Inbound email (R3)
- **Answer:** email's Resend handler maps `email.received` to `crm.ingestInboundEmail(tx, ctx, { messageId, inReplyTo?, from, fromName?, subject, text, attachmentCount, receivedAt })`, returning `{ threadId }`.
- **Reason:** crm api functions take the caller's transaction; the Resend payload format belongs to email.
- **Changes:**
- `modules/email.md`: email-P9 and rule 37/R3 dispatch text name the mapped fields above (no `{ payload }`).

### D11. `readSensitive` signature
- **Answer:** `readSensitive(ctx: Ctx, personId: string, purpose: 'staff_view' | 'privacy_export' | 'subject_result', scope?: { keys?: SensitiveFieldKey[]; eventIds?: string[]; submissionIds?: string[] }): Promise<SensitiveBundle>`, `SensitiveBundle = { fields: Partial<Record<SensitiveFieldKey, string>>; formAnswers: { submissionId; fieldKey; value }[]; notes: { eventId; body }[] }`. `staff_view` needs a staff actor with `persons.sensitive_read`; `privacy_export` needs the system actor; `subject_result` needs the system actor and a non-empty `submissionIds` of the person's own submissions. The purposes `care` and `customer_request` and the field `events` do not exist.
- **Reason:** platform owns `apps/web/lib/sensitive.ts` (frozen after Wave 0) and its decision 70 already serves both crm and forms.
- **Changes:**
- `modules/crm.md`: rule 24, rule 26 (`'care'` -> `'staff_view'`), the `revealSensitive` action row (map `notes` straight from the bundle's `notes`), section 10 platform row and decisions 41 and 53: use platform's signature and bundle.
- `modules/platform.md`: decision 53: delete "takes crm's purposes (`care`, `customer_request`, `privacy_export`)"; decision 70 stands.
- `modules/forms.md`: none (SE3 and decision 9 already match).
- `01-architecture.md`: section 4: `readSensitive(ctx, personId, purpose, scope?)` with the three purposes above.

### D12. Processing restriction flag
- **Answer:** `persons.processing_restricted_at` (timestamptz, crm) is the one flag; `crm.restrictProcessing` sets and clears it; ops' `processing_restrictions` table keeps the request record (ground, request id) but no other module reads it. Automation's condition `{ processing_restricted: true }` and rule A-11 read `persons.processing_restricted_at is not null`.
- **Reason:** one restriction flag already drives `v_suppression_status`, `v_marketing_reachability`, segments and `v_person_profile` (crm decision 44, ops decision 66).
- **Changes:**
- `modules/automation.md`: A-11, the condition comment in section 2 ("processing_restrictions row exists (ops)"), the tables-read row for ops and the automation-P2 dependency: read `persons.processing_restricted_at`; drop `ops:processing_restrictions`.
- `modules/forms.md`: section 9: refer to `persons.processing_restricted_at`, not the `processing_restrictions` table; section 10 ops row likewise.

### D13. Writing person fields (`updatePersonFields`)
- **Answer:** the one write path for person columns is `crm.updatePersonFields(tx, ctx, personId, patch: PersonFieldPatch, { onlyEmpty: boolean })`; `fillAcquisitionIfEmpty(tx, ctx, personId, acquisition)` is the one path for `acquisition`. `PersonFieldPatch` accepts, besides the existing fields, `preferredChannel`, `emergencyContact: { name: string; phone: string; relation?: string }` and `externalIds: Partial<Record<'simplybook' | 'lightspeed' | 'mailchimp' | 'sheet' | 'webinargeek' | 'typeform' | 'scoreapp', string>>` (merged key by key into `persons.external_ids`; with `onlyEmpty: true` an existing key is kept). No `setPreferredChannel`, `updatePersonProfile` or `setAcquisitionIfEmpty` is added. Mapping for callers: "fill empty" = `{ onlyEmpty: true }`, "overwrite" = `{ onlyEmpty: false }`.
- **Reason:** crm owns its api and adds no aliases (crm section 4.8); the three requested fields are plain columns of `persons`.
- **Changes:**
- `modules/crm.md`: section 4.8 `PersonFieldPatch` adds `emergencyContact` and `externalIds` with the source list above; section 2 documents `persons.emergency_contact jsonb` if not present.
- `modules/automation.md`: `set_field` uses `updatePersonFields(..., { onlyEmpty: false })` (decision 56 stands); remove any remaining `setPreferredChannel`.
- `modules/forms.md`: every `updatePersonProfile(..., { mode })` / `setAcquisitionIfEmpty` becomes `updatePersonFields(..., { onlyEmpty })` / `fillAcquisitionIfEmpty`.
- `modules/booking.md`: the night-booking emergency contact is written with `crm.updatePersonFields(tx, ctx, personId, { emergencyContact }, { onlyEmpty: true })` (as stated; no change beyond confirming the field name).
- `modules/ops.md`: rule 50 writes legacy ids with `updatePersonFields(tx, ctx, personId, { externalIds: { <source>: <id> } }, { onlyEmpty: true })`.

### D14. `crm.createTask` call shape
- **Answer:** `crm.createTask(tx, ctx, { title, kind, ownerUserId? , ownerRole?, personId?, companyId?, dueAt, priority?, source: 'manual' | 'automation' | 'retention' | 'system', ref?: { type: string; id: string }, dedupeKey?, notes? })` with `source` required. Credits passes `source: 'system'` and `ref: { type, id }`; no flat `refType`/`refId`.
- **Reason:** crm's published signature; a required source keeps task reports honest.
- **Changes:**
- `modules/credits.md`: every `createTask` call (rule 50a dunning tasks, sharing review) uses `ref: { type, id }` and `source: 'system'`.
- `modules/crm.md`: none.

### D15. House rules, health declaration and guardian consent
- **Answer:** house rules and the health self-declaration are chapters of site's `terms`, checked with `site.hasAcceptedCurrentTerms(db, personId)`; the detailed health declaration is forms' `health-declaration` form, checked with `forms.hasValidSubmission(db, { personId, formSlug: 'health-declaration' })` (365-day validity). crm's `person_declarations` keeps only kind `guardian_consent`; its text and version come from `site.getCurrentLegalVersion(db, 'guardian_consent')` returning `{ versionId, version, requiresReacceptance, text }`. crm keeps `recordDeclaration`, `revokeDeclaration` and `hasValidDeclaration(db, { personId, kind: 'guardian_consent' })` typed to that one kind; `acceptMyDeclaration` is removed. `crm.getReceptionCard().declarations = { termsAccepted, healthDeclarationValid, guardianConsentValid }`, built from site, forms and crm.
- **Reason:** one record per fact; two copies of the house rules would drift (site decision 54, booking decision 39).
- **Changes:**
- `modules/crm.md`: section 2 enum `person_declarations_kind` = `guardian_consent` only; sections 4.8 and 10, edge case 32 and line ~650 stop saying booking reads `hasValidDeclaration`; `getReceptionCard` builds `declarations` as above; remove `acceptMyDeclaration`.
- `modules/booking.md`: none (already reads site and forms); the reception card uses crm's `getReceptionCard`.
- `modules/site.md`: none (decisions 54 and 55 stand).

### D16. Booking settings field names
- **Answer:** fields inside `settings.booking_rules` and `settings.business_hours` are snake_case (Convention 3): `require_health_declaration` (boolean, default `false`), `reminder_hours_before` (`{ day: [24], night: [48], event: [] }`), `guest_abuse`, `max_reschedules_per_booking`, `offer_cutoff_minutes_before_start`, `min_claim_minutes`, `max_offers_per_person_per_session`, `opens_at`, `closes_at`, `special_hours`, and every other camelCase field renamed the same way. Booking never blocks check-in or staff bookings on `require_health_declaration`.
- **Reason:** every other setting (platform, commerce, credits, finance, email, site, automation, ops, architecture's `settings.ai`) is snake_case; one rule beats one exception.
- **Changes:**
- `modules/booking.md`: the `BookingRules` and `BusinessHours` Zod schemas (section 2, around lines 298-335) and every rule that names a field (R24, R31, R42, R60, 3.0b, decisions 49 and 55) use the snake_case names; decision 49 says snake_case.
- `modules/forms.md`: rule ID11 and section 10 name `settings.booking_rules.require_health_declaration`.
- `modules/automation.md`: `reminderHoursBefore.event` -> `reminder_hours_before.event`.

### D17. Settings register
- **Answer:** the register (platform section 2) is complete with one addition: platform `ai`, `last_tick_at`, `company`, `go_live_gate`, `security`, `support`; booking `booking_rules`, `business_hours`; commerce `commerce`, `payment_provider_by_channel`; credits `credits`, `referrals` (R3); finance `finance`; email `email_footer`, `warmup_schedule`, `email_config`, `email_brand`; automation `automation_cursor`, `automation_rules`; ops `retention_defaults`, `ads` (R3, `{ meta_account_ids: string[], google_customer_ids: string[] }`); site `site`; crm `inbox` (R3). `company` (`legal_name`, `trade_name`, `vat_number`, `enterprise_number`, `address`, `support_email`, `phone`, `website`) and `finance` are edited only through platform's generic editor (`/admin/settings/[key]`, `updateSetting` with `expectedVersion`); `finance.issuer` holds only `register_court`, `iban`, `bic`, `invoice_footer`. No module calls `setSetting` from a form; ops' `setSetting` use is limited to system keys it owns.
- **Reason:** one register keeps `gen:indexes` duplicate detection meaningful; issuer identity lives once, in `company`.
- **Changes:**
- `modules/platform.md`: section 2 register and decision 76 add ops `ads`; the `company` bullet replaces "finance's company form writes it through `setSetting()`" with "edited through the generic editor (`updateSetting`, PL-41)"; the Wave 0 `config.ts` placeholder and seed for `finance` carry no `enterprise_number` or `website`.
- `modules/ops.md`: decision 9 and section 10 platform row: `ads` is declared in `apps/web/modules/ops/config.ts`; `setSetting` is replaced by `updateSetting` for staff edits.
- `modules/finance.md`: none (decisions 47 and 48 stand).
- `01-architecture.md`: section 2 `settings` keys list becomes the register above.

### D18. Referral code capture
- **Answer:** the referral code lives in site's `beam_ref` cookie. The request handlers that create persons read it with `site.readReferralCode()` and pass it as `acquisition.referral_code` to crm: forms' submit route, commerce's checkout, platform's customer sign-up and webinar's registration route. crm resolves it through `credits.resolveReferralCode` when the person is created (crm rule 3.4). `FormEmbed` context is `{ pagePath, utm?, landingPath?, referrer?, partnerCompanyId? }` with no `referralCode`.
- **Reason:** crm api functions have no request object, and a signed context must not carry a forgeable code.
- **Changes:**
- `modules/crm.md`: the R3 referral item says callers pass `acquisition.referral_code`, including persons created by forms.
- `modules/forms.md`: forms-P9 submit route reads `site.readReferralCode()` (stated; confirm in section 10 site row).
- `modules/commerce.md`: checkout passes `acquisition.referral_code` from `site.readReferralCode()` when it creates the person.
- `modules/webinar.md`: the public register route passes `acquisition.referral_code` from `site.readReferralCode()`.
- `modules/platform.md`: customer sign-up passes `acquisition.referral_code` from `site.readReferralCode()`.

### D19. Person merge and webinar registrations
- **Answer:** crm's merge calls `webinar.mergePersons(tx, winnerPersonId, loserPersonId): Promise<{ moved: number; collapsed: number }>` before the generic repoint, and `webinar_registrations` is `skip` in `MERGE_STRATEGIES`. The hook never sets `beam.allow_rewrite`. A loser registration for a webinar the winner is not registered for is repointed to the winner (`moved`). When both are registered, the loser's registration stays on the loser id with its append-only `watch_segments` and `webinar_interactions` (`collapsed` counts these); webinar's stats, exports and erasure read registrations of `crm.resolvePersonIds(tx, personId)` and merge watch intervals across them per mode; poll answers keep the earliest per poll and mode.
- **Reason:** `beam.allow_rewrite` is reserved for erasure (architecture section 2, crm decision 52).
- **Changes:**
- `modules/webinar.md`: edge case 19 rewritten as above (no move of segments, no deletion, no `allow_rewrite`); `v_webinar_watch` and `v_person_webinar_stats` group by the resolved person.
- `modules/crm.md`: none.

### D20. Credits merge hook
- **Answer:** crm refuses to merge two persons who both have an `active` or `past_due` membership (crm rule 3.31). Credits' `onPersonsMerged(tx, ctx, { winnerPersonId, loserPersonId })` handles `credit_grants`, `memberships`, `package_shares`, R3 `referral_codes` and `referral_attributions`, which are `skip` in the generic repoint; its branch for two live memberships stays as a defensive path that throws `ConflictError('both_members')`.
- **Reason:** the precondition belongs to the merge owner; the hook only defends.
- **Changes:**
- `modules/credits.md`: rule 35: the "two active memberships" branch becomes a defensive `ConflictError('both_members')` with a note that crm prevents it.
- `modules/crm.md`: none.

### D21. Booking-originated orders and the order hooks
- **Answer:** booking inserts the `reserved` rows first under its session lock, then calls `commerce.createOrder(tx, ctx, { personId, companyId?, channel, items, promoCode?, clientKey, checkoutId?, locale, useEuroCredit?, note?, expiresAt? })` with one item per seat `{ productId, quantity: 1, sessionId, ticketTypeId?, bookingIds: [bookingId] }`. Commerce stores them in `order_lines.data.booking_ids`, returns `{ orderId, reference, lineIds, totalCents, status, expiresAt, isExisting }` with `lineIds` in item order, and never calls booking inside `createOrder`. `expiresAt` is accepted only for channel `admin` (pay-at-desk orders expire at the session's `ends_at`). Booking sets `order_line_id`, `reserved_until` and its own pay-at-desk marker on its rows. The hooks are booking's: `confirmBookingsForOrder(tx, ctx, { orderId }) -> { confirmedBookingIds, unavailableOrderLineIds }` (paid transaction), `releaseBookingsForOrder(tx, ctx, { orderId, reason: 'payment_expired' | 'payment_failed' | 'order_cancelled' })` (expiry, failure, cancellation), `cancelBookingsForOrderLine(tx, ctx, { orderLineId, reason: 'refunded' })` (staff refund) and `createBookingForPosLine(tx, ctx, { orderLineId, sessionId, personId }) -> { bookingId }` (POS walk-in; throws `ConflictError('session_full' | 'member_only' | 'already_booked')`, mapped to `sold_out`). `booking.reserveForOrderLine`, `confirmOrderBookings`, `releaseOrderBookings`, `CartItem.attendeePersonId` and `createOrder({ isPayAtDesk })` do not exist. Customers pay at `/[locale]/account/checkout/[orderId]`.
- **Reason:** booking owns capacity and its rows; this flow has no re-entrant call from commerce back into booking inside one `createOrder`, and the hook names are booking's own api.
- **Changes:**
- `modules/commerce.md`: rules 21, 22 (expiry calls `releaseBookingsForOrder` with `payment_expired`), 22b, 32; `CartItem` (add `bookingIds?: string[]`, drop `attendeePersonId`); `createOrder` signature (drop `isPayAtDesk`); `order_lines_session_chk` keeps quantity 1 and requires one `booking_ids` element except for channel `pos`; section 10 booking row; P3/P6 depends-on and tests (`reserveForOrderLine` -> `bookingIds`/`createBookingForPosLine`); decisions 39, 59, 79.
- `modules/booking.md`: state table line ~388 (`confirmOrderBookings` -> `confirmBookingsForOrder`, `reserveForOrderLine` row removed); `reserveForOrderLine` removed from api and tests; R18 stands.

### D22. Late payment when the seat is gone
- **Answer:** when `confirmBookingsForOrder` returns `unavailableOrderLineIds`, commerce refunds each line automatically through `refundOrderLine(tx, ctx, { orderLineId, reason: 'seat_no_longer_available' })` (job `commerce.refund_unavailable_lines`); no customer-service task is opened.
- **Reason:** the money goes back in seconds and nobody has to act (commerce decision 69).
- **Changes:**
- `modules/booking.md`: edge case 3 and the R18/api comment on `confirmBookingsForOrder` say commerce refunds the lines automatically with reason `seat_no_longer_available`.
- `modules/commerce.md`: none (decision 71 closed).

### D23. Desk payments
- **Answer:** pay-at-desk orders are paid at `/admin/pos?order=<orderId>` with commerce's `posPayOrder`; booking R44 and R63 link there and pass `expiresAt` (the session's `ends_at`) with channel `admin`.
- **Reason:** the POS owns card-terminal and cash payments.
- **Changes:**
- `modules/booking.md`: R44 and R63 use `/admin/pos?order=<orderId>` and `createOrder({ channel: 'admin', expiresAt })` (no `isPayAtDesk` argument).
- `modules/commerce.md`: none beyond D21.

### D24. Package grant inputs
- **Answer:** in the paid transaction commerce calls `credits.grantCredits` once per unit of `order_lines.quantity` with `{ personId, kind, units: products.credit_units, source: 'purchase', productId, orderLineId, lineUnitIndex, unitValueCents, vatRatePct, startsAt, expiresAt, key: 'grant:order_line:<order_line_id>:<n>' }`, where `startsAt` = `order_lines.data.start_on` 00:00 Europe/Brussels when set, else `orders.paid_at`, and `expiresAt` = `computeExpiresAt(startsAt, products.validity_days)` from `@beam/core/credits`. Credits reads nothing from `order_lines.data` or `options`; there is no per-line `credit_units` override.
- **Reason:** commerce owns `order_lines`; credits keeps a narrow input contract.
- **Changes:**
- `modules/credits.md`: rule 1 drops "`starts_at` = `order_lines.data.start_on`" in favour of "the `startsAt` commerce passes"; section 2 tables-read row drops `order_lines.data.start_on`; section 10 commerce row likewise; decision 50 updated.
- `modules/commerce.md`: rule 32 states the input above.

### D25. Partial refund of a credit-balance payment
- **Answer:** a partial refund of an order paid partly with euro credit restores the euro part with `credits.grantCredits(tx, ctx, { personId, kind: 'euro', units: <cents>, source: 'manual', refundId, vatRatePct: null, expiresAt: null, key: 'grant:refund:<refund_id>', reason: 'partial_refund' })` (multi-purpose VAT, kept on erasure, credits rule 20a). `releaseCredits` has no `amountCents`: each release mirrors exactly one consume. A full refund or order expiry uses `releaseCredits(tx, ctx, { ref: { type: 'order', id: orderId }, reason })`.
- **Reason:** the partial unique index on `reverses_entry_id` keeps release one-to-one with consume (credits decision 51c).
- **Changes:**
- `modules/commerce.md`: rule 38 passes `refundId` and the key above; package expiry uses `computeExpiresAt` (D24).
- `modules/credits.md`: none (rule 20a stands).

### D26. Credits function names commerce calls; voucher redemption source
- **Answer:** commerce calls only credits' names: `grantCredits` (packages per unit, `source: 'voucher'` with key `grant:voucher:<voucher_id>` and multi-purpose VAT when a gift voucher is redeemed), `consumeCredits` / `releaseCredits` with `ref: { type: 'order', id }` (euro credit at checkout), `revokeGrantRemainder` (refunded package line), `activateMembership`, `applyRenewalPayment`, `applyRenewalFailure`, `getMembershipForPerson`, `canStartMembership`, `getEuroBalance`. The names `fulfilOrderLines`, `onOrderPaymentFailed`, `redeemEuroCredits`, `releaseEuroRedemption`, `getMemberBenefits`, `revokeForRefund` and `grantVoucherCredit` do not exist. A voucher redemption is never `source: 'purchase'`.
- **Reason:** two names for one operation would split idempotency keys, and a voucher holder paid nothing, so must not become a customer or fire package thresholds (crm rule 3.8).
- **Changes:**
- `modules/commerce.md`: verify P3, P5 and decisions 10, 40, 41 carry no retired name (the current text already uses credits' names; any remaining occurrence is replaced).
- `modules/credits.md`: none.

### D27. Credit kind field in credits events
- **Answer:** every credits event carries `data.credit_kind`: `credits.threshold_reached { grant_id, credit_kind, pct, remaining_units }` (`pct` in `50|75|80|90|'last_unit'`), `credits.grant_exhausted { grant_id, credit_kind, source, product_id }`, `credits.expiry_approaching { grant_id, credit_kind, days, remaining_units }`.
- **Reason:** automation reads `data.credit_kind`; one name per field across the event catalogue (Convention 2).
- **Changes:**
- `modules/credits.md`: rule 21 and the section 4 event list show `credit_kind` for all three events (the event list line `credits.threshold_reached { pct }` becomes the full shape).
- `modules/automation.md`: none (already reads `data.credit_kind`).

### D28. Derived status `v_person_status`
- **Answer:** `member` if an `active` or `past_due` membership; else `customer` if the person has a paid order with `total_cents > 0` containing a line whose `order_lines.product_kind` is `session`, `night`, `package`, `membership` or `ticket`, or a `credit_grants` row with `source in ('purchase','import')` and `credit_kind in ('day','night')`; else `lead`; then `coalesce(status_override, derived)`.
- **Reason:** blueprint 3 and 19 and crm rule 3.8 define a customer by a paid experience, not any order (a voucher buyer or a merchandise buyer is not a customer).
- **Changes:**
- `01-architecture.md`: section 2 credits views: replace "`customer` if any paid order" with the definition above.
- `modules/credits.md`: none.

### D29. Credits views read by finance
- **Answer:** credits keeps these names stable: `v_credit_liability`, `v_credit_movements_monthly (month_on, credit_kind, vat_treatment, vat_rate_pct, entry_kind, units, value_cents)`, `v_euro_voucher_redemptions (entry_id, grant_id, person_id, order_id, amount_cents, redeemed_at, is_reversed)` and `getCreditLiabilityAsOf(db, at: Date)`. Finance reads no `credit_grants` or `credit_entries` directly.
- **Reason:** a view contract lets credits change its tables without breaking finance's R3 reports.
- **Changes:**
- `modules/credits.md`: section 2 views state these exact columns and mark them "contract with finance".
- `modules/finance.md`: none.

### D30. Invoice functions as commerce calls them
- **Answer:** `finance.issueInvoice(tx, ctx, { orderId, status?: 'paid' | 'open', dueOn?, paymentId?, paidAt?, settledVia? })` returning `{ invoiceId, number, created }` (`created: false` = existing), and `finance.getInvoiceForOrder(db, orderId)`.
- **Reason:** finance owns the signatures; commerce rule 43 already uses them.
- **Changes:**
- `modules/commerce.md`: section 10 finance row replaces `issueInvoice(tx, ctx, {orderId, paymentId?, settlement: 'paid'|'open'})` and `getInvoiceForOrder(tx, ...)` with the shapes above.

### D31. Full manual credit note on an open bank-transfer invoice
- **Answer:** finance's action calls `commerce.cancelOrder(tx, ctx, { orderId, reason })` inside its own transaction. `cancelOrder` keeps calling `finance.issueCreditNote(tx, ctx, { orderId, reason, noRefund: true })` in the same transaction and returns `{ cancelled: boolean }`; when the order is not cancellable it returns `{ cancelled: false }` (no throw) and finance fails the action with `finance.errors.order_not_cancellable`. `issueCreditNote` is idempotent on (order, reason) so the nested call cannot issue two notes.
- **Reason:** one transaction, one credit note, and the caller decides the error message (finance rule 25, decision 50).
- **Changes:**
- `modules/commerce.md`: rule 22b and the api: `cancelOrder` returns `{ cancelled: boolean }` and never throws for a non-cancellable status.
- `modules/finance.md`: none.

### D32. Settling bank transfers
- **Answer:** `commerce.recordBankTransferPaid(tx, ctx, { orderId, paidOn: 'YYYY-MM-DD', reference })` (idempotent on the order) is called by finance's `markInvoicePaid` and by `billit.sync_pending`. Commerce has no "Record bank transfer" button; the order screen links to finance's invoice.
- **Reason:** one entry point per state change; finance holds the amount check (finance rule 26).
- **Changes:**
- `modules/finance.md`: rule 27: delete "Commerce's own 'Record bank transfer' button on the order screen reaches the same state through rule 2a".
- `modules/commerce.md`: none (rule 43a and decision 75 stand).

### D33. Credit-note sign in revenue views
- **Answer:** finance stores every credit-note amount, including `vat_cents`, as a negative number (`chk_invoices_vat_sign`). Ops' `v_revenue_daily` uses `refunds_vat_cents = -coalesce(sum(cn.vat_cents), 0)` and the same negation for the other credit-note amounts.
- **Reason:** the stored sign is finance's, enforced by a check constraint.
- **Changes:**
- `modules/ops.md`: `v_revenue_daily` definition and its note ("stored positive on credit notes by finance" -> "stored negative; negated here").

### D34. Accounting retention horizon (invoices and linked records)
- **Answer:** 10 years = 3653 days (Belgian law of 20 November 2022), counted from 1 January after the fiscal year of the record. Policies: `finance.invoices` 3653 days `anonymise` (after the horizon: `person_id` and `company_id` null, `customer_snapshot` reduced to `{ "anonymised": true }`, PDF file deleted; totals, lines and numbers kept for the sequence); `commerce.orders` 3653 `anonymise`; `commerce.lightspeed_sales` 3653 `delete`; `credits.ledger` 3653 `delete`; `credits.memberships` 3653 `delete` (after `ended_at`); `site.terms_acceptances` 3653 `delete`. No sweep touches a record younger than 3653 days; erasure before then reduces invoices as architecture section 10 says (`retained_legal`).
- **Reason:** the 7-year figure is outdated law; one horizon for every accounting-linked record avoids a ledger or acceptance being deleted before the invoice it supports.
- **Changes:**
- `01-architecture.md`: section 10 retention defaults: "invoices 7 years" -> "invoices and accounting-linked records 10 years (3653 days, from 1 January after the fiscal year), then anonymise".
- `modules/ops.md`: seed row 90 becomes `finance.invoices`, 3653, `anonymise`; decision 40 and the "invoices retention" note updated; withdraw nothing else.
- `modules/finance.md`: rule 45, section 9 retention text and decision 53: 3653 days `anonymise` from the fiscal-year end (the 10-year floor is the policy itself).
- `modules/platform.md`: privacy text keeps 10 years (3653 days); decisions 86 and 94 point to this decision.
- `modules/commerce.md`: retention `commerce_orders` and `commerce_lightspeed_sales` 2555 -> 3653 (keys per D37).
- `modules/credits.md`: retention `credits.ledger` and memberships 2555 -> 3653 (keys per D37).
- `modules/site.md`: `terms_acceptances` 2555 -> 3653 (decision 31 text "7-year retention with the invoices" -> "10-year").

### D35. Provider-side erasure (Resend, Billit, Mollie mandates)
- **Answer:** ops' `privacy.erase_external` performs every external erasure before the local steps, while the address is still known: providers `billit` (finance's `getBillitCustomerRef` then `BillitApi.anonymiseCustomer`), `mandates` (commerce's `revokeMandatesForPerson`) and `resend` (email's `ResendClient.deleteContact(email)`, 404 = `not_found`), each with key `privacy:<request_id>:r<run_attempt>:external:<billit|mandates|resend>`. There is no `email.erase_provider_data` job, no `recordExternalOutcome` and no `SET LOCAL beam.privacy_request_id`; the erase step transaction sets only `SET LOCAL beam.allow_rewrite = 'on'`. The `PrivacyRegistration` signature `erase(tx, personId)` is unchanged.
- **Reason:** ops already orchestrates Billit and mandates this way; one pattern for all providers is simpler than a second callback path, and email decision 51 asked for it.
- **Changes:**
- `modules/ops.md`: rule 62 adds `resend` to the external step; rules 63 and edge case 35 report the Resend outcome from `privacy.erase_external`; remove `recordExternalOutcome` (section 4.7, ops-P exposes list), the `beam.privacy_request_id` setting (job table `privacy.erase_step`, ops-P tests), the Resend row of section 6 ("not called by ops") and decision 68 (replaced by this decision); section 10 email rows name `ResendClient.deleteContact`.
- `modules/email.md`: none (decision 51 stands; the client method stays exported for ops).
- `01-architecture.md`: section 10 privacy workflows: "external providers (Billit anonymise customer, Resend delete contact, revoke Mollie mandates) are called first by `privacy.erase_external`, then the module handlers run".

### D36. Whole-profile anonymisation keys
- **Answer:** ops owns `ops.marketing_profile` (persons with no activity for 3 years, 1095 days, anonymise, candidates from `crm.listInactiveProfiles`) and `ops.marketing_contact` (leads, 730 days, anonymise). crm seeds no `crm.inactive_profile` row; crm's own rows (`crm.declarations_superseded` 1095, `crm.duplicate_candidates_closed` 365, `crm.tasks_closed` 730, R3 `crm.inbox_resolved` 730) stay.
- **Reason:** each key has one owner; ops runs whole-profile erasure.
- **Changes:**
- `modules/crm.md`: section 9 retention table drops `crm.inactive_profile` and names `ops.marketing_profile` as the 3-year rule.
- `modules/platform.md`: section 9 "anonymised together with the marketing profile by crm's sweep" -> "by ops' `ops.marketing_profile` sweep".

### D37. Retention policy key renames
- **Answer:** every `retention_policies.key` follows Convention 4. The full mapping (old -> new; days and actions unchanged unless D34 says otherwise):
  - ops: `marketing_contact` -> `ops.marketing_contact`; `marketing_profile` -> `ops.marketing_profile`; `import_rows` -> `ops.import_rows`; `nl_questions` -> `ops.nl_questions`; `data_exports` -> `ops.data_exports`; `retention_lists` -> `ops.retention_lists`; `privacy_requests` -> `ops.privacy_requests`.
  - forms: `form_sensitive_answers` -> `forms.form_sensitive_answers`; `form_submissions` -> `forms.form_submissions`; forms' five own rows -> `forms.<table>[_<qualifier>]`.
  - webinar: `watch_segments` -> `webinar.watch_segments`; `webinar_interactions` -> `webinar.webinar_interactions`; `webinar_registrations` -> `webinar.webinar_registrations`.
  - finance: `invoices` -> `finance.invoices`; `invoice_requests` -> `finance.invoice_requests`; `billit_reconcile_runs` -> `finance.billit_reconcile_runs`; `finance_exports` -> `finance.finance_exports`.
  - automation: `automation_runs` -> `automation.automation_runs`; `automation_enrolments` -> `automation.automation_enrolments`.
  - platform: `audit_log` -> `platform.audit_log`; `ai_requests` -> `platform.ai_requests`; `webhook_events` -> `platform.webhook_events`; `integration_calls` -> `platform.integration_calls`; `jobs` -> `platform.jobs`; `exports` -> `platform.files_export`; `rendered_emails` -> `platform.files_rendered_email`.
  - crm: `crm.declarations_superseded`, `crm.duplicate_candidates_closed`, `crm.tasks_closed`, `crm.inbox_resolved` unchanged; `suppressions` -> `crm.suppressions` and `consent_records` -> `crm.consent_records` (both `keep`).
  - booking: `waitlist_entries` -> `booking.waitlist_entries`; `bookings_free_text` -> `booking.bookings_free_text`.
  - commerce: `commerce_checkouts` -> `commerce.checkouts`; `commerce_payments_raw` -> `commerce.payments_raw`; `commerce_orders` -> `commerce.orders`; `commerce_person_prices` -> `commerce.person_prices`; `commerce_lightspeed_sales` -> `commerce.lightspeed_sales`.
  - credits: `credits.ledger`, `credits.sharing_reviews`, `credits.reconciliation_runs` unchanged; `referrals.attributions` -> `credits.referral_attributions`; the unnamed membership row -> `credits.memberships`.
  - email: `email_events` -> `email.email_events`; `email_messages` -> `email.email_messages`; `campaign_recipients` -> `email.campaign_recipients`; `email_ai_drafts` -> `email.email_ai_drafts`.
  - site: `site_cookie_consents` -> `site.cookie_consents`; `site_terms_acceptances` -> `site.terms_acceptances`; `site_page_edit_requests` -> `site.page_edit_requests`.
  ops adds the check `key ~ '^[a-z]+\.[a-z][a-z0-9_]*$'` and asserts in a test that the prefix of every key names a module whose `sweep[key]` exists (or `keep`).
- **Reason:** the key must say who owns the sweep; three formats were in use.
- **Changes:**
- `modules/ops.md`: section 2 `retention_policies.key` check; the seed table (rows 10-200) uses the new keys; the ownership test.
- `modules/forms.md`: section 9 keys and `formsPrivacy.sweep` map keys.
- `modules/webinar.md`: section 9.2 keys and `sweep` map keys.
- `modules/finance.md`: section 9 keys and `sweep` map keys.
- `modules/automation.md`: section 9 keys (`purgeAutomationHistory` keyed by the new names).
- `modules/platform.md`: section 9 `sweep` keys.
- `modules/crm.md`: section 9 adds the `keep` rows' new keys.
- `modules/booking.md`: section 9 keys.
- `modules/commerce.md`: section 9 `retention` seeds.
- `modules/credits.md`: section 9 retention keys.
- `modules/email.md`: section 9 retention keys.
- `modules/site.md`: section 9 retention keys.

### D38. DPIA key for sensitive processing
- **Answer:** `ops.isDpiaApproved(db: DbOrTx, key: DpiaKey): Promise<boolean>` with the key `'sensitive_assessment_processing'` (ops' enum; the name blueprint 66 uses) gates both forms' publish check (a version with non-empty `sensitive_field_keys` cannot be published unless approved or `not_required`) and platform's sensitive-AI switch (PL-55). The name `ai_sensitive_processing` does not exist.
- **Reason:** one register row for one processing activity.
- **Changes:**
- `modules/platform.md`: PL-55 and the `isDpiaApproved` key union (around line 600) use `'sensitive_assessment_processing'`.
- `modules/forms.md`: rule P7 states the publish check with this key (already there; confirm in forms-P3 tests).

### D39. Health-declaration form before the DPIA decision
- **Answer:** forms' `defaults` seed creates `health-declaration` as a draft; staff publish it after `sensitive_assessment_processing` is approved or `not_required`. Only the `demo` seed profile publishes sensitive forms. Until then `/f/health-declaration` returns the "form not available" page, booking's reception badge shows "missing", and automation's `intake_reminder` step is skipped by its `unless form_completed` condition and the template link check.
- **Reason:** no special-category data is collected before the DPIA is decided.
- **Changes:**
- `modules/ops.md`: cut-over checklist adds the item `dpia_sensitive_processing_decided` ("decide DPIA `sensitive_assessment_processing` and publish `health-declaration`").
- `modules/booking.md`: R62b notes that the linked form may be unpublished before the DPIA decision and the badge then shows "missing".
- `modules/automation.md`: the `intake_reminder` step notes the same.
- `modules/forms.md`: none (decisions 51 and P13 stand).

### D40. Watch-time DPIA gate
- **Answer:** `watch_time_profiling` gates the webinar segment fields and every automation journey with `automations.requires_dpia = 'watch_time_profiling'` (all webinar behaviour journeys of D52 marked DPIA). `requires_dpia` is a seed-only column of `automations`.
- **Reason:** automation's activation gate (A-5a) calls this key; ops' register must say what it gates.
- **Changes:**
- `modules/ops.md`: rule 70 lists automation's webinar behaviour journeys (via `automations.requires_dpia`) next to the segment fields; `DPIA_GATED` includes them.

### D41. CSP and frame restrictions
- **Answer:** the Content-Security-Policy is built per request by `buildCsp()` in `apps/web/lib/csp.ts`, called from `proxy.ts`, with a per-request nonce and `strict-dynamic`; it sends `frame-ancestors 'none'` everywhere except `/:locale/f/:path*`, where it sends `frame-ancestors *`. `next.config.ts` sends no CSP or frame header. The go-live check is a Better Stack probe on `GET /nl/f/contact`.
- **Reason:** a second header would be enforced together with the first and block embedding; nonces must be per request (platform PL-67, decision 72).
- **Changes:**
- `01-architecture.md`: section 10 security controls: "CSP with per-request nonces built by `buildCsp()` in `proxy.ts` (frame-ancestors `*` only on `/:locale/f/*`)" replaces "in `next.config.ts` headers".
- `modules/forms.md`: section 10 orchestrator row and decision 11: the exception comes from `buildCsp()`; drop the next.config request.

### D42. CSP hosts for site's ad and analytics tags
- **Answer:** platform PL-67 and decision 72 are final: from Wave 0 `buildCsp()` holds the V1 GA4 hosts (`*.google-analytics.com`, `*.googletagmanager.com`) and the R3 Google Ads and Meta hosts: `https://www.googleadservices.com` and `https://googleads.g.doubleclick.net` in `img-src` and `connect-src`, `https://www.facebook.com` in `img-src` and `connect-src`, `https://connect.facebook.net` in `script-src`. R3 needs no frozen-file change. The tags themselves load only after marketing-cookie consent (site's consent banner).
- **Reason:** platform's current PL-67 already carries every host site asked for; site's conflict note predates it.
- **Changes:**
- `modules/site.md`: the R3 ad-tag row cites PL-67's host list; remove the CSP-host request to platform and from site-P1's dependency requests.
- `modules/platform.md`: none.

### D43. Requests already met in Wave 0 (closed)
- **Answer:** closed with no further action: `APPEND_ONLY_TABLES` already holds `person_merges`, `person_declarations`, `imported_history`, `membership_periods`, `automation_runs`, `automation_versions`, `terms_acceptances`, `cookie_consents`, `site_audit_reports`, `order_lines`, `webinar_moderation_actions` (the orchestrator runs `select beam_protect_append_only();` as a custom migration after each wave); `integration_calls_provider` includes `wordpress`; the Serwist wrapper and GA4 hosts are in Wave 0; the WAF exemption, `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` are in `.env.example` and `security-controls.md`; platform's `DEFAULT_ROLE_GRANTS` gives `referrals.manage` to finance and sales.
- **Reason:** duplicated requests create conflicting edits to frozen files.
- **Changes:**
- `modules/site.md`: remove the `wordpress` enum, Serwist and GA4 CSP items from site-P1's dependency requests.
- `modules/credits.md`: remove the `membership_periods` append-only request and the `referrals.manage` seed grant.
- `modules/automation.md`: remove the `automation_runs` / `automation_versions` append-only request.
- `modules/commerce.md`: remove the `order_lines` append-only request.
- `modules/crm.md`: remove the `person_merges` / `person_declarations` append-only request.
- `modules/webinar.md`: remove the WAF, Google OAuth and `webinar_moderation_actions` dependency requests.
- `modules/ops.md`: remove the `imported_history` append-only request.
- `01-architecture.md`: section 9 secrets list adds `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` (R2) beside `GOOGLE_OAUTH_REFRESH_TOKEN`.
- `01-architecture.md`: section 4 permission list adds `referrals.manage` (R3, declared in credits' `permissions.ts`; granted by default to finance and sales).

### D44. Webinar routes and the V1 webinar stopgap
- **Answer:** route handlers added to the architecture list: `api/webinar/heartbeat`, `api/webinar/state`, `api/webinar/view`, `api/webinar/interact`, `api/webinar/cta/[ctaId]`, `api/public/webinars/[slug]/register`, `api/public/webinars/[slug]/ics` (all R2). In V1 there is no webinar package; WebinarGeek history arrives through ops' import (kind `history`, source `webinargeek`).
- **Reason:** the architecture's route list must be complete for the ownership check.
- **Changes:**
- `01-architecture.md`: section 1 tree and section 3 route list add the seven routes; section 1 module table notes "V1: ops import of WebinarGeek history; no webinar package before R2".

### D45. Webinar rate limits
- **Answer:** `rate_limits` buckets: `webinar_heartbeat` 8 requests per registration per minute; `webinar_state` 30 per registration per minute (the player polls every 5 s while live). Both routes are exempt from the 60-per-minute per-IP rule in the app and in the Vercel WAF; every other webinar viewer route (`view`, `interact`, `cta/[ctaId]`, public `register` and `ics`) falls under the per-IP rule.
- **Reason:** an 8/min state bucket would block every live viewer (platform decision 83).
- **Changes:**
- `modules/webinar.md`: rate-limit text for `/api/webinar/state` uses `webinar_state` 30/min.
- `modules/platform.md`: none (PL-68 and decision 93 stand).
- `01-architecture.md`: section 10 WAF line adds "except `/api/webinar/heartbeat` and `/api/webinar/state`, limited per registration (8 and 30 per minute)".

### D46. Read-only AI SQL (R4)
- **Answer:** platform owns the role `beam_ai_ro`, the schema `ai`, `runAiReadOnlyQuery(ctx, sql)` with `assertAiSqlSafe`, and the one function allow-list `AI_SQL_FUNCTIONS` exported from `@beam/core/ai`. Platform's `0100_ai_readonly.sql` creates only the role and the schema. Ops owns every `ai.*` view in `packages/db/src/sql/0101_ai_views_ops.sql`, including `ai.webinar_performance_daily = select * from public.v_webinar_performance_daily` (webinar's view). Ops' `validateAiSql` imports `AI_SQL_FUNCTIONS` from `@beam/core/ai` and re-exports it; ops defines no list of its own.
- **Reason:** one list cannot drift, and one owner for every `ai.*` view keeps the NL-question schema description in one place.
- **Changes:**
- `modules/platform.md`: platform-P10 files: `0100_ai_readonly.sql` without `ai.webinar_performance_daily`; decision 81 says ops places it; the subset test becomes "ops re-exports platform's list".
- `modules/ops.md`: section 2 `ai` schema text drops "where platform's 0100 declares a view with the same purpose"; rule 77 and ops-P exposes: `AI_SQL_FUNCTIONS` is re-exported from `@beam/core/ai`; `0101_ai_views_ops.sql` adds `ai.webinar_performance_daily`.
- `modules/webinar.md`: the `ai.webinar_performance_daily` request goes to ops (0101), not platform (0100).

### D47. Billit client files
- **Answer:** Wave 0 (platform-P3) ships `packages/integrations/src/billit/{index.ts,types.ts,fake.ts,client.ts}` (client throws `NotImplementedError`); finance-P4 takes over all four files.
- **Reason:** one owner per provider folder after Wave 0.
- **Changes:**
- `modules/finance.md`: owner paths and finance-P4 files: "takes over `index.ts`, `types.ts`, `fake.ts` and `client.ts`".

### D48. Booking health on `/api/health`
- **Answer:** `booking.getBookingHealth(db)` returns `{ level: 'ok' | 'warn' | 'alert', materialisedThroughOn, overdueOffers, overdueReservations, unsentConfirmations24h }` with booking's thresholds. `/api/health` shows it under `checks.booking` and never returns 503 because of it; `alert` raises a High Slack alert from `platform.check_alerts` (fingerprint `booking-health`), `warn` goes to the daily digest.
- **Reason:** 503 is reserved for the platform being down; booking anomalies are operational.
- **Changes:**
- `modules/booking.md`: section 4.8 `getBookingHealth` return type adds `level` with the thresholds that set it.
- `modules/platform.md`: PL-74 and PL-75 as above (fingerprint `booking-health`).

### D49. `PAYMENTS_FAKE`
- **Answer:** `PAYMENTS_FAKE=1` selects the payments fake only (other providers keep their own switch); in production it makes the `config` check of `/api/health` fail (503).
- **Reason:** a fake payment provider in production must page someone.
- **Changes:**
- `modules/commerce.md`: section 6 fake row and P-done lines state both effects.
- `modules/platform.md`: PL-74 `config` check lists `PAYMENTS_FAKE` among the production failures.

### D50. Webinar sessions in booking
- **Answer:** `booking.upsertWebinarSession(tx, ctx, { webinarId, title, startsAt, endsAt, sessionId? }): Promise<{ sessionId: string; created: boolean }>` and `booking.cancelWebinarSession(tx, ctx, { webinarId, reason }): Promise<{ cancelled: boolean }>` (keyed by webinar id, idempotent). There is no `linkWebinarSession`.
- **Reason:** booking's published signatures (R64, decision 47); keying by webinar id saves a lookup and stores the reason.
- **Changes:**
- `modules/webinar.md`: section 10 (around line 646) and decision 8 use these shapes and expect `{ sessionId, created }`; drop the note that booking only has `linkWebinarSession`.
- `modules/booking.md`: decision 47's conflict note is closed.

### D51. Automation groups
- **Answer:** seeded groups (key, exclusive, priority): `customer_journey` (yes, 10), `webinar` (yes, 20), `waitlist` (yes, 25), `lead_nurture` (yes, 30), `package`, `inactivity`, `membership`, `transactional`, `review`, `sales`, `checkout` (all non-exclusive, 100). The exclusive groups share the lane `sales_journey`.
- **Reason:** review requests, task-only journeys and checkout recovery must neither block nor supersede sales journeys (automation decision 2).
- **Changes:**
- `01-architecture.md`: section 2 `automation_groups` seeded list adds `review`, `sales`, `checkout`.

### D52. Webinar journeys
- **Answer:** automation seeds every webinar journey in `packages/core/src/automation/seeds/webinar.ts` (drafts in automation-P4, activation in automation-P8); webinar seeds none and `seedAutomations` is not in automation's api. Final set (group, priority, gate): `webinar-registration` (transactional, active at R2), `webinar-watched-end` (webinar, 10, DPIA), `webinar-cta-click` (webinar, 15, DPIA; `follow_up` email +60 min only), `webinar-watched-30` (webinar, 20, DPIA; threshold `30m` or `50pct`), `webinar-watched-15` (webinar, 40, DPIA), `webinar-replay` (webinar, 50, DPIA), `webinar-on-demand` (webinar, 55, DPIA), `webinar-attended` (webinar, 60, DPIA), `webinar-no-show` (webinar, 70, active at R2; step `replay` sends `webinar.replay_available`), `webinar-poll-answer` (sales, active), `webinar-cta-sales-task` (sales, DPIA; trigger `webinar.cta_clicked` in any mode; subject ref `webinar_registration:<id>`, `re_entry: never`; one task owner sales +0 unless `has_future_booking`, title "Webinar CTA clicked: <cta_key>"). "DPIA" = `requires_dpia = 'watch_time_profiling'`.
- **Reason:** the sales task must fire even when another `sales_journey` journey blocks the exclusive webinar group (webinar 4.8, decision 43).
- **Changes:**
- `modules/automation.md`: section 3.6 webinar table: remove the `sales_task` step from `webinar-cta-click`; add the `webinar-cta-sales-task` row; seed test covers it.
- `modules/webinar.md`: section 4.8 table stands; drop the stale request that webinar seeds through `automation.seedAutomations` and the slugs `webinar-follow-up-attended` / `-missed`.

### D53. Booking facts used by automation
- **Answer:** booking's event kinds are `booking.confirmed { session_kind, starts_at, is_first_booking, is_guest, rescheduled_from_booking_id? }`, `booking.cancelled { cancel_reason_code, by }`, `booking.late_cancelled`, `booking.rescheduled`, `booking.attended { is_first_visit }`, `booking.no_show`, `booking.event_ended { attended }`, `waitlist.offered { offer_expires_at }`, `waitlist.confirmed`, `waitlist.expired`, `waitlist.released`, `waitlist.withdrawn`. A reschedule writes `booking.rescheduled`, `booking.cancelled` (old row, code `rescheduled`) and `booking.confirmed` (new row, old `is_first_booking`), and one email `booking.booking_rescheduled`. `settings.booking_rules.reminder_hours_before.event` defaults to `[]` (event reminders are automation steps). `booking.nextOpeningAt(db, from, opts?: { includePublicHolidays?: boolean }): Promise<Date | null>` exists in booking's api. The `booking.seat_*`, `booking.offer_expired`, `booking.waitlist_*` names and `data.is_first` do not exist.
- **Reason:** these are booking's and crm's catalogue names (booking decisions 10, 55-57).
- **Changes:**
- `modules/automation.md`: `waitlist-offer` trigger and exits, section 10 booking event table, `after-first-booking` (`data.is_first_booking`), `after-first-visit` (`data.is_first_visit`); "the confirmation is booking's booking-confirmed" -> "`booking.booking_confirmed`"; drop the claim that booking lacks `nextOpeningAt`.
- `modules/booking.md`: none.

### D54. Abandoned-checkout recovery
- **Answer:** `abandoned-checkout` is a marketing automation (purpose `newsletter`, group `checkout`, `requires_flag = ff_commerce_checkout_recovery`), triggered by `checkout.abandoned` (data includes `total_cents`), with both reminders (`remind_1h`, `remind_24h`) sending the transactional-looking template `commerce.checkout_recovery` as a marketing message (reachability for `newsletter` checked). Commerce's `getCheckoutRecoveryProps` serves the template; automation calls `commerce.markCheckoutRecoveryMessage`.
- **Reason:** a reminder to buy is a commercial message under Belgian law; commerce rule 52 and automation's current text agree.
- **Changes:**
- `modules/automation.md`: the seed row says marketing for both steps (no transactional `remind_1h`), template `commerce.checkout_recovery`, group `checkout`.
- `modules/commerce.md`: rule 52 and section 10 use `commerce.checkout_recovery`; `findLatestMessage(db, { personId, templateSlug: 'commerce.checkout_recovery', after })`.
- `modules/email.md`: a registry template sent through `queueMarketingEmail` is rendered with the marketing footer and `news.beam.be` (rule note in 39a).

### D55. Abandoned-checkout values in ops
- **Answer:** `checkouts.items[]` elements are `CartItem` without prices. Ops' `v_abandoned_checkouts` takes the value from `checkouts.total_cents` (set by commerce from the quote when the checkout is saved) and the product mix from `items[].productId` and `quantity`; it never reads `unit_amount_cents`.
- **Reason:** commerce owns the price snapshot; a cart is not an order.
- **Changes:**
- `modules/ops.md`: section 10 (checkouts row) and the `v_abandoned_checkouts` definition.
- `modules/commerce.md`: section 2 `checkouts.total_cents` documented as "quote total at the last save".

### D56. Landing attribution of site buy links
- **Answer:** site's buy links are `/[locale]/checkout?sku=<sku>&from=<page path>` (site rules 31 and 46); commerce stores `from` (same-origin path only) in `checkouts.landing_path`, falling back to the same-origin `Referer`. `commerce.countOrdersByLanding(db, { from, to }): Promise<{ landingPath, utmCampaign, orders, revenueCents }[]>`.
- **Reason:** the Referer header is dropped by many browsers; an explicit parameter is reliable.
- **Changes:**
- `modules/site.md`: rules 31 and 46 add `from=<page path>`; section 10 commerce row names `countOrdersByLanding`.

### D57. Future-booking import from ops
- **Answer:** `booking.importBooking(tx, ctx, { externalRef, personId, kind, startsAt, paidWith: 'credit' | 'order' | 'free' }): Promise<{ bookingId: string | null; outcome: 'created' | 'existing' | 'no_session' | 'over_capacity' }>`. Every imported row is `confirmed` with `source = 'import'`; ops passes no status. The capacity report reads booking's `v_session_utilisation`; there is no `v_capacity_utilisation` view.
- **Reason:** a `reserved` import would need an order (booking R65).
- **Changes:**
- `modules/ops.md`: section 10 (around line 622) and rule 49 use this call and outcomes; the capacity report reads `v_session_utilisation`.
- `modules/booking.md`: section 10 ops row (around line 730 and 749) drops `v_capacity_utilisation`.

### D58. Webinar columns in `v_person_profile`
- **Answer:** webinar's `v_person_webinar_stats` columns stay `replays_watched`, `on_demand_watched`, `poll_answers`, `cta_clicks`, `imported_webinars_registered`, `imported_webinars_attended` (native counts exclude imported history). Ops' `v_person_profile` aliases them as `webinars_watched_replay`, `webinars_watched_on_demand`, `webinar_poll_answers`, `webinar_cta_clicks`, and computes `webinars_registered_total = webinars_registered + imported_webinars_registered` and `webinars_attended_total = webinars_attended + imported_webinars_attended` itself.
- **Reason:** the view owner names its own columns; the consumer aliases.
- **Changes:**
- `modules/ops.md`: `v_person_profile` definition aliases and sums as above; the note "native counts include imported history" is removed.
- `modules/webinar.md`: none.

### D59. Webinar items requested by ops
- **Answer:** webinar's api adds `listWebinarLeadsWithoutBooking(db, { startedSince: Date, limit: number }): Promise<{ personId: string; webinarId: string; registeredAt: Date }[]>` with the same definition as `countWebinarLeadsWithoutBooking` (ops' action-dashboard card shows the first 10). Webinar-tool rows (WebinarGeek history) resolve persons through `crm.upsertPersonFromImport`, like every import kind; live registrations keep `crm.findOrCreatePersonByEmail`. Retention: `webinar.watch_segments` 730, `webinar.webinar_interactions` 730, `webinar.webinar_registrations` 1095 (D37 keys).
- **Reason:** one import code path keeps dry runs, duplicate merging and reports equal for every source (ops decision 67).
- **Changes:**
- `modules/webinar.md`: api.ts adds `listWebinarLeadsWithoutBooking`; rule 2 says `crm.upsertPersonFromImport` for imported rows; section 9.2 keys per D37.
- `modules/ops.md`: section 10 webinar row names `listWebinarLeadsWithoutBooking`.

### D60. Automation permissions in platform's tables
- **Answer:** automation uses `automations.write`, `automations.publish` (also pause and resume) and `automations.move_person` (exit, enrol, move). `automations.exit_person` and `automations.pause` do not exist.
- **Reason:** the architecture's permission list is binding (Convention 6).
- **Changes:**
- `modules/platform.md`: section 8 blueprint-56 table: `automations.exit_person` -> `automations.move_person`, `automations.pause` -> `automations.publish`.

### D61. Segment archive guard and suppression lookup
- **Answer:** `crm.archiveSegment` refuses with `conflict` (`segment_in_use`) when `automation.isSegmentInUse(db, segmentId)` or `email.isSegmentInUse(db, segmentId)` is true. Automation's suppression exit finds persons with `crm.findPersonIdsByEmailHash(tx, emailHash)`; `findPersonIdsByEmail` is not added.
- **Reason:** suppressions are keyed by email hash, and both owners of segment references must be asked.
- **Changes:**
- `modules/crm.md`: `archiveSegment` calls both guards; section 10 automation row adds `isSegmentInUse`.
- `modules/automation.md`: none (decisions 56 and 57 stand).

### D62. Form setting that opens an inbox thread (R3)
- **Answer:** the switch is `FormSettings.createInboxThread: boolean` in the versioned `FormDefinition` (forms rule F1; true on the seeded `contact` form). `definition.settings.inbox` does not exist.
- **Reason:** forms owns its definition schema.
- **Changes:**
- `modules/crm.md`: section 10 forms row and decision 32 name `FormSettings.createInboxThread`.

### D63. `FormEmbed` and the completion event
- **Answer:** the embed component is `FormEmbed({ slug, locale, context: { pagePath, utm?, landingPath?, referrer?, partnerCompanyId? } })` from forms. On a successful submit forms dispatches `window` CustomEvent `beam-form:completed` with `detail: { slug, kind, locale, endingKind }`; `embed.js` re-dispatches it on the parent window for iframes. Site's R3 conversion tags listen for that event. The name `FormBlock` does not exist.
- **Reason:** forms owns the component (forms decision 48, site decision 57).
- **Changes:**
- `modules/site.md`: section 1 V1 row, the page-route table (line ~497 "footer newsletter FormBlock") and the R3 ad-tag row (line ~512) say `FormEmbed` and `beam-form:completed` with the detail above.
- `modules/forms.md`: none (decision 48 stands).

### D64. Preference centre route ownership
- **Answer:** `apps/web/app/[locale]/(site)/preferences/` and `apps/web/app/api/public/{unsubscribe,preferences}/` are owned by crm.
- **Reason:** architecture section 11 gives the preference centre pages to crm (crm decisions 5 and 58).
- **Changes:**
- `modules/site.md`: the owner-path exception list says `preferences/` is owned by crm (not email).
- `modules/email.md`: owner paths do not list `preferences/`.

### D65. Portal layout and `PortalSiteChrome`
- **Answer:** platform-P6 (Wave 0) creates `apps/web/app/[locale]/(portal)/account/layout.tsx` with `requireCustomer()` and `PortalShell`. site-P6 takes over that file in its wave and wraps `PortalShell` with site's internal `PortalSiteChrome`. `PortalSiteChrome` is not exported from site's `api.ts` and platform's layout never mounts it.
- **Reason:** one owner per file per wave, with an explicit hand-over (platform decision 63).
- **Changes:**
- `modules/platform.md`: remove the "For platform" item asking platform's layout to mount `PortalSiteChrome`; platform-P6 layout = `requireCustomer()` + `PortalShell`, handed over to site-P6.
- `modules/site.md`: owner paths list `account/layout.tsx` from site-P6 on; api.ts does not export `PortalSiteChrome`.

### D66. Portal lists of a person's bookings and offers
- **Answer:** `booking.listUpcomingBookingsForPerson(db, personId: string, limit: number)` and `booking.listOpenOffersForPerson(db, personId: string)`, single person id. `bookings` and `waitlist_entries` are mutable and repointed to the winner by crm's merge, so the winner's id finds every row.
- **Reason:** the simpler signature is complete; site adopted it (site decision 56).
- **Changes:**
- `modules/booking.md`: section 4.9 signatures (lines ~615-616) and section 10 site row take `personId: string`; drop the `crm.resolvePersonIds` comment.
- `modules/site.md`: none.

### D67. Payment alerts
- **Answer:** commerce owns the "payment `pending` for more than 15 minutes" check and the alerts for dead `payments.*` jobs; credits owns "3 failed renewals in a day" (rule 50a, threshold `settings.credits.failed_renewals_alert_per_day`, default 3), because only credits knows that a failure is a renewal attempt. Both raise High Slack alerts and action-dashboard rows through ops' cards.
- **Reason:** each check lives with the module that can interpret the data (commerce decision 51).
- **Changes:**
- `01-architecture.md`: section 10 "Payments and Billit" row: "payment pending above 15 min (commerce); 3 failed renewals in a day (credits); Billit failed for 1 h (finance)".
- `modules/platform.md`: PL-75a lists the two checks with these owners.

### D68. Stale review items (void)
- **Answer:** void and closed: the review items asking for slash template keys (booking `booking/<file>`, commerce `commerce/<name>`, credits `credits/<name>`, finance `finance/invoice-issued` and `finance/credit-note-issued`, ops `ops/privacy-*`, webinar `webinar/webinar-access`, platform `platform/magic-link`); email's earlier stateless-preference-token and `ingestInboundEmail(ctx, { payload })` requests; automation's requests for `seedAutomations`, `queueAutomationEmail(ctx, ...)` returning `skipped_*` in its own wording, `findPersonIdsByEmail`, `setPreferredChannel`, `kind` in credits events, `total_cents` in `checkout.abandoned` (already present); booking's and site's `personIds` requests; site's `PortalSiteChrome` request; ops' and platform's requests to change the architecture's invoice retention to 3653 days with action delete (superseded by D34); crm's `notes` request to platform (superseded by D11, which keeps `notes`).
- **Reason:** each is either already applied or superseded by a decision above.
- **Changes:**
- `modules/webinar.md`: decisions 43 and 44 record the email and automation review items as resolved.
- `modules/email.md`: retract the earlier slash-key requests in section 13 (decision 1 already lists them as retracted).

### D69. Erasure transaction setting
- **Answer:** the erase step transaction sets only `SET LOCAL beam.allow_rewrite = 'on'`; no other session setting is a cross-module convention (see D35). `PrivacyRegistration = { tables, export(tx, personId), erase(tx, personId), sweep?: Record<policyKey, (tx, cutoff: Date) => Promise<number>>, retention?: RetentionPolicySeed[] }`.
- **Reason:** with D35 no handler needs the request id.
- **Changes:**
- `01-architecture.md`: section 10 privacy workflows: the registry entry is `{ tables, export, erase, sweep?, retention? }`.
- `modules/ops.md`: decision 12 and the orchestrator test drop `beam.privacy_request_id`.
