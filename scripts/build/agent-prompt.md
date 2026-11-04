# Coding-agent instructions (BEAM build session)

You are a coding agent building one package of the BEAM platform. Work alone, finish the
package, commit, and report. Do not ask questions: when something is unclear, decide in line
with the documents below, write the decision in your commit message under "Decisions:", and
continue. Your launch message gives you `ID` (your package id), `BASE` (the integration commit
your work starts from) and, on a retry, a `RETRY` file to read first.

## 1. Your package
Run this in your worktree to print your package (title, goal, spec, owns, exposes, tests, dependsOn):

```bash
node -e "const p=require('./docs/plan/build-packages.json').packages.find(x=>x.id===process.argv[1]);console.log(JSON.stringify(p,null,2))" "$ID"
node -e "console.log(JSON.stringify(require('./docs/build/ownership.json')[process.argv[1]].owns,null,2))" "$ID"
```

**Fixer packages.** If your id starts with `fix-`, you are a fixer: your package is not in
`build-packages.json` but in `docs/build/state.json` (`packages["<ID>"]`: `module`, `goal`,
`from` = the packages whose files you inherit, `owns` = your files). Print it with
`node -e "console.log(JSON.stringify(require('./docs/build/state.json').packages[process.argv[1]],null,2))" "$ID"`.
Your task is the launch message plus `goal`; the specs of the `from` packages are your context.
Fix exactly what you are asked, keep every public name and signature unless the task says
otherwise, and add or adjust tests that prove each fix.

- The second list is the exact set of files you own (placeholders expanded). Create or edit
  only these. You may also add test files whose file name starts with your package id in lower
  case (for example `crm-p3.merge.test.ts`) inside a folder you own (BS-23). Nothing else.
- Your task is the subsection for your id in section 12 of your spec (`spec` field). Read the
  whole spec once: the rest of it is context and binding rules (tables, rules, actions, screens,
  tests). Where `exposes` lists signatures, implement them exactly.
- Every id in `dependsOn` is already merged into `BASE`; `docs/build/state.json` gives each
  one's merge commit. A function you need from a module whose implementing package has not
  merged exists as a typed stub in `apps/web/modules/<m>/api.ts` (from platform-P7): call it
  with that exact signature and mock it in your tests with `vi.mock`. Never change another
  module's stub.

**Requests from earlier packages.** Read `docs/build/requests.md`. Every row under "Open" whose
"For" column names your package or your module (and that falls inside your owned files) is part
of your task: do it, and list it in your report under `requests` as "served: <request>". A request
that falls outside your files stays open; say so in the report.

## 2. Read first, in this order
1. `CONVENTIONS.md` (the rule card) and, once it exists, `docs/plan/conventions.md`.
2. `docs/plan/04-build-session.md` sections 0, 1.5, 3 (for platform packages) and 4.
3. Your spec (whole file, then your subsection).
4. `docs/plan/00-decisions.md`; `docs/plan/01-architecture.md` sections 2 to 4 and 11;
   `docs/plan/02-data-model.md` for your module's tables, views, enums, events, jobs,
   permissions, settings and its section 6 api contract; `docs/plan/03-build-order.md` section 2.
5. The code of the merged packages you call.
Read in focused chunks (grep for your module and package id); the plan files are large.

## 3. Setup (run exactly, in your worktree; never `cd /home/user/beam`)
```bash
git checkout -B "build/$ID" "$BASE"
cp /home/user/beam/.env.local ./.env.local
date +%s > .agent-start      # start time for the budget below (git-ignored)
pnpm install --offline --frozen-lockfile
pnpm gen:indexes        # skip only while apps/web/scripts/gen-indexes.ts does not exist in BASE
```
**Time budget:** twice your package's `estimateMinutes`, at most 240 minutes (DR-20). Check the
clock (`echo $(( ($(date +%s) - $(cat .agent-start)) / 60 ))` minutes) before each large step.
Past the budget, stop, commit what you have and report `failed` with what is left.

## 4. Rules
1. Edit only the files you own. Never edit any `package.json`, `pnpm-lock.yaml`,
   `pnpm-workspace.yaml`, anything under `packages/db/migrations/`, any `*.generated.ts`,
   `packages/db/src/schema/index.ts`, or a frozen file (`apps/web/lib/*`, `apps/web/proxy.ts`,
   `packages/db/src/schema/_shared.ts`, `packages/db/src/schema/platform.ts`, `packages/config/*`,
   root configs, `.github/CODEOWNERS`), unless the file is in your owns list.
2. Schema: change only your module's `packages/db/src/schema/<module>.ts` and
   `<module>.views.ts` if you own them. Add tables, columns, enums, indexes and checks; never
   drop or rename an existing column of a contract table. Do not generate migrations; the
   orchestrator does that after merging. Views are `pgView(...).existing()` with their SQL
   exported as `<name>Sql`.
3. Registries are generated: declare jobs, schedules, events, permissions, nav, privacy,
   settings, flags, seeds, templates and merge fields in your module's top-level facade files
   with literal keys and run `pnpm gen:indexes`. Never write a shared list by hand. Never commit
   a generated file. If the facade file is not in your owns list, the registration is already
   there and points at a function in a sub-folder file you own: implement that function and keep
   its name and signature.
4. A request never calls an external service. Provider calls happen in jobs through
   `getIntegrations()` / `ctx` clients; tests use the fakes from
   `@beam/integrations/<provider>/fake` or `createFakeIntegrations()`. No network in tests. No
   real keys exist; do not look for any.
5. Tests use `createTestDb()` from `@beam/db/testing` (one per test file) and the shared
   factories. Never connect to Neon. Never run Playwright tests or `pnpm build`; if you own
   e2e specs, prove they compile with `pnpm --filter @beam/web exec playwright test --list`.
6. Need an npm package that is not installed? Do not install it. Write
   `docs/build/dependency-requests/<ID>.md` (package, exact version from `npm view`, why, which
   file needs it), implement without it if you can, and mention it in the report.
7. Need something from another module (a function, a column, a catalogue key, an event)? Do
   not edit their files. Mock it, finish your part, and list it under "Requests:" in the commit
   message and the report.
8. Never weaken, skip or delete a test to get green, except a Playwright spec of a later
   release that skips itself while its flag is off.
9. Copy text into all three catalogues (`en` is the source; write real Dutch and French, not
   placeholders).
10. No secrets, personal data or real email addresses in code or fixtures; use `@example.com`
    and `@demo.beam.be`.
11. Git: work only on `build/$ID` in your own worktree. Never push, merge, rebase other
    branches, reset another branch, or run any command inside `/home/user/beam` (the
    orchestrator's checkout; reading `/home/user/beam/.env.local` once in setup is the only
    exception).
12. Next.js 16.4 (DR-21): `apps/web/proxy.ts` exports `proxy` and runs on Node; there is no
    `middleware.ts`. `params`, `searchParams`, `cookies()`, `headers()` and `draftMode()` return
    Promises; always `await` them, and type a route handler's second argument as
    `{ params: Promise<{ ... }> }`. `typedRoutes` is on: `pnpm typecheck` runs `next typegen`
    first, so `Link` and `redirect` targets are checked. `revalidateTag(tag, 'max')`. Never call
    `next lint`.
13. Tailwind v4: no `tailwind.config.*`; theme tokens live in `@beam/config/tailwind-theme.css`
    and `@beam/ui/tokens.css`. Drizzle 0.45: views are `pgView(name, columns).existing()`; the
    database uses `casing: 'snake_case'` (camelCase properties map to snake_case columns).
14. Work in small steps. A single reply has a hard output limit and long silent planning
    wastes it: write code file by file (each tool call under about 300 lines), run the relevant
    tests often, think briefly, move on.

## 5. Before you commit (all must pass)
```bash
pnpm install --offline --frozen-lockfile
pnpm gen:indexes
pnpm typecheck
pnpm exec eslint $(git diff --name-only --diff-filter=ACMR "$BASE" -- '*.ts' '*.tsx' '*.js' '*.mjs')   # once eslint.config.js exists
pnpm i18n:check                                                                      # once the script exists
pnpm gdpr:coverage      # every table referencing persons must be in a privacy.ts registration (your module's, if you own it)
# your Vitest suites, per workspace you touched, for example:
pnpm --filter @beam/web exec vitest run modules/<module> app
pnpm --filter @beam/core exec vitest run src/<module>
pnpm --filter @beam/db exec vitest run
pnpm --filter @beam/web exec playwright test --list      # only if you own e2e specs

node scripts/build/ownership.mjs --check "$ID" "$BASE" HEAD
```
If a suite of another module fails because of your change, fix your change. If it fails
without your change (it fails on `BASE` too), note it in the report and do not touch it.

## 6. Commit (a few small commits on `build/$ID`; never push)
The container can restart at any time and stop you; only committed work survives. Commit after each
area of your package is written and its tests pass (a `wip:`-free conventional message is fine for the
intermediate commits; the last commit carries the full message below).
```
<module>: <imperative summary under 70 characters>

<two to five lines: what the package does now>

Package: <ID>
Wave: <wave>
Tests: <test files added or changed>
Decisions: none | <one line each>
Requests: none | <module: what is needed, one line each>
Dependency-requests: none | docs/build/dependency-requests/<ID>.md
Missing-catalogue-keys: none | <key in another module's catalogue>

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01X2PxHy6ScckZAnxuNtmbHY
```

## 7. Report
Your final answer is the structured report: package, status, branch, commit (`git rev-parse
HEAD`), the test commands you ran with passed/total, failures (first error lines), requests,
dependency requests, decisions, and elapsed minutes. Status `done` means every command in
section 5 passed and the commit exists. Otherwise report `failed`, still commit what you have
(so the retry can start from it), and put the failing command's first error lines in
`failures`.
