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
| crm-P1 | credits (fixer) | `credits.views.ts` exports the `v_person_status` SQL as `vPersonStatusSql`, so crm's `v_status_override_conflicts` turns on. |
| crm-P1 | ops-P2 | `v_person_profile` (and `PERSON_PROFILE_COLUMNS`) includes every column of crm's `SEGMENT_FIELDS`, including `package_product_ids uuid[]`. |
| email-P1 | email-P1 (attempt 2) | Register `campaign_recipients` (and the other person-referencing email tables) in email's `privacy.ts` (OD-9) and add `campaign_recipients.person_id -> persons.id` (on delete restrict). |
| site-P1 | site (fixer) | FK `pages.partner_company_id -> companies.id` (on delete set null) once crm-P1 merged. |
| forms-P1 | forms (next forms package) | FK `form_links.partner_company_id -> companies.id` once crm-P1 merged. |
| ops-P1 | ops and booking (fixer after fix-w04-platform-3) | Move `PLANNED_SCHEDULES` into `schedules` in `apps/web/modules/ops/schedules.ts` and `apps/web/modules/booking/schedules.ts` (no later package of either module owns that file) once platform's schedule tests filter to platform kinds. |
| ops-P1 | ops (fixer) | FK `retention_list_items.task_id -> tasks.id` once crm's `tasks` table exists (`ops.ts` has no later owner). |
| ops-P1 | ops-P5 | Wire `sweep` in `apps/web/modules/ops/privacy.ts` to ops-P6's `exports/sweep.ts` handlers. |
| ops-P1 | platform-P8 | Nav section labels `platform.nav.section_insights`, `section_reports`, `section_data`; filter admin and portal nav entries by their optional `flag`. |

## Served

| From | For | Request | Served by |
| --- | --- | --- | --- |
| platform-P2 | platform-P7 | Call `seedDefaults(db, { permissions: PERMISSIONS })` in `seed-demo.ts`. | platform-P7 (launch instructions) |
| platform-P5 | platform-P6 | Build `action()` on `createCtx()`, map errors by `error.code`, run `after(() => runJobs({ ids: ctxState(ctx).enqueuedIds, budgetMs: 8000 }))`, skip the automatic audit row when `auditedActions` has the action, flush the integration log and durable writes after commit or rollback; `hasPermission` may delegate to `actorHasPermission`; add `platform.nav.{settings,users,flags,system,ai}` to `platform.json` in all three locales. | platform-P6 (launch instructions) |
| platform-P5 | orchestrator | `drizzle-orm` in `apps/web`; `lib/ctx.ts` imports it directly. | orchestrator, wave 2 |
| platform-P7 | platform (P2's test) | `seed-platform.test.ts` accepts module default seeds after platform. | fix-w03-platform-1 |
| platform-P3 | platform-P5 | The job runner treats `isPermanentFailure()` from `@beam/integrations/_shared` as dead at once. | platform-P5 (in its launch instructions) |
