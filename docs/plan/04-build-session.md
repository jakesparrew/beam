# BEAM build session runbook

This is the document the orchestrator follows to build the whole BEAM platform in this cloud sandbox, wave by wave, without asking questions. It covers V1 and Releases 2, 3 and 4 (waves 0 to 23 of `docs/plan/build-packages.json`). Items the proposal marks "Later" (automated B2B prospecting, voice AI, predictive analytics, a native mobile app, gamification) stay documented in the specs and are not built.

**Sources, in order of authority.** `00-decisions.md`, then `01-architecture.md`, then `02-data-model.md`, then `build-packages.json` (the machine plan), then `03-build-order.md`, then the module specs in `docs/plan/modules/`. This file decides how the session runs. Where it decides something the other files left open or contradicted, the decision is listed in section 0 and is binding for the orchestrator and every coding agent.

**Who does what.**

- The **orchestrator** is the Claude session that reads this file. It drives coding agents with the Workflow tool, owns the root files, merges branches, runs gates, generates migrations, seeds `beam_dev`, runs Playwright, commits and pushes.
- A **coding agent** is one build package: model `claude-opus-5-5`, Workflow agent option `isolation: 'worktree'`, a worktree created from the integration branch `claude/focused-hopper-gpky3y`. It commits on `build/<package-id>` and returns. It never pushes.
- A **fixer agent** is a coding agent with the same rules, launched on a failure (section 5.6).

## 0. Decisions made in this runbook

Each decision has an id (BS-n). Specs that say otherwise are read through these.

| Id | Decision |
| --- | --- |
| BS-1 | Architecture "Wave 0" means build waves 0 to 3 (platform-P1 to P7) plus the orchestrator step W0-0. Section 3 of this file covers all of it. |
| BS-2 | W0-0 is done by the orchestrator, not a coding agent. It owns every root file that no package owns: all `package.json` files, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.npmrc`, root `tsconfig.base.json`, `.gitignore`, `.env.example`, `.gitleaks.toml`, `.github/CODEOWNERS`, `CONVENTIONS.md`, `docs/build/ownership.json`, `scripts/build/*`. |
| BS-3 | Every npm version is pinned exactly (no `^`, no `~`) through the pnpm catalog in `pnpm-workspace.yaml`. Workspace `package.json` files reference `catalog:`. `.npmrc` has `save-exact=true`. |
| BS-4 | Version policy: the latest stable version on 2026-11-03 (checked with `npm view`), except where a constraint forces another: `next` and `@next/eslint-plugin-next` stay on 16.4.4 (locked and build-verified; 16.4.5 was published today), `typescript` 5.9.3 (7.x is out of scope), `@types/node` 22.20.5 (Node 22 runtime), `next-auth` 5.0.0-beta.32 (v5 is the `beta` tag; `latest` is v4), `@hookform/resolvers` 6.0.2 (7.0 is a 3-day-old major). |
| BS-5 | `react-email@6.11.6` provides the email components (`Html`, `Body`, `Button` and so on); `@react-email/components` is deprecated on npm and is not installed. Rendering uses `@react-email/render@2.2.0`. Specs that say `@react-email/components` mean `react-email`. |
| BS-6 | The PWA uses `@serwist/next` (webpack plugin). `apps/web` builds with `next build --webpack`; `next dev` keeps Turbopack because Serwist is disabled in development. |
| BS-7 | Dependency requests go to `docs/build/dependency-requests/<package-id>.md`, one file per package (build order rule 3). Specs that name `docs/build/dependency-requests.md` mean this folder. |
| BS-8 | Fake-provider mode is selected per provider (section 1.4). Tonight every provider is fake, because no key exists. `.env.local` also sets `INTEGRATIONS=fake`. |
| BS-9 | The runtime payments fake has a hosted pay page at `apps/web/app/api/dev/fake-pay/[id]/route.ts`, owned by commerce-P4a (amendment A4). It answers 404 when `APP_ENV=production`. |
| BS-10 | `EMAIL_SINK` holds an address, never `1`. Sandbox, CI and preview use `EMAIL_SINK=sink@beam.be`. Where `build-packages.json` gate strings say `EMAIL_SINK=1`, `scripts/build/gate.sh` exports `EMAIL_SINK=sink@beam.be` instead. |
| BS-11 | Seeding: `pnpm db:seed` runs the `defaults` profile and then the `demo` profile outside production, and only `defaults` in production. `pnpm db:seed --profile defaults` runs only defaults (deploy). `pnpm seed:demo` is `pnpm db:seed --profile demo`: it also runs `defaults` first (they are idempotent, and demo rows need the roles and settings they create), and it refuses in production. |
| BS-12 | Migration names: wave 1 creates `init`, `append_only` and `init_views` (the architecture's `0001_init.sql` and `0002_append_only.sql`; drizzle-kit numbers them `0000_init.sql`, `0001_append_only.sql`, `0002_init_views.sql`). Every later wave that changes the schema creates `w<NN>`, then `w<NN>_views` when views changed, then `w<NN>_protect` when it created an APPEND table. The R4 custom files keep the names `ai_readonly` and `ai_views_ops`. The numeric prefix is drizzle-kit's. |
| BS-13 | The wave gate is `scripts/build/gate.sh <wave>` (section 5.4). It runs the JSON gate list plus `pnpm db:check-migrations`, `pnpm --filter @beam/db test:migrations`, from wave 1 `pnpm db:views --check`, `pnpm db:append-only --check` and `pnpm i18n:check` (DR-4), and from wave 3 `pnpm gdpr:coverage`. |
| BS-14 | Playwright is `@playwright/test@1.64.1`, which uses chromium revision 1248. Re-checked on 2026-11-03 in the dry run: `/opt/pw-browsers` already holds `chromium-1248` and `chromium_headless_shell-1248` (next to 1194), so `playwright install chromium` in W0-0 is a no-op check. If 1248 is ever missing and the download fails, W0-0 pins `@playwright/test@1.56.1` instead, which uses revision 1194. |
| BS-15 | End-to-end runs use a production build: `pnpm build` then `next start -p 3100`, started by Playwright's `webServer`. Two Playwright workers, one retry. Every spec creates its own persons with unique emails, so specs never depend on each other. Jobs run during e2e through the local tick of DR-13. |
| BS-16 | At most 6 coding agents run at once, never more (binding). The Workflow tool caps concurrent `agent()` calls per run at min(16, CPUs − 2), which is 2 on this 4-CPU sandbox. The orchestrator splits a wave's sorted package list round-robin into up to three groups and starts one Workflow run per group at the same time, so at most 6 agents run. If the tool does not accept a second concurrent run, it runs the groups one after another (2 agents at a time) and notes the slower pace in the wave log. It never raises the limit above 6. |
| BS-17 | `docs/build/ownership.json` is generated by the orchestrator from `build-packages.json` at the start of every wave (`node scripts/build/ownership.mjs`), with the placeholder `/m/` in platform-P7's list expanded to the eleven module ids. platform-P1's `check-ownership.ts` reads it. It is removed from platform-P1's `owns` (amendment A1). |
| BS-18 | The orchestrator never edits a module's files to fix a red gate. It runs a fixer agent (section 5.6). The only files it writes are the BS-2 files, migrations, `docs/build/*` and the plan amendments of section 1.3. |
| BS-19 | The coverage matrix is `docs/plan/05-coverage.md`. It maps every proposal promise (section 2 scope rows, section 11 scenarios, section 12 acceptance rows) to its package and test. The orchestrator fills its Status column at each checkpoint. |
| BS-20 | Demo staff accounts are `<role>@demo.beam.be` for the nine roles, all with the password in `DEMO_STAFF_PASSWORD` and the TOTP secret in `DEMO_TOTP_SECRET` (section 6). |
| BS-21 | mjml's `htmlnano` asks for `cssnano@^8` as a peer and gets 7.1.9. mjml minification is never used, so `peerDependencyRules.allowedVersions` accepts it. `zod` is overridden to 4.6.7 so Serwist's internal 4.6.5 copy does not duplicate it. |
| BS-22 | Uncommitted plan files are committed before W0-0 starts. The plan is frozen from then on; a later plan change is its own orchestrator commit with the message `plan: <summary>`. |
| BS-23 | A package may add test files that its `owns` list does not name, if they sit inside a folder the package owns and their file name starts with the package id in lower case (`crm-p3.merge.test.ts`, `__fixtures__/crm-p3/...`). `check-ownership.ts` allows exactly that pattern, so two packages of one module in one wave never collide. |
| BS-24 | "Conventional commit message" means the repository convention of architecture section 11: `<module>: <imperative summary>` plus the trailers of section 4 (`Package`, `Wave`, `Tests`, `Decisions`, `Requests`, `Dependency-requests`, `Missing-catalogue-keys`) and the session's attribution lines. Orchestrator commits use the prefixes `build:`, `merge:`, `db:` and `plan:`. |

### 0.1 Dry-run decisions (2026-11-03)

A dry run walked W0-0, waves 0 to 3 and waves 4 and 5 as each coding agent would receive them. These decisions fix what it found. They are already applied to `build-packages.json` and the platform spec; the orchestrator does not apply them again.

| Id | Problem found | Decision |
| --- | --- | --- |
| DR-1 | Several files that waves 0 to 3 need had no owner: `apps/web/lib/testing.ts`, `apps/web/postcss.config.mjs`, `apps/web/app/globals.css`, `packages/db/scripts/views-sql.ts`, the Billit files P3 must ship, `packages/core/src/{i18n,ai,privacy}/index.ts` (targets of the `@beam/core/*` exports), every `packages/integrations/src/<provider>/index.ts`, `apps/web/tsconfig.json`, `packages/db/tsconfig.json`. | Owners added in `build-packages.json`: P1 gets the two tsconfigs, `packages/db/vitest.config.ts`, `apps/web/postcss.config.mjs`, `packages/config/src/server-only-stub.ts`, `e2e/global-setup.ts`, `e2e/support/a11y.ts`. P2 gets `views-sql.ts` and its test. P3 gets `billit/{index,types,client,fake}.ts`, `_shared/index.ts`, the provider `index.ts` files and the three core index files. P5 gets `lib/testing.ts`. P6 gets `app/globals.css`. Later providers' `index.ts` go to the package that creates the provider (email-P1 `resend`, webinar-P2 `youtube`, ops-P8 `ads`, automation-P3 `webhook`, crm-P9 `meta-messaging`). |
| DR-2 | 343 test files named in the packages' `tests` lists were not in their `owns` lists, so `check-ownership.ts` would have failed almost every package. | Every test file path named in a package's `tests` is now in its `owns`. A check over all 24 waves found no file owned by two packages of the same wave. |
| DR-3 | Amendments A1, A4, A5, A9 and A10 were to be applied at pre-flight. | Applied now. A3 stays a rule of `ownership.mjs` (the JSON keeps `/m/`). Pre-flight step 4 only validates the JSON. |
| DR-4 | Wave 0 gate: `i18n:check`, `db:views --check` and `db:append-only --check` call scripts that P2 and P3 write in wave 1. | `gate.sh` runs those three steps from wave 1 on (section 5.4). |
| DR-5 | Turborepo 2 runs tasks in strict env mode, so `NODE_USE_ENV_PROXY`, `NODE_EXTRA_CA_CERTS`, `AUTH_SECRET`, `SENSITIVE_DATA_KEY_V1`, the provider keys and `PLAYWRIGHT_BROWSERS_PATH` would be stripped from `pnpm test` and `pnpm build`. A root task `//#gen` runs a root script named `gen`, which does not exist. | `turbo.json` sets `"envMode": "loose"` (`globalEnv` still lists the values that change outputs) and the root task is `//#gen:indexes`. |
| DR-6 | Memory: 6 agents each running `turbo run typecheck` (7 `tsc` processes) and Vitest with one worker per CPU would exceed 16 GB. | Root scripts pass `--concurrency=2` to Turborepo for `typecheck`, `lint` and `test`. The shared Vitest preset sets `maxWorkers: 2` and `pool: 'forks'`. Before starting an agent the orchestrator needs 3 GB `available` in `free -g`, else it waits. |
| DR-7 | `apps/web` typecheck ran `tsc` without Next's generated route types, so typed-route errors (`typedRoutes` is on) would only show in the gate's `next build`. | `apps/web` `typecheck` is `next typegen && tsc --noEmit` (`next typegen` exists in 16.4.4). |
| DR-8 | `@beam/integrations` mapped `./*` to `src/*/index.ts`, and `./_shared` to `types.ts` only, so `errors.ts` and most clients could not be imported. `seedDefaults` had no export path. | Exports are fixed in section 3.1. `@beam/db` gets `"./seed": "./src/seed/run.ts"`. |
| DR-9 | Vitest in `apps/web`: `server-only` throws when imported outside a React Server build, and `@/` imports need an alias. Two Vite copies could be resolved because `vite` is only a peer. | P1's `apps/web/vitest.config.ts` aliases `server-only` to `packages/config/src/server-only-stub.ts` (`export {};`) and `@` to `apps/web`. `vite@8.3.5` joins the catalog and every workspace that runs Vitest. |
| DR-10 | P5 (wave 2) calls `booking.getBookingHealth` and `ops.isDpiaApproved`, and P6 (wave 3) calls `crm.findOrCreatePersonByEmail`, `email.sendTransactional` and `site.readReferralCode`. Their stubs were written by P7, which runs in wave 3 next to P6, so P5 and P6 could not compile. | P5 writes those five functions as forward stubs (exact section 4.9 signatures, types declared in the stub file) in `apps/web/modules/{booking,ops,crm,email,site}/api.ts`. P7 rewrites the five files in wave 3 with the full stub sets, moves the types to `packages/core/src/<m>/types.ts` and keeps the five exports unchanged. P6 never edits them. |
| DR-11 | Auth.js v5 (`@auth/core` 0.41.3, checked in its source) issues a JWT cookie for the Credentials provider even when the session strategy is `database`, so a staff password sign-in would never find its `auth_sessions` row. The Drizzle adapter's `createUser` and `createSession` would also violate the NOT NULL columns `users.audience`, `users.person_id` (customers) and `auth_sessions.audience`, `absolute_expires_at`. | No Credentials provider. Auth.js keeps the Email provider (magic link), database sessions, `auth()` and sign-out. The staff sign-in server action checks password, lockout and rate limit, inserts the `auth_sessions` row (32 random bytes, base64url) and sets the Auth.js session cookie with `cookies().set()`; the cookie name is the exported `SESSION_COOKIE` of `lib/auth-config.ts` (`authjs.session-token`, `__Secure-` prefix when `APP_URL` is https). The adapter is `{ ...DrizzleAdapter(db, tables), createUser, createSession }` with overrides that run PL-12 and fill `audience` and `absolute_expires_at`. `proxy.ts` only checks that the cookie exists (no database call per request); `requireStaff()` and `requireCustomer()` in layouts do the real check. |
| DR-12 | P7's demo seed needed `hashPassword` and the TOTP storage of P6, which runs in the same wave. P7's `smoke.spec.ts` needed P6's `e2e/support/a11y.ts`. | `apps/web/modules/platform/seed.ts` and its test move to P6. `e2e/support/a11y.ts` moves to P1 (wave 0). P7 keeps `seed-demo.ts` (the runner) and tests it with fixture seeds. P7 writes each module's `actions.ts` and `queries.ts` as `export {};` because `lib/action.ts` lands in the same wave. |
| DR-13 | Nothing processed jobs under `next start` or `next dev`, so magic links, the fake pay webhook and every e2e flow that waits for a job would hang. | `apps/web/instrumentation.ts` (P5) starts an in-process tick when `LOCAL_TICK_MS` is set and `APP_ENV` is `local`: every `LOCAL_TICK_MS` ms it runs the same `runTick()` that `/api/cron/tick` calls (exported from `lib/job-runner.ts`), skipping a beat while the previous one runs. Playwright's `webServer` sets `LOCAL_TICK_MS=1000`; `.env.local` sets `LOCAL_TICK_MS=5000` for `pnpm dev`. It refuses to start in `preview`, `staging` and `production`. |
| DR-14 | The wave 3 `platform.spec.ts` customer magic-link step creates a new customer, which calls the throwing crm stub until crm-P2 (wave 5). | P6's platform demo seed gives the first five of the 20 test persons a customer `users` row (`customer1@example.com` to `customer5@example.com`). `platform.spec.ts` signs in as `customer1@example.com`; new-account sign-up is proven in Vitest with the crm mock until wave 5. |
| DR-15 | `@sentry/nextjs` 11 loads browser config from `instrumentation-client.ts`; `sentry.client.config.ts` is only injected by `withSentryConfig`, which the build does not use (no auth token tonight). | P5 owns `apps/web/instrumentation-client.ts` instead of `sentry.client.config.ts`. `instrumentation.ts` imports `sentry.server.config.ts` in `register()` and exports `onRequestError = Sentry.captureRequestError`. `next.config.ts` is not wrapped with `withSentryConfig` until a `SENTRY_AUTH_TOKEN` exists (a platform-P8 or later frozen-file change). |
| DR-16 | Tailwind v4 only scans files under `apps/web`, so classes used in `packages/ui` would be missing; `tw-animate-css` is a dependency of `@beam/ui`, not of `apps/web`. | `apps/web/app/globals.css` (P6) is `@import "tailwindcss"; @import "@beam/ui/tokens.css"; @source "../../../packages/ui/src";`. `packages/ui/src/tokens.css` (P4) does `@import "tw-animate-css";` and imports the theme from `@beam/config/tailwind-theme.css`. `apps/web/postcss.config.mjs` (P1) is `export default { plugins: { '@tailwindcss/postcss': {} } };`. |
| DR-17 | `next-intl`'s plugin needs its request config file, which P6 writes in wave 3; `next.config.ts` is P1's (wave 0). `mjml` is a dependency of `@beam/email` only, so a server external could not be resolved from `apps/web`. | P1's `next.config.ts` applies `createNextIntlPlugin('./lib/i18n.ts')` only when that file exists (the same pattern as Serwist), lists every `@beam/*` package in `transpilePackages`, and adds `mjml` to `serverExternalPackages`. W0-0 also adds `mjml` to `apps/web` dependencies. `lib/i18n.ts` (P6) default-exports `getRequestConfig`. |
| DR-18 | ESLint would lint P1's own boundary fixtures (they contain the forbidden imports on purpose) and would refuse files outside every tsconfig. | The ESLint config ignores `apps/web/scripts/__fixtures__/**` (the test lints them with `ignore: false`), and `projectService` uses `allowDefaultProject: ['*.config.ts', '*.config.js', '*.config.mjs']`. P1's `packages/db/tsconfig.json` includes `test` and `vitest.config.ts`; `apps/web/tsconfig.json` excludes `scripts/__fixtures__`. |
| DR-19 | The agent prompt's setup runs `pnpm gen:indexes`, which platform-P1 is writing; W0-0 removes `packages/db/src/schema/index.ts` from git, so a fresh P1 worktree has no schema index. | The prompt says: skip `pnpm gen:indexes` while `apps/web/scripts/gen-indexes.ts` does not exist. The generator writes `export {};` into every output that has no entries. |
| DR-20 | The Workflow `agent()` call has no timeout option, and a free-text report must be parsed. | The workflow script passes the report JSON schema of section 4 as `schema`, so `agent()` returns the object. The prompt gives each agent its time budget (2 × estimate, at most 240 minutes): it records `date +%s` at start and, past the budget, commits what it has and reports `failed`. The orchestrator never commits to the integration branch while a wave's workflow runs, because worktrees start from its current `HEAD`. |
| DR-21 | Next.js 16 rules the specs assume but do not state. | Binding for every agent (section 4, rule 11): `proxy.ts` (export `proxy`, Node runtime only), never `middleware.ts`; `params`, `searchParams`, `cookies()`, `headers()` and `draftMode()` are Promises and are awaited; route handlers type their context as `{ params: Promise<...> }`; `next lint` does not exist (use `pnpm lint`); `revalidateTag(tag, 'max')` takes the profile argument; `next build --webpack` (BS-6). |
| DR-22 | W0-0 was committed (`8272547`, 2026-11-03 20:18 UTC) while this dry run ran, so its manifests miss DR-7, DR-8, DR-9 and DR-17, and `docs/build/orchestrator-decisions.md` OD-6 still allows 8 agents. | Before platform-P1 merges, the orchestrator makes one `build: apply dry-run manifest fixes` commit: (1) `pnpm-workspace.yaml` catalog `vite: 8.3.5`, and `"vite": "catalog:"` in the devDependencies of every workspace that lists `vitest`; (2) `apps/web/package.json` `"typecheck": "next typegen && tsc --noEmit"` and `"mjml": "catalog:"` in dependencies; (3) root `package.json` `typecheck`, `lint`, `test` get `--concurrency=2`; (4) `packages/integrations/package.json` exports as in section 3.1; (5) `packages/db/package.json` export `"./seed": "./src/seed/run.ts"`; then `pnpm install` and `pnpm install --offline --frozen-lockfile`. `scripts/build/agent-prompt.md` gets the section 4 changes (time budget, rules 11 and 12, the facade rule in rule 3). OD-6 is read as "at most 6": BS-16 is binding and the 8-agent step is dropped. OD-7 is already satisfied: A4, A5, A9 and A10 are in `build-packages.json` (DR-3). The committed `gate.sh` already skips steps whose script is missing, which meets DR-4. |

## 1. Pre-flight

### 1.1 What already exists and works

Verified on 2026-11-03 by reading the code and running the commands below in `/home/user/beam` on branch `claude/focused-hopper-gpky3y`.

| Item | State | Evidence |
| --- | --- | --- |
| Sandbox | Linux, 4 CPUs, 15 GB RAM visible to `free -g`, 29 GB free on `/`. Node 22.22.0, pnpm 10.28.0. pnpm store `/root/.local/share/pnpm/store/v10` (shared by every worktree). | `node -v`, `pnpm -v`, `df -h`, `pnpm store path` |
| Git | Remote `origin` = `github.com/jakesparrew/beam`. Branch up to date with origin. Modified and untracked plan files exist (`01-architecture.md`, every module spec, `02-data-model.md`, `03-build-order.md`, `build-packages.json`). | `git status` |
| Root | `package.json` (`beam-platform`, `packageManager: pnpm@10.28.0`, scripts `build`, `dev`, `typecheck`, `test`, `db:generate`, `db:migrate`, `db:check`, `db:check-migrations`; deps `@neon/config@1.10.0`, `@neon/env@1.6.8`; dev `turbo@2.11.10`, `typescript@5.9.3`). `pnpm-workspace.yaml` (`apps/*`, `packages/*`, `onlyBuiltDependencies: [esbuild]`). `turbo.json` (tasks `build`, `typecheck`, `dev`, `test`; no `gen`, no `lint`). `tsconfig.base.json` (strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, Bundler resolution). `neon.ts` (Neon config as code, non-default branches get a 7-day TTL), `.neon` (gitignored link). `.env.example` (DATABASE_URL, DATABASE_URL_UNPOOLED, DATABASE_DRIVER only). `.env.local` (beam_dev URLs, production URLs under `PRODUCTION_*`, `DATABASE_DRIVER=neon-ws`). `.gitignore` (node_modules, .next, dist, .turbo, tsbuildinfo, next-env.d.ts, .env files, .neon). | file reads |
| `packages/db` (`@beam/db`) | Exports `.`, `./schema`, `./testing`. `src/client.ts`: `Db = PgDatabase<PgQueryResultHKT, Schema>`, `Tx`, `DbOrTx`, `resolveDriver()` (`pg`, `neon-ws`, `pglite`), `createDbHandle()`, `getDbHandle()` (one handle per instance on `globalThis`), `getDb()`; `pg` uses `attachDatabasePool`; `neon-ws` sets `neonConfig.webSocketConstructor = globalThis.WebSocket`. `src/health.ts`: `checkDatabase()` with a rolled-back temp-table round trip. `src/testing.ts`: `createTestDb({ from })` with `from` = `'schema'` or `'migrations'` on in-memory PGlite, `schemaToSql()` through `drizzle-kit/api`, `committedMigrationSql()`, `latestSnapshot()`, `migrationsFolder`. `src/schema/index.ts` is `export {}`. `drizzle.config.ts` (snake_case, strict, out `./migrations`, URL from `DATABASE_URL_UNPOOLED`). Scripts `migrate.ts` (pg and neon-ws), `check.ts`, `check-migrations.ts` (diffs schema against the latest snapshot). `migrations/meta/_journal.json` has no entries. Deps: drizzle-orm 0.45.4, drizzle-kit 0.31.11, pg 8.23.1, @neondatabase/serverless 1.2.0, @electric-sql/pglite 0.5.15, @vercel/functions 3.10.6, vitest 5.1.0, tsx 4.23.15, dotenv 18.0.9. | `pnpm --filter @beam/db test`: 2 files, 4 tests passed in 7.4 s |
| `apps/web` (`@beam/web`) | Next.js 16.4.4, React 19.3.1. `app/layout.tsx`, `app/page.tsx`, `app/api/health/route.ts` (Node runtime, `force-dynamic`, returns `checkDatabase()` with 200 or 503). `next.config.ts` loads the root `.env.local`, `transpilePackages: ['@beam/db']`, `serverExternalPackages: ['pg', '@electric-sql/pglite']`, `outputFileTracingRoot` at the repo root. | `pnpm typecheck`: 2 tasks green |
| `beam_dev` on Neon | PostgreSQL 18.6, reachable over WebSockets through the proxy, write/read round trip true, latency 3.5 s on a cold connection. `drizzle.__drizzle_migrations` exists from an earlier `pnpm db:migrate`; no application table exists. | `DATABASE_DRIVER=neon-ws NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt pnpm db:check` → `ok: true, database: beam_dev` |
| npm registry | Reachable through the proxy. Every version in section 2 was read with `npm view`; the full set was resolved together with `pnpm install --lockfile-only` in a scratch project (1,266 packages, no unmet peer except BS-21). | section 2.1 |
| Playwright browsers | `/opt/pw-browsers` holds chromium revision 1194 and ffmpeg 1011 (Playwright 1.56.x); `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`; the Playwright CDN is reachable (BS-14). | `ls /opt/pw-browsers`, `curl -r 0-1023` → 206 |

**Not there yet:** `packages/{config,ui,core,email,integrations}`, any schema table, any migration, lint, `gen:indexes`, registries, i18n catalogues, auth, the tick, CI workflows, `CLAUDE.md`, `CONVENTIONS.md`, `docs/plan/conventions.md`, Playwright config and specs, seed code.

**Never touched during the build:** the production database `neondb` (`PRODUCTION_DATABASE_URL*` in `.env.local`). No script reads those two variables; `scripts/build/gate.sh` refuses to run when `DATABASE_URL` contains `/neondb`.

### 1.2 Pre-flight checklist (run in this order)

```bash
cd /home/user/beam
git switch claude/focused-hopper-gpky3y && git pull --ff-only
# 1. The plan is frozen (BS-22).
git add docs/plan docs/requirements && git commit -m "plan: freeze the build plan before wave 0"
# 2. Environment sanity.
node -v | grep -q '^v22\.' && pnpm -v | grep -q '^10\.' && df -BG / | awk 'NR==2 && $4+0 < 15 {exit 1}'
grep -q 'beam_dev' .env.local && ! grep -E '^DATABASE_URL=.*/neondb' .env.local
DATABASE_DRIVER=neon-ws NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt pnpm db:check
pnpm typecheck && pnpm --filter @beam/db test
# 3. Coverage matrix exists (BS-19); if not, write it now from proposal sections 2, 11 and 12 and the tests lists.
test -f docs/plan/05-coverage.md
# 4. The amendments of section 1.3 are already in build-packages.json (DR-3); validate the JSON.
node -e 'JSON.parse(require("fs").readFileSync("docs/plan/build-packages.json","utf8"))'
git push origin claude/focused-hopper-gpky3y
```

The orchestrator stops the session only if step 2 fails (wrong Node, disk below 15 GB, `beam_dev` unreachable). Everything else it fixes itself.

### 1.3 Plan amendments the orchestrator applies before W0-0

These are edits to `build-packages.json` that close ownership gaps found while writing this runbook. A1, A4, A5, A9 and A10 are already applied (DR-3); A9's `a11y.ts` now belongs to platform-P1 (DR-12). A2, A6, A7 and A8 are rules for W0-0 and the gate. A3 is applied by `ownership.mjs`.

| Id | Amendment |
| --- | --- |
| A1 | platform-P1: remove `docs/build/ownership.json` from `owns` (BS-17). Replace `docs/build/dependency-requests.md` mentions in its spec text with the folder (BS-7). |
| A2 | platform-P1 spec mentions `.gitignore`, `.env.example`, `.gitleaks.toml`, `.github/CODEOWNERS` and `git rm --cached packages/db/src/schema/index.ts`; W0-0 does all five (BS-2). P1 reads them and does not edit them. |
| A3 | platform-P7: the owns entries `apps/web/modules/m/...`, `packages/db/src/seed/m.ts`, `packages/core/src/m/...`, `packages/email/src/templates/m/.gitkeep` and `packages/core/src/i18n/messages/{nl-BE,fr-BE,en}/m.json` are expanded to the eleven module ids `crm, booking, commerce, credits, finance, forms, email, automation, ops, site, webinar` in `ownership.json` (the JSON keeps the short form). |
| A4 | commerce-P4a: add `apps/web/app/api/dev/fake-pay/[id]/route.ts` and `apps/web/app/api/dev/fake-pay/[id]/route.test.ts` to `owns`, and the goal sentence "runtime fake hosted pay page (BS-9)". |
| A5 | webinar-P4: add to its goal "when `youtube_video_id` starts with `fake_`, `webinar-player.tsx` renders the simulated player of the YouTube fake (a 1-second timer that emits the same play, pause, seek and ended events), so watch-time e2e runs without youtube.com". No owns change. |
| A6 | Every wave's `gate` list: the gate is run by `scripts/build/gate.sh <wave>` (BS-13); the list stays as documentation. |
| A7 | platform-P2: `packages/db/package.json` script names it relies on (`views`, `append-only`, `seed`, `test:migrations`, `docs-schema`) are created by W0-0; P2 writes the scripts they call. |
| A8 | `CONVENTIONS.md` (root) is written by W0-0 (section 3.2); `CLAUDE.md` and `docs/plan/conventions.md` stay with platform-P1, and `CLAUDE.md` links to both. |
| A9 | Playwright support files get owners: platform-P1 adds `apps/web/e2e/global-setup.ts` (section 3.6) to its `owns`; platform-P6 adds `apps/web/e2e/support/{auth.ts, sink.ts, db.ts, ids.ts}` (sign in a demo staff user with TOTP, sign in a customer through the magic link in the sink, read the newest `rendered_email` file for an address, a `@beam/db` handle over `neon-ws`, unique test emails). Later packages import them and never edit them. |
| A10 | credits-P6: add `apps/web/modules/credits/seed.ts` to `owns` so the credits rows of the demo dataset (section 6.3) have an owner. |

### 1.4 Environment variables per mode

Every name is listed in `.env.example` (written by W0-0). Values live only in `.env.local` (sandbox and local), GitHub Actions secrets (CI) and Vercel environment groups. "gen" means W0-0 generates the value with the command in the last column and writes it to `.env.local`.

| Variable | Sandbox (build, Vitest, e2e) | CI (GitHub Actions) | Vercel preview | Vercel staging and production | Notes and how to generate |
| --- | --- | --- | --- | --- | --- |
| `APP_ENV` | `local` | `local` | `preview` | `staging` / `production` | One of `local, preview, staging, production` (PL-76). |
| `APP_URL` | `http://localhost:3100` for e2e, `http://localhost:3000` for `pnpm dev` | `http://localhost:3100` | the preview URL (`https://$VERCEL_URL`) | `https://staging.beam.be` / `https://www.beam.be` | Absolute links in emails, webhooks, fake pay page. |
| `DATABASE_URL` | beam_dev pooled | beam_dev pooled (secret `BEAM_DEV_DATABASE_URL`) | Neon branch `preview/pr-<n>` pooled (set by `preview-branch.yml`) | Neon branch `staging` / `production` (`neondb`) pooled | Unused by Vitest (PGlite). |
| `DATABASE_URL_UNPOOLED` | beam_dev direct | beam_dev direct | branch direct | branch direct | Migrations only. |
| `DATABASE_DRIVER` | `neon-ws` | `neon-ws` | `pg` | `pg` | TCP 5432 is blocked in the sandbox and assumed blocked in CI. |
| `NODE_USE_ENV_PROXY` | `1` | unset | unset | unset | Node's fetch and WebSocket go through the sandbox proxy. |
| `NODE_EXTRA_CA_CERTS` | `/root/.ccr/ca-bundle.crt` | unset | unset | unset | Proxy CA. |
| `AUTH_SECRET` | gen | secret | env group | env group | `openssl rand -base64 32` |
| `AUTH_TRUST_HOST` | `true` | `true` | unset (Vercel sets it) | unset | Auth.js v5 outside Vercel. |
| `CRON_SECRET` | gen | gen per run | env group | env group | `openssl rand -hex 32`; the tick route checks `Authorization: Bearer`. |
| `SENSITIVE_DATA_KEY_V1` | gen | gen per run | env group | env group (different per environment) | `openssl rand -base64 32` (32 bytes, AES-256-GCM). |
| `VOUCHER_CODE_SECRET` | gen | gen per run | env group | env group | `openssl rand -hex 32` (commerce). |
| `AUTOMATION_WEBHOOK_SECRET` | gen | gen per run | env group | env group | `openssl rand -hex 32` (automation webhook step). |
| `INTEGRATIONS` | `fake` | `fake` | `fake` until the test keys exist | unset (forbidden in production) | Section 1.5. |
| `PAYMENTS_FAKE` | unset (covered by `INTEGRATIONS=fake`) | unset | unset | unset (forbidden in production) | Forces the payments fake alone. |
| `EMAIL_SINK` | `sink@beam.be` | `sink@beam.be` | `sink@beam.be` | staging `sink@beam.be`; production unset (forbidden) | BS-10. |
| `DEMO_STAFF_PASSWORD` | gen | gen per run | env group | staging env group; production unset | `node -e "console.log(require('crypto').randomBytes(18).toString('base64url'))"` (24 characters, passes zxcvbn 3). |
| `DEMO_TOTP_SECRET` | gen | gen per run | env group | staging only | `node -e "const b=require('crypto').randomBytes(20);const a='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';let bits='';for(const x of b)bits+=x.toString(2).padStart(8,'0');let s='';for(let i=0;i<bits.length;i+=5)s+=a[parseInt(bits.slice(i,i+5).padEnd(5,'0'),2)];console.log(s)"` (base32, 32 characters). |
| `MOLLIE_API_KEY`, `MOLLIE_WEBHOOK_SECRET` | unset | unset | unset | staging `test_...`; production `live_...` | Absent means the payments fake. |
| `STRIPE_API_KEY`, `VIVA_CLIENT_ID`, `VIVA_CLIENT_SECRET` | unset | unset | unset | unset | Stub adapters refuse selection without them. |
| `BILLIT_API_KEY`, `BILLIT_BASE_URL`, `BILLIT_PARTY_ID` | unset | unset | unset | staging sandbox values; production live values | `BILLIT_BASE_URL` sandbox `https://api.sandbox.billit.be`, live `https://api.billit.be`. |
| `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET` | unset | unset | unset | env group | Webhook secret is the Svix `whsec_...` value. |
| `ANTHROPIC_API_KEY` | unset | unset | unset | env group | Fake answers scripted per feature. |
| `SLACK_WEBHOOK_URL` | unset | unset | unset | env group | Fake records messages. |
| `SENTRY_DSN`, `SENTRY_AUTH_TOKEN`, `NEXT_PUBLIC_SENTRY_DSN` | unset | `SENTRY_AUTH_TOKEN` only after the project exists | DSN | DSN and auth token | Absent DSN disables the SDK; `beforeSend` scrubbing is unit-tested with a fake transport. |
| `BETTERSTACK_HEARTBEAT_URL`, `BETTERSTACK_API_TOKEN`, `BETTERSTACK_MONITOR_ID` | unset | unset | unset | env group | Absent heartbeat URL skips the ping; absent token uses the SLA fake. |
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REFRESH_TOKEN` | unset | unset | unset | env group (R2) | YouTube and Meet. |
| `META_ADS_TOKEN`, `GOOGLE_ADS_TOKEN`, `META_APP_SECRET`, `META_VERIFY_TOKEN` | unset | unset | unset | env group (R3) | Ads pulls and the Meta inbox webhook. |
| `BACKUP_AGE_PUBLIC_KEY` | unset | secret (after go-live) | unset | unset | Only `backup.yml` uses it. |
| `E2E_BASE_URL` | `http://localhost:3100` | `http://localhost:3100` | the preview URL (for `e2e.yml` on previews) | unset | Playwright `baseURL`. |
| `PLAYWRIGHT_BROWSERS_PATH` | `/opt/pw-browsers` (already set) | default | n/a | n/a | BS-14. |
| `LOCAL_TICK_MS` | `5000` (`pnpm dev`); Playwright's `webServer` sets `1000` | `1000` | unset | unset (refused outside `local`) | DR-13: in-process tick under `next dev` and `next start`. |
| `PRODUCTION_DATABASE_URL`, `PRODUCTION_DATABASE_URL_UNPOOLED` | present, never read | absent | absent | absent | Go-live only, by a human (section 7.2, row 2). |

CI generates the "gen per run" values in the job itself (`echo "AUTH_SECRET=$(openssl rand -base64 32)" >> $GITHUB_ENV`), so no long-lived test secret exists. The only CI secrets are `BEAM_DEV_DATABASE_URL`, `BEAM_DEV_DATABASE_URL_UNPOOLED` and, later, `NEON_API_KEY`, `VERCEL_TOKEN`, `SENTRY_AUTH_TOKEN` and `BACKUP_AGE_PUBLIC_KEY`.

W0-0 appends the generated values to `.env.local` with this block (it never prints them):

```bash
cd /home/user/beam
{
  echo "APP_ENV=local"
  echo "APP_URL=http://localhost:3000"
  echo "E2E_BASE_URL=http://localhost:3100"
  echo "NODE_USE_ENV_PROXY=1"
  echo "NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt"
  echo "AUTH_SECRET=$(openssl rand -base64 32)"
  echo "AUTH_TRUST_HOST=true"
  echo "CRON_SECRET=$(openssl rand -hex 32)"
  echo "SENSITIVE_DATA_KEY_V1=$(openssl rand -base64 32)"
  echo "VOUCHER_CODE_SECRET=$(openssl rand -hex 32)"
  echo "AUTOMATION_WEBHOOK_SECRET=$(openssl rand -hex 32)"
  echo "INTEGRATIONS=fake"
  echo "EMAIL_SINK=sink@beam.be"
  echo "LOCAL_TICK_MS=5000"
  echo "DEMO_STAFF_PASSWORD=$(node -e "console.log(require('crypto').randomBytes(18).toString('base64url'))")"
  echo "DEMO_TOTP_SECRET=$(node -e "const b=require('crypto').randomBytes(20);const a='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';let bits='';for(const x of b)bits+=x.toString(2).padStart(8,'0');let s='';for(let i=0;i<bits.length;i+=5)s+=a[parseInt(bits.slice(i,i+5).padEnd(5,'0'),2)];console.log(s)")"
} >> .env.local
chmod 600 .env.local
```

A git worktree does not contain gitignored files, so the agent prompt (section 4) makes every coding agent run `cp /home/user/beam/.env.local ./.env.local` first. Agents never need Neon (Vitest is PGlite), so the copy only feeds `AUTH_SECRET`, `SENSITIVE_DATA_KEY_V1` and the fake switches.

### 1.5 Fake-provider mode

**One selector.** `getIntegrations()` in `apps/web/lib/integrations.ts` (platform-P5) builds the six shared clients (`payments`, `resend`, `billit`, `anthropic`, `slack`, `betterstack`) with this rule, evaluated per provider at first use and cached per process. The same file exports `integrationMode(provider: string, keyEnv: string): 'real' | 'fake'`, which applies the identical rule; the owners of the per-call clients (webinar's `youtube`, ops' `ads`, crm's `meta-messaging`, site's `wordpress`, automation's `webhook`) call it in their jobs, so the whole platform switches with one rule (platform spec section 6):

1. `APP_ENV=production`: always the real client. A missing key makes the provider's status `not_configured`, `/api/health` returns 503 through its `config` check, and a job that needs the client fails with `PermanentError('not_configured')`. `INTEGRATIONS=fake`, `PAYMENTS_FAKE=1` or `EMAIL_SINK` in production also make `/api/health` return 503 (PL-74).
2. `APP_ENV=staging`: the real client; staging is only created when the test keys exist (week 3).
3. Otherwise (`local`, `preview`, Vitest): `INTEGRATIONS=fake` gives every fake. `PAYMENTS_FAKE=1` gives the payments fake. Else a provider is real exactly when its key is present, and fake when it is absent.

| Provider | Key that switches it to real | Fake (`packages/integrations/src/<p>/fake.ts`) behaviour outside tests |
| --- | --- | --- |
| payments (Mollie; Stripe and Viva stubs) | `MOLLIE_API_KEY` | In-memory store on `globalThis.__beamFakePayments`. `createPayment` returns `checkoutUrl = ${APP_URL}/api/dev/fake-pay/<id>`. That page (BS-9) shows the amount and three buttons, `Pay`, `Fail`, `Cancel` (`data-testid="fake-pay-<outcome>"`); a click sets the fake status, POSTs `id=<id>` to `/api/webhooks/mollie` exactly as Mollie does, then redirects to the payment's `redirectUrl`. Terminal payments use the same page with `?kind=terminal`. Mandates are `valid` at once; recurring payments settle `paid` unless `failNext()` was called. A server restart loses open fake payments; `payments.scan_expired` then expires them. |
| resend | `RESEND_API_KEY` | `sendEmail` and `sendBatch` return `fake_<uuid>` ids and record the message in memory. `EMAIL_SINK` is applied before the client: the rendered HTML is stored as a `rendered_email` file, which is what e2e specs read. Events (`delivered`, `bounced`, `complained`) are produced by POSTing a signed fake event to `/api/webhooks/resend`; the fake's `signEvent()` uses a fixed fake secret that `verifyWebhook` accepts only when the fake is active. |
| billit | `BILLIT_API_KEY` | Accepts customers, invoices and credit notes, returns `billit_<n>` ids, marks bank-transfer invoices paid when `fake.markPaid(number)` is called, simulates Peppol status `sent`. |
| anthropic | `ANTHROPIC_API_KEY` | Scripted answers per `AI_FEATURES` key (a page proposal, an email draft, a reply draft, a summary, a classification, an SQL query over the `ai` schema), real-looking token counts, `ai_requests` rows written as for the real client. Refusal and 529 are injectable in tests only. |
| slack | `SLACK_WEBHOOK_URL` | Records messages; `/admin/system` shows the last 50. |
| betterstack | `BETTERSTACK_API_TOKEN` | Heartbeat skipped; SLA returns 99.95 % and 0 incidents. |
| youtube (R2) | `GOOGLE_OAUTH_REFRESH_TOKEN` | Broadcast ids `fake_<uuid>`, state machine `created -> ready -> live -> complete`, recording id on `complete`; the player renders the simulated player (A5). |
| meta and google ads (R3) | `META_ADS_TOKEN`, `GOOGLE_ADS_TOKEN` | Deterministic daily rows for three fake campaigns per platform, seeded by date, so dashboards have data. |
| meta inbox (R3) | `META_APP_SECRET` | Inbound messages injected by a signed POST to the Meta webhook route; outbound replies recorded. |
| webhook poster (automation) | none (always real outside tests) | Tests use the fake; in the sandbox the demo automations contain no webhook step. |
| sentry | `SENTRY_DSN` | No fake: absent DSN disables the SDK. |

**How a test selects fakes.** Vitest never reads `INTEGRATIONS`: tests pass fakes explicitly through `makeCtx(db, { integrations: createFakeIntegrations() })` from `apps/web/lib/testing.ts`, so a test can never call a real provider even on a machine with keys. The whole platform runs end to end in fake mode: the demo seed, every Playwright spec, and the acceptance suites.

## 2. Dependency manifest for the whole platform

W0-0 installs everything in this section, so no later package touches a `package.json` or the lockfile. A package that still needs something writes `docs/build/dependency-requests/<id>.md` (BS-7) and the orchestrator handles it between waves (section 5.5).

### 2.1 How the versions were verified

1. `npm view <pkg> version` and `npm view <pkg> time --json` for every package on 2026-11-03 (the "Published" column is the date of the pinned version).
2. `npm view <pkg>@<version> peerDependencies` and `peerDependenciesMeta` for every pinned version, checked against Next.js 16.4.4, React 19.3.1, TypeScript 5.9.3, Node 22 and Vitest 5.1.0.
3. The whole set below was resolved at once in a scratch project with `pnpm install --lockfile-only` (pnpm 10.28.0): 1,266 packages, one peer warning (`htmlnano` wants `cssnano@^8`, gets 7.1.9; accepted by BS-21), one duplicate (`zod` 4.6.5 inside `@serwist/build`; overridden by BS-21), and one deprecation that changed the plan (`@react-email/components`, replaced by `react-email`, BS-5).

`vitest@5.1.0` and `@vitejs/plugin-react@6.2.1` take `vite` as a peer only, so `vite@8.3.5` is pinned in the catalog and listed next to every `vitest` devDependency (DR-9). Peer results that matter: `next-auth@5.0.0-beta.32` peers `next ^14 || ^15 || ^16`, `react ^18.2 || ^19` (its `nodemailer` and `@simplewebauthn/*` peers are optional and not installed). `next-intl@4.14.9` peers `next ^16`, `react ^19`. `@sentry/nextjs@11.10.0` peers `next ^16.0.0-0`. `@serwist/next@9.5.13` peers `next >=14`, `typescript >=5` (its `@serwist/cli` peer is optional). `typescript-eslint@8.72.1` peers `eslint ^10`, `typescript >=4.8.4 <6.1.0` (5.9.3 fits). `vitest@5.1.0` peers `@types/node ^22`, `vite ^8` (8.3.5 comes with it), `jsdom *`; `@vitest/coverage-v8@5.1.0` peers exactly `vitest 5.1.0`. `@vitejs/plugin-react@6.2.1` peers `vite ^8`. `@tiptap/react@3.32.2` peers `@tiptap/core` and `@tiptap/pm` at exactly 3.32.2 (both installed). `recharts@3.10.1` peers `react-is` (installed at 19.3.1). `@testing-library/react@16.3.3` peers `@testing-library/dom ^10` (installed 10.4.2). `@anthropic-ai/sdk@1.4.0` and `@hookform/resolvers@6.0.2` peer `zod ^4`. `@axe-core/playwright@4.14.0` peers `playwright-core >=1` (from `@playwright/test`). `next@16.4.4` lists `@playwright/test ^1.51.1` as an optional peer (1.64.1 fits). `resend@6.37.0` peers `@react-email/render *`. `@react-pdf/renderer@4.9.0`, `react-email@6.11.6`, `radix-ui@1.8.1`, `cmdk@1.1.1`, `sonner@2.0.8`, `lucide-react@1.67.0`, `react-hook-form@7.91.0`, `@tanstack/react-table@9.3.1` all peer `react ^19`.

### 2.2 The catalog (single source of every version)

`pnpm-workspace.yaml` after W0-0:

```yaml
packages:
  - "apps/*"
  - "packages/*"
onlyBuiltDependencies:
  - esbuild
  - "@node-rs/argon2"
catalog:
  # framework
  next: 16.4.4
  react: 19.3.1
  react-dom: 19.3.1
  typescript: 5.9.3
  "@types/node": 22.20.5
  "@types/react": 19.3.0
  "@types/react-dom": 19.3.0
  server-only: 0.0.1
  # database
  drizzle-orm: 0.45.4
  drizzle-kit: 0.31.11
  pg: 8.23.1
  "@types/pg": 8.23.1
  "@neondatabase/serverless": 1.2.0
  "@electric-sql/pglite": 0.5.15
  "@vercel/functions": 3.10.6
  dotenv: 18.0.9
  # auth and security
  next-auth: 5.0.0-beta.32
  "@auth/drizzle-adapter": 1.11.3
  "@node-rs/argon2": 2.2.2
  otpauth: 9.6.0
  qrcode: 1.5.4
  "@types/qrcode": 1.5.6
  "@zxcvbn-ts/core": 4.2.0
  "@zxcvbn-ts/language-common": 4.1.3
  "@zxcvbn-ts/language-en": 4.1.1
  "@zxcvbn-ts/language-nl-be": 4.1.1
  "@zxcvbn-ts/language-fr": 4.1.2
  # i18n, validation, dates
  next-intl: 4.14.9
  intl-messageformat: 12.1.4
  zod: 4.6.7
  date-fns: 4.4.0
  "@date-fns/tz": 1.5.0
  # observability
  "@sentry/nextjs": 11.10.0
  pino: 10.4.0
  pino-pretty: 13.2.0
  # PWA
  serwist: 9.5.13
  "@serwist/next": 9.5.13
  # files, CSV, ZIP, PDF, XML, HTML
  csv-parse: 7.0.3
  fflate: 0.8.3
  "@react-pdf/renderer": 4.9.0
  fast-xml-parser: 5.12.0
  node-html-parser: 9.0.6
  # email
  react-email: 6.11.6
  "@react-email/render": 2.2.0
  mjml: 5.4.1
  "@types/mjml": 5.4.2
  resend: 6.37.0
  svix: 2.9.1
  # providers
  "@mollie/api-client": 4.6.0
  "@anthropic-ai/sdk": 1.4.0
  google-auth-library: 11.3.3
  # UI
  tailwindcss: 4.3.4
  "@tailwindcss/postcss": 4.3.4
  postcss: 8.5.32
  tw-animate-css: 1.4.0
  class-variance-authority: 0.7.1
  clsx: 2.1.1
  tailwind-merge: 3.7.0
  lucide-react: 1.67.0
  radix-ui: 1.8.1
  "@tanstack/react-table": 9.3.1
  react-hook-form: 7.91.0
  "@hookform/resolvers": 6.0.2
  sonner: 2.0.8
  cmdk: 1.1.1
  recharts: 3.10.1
  react-is: 19.3.1
  "@tiptap/core": 3.32.2
  "@tiptap/pm": 3.32.2
  "@tiptap/react": 3.32.2
  "@tiptap/starter-kit": 3.32.2
  "@tiptap/extension-link": 3.32.2
  # tests
  vitest: 5.1.0
  vite: 8.3.5
  "@vitest/coverage-v8": 5.1.0
  "@vitejs/plugin-react": 6.2.1
  jsdom: 30.1.3
  "@testing-library/react": 16.3.3
  "@testing-library/dom": 10.4.2
  "@testing-library/user-event": 14.6.8
  "@testing-library/jest-dom": 7.0.1
  "@playwright/test": 1.64.1
  "@axe-core/playwright": 4.14.0
  autocannon: 8.0.0
  "@types/autocannon": 7.12.7
  # tooling
  turbo: 2.11.10
  tsx: 4.23.15
  esbuild: 0.28.2
  eslint: 10.14.0
  "@eslint/js": 10.0.1
  typescript-eslint: 8.72.1
  "@next/eslint-plugin-next": 16.4.4
  eslint-plugin-react-hooks: 7.1.1
  eslint-config-prettier: 10.1.8
  globals: 17.14.0
  prettier: 3.9.10
  prettier-plugin-tailwindcss: 0.8.1
  "@neon/config": 1.10.0
  "@neon/env": 1.6.8
overrides:
  zod: 4.6.7
peerDependencyRules:
  allowedVersions:
    "htmlnano>cssnano": "7"
```

`.npmrc`: `save-exact=true`, `auto-install-peers=true`, `strict-peer-dependencies=false`, `link-workspace-packages=true`.

### 2.3 Where each dependency lives

Every entry is written as `"<name>": "catalog:"`; workspace packages as `"workspace:*"`.

| Workspace package | dependencies | devDependencies | Used for |
| --- | --- | --- | --- |
| root `beam-platform` | `@neon/config`, `@neon/env` | `turbo`, `typescript`, `tsx`, `@types/node`, `eslint`, `prettier`, `@beam/config` (workspace) | `neon.ts`, Turborepo, root scripts, root `eslint.config.js` (re-exports `@beam/config/eslint`) |
| `@beam/config` (`packages/config`) | `@eslint/js`, `typescript-eslint`, `@next/eslint-plugin-next`, `eslint-plugin-react-hooks`, `eslint-config-prettier`, `globals`, `prettier-plugin-tailwindcss` | `eslint`, `prettier`, `typescript`, `vitest`, `vite` | shared eslint, tsconfig, prettier, Tailwind theme, Vitest presets |
| `@beam/core` (`packages/core`) | `zod`, `date-fns`, `@date-fns/tz`, `intl-messageformat` | `typescript`, `@types/node`, `vitest`, `vite`, `@vitest/coverage-v8`, `tsx`, `@beam/config`, `@beam/db` (type-only imports) | pure domain logic, i18n, AI context, privacy types |
| `@beam/db` (`packages/db`) | existing five (`drizzle-orm`, `pg`, `@neondatabase/serverless`, `@electric-sql/pglite`, `@vercel/functions`), plus `zod`, `@beam/core` | existing (`@types/node`, `@types/pg`, `dotenv`, `drizzle-kit`, `tsx`, `typescript`, `vitest`), plus `vite`, `@vitest/coverage-v8`, `@beam/config` | schema, migrations, enqueue, seeds, test harness |
| `@beam/email` (`packages/email`) | `react`, `react-dom`, `react-email`, `@react-email/render`, `mjml`, `zod`, `@beam/core` | `@types/react`, `@types/react-dom`, `@types/mjml`, `typescript`, `vitest`, `vite`, `@vitest/coverage-v8`, `@beam/config` | templates, block document to MJML to HTML, `renderEmail()`; `pnpm --filter @beam/email preview` runs `email dev --dir src/templates` (react-email CLI) |
| `@beam/integrations` (`packages/integrations`) | `@mollie/api-client`, `@anthropic-ai/sdk`, `resend`, `svix`, `google-auth-library`, `zod`, `@beam/core` | `@types/node`, `typescript`, `vitest`, `vite`, `@vitest/coverage-v8`, `@beam/config` | provider clients and fakes; Billit, Slack, Better Stack, YouTube, ads, Meta and the webhook poster use `fetch` |
| `@beam/ui` (`packages/ui`) | `radix-ui`, `class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react`, `@tanstack/react-table`, `react-hook-form`, `@hookform/resolvers`, `sonner`, `cmdk`, `recharts`, `react-is`, `tw-animate-css`; peers `react`, `react-dom` | `react`, `react-dom`, `@types/react`, `@types/react-dom`, `tailwindcss`, `typescript`, `vitest`, `vite`, `@vitest/coverage-v8`, `@vitejs/plugin-react`, `jsdom`, `@testing-library/react`, `@testing-library/dom`, `@testing-library/user-event`, `@testing-library/jest-dom`, `@beam/config` | shadcn set, DataTable, LocalizedInput, shells, charts |
| `@beam/web` (`apps/web`) | `next`, `react`, `react-dom`, `server-only`, `dotenv`, `next-auth`, `@auth/drizzle-adapter`, `next-intl`, `zod`, `@node-rs/argon2`, `otpauth`, `qrcode`, `@zxcvbn-ts/core`, `@zxcvbn-ts/language-common`, `@zxcvbn-ts/language-en`, `@zxcvbn-ts/language-nl-be`, `@zxcvbn-ts/language-fr`, `@sentry/nextjs`, `pino`, `serwist`, `@serwist/next`, `date-fns`, `@date-fns/tz`, `csv-parse`, `fflate`, `@react-pdf/renderer`, `fast-xml-parser`, `node-html-parser`, `@tiptap/core`, `@tiptap/pm`, `@tiptap/react`, `@tiptap/starter-kit`, `@tiptap/extension-link`, `mjml` (DR-17), `@beam/db`, `@beam/core`, `@beam/email`, `@beam/integrations`, `@beam/ui` | `@types/node`, `@types/react`, `@types/react-dom`, `@types/qrcode`, `typescript`, `tailwindcss`, `@tailwindcss/postcss`, `postcss`, `vitest`, `vite`, `@vitest/coverage-v8`, `@vitejs/plugin-react`, `jsdom`, `@testing-library/react`, `@testing-library/dom`, `@testing-library/user-event`, `@testing-library/jest-dom`, `@playwright/test`, `@axe-core/playwright`, `autocannon`, `@types/autocannon`, `pino-pretty`, `tsx`, `esbuild`, `@beam/config` | the app, scripts, e2e and load tests |

Deliberately not installed (the specs decided in-house code or another tool): a graph library for the R4 builder (automation decision 36), a phone library (crm decision 38), a ZIP writer (ops uses `fflate` for reading and its own store-only writer; `fflate` stays for unzipping WXR and import uploads), `@vercel/analytics` (site uses `next/script`), `stripe` and Viva SDKs (stub adapters), `@radix-ui/react-*` single packages (`radix-ui` bundles them), `eslint-plugin-boundaries` (the import rules of architecture section 1 are `no-restricted-imports`), `actionlint` and `gitleaks` (GitHub Actions run them as actions, not npm packages).

### 2.4 Root scripts (root `package.json`, written by W0-0)

| Script | Command | Used by |
| --- | --- | --- |
| `gen:indexes` | `tsx apps/web/scripts/gen-indexes.ts` | everyone; Turborepo `gen` task |
| `build` | `turbo run build` | gate |
| `dev` | `turbo run dev --filter @beam/web` | local |
| `typecheck` | `turbo run typecheck --concurrency=2` | gate, agents (DR-6) |
| `lint` | `turbo run lint --concurrency=2` | gate, agents |
| `test` | `turbo run test --concurrency=2` | gate, agents |
| `test:e2e` | `pnpm --filter @beam/web exec playwright test` | orchestrator only |
| `test:load` | `pnpm --filter @beam/web exec tsx scripts/load-test.ts` | platform-P11b |
| `i18n:check` | `pnpm --filter @beam/core exec tsx scripts/i18n-check.ts` | gate |
| `gdpr:coverage` | `pnpm --filter @beam/web exec vitest run test/gdpr-coverage.test.ts` | gate from wave 3 |
| `db:generate` | `pnpm --filter @beam/db generate` (passes `--name`) | orchestrator |
| `db:views` | `pnpm --filter @beam/db views` | orchestrator, gate (`--check`) |
| `db:append-only` | `pnpm --filter @beam/db append-only` | orchestrator, CI (`--check`) |
| `db:migrate` | `pnpm --filter @beam/db migrate` | orchestrator, deploy |
| `db:check` | `pnpm --filter @beam/db check` | pre-flight |
| `db:check-migrations` | `pnpm --filter @beam/db check-migrations` | gate |
| `db:seed` | `pnpm --filter @beam/web exec tsx scripts/seed-demo.ts` (BS-11; flag `--profile defaults` or `--profile demo`) | orchestrator, deploy |
| `seed:demo` | `pnpm db:seed --profile demo` | checkpoints |
| `docs:schema` | `pnpm --filter @beam/db docs-schema` | CI on `main` |
| `admin:reset-mfa` | `pnpm --filter @beam/web exec tsx scripts/admin-reset-mfa.ts` | runbook |
| `exit:export` | `pnpm --filter @beam/web exec tsx scripts/exit-export.ts` | platform-P11b |
| `format` | `prettier --write .` | humans |

`packages/db/package.json` scripts (W0-0 adds to the existing ones and changes `generate`): `"generate": "pnpm -w gen:indexes && drizzle-kit generate"`, `"views": "tsx scripts/views-sql.ts"`, `"append-only": "tsx scripts/append-only-sql.ts"`, `"docs-schema": "tsx scripts/docs-schema.ts"`, `"test:migrations": "vitest run test/test-db.test.ts"` (the existing test that builds a database from the committed migrations), `"lint": "eslint ."`. Every workspace package gets `"typecheck": "tsc --noEmit"`, `"lint": "eslint ."`, `"test": "vitest run"`. `apps/web` gets `"build": "next build --webpack"`, `"dev": "next dev -p 3000"`, `"start": "next start"` and `"typecheck": "next typegen && tsc --noEmit"` (DR-7).

## 3. Wave 0 in full detail (W0-0 and waves 0 to 3)

Order (platform spec section 12): **W0-0** (orchestrator) → wave 0 **platform-P1** → wave 1 **platform-P2, P3, P4** in parallel → wave 2 **platform-P5** → wave 3 **platform-P6, P7** in parallel → wave 3 checkpoint. Nothing else starts before the wave 3 checkpoint is green. Each package's complete file list is its `owns` list in `build-packages.json` and its section in `docs/plan/modules/platform.md`; this section adds the details a coding agent needs and the spec does not spell out.

### 3.1 W0-0, the orchestrator step (about 30 minutes)

The orchestrator runs these commands itself in `/home/user/beam` on the integration branch.

**Step 1: folders and package manifests.**

```bash
cd /home/user/beam
mkdir -p packages/{config,core,email,integrations,ui} scripts/build docs/build/dependency-requests docs/runbooks docs/handbook
```

It writes these `package.json` files (all `"private": true`, `"version": "0.0.0"`, `"type": "module"`, scripts `typecheck`, `lint`, `test` as in section 2.4, dependencies as in section 2.3 with `catalog:`):

| File | `name` | `exports` |
| --- | --- | --- |
| `packages/config/package.json` | `@beam/config` | `".": "./src/index.ts"`, `"./eslint": "./eslint.config.js"`, `"./prettier": "./prettier.config.js"`, `"./tsconfig.base.json"`, `"./tsconfig.next.json"`, `"./tsconfig.lib.json"`, `"./tailwind-theme.css"` (each mapping to the file of the same name) |
| `packages/core/package.json` | `@beam/core` | `".": "./src/index.ts"`, `"./errors": "./src/errors.ts"`, `"./i18n": "./src/i18n/index.ts"`, `"./i18n/messages/*": "./src/i18n/messages/*"`, `"./*": "./src/*/index.ts"` (modules, `ai`, `privacy`, `platform`) |
| `packages/email/package.json` | `@beam/email` | `".": "./src/index.ts"`, `"./render": "./src/render.ts"`, `"./layout": "./src/layout.tsx"`, `"./templates/define": "./src/templates/define.ts"`, `"./templates/registry": "./src/templates/registry.generated.ts"`, `"./templates/*": "./src/templates/*/index.ts"`, `"./blocks": "./src/blocks/index.ts"` |
| `packages/integrations/package.json` | `@beam/integrations` | `".": "./src/index.ts"`, `"./_shared": "./src/_shared/index.ts"`, `"./_shared/*": "./src/_shared/*.ts"`, `"./*/fake": "./src/*/fake.ts"`, `"./*/client": "./src/*/client.ts"`, `"./*/types": "./src/*/types.ts"`, `"./*": "./src/*/index.ts"` (Node picks the longest matching key, so `anthropic/fake` resolves to `fake.ts` and `billit` to `billit/index.ts`; DR-8) |
| `packages/ui/package.json` | `@beam/ui` | `".": "./src/index.ts"`, `"./tokens.css": "./src/tokens.css"`, `"./components/*": "./src/components/*.tsx"` |

It edits `packages/db/package.json` (dependencies of section 2.3, `catalog:` for every existing entry, the five new scripts of section 2.4, and the export `"./seed": "./src/seed/run.ts"`, DR-8) and `apps/web/package.json` (section 2.3; `build` becomes `next build --webpack`). It rewrites the root `package.json` with the scripts and dependencies of sections 2.3 and 2.4 (overrides and peer rules live in `pnpm-workspace.yaml`, never in a `pnpm` field). It writes `pnpm-workspace.yaml` (section 2.2) and `.npmrc` (section 2.2). The root `tsconfig.base.json` stays as it is in W0-0; in the wave 0 merge step, after platform-P1's `packages/config/tsconfig.base.json` exists, the orchestrator replaces it with `{ "extends": "./packages/config/tsconfig.base.json" }` in the same commit as the migration step.

**Step 2: install and browsers.**

```bash
pnpm install                                   # writes pnpm-lock.yaml; about 1,300 packages
pnpm install --frozen-lockfile --offline       # proves the store is complete for worktrees
pnpm --filter @beam/web exec playwright install chromium
pnpm --filter @beam/web exec playwright --version   # 1.64.1
```

If `playwright install chromium` fails, the orchestrator sets `"@playwright/test": 1.56.1` in the catalog, runs `pnpm install`, and checks that `/opt/pw-browsers/chromium-1194` is used (BS-14).

**Step 3: root files.**

- `.gitignore`: add `apps/web/registry/*.generated.ts`, `packages/db/src/schema/index.ts`, `packages/core/src/i18n/messages/index.generated.ts`, `packages/email/src/templates/registry.generated.ts`, `apps/web/test-results/`, `apps/web/playwright-report/`, `apps/web/e2e/.auth/`, `coverage/`, `.worktrees/`.
- `git rm --cached packages/db/src/schema/index.ts` (it becomes generated; the file stays on disk until `pnpm gen:indexes` overwrites it).
- `.env.example`: every variable of section 1.4 with an empty or placeholder value and a one-line comment, grouped by mode.
- `.gitleaks.toml`: `[extend] useDefault = true` and an allow-list for `.env.example` and `docs/**`.
- `.github/CODEOWNERS`: `* @jakesparrew`; per-module lines for `apps/web/modules/<m>/`, `packages/db/src/schema/<m>*.ts`, `packages/core/src/<m>/` pointing at the same owner (the file exists so the CI ownership step has a target; real reviewers are added when the repository moves to BEAM's organisation).
- `CONVENTIONS.md` (section 3.2).
- `docs/build/README.md`: what the folder holds (`ownership.json`, `dependency-requests/`, `wave-log.md`, `seam-issues-v1.md`, `seam-issues-r2.md`, `split-log.md`).
- `scripts/build/ownership.mjs`, `scripts/build/gate.sh`, `scripts/build/merge-wave.sh`, `scripts/build/agent-prompt.md` (sections 4 and 5), then `node scripts/build/ownership.mjs` to write `docs/build/ownership.json`.

**Step 4: append the generated secrets to `.env.local`** (section 1.4).

**Step 5: verify and commit.**

```bash
pnpm --filter @beam/db test && pnpm --filter @beam/web typecheck
git add -A && git commit -m "build: W0-0 workspace packages, dependencies, root files"
git push origin claude/focused-hopper-gpky3y
```

Packages without a `tsconfig.json` yet (config, core, email, integrations, ui) are excluded from this verification; platform-P1 adds their tsconfig and `src/index.ts`.

### 3.2 `CONVENTIONS.md` (root, W0-0) and `docs/plan/conventions.md` (platform-P1)

`CONVENTIONS.md` is the one-page rule card every coding agent reads first. Content outline, in this order, each item one to three lines:

1. **Where things go.** The twelve module ids. A module's files: `packages/db/src/schema/<m>.ts` and `<m>.views.ts`, `packages/db/src/seed/<m>.ts`, `packages/core/src/<m>/`, `apps/web/modules/<m>/{actions,queries,api,jobs,schedules,events,permissions,nav,privacy,config,seed,merge-fields}.ts` and `ui/`, `packages/email/src/templates/<m>/`, `packages/core/src/i18n/messages/<locale>/<m>.json`, route folders listed in the module spec.
2. **Ownership.** Edit only files in your package's `owns` list. The list is checked by `apps/web/scripts/check-ownership.ts`.
3. **Never edit** `package.json` files, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `packages/db/migrations/**`, `*.generated.ts`, `packages/db/src/schema/index.ts`, the frozen files (architecture section 11: `apps/web/lib/*`, `apps/web/proxy.ts`, `packages/db/src/schema/{_shared,platform}.ts`, existing contract-table columns, `packages/config/*`, root configs, `CODEOWNERS`).
4. **Cross-module calls** only through `apps/web/modules/<m>/api.ts` and `@beam/core/<m>`, caller's transaction first (`tx, ctx, input`). Need something another module lacks: write it in your commit message under `Requests:`.
5. **Mutations** are `action()` in `actions.ts`; **side effects** are jobs (`defineJob`) enqueued in the same transaction; a request never calls a provider.
6. **Facts are append-only.** Never update or delete rows of an APPEND table; balances and statuses are views.
7. **Naming.** Tables snake_case plural; enums `<table>_<column>`; views `v_<name>`; event kinds `<entity>.<past_tense_or_fact>`; job kinds `<module_or_entity>.<verb_noun>`; permissions `<module>.<action>`; i18n keys `<m>.<screen>.<element>`; flags `ff_<m>_<name>`; settings keys snake_case in `config.ts`; idempotency keys `<noun>:<id>[:<qualifier>]`; templates `<m>.<name>` (transactional) and kebab-case (marketing); files kebab-case, components PascalCase.
8. **Money, time, language.** Integer cents EUR, VAT per line; UTC in the database, `Europe/Brussels` in logic; `nl-BE`, `fr-BE`, `en` everywhere, no fallback language.
9. **Sensitive data** only through `readSensitive()`; never in logs, AI context, segments or exports.
10. **Tests.** Vitest beside the code; integration tests with `createTestDb()` and the factories; provider fakes only; every job runs twice in `jobs.test.ts`; `privacy.test.ts` and `permissions.test.ts` per module. Playwright specs are written and listed (`playwright test --list`), never run by a coding agent.
11. **Before you commit.** The command list of section 4 of `docs/plan/04-build-session.md`.
12. **Commit.** Branch `build/<package-id>`, message `<module>: <summary>` with the trailers of section 4.

`docs/plan/conventions.md` is the long reference with examples, written by platform-P1 from architecture section 11 "Naming conventions": one section per item 7 with three correct and two wrong examples each; the idempotency-key grammar with the full key list (architecture section 3, DM-5); the template-key rule with the collector's failure cases; settings and flag declaration examples (`config.ts`); the file set of a module with a skeleton of each file; the forward-call stub rule (build order rule 1) with the `NotImplementedError` pattern; the frozen-file list; "how to add a table" (schema file, views, `privacy.ts` registration, factory, `gdpr-coverage`); "how to add a job, a schedule, an event, a permission, a nav item, a template, a catalogue key"; the accepted edge of PL edge case 6 (pruned keys). `CLAUDE.md` (platform-P1) is short: what BEAM is, the commands, and links to `CONVENTIONS.md`, `docs/plan/conventions.md`, `00-decisions.md`, `01-architecture.md`, `02-data-model.md` and this file.

### 3.3 Wave 0: platform-P1 (tooling, generator, repository rules)

**Files** are the 45 entries of its `owns` list (minus `docs/build/ownership.json`, A1). The points below are binding details.

**`turbo.json`.** `"envMode": "loose"` (DR-5). A root task `//#gen:indexes` (it runs the root script `gen:indexes`) with `"cache": false`. `build`, `typecheck`, `lint`, `test` and `dev` depend on `//#gen:indexes`; `typecheck` also on `^typecheck`. `db:generate` is run through `pnpm` (not Turborepo) and calls `pnpm gen:indexes` first in its own script chain (`"generate": "pnpm -w gen:indexes && drizzle-kit generate"`). `globalEnv` adds `APP_ENV`, `INTEGRATIONS`, `PAYMENTS_FAKE`, `EMAIL_SINK`. `test` outputs `coverage/**`.

**The generator `apps/web/scripts/gen-indexes.ts`** (run with `tsx`, about 2 seconds).

- Input discovery: the module ids are the directory names under `apps/web/modules/` (any subset may exist). For each module it looks for the files below; a missing file is skipped, never an error.
- Reading: it uses the TypeScript compiler API (`typescript` is installed) to read each file statically. It never imports module code, so it needs no environment and cannot run side effects. It extracts the string literal of each `kind`, `key`, `name` or `permission` property inside the exported array or object. A non-literal value is an error ("registry values must be string literals") with file and line. So every registration of a module sits in its top-level facade file (`modules/<m>/jobs.ts`, `events.ts`, `schedules.ts`, `permissions.ts`, `nav.ts`, `config.ts`, `privacy.ts`, `seed.ts`, `merge-fields.ts`) with its literal key, written by the module's first package (wave 4); only the implementation (`handler`, `run`, `export`, `erase`) may be an identifier imported from a sub-folder file such as `./duplicates/jobs`. A later package that owns only the sub-folder file implements the imported function; a registration missing from the facade is a `Requests:` line, never an edit of the facade.
- Writing: every output starts with `// GENERATED by pnpm gen:indexes. Do not edit.`, imports are sorted by module id, entries by key, line endings `\n`, so two runs give byte-identical files. A file is only rewritten when its content changed (keeps Next.js hot reload quiet).
- Failure: duplicates across modules fail with both file paths and the key; exit code 1, nothing written.
- Empty input: an output with no entries is still written, as `export {};` plus the empty typed constants, so every import resolves from wave 0 (DR-19).

| Output | Built from | Contains |
| --- | --- | --- |
| `apps/web/registry/jobs.generated.ts` | `modules/*/jobs.ts` export `jobs` | `JOBS` (array of every `defineJob` result), `JOB_BY_KIND` (record keyed by kind) |
| `apps/web/registry/webhooks.generated.ts` | `modules/*/jobs.ts` export `webhookHandlers` | `WEBHOOK_HANDLERS` keyed by provider (one handler per provider; a second fails) |
| `apps/web/registry/schedules.generated.ts` | `modules/*/schedules.ts` export `schedules` | `SCHEDULES` (kind, cron, payload, catchUp) |
| `apps/web/registry/events.generated.ts` | `modules/*/events.ts` export `events` | `EVENTS` keyed by event kind with the Zod data schema, `isSensitive`, `subject` |
| `apps/web/registry/permissions.generated.ts` | `modules/*/permissions.ts` export `permissions` | `PERMISSIONS` (sorted string array with the declaring module) |
| `apps/web/registry/nav.generated.ts` | `modules/*/nav.ts` export `nav` | `NAV` for `admin` and `portal`, sections and items with `permission`, `href`, label key, icon, order |
| `apps/web/registry/privacy.generated.ts` | `modules/*/privacy.ts` export `privacy` | `GDPR_REGISTRY` keyed by module (`tables`, `export`, `erase`, `sweep`, `retention`) and `NO_PII_TABLES` (the union of each module's `noPiiTables` export) |
| `apps/web/registry/settings.generated.ts` | `modules/*/config.ts` export `settings` | `SETTINGS` keyed by setting key with owner, Zod schema, default, `isSystem` |
| `apps/web/registry/flags.generated.ts` | `modules/*/config.ts` export `flags` | `FLAGS` keyed by flag key with owner and description |
| `apps/web/registry/seeds.generated.ts` | `modules/*/seed.ts` export `seed` | `DEMO_SEEDS` in dependency order (`{ module, after: ModuleId[], run(ctx) }`, topological, ties by module id) |
| `apps/web/registry/merge-fields.generated.ts` | `modules/*/merge-fields.ts` export `mergeFields` | `MERGE_FIELDS` keyed `<m>.<field>` |
| `apps/web/registry/types.generated.ts` | all of the above | literal unions `JobKind`, `EventKind`, `Permission`, `ScheduleKind`, `SettingKey`, `FlagKey`, `TemplateKey`, `MergeFieldKey`, `ModuleId`, plus `MessageKey = \`${ModuleId}.${string}\`` (the catalogues are too large for a literal union). `apps/web/lib/*` imports these types only, so the type cycle with the modules is harmless. |
| `packages/db/src/schema/index.ts` | `packages/db/src/schema/<m>.ts` and `<m>.views.ts` | `export * from './<file>'` for every file present, `_shared.ts` excluded |
| `packages/db/src/seed/index.generated.ts` | `packages/db/src/seed/<m>.ts` export `seed` | `DEFAULT_SEEDS` in dependency order, read by `seedDefaults(db)` in `run.ts` (decided here so `@beam/db` never imports `apps/web`) |
| `packages/core/src/i18n/messages/index.generated.ts` | `packages/core/src/i18n/messages/<locale>/<m>.json` | `MESSAGES[locale][module]` with static JSON imports, and `MESSAGE_MODULES` |
| `packages/email/src/templates/registry.generated.ts` | `packages/email/src/templates/<m>/index.ts` export `templates` | `TEMPLATE_REGISTRY` keyed `<folder>.<declared name>`; fails on a name whose kebab form differs from its file basename, on a duplicate key, on a slash |

`.gitignore` also lists `packages/db/src/seed/index.generated.ts` (W0-0 adds it with the others).

**`check-ownership.ts`.** `tsx apps/web/scripts/check-ownership.ts --package <id> --base <sha>` lists `git diff --name-only <base>...HEAD`, matches each path against the package's globs in `docs/build/ownership.json` (minimatch-style globs implemented in the script with `path.matchesGlob`, Node 22), and exits 1 listing every foreign path. Generated files, `docs/build/dependency-requests/<id>.md` and the BS-23 test files are always allowed.

**ESLint boundaries** (`packages/config/eslint.config.js`, flat config, re-exported by the root `eslint.config.js`). The module ids are a constant array in the file; overrides are generated from it in code:

| Files | `no-restricted-imports` forbids |
| --- | --- |
| `apps/web/modules/<m>/**` | any path into `modules/<other>/` (relative or `@/modules/<other>/`) except `modules/<other>/api` (regex patterns per module id) |
| `packages/core/**` | `@beam/email`, `@beam/integrations`, `@beam/ui`, `react`, `react-dom`, `next`, `next/*`, `drizzle-orm`, `node:crypto`, `pg`; `@beam/db` with `allowTypeImports: true` |
| `packages/ui/**` | `@beam/db`, `@beam/core`, `@beam/email`, `@beam/integrations`, `next/server`, `server-only` |
| `packages/db/**` | `@beam/email`, `@beam/integrations`, `@beam/ui`, `@beam/web`, `@/*` |
| `packages/email/**` | `@beam/db`, `@beam/integrations`, `@beam/ui` |
| `packages/integrations/**` | `@beam/db`, `@beam/email`, `@beam/ui` |
| everything except `packages/integrations/src/anthropic/**` | `@anthropic-ai/sdk` (PL-51) |
| `packages/config/**` | any `@beam/*` |

Also: `typescript-eslint` recommended-type-checked on `.ts`/`.tsx` with `projectService: { allowDefaultProject: ['*.config.ts', '*.config.js', '*.config.mjs'] }` (DR-18), `@next/eslint-plugin-next` recommended and `eslint-plugin-react-hooks` recommended on `apps/web/**` and `packages/ui/**`, `eslint-config-prettier` last, `no-console` error except `apps/web/scripts/**` and `packages/*/scripts/**`, ignores `**/*.generated.ts`, `packages/db/migrations/**`, `apps/web/scripts/__fixtures__/**`, `**/.next/**`, `**/coverage/**`, `**/playwright-report/**`. `eslint-boundaries.test.ts` lints the two fixtures of the spec with the real config through the ESLint Node API (`new ESLint({ ignore: false })`).

**Other P1 files** (DR-6, DR-9, DR-16 to DR-18). `packages/config/vitest.config.ts` exports a preset `beamVitest({ jsdom?: boolean })` with `maxWorkers: 2`, `pool: 'forks'`, `testTimeout: 30_000`, `hookTimeout: 60_000`; every package's `vitest.config.ts` uses it. `apps/web/vitest.config.ts` adds `@vitejs/plugin-react`, the aliases `@` → `apps/web` and `server-only` → `packages/config/src/server-only-stub.ts`, and includes `**/*.test.{ts,tsx}` except `e2e/**`. `apps/web/tsconfig.json` extends `@beam/config/tsconfig.next.json`, keeps `paths: { "@/*": ["./*"] }`, `jsx: "react-jsx"` (Next 16's value) and excludes `scripts/__fixtures__`. `packages/db/tsconfig.json` extends `@beam/config/tsconfig.lib.json` and includes `src`, `scripts`, `test`, `drizzle.config.ts`, `vitest.config.ts`. `apps/web/next.config.ts`: `transpilePackages` lists all six `@beam/*` packages; `serverExternalPackages: ['pg', '@electric-sql/pglite', 'mjml']`; `typedRoutes: true`; security headers; the Serwist wrapper and the next-intl plugin each applied only when their source file exists; no `withSentryConfig` (DR-15). `apps/web/postcss.config.mjs` as in DR-16.

**CI workflow files** (`.github/workflows/`). Every job: `ubuntu-24.04`, `pnpm/action-setup` with the version from `packageManager`, `actions/setup-node` Node 22 with pnpm cache, `pnpm install --frozen-lockfile`. Jobs that need a secret that does not exist yet are skipped by an `if:` on an env flag set from the secret (`env: HAS_VERCEL: ${{ secrets.VERCEL_TOKEN != '' }}`), so the workflows are green from day one.

| File | Trigger | Steps |
| --- | --- | --- |
| `ci.yml` | pull request, push to the integration branch and `main` | `pnpm gen:indexes`; `pnpm typecheck`; `pnpm lint`; `pnpm i18n:check`; `pnpm test` (Vitest with PGlite, no secrets); `pnpm db:check-migrations`; `pnpm db:views --check`; `pnpm db:append-only --check`; `pnpm --filter @beam/db test:migrations`; `pnpm gdpr:coverage`; ownership check for `build/*` branches; `pnpm audit --audit-level high --prod`; `gitleaks/gitleaks-action@v2`; `rhysd/actionlint` through `docker://rhysd/actionlint:latest`; on `main` only `pnpm docs:schema --check` |
| `e2e.yml` | `workflow_dispatch` and nightly 02:10 UTC on `main` (never on the integration branch, so it never shares `beam_dev` with a running build session) | `DATABASE_DRIVER=neon-ws`, beam_dev secrets, generated runtime secrets, `INTEGRATIONS=fake`, `EMAIL_SINK=sink@beam.be`; `pnpm exec playwright install --with-deps chromium`; `pnpm db:migrate`; `pnpm seed:demo`; `pnpm build`; `pnpm test:e2e`; upload `playwright-report` |
| `preview-branch.yml` | pull request opened, synchronised, closed | `neondatabase/create-branch-action@v6` (branch `preview/pr-<n>` from `production` until week 7, then from `staging`) and `delete-branch-action` on close; writes the URLs to the Vercel preview env with the Vercel CLI; skipped without `NEON_API_KEY` and `VERCEL_TOKEN` |
| `deploy.yml` | push to `main` | refuses a commit not on `origin/staging` unless the PR has label `hotfix` (PL-76a); `pnpm db:migrate` against the target branch; `pnpm db:seed --profile defaults`; `vercel pull`, `vercel build --prod`, `vercel deploy --prebuilt --prod`; skipped without `VERCEL_TOKEN` |
| `backup.yml` | daily 02:30 UTC | `pg_dump --format=custom` of production, `age` encrypt with `BACKUP_AGE_PUBLIC_KEY`, upload to Scaleway; skipped until go-live secrets exist |
| `restore-drill.yml` | first Monday of each quarter 05:00 UTC | restore the latest dump into a fresh Neon branch, run the Vitest suites against it, post to Slack; skipped until go-live |
| `anonymise-staging.yml` | monthly, after go-live | `pnpm db:anonymise` on staging; skipped until go-live |

**Done for P1:** `pnpm gen:indexes` (empty module tree), `pnpm typecheck`, `pnpm lint`, `pnpm --filter @beam/web test -- scripts` green; `actionlint` is not installed locally (it is not an npm package), so the workflows are checked by `actionlint` in the first CI run after wave 0 is pushed; a failure there is fixed by a fixer agent for platform-P1 before wave 1 starts.

### 3.4 Wave 1: platform-P2 (database foundation)

**Schema helpers** (`packages/db/src/schema/_shared.ts`, frozen after wave 3): `id()` = `uuid('id').primaryKey().defaultRandom()` (`gen_random_uuid()`); `createdAt()`, `updatedAt()` (`$onUpdate(() => new Date())`), `timestamps()` = both; `localized(name)` = `jsonb(name).$type<LocalizedText>()`; `money(name)` = `integer(name)`; `vatRate(name)` = `numeric(name, { precision: 4, scale: 2 })` plus the check helper `vatRateCheck(table, column)`; `sensitive(column, { table, keyColumn })` which returns the column and pushes `{ table, column, keyColumn }` into `SENSITIVE_COLUMNS`; `localeEnum = pgEnum('locale', ['nl-BE', 'fr-BE', 'en'])`; `lowerEmailUnique(name, column, where?)` building `uniqueIndex(name).on(sql\`lower(${column})\`)`; `APPEND_ONLY_TABLES` (the 24 names of data model rule 6, in alphabetical order); `IMMUTABLE_TABLES`.

**The append-only migration.** `packages/db/scripts/append-only-sql.ts` writes `packages/db/src/sql/0002_append_only.sql` from `APPEND_ONLY_TABLES`; `--check` exits 1 when the committed file differs. The generated content is exactly this, with the array holding the 24 names:

```sql
-- GENERATED by pnpm db:append-only from APPEND_ONLY_TABLES. Do not edit.
create or replace function reject_update_delete() returns trigger
language plpgsql as $$
begin
  if coalesce(current_setting('beam.allow_rewrite', true), '') = 'on' then
    if tg_level = 'STATEMENT' then return null; end if;
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  raise exception 'append-only table %: % is not allowed', tg_table_name, tg_op
    using errcode = '55000', hint = 'Facts are insert-only. Erasure and retention use SET LOCAL beam.allow_rewrite = ''on''.';
end
$$;

create or replace function beam_protect_append_only() returns integer
language plpgsql as $$
declare
  t text;
  added integer := 0;
begin
  foreach t in array array[
    'activity_events', 'ai_requests', 'audit_log', 'automation_runs', 'automation_versions',
    'consent_records', 'cookie_consents', 'credit_entries', 'email_events', 'imported_history',
    'integration_calls', 'lightspeed_sales', 'membership_periods', 'order_lines',
    'person_declarations', 'person_merges', 'price_versions', 'site_audit_reports',
    'suppressions', 'terms_acceptances', 'watch_segments', 'webhook_events',
    'webinar_interactions', 'webinar_moderation_actions'
  ] loop
    if to_regclass('public.' || t) is not null
       and not exists (select 1 from pg_trigger
                       where tgrelid = ('public.' || t)::regclass and tgname = t || '_append_only') then
      execute format('create trigger %I before update or delete on public.%I for each row execute function reject_update_delete()', t || '_append_only', t);
      execute format('create trigger %I before truncate on public.%I for each statement execute function reject_update_delete()', t || '_append_only_truncate', t);
      added := added + 1;
    end if;
  end loop;
  return added;
end
$$;

select beam_protect_append_only();
```

The orchestrator places it with `pnpm --filter @beam/db exec drizzle-kit generate --custom --name append_only` and copies the file content into the generated empty SQL file (section 5.3). After every later wave that creates an APPEND table it writes a `w<NN>_protect` custom migration that contains only `select beam_protect_append_only();`. `createTestDb()` (default `from: 'schema'`) runs the view SQL and these statements after the schema on every call, so Vitest always sees views and triggers; `createTestDb({ from: 'migrations' })` runs only the committed migrations, which already contain both, and applies nothing twice; `applyCustomSql(handle, { files })` exists only for the extra custom files of R4 (`0100_ai_readonly.sql`, `0101_ai_views_ops.sql`). `drizzle.__drizzle_migrations` bookkeeping is unaffected by the triggers (they are only on the listed tables).

**Views.** `packages/db/scripts/views-sql.ts` (`pnpm db:views`): imports every `*.views.ts`, collects each `<name>Sql` export, finds the views each one reads (`from` and `join` targets that start with `v_` or `ai.`), sorts topologically, and with `--migration <name>` runs `drizzle-kit generate --custom --name <name>` and writes `create or replace view <name> as <sql>;` for every view that is new or whose SQL changed since the last views migration (it reads the previous definitions from the committed migrations). With `--check` it exits 1 when a view's SQL differs from the latest committed definition. A view whose column list shrinks or changes type cannot be `create or replace`d; the script then writes `drop view ... cascade` plus the re-creation of every dependent view, and prints a warning that the orchestrator copies into the wave log.

**Seed framework.** Two profiles (platform decision 37, BS-11):

- `defaults`: `packages/db/src/seed/<m>.ts` exports `seed = { module, after, run: async (db) => {} }`. Rows are inserted with `on conflict do nothing` (or `do update` only for system rows the code owns, such as `roles` with `is_system`), so every run is idempotent. `packages/db/src/seed/run.ts` exports `seedDefaults(db)`, which runs `DEFAULT_SEEDS` (generated) in order inside one transaction per module.
- `demo`: `apps/web/modules/<m>/seed.ts` exports `seed = { module, after, run: async (ctx: SeedCtx) => {} }` where `SeedCtx = { db, ctx: Ctx /* system actor */, now, rand /* seeded PRNG */, ids: DemoIds /* shared lookup of created ids */ }`. Demo seeds may call the module's own logic and other modules' `api.ts`, so a demo order goes through the real paid transaction.
- `apps/web/scripts/seed-demo.ts` (platform-P7): parses `--profile`, refuses `demo` when `APP_ENV=production` or when `persons` has more than 500 rows with `is_tester = false` (edge case 28), runs `seedDefaults(db)` then `DEMO_SEEDS` in order, then `runJobs({ budgetMs: 120_000 })` until no pending fast job is left, so seeded orders, invoices and emails are processed. It prints one line per module with row counts. The demo data is deterministic: `rand` is seeded with `20261103`, all dates are relative to `now` rounded to the Brussels day, and every demo person has `is_tester = true` and an email under `@demo.beam.be` or `@example.com`. A second run finds its rows by natural keys (email, sku, slug, template key) and creates nothing new.

**Test harness** (`packages/db/src/testing.ts` and `packages/db/src/testing/factories.ts`, then `apps/web/lib/testing.ts` from platform-P5):

```ts
import { createTestDb, makePerson, makeUser, makeProduct, makeSession, makeGrant } from '@beam/db/testing';
import { makeCtx, makeJobCtx, runJobTwice, createFakeIntegrations } from '@/lib/testing';

let h: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => { h = await createTestDb(); }); // schema, then views, then append-only triggers
afterAll(() => h.close());

it('consumes one credit', async () => {
  const person = await makePerson(h.db, { locale: 'fr-BE' });
  const grant = await makeGrant(h.db, { personId: person.id, creditKind: 'day', units: 5 });
  const ctx = makeCtx(h.db, { actor: { kind: 'system', jobId: 'test' }, integrations: createFakeIntegrations() });
  // ... call the module function with ctx.tx inside h.db.transaction(...)
});
```

Rules: one `createTestDb()` per test file (about 0.5 s with the full schema); never share a database between files; factories take `(db, overrides?)` and fill every required column with valid defaults (`makePerson` gives a unique `@example.com` email, `nl-BE`, `is_tester = true`); `runJobTwice(db, kind, payload)` runs a job twice through the real runner and returns both snapshots of the touched tables, which `jobs.test.ts` compares; `createFakeIntegrations()` returns fresh fake instances per call. A module's own factories live in files its packages own (for example `packages/db/src/testing/credits-factories.ts`, owned by credits-P1), never in the shared `factories.ts` (BS-23 covers unlisted test files).

### 3.5 Waves 1 to 3: the other foundation packages

| Package (wave) | Key outputs beyond its `owns` list | What later packages rely on |
| --- | --- | --- |
| platform-P3 (1) | `packages/core/src/{i18n,ai,privacy,platform}/index.ts` (the `@beam/core/<x>` entry points), `packages/integrations/src/_shared/index.ts` and one `index.ts` per provider folder it creates (DR-1, DR-8), Billit's `index.ts`, `types.ts`, `fake.ts` and a `client.ts` that throws `NotImplementedError` (platform decision 78); `@beam/core` errors (`RetryableError`, `PermanentError`, `NotImplementedError`, `ForbiddenError`, `MissingTranslationError`), i18n (`t`, `LocalizedText`, `assertComplete`, `format*`), the twelve empty catalogues per locale plus `platform.json`, `i18n-check.ts`, AI context and `AI_FEATURES`, cron and backoff maths, holidays, SLA; `@beam/integrations` `_shared` and every fake of section 1.5 that exists in wave 1 (payments, resend, billit, anthropic, slack, betterstack, youtube, ads); `@beam/email` `define.ts`, `layout.tsx`, `render.ts` and the five platform templates. | `createFakeIntegrations()` shape; `defineTemplate()` final signature; `PaymentProvider` interface |
| platform-P4 (1) | `@beam/ui`: tokens, the 25 shadcn components on `radix-ui`, `DataTable`, `LocalizedInput`, `FormField`, `AdminShell`, `PortalShell`, empty, error and locale-unavailable states, `ReportProblemDialog`. Tests run in jsdom with `@vitejs/plugin-react`. | every screen |
| platform-P5 (2) | `apps/web/lib/*` except auth, action, i18n and csp; the tick route; health; files route; platform module registrations; `apps/web/lib/testing.ts` (`makeCtx`, `makeJobCtx`, `runJobTwice`, `createFakeIntegrations`, `fakeSentry`). `getIntegrations()` and `integrationMode()` implement section 1.5 exactly. `runTick()` in `job-runner.ts` and the local tick in `instrumentation.ts` (DR-13); `instrumentation-client.ts` (DR-15). The five forward stubs of DR-10. | job runner, events, audit, settings, flags, files, sensitive, webhooks, AI gateway, alerts |
| platform-P6 (3) | Auth.js v5 with the Drizzle adapter (tables mapped by name, `createUser` and `createSession` overridden) and database sessions; staff password plus TOTP through platform's own sign-in action that writes the session row and cookie (DR-11), magic link for customers through the Email provider; the platform demo seed (DR-12, DR-14); `app/globals.css` (DR-16); `action()`, `proxy.ts`, `csp.ts`, `i18n.ts` (next-intl per route group), the three route-group shells, sign-in screens, `/admin/system/jobs`, `e2e/support/a11y.ts`, `e2e/platform.spec.ts`. | `action()`, `requireStaff`, `requireCustomer`, the shells, `expectAccessible` |
| platform-P7 (3) | Every module folder with every file compiling (`actions.ts` and `queries.ts` are `export {};`, DR-12); the cross-module stubs (platform spec 4.9 and build order rule 1 table), keeping the five P5 forward-stub exports unchanged (DR-10); the working Wave 0 `email.sendTransactional` and `email.send`; each module's `permissions.ts`, `config.ts` (settings and flags), empty `privacy.ts`; `seed-demo.ts` (the runner; platform's own demo seed is P6's); `registries.test.ts`, `gdpr-coverage.test.ts`, `i18n-parity.test.ts`; `e2e/smoke.spec.ts`; the scenario and acceptance shells as `test.fixme`. | the green tree for the 14 packages of wave 4 |

**Wave 1 migration** (after P2, P3, P4 merge): `pnpm db:generate --name init`, then the custom `append_only`, then `pnpm db:views --migration init_views` (section 5.3). Waves 2 and 3 add tables only if P5 to P7 changed schema files (they should not; `platform.ts` is complete after P2), so normally `db:generate` reports "No schema changes" and nothing is committed.

### 3.6 Playwright against `beam_dev`

**Config** (`apps/web/playwright.config.ts`, platform-P1):

```ts
import { defineConfig, devices } from '@playwright/test';
const port = 3100;
export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: 1,                       // a spec that fails twice is a real failure (build order risk 6)
  workers: 2,
  fullyParallel: false,             // tests inside one file run in order
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? `http://localhost:${port}`,
    locale: 'nl-BE', timezoneId: 'Europe/Brussels',
    trace: 'retain-on-failure', screenshot: 'only-on-failure', video: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `pnpm start -p ${port}`, // production build made by the gate's `pnpm build`
    url: `http://localhost:${port}/api/health`,
    timeout: 120_000,
    reuseExistingServer: false,
    env: { APP_URL: `http://localhost:${port}`, INTEGRATIONS: 'fake', EMAIL_SINK: 'sink@beam.be', LOCAL_TICK_MS: '1000' }, // merged over process.env
  },
});
```

**`e2e/global-setup.ts`** (platform-P1, A9): refuses to run unless `DATABASE_URL` names `beam_dev` (never `neondb`), `INTEGRATIONS=fake` and `APP_ENV` is not `production`; checks that the demo seed ran (the owner `owner@demo.beam.be` exists) and fails with "run pnpm seed:demo" otherwise.

**Support helpers** (platform-P6, A9): `auth.ts` exports `signInStaff(page, role)` (password from `DEMO_STAFF_PASSWORD`, TOTP computed with `otpauth` from `DEMO_TOTP_SECRET`) and `signInCustomer(page, email, locale)` (requests a magic link, reads it with `sink.ts`, opens it, clicks "Sign in"); `sink.ts` exports `latestEmail(to, { after, subjectIncludes })` that polls `files` (kind `rendered_email`) joined to `email_messages.to_email` every 500 ms for up to 15 s and returns `{ subject, html, links }`; `db.ts` exports `e2eDb()` (a `@beam/db` handle with `neon-ws`, closed in `afterAll`); `ids.ts` exports `uniqueEmail(tag)` = `e2e+<tag>-<timestamp36>-<rand>@example.com`. `a11y.ts` (platform-P1, DR-12) exports `expectAccessible(page)` (axe, WCAG 2.1 AA tags, no `serious` or `critical` violation).

**Rules for every spec.** Each spec creates the persons it needs with `uniqueEmail()` and never edits demo seed rows, except the scenario specs that name a demo row on purpose (scenario 4 uses its own session created through the admin UI). Specs read state through the UI first and through `e2eDb()` only for what the UI does not show (sink emails, `automation_runs` reasons, `audit_log`). Specs for a release whose flag is off call `test.skip(!(await flagOn('ff_...')), 'flag off')`. Specs never call providers: everything is fake. Coding agents write specs and prove they compile with `pnpm --filter @beam/web exec playwright test --list`; only the orchestrator runs them (build order rule 2).

**How the orchestrator runs them** (section 5.4, checkpoint steps):

```bash
export DATABASE_DRIVER=neon-ws NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt
export INTEGRATIONS=fake EMAIL_SINK=sink@beam.be APP_ENV=local
pnpm db:migrate && pnpm seed:demo && pnpm build && pnpm test:e2e
```

### 3.7 The foundation checkpoint (end of wave 3)

The wave 3 gate (section 5.4) must show all of this before wave 4 starts:

- `pnpm gen:indexes` writes every registry of section 3.3 with entries from all twelve modules; `registries.test.ts`, `gdpr-coverage.test.ts`, `i18n-parity.test.ts` green.
- `pnpm db:check-migrations` green with `0000_init`, `0001_append_only`, `0002_init_views` committed; `createTestDb({ from: 'migrations' })` equals the schema build.
- On `beam_dev`: migrations applied; `pnpm seed:demo` creates nine staff users and 20 test persons and is idempotent on a second run.
- Playwright: `platform.spec.ts` and `smoke.spec.ts` green; scenario and acceptance shells listed as `fixme`.
- Measured and written to `docs/build/wave-log.md`: peak RAM during `pnpm test`, duration of each gate step, disk free. These numbers check the DR-6 memory rule; the agent limit stays at 6 (BS-16).

### 3.8 Every file the foundation creates

The lists below predate the dry run; where they differ, `build-packages.json` wins (DR-1, DR-2, DR-10, DR-12 added and moved files there). W0-0's files are listed in section 3.1. The packages' files are their `owns` lists (amendments A1, A3 and A9 applied; `m` stands for each of the eleven module ids). Generated files (section 3.3 table) are created by `pnpm gen:indexes` and never committed.

- **platform-P1** (wave 0, 45 entries): `packages/config/eslint.config.js`, `packages/config/tsconfig.base.json`, `packages/config/tsconfig.next.json`, `packages/config/tsconfig.lib.json`, `packages/config/tailwind-theme.css`, `packages/config/prettier.config.js`, `eslint.config.js`, `turbo.json`, `vercel.json`, `apps/web/next.config.ts`, `renovate.json`, `.github/pull_request_template.md`, `apps/web/vitest.config.ts`, `apps/web/playwright.config.ts`, `packages/config/tsconfig.json`, `packages/config/vitest.config.ts`, `packages/config/src/index.ts`, `packages/ui/tsconfig.json`, `packages/ui/vitest.config.ts`, `packages/ui/src/index.ts`, `packages/core/tsconfig.json`, `packages/core/vitest.config.ts`, `packages/core/src/index.ts`, `packages/email/tsconfig.json`, `packages/email/vitest.config.ts`, `packages/email/src/index.ts`, `packages/integrations/tsconfig.json`, `packages/integrations/vitest.config.ts`, `packages/integrations/src/index.ts`, `apps/web/scripts/gen-indexes.ts`, `apps/web/scripts/gen-indexes.test.ts`, `apps/web/scripts/check-ownership.ts`, `apps/web/scripts/eslint-boundaries.test.ts`, `apps/web/scripts/__fixtures__/**`, `.github/workflows/ci.yml`, `.github/workflows/preview-branch.yml`, `.github/workflows/deploy.yml`, `.github/workflows/e2e.yml`, `.github/workflows/backup.yml`, `.github/workflows/restore-drill.yml`, `.github/workflows/anonymise-staging.yml`, `docs/plan/conventions.md`, `CLAUDE.md`, `docs/build/dependency-requests/platform-P1.md`, `apps/web/e2e/global-setup.ts`.
- **platform-P2** (wave 1, 29 entries): `packages/db/scripts/docs-schema.ts`, `packages/db/test/docs-schema.test.ts`, `packages/db/src/schema/_shared.ts`, `packages/db/src/schema/platform.ts`, `packages/db/src/schema/platform.views.ts`, `packages/db/src/schema/crm.ts`, `packages/db/src/schema/booking.ts`, `packages/db/src/schema/commerce.ts`, `packages/db/src/schema/credits.ts`, `packages/db/src/schema/finance.ts`, `packages/db/src/schema/forms.ts`, `packages/db/src/schema/email.ts`, `packages/db/src/schema/automation.ts`, `packages/db/src/schema/ops.ts`, `packages/db/src/schema/site.ts`, `packages/db/src/schema/webinar.ts`, `packages/db/src/enqueue.ts`, `packages/db/src/index.ts`, `packages/db/scripts/append-only-sql.ts`, `packages/db/src/sql/0002_append_only.sql`, `packages/db/src/seed/run.ts`, `packages/db/src/seed/platform.ts`, `packages/db/src/testing/factories.ts`, `packages/db/src/testing.ts`, `packages/db/test/platform-schema.test.ts`, `packages/db/test/enqueue.test.ts`, `packages/db/test/append-only.test.ts`, `packages/db/test/factories.test.ts`, `packages/db/test/seed-platform.test.ts`.
- **platform-P3** (wave 1, 50 entries): `packages/core/src/errors.ts`, `packages/core/src/i18n/locales.ts`, `packages/core/src/i18n/localized-text.ts`, `packages/core/src/i18n/t.ts`, `packages/core/src/i18n/format.ts`, `packages/core/src/i18n/messages/nl-BE/*.json`, `packages/core/src/i18n/messages/fr-BE/*.json`, `packages/core/src/i18n/messages/en/*.json`, `packages/core/src/i18n/messages/*/platform.json`, `packages/core/scripts/i18n-check.ts`, `packages/core/src/privacy/sensitive-keys.ts`, `packages/core/src/privacy/registry-types.ts`, `packages/core/src/ai/context.ts`, `packages/core/src/ai/features.ts`, `packages/core/src/ai/pricing.ts`, `packages/core/src/platform/cron.ts`, `packages/core/src/platform/backoff.ts`, `packages/core/src/platform/flags-eval.ts`, `packages/core/src/platform/rate-window.ts`, `packages/core/src/platform/recovery-codes.ts`, `packages/core/src/platform/go-live.ts`, `packages/core/src/platform/holidays.ts`, `packages/core/src/platform/sla.ts`, `packages/core/src/platform/index.ts`, `packages/integrations/src/_shared/errors.ts`, `packages/integrations/src/_shared/digest.ts`, `packages/integrations/src/_shared/timeout.ts`, `packages/integrations/src/_shared/types.ts`, `packages/integrations/src/anthropic/client.ts`, `packages/integrations/src/anthropic/fake.ts`, `packages/integrations/src/slack/client.ts`, `packages/integrations/src/slack/fake.ts`, `packages/integrations/src/betterstack/client.ts`, `packages/integrations/src/betterstack/fake.ts`, `packages/integrations/src/resend/client.ts`, `packages/integrations/src/resend/fake.ts`, `packages/integrations/src/payments/provider.ts`, `packages/integrations/src/payments/fake.ts`, `packages/integrations/src/youtube/fake.ts`, `packages/integrations/src/ads/fake.ts`, `packages/email/src/layout.tsx`, `packages/email/src/render.ts`, `packages/email/src/index.ts`, `packages/email/src/templates/define.ts`, `packages/email/src/templates/platform/magic-link.tsx`, `packages/email/src/templates/platform/staff-invite.tsx`, `packages/email/src/templates/platform/password-reset.tsx`, `packages/email/src/templates/platform/mfa-changed.tsx`, `packages/email/src/templates/platform/monthly-report.tsx`, `packages/email/src/templates/platform/index.ts`.
- **platform-P4** (wave 1, 19 entries): `packages/ui/src/tokens.css`, `packages/ui/src/components/*.tsx`, `packages/ui/src/data-table.tsx`, `packages/ui/src/localized-input.tsx`, `packages/ui/src/form-field.tsx`, `packages/ui/src/admin-shell.tsx`, `packages/ui/src/portal-shell.tsx`, `packages/ui/src/empty-state.tsx`, `packages/ui/src/error-state.tsx`, `packages/ui/src/locale-unavailable.tsx`, `packages/ui/src/report-problem-dialog.tsx`, `packages/ui/src/cn.ts`, `packages/ui/src/index.ts`, `packages/ui/src/data-table.test.tsx`, `packages/ui/src/localized-input.test.tsx`, `packages/ui/src/admin-shell.test.tsx`, `packages/ui/src/form-field.test.tsx`, `packages/ui/src/dialog.test.tsx`, `packages/ui/src/tokens.test.ts`.
- **platform-P5** (wave 2, 35 entries): `apps/web/lib/ctx.ts`, `apps/web/lib/job-runner.ts`, `apps/web/lib/events.ts`, `apps/web/lib/audit.ts`, `apps/web/lib/settings.ts`, `apps/web/lib/flags.ts`, `apps/web/lib/files.ts`, `apps/web/lib/sensitive.ts`, `apps/web/lib/webhooks.ts`, `apps/web/lib/ai.ts`, `apps/web/lib/rate-limit.ts`, `apps/web/lib/alerts.ts`, `apps/web/lib/logger.ts`, `apps/web/lib/integrations.ts`, `apps/web/lib/*.test.ts`, `apps/web/instrumentation.ts`, `apps/web/sentry.server.config.ts`, `apps/web/instrumentation-client.ts` (DR-15), `apps/web/lib/testing.ts`, `apps/web/app/api/health/route.ts`, `apps/web/app/api/health/route.test.ts`, `apps/web/app/api/cron/tick/route.ts`, `apps/web/app/api/cron/tick/route.test.ts`, `apps/web/app/api/public/files/[id]/route.ts`, `apps/web/modules/platform/api.ts`, `apps/web/modules/platform/jobs.ts`, `apps/web/modules/platform/schedules.ts`, `apps/web/modules/platform/events.ts`, `apps/web/modules/platform/permissions.ts`, `apps/web/modules/platform/nav.ts`, `apps/web/modules/platform/privacy.ts`, `apps/web/modules/platform/config.ts`, `apps/web/modules/platform/jobs.test.ts`, `apps/web/modules/platform/privacy.test.ts`, `apps/web/lib/alerts.test.ts`, `apps/web/lib/logger.test.ts`.
- **platform-P6** (wave 3, 56 entries): `apps/web/lib/auth.ts`, `apps/web/lib/auth-config.ts`, `apps/web/lib/password.ts`, `apps/web/lib/totp.ts`, `apps/web/lib/action.ts`, `apps/web/lib/i18n.ts`, `apps/web/lib/csp.ts`, `apps/web/proxy.ts`, `apps/web/proxy.test.ts`, `apps/web/e2e/support/a11y.ts`, `apps/web/app/api/auth/[...nextauth]/route.ts`, `apps/web/app/layout.tsx`, `apps/web/app/page.tsx`, `apps/web/app/not-found.tsx`, `apps/web/app/global-error.tsx`, `apps/web/app/[locale]/layout.tsx`, `apps/web/app/[locale]/not-found.tsx`, `apps/web/app/(admin)/admin/layout.tsx`, `apps/web/app/(admin)/admin/loading.tsx`, `apps/web/app/(admin)/admin/error.tsx`, `apps/web/app/(admin)/admin/page.tsx`, `apps/web/app/(admin)/admin/account/page.tsx`, `apps/web/app/(admin)/admin/system/jobs/page.tsx`, `apps/web/app/(admin)/admin/system/jobs/[id]/page.tsx`, `apps/web/app/(admin-auth)/admin/layout.tsx`, `apps/web/app/(admin-auth)/admin/login/page.tsx`, `apps/web/app/(admin-auth)/admin/mfa/setup/page.tsx`, `apps/web/app/(admin-auth)/admin/mfa/verify/page.tsx`, `apps/web/app/(admin-auth)/admin/mfa/qr/route.ts`, `apps/web/app/(admin-auth)/admin/invite/[token]/page.tsx`, `apps/web/app/(admin-auth)/admin/reset-password/page.tsx`, `apps/web/app/(admin-auth)/admin/reset-password/[token]/page.tsx`, `apps/web/app/[locale]/(portal)/account/layout.tsx`, `apps/web/app/[locale]/(portal)/account/loading.tsx`, `apps/web/app/[locale]/(portal)/account/error.tsx`, `apps/web/app/[locale]/(portal)/account/security/page.tsx`, `apps/web/app/[locale]/(portal-auth)/account/login/page.tsx`, `apps/web/app/[locale]/(portal-auth)/account/login/check-email/page.tsx`, `apps/web/app/[locale]/(portal-auth)/account/login/verify/page.tsx`, `apps/web/app/[locale]/(portal-auth)/account/login/error/page.tsx`, `apps/web/modules/platform/actions.ts`, `apps/web/modules/platform/queries.ts`, `apps/web/modules/platform/actions.test.ts`, `apps/web/modules/platform/permissions.test.ts`, `apps/web/modules/platform/ui/login-form.tsx`, `apps/web/modules/platform/ui/mfa-setup.tsx`, `apps/web/modules/platform/ui/totp-form.tsx`, `apps/web/modules/platform/ui/password-strength.tsx`, `apps/web/modules/platform/ui/hibp.ts`, `apps/web/modules/platform/ui/hibp.test.ts`, `apps/web/modules/platform/ui/jobs-table.tsx`, `packages/core/src/i18n/messages/nl-BE/platform.json`, `packages/core/src/i18n/messages/fr-BE/platform.json`, `packages/core/src/i18n/messages/en/platform.json`, `apps/web/e2e/platform.spec.ts`, `apps/web/e2e/support/{auth.ts, sink.ts, db.ts, ids.ts}`.
- **platform-P7** (wave 3, 36 entries): `apps/web/modules/m/actions.ts`, `apps/web/modules/m/queries.ts`, `apps/web/modules/m/api.ts`, `apps/web/modules/m/jobs.ts`, `apps/web/modules/m/schedules.ts`, `apps/web/modules/m/events.ts`, `apps/web/modules/m/permissions.ts`, `apps/web/modules/m/nav.ts`, `apps/web/modules/m/privacy.ts`, `apps/web/modules/m/seed.ts`, `apps/web/modules/m/config.ts`, `packages/db/src/seed/m.ts`, `packages/core/src/m/index.ts`, `packages/core/src/m/types.ts`, `packages/core/src/i18n/messages/nl-BE/m.json`, `packages/core/src/i18n/messages/fr-BE/m.json`, `packages/core/src/i18n/messages/en/m.json`, `apps/web/modules/platform/api.ts`, `apps/web/modules/platform/jobs.ts`, `apps/web/test/wave0-email.test.ts`, `apps/web/app/[locale]/(portal)/account/page.tsx`, `packages/core/src/crm/segment-fields.ts`, `apps/web/modules/platform/seed.ts`, `apps/web/scripts/seed-demo.ts`, `apps/web/test/registries.test.ts`, `apps/web/test/gdpr-coverage.test.ts`, `apps/web/test/i18n-parity.test.ts`, `apps/web/e2e/smoke.spec.ts`, `apps/web/e2e/scenario-1-late-entry.spec.ts`, `apps/web/e2e/scenario-2-fast-unsubscribe.spec.ts`, `apps/web/e2e/scenario-3-lead-access.spec.ts`, `apps/web/e2e/scenario-4-seat-claim.spec.ts`, `apps/web/e2e/scenario-5-replay-separation.spec.ts`, `apps/web/e2e/scenario-6-sensitive-ai.spec.ts`, `apps/web/e2e/scenario-7-deletion.spec.ts`, `apps/web/e2e/acceptance-v1.spec.ts`.

## 4. The coding-agent prompt template

The orchestrator keeps this template in `scripts/build/agent-prompt.md` and fills it per package from the package object in `build-packages.json`. Placeholders are `{{name}}`. Lists are rendered one item per line. The prompt is self-contained: the agent needs nothing else from the orchestrator's conversation.

| Placeholder | Filled from |
| --- | --- |
| `{{id}}`, `{{module}}`, `{{release}}`, `{{wave}}`, `{{title}}`, `{{goal}}`, `{{estimateMinutes}}` | the package object |
| `{{spec}}`, `{{specSection}}` | `spec`, `specSection`, plus the heading of the package inside that section (`### {{id}}` or the split heading for `-a`/`-b` packages) |
| `{{owns}}` | `owns`, with `/m/` placeholders expanded (A3) |
| `{{exposes}}` | `exposes` |
| `{{tests}}` | `tests` |
| `{{dependencies}}` | each `dependsOn` id with the merge commit SHA on the integration branch and one line from its `goal` |
| `{{baseSha}}` | `git rev-parse HEAD` of the integration branch when the wave started |
| `{{workspaces}}` | the workspace packages its owned paths fall in (`@beam/web`, `@beam/core`, `@beam/db`, `@beam/email`, `@beam/integrations`, `@beam/ui`, `@beam/config`) |
| `{{retry}}` | empty on the first run; on a retry, the previous attempt's report and the last 200 lines of the failing command output |
| `{{attribution}}` | the commit trailer lines the orchestrator session was given |
| `{{budgetMinutes}}` | `min(2 × estimateMinutes, 240)` (DR-20) |

The template:

````markdown
You are a coding agent building one package of the BEAM platform. Work alone, finish the package, commit, and report. Do not ask questions: when something is unclear, decide in line with the documents below, write the decision in your commit message under "Decisions:", and continue.

## Your package
- Id: {{id}} (module `{{module}}`, release {{release}}, wave {{wave}}, estimate {{estimateMinutes}} minutes)
- Title: {{title}}
- Goal: {{goal}}
- Spec: `{{spec}}`, section {{specSection}}, the subsection for {{id}}. Read the whole spec once; that subsection is your task, the rest is context and binding rules.
- Base commit: {{baseSha}} on branch `claude/focused-hopper-gpky3y`. Your worktree starts there.

## Files you own (create or edit only these)
{{owns}}
Every test file named under "Tests you must write" is in this list. You may also add test files whose name starts with `{{id|lower}}` inside a folder you own (BS-23). Nothing else.

## Interfaces you must expose (exact names and signatures from the spec)
{{exposes}}

## Tests you must write and make green
{{tests}}
Plus, for every module package: `privacy.test.ts`, `permissions.test.ts` and `jobs.test.ts` cases for anything you add (every job run twice with the same payload yields the same state), and i18n keys in all three locales.

## Already merged (you can import these; their signatures are final)
{{dependencies}}
A function you need from a module whose implementing package has not merged exists as a typed stub in `apps/web/modules/<m>/api.ts`. Call it with that exact signature and mock it in your tests with `vi.mock`. Never change another module's stub.

## Read first, in this order
1. `CONVENTIONS.md` (the rule card) and `docs/plan/conventions.md` (naming and file patterns).
2. `docs/plan/04-build-session.md` sections 0, 1.5 and 4 (this prompt's rules and fake mode).
3. `{{spec}}` (whole file, then your subsection).
4. `docs/plan/00-decisions.md`, `docs/plan/01-architecture.md` sections 2 to 4 and 11, `docs/plan/02-data-model.md` sections for your module's tables, views, enums, events, jobs, permissions, settings and its section 6 api contract, `docs/plan/03-build-order.md` section 2.
5. The code of the packages listed under "Already merged" that you call.

## Setup (run exactly)
```bash
git checkout -B build/{{id}}
date +%s > /tmp/agent-{{id}}.start   # time budget: {{budgetMinutes}} minutes from now
cp /home/user/beam/.env.local ./.env.local
pnpm install --offline --frozen-lockfile
test -f apps/web/scripts/gen-indexes.ts && pnpm gen:indexes   # skipped only while platform-P1 writes the generator
```
Check the clock (`echo $(( ($(date +%s) - $(cat /tmp/agent-{{id}}.start)) / 60 ))` minutes) before each large step. Past {{budgetMinutes}} minutes, stop, commit what you have and report `failed` with what is left.

## Rules
1. Edit only the files you own. Never edit any `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, anything under `packages/db/migrations/`, any `*.generated.ts`, `packages/db/src/schema/index.ts`, or a frozen file (`apps/web/lib/*`, `apps/web/proxy.ts`, `packages/db/src/schema/_shared.ts`, `packages/db/src/schema/platform.ts`, `packages/config/*`, root configs, `.github/CODEOWNERS`), unless the file is in your owns list.
2. Schema: change only `packages/db/src/schema/{{module}}.ts` and `{{module}}.views.ts` if you own them. Add tables, columns, enums, indexes and checks; never drop or rename an existing column of a contract table. Do not generate migrations; the orchestrator does that after the wave. Views are `pgView(...).existing()` with their SQL exported as `<name>Sql`.
3. Registries are generated: declare jobs, schedules, events, permissions, nav, privacy, settings, flags, seeds, templates and merge fields in your module's top-level facade files with literal keys and run `pnpm gen:indexes`. Never write a shared list by hand. If the facade file is not in your owns list, the registration is already there and points at a function in a sub-folder file you own: implement that function and keep its name and signature.
4. A request never calls an external service. Provider calls happen in jobs through `getIntegrations()` / `ctx` clients; tests use the fakes from `@beam/integrations/<provider>/fake` or `createFakeIntegrations()`. No network in tests. No real keys exist; do not read any.
5. Tests use `createTestDb()` from `@beam/db/testing` (one per test file; it already applies the views and the append-only triggers) and the shared factories. Never connect to Neon. Never run Playwright tests; if you own e2e specs, prove they compile with `pnpm --filter @beam/web exec playwright test --list`.
6. Need an npm package that is not installed? Do not install it. Write `docs/build/dependency-requests/{{id}}.md` (package, exact version from `npm view`, why, which file needs it), implement without it if you can, and mention it in the report.
7. Need something from another module (a function, a column, a catalogue key, an event)? Do not edit their files. Mock it, finish your part, and list it under "Requests:" in the commit message and the report.
8. Never weaken, skip or delete a test to get green, except a Playwright spec of a later release that skips itself while its flag is off.
9. Copy text into all three catalogues (`en` is the source; write real Dutch and French, not placeholders).
10. No secrets, personal data or real email addresses in code or fixtures; use `@example.com` and `@demo.beam.be`.
11. Next.js 16.4 (DR-21): `apps/web/proxy.ts` exports `proxy` and runs on Node; there is no `middleware.ts`. `params`, `searchParams`, `cookies()`, `headers()` and `draftMode()` return Promises; always `await` them, and type a route handler's second argument as `{ params: Promise<{ ... }> }`. `typedRoutes` is on: `pnpm typecheck` runs `next typegen` first, so `Link` and `redirect` targets are checked. `revalidateTag(tag, 'max')`. Never call `next lint`.
12. Tailwind v4: no `tailwind.config.*`; theme tokens live in `@beam/config/tailwind-theme.css` and `@beam/ui/tokens.css`. Drizzle 0.45: views are `pgView(name, columns).existing()`; use `casing: 'snake_case'` names (camelCase properties map to snake_case columns).

## Before you commit (all must pass)
```bash
pnpm install --offline --frozen-lockfile
pnpm gen:indexes
pnpm typecheck
pnpm exec eslint $(git diff --name-only --diff-filter=ACMR {{baseSha}} -- '*.ts' '*.tsx' '*.js')
pnpm i18n:check
# your Vitest suites, per workspace you touched ({{workspaces}}), for example:
pnpm --filter @beam/web exec vitest run modules/{{module}} app
pnpm --filter @beam/core exec vitest run src/{{module}}
pnpm --filter @beam/db exec vitest run
pnpm --filter @beam/web exec playwright test --list   # only if you own e2e specs
pnpm exec tsx apps/web/scripts/check-ownership.ts --package {{id}} --base {{baseSha}}
```
If a suite of another module fails because of your change, fix your change. If it fails without your change (it fails on the base commit too), note it in the report and do not touch it.

## Commit (one commit, or a few small ones, on `build/{{id}}`; never push)
```
{{module}}: <imperative summary under 70 characters>

<two to five lines: what the package does now>

Package: {{id}}
Wave: {{wave}}
Tests: <test files added or changed>
Decisions: none | <one line each>
Requests: none | <module: what is needed, one line each>
Dependency-requests: none | docs/build/dependency-requests/{{id}}.md
Missing-catalogue-keys: none | <key in another module's catalogue>

{{attribution}}
```

## Report (your final message, exactly this block and nothing after it)
```json
{ "package": "{{id}}", "status": "done | failed", "branch": "build/{{id}}", "commit": "<sha>",
  "testsRun": ["<command>: <passed>/<total>"], "failures": ["<command>: <first error line>"],
  "requests": ["<module>: <need>"], "dependencyRequests": ["<pkg>@<version>"], "decisions": ["<line>"],
  "minutes": <elapsed> }
```
The orchestrator's workflow passes this block's JSON schema to `agent()` (DR-20), so you return it through the structured-output tool. Status `done` means every command under "Before you commit" passed and the commit exists. Otherwise report `failed`, still commit what you have (so the retry can start from it), and put the failing command's first error lines in `failures`.

{{retry}}
````

When `{{retry}}` is filled, it reads: "This is attempt 2. Attempt 1 ended with the report below. Start from branch `build/{{id}}` as it is (`git checkout build/{{id}}` instead of `-B`), read the failure output, fix the cause, and finish the package." followed by the report and the output.

## 5. The wave loop

### 5.1 The loop in one screen

```
for wave in 0..23:
  1. prepare   check every dependsOn is merged; node scripts/build/ownership.mjs; record baseSha
  2. launch    packages longest-first, at most 6 (BS-16) coding agents at once, prompt of section 4
  3. collect   each report; status failed -> retry once (5.6); still failed -> split or fixer
  4. merge     scripts/build/merge-wave.sh <wave> (5.3): ownership check, git merge --no-ff in list order
  5. deps      install dependency requests if any (5.5)
  6. migrate   gen:indexes, db:generate --name, db:views, protect, db:check-migrations (5.3)
  7. gate      scripts/build/gate.sh <wave> (5.4); red -> gate-fixer agent (5.6) until green
  8. beam_dev  db:migrate with neon-ws (every wave with a migration); at checkpoints seed:demo and e2e
  9. record    docs/build/wave-log.md, coverage matrix status at checkpoints
 10. ship      git commit, git push origin claude/focused-hopper-gpky3y, remove merged worktrees
```

The orchestrator writes the loop as a Workflow script (it loads the `workflow-authoring` skill first). One workflow run per wave keeps each run short and resumable; the orchestrator itself does steps 4 to 10 between runs, because they need its judgement.

### 5.2 Launching and collecting

- **Order.** Sort the wave's packages by `estimateMinutes`, longest first; ties by list order. Deal them round-robin into up to three groups, one Workflow run per group (BS-16); inside a run the tool starts the next package each time one returns. Never more than 6 agents at once.
- **Agent options.** `model: 'claude-opus-5-5'`, `isolation: 'worktree'` from the integration branch at `baseSha`, the filled prompt of section 4. No other tools or permissions are granted than the Workflow defaults for coding agents.
- **Timeout.** `agent()` has no timeout option, so the budget (twice `estimateMinutes`, at most 240 minutes) is enforced by the agent itself (`{{budgetMinutes}}`, DR-20). An agent still running 30 minutes past its budget is stopped with `TaskStop` on its workflow run. That stops the whole group: agents of the group that already returned keep their reports and committed branches, the others count as `failed`, and their branches are kept for the retry.
- **Collect.** `agent()` returns the report object (DR-20); a `null` result counts as `failed`. Then, in the main checkout: `git log --oneline baseSha..build/<id>` must show at least one commit, and `pnpm exec tsx apps/web/scripts/check-ownership.ts --package <id> --base <baseSha>` (run against the package branch) must pass. A report saying `done` that fails either check is treated as `failed`.
- **Requests.** Copy every `requests` entry into `docs/build/wave-log.md` under the wave with the owning module. A request for a module whose next package is in a later wave is added to that package's prompt as an extra "Requested by earlier packages" list (the orchestrator appends it to `{{goal}}`); a request that no later package can serve becomes a fix package after the wave (5.6).
- **Resources.** Before starting an agent: `df -BG /` must show at least 6 GB free, `free -g` at least 3 GB `available` (DR-6), and no more than 8 worktrees may exist (`git worktree list`). Otherwise wait for a running agent to return and clean merged worktrees first.

### 5.3 Merging and generating the wave migration

`scripts/build/merge-wave.sh <wave>` runs in `/home/user/beam` on the integration branch with a clean tree:

```bash
#!/usr/bin/env bash
set -euo pipefail
wave="$1"
ids=$(node -e "const p=require('./docs/plan/build-packages.json');console.log(p.waves.find(w=>w.wave==${wave}).packages.join(' '))")
for id in $ids; do
  git rev-parse --verify -q "build/$id" >/dev/null || { echo "missing branch build/$id"; exit 2; }
  git merge --no-ff "build/$id" -m "merge: $id (wave $wave)" || { echo "CONFLICT in $id"; exit 3; }
done
```

**Conflicts.** Owners are disjoint inside a wave, so a conflict means one of three things, handled as follows:

1. Both sides changed a file that only one package owns (the other package edited it against the rules, and the ownership check missed it): `git checkout --theirs` or `--ours` so the owner's version wins, `git add`, continue the merge, then run the foreign package's tests in the gate; a red result goes to a fixer for the foreign package.
2. Two packages of the same module in one wave both added lines to a file that neither owns exclusively (a plan error in `owns`): abort that merge (`git merge --abort`), merge the rest, and give the aborted package to a fixer agent whose prompt says "rebase `build/<id>` onto the current integration branch and resolve the conflict in favour of both changes" (it owns that package's files plus the conflicting file for this one task).
3. A conflict in a generated file: impossible, they are git-ignored; if one appears, a package committed a generated file against the rules: delete it from the merge (`git rm --cached`) and continue.

**Migration** (after all merges, before the gate). `<NN>` is the two-digit wave number. Commands:

```bash
pnpm gen:indexes
pnpm db:generate --name w<NN>                 # wave 1: --name init; prints "No schema changes" when none
# wave 1 only: the append-only custom migration
pnpm db:append-only                           # (re)writes packages/db/src/sql/0002_append_only.sql
pnpm --filter @beam/db exec drizzle-kit generate --custom --name append_only
cp packages/db/src/sql/0002_append_only.sql "$(ls -t packages/db/migrations/*_append_only.sql | head -1)"
# every wave: views that are new or changed (wave 1: init_views)
pnpm db:views --migration w<NN>_views         # writes nothing when no view changed
# every wave that created a table listed in APPEND_ONLY_TABLES
pnpm --filter @beam/db exec drizzle-kit generate --custom --name w<NN>_protect
echo "select beam_protect_append_only();" > "$(ls -t packages/db/migrations/*_w<NN>_protect.sql | head -1)"
# R4 only (waves 22 and 23): the two named custom files written by platform-P10 and ops-P10 as
# packages/db/src/sql/0100_ai_readonly.sql and 0101_ai_views_ops.sql, placed the same way with
# --name ai_readonly (wave 22) and --name ai_views_ops (wave 23)
pnpm db:check-migrations
git add packages/db/migrations && git commit -m "db: migration for wave <NN>"
```

Which waves create APPEND tables (so need `w<NN>_protect`): wave 1 (covered by `append_only` itself), waves 4 to 6 (person_merges, person_declarations, membership_periods, email_events, automation_versions, automation_runs, imported_history, terms_acceptances, cookie_consents, as each lands), wave 12 to 16 (watch_segments, webinar_interactions, webinar_moderation_actions), wave 19 (lightspeed_sales), wave 22 (site_audit_reports). That list is what the plan expects. The rule that decides is mechanical: the orchestrator runs `select beam_protect_append_only()` through a `w<NN>_protect` file in every wave whose `db:generate` created a table named in `APPEND_ONLY_TABLES`, checked with `grep -l "CREATE TABLE \"\(<names joined by \|>\)\"" packages/db/migrations/*_w<NN>.sql`.

A migration that drizzle-kit wants to write as a drop, rename or type change is not allowed (expand-only rule). drizzle-kit asks interactively about renames; the orchestrator never answers "rename": it stops, deletes the generated file, and runs a fixer for the package that changed the column, with the instruction to add a new column instead.

**Apply to `beam_dev`** after the gate is green and before the push, in every wave that produced a migration:

```bash
DATABASE_DRIVER=neon-ws NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt pnpm db:migrate
```

### 5.4 The gate

`scripts/build/gate.sh <wave>` (BS-13) runs from the integration branch with the merged tree and the new migration. Every step's output goes to `docs/build/logs/w<NN>-<step>.log` (git-ignored); the script stops at the first red step and prints its name.

```bash
#!/usr/bin/env bash
set -euo pipefail
wave="$1"; NN=$(printf '%02d' "$wave"); logs=docs/build/logs; mkdir -p "$logs"
if grep -Eq '^DATABASE_URL(_UNPOOLED)?=.*/neondb' .env.local || grep -q '/neondb' <<<"${DATABASE_URL:-}${DATABASE_URL_UNPOOLED:-}"; then echo "refusing: database points at production"; exit 9; fi
export INTEGRATIONS=fake EMAIL_SINK=sink@beam.be APP_ENV=local
[ -f apps/web/scripts/gen-indexes.ts ] || { echo "gate needs platform-P1 merged"; exit 2; }
step() { local name="$1"; shift; echo "== $name"; "$@" >"$logs/w$NN-$name.log" 2>&1 || { echo "RED: $name (see $logs/w$NN-$name.log)"; tail -40 "$logs/w$NN-$name.log"; exit 1; }; }
step install         pnpm install --offline --frozen-lockfile
step gen             pnpm gen:indexes
step generate-clean  bash -c 'pnpm db:generate --name gate_probe | tee /dev/stderr | grep -q "No schema changes"'
step check-migr      pnpm db:check-migrations
if [ "$wave" -ge 1 ]; then          # the scripts below are written in wave 1 (DR-4)
  step views         pnpm db:views --check
  step append-only   pnpm db:append-only --check
fi
step migr-db         pnpm --filter @beam/db test:migrations
step typecheck       pnpm typecheck
step lint            pnpm lint
if [ "$wave" -ge 1 ]; then step i18n pnpm i18n:check; fi
step test            pnpm test
if [ "$wave" -ge 3 ]; then step gdpr pnpm gdpr:coverage; fi
step build           pnpm build
checkpoint=$(node -e "const p=require('./docs/plan/build-packages.json');console.log(p.waves.find(w=>w.wave==${wave}).e2eCheckpoint)")
if [ "$checkpoint" = "true" ]; then
  export DATABASE_DRIVER=neon-ws NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt
  step migrate       pnpm db:migrate
  step seed          pnpm seed:demo
  step e2e           pnpm test:e2e
fi
echo "GREEN: wave $wave"
```

Notes: the `generate-clean` step proves the committed migration covers the schema (a leftover change makes drizzle-kit write a `gate_probe` file; the step is then red and the probe file is deleted by the orchestrator with `git clean -f packages/db/migrations`). `pnpm test` runs every Vitest suite of every workspace through Turborepo (cached per package when inputs did not change). The gate runs in the main checkout; agents are idle while it runs. Typical durations measured on the foundation waves are written to the wave log; the plan assumes 20 minutes, 60 at a checkpoint.

### 5.5 Dependency requests between waves

After merging, `ls docs/build/dependency-requests/` shows the requests of the wave. For each:

1. `npm view <pkg>@<version> version peerDependencies` (and `time` for the date); refuse a package that duplicates an installed one (for example a second date library) and tell the requesting module's next package to use the installed one instead.
2. Add it to the catalog in `pnpm-workspace.yaml` and to the right workspace `package.json` with `catalog:`.
3. `pnpm install` then `pnpm install --offline --frozen-lockfile` (proves the store has it for the next worktrees).
4. Commit `build: install dependency requests of wave <NN>` before the gate.
5. Move the handled files to `docs/build/dependency-requests/done/`.

A request that arrives in a package's report while the package also implemented a workaround is still installed only when a later package needs it.

### 5.6 When something fails

**A package returns `failed` (or times out, or fails the ownership check).**

1. Retry once: remove its worktree (`git worktree remove --force <path>`, the branch stays), relaunch the same package with `{{retry}}` filled with the report and the last 200 lines of the failing command. The retry continues from the branch.
2. If the retry fails too, decide by the failure:
   - **Too big** (the agent ran out of time with most tests green, or the failure list spans more than one area of the spec): split along the `owns` list into `<id>-a` (schema, core, server code and their tests) and `<id>-b` (screens, routes, e2e specs and the rest), add both to the same wave in `build-packages.json` with `dependsOn` `<id>-a` before `<id>-b` and the `-b` part moved to the next round, record it in `docs/build/split-log.md` and in the spec's package list, and launch `-a` from the existing branch.
   - **Small and specific** (one test or one type error left): launch a fixer agent `fix-w<NN>-<module>-<n>` on branch `build/fix-w<NN>-<module>-<n>` created from `build/<id>`, owning the same files, with the failure output as its whole task. Merge the fixer's branch instead of the package branch.
   - **Blocked by another module** (a missing function or column): mock it, mark the dependent tests `it.todo` with the request text, merge, and add the request to the owning module's next package (5.2). If no next package of that module exists in the plan, the orchestrator adds a fix package `fix-w<NN>-<owner>-<n>` to the next wave.
3. A wave is merged only when every package (or its split or fixer) is `done`. The orchestrator never merges a red package.

**The gate is red.**

1. Read the failing step's log. Name the owner from the failing file's path with `docs/build/ownership.json` (the first stack frame or type error inside the repo decides).
2. Launch a gate-fixer agent `fix-w<NN>-<module>-<n>` on branch `build/fix-w<NN>-<module>-<n>` from the current integration branch. Its prompt is the section 4 template with: `{{goal}}` = "make the wave <NN> gate green", `{{owns}}` = that module's files of this wave (the union of its packages' `owns` lists in this wave, or the module's whole folder set when the failure is in an earlier wave's file), `{{tests}}` = the failing command, and `{{retry}}` = the log tail (last 200 lines) plus the exact gate command.
3. Merge it with `--no-ff`, run the gate again from the failing step onwards (the earlier steps are cheap and rerun anyway). Repeat up to three fixers per wave; a fourth red gate means a design error: the orchestrator writes `docs/build/wave-log.md` "blocked" with the analysis, fixes the plan (a `plan:` commit that changes the owning spec and package), and continues with a fixer under the new plan. It does not stop the session.
4. A failure in a frozen file (`apps/web/lib/*`, `proxy.ts`, `_shared.ts`, `platform.ts`, `packages/config/*`) goes to a fixer with platform ownership of exactly that file; it is the only way a frozen file changes, and it is a separate commit `platform: fix <file> (frozen-file change, wave <NN>)`.
5. A red `lint` step caused only by formatting is fixed by the orchestrator with `pnpm exec eslint --fix <files>` on the owning package's files; nothing else is edited by the orchestrator directly.

**End-to-end red at a checkpoint.** Re-run the failing spec once alone (`pnpm test:e2e e2e/<file>.spec.ts`). Green alone and red in the suite means a data collision between specs: fixer for the spec's owner with "make the spec independent (own persons, own session)". Red twice: triage by the step that failed (the page's route folder and its owning package) and run a fixer. A seam failure found by platform-P12 or P13 goes to `docs/build/seam-issues-v1.md` or `-r2.md` and becomes a fix package before the next release starts (build order rule 7).

**Infrastructure.** Neon unreachable: wait 2 minutes and retry the step three times; Vitest needs no network, so the waves keep running and only the `beam_dev` steps wait. Disk below 6 GB: `git worktree prune`, delete `apps/web/.next` in removed worktrees, `pnpm store prune`. An agent process crash: same as `failed`.

### 5.7 Ship and clean up

```bash
git status --short                       # only expected files
git commit -am "build: wave <NN> gate green" --allow-empty
git push origin claude/focused-hopper-gpky3y
for id in <wave ids>; do git worktree remove --force "$(git worktree list --porcelain | awk -v b="refs/heads/build/$id" '$1=="worktree"{w=$2} $1=="branch" && $2==b {print w}')" || true; done
git worktree prune
```

Package branches stay (they are cheap and document the history); they are never pushed. `docs/build/wave-log.md` gets one entry per wave: start and end time, packages with minutes and attempts, splits and fixers, migration file names, gate step durations, peak RAM, free disk, e2e results with counts, requests carried forward, and at checkpoints the coverage matrix rows that turned green.

### 5.8 Checkpoints and what must be green

| Wave | Checkpoint | Specs that must pass (in addition to everything green before) |
| --- | --- | --- |
| 3 | foundation | `platform.spec.ts`, `smoke.spec.ts` |
| 7 | first seams | `platform-admin`, `site-public`, `site-admin`, `site-a11y`, `site-consent`, `site-perf`, `site-claude`, `site-portal`, `forms`, `ops`, `ops-exports`, `crm`, `booking` (staff), `scenario-2-fast-unsubscribe`, `scenario-4-seat-claim`, `scenario-6-sensitive-ai` |
| 9 | V1 core flows | `commerce` (shop, checkout), `booking` (portal), `finance`, `email`, `automation`, `automation-person`, `ops-imports`, `scenario-1-late-entry` |
| 11 | end of V1 | `commerce` (POS), `credits`, `email` (reporting), `scenario-7-deletion`, `acceptance-v1`; load scenarios of platform-P11b run against the local production build instead of staging (staging does not exist yet) |
| 18 | end of R2 | `scenario-3-lead-access`, `scenario-5-replay-separation`, `webinar-register`, `webinar-watch`, `acceptance-r2-webinar`, `ops-retention`, `site-events-r2`, `acceptance-r2`, `scenario-7-deletion` with webinar data; the R2 flags are switched `on` in `beam_dev` before the run (`ff_webinar_portal`, `ff_booking_lead_priority`, `ff_booking_ticket_types`, `ff_commerce_checkout_recovery`, `ff_forms_portal_results`, `ff_ops_retention`) |
| 21 | end of R3 | `ops-marketing`, `site-consent` (marketing tags); R3 flags on (`ff_crm_pipeline`, `ff_crm_inbox`, `ff_crm_inbox_meta`, `ff_ops_marketing`) |
| 23 | end of R4 | `automation-builder`, `ops-ai`; `ff_ops_ai` on |

Flags are switched on in `beam_dev` with `pnpm --filter @beam/web exec tsx ../../scripts/build/set-flag.ts <key> on` (with the `neon-ws` variables). The orchestrator writes this short script after wave 4: it runs platform's flag update (the `flags.manage` action's service function from `apps/web/modules/platform`) as the system actor inside one transaction, so the change is audited like a staff change. Flags are never set by hand-written SQL.

## 6. Seed and demo data

### 6.1 Purpose and rules

The demo dataset makes `beam_dev` look like BEAM after about three months of use, so demos, training screenshots (platform-P11b) and the e2e suites have realistic data in all three languages. It is loaded by `pnpm db:seed` (BS-11) and is binding for every package that owns a demo seed file (`apps/web/modules/<m>/seed.ts`): each such package implements the rows of its module below, in addition to what its spec lists. Where a spec's seed list and this section differ, the union is seeded.

- **Real flows, not raw inserts.** Persons are created with `crm.findOrCreatePersonByEmail`, orders through `commerce.createOrder` and the fake payment settled `paid` (so credits, invoices, timeline events and emails come from the real paid transaction), bookings through booking's own service functions, form submissions through forms' submit function, campaigns through email's plan and send jobs. Only history that has no service path (past sessions, past attendance) is inserted directly by its owner's seed.
- **Backdating.** A demo seed may set `ctx.now` to a past moment for one call; `occurred_at`, `paid_at`, `attended_at`, `issued_on` follow it. `created_at` stays the seed time.
- **Deterministic and idempotent.** PRNG seed `20261103`; natural keys (email, sku, slug, template key, invoice external reference) make a second run a no-op; `DemoIds` passes ids between module seeds.
- **Safe.** Every person has `is_tester = true` and an address under `@demo.beam.be` (staff) or `@example.com` (customers). `EMAIL_SINK` catches everything. The demo profile refuses `APP_ENV=production`.
- **Order** (the `after` lists): platform → crm → site → forms → commerce → credits → booking → finance → email → automation → ops → webinar. A module whose seed does not exist yet (earlier waves) is skipped; the dataset grows wave by wave.

### 6.2 The business frame

- Company (`settings.company`, demo values): legal name Vibrant Lifestyle Collective BV, trade name BEAM, VAT `BE0123456749` (a valid mod-97 demo number, replaced by the real one at go-live), address `Voorbeeldstraat 1, 9000 Gent`, support `hello@beam.be`, phone `+32 9 000 00 00`, website `https://www.beam.be`.
- Opening: day sessions Tuesday to Sunday at 09:00, 11:30, 14:00 and 16:30 (120 minutes, 12 seats); nights Friday and Saturday at 21:00 (720 minutes, 6 beds); closed Monday and on Belgian public holidays (`belgianPublicHolidays`); a closed-day exception on 24 and 25 December 2026.
- Rules (`settings.booking_rules`): day sessions free cancellation until 24 h before, nights 72 h, events non-refundable; no-show marking on.

### 6.3 What is seeded, by module

| Module (seed owner) | Rows |
| --- | --- |
| platform (platform-P7) | Nine staff users `<role>@demo.beam.be` (owner Gaëtan Demo `nl-BE`, management Achille Demo `fr-BE`, customer_service Sofie Demo `nl-BE`, sales Thomas Demo `nl-BE`, marketing Julie Demo `fr-BE`, finance Marc Demo `nl-BE`, reception Lien Demo `nl-BE`, technical_admin Dev Demo `en`, external_partner Partner Demo `en` linked to the partner hotel), all MFA-enrolled with `DEMO_TOTP_SECRET`; `users.is_tester = true` for owner and marketing; settings with the demo `company` values; flags: every V1 flag `on`, R2 to R4 flags `off` (switched at their checkpoints, 5.8). |
| crm (crm-P1, completed by later crm packages) | 60 customer persons: 30 `nl-BE`, 18 `fr-BE`, 12 `en`, Belgian first and last names from fixed pools (Dutch: Peeters, Janssens, Maes, Jacobs, Mertens, Willems, Claes, Goossens, Wouters, De Smet; French: Dubois, Lambert, Dupont, Martin, Simon, Laurent, Leroy, Lefebvre; English: Smith, Taylor, Brown, Wilson). Twelve named personas that specs and demos use: **Lotte Peeters** (nl-BE, member since August, monthly membership, books weekly), **Jonas Claes** (nl-BE, customer, 10-day package with 3 left, expires in 10 days), **Camille Dubois** (fr-BE, customer, 5-day package, shares with a guest), **Lucas Lambert** (fr-BE, lead from the vitality assessment, newsletter consent, in `welcome-lead` step 2), **Emma Janssens** (nl-BE, lead from a Meta campaign with UTM, no consent), **Noah Maes** (nl-BE, customer, two no-shows, inactive 65 days), **Sarah Wilson** (en, customer of nights only, 2-night package), **Elise Martin** (fr-BE, unsubscribed from the newsletter via the one-click link), **Pieter Jacobs** (nl-BE, hard bounce, suppressed), **Hanne Wouters** (nl-BE, member `past_due` after a failed renewal), **Tom De Smet** and **Tom Desmet** (a duplicate pair with the same phone, waiting in the duplicate queue), **Marie Leroy** (fr-BE, a privacy export request received). Consents: newsletter granted for 38, events for 30, member_comms for all members, withdrawn newsletter for 3 (each with history rows), wording versions v1. Tags: `vip`, `corporate`, `night-guest`, `assessment-done`, `influencer`. Segments: `leads`, `customers`, `members`, `newsletter-nl`, `newsletter-fr`, `newsletter-en`, `inactive-60-days`, `low-balance`, with `last_count` computed. Companies: Hotel Zonnebloem (partner, 10 % commission, partner user), Acme Logistics NV (corporate customer, 3 contacts), Kine Gent (physio, prospect), Studio Yoga Leuven (partner). Tasks: 8 open (2 overdue), 5 done. Sensitive: one `health_note` for Lotte Peeters (encrypted with the demo key), one sensitive staff note. |
| site (site-P7) | Pages `home`, `about`, `day-sessions`, `nights`, `memberships`, `pricing`, `events`, `blog`, `contact`, `privacy`, `terms` (published demo terms, so checkout works), `cookies`, `accessibility`, `guardian-consent`, in all three locales; three blog posts (`slaap-en-herstel`, `respiration-et-stress`, `the-power-of-rest`), each in its own locale plus translations; redirects for five old WordPress URLs. |
| forms (forms-P2, completed by later forms packages) | `contact` (lead), `newsletter` (lead, newsletter consent checkbox), `vitality-check` (assessment: 14 questions, branching on "do you sleep less than 6 hours", dimensions sleep, stress, energy, recovery with weights, outcomes `rested`, `recharge`, `restore`, result page per outcome in three locales), `event-registration`, `b2b-inquiry`, `health-declaration` (intake with sensitive fields, kept as draft because the DPIA is not approved, DM-15). 40 submissions: 22 completed assessments (8 by existing customers, which updated their record), 6 partial, 4 abandoned, 8 contact and newsletter forms; UTM on 15 of them (`utm_source` meta, google, newsletter). |
| commerce (commerce-P3) | Products and price versions of the spec: day walk-in €45 (21 %), night €95 (6 %), 5-day package €200 / 6 months (21 %), 10-day package €380 / 12 months (21 %), 2-night package €180 / 12 months (6 %), monthly membership €89 with 4 day credits and 10 % member discount (21 %), event ticket €25 (21 %), gift voucher €25 to €500 (0 %, single-purpose), BEAM water bottle €19 (21 %). A price change on the 10-day package (€360 until 1 October, €380 since), so price history shows two versions. Promotions: code `WELKOM10` (10 %, first purchase, max 1 per person), automatic `NIGHTS-WINTER` (€20 off the 2-night package in December). 35 paid orders over the last 90 days through the fake provider (portal 22, site 6, POS 5 with cash or terminal, link 2), one expired order, one abandoned checkout with recovery data, one refund (half of a 5-day package) with its credit note. |
| credits (credits-P6, A10) | Beyond the grants created by the paid orders: Camille Dubois's grant with `sharing.mode = guests` and one guest use this month; one bonus grant (1 day, reason "compensation for a cancelled session"); one manual `adjust` with reason; Hanne Wouters's renewal made to fail with the fake's `failNext()`, so her membership is `past_due` and shows on the action dashboard; one `extend` on an expired-soon grant. |
| booking (booking-P2, completed by later booking packages) | Session templates as in 6.2; sessions materialised 90 days ahead; 60 days of past sessions with about 70 % occupancy: about 480 bookings, attended 88 %, late-cancelled 5 %, no-show 4 %, cancelled in time 3 %; capacity holds (2 staff seats on Wednesdays, the partner hotel holds 2 beds on the first Saturday of each month); a full Saturday night 9 days ahead with 3 people waiting and one live offer (claim link in the sink); events: `Lezing: Slaap en herstel` (nl-BE, 30 seats, 18 booked), `Atelier respiration` (fr-BE, 15 seats, full, waitlist 2), `Vitality Evening` (lead magnet event with `lead_reserved_seats = 10` and a lead window, used by scenario 3 once R2 flags are on). |
| finance (finance-P6) | Invoices issued by the paid orders: numbers `BEAM-2026-000001` upwards in paid order, one credit note `CN-2026-000001`, one B2B invoice for Acme Logistics NV with its VAT number and an open bank transfer (due in 12 days), Billit fake ids on all, one invoice with `billit_status = failed` (Retry visible on the finance screen). |
| email (email-P3, completed by later email packages) | System rows of every code-backed transactional template; marketing templates `welcome-newsletter`, `nieuwsbrief-november` / `newsletter-novembre` / `newsletter-november` (one template, three locales), `night-launch`, `member-content-blocks` (lead, customer and member blocks, for the acceptance test); campaigns: November newsletter sent to `newsletter-nl` + `-fr` + `-en` (46 recipients: 43 delivered, 21 opened, 9 clicked, 1 hard bounce → Pieter Jacobs suppressed, 1 complaint → suppressed), `night-launch` scheduled for next Thursday 10:00, one draft; warm-up schedule at week 2. |
| automation (automation-P4) | The nine seeded V1 sequences (`welcome-lead`, `after-first-booking`, `after-first-visit`, `package-usage`, `inactivity`, `membership-renewal`, `review-request`, `waitlist-offer`, `abandoned-checkout` paused behind its flag), published v1, active; enrolments produced by replaying the seeded events through `automation.evaluate` (the seed-demo runner runs jobs at the end), so the logs show `sent`, `skipped_late_entry`, `skipped_unreachable` (Elise Martin) and `exited: order.paid` rows. |
| ops (ops-P1, completed by later ops packages) | `person_stats` computed for everyone; retention lists filled from `v_retention_candidates`; one finished import (Mailchimp CSV of 12 rows, 2 duplicates merged by email, 1 suppression kept) and one dry run with its report; the WebinarGeek history import (`history`, `webinar_tool`, preset `webinargeek`, 15 attendees of two past webinars); Marie Leroy's export request `received`; retention policies seeded by the defaults profile. |
| webinar (webinar-P3, R2) | Webinar `Beter slapen in 30 dagen` (nl-BE, live 14 days ago, replay open) with 28 registrations, 17 live viewers with watch segments, 6 replay viewers, poll answers in both modes, one CTA with clicks; webinar `Mieux dormir` (fr-BE, upcoming in 5 days) with 9 registrations; uses the YouTube fake (`fake_` video ids, A5). |
| R3 and R4 data (crm-P8, ops-P8, credits-P9, ops-P9) | When their packages exist: 6 opportunities across the B2B stages; ads rows from the fakes for the last 60 days; two referral codes with attributions; one shared custom dashboard. These are added by those packages' seed files; until then they are absent. |

### 6.4 Loading it

```bash
export DATABASE_DRIVER=neon-ws NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt
pnpm db:migrate
pnpm db:seed                 # defaults then demo (local); prints one line per module with counts
pnpm db:seed                 # second run: every line says "0 created"
```

**Resetting `beam_dev`.** The demo seed is additive and idempotent, so normal checkpoints just run it again. When a wave changed seed logic in a way that conflicts with existing rows (the wave log names it), the orchestrator resets the database first: `pnpm --filter @beam/web exec tsx ../../scripts/build/reset-beam-dev.ts`, a script it writes in wave 3 that refuses unless the database name is `beam_dev`, then runs `drop schema public cascade; create schema public; drop schema if exists drizzle cascade;` and `pnpm db:migrate`. Nothing else ever drops data on `beam_dev`, and nothing touches `neondb`.

## 7. Definition of done for the whole build

### 7.1 The checklist

The build session is done when every line below is true. The orchestrator checks them in this order after wave 23 and writes the result to `docs/build/wave-log.md` under "Build complete".

1. **All waves merged.** All 123 packages (plus any splits and fixers) of waves 0 to 23 are merged into `claude/focused-hopper-gpky3y` with `--no-ff`; `git log --merges` shows one merge per package; the branch is pushed.
2. **All gates green.** Every wave's gate passed; a final full gate `scripts/build/gate.sh 23` passes on the final tree, and it is run once more with every flag `on` in `beam_dev` (V1 to R4).
3. **Migrations.** `pnpm db:check-migrations`, `pnpm db:views --check` and `pnpm db:append-only --check` green; `createTestDb({ from: 'migrations' })` equals the schema; `beam_dev` is migrated to the last file; every one of the 24 APPEND tables carries its trigger (`select count(*) from pg_trigger where tgname like '%_append_only'` returns 24 on `beam_dev`).
4. **Acceptance in fake-provider mode.** Against `beam_dev`, after `pnpm db:seed`, with `INTEGRATIONS=fake` and all flags on, `pnpm test:e2e` is green, including the seven scenario specs and the acceptance specs that encode proposal section 12 (blueprint section 76):

| Proposal section 12 test | Spec that proves it |
| --- | --- |
| V1 core: register, book, pay, cancel | `acceptance-v1.spec.ts` (core block), `commerce.spec.ts`, `booking.spec.ts` |
| Package balance updates | `commerce.spec.ts` ("5 sessions remaining", then 4 after a booking, 5 after an in-time cancel) |
| Member discount applies automatically | `commerce.spec.ts` (member price without a code) |
| Administrator can change a booking | `booking.spec.ts` (staff reschedule with audit row) |
| CRM shows the activity | `crm.spec.ts` (timeline shows order, booking, cancel, email) |
| Reports reflect the transaction | `ops.spec.ts` and `finance.spec.ts` (revenue and invoice list include the order) |
| Data can be exported | `ops-exports.spec.ts` |
| Late-entry reminders are skipped | `scenario-1-late-entry.spec.ts` |
| Unsubscribe stops marketing within 15 minutes | `scenario-2-fast-unsubscribe.spec.ts` (ends the enrolment within seconds) |
| Hard bounces are suppressed | `email.spec.ts` (fake bounce event → suppression → next campaign skips) |
| Lead, customer and member content blocks display correctly | `email.spec.ts` (`member-content-blocks` rendered for three personas) |
| A weighted, branched assessment works | `forms.spec.ts` (`vitality-check`) |
| An existing customer record is updated | `acceptance-v1.spec.ts` (assessment block) |
| A result does not create newsletter consent | `acceptance-v1.spec.ts` (assessment block) |
| Sensitive free text is excluded from AI | `scenario-6-sensitive-ai.spec.ts` |
| Same person cannot take a second seat; claim window expires; confirmed seat protected | `scenario-4-seat-claim.spec.ts` |
| Export works; deletion propagates; consent history kept; suppression survives an import | `scenario-7-deletion.spec.ts`, `ops-exports.spec.ts`, `crm.spec.ts`, `acceptance-v1.spec.ts` (GDPR block) |
| R2: registration is not attendance; watch time captured; replay activity and polls stored apart from live | `scenario-5-replay-separation.spec.ts`, `webinar-watch.spec.ts`, `acceptance-r2-webinar.spec.ts` |
| R2: lead and customer rules; a waiting lead who buys is reclassified without losing a confirmed seat | `scenario-3-lead-access.spec.ts`, `acceptance-r2.spec.ts` |

5. **Unit and integration.** `pnpm test` green with coverage above 90 % for `packages/core/src/commerce/pricing*`, `packages/core/src/credits/`, `packages/core/src/automation/` and `packages/core/src/booking/waitlist*` (`vitest run --coverage` thresholds in those packages' configs); every module has `privacy.test.ts`, `permissions.test.ts`, `jobs.test.ts`; `registries.test.ts`, `gdpr-coverage.test.ts`, `i18n-parity.test.ts` green.
6. **Coverage matrix complete.** Every row of `docs/plan/05-coverage.md` has a package, a test id and the status `green`, except rows marked "Later" in the proposal, which say `documented, not built`.
7. **Nothing open.** `docs/build/seam-issues-v1.md` and `-r2.md` have no open item; every file in `docs/build/dependency-requests/` is in `done/`; every `Requests:` line in the wave log is marked served or turned into a merged fix package.
8. **Documentation.** `docs/handbook/` (platform-P11a, with `data-model.generated.md` current), `docs/runbooks/` (restore, access, rotate keys, dead jobs, failed sync, add a role, email DNS, automations, go-live), training material and load-test results (platform-P11b), and section 7.2 of this file copied into `docs/runbooks/go-live-credentials.md` by the orchestrator.
9. **Hygiene.** `pnpm audit --audit-level high --prod` green; gitleaks clean; no `TODO` without a package id (`git grep -n "TODO" -- ':!docs'` lists only `TODO(<package-id>)` lines that belong to "Later" items); `neondb` was never connected (no log line, no migration on it).
10. **Demo ready.** A staff member signs in on `pnpm dev` with `owner@demo.beam.be`, the password and a TOTP; the dashboard, a customer 360 page, the schedule, the shop, the finance list, a campaign report, an automation log and (flags on) a webinar report show the demo data of section 6 in all three languages.

### 7.2 What needs real credentials and a human

Code never changes for these. Each is a key in the environment (section 1.4), a redeploy, a check on `/admin/system` (the provider tile turns from "fake" to "connected"), one test transaction, and a day of watching `integration_calls`. BEAM owns every account (proposal section 10); Sidestream gets team access.

| # | What | When | Steps (BEAM unless noted) | Result to store |
| --- | --- | --- | --- | --- |
| 1 | **Vercel project** | week 2 | Sidestream creates a Vercel team in BEAM's name (Pro plan), imports the GitHub repository after it moves to BEAM's organisation, sets root directory `apps/web`, framework Next.js, build command `pnpm --filter @beam/web build` from the repo root, install `pnpm install --frozen-lockfile`, function region `fra1` (also in `vercel.json`), Node 22. Create environments `preview`, `staging` (Git branch `staging`) and `production` (Git branch `main`), each with its env group of section 1.4. Add the Vercel Cron from `vercel.json` (automatic) and set `CRON_SECRET`. Create a token for GitHub Actions. | `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` as GitHub secrets |
| 2 | **Neon branches and API key** | week 2 (key), week 7 (staging) | In the Neon console of project `lingering-waterfall-91843473`: create an API key (Account settings, API keys) for `preview-branch.yml`; in week 7 create branch `staging` from `production` (never suspended) with database `neondb`; at go-live run `pnpm db:migrate` once against `neondb` with `DATABASE_URL_UNPOOLED` from `PRODUCTION_DATABASE_URL_UNPOOLED`, then `pnpm db:seed --profile defaults`. | `NEON_API_KEY` (GitHub), staging and production URLs (Vercel env groups) |
| 3 | **DNS for `beam.be`** | week 2 | At BEAM's DNS host: add the Resend records for `mail.beam.be` and `news.beam.be` (SPF `include:amazonses.com` on the `send.` subdomains, the three DKIM CNAMEs Resend shows, MX for the return path), DMARC `_dmarc.beam.be` `v=DMARC1; p=quarantine; rua=mailto:dmarc@beam.be` (moved to `p=reject` after 4 clean weeks), the inbound MX for `in.beam.be` (R3 inbox), and at go-live the `www` CNAME to `cname.vercel-dns.com` plus the apex A record Vercel shows. `docs/runbooks/email-dns.md` (email module) lists the exact values once Resend shows them. | records live; Resend shows "verified" |
| 4 | **Resend** | week 2 | Create the account in the EU region; add domains `mail.beam.be` and `news.beam.be`; create an API key with sending access; add a webhook to `https://<env host>/api/webhooks/resend` for `email.sent, delivered, delivery_delayed, bounced, complained, opened, clicked` and copy its signing secret. Staging and production get separate keys. | `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`; `settings.email_config.resend_domain_ids` through `/admin/settings/email_config` |
| 5 | **Mollie** | week 3 (test), week 8 (live) | Create or use BEAM's Mollie account, complete onboarding (KBO number, IBAN, identity), enable Bancontact, cards and SEPA direct debit (for membership mandates), order the payment terminal if wanted. Developers → API keys: copy the test key for staging and the live key for production. The webhook URL is passed per payment by the code (`/api/webhooks/mollie`), so nothing is configured in Mollie for webhooks. For the terminal, note its terminal id in `settings.commerce`. | `MOLLIE_API_KEY` (test `test_...` in staging, live `live_...` in production) |
| 6 | **Billit** | week 3 (sandbox), week 8 (live) | Request a Billit sandbox from Billit support; in the sandbox and later in the live account create an API key (Settings → API) and read the party id of BEAM's company. Confirm the Peppol registration of BEAM in Billit. | `BILLIT_API_KEY`, `BILLIT_BASE_URL`, `BILLIT_PARTY_ID` |
| 7 | **Sentry (EU)** | week 2 | Create an organisation in the EU region (`de.sentry.io`), project `beam-web` (Next.js); copy the DSN; create an auth token with `project:releases` for source maps. | `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_AUTH_TOKEN` |
| 8 | **Slack** | week 2 | In BEAM's workspace create channel `#beam-alerts`, add an app with an incoming webhook to that channel. | `SLACK_WEBHOOK_URL` |
| 9 | **Better Stack** | week 6 | Create an EU account; add an uptime monitor on `https://www.beam.be/api/health` (every minute, phone call to the on-call founder), a monitor on `GET /nl/f/contact` (CSP go-live probe), and a heartbeat (expected every minute, grace 3 minutes); create an API token for the monthly SLA. | `BETTERSTACK_HEARTBEAT_URL`, `BETTERSTACK_API_TOKEN`, `BETTERSTACK_MONITOR_ID` |
| 10 | **YouTube and Google Meet** (R2) | week 9 | In a Google Cloud project owned by BEAM enable YouTube Data API v3 and Google Meet API; configure the OAuth consent screen (internal if BEAM uses Google Workspace); create an OAuth client (web); with BEAM's YouTube channel owner, run the one-time consent with scopes `youtube` and `meetings.space.created` (the webinar runbook gives the exact helper command) and store the refresh token. The channel must have live streaming enabled (24-hour activation wait). | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REFRESH_TOKEN` |
| 11 | **Meta** (R3) | week 11 | In Meta Business Manager: give a system user read access to the ad accounts, create a token with `ads_read`; for the inbox, create a Meta app with Messenger and Instagram messaging, subscribe the BEAM page, set the webhook to `/api/webhooks/meta` with a verify token, and copy the app secret. List the ad account ids in `settings.ads.meta_account_ids`. | `META_ADS_TOKEN`, `META_APP_SECRET`, `META_VERIFY_TOKEN` |
| 12 | **Google Ads** (R3) | week 11 | In BEAM's Google Ads manager account: apply for an API developer token (basic access), create read-only OAuth credentials for the reporting user, and list the customer ids in `settings.ads.google_customer_ids`. | `GOOGLE_ADS_TOKEN` (plus the OAuth values the ads runbook names) |
| 13 | **Anthropic** (R4) | week 13 | Create an organisation in BEAM's name at console.anthropic.com, add billing, create an API key for production (and one for staging with a low spend limit), set the monthly limit to match `settings.ai.monthly_budget_cents`. Confirm the zero-retention or default-retention terms BEAM accepts in the DPIA (ops). | `ANTHROPIC_API_KEY` |
| 14 | **Backups** (go-live) | week 8 | Create a Scaleway Object Storage bucket in `fr-par` in BEAM's name with an access key for uploads only; generate an `age` key pair (`age-keygen`), keep the private key offline with BEAM and Sidestream, put the public key in GitHub. | `BACKUP_AGE_PUBLIC_KEY`, Scaleway keys (GitHub secrets) |
| 15 | **GitHub** | week 6 | Create BEAM's GitHub organisation, transfer the repository, add Sidestream as members, set branch protection on `main` and `staging` (CI required), add the secrets of rows 1, 2, 7 and 14, update `.github/CODEOWNERS` with the real reviewers (an orchestrator PR, frozen file). | repository under BEAM's organisation |
| 16 | **Production keys check** | week 8 | After all keys are set in production: `/api/health` returns 200 with `config` green (no fake flag, no `EMAIL_SINK`, a `live_` Mollie key, `SENSITIVE_DATA_KEY_V1` present, `sslmode=require`); one real booking and one real invoice end to end; the go-live gate on `/admin/system` complete. | go-live sign-off |

Until these exist, nothing waits on them: the whole platform runs in fake-provider mode (section 1.5) and every acceptance test above is proven there.
