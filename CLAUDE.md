# BEAM platform

BEAM is the operating platform of the BEAM Vitality Center: public website, customer portal and
staff back-office for CRM, bookings, commerce, credits, invoicing, forms, email, automation,
operations dashboards and webinars. One Next.js 16 app (`apps/web`) on Vercel (fra1), Postgres on
Neon through Drizzle ORM, a pnpm + Turborepo monorepo with the packages `db`, `core`, `email`,
`integrations`, `ui` and `config`.

## Commands

```bash
pnpm install --offline --frozen-lockfile   # install (never add dependencies in a package branch)
pnpm gen:indexes                           # regenerate registries and indexes (git-ignored)
pnpm typecheck                             # every workspace (next typegen for apps/web)
pnpm lint                                  # ESLint with the import boundaries
pnpm test                                  # Vitest everywhere (PGlite, provider fakes, no network)
pnpm --filter @beam/web exec vitest run modules/<m>
pnpm --filter @beam/web exec playwright test --list   # specs are listed, never run by agents
pnpm db:check-migrations                   # the schema matches the committed migrations
```

Never run `next lint` (it does not exist in Next 16) or `pnpm build` inside a package branch.

## Read first

1. `CONVENTIONS.md`: the one-page rule card.
2. `docs/plan/conventions.md`: naming, idempotency keys, facade formats, how to add things.
3. `docs/plan/00-decisions.md`, `docs/plan/01-architecture.md`, `docs/plan/02-data-model.md`.
4. `docs/plan/04-build-session.md`: how the build session runs (waves, gates, agent rules).
5. Your module's spec in `docs/plan/modules/<m>.md`.
