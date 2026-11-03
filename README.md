# BEAM platform

The custom CRM, operations and AI platform of BEAM Vitality Center (Vibrant Lifestyle Collective BV), built by SideStream.

## What it is

One platform for everything BEAM runs today across SimplyBook, Mailchimp, Typeform and ScoreApp, WebinarGeek, WordPress and part of Lightspeed. Billit stays for invoices and Peppol. It has three audiences in one Next.js 16 app:

- the **public website** at `/nl`, `/fr` and `/en`;
- the **customer portal** at `/<locale>/account` (an installable PWA): book, buy, packages, membership, invoices, preferences;
- the **staff back-office** at `/admin`: customers, bookings, shop and POS, credits, finance, forms, email, automations, dashboards, imports, privacy, system.

It is built from 12 modules: platform, crm, booking, commerce, credits, finance, forms, email, automation, ops, site and webinar. Stack: TypeScript, Next.js 16 on Vercel (Frankfurt), Postgres on Neon with Drizzle ORM, Auth.js, next-intl, Tailwind and shadcn/ui, Resend, Mollie, Billit, Claude. BEAM owns the code, the data and every account.

## Status

- **Proposal:** `docs/requirements/proposal.md` sets the scope and the timeline. V1 in weeks 1 to 6 (MVP in week 3), go-live in week 8, Releases 2 to 4 in weeks 9 to 14.
- **Plan:** complete and validated. Start at `docs/plan/README.md`.
- **Build:** running since 2026-11-03, wave by wave, by AI coding agents. W0-0 and wave 0 (`platform-P1`: tooling, generator, repository rules) are merged. Wave 1 (`platform-P2` to `P4`: database foundation, core, provider fakes, UI kit) is in progress. Live progress: `docs/build/state.json` and `docs/build/wave-log.md`.
- Every provider runs as a fake until BEAM's real keys are set. No production data is used during the build.

## Folder guide

| Folder | What is in it |
| --- | --- |
| `apps/web` | `@beam/web`, the only deployable: the Next.js app with route groups `(site)`, `(portal)` and `(admin)`, API routes (health, cron tick, webhooks, public endpoints), `modules/<m>/` per module, Playwright specs in `e2e/` |
| `packages/db` | `@beam/db`: Drizzle schema per module, views, committed migrations, seed, `createTestDb()` for PGlite tests |
| `packages/core` | `@beam/core`: pure domain logic per module (credits ledger, booking engine, pricing, automation evaluator, consent) and the i18n catalogues |
| `packages/email` | `@beam/email`: react-email templates, the block editor renderer (JSON to MJML to HTML), the Resend client |
| `packages/integrations` | `@beam/integrations`: Mollie, Billit, Resend, YouTube, ads, Anthropic and Slack clients, each with a `fake.ts` |
| `packages/ui` | `@beam/ui`: shared shadcn/ui components and design tokens |
| `packages/config` | `@beam/config`: ESLint (with import boundaries), TypeScript, Tailwind and Prettier presets |
| `docs/requirements` | What BEAM asked for: the blueprint (`beam-blueprint.txt`) and SideStream's proposal (`proposal.md`) |
| `docs/plan` | The build plan: decisions, architecture, data model, build order, build runbook, coverage, module specs and `build-packages.json`. Entry point: `docs/plan/README.md` |
| `docs/build` | Build state, wave log and orchestrator decisions, written by the build orchestrator |
| `docs/runbooks`, `docs/handbook` | Operations runbooks and the staff handbook (filled during the build) |
| `proposal-prep` | Internal pre-proposal work: the blueprint analysis and the first reply to BEAM |
| `scripts/plan`, `scripts/build` | The plan validator and the orchestrator's build scripts |

## Run it locally

You need Node 22 or later and pnpm 10 (`corepack enable` picks the version from `package.json`).

```bash
pnpm install                      # install the workspace
cp .env.example .env.local        # then fill in .env.local (see below)
pnpm db:migrate                   # apply the committed migrations to the database in DATABASE_URL_UNPOOLED
pnpm dev                          # start apps/web on http://localhost:3000
pnpm test                         # Vitest in every workspace
```

Fill in `.env.local` like this:

- `DATABASE_URL` (pooled) and `DATABASE_URL_UNPOOLED` (direct) point at the Neon development database `beam_dev`. Never point them at `neondb` (production).
- Generate the secrets with the commands written next to them in `.env.example` (`AUTH_SECRET`, `CRON_SECRET`, `SENSITIVE_DATA_KEY_V1`, `VOUCHER_CODE_SECRET`, `AUTOMATION_WEBHOOK_SECRET`).
- Keep `INTEGRATIONS=fake` and `EMAIL_SINK` set. Every provider then uses its fake and every email goes to the sink, so nothing needs real credentials.
- `LOCAL_TICK_MS=5000` runs the job tick inside `pnpm dev` every 5 seconds.

Check it works: `GET http://localhost:3000/api/health` returns 200 with a database round trip. Load demo data with `pnpm seed:demo`.

Tests need no database and no network: Vitest builds a fresh in-memory PGlite database per test file. Playwright (`pnpm test:e2e`) runs against `beam_dev`.

**Sandbox driver note.** In the cloud build sandbox and in CI, TCP port 5432 is blocked. Anything that talks to Neon there (dev server, migrations, seed, Playwright) needs the WebSocket driver and the sandbox proxy:

```bash
DATABASE_DRIVER=neon-ws NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt pnpm db:migrate
```

On a laptop and on Vercel, keep the default `DATABASE_DRIVER=pg`. `pnpm test` needs none of this.

Other useful commands: `pnpm typecheck`, `pnpm lint`, `pnpm gen:indexes` (regenerates the git-ignored registries), `pnpm db:generate` (orchestrator only, once per wave), `pnpm db:check-migrations`.

## Next step

Finish the foundation: merge wave 1 (`platform-P2`, `P3`, `P4`), then wave 2 (`platform-P5`: jobs, tick, audit, settings, flags) and wave 3 (`platform-P6` and `P7`: sign-in for both audiences and the cross-module stubs). The wave 3 checkpoint must be green before the 14 module packages of wave 4 start. The orchestrator follows `docs/plan/04-build-session.md`; the order and the gates are in `docs/plan/03-build-order.md`.

## Contacts

- **BEAM:** Jonathan Bossaer (lead), Christophe, Sanne, George (internal technical reference), Tinne, Jonas, Tet.
- **SideStream:** Gaëtan, Achille.
