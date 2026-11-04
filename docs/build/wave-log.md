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
- finance-P1: 16 min (attempt 2 after the restart; the saved work was complete), merged as `7bf2ac1` with migrations `w04` and the custom `0025_w04_finance_guard` (invoice immutability trigger, finance-P1's request); gate `g26` green in 819 s (tests 586 s under load).
- email-P2: merged as `3c1eaef` in batch `g27-batch`.
- crm-P6: merged as `4107cbe` in batch `g27-batch`.
- Batch `g27-batch` (email-P2 crm-P6): merge gate green, peak 5988 MB.
- 02:20 UTC: a second container restart stopped platform-P8 (attempt 2, 47 uncommitted files, saved as `wip` commit `3d8ad7d`) and credits-P4 (nothing written). Agent instructions now require a commit after each finished area. Relaunched platform-P8 (attempt 3), credits-P4, and started site-P2 and forms-P2 from `1b2926a`.
- Done and waiting to land: crm-P3 (38 min), booking-P3a (39 min). fix-w05-schema-1 (33 min) added every deferred FK and check and activated the booking and ops schedules, but its new `orders_terms_chk` breaks 21 tests in five other modules' fixtures (portal orders without a terms version); attempt 2 gets those test files and adds `@beam/db/testing/commerce-factories`.
- crm-P3: 38 min, merged as `517b02d`; gate `g29-crm-P3` (merge) green, peak 4673 MB.
- Batch `g28` (crm-P3, booking-P3a) red in email's template registry test (`define.test.ts`, from email-P2): crm-P3's two templates were not registered (no package owned `templates/crm/index.ts`) and booking-P3a's two templates had no `sample`. crm-P3 then landed alone (`g29`) because the changed-tests gate did not select the registry test, leaving a latent failure; fixer `fix-w05-crm-1` registers crm's templates, booking-P3a attempt 3 adds samples. Plan amended (OD-10); full quick gates now run every three or four landings.
- platform-P8 attempt 3 finished the package (16 min) except one platform-P6 assertion written to fail once P8 implements `reportProblem`; attempt 4 gets that test and the old AdminFrame copy.
- fix-w05-crm-1: 6 min, merged as `fab14fa`; gate `g31-fix-w05-crm-1` (quick) green, peak 5862 MB.
- booking-P3a: merged as `03300f6` in batch `g32-batch`.
- platform-P8: merged as `b0d6020` in batch `g32-batch`.
- Batch `g32-batch` (booking-P3a platform-P8): merge gate green, peak 5934 MB.
- fix-w05-crm-1 (6 min) landed through a full quick gate (`g31`, 509 s): the integration head is fully green again. booking-P3a (attempt 3, samples) and platform-P8 (attempt 4) landed in batch `g32`.
- credits-P4 attempt 1 (37 min) done except two credits-P3 tests that pin stubs credits-P4 implements; CONVENTIONS.md item 11 now forbids such tests. Started credits-P4 attempt 2, fix-w05-schema-1 attempt 2 (every test file and fixture granted, commerce order factories, the mandate FK) and fix-w04-platform-4 (the 27 confirmed review findings plus platform requests) from `7b1c11d`.
- site-P2: 38 min, merged as `e1c68f8`; gate `g33-site-P2` (merge) green, peak 9251 MB.
- site-P2 (38 min) landed (`g33`, 863 s, peak 9.2 GB). createTestDb measured at 4 to 7 s per test file (818 DDL statements) against 1 to 2 s from a PGlite data-directory snapshot: fixer `fix-w05-platform-testdb` adds a snapshot cache (started from `ae984c2`).
- forms-P2: 56 min, merged as `74e15ad`; gate `g34-forms-P2` (merge) green, peak 5289 MB.
- fix-w05-schema-1: 58 min, merged as `2e3c058`, migrations 0026_w04.sql; gate `g35-fix-w05-schema-1` (merge) green, peak 7454 MB.
- forms-P2 (56 min) landed (`g34`). fix-w05-schema-1 attempt 2 (25 min) landed (`g35`, 854 s): every deferred FK and check, booking and ops schedules active, `@beam/db/testing/commerce-factories` (makeOrder, makeOrderLine, makePaidOrder), the mandate FK, and the fixtures of six modules updated. Started finance-P2, commerce-P3, commerce-P2 from `d447ab3`.
- fix-w04-platform-4: merged as `90cbe19` in batch `g37-batch`.
- fix-w05-platform-testdb: merged as `45a8275` in batch `g37-batch`.
- Batch `g37-batch` (fix-w04-platform-4 fix-w05-platform-testdb): merge gate green, peak 6152 MB.
- fix-w04-platform-4 (37 min: all 27 confirmed review findings fixed or decided, plus the portal nav flags, the proxy 410 and the HIBP test flake) and fix-w05-platform-testdb (22 min: snapshot cache; the web suite went from 410 s to 270 s with a warm cache) landed in batch `g37` (288 s). credits-P4's landing `g36` was red: its tests set a random `mandate_id`, now rejected by the new FK; attempt 3 creates real mandates. Plan: OD-11 (ai_requests retention), OD-12 (job rename). Started credits-P4 attempt 3 and email-P3 from `44a337a`.
- commerce-P2: 13 min, merged as `7b3fd68`; gate `g38-commerce-P2` (merge) green, peak 4813 MB.
- commerce-P2 (13 min) landed (`g38`, 93 s with the warm test-db cache). Load average fell to about 5 with four agents, so the limit goes back to six. Started ops-P2 and automation-P2 from `e0b1319`.
- credits-P4: 70 min, merged as `a945df0`; gate `g39-credits-P4` (merge) green, peak 4061 MB.
- credits-P4 attempt 3 (8 min, real mandates in tests) landed (`g39`, 261 s). Started ops-P4 from `a945df0`.
- finance-P2: 28 min, merged as `b8ab7a6`; gate `g40-finance-P2` (merge) green, peak 5989 MB.
- commerce-P3: 40 min, merged as `9aa2a07`; gate `g41-commerce-P3` (merge) green, peak 6726 MB.
- finance-P2 (28 min, `g40`) and commerce-P3 (40 min, `g41`) landed. Started commerce-P4a from `9aa2a07`.
- automation-P2: 36 min, merged as `c1ad2a7`; gate `g42-automation-P2` (merge) green, peak 6892 MB.
- ops-P2 attempt 1 (38 min) done but two ops-P1 facade tests pinned stubs it implemented; attempt 2 (from `107c9bd`) removes every stub pin in that file. A sweep found one more stub pin (Billit client in platform-P3's shared test), granted to finance-P4. automation-P2 (36 min) landed (`g42`).
- email-P3 attempt 1 (48 min) red in `g43`: its tests mock automation's suppression exit, which automation-P2 (merged meanwhile) now reaches by another path; attempt 2 started. ops-P2 attempt 2 red in `g44` only on a platform test flake (`lib/action.test.ts` rate-limit test straddles a clock-minute window under load); fixer `fix-w06-platform-1` freezes the clock there and wires the real Mollie provider. booking-P2 (51 min) done. Started fix-w06-platform-1 and site-P5 from `beb4769`.
- Batch `g45` (ops-P2, booking-P2) red: ops-P2's 4,500-person continuation test timed out (189 s) at load average 20; the one-by-one fallback refused to start because the orchestrator had edited `requests.md` meanwhile (no tracked-file edits during a landing from now on). Done and waiting: ops-P2, booking-P2, ops-P4 (its only failure was the facades stub pin that ops-P2 removed), fix-w06-platform-1 (21 min), email-P3 attempt 2 (36 min), finance-P3 (54 min), commerce-P4a (59 min). New launches wait until these land, to keep the gate's load low.
- fix-w06-platform-1: merged as `574251f` in batch `g46-batch`.
- ops-P2: merged as `f18eca9` in batch `g46-batch`.
- booking-P2: merged as `47d21d9` in batch `g46-batch`.
- ops-P4: merged as `57aa281` in batch `g46-batch`.
- Batch `g46-batch` (fix-w06-platform-1 ops-P2 booking-P2 ops-P4): migrations 0027_w08_views.sql; merge gate green, peak 5285 MB.
- email-P3: merged as `cdb9e13` in batch `g47-batch`.
- finance-P3: merged as `4be1f32` in batch `g47-batch`.
- commerce-P4a: merged as `023b05b` in batch `g47-batch`.
- Batch `g47-batch` (email-P3 finance-P3 commerce-P4a): migrations 0028_w06_views.sql; merge gate green, peak 4663 MB.
- Batch `g46` (fix-w06-platform-1, ops-P2, booking-P2, ops-P4) green in 489 s; batch `g47` (email-P3, finance-P3, commerce-P4a) green in 600 s. booking-P3b attempt 2 (health route test pinned its stub) and site-P5 (36 min) done. 38 of 80 V1 packages merged. Started commerce-P4b, finance-P4 (with the Billit stub test), crm-P4, crm-P5, forms-P3, credits-P5 from `a8d4d68`.
- booking-P3b: 60 min, merged as `8f7dfa5`; gate `g49-booking-P3b` (merge) green, peak 9180 MB.
- site-P5: merged as `f8b2d81` in batch `g51-batch`.
- crm-P5: merged as `c666a80` in batch `g51-batch`.
- crm-P4: merged as `7f6ff93` in batch `g51-batch`.
- credits-P5: merged as `f45d8f5` in batch `g51-batch`.
- finance-P4: merged as `1261e6a` in batch `g51-batch`.
- commerce-P4b: merged as `13ab9d3` in batch `g51-batch`.
- Batch `g51-batch` (site-P5 crm-P5 crm-P4 credits-P5 finance-P4 commerce-P4b): merge gate green, peak 3747 MB.
- OD-14: batches g40 (finance-P2), g42 (automation-P2) and g51 ran no web tests (all-digit short SHA passed to `vitest --changed`). Gate fixed; quick gate `g52-quick` runs every suite on the head to cover them.
- forms-P3: merged as `48a8704` in batch `g55-batch`.
- ops-P3: merged as `42347c3` in batch `g55-batch`.
- booking-P4: merged as `47641e9` in batch `g55-batch`.
- booking-P5: merged as `1a10d6a` in batch `g55-batch`.
- automation-P3: merged as `f70e4e8` in batch `g55-batch`.
- fix-w07-site-1: merged as `a4b1b87` in batch `g55-batch`.
- Batch `g55-batch` (forms-P3 ops-P3 booking-P4 booking-P5 automation-P3 fix-w07-site-1): merge gate green, peak 6550 MB.
- finance-P5: merged as `469306a` in batch `g56-batch`.
- commerce-P5: merged as `405a3c6` in batch `g56-batch`.
- Batch `g56-batch` (finance-P5 commerce-P5): merge gate green, peak 9140 MB.
- ops-P6: merged as `5241fa2` in batch `g59-batch`.
- crm-P7: merged as `37ed911` in batch `g59-batch`.
- credits-P6: merged as `2da54ff` in batch `g59-batch`.
- site-P3: merged as `9f56702` in batch `g59-batch`.
- fix-w07-crm-1: merged as `dd9127d` in batch `g59-batch`.
- fix-w07-booking-1: merged as `c035115` in batch `g59-batch`.
- Batch `g59-batch` (ops-P6 crm-P7 credits-P6 site-P3 fix-w07-crm-1 fix-w07-booking-1): merge gate green, peak 9920 MB.
- email-P4: merged as `81e6589` in batch `g60-batch`.
- finance-P6: merged as `1762755` in batch `g60-batch`.
- booking-P6: merged as `4df7b89` in batch `g60-batch`.
- forms-P4: merged as `2764ed5` in batch `g60-batch`.
- Batch `g60-batch` (email-P4 finance-P6 booking-P6 forms-P4): merge gate green, peak 5400 MB.
- automation-P4: 48 min, merged as `8904915`; gate `g65-automation-P4` (merge) green, peak 6028 MB.
- site-P6: 27 min, merged as `d314bcf`; gate `g66-site-P6` (merge) green, peak 2604 MB.
- fix-w08-booking-2: 8 min, merged as `a7b0b45`; gate `g67-fix-w08-booking-2` (merge) green, peak 2413 MB.
- commerce-P6: merged as `eb0ef6e` in batch `g72-batch`.
- platform-P9: merged as `` in batch `g72-batch`.
- fix-w09-commerce-1: merged as `e8aed3c` in batch `g72-batch`.
- ops-P5: merged as `2e397bd` in batch `g72-batch`.
- webinar-P1: merged as `754228a` in batch `g72-batch`.
- Batch `g72-batch` (commerce-P6 platform-P9 fix-w09-commerce-1 ops-P5 webinar-P1): migrations 0030_w19.sql 0031_w19_views.sql 0032_w19_protect.sql; merge gate green, peak 5156 MB.
- site-P7: 50 min, merged as `84549af`; gate `g73-site-P7` (merge) green, peak 9874 MB.
- fix-w09-credits-review: 23 min, merged as `f48397d`; gate `g76-fix-w09-credits-review` (merge) green, peak 4638 MB.
- fix-w09-forms-review: merged as `3b4ae0e` in batch `g77-batch`.
- fix-w09-booking-review: merged as `3592578` in batch `g77-batch`.
- fix-w09-email-review: merged as `7475b91` in batch `g77-batch`.
- fix-w09-commerce-review: merged as `372e383` in batch `g77-batch`.
- fix-w09-crm-review: merged as `0cd69a7` in batch `g77-batch`.
- fix-w09-finance-review: merged as `859d590` in batch `g77-batch`.
- Batch `g77-batch` (fix-w09-forms-review fix-w09-booking-review fix-w09-email-review fix-w09-commerce-review fix-w09-crm-review fix-w09-finance-review): migrations 0033_w00.sql; merge gate green, peak 5317 MB.
- fix-w09-automation-review: 12 min, merged as `a943df5`; gate `g79-fix-w09-automation-review` (merge) green, peak 4938 MB.
