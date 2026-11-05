# Support

How to get help, how fast Sidestream responds, what the monthly fee covers, and how changes are
handled. The commitments are sections 6, 7 and 8 of the [proposal](../requirements/proposal.md);
the platform rules are PL-86 to PL-89a in [platform.md](../plan/modules/platform.md); the
day-to-day handling is in [docs/runbooks/support-sla.md](../runbooks/support-sla.md).

## How to report a problem

| Channel | Use it for | Where it ends up |
| --- | --- | --- |
| **In the app**: user menu → "Report a problem" (or `/admin/support`) | Anything, from any staff account | Stored with the page and request id, posted to Slack, counted in the SLA |
| Shared Slack or WhatsApp group | Day-to-day questions | Sidestream logs it on `/admin/system/support` with the real time received |
| Support email address (`settings.support.support_email`) | Anything; every email is logged | Same |
| **Emergency phone number** (`settings.support.emergency_phone`) | Critical problems only, also at weekends | Same; the in-app form shows the number when you pick "critical" |

You can follow your own requests and their status on `/admin/support`.

## Severities and response times

Support hours are Monday to Friday 09:00–18:00 Brussels time, except Belgian public holidays
(1 January, Easter Monday, 1 May, Ascension Day, Whit Monday, 21 July, 15 August, 1 November,
11 November, 25 December). Critical problems are also covered on Saturday, Sunday and public
holidays from 10:00 to 18:00 through the emergency number. The clock only runs inside support
hours; a request received outside them starts counting at the next opening (PL-88).

| Severity | Examples | First response | Resolution target |
| --- | --- | --- | --- |
| **Critical** | Platform down, booking or payments not working, suspected data breach | Within 2 hours on business days, within 4 hours at weekends and on public holidays | Workaround or fix the same day; work continues until it is solved |
| **High** | A major function is disrupted: emails not sending, Billit sync failing | Within 4 business hours | 24–48 hours |
| **Normal** | A bug with a workaround, a functional question | Within 1 business day | Within a week, usually in the next weekly release |
| **Improvement** | A new idea or an optimisation | Acknowledged within 2 business days | Planned in the weekly sprint |

`response_due_at` is calculated for every request; `/admin/system/support` shows late requests in
red, and `platform.check_alerts` reminds Sidestream in Slack about critical and high requests that
are past their due time without a first response.

A security incident or data breach is always critical. Sidestream informs BEAM **within 24 hours**
of discovering it ([docs/runbooks/incident.md](../runbooks/incident.md)).

## Uptime target

99.5 % per month (PL-89a). This excludes announced maintenance and large outages of the global
cloud providers. A month below target is shown in red on the monthly report and on
`/admin/system`.

## Monthly report

On the 1st of each month at 07:10, `platform.build_monthly_report` prepares a draft report for the
previous month (PL-89):

- uptime and downtime minutes (from Better Stack);
- security incidents by severity;
- support requests per severity: received, resolved, median first response, breaches;
- dead jobs and alerts sent;
- backup runs (OK and failed) and the last restore drill;
- AI spend, database size and file size.

An owner or technical_admin reviews it on `/admin/system/reports`, adds notes and sends it; it goes
by email to `settings.support.report_recipients`. A sent report cannot be changed. Steps:
[docs/runbooks/monthly-report.md](../runbooks/monthly-report.md).

## What the monthly fee includes

The Sidestream fee is **€299 per month excl. VAT**, from go-live with real data, indexed every
January (Belgian health index), cancellable with 3 months' notice (proposal section 6).

| Included | Notes |
| --- | --- |
| Hosting accounts managed in BEAM's name | BEAM pays the providers directly ([hosting.md](hosting.md#monthly-cost-model)) |
| Monitoring and alerts | Better Stack, Sentry, Slack alerts, the System pages |
| Security and software updates | Weekly dependency updates, security fixes at once |
| Sidestream Security | Periodic ethical-hacking tests, security monitoring and reporting (worth €99, included) |
| Bug fixes | Always included |
| Minor updates | Small adjustments up to about half a day of work per request |
| Support | The channels and response times above |
| Account management | Managing the provider accounts for BEAM |

| Not included | How it is charged |
| --- | --- |
| New features and major changes | A change proposal with a fixed price (below) |
| Payment fees (Mollie, Stripe or Viva) | Directly by the provider, per transaction |
| Payment terminals | Bought or rented from the provider |
| Billit subscription and API use | BEAM's own Billit subscription |
| SMS reminders (optional) | Per message, at cost |
| Google Workspace for Meet live streaming | Only if BEAM's plan does not include it |
| Provider running costs | Paid by BEAM directly (Neon, Vercel, Resend, Claude, ...) |

## Changes and improvements

Every request falls into one of four classes (blueprint 75, proposal section 8):

| Class | Example | Cost |
| --- | --- | --- |
| **Bug** | Something that was agreed does not work | Included, always; fixed within 24–48 hours |
| **Minor update** | Texts, fields, settings, layout, an extra filter or email template; up to about half a day | Included; live within a week |
| **New feature or major change** | New functionality, or a substantial change to how a feature works | Change proposal with a fixed price |
| **New release or module** | A new product area, such as a native mobile app | Release proposal with a fixed price and planning |

### How a change proposal works

1. BEAM describes the request in the shared channel or in a meeting.
2. Within 5 business days Sidestream sends a one-page proposal: what will be built, what changes
   for users, the fixed price, the delivery date and any effect on the monthly fee.
3. BEAM approves in writing (an email is enough). The work is planned in the next sprint.
4. Sidestream delivers. BEAM tests against the acceptance points in the proposal; Sidestream
   invoices after acceptance.

Prices are based on Sidestream's day rate. BEAM can also prepay a bundle of days at a reduced rate,
so smaller requests do not each need a proposal.

A change that alters a business rule also updates the matching handbook page
([business-rules.md](business-rules.md)) in the same pull request.

## Team and continuity

BEAM is served by a team of three: the two Sidestream founders (Gaetan and Achile), who build and
maintain the platform, and a freelance developer who can take over support. Holidays are planned
so someone is always reachable for critical problems. The code is standard technology and
documented in this handbook, so another developer can continue if needed
([ownership-and-exit.md](ownership-and-exit.md)).
