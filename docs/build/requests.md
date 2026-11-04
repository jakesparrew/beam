# Requests carried between packages

Requests a package reported for another module (runbook 5.2). The orchestrator adds each open
request to the launch instructions of the first later package of the named module, then moves it
to "Served" with the package id.

## Open

| From | For | Request |
| --- | --- | --- |
| platform-P2 | crm, booking, commerce, finance, forms, email, automation, site (first package of each) | When you create the tables referenced by the Wave 0 contract-table stubs, add the foreign keys noted in the stub comments (companies, session_templates, ticket_types, promotions, checkouts, form_versions, email_template_versions, campaigns, automation_groups, automation_versions, page_versions). |
| platform-P3 | crm (inbox AI drafts, R3) | `callClaude` feature key is `ai.draft_reply`, not `inbox_draft`. Its fields `thread_messages` and `knowledge_articles` are not in `AI_ALLOWED_FIELDS`: the crm package that builds AI reply drafts decides and documents which fields are sent, and asks platform for an `AI_ALLOWED_FIELDS` addition if needed. |
| platform-P3 | email (AI campaign drafts, R4) | `callClaude` feature key is `ai.draft_email`, not `email.draft_email`. |
| platform-P7 | platform-P6 | Type the `run` of `apps/web/modules/platform/seed.ts` with `SeedCtx` from `apps/web/scripts/seed-demo.ts` (`{ db: DbOrTx, ctx: system Ctx, now: start of the Brussels day, rand: seeded PRNG 20261103, ids: Map }`). |
| platform-P7 | commerce | `apps/web/modules/commerce/api.ts` re-exports `redeemVoucher` once commerce's actions implement it (02-data-model section 6). |
| platform-P7 | forms | `FormEmbed` in `apps/web/modules/forms/api.ts` is a throwing stand-in; the forms package that builds the embed replaces it. |
| platform-P7 | automation | `PersonAutomationsPanel` in `apps/web/modules/automation/api.ts` is a throwing stand-in; the automation package that builds the person panel replaces it. |
| platform-P7 | webinar | `WebinarSignup` in `apps/web/modules/webinar/api.ts` is a throwing stand-in; webinar-P3 replaces it. |
| platform-P7 | ops | `PersonStats` in `apps/web/modules/ops/api.ts` is an open row type until `person_stats` exists; the ops package that creates it narrows the type. |
| platform-P7 | every module | `packages/db/src/seed/<m>.ts` are documented skeletons without a `seed` export; a module that needs default rows exports `seed = { module, after: ['platform', ...], run }` there (allowed once `fix-w03-platform-1` merges). |
| platform-P6 | platform-P8 | Move `AdminFrame` (AdminShell plus the Report-a-problem dialog) out of `modules/platform/ui/login-form.tsx` into its own ui file. |
| platform-P6 | platform-P8 | Implement the `reportProblem` handler; the stub in `modules/platform/actions.ts` has its final signature. |
| platform-P6 | platform-P8 | Call `notifySecurityChange` from `lib/auth.ts` in `resetUserMfa` (PL-9). |
| platform-P6 | platform-P8 | Build `/admin/settings` (an owner signing in to `/admin` is redirected to the first permitted nav entry, which is a 404 until then). |
| credits-P2 | credits (the package that owns `packages/core/src/credits/types.ts`), else platform | `types.ts` has Wave 0 guesses of `GrantSharing` (`max_guests_per_month`, `named_person_ids`) and `AllocationResult` (`allocations`/`quantity`) that do not match the spec; `credits/index.ts` re-exports the spec shapes (`GrantSharing` = `{ mode, max_guest_uses_per_month, allowed_person_ids }`, `AllocationResult` = `{ ok: true, parts } \| { ok: false, reason, available }`). Align `types.ts` with them or remove the two guesses. |
| credits-P1 | credits-P4 | Add the FK `memberships.mandate_id -> mandates.id` once commerce's `mandates` table has merged (the column exists without an FK). |
| credits-P1 | every module | Module factories and seed helpers are importable without editing shared files: `@beam/db/testing/<m>-factories` (for example `makeCreditGrant`, `makeMembership`, `makeEntry` from `@beam/db/testing/credits-factories`) and `@beam/db/seed/<m>` (for example `seedCreditsDemo` from `@beam/db/seed/credits`). |
| commerce-P1 | platform (fixer) | `apps/web/lib/alerts.test.ts`: the Mollie-silence fixture should insert a valid order (a person from `makePerson`, a `termsVersionId`), so commerce can turn `ORDERS_PENDING_CHECKS` (`orders_person_chk`, `orders_terms_chk`) into real table checks. |
| commerce-P1 | platform (fixer) | `makeProduct` in `packages/db/src/testing/factories.ts` sets `itemCategory: 'merchandise'` for `kind: 'item'`, so commerce can add `products_item_category_chk`. |
| commerce-P1 | commerce (fixer after the platform fixer) | Turn `ORDERS_PENDING_CHECKS` into table checks and add `products_item_category_chk` in `packages/db/src/schema/commerce.ts`. |
| commerce-P1 | commerce-P3 | `config.ts` imports `CommerceSettings`, `PaymentProviderByChannel` and their defaults from `@beam/core/commerce`. |
| commerce-P1 | crm, booking, site, credits | Add the FKs `orders.company_id -> companies` (crm), `order_lines.ticket_type_id -> ticket_types` (booking), `orders.terms_version_id -> page_versions` (site), `orders.renewal_membership_id -> memberships` (credits): the owner of the target table asks commerce's schema owner, because the column is in `commerce.ts`. |
| booking-P1 | platform (fixer) | `schedules.test.ts` and `api/cron/tick/route.test.ts` look only at platform kinds (fix-w04-platform-3); then a booking fixer moves `PLANNED_SCHEDULES` into `schedules` in `apps/web/modules/booking/schedules.ts`. |
| booking-P1 | booking (fixer) | Register `waitlist_entries` in booking's `privacy.ts` and add the FK `waitlist_entries.person_id -> persons.id` (on delete restrict); FKs `capacity_holds.company_id` and `sessions.partner_company_id -> companies.id` once crm-P1 merged; tighten `sessions_event_category_ck` to `(kind = 'event') = (event_category is not null)` once `makeSession` sets a category. |
| booking-P1, crm-P1, site-P1 | platform-P8 | Admin nav section labels: `platform.nav.section_booking`, `section_customers`, `section_website` (and every other section a module's `nav.ts` declares); the admin layout hides a nav entry whose `flag` is off; nav badge support (crm: own overdue tasks, open unassigned threads). |
| crm-P1 | platform (fix-w04-platform-4) | Delete `packages/core/src/crm/segment-fields.ts`; `@beam/core/crm` exports `segments/fields.ts` with the same `SEGMENT_ALLOWED_FIELDS`. |
| crm-P1 | ops-P2 | `v_person_profile` (and `PERSON_PROFILE_COLUMNS`) includes every column of crm's `SEGMENT_FIELDS`, including `package_product_ids uuid[]`. |
| email-P1 | email-P1 (attempt 2) | Register `campaign_recipients` (and the other person-referencing email tables) in email's `privacy.ts` (OD-9) and add `campaign_recipients.person_id -> persons.id` (on delete restrict). |
| site-P1 | site (fixer) | FK `pages.partner_company_id -> companies.id` (on delete set null) once crm-P1 merged. |
| forms-P1 | forms (next forms package) | FK `form_links.partner_company_id -> companies.id` once crm-P1 merged. |
| ops-P1 | ops and booking (fixer after fix-w04-platform-3) | Move `PLANNED_SCHEDULES` into `schedules` in `apps/web/modules/ops/schedules.ts` and `apps/web/modules/booking/schedules.ts` (no later package of either module owns that file) once platform's schedule tests filter to platform kinds. |
| ops-P1 | ops (fixer) | FK `retention_list_items.task_id -> tasks.id` once crm's `tasks` table exists (`ops.ts` has no later owner). |
| ops-P1 | ops-P5 | Wire `sweep` in `apps/web/modules/ops/privacy.ts` to ops-P6's `exports/sweep.ts` handlers. |
| ops-P1 | platform-P8 | Nav section labels `platform.nav.section_insights`, `section_reports`, `section_data`; filter admin and portal nav entries by their optional `flag`. |
| commerce-P2 | platform (fixer) | `apps/web/lib/integrations.ts` `buildIntegrations` builds `createMollieProvider({ apiKey: MOLLIE_API_KEY, webhookBaseUrl: APP_URL, webhookSecret: MOLLIE_WEBHOOK_SECRET, onCall })` from `@beam/integrations/payments` when the key is present, instead of `notConfigured('mollie')`. |
| commerce-P2 | commerce-P3 | `config.ts` refines `payment_provider_by_channel` with `unconfiguredChannels(value, process.env)` from `@beam/integrations/payments`, so Stripe or Viva cannot be selected without their keys. |
| finance-P2 | finance (schema fixer) | `chk_invoices_party` refuses a POS company invoice with billing details but no person and no CRM company (snapshot kind `company`, `person_id` and `company_id` null): allow a company snapshot with a VAT number, or require a CRM company for POS company invoices. |
| finance-P2 | finance-P3 | Register `finance.render_pdf` (payload `{ invoiceId }`, key `invoice_pdf:<id>`); add catalogue keys `finance.pdf.walk_in` and `finance.pdf.partial_credit`. |
| commerce-P3 | commerce-P4a (owner of `api.ts`) | Wire `getQuote`, `getProductPrice`, `listPublicPrices` and `getProductCards` in `apps/web/modules/commerce/api.ts` to `./server/catalogue` (built with the exact api signatures; api.ts still has the throwing stubs). |
| commerce-P3 | commerce (owner of `events.ts`) | Declare the event kind `person_price.set`; until then `setPersonPrice` writes only its audit row. |
| automation-P2 | crm (suppressions) | `addSuppression` pushes the jobId that `automation.requestSuppressionExit` returns into the action's after-commit list (`ctxState(ctx).enqueuedIds`), so `automation.exit_for_suppression` runs in the after() kick (A-23). |
| ops-P2 | ops-P7 | Add the R2 webinar columns and the `webinars_registered_total` and `webinars_attended_total` sums to `v_person_profile` in `ops.views.ts`, with their `ops.views.test.ts` cases. |
| email-P3 | automation (the package that implements `requestSuppressionExit`) | `crm.addSuppression` calls `automation.requestSuppressionExit` from email's hard-bounce, complaint and soft-bounce handling; it still throws. |
| ops-P4 | ops (owner of `packages/core/src/ops/import-targets.ts` and `import-presets.ts`) | Add the targets `mode` and `watched_minutes` to `IMPORT_TARGETS.history` and map the watched-minutes columns in the webinar presets (ops-P4 accepts both already). |
| ops-P4 | crm | `upsertPersonFromImport` accepts `street`, `country`, `preferredChannel` and an `onlyEmpty` option (ops rule 46); today street and country of a persons file are not written. |
| ops-P4 | platform | Add `setFileExpiry(tx, fileIds, expiresAt)`; until then ops-P4 updates `files.expires_at` directly for its own import parts. |
| ops-P4 | ops (owner of `ops.json`) | Missing catalogue keys from ops-P4's commit trailer (for example `ops.imports.option.confirm_different_file`, `ops.imports.target.{mode,watched_minutes}`, `ops.imports.error.{past_booking,invalid_status,unknown_tag,...}`). |
| finance-P3 | finance (owner of `packages/core/src/finance/index.ts`) | Add `export * from "./document-model"`, then switch `apps/web/modules/finance/pdf/render.ts` from the relative path to `@beam/core/finance`. |
| finance-P3 | finance-P5 | `rerenderInvoicePdf` enqueues `finance.render_pdf` with key `invoice_pdf:<id>:r<n>`; `resendInvoiceEmail` and `sendPaymentReminder` enqueue `finance.send_invoice_email` with reason `resend:<n>` or `reminder:<yyyy-mm-dd>`. |
| commerce-P4a | commerce (owner of `server/catalogue.ts`) | Record the `person_price.set` event in `setPersonPriceRecord` (the kind is declared now). |
| booking-P3b | commerce | `refundOrderLine` has no reason for staff forced refunds; booking passes `cancelled_in_policy`. Add `staff_override` if finance needs to tell them apart. |
| booking-P3b | booking-P5 (or a booking fixer) | `releaseOrderBookings` in `server/order-hooks.ts` also moves a claimed offered waitlist entry to `expired` with `payment_not_completed` and enqueues `offer_next` (R44), as `expireReservedRow` in `server/cancel.ts` already does. |
| site-P5 | platform (fixer) | Add `BEAM_ANALYTICS_PRODUCTION: "1"` to the Playwright `webServer.env` in `apps/web/playwright.config.ts`, so `site-consent.spec`'s GA4 test can load gtag. |
| site-P5 | forms (FormEmbed) | FormEmbed may read sessionStorage `beam_utm` through site's `readStoredUtm()` (`apps/web/modules/site/ui/public/utm-capture.tsx`) to attribute UTM on later pages of a visit (rule 40). |
| site-P5 | site-P6 | `PortalSiteChrome` mounts `ConsentProvider` (`getConsentChromeState`, `consentLabels` in `server/consent.ts`), `AnalyticsLoader` with `gaMeasurementId` null and `SwRegister`; its Cookie settings link carries `data-cookie-settings`. |
| crm-P4 | crm (owner of `packages/core/src/crm/merge-plan.ts`) | Add to `MERGE_STRATEGIES`: `automation_enrolments.person_id: skip`, `privacy_requests.person_id: repoint`, `provider_customers.person_id: repoint`, `retention_list_items.person_id: keep_winner`. Until then they live in `MERGE_STRATEGY_ADDITIONS` in `apps/web/modules/crm/merge/execute.ts`, and an entry in core takes precedence. |
| crm-P5 | email-P6 | Implement `isSegmentInUse`. Until then crm counts the stub's `NotImplementedError` as "not in use", so the segment archive guard and the list's "used by" column see only automations and other segments. |
| finance-P4 | finance (owner of `packages/core/src/finance/index.ts`) | Add `export * from "./billit-mapping"`, then switch `apps/web/modules/finance/service/billit-sync.ts` and `billit-jobs.test.ts` from the relative import to `@beam/core/finance`. |
| finance-P4 | commerce (the package that implements `recordBankTransferPaid`) | `recordBankTransferPaid` still throws (stub); `billit.sync_pending` settles open invoices through it (mocked in `sync-pending.test.ts`). |
| commerce-P4b | commerce (schema fixer) | Make `refunds.created_by_user_id` nullable (null = system refund): rule 22c late-paid refunds and rule 37a `refundOrderLine` from jobs need it. Until then a late-paid renewal refund is recorded on the payment only (`refunded_cents`, status `refunded`, `order.refunded` event) and writes no `refunds` row. |
| commerce-P4b | site (the package that implements `getCurrentLegalVersion`) | `getCurrentLegalVersion` still throws `NotImplementedError`; `createRenewalLinkOrder` needs it for `orders_terms_chk` (`recurring.test.ts` mocks it). |

## Served

| From | For | Request | Served by |
| --- | --- | --- | --- |
| crm-P1 | credits | `vPersonStatusSql` exported; `v_status_override_conflicts` is in migration `0011_w04_views`. | credits-P1 (already) |
| commerce-P1, booking-P1, credits-P2 | platform | Fixtures and factories follow the real schemas; schedule tests filter to platform kinds; credits `types.ts` guesses removed. | fix-w04-platform-3 |
| platform-P2 | platform-P7 | Call `seedDefaults(db, { permissions: PERMISSIONS })` in `seed-demo.ts`. | platform-P7 (launch instructions) |
| platform-P5 | platform-P6 | Build `action()` on `createCtx()`, map errors by `error.code`, run `after(() => runJobs({ ids: ctxState(ctx).enqueuedIds, budgetMs: 8000 }))`, skip the automatic audit row when `auditedActions` has the action, flush the integration log and durable writes after commit or rollback; `hasPermission` may delegate to `actorHasPermission`; add `platform.nav.{settings,users,flags,system,ai}` to `platform.json` in all three locales. | platform-P6 (launch instructions) |
| platform-P5 | orchestrator | `drizzle-orm` in `apps/web`; `lib/ctx.ts` imports it directly. | orchestrator, wave 2 |
| platform-P7 | platform (P2's test) | `seed-platform.test.ts` accepts module default seeds after platform. | fix-w03-platform-1 |
| platform-P3 | platform-P5 | The job runner treats `isPermanentFailure()` from `@beam/integrations/_shared` as dead at once. | platform-P5 (in its launch instructions) |
| automation-P2 | crm (person merge, crm-P4) | The person merge calls `automation.exitPersonEnrolments(tx, { personId: loser, reason: 'merged', actor })` inside its own transaction (A-21). | crm-P4 |
| finance-P2 | finance-P4 | Register `billit.push_payment` (`{ invoiceId }`, key `billit:payment:<id>`) and `billit.push_customer` (`{ partyKey }`, key `billit:customer:<party_key>:<hash8>`). | finance-P4 |
| finance-P3 | finance-P4 | Register `billit.push_invoice` and `billit.push_credit_note` (render_pdf enqueues them with keys `billit:invoice:<id>` and `billit:credit_note:<id>`). | finance-P4 |
| orchestrator | finance-P4 | `packages/integrations/src/_shared/platform-p3.shared.test.ts` (line ~69) pins the Billit client stub (`NotImplementedError`); finance-P4 implements the real client, so it also owns that test (granted as extraOwns at launch) and replaces the stub assertion with the client's real contract. | finance-P4 |
| email-P3 | site-P5 | Implement `getLegalLinks`; email footers carry no privacy or terms links until it exists (email handles the `NotImplementedError`). | site-P5 |
