# Build wave log

One entry per merge batch and gate (runbook section 5.7, adapted by OD-3).

## W0-0 (orchestrator), 2026-11-03 20:05-20:20 UTC

- Workspace manifests for `@beam/config`, `@beam/core`, `@beam/email`, `@beam/integrations`, `@beam/ui`; `@beam/db` and `@beam/web` extended (section 2.3). `@beam/core` does not list `@beam/db` (OD-1).
- Catalog of 98 exact versions in `pnpm-workspace.yaml`; `pnpm install` resolved 1,292 packages in 15 s; `pnpm install --frozen-lockfile --offline` in 2.5 s. All Next.js plugins (`next-auth`, `next-intl`, `@sentry/nextjs`, `@serwist/next`) link the app's `next` instance.
- Playwright 1.64.1 with Chromium Headless Shell revision 1248 installed into `/opt/pw-browsers` (BS-14 primary path).
- Root files: `.gitignore` (generated registries, test output, worktrees, gate logs), `.env.example`, `.gitleaks.toml`, `.github/CODEOWNERS`, `CONVENTIONS.md`, `docs/build/README.md`; `packages/db/src/schema/index.ts` untracked (generated from now on).
- Build scripts: `scripts/build/{lib.mjs, ownership.mjs, state.mjs, gate.sh, merge.sh, migrate-step.sh, agent-prompt.md}`; `docs/build/ownership.json` (122 packages) and `docs/build/state.json`.
- Generated secrets appended to `.env.local` (not printed).
- Verified: `@beam/db` tests 4/4, `@beam/web` and `@beam/db` typecheck, `db:check-migrations` in sync.
- Pull request: none possible, because `claude/focused-hopper-gpky3y` is the remote's only and default branch.

## Wave 0: platform-P1

- Started 20:17 UTC from `8272547` (run `wf_ef390e00-e9b`), before the runbook dry run finished; the dry-run items for P1 (DR-1, DR-5, DR-6, DR-9, DR-12, DR-16 to DR-19, DR-21) are applied in a second pass on its branch before it merges.
- Attempt 2 from `ad67676` (run `wf_fd8d3f52-ea1`): done in 26 minutes, all checks green (typecheck, lint, 24 tests, both ownership checks). Merged as `d68eeed`; root `tsconfig.base.json` now extends `packages/config/tsconfig.base.json`.
- Gate `g01-p1` (quick): green in 58 s, peak used RAM 2.6 GB. The production-database guard was fixed to match the database name `/neondb`, not the role `neondb_owner`.

## Wave 1: platform-P2, P3, P4

- Started 20:56 UTC in parallel from `f14e1fc` (runs `wf_e1f35b9a-c3a`, `wf_d92d475c-cb4`, `wf_dec6bb2d-7af`).
- platform-P4 done in 20 minutes (84 UI tests). Merged as `ba5c0bc`; gate `g02-p4` (merge mode) green in 40 s, peak 1.8 GB.
- Plan: validation passed (123 packages after the coverage pass added platform-P14), coverage matrix `docs/plan/05-coverage.md` written, four ownership gaps fixed (booking-P6 portal routes, ops-P8 report routes, booking api folder, automation engine step file), plan README and repository README written. A scan of every owns list for misplaced paths found nothing else.
- platform-P2 done in 29 minutes (53 db tests). Merged as `2e1033d`. Migrations `0000_init` (36 tables, 56 enums), `0001_append_only`, `0002_init_views` (4 views); `db:check-migrations`, `db:views --check`, `db:append-only --check` and `test:migrations` green. Gate `g03-p2` (merge mode) green in 72 s, peak 2.6 GB. Applied to `beam_dev` over neon-ws: 36 tables, 4 views, 10 append-only triggers, 3 migrations recorded.
- Requests carried forward: platform-P7 calls `seedDefaults(db, { permissions: PERMISSIONS })` in `seed-demo.ts`; each module adds the foreign keys noted in the contract-table stub comments when it creates the referenced tables.
- platform-P3 done in 33 minutes (163 tests across core, integrations, email). Merged as `e9d6e15`; gate `g04-p3` (merge mode) green in 51 s. Wave 1 quick gate `g05-w1` (all lint and tests) green in 74 s, peak 2.4 GB.
- Requests carried forward: crm uses AI feature key `ai.draft_reply` (not `inbox_draft`) and needs a decision on `thread_messages`/`knowledge_articles` fields before R3; email uses `ai.draft_email`; platform-P5's job runner uses `isPermanentFailure()` from `@beam/integrations/_shared`.
- A push hung on a stalled GitHub connection; `scripts/build/push.sh` now pushes with a 90 s timeout per attempt and backoff.

## Wave 2: platform-P5
- Started 21:37 UTC from `13e0d1d` (run `wf_51c79ed8-285`).
- platform-P5 done in 45 minutes (152 web tests). Dependency request: `drizzle-orm` added to `apps/web` (one shared instance in the lockfile), and `lib/ctx.ts` switched to import it directly (frozen-file change, one line). Merged as `fbb76c1`.
- Full gate `g06-w2` green in 217 s: lint 37 s, tests 74 s, production build 64 s, peak used RAM 4.0 GB.

## Wave 3: platform-P6, P7
- Started 22:28 UTC in parallel from `19dbd95` (runs `wf_31aa1b94-155`, `wf_f1e7d0b9-38b`).
