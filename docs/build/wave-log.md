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
