# BEAM conventions (the rule card)

Every coding agent reads this page first. The long reference with examples is
`docs/plan/conventions.md`; the binding sources are `docs/plan/00-decisions.md`,
`docs/plan/01-architecture.md`, `docs/plan/02-data-model.md` and
`docs/plan/04-build-session.md`.

1. **Where things go.** The twelve modules are `platform`, `crm`, `booking`,
   `commerce`, `credits`, `finance`, `forms`, `email`, `automation`, `ops`, `site`
   and `webinar`. A module `<m>` owns: `packages/db/src/schema/<m>.ts` and
   `<m>.views.ts`; `packages/db/src/seed/<m>.ts`; `packages/core/src/<m>/`;
   `apps/web/modules/<m>/{actions,queries,api,jobs,schedules,events,permissions,nav,privacy,config,seed,merge-fields}.ts`
   and `apps/web/modules/<m>/ui/`; `packages/email/src/templates/<m>/`;
   `packages/core/src/i18n/messages/<locale>/<m>.json`; and the route folders listed
   in its spec.
2. **Ownership.** Edit only the files in your package's `owns` list
   (`docs/build/ownership.json`). Test files that start with your package id in
   lower case, inside a folder you own, are also yours.
3. **Never edit** any `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`,
   `packages/db/migrations/**`, any `*.generated.ts`, `packages/db/src/schema/index.ts`,
   or a frozen file: `apps/web/lib/*`, `apps/web/proxy.ts`,
   `packages/db/src/schema/{_shared,platform}.ts`, existing contract-table columns,
   `packages/config/*`, root configs, `.github/CODEOWNERS`. The only exception is a
   file in your own `owns` list.
4. **Cross-module calls** go only through `apps/web/modules/<m>/api.ts` and
   `@beam/core/<m>`, with the caller's transaction first (`tx, ctx, input`). Need
   something another module lacks? Do not add it: list it under `Requests:` in your
   commit message.
5. **Mutations** are `action()` in `actions.ts`. **Side effects** are jobs
   (`defineJob`) enqueued in the same transaction. A request never calls a provider.
6. **Contract tables are shared.** Other modules' code and fixtures insert into contract
   tables (persons, orders, order_lines, products, sessions, bookings, invoices,
   email_messages, ...). A column you add to one must be nullable or have a default, unless
   the spec requires otherwise; then list every other module's fixture that breaks under
   `Requests:`. In tests, create another module's rows through the shared factories
   (`@beam/db/testing`, `@beam/db/testing/<m>-factories`), not raw inserts.
7. **Facts are append-only.** Never update or delete rows of an APPEND table;
   balances and statuses are views.
8. **Naming.** Tables snake_case plural; enums `<table>_<column>`; views `v_<name>`;
   event kinds `<entity>.<past_tense_or_fact>`; job kinds `<module_or_entity>.<verb_noun>`;
   permissions `<module>.<action>`; i18n keys `<m>.<screen>.<element>`; flags
   `ff_<m>_<name>`; settings keys snake_case in `config.ts`; idempotency keys
   `<noun>:<id>[:<qualifier>]` (no wall-clock timestamps); transactional templates
   `<m>.<snake_name>`, marketing templates kebab-case; files kebab-case, React
   components PascalCase.
9. **Money, time, language.** Integer cents in EUR, VAT per line; UTC in the
   database, `Europe/Brussels` in logic; `nl-BE`, `fr-BE` and `en` everywhere, with
   no fallback language.
10. **Sensitive data** is read only through `readSensitive()`; never in logs, AI
   context, segments or exports.
11. **Tests.** Vitest beside the code; integration tests use `createTestDb()` and the
    factories; provider fakes only, no network; every job runs twice in `jobs.test.ts`;
    `privacy.test.ts` and `permissions.test.ts` per module. Playwright specs are
    written and listed (`playwright test --list`), never run by a coding agent.
    Never assert that another package's stub still throws, or the value your code
    falls back to while it throws (a `null` card, an empty list): mock that
    function with `vi.mock` to the shape its contract promises, so the test stays
    true when the real implementation lands. Never assert that a registry has
    exactly the entries of today (later packages implement stubs and add jobs,
    schedules and templates): assert behaviour that stays true.
    In Playwright, never wait on a bare `getByRole("alert")`: Next.js renders a
    hidden route announcer with `role="alert"`, so the wait passes before your
    server action finishes. Wait for the action's POST response
    (`page.waitForResponse`) or for the specific message text, and reset the
    shared demo rows you touch both before and after the test.
12. **Before you commit**, run the command list of section 4 of
    `docs/plan/04-build-session.md` (install offline, `gen:indexes`, typecheck,
    eslint on your files, `i18n:check`, your Vitest suites, the ownership check).
13. **Commit** on branch `build/<package-id>` with the message `<module>: <summary>`
    and the trailers of section 4 (`Package`, `Wave`, `Tests`, `Decisions`,
    `Requests`, `Dependency-requests`, `Missing-catalogue-keys`). Never push.
