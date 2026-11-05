# BEAM platform handbook

This handbook explains how the BEAM platform works, where everything lives and what to do when
something needs attention. It is written for **George**, BEAM's internal technical point of
reference, and for any developer who joins later. You do not need to read the code to follow it.

- **Client:** Vibrant Lifestyle Collective BV (BEAM Vitality Center), Xavier de Cocklaan 70 bus 7,
  9831 Sint-Martens-Latem.
- **Built and supported by:** Sidestream (Ghent).
- **What the platform is:** one web application for the public website, the customer portal and
  the staff back-office. It covers customers (CRM), bookings, the shop and payments, packages and
  memberships, invoices, forms, email, automations, dashboards and, from Release 2, webinars.

## In short

- One Next.js application on Vercel, in Frankfurt (`fra1`).
- One PostgreSQL database on Neon, in Frankfurt (`aws-eu-central-1`).
- Every account (Vercel, Neon, Resend, Mollie, Billit, and so on) is in BEAM's name.
- A web request only writes to the database. Everything that talks to the outside world (email,
  payments, Billit, Slack, AI) runs as a **job**, picked up by a one-minute **tick**.
- Facts are never overwritten. Bookings, payments, credits, consent and the activity timeline are
  added as new rows, so the history is always complete.
- Three languages everywhere: Dutch (`nl-BE`), French (`fr-BE`) and English (`en`). A missing
  translation blocks a send; the platform never shows the wrong language.

### Kort in het Nederlands

Dit handboek legt uit hoe het BEAM-platform werkt. Het platform is één webapplicatie (website,
klantenportaal en back-office) op Vercel, met één PostgreSQL-database bij Neon, allebei in
Frankfurt. Alle accounts staan op naam van BEAM. Een verzoek van een gebruiker schrijft alleen in
de database; alles wat met de buitenwereld praat (e-mail, betalingen, Billit, AI) loopt via taken
die elke minuut worden opgepikt. Begin bij de tabel hieronder.

### En bref, en français

Ce manuel explique le fonctionnement de la plateforme BEAM : une seule application web (site,
portail client et back-office) sur Vercel, avec une seule base PostgreSQL chez Neon, toutes deux à
Francfort. Tous les comptes sont au nom de BEAM. Une requête écrit seulement dans la base ; tout ce
qui parle au monde extérieur (e-mail, paiements, Billit, IA) passe par des tâches traitées chaque
minute. Commencez par le tableau ci-dessous.

## Where to start

Read the pages in this order the first time. Each page is short and links to the deeper material.

| # | Topic (blueprint 80) | Page | What you learn |
| --- | --- | --- | --- |
| 1 | Architecture | [architecture.md](architecture.md) | The twelve modules, the three parts of the site, requests, jobs, the tick and the outbox |
| 2 | Database and data model | [database.md](database.md) and [data-model.generated.md](data-model.generated.md) | The Neon project, branches, connection strings, migrations, restore; every table and column |
| 3 | Integrations | [integrations.md](integrations.md) | Each outside service, which job calls it, what happens when it fails, which secret it needs |
| 4 | User roles | [roles.md](roles.md) | The nine roles, what each may do, how to change it, who sees sensitive data |
| 5 | Business rules | [business-rules.md](business-rules.md) | Cancellation, credits, prices, VAT, waitlist, consent, with the rule numbers of each spec |
| 6 | Automations | [automations.md](automations.md) | How journeys start, wait, skip, stop and pause; the seeded journeys |
| 7 | AI connections | [ai-connections.md](ai-connections.md) | Every AI feature, the data it may see, the budget, the no-training position |
| 8 | Hosting | [hosting.md](hosting.md) | Providers, region, ownership, monthly cost, scaling, monitoring, security |
| 9 | Backup | [backup.md](backup.md) | How often, how long, where, who restores and how fast |
| 10 | Support | [support.md](support.md) | Severities, response times, channels, the monthly report, what the fee covers |
| 11 | Deployment | [deployment.md](deployment.md) | Environments, the release flow, feature flags, rollback |
| 12 | Core workflows | [core-workflows.md](core-workflows.md) | Step by step: booking, purchase to Billit, form to email, unsubscribe, deletion |
| 13 | Ownership and exit | [ownership-and-exit.md](ownership-and-exit.md) | Every account, who owns it, Sidestream's access, how to hand over |

## Other documentation

- **Runbooks** (what to do, step by step): [docs/runbooks/](../runbooks/). The most used ones are
  [restore](../runbooks/restore.md), [dead jobs](../runbooks/dead-jobs.md),
  [failed sync](../runbooks/failed-sync.md), [rollback](../runbooks/rollback.md),
  [access](../runbooks/access.md) and [incident](../runbooks/incident.md).
- **Training guides** for staff (task based, with screenshots) live in `docs/handbook/training/`.
  They map each guide to a BEAM role. George follows the administration, troubleshooting and
  privacy-security guides as well as this handbook.
- **Load test results** are in `docs/handbook/load-test-results.md`.
- **Module specifications** (the full rules, one file per module): [docs/plan/modules/](../plan/modules/).
  When this handbook gives a rule number such as "booking R28", that is where the full text is.
- **Fixed decisions and architecture:** [00-decisions.md](../plan/00-decisions.md),
  [01-architecture.md](../plan/01-architecture.md), [02-data-model.md](../plan/02-data-model.md).
- **Requirements:** the BEAM blueprint (`docs/requirements/beam-blueprint.txt`) and Sidestream's
  proposal ([proposal.md](../requirements/proposal.md)).

## Words used in this handbook

| Word | Meaning |
| --- | --- |
| Module | One business area with its own tables, screens and rules (for example `booking`) |
| Action | A server function that changes data when a staff member or customer clicks something |
| Job | A unit of background work stored in the `jobs` table (send an email, push an invoice) |
| Tick | The call Vercel makes every minute to `/api/cron/tick`; it starts due jobs |
| Outbox | The rule that a request writes rows and jobs in one transaction and never calls a provider itself |
| Event | A fact on a person's timeline (`activity_events`), such as `booking.attended` |
| Append-only | A table whose rows are never changed or deleted; corrections are new rows |
| Flag | A switch that turns a feature on for testers or for everyone without a new deploy |
| Fake | A stand-in for a provider (Mollie, Resend, Billit) used in tests and before the real keys exist |
| Branch (Neon) | A copy of the database that can be created in seconds, used for previews and restores |

## Keeping this handbook true

- A change to a business rule updates the matching page in the same pull request. The pull request
  template has a checkbox for it (PL-91).
- The data model page is generated from the code by `pnpm docs:schema`. CI runs
  `pnpm docs:schema --check`, so that page cannot drift from the database.
- `apps/web/scripts/handbook-links.test.ts` checks that every link and anchor in this folder works,
  that every blueprint 80 topic has its page, and that every runbook named here exists.
