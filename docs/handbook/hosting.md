# Hosting

This page answers the hosting questions of blueprint 71: provider, region, account ownership,
cost, scaling, backup, monitoring, security, who pays and the exit procedure. The commitments come
from sections 3, 6, 9 and 10 of Sidestream's [proposal](../requirements/proposal.md).

## Providers and region

| Service | What it runs | Region | Plan |
| --- | --- | --- | --- |
| Vercel | The application (website, portal, back-office, API, the one-minute cron) | Functions pinned to `fra1` (Frankfurt), set in `vercel.json` | Pro |
| Neon | The PostgreSQL database, including stored files | `aws-eu-central-1` (Frankfurt) | Launch |
| Resend | Email sending | EU sending region | Pro |
| Mollie | Payments (Stripe or Viva possible) | EU | Pay per transaction, BEAM's own contract |
| Billit | Invoicing and Peppol | Belgium / EU | BEAM's own subscription |
| Scaleway Object Storage | The encrypted daily backup | `fr-par` (Paris) | Pay per use |
| Sentry | Error tracking | EU (`de.sentry.io`) | Free tier, then Team |
| Better Stack | Uptime monitoring and phone alerts | EU | Free tier |
| Slack | Alert channel `#beam-alerts` | BEAM's workspace | BEAM's plan |
| Anthropic | Claude API for AI features | See [ai-connections.md](ai-connections.md) | Pay per use |
| Google (Release 2) | YouTube Live and Meet for webinars | EU / US | BEAM's Google account |

Customer data is stored only in the Neon database in Frankfurt. Vercel processes requests in
Frankfurt but stores no customer data. The full subprocessor list, with locations and transfer
mechanisms, is [docs/runbooks/subprocessors.md](../runbooks/subprocessors.md).

## Account ownership

**Every account is in BEAM's name from day one and is paid directly by BEAM.** Sidestream has
administrator or team access to manage them. The full list, with Sidestream's access level and the
handover steps, is on [ownership-and-exit.md](ownership-and-exit.md).

## Monthly cost model

Running costs are paid directly to the providers, in BEAM's name. Indicative figures for up to
2,000 active clients (proposal section 6, prices checked October 2026; providers bill in US
dollars and can change prices):

| Service | Pricing basis | Estimate per month |
| --- | --- | --- |
| Neon | Launch plan: $0.106 per compute-hour plus $0.35 per GB per month; production never sleeps | $50–100 |
| Vercel | Pro: $20 per developer seat, including $20 of usage | $20–30 |
| Resend | Pro: $20 for 50,000 emails, $35 for 100,000, then $0.90 per extra 1,000 | $20–35 |
| Claude API | Pay per use, capped by `settings.ai.monthly_budget_cents` (default €100) | $30–60 |
| **Total** | | **$120–225 (about €110–205)** |

Small extras: Scaleway backup storage about €1, Sentry and Better Stack on their free tiers (Sentry
Team about $26 if the free tier is outgrown).

Separate from the running costs:

- **Sidestream support and maintenance:** €299 per month excl. VAT, from go-live with real data,
  indexed yearly in January (Belgian health index), 3 months' notice. See [support.md](support.md).
- **Paid directly by BEAM to the provider:** payment fees (Mollie, Stripe or Viva), payment
  terminals, the Billit subscription and API use, optional SMS, Google Workspace if needed for Meet.

The monthly report on `/admin/system/reports` shows the month's AI spend, database size and file
size, so costs can be followed. With more than 2,000 active clients or very heavy use, provider
costs rise with use; Sidestream shows the numbers before anything changes.

## Scaling model

The platform grows with use without a redesign:

| Part | How it scales |
| --- | --- |
| Application | Vercel Fluid compute starts more function instances when traffic rises; nothing to configure |
| Database | Neon autoscaling from 0.25 to 2 compute units; the limit can be raised in the Neon console |
| Connections | The app uses the pooled connection string, so many functions share few database connections |
| Background work | Big jobs are cut into chunks (500 rows); a 50,000-contact campaign takes about 15 minutes of ticks |
| Email | The Resend plan follows the monthly volume; marketing mail ramps up through a warm-up schedule |
| Files | Stored in Postgres. Above 4 GB the daily digest warns; above 5 GB a High alert says it is time to move file bytes to object storage |

Load tests (proposal section 5) check the main paths before go-live; the results are in
`docs/handbook/load-test-results.md`.

## Backup

Neon point-in-time restore (7 days, at most 1 minute of data lost) plus a daily encrypted dump
outside Neon, in Paris, kept 35 days and 12 months. Details on [backup.md](backup.md).

## Monitoring

| What | How | Who is told |
| --- | --- | --- |
| Platform up | Better Stack calls `/api/health` every minute | Slack and a phone call to the on-call founder |
| Tick running | Heartbeat every minute; health fails after 3 minutes | Same |
| Errors | Sentry, alert above 1 % error rate over 5 minutes | Slack |
| Dead jobs, failed automations, failed emails, payment failures, Billit, webhooks, database size | `platform.check_alerts` every 5 minutes and each module's checks | Slack `#beam-alerts`, `/admin/system` |
| Daily overview | `ops.daily_digest` at 08:00 | Slack |
| Monthly | Uptime, incidents, support, backups, AI spend | Monthly report (see [support.md](support.md#monthly-report)) |

BEAM's technical_admin sees the same System pages Sidestream sees (`/admin/system`).

## Security

The main safeguards (blueprint 64, full list with proof in
[docs/runbooks/security-controls.md](../runbooks/security-controls.md)):

- HTTPS everywhere with HSTS; a strict content security policy on every page.
- Staff sign in with a strong password and an authenticator code; accounts lock after 10 failed
  attempts.
- Role-based permissions checked on the server for every change ([roles.md](roles.md)).
- Sensitive fields encrypted separately (AES-256-GCM); the database and backups are encrypted at
  rest.
- An audit log of every staff change and every sensitive read.
- Rate limits on sign-in, forms and the API, plus the Vercel firewall.
- Secrets only in the Vercel environment groups and GitHub secrets, never in the code; gitleaks
  checks every pull request.
- Weekly dependency updates (Renovate) and `pnpm audit` in CI.
- An ethical-hacking test by Sidestream before go-live and every quarter after
  ([docs/runbooks/security-testing.md](../runbooks/security-testing.md)).
- Security incidents are reported to BEAM within 24 hours ([docs/runbooks/incident.md](../runbooks/incident.md)).

## Who pays what

| Cost | Paid by | How |
| --- | --- | --- |
| Vercel, Neon, Resend, Anthropic, Scaleway, Sentry, Better Stack | BEAM | Directly to the provider, BEAM's card |
| Mollie, Stripe or Viva fees, terminals | BEAM | Directly to the provider |
| Billit | BEAM | BEAM's own subscription |
| Support and maintenance | BEAM to Sidestream | €299 per month excl. VAT |
| Sidestream's own tools and time beyond the fee | Sidestream, unless a change proposal is approved | See [support.md](support.md#changes-and-improvements) |

## Exit procedure

Because every account is already in BEAM's name, an exit is mostly removing Sidestream's access and
handing over knowledge. The steps, the account list and the full database export (`pnpm
exit:export`) are on [ownership-and-exit.md](ownership-and-exit.md).
