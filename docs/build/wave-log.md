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
- platform-P7 done in 32 minutes (185 web tests; 59 Playwright tests listed in 9 files, scenario and acceptance shells as fixme). Merged as `22a00d2`; gate `g07-p7` (merge mode) green in 131 s, gdpr coverage now running.
- Fixer `fix-w03-platform-1`: `packages/db/test/seed-platform.test.ts` must accept module default seeds after platform (request from platform-P7).
- `fix-w03-platform-1` done in 6 minutes; merged as `6207554`; gate `g08-fix1` green. Module default seeds may now register after platform.
- platform-P6 attempt 1 done in 43 minutes (231 web tests). Merging it on top of platform-P7 turned gate `g09-p6` red in one test: P7's seed runner passes `SeedCtx` (`{ db, ctx, now, rand, ids }`) while P6's platform demo seed used its argument as the database. Merge undone with `git reset --keep`; attempt 2 (run `wf_a2faf98e-e02`) merges the integration head into `build/platform-P6` and adopts `SeedCtx`.
- platform-P6 attempt 2 done in 5 minutes (265 web tests); merged as `58d8fd8`; gate `g10-p6` green in 141 s.
- **Wave 3 checkpoint `g11-w3` (e2e mode)**: install, gen, migrations, typecheck, lint, i18n, all tests (101 s), gdpr, production build (129 s), `db:migrate` and `seed:demo` on beam_dev (44 s) green. Playwright: 7 passed (smoke 5, login page accessible, owner signs in with password and TOTP and signs out), 54 skipped (later-wave shells), 1 failed twice: "ten wrong passwords lock the account". The audit log on beam_dev shows the lock works (`auth.locked` at 10); the test's bare `getByRole("alert")` wait passed before each server action finished, so attempts overlapped the counter read and the restore step. A stale `next start` from the Neon setup held port 3100 and was stopped first.
- Fixer `fix-w03-platform-2` makes `platform.spec.ts` wait for the action response; CONVENTIONS.md item 10 now forbids bare alert waits. Wave 4 starts in parallel, because the failure is in the test, not the product.

## Wave 4 (dependency-scheduled from here on)

- 23:35 UTC: started fix-w03-platform-2, credits-P1, commerce-P1, credits-P2, crm-P1, booking-P1 from `9892b11` (6 agents).
- Foundation review (run `wf_ffea3f4a-fbc`): five reviewers (security, runtime, data, spec, tests) over platform-P1 to P7, each finding checked by an adversarial verifier; confirmed findings become platform fixer packages.
- fix-w03-platform-2: 13 min, merged as `5c125ff`; gate `g12-fix-w03-platform-2` (merge) green, peak 2914 MB.
- credits-P2: 14 min, merged as `b3ca117`; gate `g13-credits-P2` (merge) green, peak 3520 MB.
- 23:52 UTC: started email-P1, site-P1 from `7835fd3`. Wave 3 checkpoint now green: `fix-w03-platform-2` ran `platform.spec.ts` 4/4 twice against beam_dev (magic link included).
- credits-P1 attempt 1 done in 18 minutes (102 db tests) but gdpr coverage would fail: its three person-referencing tables were not registered, because credits' `privacy.ts` belonged to credits-P5. Plan amended (OD-9): every module's schema package owns its `privacy.ts`. Attempt 2 (run `wf_bba4be41-aca`) registers the tables. `@beam/db` now exports `./testing/*` and `./seed/*`.
- credits-P1: 23 min, merged as `ea67dfd`, migrations 0003_w04.sql 0004_w04_views.sql 0005_w04_protect.sql; gate `g14-credits-P1` (merge) green, peak 4539 MB.
- 00:06 UTC: started forms-P1 from `ea67dfd`.
- commerce-P1 attempt 1 (35 minutes) turned gate `g15` red at typecheck: it made `order_lines.sku` and `line_no` required while credits-P1's tests insert order lines without them. Undone; attempt 2 (run `wf_c50753e8-3c3`) fixes the two credits test inserts (one-attempt ownership extension) and adds the six persons FKs and privacy registrations (OD-9). CONVENTIONS.md item 6 now covers columns added to contract tables.
- booking-P1: 45 min, merged as `ec59be9`, migrations 0006_w04.sql 0007_w04_views.sql; gate `g16-booking-P1` (merge) green, peak 8433 MB.
- commerce-P1: 52 min, merged as `40fd6ce`, migrations 0008_w04.sql 0009_w04_views.sql; gate `g17-commerce-P1` (merge) green, peak 3073 MB.
- crm-P1: 58 min, merged as `fdf7995`, migrations 0010_w04.sql 0011_w04_views.sql 0012_w04_protect.sql; gate `g20-crm-P1` (merge) green, peak 3351 MB.
- Batch `g18` (forms-P1, crm-P1) red in one forms view test: a cancelled booking inserted without `cancelled_at` violates booking-P1's `bookings_cancelled_ck` (forms-P1 was built before booking-P1 merged). crm-P1 then landed alone (`g20`); forms-P1 attempt 2 fixes its test inserts and adds the companies FK. Three platform tests are known red (`docs/build/known-red.txt`) until `fix-w04-platform-3` lands.
- Started forms-P1 (attempt 2), email-P1 (attempt 2: privacy registration, deferred FK, review finding on `email_messages.rendered_file_id`), credits-P3, crm-P2 from `4ce9b47`.
- site-P1: 42 min, merged as `4219fa2`, migrations 0013_w04.sql 0014_w04_views.sql 0015_w04_protect.sql; gate `g21-site-P1` (merge) green, peak 7167 MB.
- forms-P1: 26 min, merged as `f721080`, migrations 0016_w04.sql 0017_w04_views.sql; gate `g22-forms-P1` (merge) green, peak 4668 MB.
- 01:06 UTC: started fix-w04-platform-3 (frozen platform tests and factories), platform-P8 (admin screens; also the module nav requests) and finance-P1 from `11fffe1`. fix-w04-platform-4 (27 review findings) runs after platform-P8 and the fixer land.
- email-P1: merged as `77efa64` in batch `g23-batch`.
- automation-P1: merged as `ae87a59` in batch `g23-batch`.
- Batch `g23-batch` (email-P1 automation-P1): migrations 0018_w04.sql 0019_w04_views.sql 0020_w04_protect.sql; merge gate green, peak 6616 MB.
- ops-P1: 44 min, merged as `4705b59`, migrations 0021_w04.sql 0022_w04_protect.sql; gate `g24-ops-P1` (merge) green, peak 6764 MB.
- fix-w04-platform-3: merged as `f2e4b0a` in batch `g25-batch`.
- crm-P2: merged as `f935750` in batch `g25-batch`.
- credits-P3: merged as `8be7a14` in batch `g25-batch`.
- Batch `g25-batch` (fix-w04-platform-3 crm-P2 credits-P3): merge gate green, peak 3823 MB.
- 01:34 UTC: started fix-w05-schema-1 (deferred FKs and checks for booking, commerce, ops, site, automation; activates booking and ops schedules) from `9a4438b`.
- 01:35 UTC: the container restarted and stopped all seven running agents (platform-P8, finance-P1, booking-P3a, crm-P3, crm-P6, email-P2, fix-w05-schema-1) before any of them committed. The repository, worktrees, scratchpad and `.env.local` survived. Their uncommitted files were saved as `wip:` commits on their own branches (platform-P8 20 files, finance-P1 30, booking-P3a 11, crm-P6 3, email-P2 3); all seven were relaunched from `4ea719a` at 01:38, the five with saved work continuing from it.
