# BEAM conventions (long reference)

The one-page rule card is `CONVENTIONS.md`. This file is the reference behind it, with examples.
Binding sources, in order: `00-decisions.md`, `01-architecture.md` (section 11 "Naming
conventions"), `02-data-model.md`, `04-build-session.md`. Where this file adds a rule (the facade
formats of section 4, written by platform-P1), it is binding for every package.

## 1. Naming, with examples

Each rule: three correct examples, two wrong ones.

| Thing | Rule | Correct | Wrong |
| --- | --- | --- | --- |
| Table | snake_case plural; PK `id`; FK `<singular>_id` | `persons`, `credit_entries`, `bookings.session_id` | `Person`, `creditEntry` |
| Enum | `pgEnum('<table>_<column>')` | `bookings_status`, `jobs_lane`, `invoices_kind` | `booking_status_enum`, `Status` |
| View | `v_<name>`, declared `pgView(name, columns).existing()` with `<name>Sql` beside it | `v_person_credits`, `v_marketing_reachability`, `v_support_sla` | `credit_balances_view`, `vCreditBalances` |
| Event kind | `<entity>.<past_tense_or_fact>`, declared once in the owner's `events.ts`; `data` keys snake_case | `booking.confirmed`, `order.paid`, `credits.threshold_reached` | `confirmBooking`, `booking.confirm` |
| Job kind | `<module_or_entity>.<verb_noun>` | `email.send`, `credits.expire_grant`, `campaign.send_chunk` | `sendEmail`, `email.sending` |
| Permission | `<module>.<action>`, exactly the list of architecture section 4 | `persons.read`, `bookings.override`, `system.jobs` | `crm:read`, `readPersons` |
| Catalogue key | `<module>.<screen>.<element>` | `booking.session.capacity_label`, `platform.login.submit`, `crm.nav.persons` | `Book now`, `login_submit` |
| Flag | `ff_<module>_<name>`, check `^ff_[a-z]+_[a-z0-9_]+$` | `ff_webinar_portal`, `ff_crm_pipeline`, `ff_ops_ai` | `webinarPortal`, `ff-webinar-portal` |
| Setting key | top-level snake_case in the owner's `config.ts`, check `^[a-z_]+$` | `booking_rules`, `business_hours`, `retention_defaults` | `bookingRules`, `booking.rules` |
| Idempotency key | `<noun>:<id>[:<qualifier>]` (section 2) | `email:<message_id>`, `expire:<grant_id>:2026-12-31`, `schedule:automation.evaluate:2026-11-03T20:15` | `email-123`, `expire:<grant_id>:1793737662` |
| Transactional template | `<m>.<name>`; `<name>` snake_case, file basename is its kebab form | `platform.magic_link` (`magic-link.tsx`), `booking.confirmation`, `webinar.replay_available` | `platform/magic-link`, `magicLink` |
| Marketing template | kebab-case slug | `webinar-follow-up`, `spring-newsletter`, `welcome-series-1` | `Webinar Follow Up`, `webinar_follow_up` |
| Retention policy | `<m>.<name>` | `platform.audit_log`, `ops.marketing_profile`, `finance.invoices` | `audit-log`, `AuditLog` |
| Server action | `verbNoun` in `actions.ts`, `name: '<m>.<verb>'` | `cancelBooking`, `updateSetting`, `mergePersons` | `bookingCancel`, `doCancel` |
| Query | `getX` / `listX` in `queries.ts` | `getPerson`, `listSessions`, `getFinanceDashboard` | `personQuery`, `fetchAll` |
| Zod schema | `<Noun>Input` beside the action | `CancelBookingInput`, `UpdateSettingInput`, `MergePersonsInput` | `cancelSchema`, `Input1` |
| Core function | pure, named by what it returns | `quote`, `allocateCredits`, `planSteps` | `doPricing`, `handleCredits` |
| Files / components | files kebab-case, React components PascalCase | `person-card.tsx` exporting `PersonCard`, `magic-link.tsx`, `jobs-table.tsx` | `PersonCard.tsx`, `person_card.tsx` |
| Tests | `*.test.ts` beside the code; Playwright `e2e/<m>.spec.ts`, `e2e/scenario-<n>-<name>.spec.ts` | `quote.test.ts`, `e2e/booking.spec.ts`, `e2e/scenario-7-deletion.spec.ts` | `test/quote.ts`, `e2e/test1.spec.ts` |
| Branch / commit | `build/<package-id>`; `<module>: <imperative summary>` | `build/crm-P3`, `crm: merge persons with audit trail`, `booking: add waitlist claim links` | `feature/merge`, `Fixed stuff` |

## 2. Idempotency keys

Grammar (architecture section 3, data model DM-5):

```
key        = noun ":" id *( ":" qualifier )
noun       = lower-case snake_case word            ; email, expire, grant, schedule, webhook ...
id         = id as stored (uuid, provider id)      ; never re-encoded
qualifier  = noun | date | hour | minute | counter
date       = YYYY-MM-DD                            ; Brussels calendar date
hour       = YYYY-MM-DDTHH                         ; UTC, throttle keys only
minute     = YYYY-MM-DDTHH:mm                      ; UTC, schedule keys, polling throttles, stored-time buckets
counter    = integer | "v" integer | "r" integer   ; :3, :v2, :r1
```

Never a wall-clock timestamp in seconds or milliseconds. The one exception is the Mollie webhook
key, whose `external_event_id` is `<payment_id>:<received_at ms>`: a stored receipt identity.

The keys in use: `email:<message_id>`, `campaign:<campaign_id>:chunk:<n>`,
`campaign:<id>:person:<id>` (message key), `automation:<enrolment_id>:<step_key>`,
`billit:invoice:<invoice_id>`, `payment:<provider_payment_id>:<status>`,
`payment_sync:<id>:<minute>`, `renewal:<membership_id>:<period_end date>`,
`expire:<grant_id>:<expires_at YYYY-MM-DD>`, `grant:<source>:<ref_id>[:<n>]`
(`grant:order_line:<id>:<n>`, `grant:voucher:<id>`, `grant:refund:<refund_id>`),
`schedule:<kind>:<YYYY-MM-DDTHH:mm>`, `webhook:<provider>:<external_event_id>` (replays
`:replay:<n>`), `privacy:<request_id>:<step>`, `privacy:<request_id>:r<attempt>:external:<billit|mandates|resend>`,
`supp:<suppression_id>`, `slack:<fingerprint>:<YYYY-MM-DDTHH>`, `stats:<person_id>:<minute>`,
`sessions.regenerate_date` keys with the template version (`:v<version>`). Fingerprints passed to
`notifySlack` are opaque and may contain `-`. The message key passed to
`email.sendTransactional` is its `key` field; the job that sends it is keyed `email:<message_id>`.

**Accepted edge (platform edge case 6).** Succeeded jobs are pruned after 7 days. A key reused
after that creates the job again. Keys embed ids and dates and every handler is idempotent on
state (a second run yields the same state), so the rerun is harmless. Do not build logic that
relies on a job row still existing after 7 days.

## 3. The file set of a module

A module `<m>` owns (architecture section 1): `packages/db/src/schema/<m>.ts` and `<m>.views.ts`,
`packages/db/src/seed/<m>.ts`, `packages/core/src/<m>/`, `apps/web/modules/<m>/` (below),
`packages/email/src/templates/<m>/`, `packages/core/src/i18n/messages/<locale>/<m>.json` and the
route folders of its spec.

| File | Holds |
| --- | --- |
| `actions.ts` | every mutation, `export const verbNoun = action({ name, audience, permission, input, audit }, handler)` |
| `queries.ts` | `getX` / `listX` read functions for the module's own screens |
| `api.ts` | the only door for other modules: functions with the caller's transaction first (`tx, ctx, input`) |
| `jobs.ts` | facade: `jobs` and optionally `webhookHandlers` |
| `schedules.ts` | facade: `schedules` |
| `events.ts` | facade: `events` |
| `permissions.ts` | facade: `permissions` |
| `nav.ts` | facade: `nav` |
| `privacy.ts` | facade: `privacy` and optionally `noPiiTables` |
| `config.ts` | facade: `settings` and `flags` |
| `seed.ts` | facade: `seed` (demo data) |
| `merge-fields.ts` | facade: `mergeFields` (only modules that offer email merge fields) |
| `ui/` | the module's React components |

Skeletons (the facade formats are section 4):

```ts
// actions.ts
export const cancelBooking = action(
  { name: 'booking.cancel', audience: 'staff', permission: 'bookings.write', input: CancelBookingInput, audit: 'bookings' },
  async (ctx, input) => { /* ctx.tx, ctx.enqueue, ctx.recordEvent, ctx.audit */ },
);

// api.ts
export async function getBookingHealth(tx: DbOrTx, ctx: Ctx, input: { personId: string }): Promise<BookingHealth> { ... }

// queries.ts
export async function listSessions(tx: DbOrTx, input: { from: Date; to: Date }) { ... }
```

## 4. Registries and facade formats (`pnpm gen:indexes`)

The generator (`apps/web/scripts/gen-indexes.ts`) reads facade files statically with the
TypeScript compiler API. It never imports them. Rules:

1. Each registration is declared in the module's **top-level facade file** with `export const
   <name> = ...` directly (not re-exported, not built with spreads or function calls around the
   whole list).
2. Every key is a **string literal** in that file: `kind`, `key`, `name`, `permission`, `provider`,
   `area`, `after`. A non-literal key fails with `registry values must be string literals` and
   the file and line.
3. An entry may be an object literal, a `defineX({ ... })` call with an object literal, or a
   `const` declared in the same file with one of those. Only implementations (`run`, `handle`,
   `export`, `erase`, `sweep`, resolvers, components) may be identifiers imported from a sub-folder
   file such as `./duplicates/jobs`.
4. A key declared twice (in one or two modules) fails with both file paths. Nothing is written
   when anything fails.
5. A missing facade file or export is skipped, never an error: any subset of modules may exist.

| Facade | Export | Form | Key |
| --- | --- | --- | --- |
| `jobs.ts` | `jobs` | array of `defineJob({ kind, ... })` | `kind` |
| `jobs.ts` | `webhookHandlers` | array of `defineWebhookHandler({ provider, handle })` | `provider` (one handler per provider) |
| `schedules.ts` | `schedules` | array of `defineSchedule({ kind, cron, payload?, catchUp? })` | `kind` |
| `events.ts` | `events` | array of `defineEvent({ kind, data, isSensitive?, subject })` | `kind` |
| `permissions.ts` | `permissions` | array of string literals (or `{ permission: '...' }`), `as const` allowed | the string |
| `nav.ts` | `nav` | array of `{ key, area: 'admin' \| 'portal', section, labelKey, href, permission?, icon, order }` | `key` (`<m>.<name>`); `area` must be literal |
| `privacy.ts` | `privacy` | one object `{ tables, export, erase, sweep?, retention? }` | the module |
| `privacy.ts` | `noPiiTables` | array of table-name literals | union across modules |
| `config.ts` | `settings` | array of `{ key, schema, default, isSystem? }` (or a `define*` call) | `key`, snake_case |
| `config.ts` | `flags` | array of `{ key, description }` | `key`, `ff_<m>_<name>` |
| `seed.ts` | `seed` | one object `{ after?: ['platform', ...], run(ctx) }` | the module; `after` literal |
| `merge-fields.ts` | `mergeFields` | object keyed by field name: `Record<string, resolver>` | `<m>.<field>` |
| `packages/email/src/templates/<m>/index.ts` | `templates` | array of `defineTemplate({ name, component, ... })` | `<m>.<name>` |
| `packages/db/src/seed/<m>.ts` | `seed` | one object `{ after?, run(db) }` | the module |

Example facade:

```ts
// apps/web/modules/credits/jobs.ts
import { defineJob } from '@/lib/job-runner';
import { runExpireGrant } from './expiry/jobs';

export const jobs = [
  defineJob({ kind: 'credits.expire_grant', lane: 'fast', input: ExpireGrantInput, run: runExpireGrant }),
];
```

Outputs (git-ignored, regenerated before `dev`, `build`, `test`, `typecheck`, `lint` and
`db:generate`). Imports are sorted by module id and entries by key; each record value points at
the facade's array element (`crm_jobs[0]!`). With no entries a file is `export {};` plus the
empty constants, so every import resolves from wave 0.

| Output | Exports |
| --- | --- |
| `apps/web/registry/jobs.generated.ts` | `JOB_BY_KIND`, `JOBS` |
| `apps/web/registry/webhooks.generated.ts` | `WEBHOOK_HANDLERS` (keyed by provider) |
| `apps/web/registry/schedules.generated.ts` | `SCHEDULE_BY_KIND`, `SCHEDULES` |
| `apps/web/registry/events.generated.ts` | `EVENTS` |
| `apps/web/registry/permissions.generated.ts` | `PERMISSIONS` (sorted strings), `PERMISSION_MODULE` |
| `apps/web/registry/nav.generated.ts` | `NAV_BY_KEY`, `NAV` (`admin`, `portal`; sorted by key, render order is the items' `order`) |
| `apps/web/registry/privacy.generated.ts` | `GDPR_REGISTRY` (keyed by module), `NO_PII_TABLES` |
| `apps/web/registry/settings.generated.ts` | `SETTINGS` (definition plus `owner`) |
| `apps/web/registry/flags.generated.ts` | `FLAGS` (definition plus `owner`) |
| `apps/web/registry/seeds.generated.ts` | `DEMO_SEEDS` (`{ module, after, run }`, topological, ties by module id) |
| `apps/web/registry/merge-fields.generated.ts` | `MERGE_FIELDS` keyed `<m>.<field>` |
| `apps/web/registry/types.generated.ts` | unions `ModuleId`, `JobKind`, `EventKind`, `Permission`, `ScheduleKind`, `SettingKey`, `FlagKey`, `TemplateKey`, `MergeFieldKey`, `WebhookHandlerProvider`, `NavKey`; `MessageKey` |
| `packages/db/src/schema/index.ts` | `export *` of each `<m>.ts` and its `<m>.views.ts` when present (`_shared.ts` excluded) |
| `packages/db/src/seed/index.generated.ts` | `DEFAULT_SEEDS` (topological) |
| `packages/core/src/i18n/messages/index.generated.ts` | `MESSAGES[locale][module]`, `MESSAGE_LOCALES`, `MESSAGE_MODULES` |
| `packages/email/src/templates/registry.generated.ts` | `TEMPLATE_REGISTRY` keyed `<m>.<name>`, `TEMPLATE_KEYS` |

Record values are typed by their literal keys. Generic runtime code in `apps/web/lib` that looks
an entry up by a runtime string casts once to its own definition type, for example
`(JOB_BY_KIND as Readonly<Record<string, JobDefinition | undefined>>)[row.kind]`. Library code
imports the unions of `types.generated.ts` only, so the type cycle with the modules is harmless.

**Template key rule.** The key is `<folder>.<declared name>`. The collector fails when the name
contains a slash (`platform/magic-link`), when the kebab form of the name differs from the
basename of the file the `component` is imported from (`magic_link` with `./sign-in-link`), when
`component` is not imported from its own file, and on a duplicate key. One file, one key.

**Seeds.** `after` lists module ids; an `after` entry naming a module that has no seed is ignored
(any subset may exist), an unknown module id or a cycle fails.

## 5. How to add ...

**A table.** Add it to your `packages/db/src/schema/<m>.ts` (snake_case plural, `id uuid`
default, `created_at`, `updated_at` on mutable tables, enums `<table>_<column>`). Mark APPEND
tables in the spec and the orchestrator's `append_only` list. Views go in `<m>.views.ts` as
`pgView(name, columns).existing()` plus `<name>Sql`. Register the table in your `privacy.ts`
(`tables`, `export`, `erase`) or, when it holds no personal data, in `noPiiTables`; add a
factory beside your tests; `gdpr-coverage.test.ts` fails on any column referencing `persons.id`
that is neither registered nor listed. Never write a migration: the orchestrator generates it.

**A job.** `defineJob({ kind: '<m>.<verb_noun>', lane, input, run })` in `modules/<m>/jobs.ts`
(the handler may live in a sub-folder file). Enqueue with `ctx.enqueue({ kind, payload, key })`
in the same transaction as the write. Add it to `jobs.test.ts`, which runs every job twice.

**A schedule.** `defineSchedule({ kind, cron })` in `schedules.ts` (cron in `Europe/Brussels`);
the kind must also be a job (`registries.test.ts`).

**An event.** `defineEvent({ kind: '<entity>.<fact>', data, subject })` in `events.ts`; record it
with `ctx.recordEvent({ kind, personId, data, dedupeKey })`.

**A permission.** Only the strings of architecture section 4, in the owner's `permissions.ts`.
A new one is a `Requests:` line to platform.

**A nav item.** An entry in `nav.ts` with literal `key` and `area`, a `labelKey` in your
catalogue and the permission that guards the page (PL-19).

**A template.** A file `packages/email/src/templates/<m>/<kebab-name>.tsx` and an entry
`defineTemplate({ name: '<snake_name>', component, props, slots })` in that folder's `index.ts`;
copy slots go in your catalogue as `<m>.email.<name>.<slot>`.

**A catalogue key.** Add `<m>.<screen>.<element>` to `packages/core/src/i18n/messages/{nl-BE,fr-BE,en}/<m>.json`
in all three locales (`en` is the source, real Dutch and French); `pnpm i18n:check` fails on a
missing key. A key you need in another module's catalogue is a `Missing-catalogue-keys:` trailer.

**A setting or flag.** In your `config.ts`:

```ts
export const settings = [
  { key: 'booking_rules', schema: BookingRules, default: DEFAULT_BOOKING_RULES },
];
export const flags = [
  { key: 'ff_booking_lead_priority', description: 'Lead-priority booking windows (R2)' },
];
```

Read them with `getSetting(tx, 'booking_rules')` and `flag('ff_booking_lead_priority', actor)`.
Staff edit settings only through platform's `updateSetting` (PL-41).

## 6. Forward-call stubs (build order rule 1)

A package may call another module's function before its implementing package merges. The
function then already exists in `apps/web/modules/<m>/api.ts` with its final signature:

```ts
export async function findOrCreatePersonByEmail(tx: Tx, ctx: Ctx, input: FindOrCreateInput): Promise<{ personId: string; created: boolean }> {
  throw new NotImplementedError('crm.findOrCreatePersonByEmail');
}
```

The caller mocks it in tests (`vi.mock('@/modules/crm/api', ...)`) and never edits it. Six stubs
return a neutral value instead of throwing (build order section 2 table). Tables and views are
never stubbed.

## 7. Frozen files

Never edited by a module package (only by the package that owns them, then by orchestrator PRs):
`apps/web/lib/*`, `apps/web/proxy.ts`, `apps/web/next.config.ts`,
`packages/db/src/schema/_shared.ts`, `packages/db/src/schema/platform.ts`, existing columns of
contract tables, `packages/config/*`, root configs (`turbo.json`, `eslint.config.js`,
`vercel.json`, `tsconfig.base.json`, `renovate.json`), `.github/CODEOWNERS`, every
`package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `packages/db/migrations/**` and every
generated file (`*.generated.ts`, `packages/db/src/schema/index.ts`).

## 8. Import boundaries (ESLint)

`packages/config/eslint.config.js` enforces architecture section 1 with `no-restricted-imports`:
a module imports another module only through `modules/<m>/api` (or `@beam/core/<m>`);
`@beam/core` imports `@beam/db` types only; `@beam/ui` imports no server code; the Anthropic SDK
is imported only under `packages/integrations/src/anthropic/` (PL-51). `no-console` is an error
outside scripts. Run `pnpm lint`, or `pnpm exec eslint <files>` for the files you changed.
