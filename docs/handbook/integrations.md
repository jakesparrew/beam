# Integrations

The platform talks to a small number of outside services. This page lists each one: what it is
for, where its code is, which jobs call it, how it reports back, what happens when it fails, and
which secret it needs. Secrets are named here by their environment variable only; the values live
in the Vercel environment groups and never in the code ([docs/runbooks/rotate-keys.md](../runbooks/rotate-keys.md)).

## The same pattern for every provider

1. **One client per provider** in `packages/integrations/src/<provider>/`. The client checks every
   answer with a schema and reports errors as `IntegrationError { provider, retryable }`.
2. **Only jobs call providers.** A web request never does (see
   [architecture.md](architecture.md#the-outbox-rule-a-request-never-calls-a-provider)). If a provider is down,
   the job waits and retries: after 1 minute, 5 minutes, 15 minutes, 1 hour and 6 hours. After the
   last try the job is `dead`, Slack gets one line and the job shows on `/admin/system/jobs`.
3. **Every call is logged** in `integration_calls` (provider, operation, status, duration, no
   personal data). `/admin/system/integrations` shows the log and whether each provider is
   "connected" or running as a "fake".
4. **Webhooks** (messages from a provider to us) are checked for their signature, stored once in
   `webhook_events`, answered within 2 seconds, and processed by the job `webhook.process`. Staff
   with `system.jobs` can replay a stored webhook from `/admin/system/webhooks`.
5. **Fakes.** Every provider has a `fake.ts` with the same interface. Tests always use the fakes.
   Locally and on previews, a provider without a key runs as a fake, and `INTEGRATIONS=fake` forces
   all fakes. On staging and production the real clients are always used, and `/api/health` refuses
   a production configuration that still points at a fake or a test key.

When something does fail, follow [docs/runbooks/failed-sync.md](../runbooks/failed-sync.md) or
[docs/runbooks/dead-jobs.md](../runbooks/dead-jobs.md).

## Overview

| Provider | Used for | Release | Secrets (environment variables) |
| --- | --- | --- | --- |
| [Mollie](#mollie-payments) | Online payments, terminal, memberships (SEPA mandates), payment links, refunds | V1 | `MOLLIE_API_KEY`, `MOLLIE_WEBHOOK_SECRET` |
| [Billit](#billit-invoices-and-peppol) | Accounting and Peppol for invoices and credit notes | V1 | `BILLIT_API_KEY`, `BILLIT_BASE_URL`, `BILLIT_PARTY_ID` |
| [Resend](#resend-email) | All email, transactional and marketing | V1 | `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET` |
| [Slack](#slack-alerts) | Alerts and the daily digest in `#beam-alerts` | V1 | `SLACK_WEBHOOK_URL` |
| [Sentry](#sentry-and-better-stack-monitoring) | Error tracking | V1 | `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_AUTH_TOKEN` |
| [Better Stack](#sentry-and-better-stack-monitoring) | Uptime checks, tick heartbeat, monthly uptime figure | V1 | `BETTERSTACK_HEARTBEAT_URL`, `BETTERSTACK_API_TOKEN`, `BETTERSTACK_MONITOR_ID` |
| [Anthropic (Claude)](#anthropic-claude) | Website page proposals (V1); drafts and analysis later | V1, R3, R4 | `ANTHROPIC_API_KEY` |
| [WordPress](#wordpress-one-time-import) | One-time import of the old website | V1 | none (public site) |
| [Automation webhooks](#automation-webhooks) | A journey step that calls another system | V1 | `AUTOMATION_WEBHOOK_SECRET` |
| [YouTube and Google Meet](#youtube-and-google-meet-release-2) | Webinar streams | R2 | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REFRESH_TOKEN` |
| [Meta and Google Ads](#meta-and-google-ads-release-3) | Ad spend for reporting (read-only), Messenger and Instagram inbox | R3 | `META_ADS_TOKEN`, `GOOGLE_ADS_TOKEN`, `META_APP_SECRET`, `META_PAGE_ACCESS_TOKEN`, `META_VERIFY_TOKEN` |
| [Scaleway](#scaleway-backup-storage) | Storage of the encrypted daily backup | V1 | Scaleway keys in GitHub secrets, `BACKUP_AGE_PUBLIC_KEY` |

## Mollie (payments)

- **Code:** `packages/integrations/src/payments/` (`mollie.ts`; `stripe.ts` and `viva.ts` follow the
  same `PaymentProvider` interface). The provider per sales channel is the setting
  `payment_provider_by_channel`.
- **Calls:** `payments.create` at checkout and `payments.terminal` at the POS run straight away as
  logged inline jobs (the two allowed exceptions). Jobs: `payments.sync`, `payments.refund`,
  `payments.create_link`, `payments.charge_recurring`, `payments.cancel`,
  `payments.cancel_terminal`, `memberships.charge_renewal`, `commerce.revoke_mandate`.
- **Webhook:** `/api/webhooks/mollie`. Mollie only sends a payment id. The platform never trusts
  the message itself: `payments.sync` fetches the payment from Mollie by id, and that fetch is the
  check. A payment status only moves forward, so a repeated or late message changes nothing.
- **When it fails:** the payment stays open; the return page says "payment pending, we will email
  you". `payments.scan_expired` (every minute) expires open payments after 30 minutes. A payment
  pending for more than 15 minutes raises a High alert. No Mollie message for 24 hours while online
  orders were placed also raises a High alert. Three failed membership renewals in a day show on
  the action dashboard.
- **Test mode:** staging uses a `test_` key; production refuses one.

## Billit (invoices and Peppol)

- **Code:** `packages/integrations/src/billit/`.
- **Calls:** jobs `billit.push_customer`, `billit.push_invoice`, `billit.push_credit_note`,
  `billit.push_payment`, `billit.send_peppol`; `billit.sync_pending` every 15 minutes (pulls the
  paid status of bank-transfer invoices); `billit.reconcile` daily at 05:15.
- **How it links:** BEAM numbers its own invoices; the BEAM number is Billit's external reference,
  and `invoices.billit_id` is stored before any second push, so an invoice is never created twice.
- **When it fails:** the invoice shows `billit_status = failed` with a Retry button on the finance
  screen. After 1 hour of failures a High alert goes to Slack. Invoices stay legally valid in BEAM
  without Billit; Billit catches up when it is back.

## Resend (email)

- **Code:** `packages/integrations/src/resend/`; templates in `packages/email/`.
- **Domains:** `mail.beam.be` for transactional mail (receipts, booking confirmations, magic links)
  and `news.beam.be` for marketing. DNS records and warm-up: [docs/runbooks/email-dns.md](../runbooks/email-dns.md).
- **Calls:** `email.send` (fast lane, top priority) for each message; `campaign.plan` and
  `campaign.send_chunk` (bulk lane, 500 recipients per chunk, 100 per Resend batch) for campaigns.
  `email.send` checks the suppression list once more right before sending.
- **Webhook:** `/api/webhooks/resend`, signed (Svix). Events go to `email_events`. A hard bounce or a
  complaint adds a suppression for all mail through `crm.addSuppression`.
- **When it fails:** the message waits and retries. Bounce rate above 2 % on a campaign pauses the
  campaign and alerts marketing; complaints above 0.1 % in 24 hours alert. Messages blocked by a
  missing translation appear in the daily digest.
- **Outside production** `EMAIL_SINK` sends every message to one test mailbox instead of the real
  recipient.

## Slack (alerts)

- **Code:** `packages/integrations/src/slack/`; job `notify.slack`.
- One incoming webhook posts to `#beam-alerts`. Each alert has a fingerprint and is sent at most
  once per hour. The daily digest (`ops.daily_digest`, 08:00) summarises sends, bounces, dead jobs,
  blocked translations, backlog and database size.
- **When it fails:** Sentry stays the fallback channel; the alert is also visible on `/admin/system`.

## Sentry and Better Stack (monitoring)

- **Sentry** (EU region) records server and browser errors, tagged with the request id or job id.
  Names, emails and phone numbers are removed before an error is sent. An error rate above 1 %
  over 5 minutes alerts Slack.
- **Better Stack** checks `/api/health` every minute and calls the on-call founder when it fails
  (database down, tick older than 3 minutes, backlog above 500, wrong production configuration).
  The tick pings a Better Stack heartbeat every minute. `platform.build_monthly_report` reads the
  month's uptime from Better Stack (`packages/integrations/src/betterstack/`).

## Anthropic (Claude)

- **Code:** `packages/integrations/src/anthropic/`; every call goes through `callClaude()` in
  `apps/web/lib/ai.ts`. Importing the Anthropic SDK anywhere else fails lint.
- **Calls:** the job `site.propose_page` in V1; R3 and R4 add inbox drafts, classification, campaign
  drafts, the weekly summary and questions in plain language. The full list, the data each feature
  may see and the budget are on [ai-connections.md](ai-connections.md).
- **When it fails:** AI panels say "unavailable, write it yourself". No business flow depends on AI.

## WordPress (one-time import)

- **Code:** `packages/integrations/src/wordpress/`; jobs `site.fetch_wordpress_media`,
  `site.parse_wordpress`, `site.apply_wordpress`. Used once to bring the old site's pages and media
  into the new site ([docs/runbooks/site-go-live.md](../runbooks/site-go-live.md)).

## Automation webhooks

- **Code:** `packages/integrations/src/webhook/`; job `automation.call_webhook`. A journey step of
  type `webhook` posts a signed JSON message (signed with `AUTOMATION_WEBHOOK_SECRET`) to an address
  marketing configures. No sensitive field is ever included.
- **Environment:** `AUTOMATION_WEBHOOK_SECRET`, one random secret per environment (for example
  `openssl rand -hex 32`); the receiving system checks the `X-Beam-Signature` header (HMAC-SHA256 of
  the body) with it. Outside staging and production a missing secret uses the fake; in staging and
  production the call fails as `webhook_not_configured`. Rotate it like the other
  secrets in [rotate-keys.md](../runbooks/rotate-keys.md#other-secrets) and give the new value to every receiving system.

## YouTube and Google Meet (Release 2)

- **Code:** `packages/integrations/src/youtube/`; jobs `webinar.create_broadcast`,
  `webinar.update_broadcast`, `webinar.delete_broadcast`, `webinar.create_meet_space`,
  `webinar.fetch_recording`, `webinar.sync_status`.
- Streams are unlisted and embedded in the portal. Presenters join through Google Meet. The player
  reports watch time every 15 seconds to `/api/webinar/heartbeat`.
- **When it fails:** a broadcast that cannot be created blocks publishing the webinar with a clear
  message. A lost heartbeat loses telemetry, never a registration.

## Meta and Google Ads (Release 3)

- **Code:** `packages/integrations/src/ads/` (daily `ads.pull_yesterday` at 05:30, read-only,
  into `ad_spend_daily`) and `packages/integrations/src/meta-messaging/` (Messenger and Instagram
  inbox, webhook `/api/webhooks/meta`).
- **Environment** (staging and production always use the real clients; elsewhere a provider is
  real only when its key is set, else the fake runs):
  - `META_ADS_TOKEN`: Meta Marketing API token (read-only) for the daily Meta ad spend.
  - `GOOGLE_ADS_TOKEN`: Google Ads API token (read-only) for the daily Google ad spend.
  - `META_APP_SECRET`: the Meta app secret; it verifies the `X-Hub-Signature-256` of every
    Messenger and Instagram webhook.
  - `META_PAGE_ACCESS_TOKEN`: the long-lived page access token the inbox sends replies with (the
    key that switches the inbox from its fake to the real client outside staging and production).
  - `META_VERIFY_TOKEN`: a random string of your choice, entered in the Meta app's webhook
    settings; `/api/webhooks/meta` answers Meta's subscription check only with this token.
  - `/admin/system/integrations` shows for each of these whether it is set (never its value).
- **When it fails:** the dashboard shows "data as of" the last good day; 3 failed days raise a Normal
  alert.

## Scaleway (backup storage)

Not called by the application. `.github/workflows/backup.yml` uploads the encrypted nightly dump to
a Scaleway Object Storage bucket in Paris (`fr-par`) in BEAM's name. See [backup.md](backup.md).

## Adding a real key

Nothing in the code changes when a real key arrives:

1. Put the key in the right Vercel environment group (staging or production).
2. Redeploy.
3. Check `/admin/system/integrations`: the provider tile turns from "fake" to "connected".
4. Make one test transaction and watch `integration_calls` for a day.

The full list of accounts and who owns them is on [ownership-and-exit.md](ownership-and-exit.md).
