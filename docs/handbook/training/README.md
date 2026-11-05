# BEAM training guides

These guides prepare BEAM's team for the training sessions in week 7 (blueprint 79). Each guide is
task-based: every section answers one "How do I ..." question with numbered steps. The guides are
written in English and quote the screen labels in **bold Dutch**, exactly as the back office shows
them to staff (the back office follows your own language setting; the screenshots use Dutch). An
English gloss follows a label where it helps the first time it appears.

## Which guides do I follow?

Follow the guides of the role you hold in BEAM (the role is shown on **Medewerkers**, the staff list,
and decides what you see in the menu). The nine roles and their guides:

| Role (label in the back office) | Guides |
| --- | --- |
| reception (**Onthaal**) | [Daily use](daily-use.md), [Booking](booking.md) |
| customer_service (**Klantendienst**) | [Customer management](customer-management.md), [Booking](booking.md) |
| marketing (**Marketing**) | [Campaigns](campaigns.md), [AI tools](ai-tools.md) |
| management (**Management**) | [Reporting](reporting.md) |
| finance (**Financiën**) | [Reporting](reporting.md) |
| owner (**Eigenaar**) | [Administration](administration.md), [Troubleshooting](troubleshooting.md), [Privacy and security](privacy-security.md) |
| technical_admin (**Technisch beheerder**) | [Administration](administration.md), [Troubleshooting](troubleshooting.md), [Privacy and security](privacy-security.md) |
| sales (**Verkoop**) | [Customer management](customer-management.md) |
| external_partner (**Externe partner**) | No guide: a partner only sees its own **Externe partner** page, explained by BEAM when access is given. |

Everyone also reads the first section of [Troubleshooting](troubleshooting.md) ("How do I report a
problem?"), because every role can report a problem from the back office.

## The people of the week-7 sessions

Jonathan, Tinne, George and Tet follow the guides of the role each of them holds on **Medewerkers**.
George is BEAM's technical point of reference: besides his own role's guides he follows
[Administration](administration.md), [Troubleshooting](troubleshooting.md) and
[Privacy and security](privacy-security.md), and walks through the whole handbook (`docs/handbook/`,
starting at its `README.md`).

## The guides

| Guide | Covers (blueprint 79 topic) |
| --- | --- |
| [Daily use](daily-use.md) | The dashboard, the reception desk (check-in and point of sale), tasks |
| [Booking](booking.md) | Sessions, bookings for a customer, cancellations, waitlists, what the customer sees |
| [Customer management](customer-management.md) | Finding, creating and merging persons, notes, consent, the inbox |
| [Campaigns](campaigns.md) | Templates, segments, creating, testing, scheduling and following a campaign |
| [Reporting](reporting.md) | Reports, revenue, the finance dashboard, exports |
| [AI tools](ai-tools.md) | "Vraag het Claude" on website pages, what AI may and may not see, the AI register |
| [Administration](administration.md) | Staff accounts, roles, settings, feature flags, the go-live checklist |
| [Troubleshooting](troubleshooting.md) | Reporting a problem, background jobs, the support register, common situations |
| [Privacy and security](privacy-security.md) | Privacy requests, sensitive data, retention, security page, audit log |

## Practising

Practise on `beam_dev` or staging with the demo data (`pnpm seed:demo`): demo persons use
`@demo.beam.be` addresses, payments go to the fake payment screen and no real email leaves those
environments. Never practise on production data.

## Screenshots

The images in `img/` are captured from `beam_dev` with the demo seed by
`apps/web/scripts/training-screenshots.ts` (Playwright, Dutch UI, 1440 x 900). Until the first capture
the files are plain grey placeholders. To capture or refresh them, with the app running on
`http://localhost:3000` against `beam_dev`:

```bash
pnpm exec tsx apps/web/scripts/training-screenshots.ts                  # every guide
pnpm exec tsx apps/web/scripts/training-screenshots.ts --only booking   # one guide
pnpm exec tsx apps/web/scripts/training-screenshots.ts --placeholders   # grey images for missing shots
```

The script signs in as a demo user of each shot's role, so no password or authenticator is needed;
it refuses to run when `APP_ENV=production`. Commit the new images with the guide change they belong
to.
