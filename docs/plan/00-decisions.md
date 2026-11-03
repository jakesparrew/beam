# Fixed decisions for the BEAM platform build

These decisions are made. Every spec, package and line of code follows them. Where a spec needs a choice that is not listed here, the spec makes the choice and records it; nothing is left "to be decided".

## Who builds it, and how

- Sidestream (Gaetan, Achile, one freelance developer) builds the platform with AI agents working in parallel. The build starts with a single overnight session that scaffolds the whole V1 and continues in weekly sprints.
- Timeline from the proposal: MVP in week 3, working V1 in week 6, go-live with real data in week 8, Releases 2–4 in weeks 9–14.
- BEAM owns the code (transferred to a BEAM-owned GitHub organisation), the data and every service account.

## Stack

| Concern | Decision |
| --- | --- |
| Language | TypeScript everywhere, strict mode |
| Framework | Next.js 15 (App Router, React Server Components, Server Actions, Route Handlers) |
| Repo | pnpm workspace monorepo managed with Turborepo: `apps/*` and `packages/*` |
| Hosting | Vercel, Pro plan, functions pinned to `fra1` (Frankfurt). Vercel Cron for scheduled jobs |
| Database | PostgreSQL on Neon, region Frankfurt, one production project with branches for staging and preview; Drizzle ORM with SQL migrations committed in the repo |
| Jobs and queues | A Postgres-backed job table (`jobs`) processed by a Vercel Cron route every minute, plus event-driven triggers from server actions and webhooks. No external queue service in V1 |
| Email delivery | Resend (EU sending region), domains owned by BEAM: `mail.beam.be` transactional, `news.beam.be` marketing. Templates with `react-email`; marketing editor is block-based (JSON document → MJML → HTML) built in-house |
| Payments | Provider abstraction `PaymentProvider` with Mollie as the first adapter (Bancontact, cards, recurring mandates, payment links, terminal). Stripe and Viva adapters follow the same interface |
| Invoicing | Native invoices and credit notes in the platform; synced to Billit through its REST API. Billit remains the Peppol access point |
| Webinars | Video via YouTube Live (unlisted streams) embedded in the platform; registration, chat, polls, CTAs and watch-time tracking are native |
| AI | Anthropic Claude API through the official SDK. `claude-opus-5-5` for drafting and analysis, `claude-haiku-5-5` for classification and cheap tasks. No training on BEAM data; sensitive fields are excluded at the data layer |
| Auth | Two audiences: staff (email + password + TOTP MFA, role-based) and customers (passwordless magic link + optional password). Sessions in Postgres. Implemented with Auth.js v5 (next-auth) with the Drizzle adapter |
| i18n | `next-intl`. Three locales: `nl-BE`, `fr-BE`, `en`. Every user-facing string, email and form lives in a message catalogue; a missing translation blocks sending and falls back to showing the key in the admin UI |
| UI | Tailwind CSS v4 + shadcn/ui components; one shared `packages/ui` used by portal, website and back-office |
| Validation | Zod schemas shared between server actions, forms and API routes |
| Testing | Vitest for unit and integration (against a Neon branch), Playwright for end-to-end on the critical flows |
| Observability | Sentry (EU region) for errors, Vercel Analytics and logs, Better Stack for uptime; alerts to a shared Slack channel |
| Timezone | All times stored in UTC; business logic uses `Europe/Brussels` |
| Money | Integer cents in `EUR`; VAT per line; prices snapshotted on every transaction |

## Application layout

- `apps/web`: one Next.js app with three route groups: `(site)` public website, `(portal)` customer portal (installable PWA), `(admin)` staff back-office. One app keeps auth, i18n and deployment simple; route groups and middleware separate the audiences.
- `packages/db`: Drizzle schema, migrations, seed and query helpers.
- `packages/core`: domain logic (credits ledger, booking engine, pricing, automation engine, consent) with no framework dependency; unit-tested.
- `packages/email`: react-email templates, MJML renderer, Resend client.
- `packages/integrations`: Mollie, Billit, YouTube, Meta/Google Ads, Anthropic clients.
- `packages/ui`: shared components and design tokens.
- `packages/config`: eslint, tsconfig, tailwind presets.

## Architecture principles

1. One central `persons` record. Every module reads and writes it; nothing else stores customer identity.
2. Append-only facts: `activity_events` (timeline), `credit_entries` (ledger), `consent_records`, `audit_log`, `automation_runs`. Balances and statuses are derived, never edited by hand.
3. Versioned definitions: forms, assessments, prices, email templates and terms. History always points to the version that produced it.
4. Rules before AI. Retention lists, package thresholds, waitlists and automations are deterministic.
5. Sensitive fields (health, sleep, stress, recovery) are tagged in the schema, restricted by role, excluded from AI and exports by default.
6. Every outbound side effect (email, payment call, Billit sync, webhook) goes through the `jobs` table with retries and alerts on failure.
7. Config, not code: schedules, capacities, prices, promotions, sequences, roles and dashboards are editable by BEAM staff.
8. No multi-tenancy. The platform is single-tenant and config-driven; a second deployment serves a second client.
9. Feature flags per user let new features ship to test users on production before everyone sees them.
10. Deletion and export are first-class workflows that reach every table and connected service.
