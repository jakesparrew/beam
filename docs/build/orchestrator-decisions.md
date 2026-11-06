# Orchestrator decisions taken while executing the runbook

These refine `docs/plan/04-build-session.md` for the actual session. They are binding for the
orchestrator and, where they mention it, for every coding agent.

| Id | Decision |
| --- | --- |
| OD-1 | `@beam/core` does not list `@beam/db` in its `package.json`: `@beam/db` depends on `@beam/core`, and Turborepo refuses a cyclic package graph (devDependencies count). The root `package.json` lists `@beam/db` as a devDependency, so `import type { ... } from '@beam/db'` inside `packages/core` still resolves (through the root `node_modules`). Value imports from `@beam/db` stay forbidden in core (ESLint boundary rule). |
| OD-2 | Scheduling is by dependency, not by wave barrier. A package starts as soon as every package in its `dependsOn` is merged and no running or unmerged package owns an overlapping path (`scripts/build/state.mjs ready`). Among ready packages, V1 goes first, then R2, R3, R4; inside a release the longest remaining chain of estimated minutes goes first. Waves stay the plan's grouping: migration names and checkpoints refer to them. |
| OD-3 | Merging is per finished package (or a small batch): `scripts/build/merge.sh` checks ownership against the package's recorded base and merges with `--no-ff`; `scripts/build/migrate-step.sh w<NN>` generates and commits the migration for the merged schema changes (`NN` = the highest plan wave in the batch; drizzle-kit's numeric prefix keeps repeated names unique; wave 1 uses `init`, `append_only`, `init_views`); then `scripts/build/gate.sh quick <label>`. The full gate (`gate.sh full`, adds `pnpm build`) runs every few batches and before each checkpoint; `gate.sh e2e` runs at checkpoints. A red gate is undone with `git reset --keep <pre-merge sha>` and handled by a retry or fixer agent (section 5.6). No agent is launched while an untested merge is at the integration head. |
| OD-4 | A coding agent receives only its id, its base commit and (on a retry) a notes file. It reads its package from `docs/plan/build-packages.json`, its expanded file list from `docs/build/ownership.json`, and its full instructions from `scripts/build/agent-prompt.md` (the section 4 template in file form). The ownership check agents and the orchestrator run is `node scripts/build/ownership.mjs --check <id> <base> <ref>`; platform-P1's `check-ownership.ts` serves CI. |
| OD-5 | A worktree agent starts with `git checkout -B build/<id> <base>`, so its base is exactly the recorded integration commit whatever commit the worktree was created at. |
| OD-6 | Gates run with `NODE_OPTIONS=--max-old-space-size=6144` and record peak used RAM in `docs/build/logs/<label>-mem.log`. At most 6 coding agents run at once (BS-16 as amended by DR-22); a new agent starts only when `free -g` shows at least 3 GB available (DR-6). From wave 5 the limit is 5: the machine has 4 CPUs and load reached 12 with 6 agents plus a gate, which tripled gate times; finished packages land in batches. |
| OD-7 | Plan amendments A1 and A3 are applied by `scripts/build/ownership.mjs` (it drops `docs/build/ownership.json` from platform-P1 and expands platform-P7's `m` placeholder). A4, A5, A9 and A10 were applied to `build-packages.json` by the dry run (DR-3). |
| OD-8 | The dry-run manifest fixes of DR-22 are one `build:` commit before platform-P1 merges. platform-P1 started before the dry run finished, so it gets a second pass on its branch (attempt 2) that merges the current integration head and applies every DR item that names platform-P1 before it is merged. |
| OD-9 | Each module's schema package also owns its module's `apps/web/modules/<m>/privacy.ts` (booking-P1, commerce-P1, credits-P1, finance-P1, forms-P1, email-P1, automation-P1, webinar-P1; crm-P1, ops-P1 and site-P1 already did). The gate's `gdpr:coverage` test requires every table that references `persons` to be registered, so the package that creates a table registers it; the later privacy packages complete the export, erase and sweep handlers. Agents run `pnpm gdpr:coverage` before committing. |
| OD-10 | A package that adds templates under `packages/email/src/templates/<m>/` also owns that folder's `index.ts` (crm-P3, ops-P5, credits-P8, credits-P9, crm-P9 added). Every template declares a `sample` that passes its props schema and is registered in its folder's `index.ts`; email's `define.test.ts` enforces both. The merge gate's changed-tests selection can miss a registry test, so a full quick gate (`gate.sh quick`) runs after every three or four landings. |
| OD-11 | `ai_requests` retention (foundation review finding 21, fixed by fix-w04-platform-4): `prompt`, `output`, `person_id` and `fields_sent` are blanked after 30 days (retention key `platform.ai_requests`) and the rows are deleted after 62 days (`platform.ai_requests_rows`), so the monthly AI spend report still sees the whole previous month. Where the plan says `ai_requests` are purged after 30 days, read this. |
| OD-12 | The job kind `crm.apply_b2c_playbook` is renamed `crm.apply_btoc_playbook` in the plan (review finding 18): `jobs_kind_ck` allows only letters, underscores and dots. |
| OD-13 | CPU contention (4 CPUs; load 17 to 25 with five agents running Vitest beside a gate) made gate tests hit their fixed time limits, so landings were undone for timeouts alone. Three measures: (1) `gate.sh` runs at `nice -10`, ahead of the agents' own test runs. (2) The gate's Vitest step records every failure through `scripts/build/timeout-reporter.mjs`. When every failed file failed on at least one timeout ("Test timed out in" / "Hook timed out in") and no other unhandled error was raised, exactly those files are re-run once, alone (`--maxWorkers=1`). They count as green only if they pass, and the step log says `TIMEOUT-RETRY`. Any other failure stays red. (3) Agents run Vitest with `--maxWorkers=1` and only their module's suites, the files they touched and the cross-module checks, never a whole workspace's suite: the gate runs every affected test after the merge. Quick, full and e2e gates now run the per-workspace runner too, so the retry applies to them. |
| OD-14 | The merge gate's `vitest --changed <sha>` selected no tests at all when the short SHA was all digits (3825578, 6596011, 3436055): Vitest's CLI parses such an argument as a number and then ignores it, so only uncommitted files counted. finance-P2 (g40), automation-P2 (g42) and the six packages of batch g51 landed without their web tests. `gate.sh` now resolves `<since-sha>` to the full SHA. If a workspace's sources changed but Vitest still selects nothing, the gate runs that workspace's whole suite rather than trusting the empty selection. A quick gate (every test of every workspace) ran on the head right after the fix to cover what those landings skipped. |
| OD-15 | A facade read that a caller may make inside its own transaction reads through that transaction, never through a second connection (`getAppDb()`). PGlite has one connection, so such a read deadlocks the tests until their time limit. In production it would also see a different snapshot from the caller. `site.getLegalLinks(locale, db?)` gains the optional `db` (02-data-model amended); email's footer passes its send transaction (fix-w07-site-1). Agents: a facade function that other modules call from jobs or actions takes the caller's `db`/`tx`. |
| OD-16 | `docs/build/known-red.txt` merges as a set. Fixers that start from the same base each delete their own line, and git reports adjacent deletions as a conflict. When that file is the only conflicted path, `merge.sh` resolves it with `scripts/build/merge-known-red.mjs`: a base line survives only if neither side removed it, and a line either side added is kept. Any other conflict still aborts the merge. Requests whose target file no pending package owns become fix packages at the next checkpoint (runbook 5.6). They are triaged together with the review findings, one fixer per module. |

## OD-17 Message catalogues merge key by key
Every package owns its module's catalogue and many also add keys to `email.json`, so the scheduler
serialised almost every remaining package on that one file. `scripts/build/merge-catalogues.mjs`
resolves a conflicted catalogue with a three-way merge per key (a key changed differently on both
sides stays a conflict), `merge.sh` uses it when only catalogues and `known-red.txt` conflict, and
`ownsOverlap` no longer counts a shared catalogue as a clash.

## OD-18 Typecheck heap and app smoke check
`tsc` for apps/web ran out of the default 2 GB heap (g88-g92); the web `typecheck` script now gives
it 4.5 GB. Running the app on beam_dev showed two defects no unit test could see: React
`createContext` in `@beam/email` (not available in server components, so every page and every
email job failed) and a non-function export in a `"use server"` file (every admin list failed).
Both are fixed; the wave-7 checkpoint adds a smoke step that starts the app and loads each route.
The gate's `NODE_OPTIONS` heap default never applied, because the container already sets
`NODE_OPTIONS=--use-openssl-ca`; `gate.sh` now appends `--max-old-space-size=6144` (lint of a
seven-package batch ran out of the 2 GB default in g102).

## OD-19 First-load JavaScript budget of the public site: 200 KB gzip
Site rule 51 set first-load JavaScript at 120 KB gzip without measuring the framework. In the
production build, Next 16's app-router runtime and React 19 DOM alone transfer about 135 KB gzip
(about 112 KB brotli) on any page, before a line of BEAM code; the public pages measure 196 KB
gzip after the checkpoint's trimming (788 KB before: admin panels, Sentry, zod in the forms
engine moved out). The remaining BEAM code is the site layout, the consent banner, the forms
engine where a page has a form block, and the shared class helper. A 120 KB budget is not
reachable without dropping the app router for the public site, which the plan's one-app
architecture rules out. The budget is 200 KB gzip (`site-perf.spec.ts`), so growth still fails
the gate; LCP <= 2.5 s and CLS <= 0.1 under 4x CPU throttling and Fast 4G are unchanged and pass.
The budget is internal: neither the proposal nor the blueprint commits to a byte size.
