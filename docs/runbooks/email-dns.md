# Email domains and DNS (Resend)

Owner: email module. Read with email spec section 6 and rules 1 to 8. BEAM owns both sending
domains and their DNS; Sidestream reads the DMARC reports.

## Domains

| Domain | Used for | Sender | Reply-To |
| --- | --- | --- | --- |
| `mail.beam.be` | every transactional message (bookings, receipts, invoices, sign-in links, automation steps with a transactional template) | `BEAM <hello@mail.beam.be>` | `info@beam.be` |
| `news.beam.be` | marketing: campaigns, marketing automation steps, commercial registry sends such as checkout recovery | `BEAM <news@news.beam.be>` | `info@beam.be` |

Senders and Reply-To live in `settings.email_config.senders` (Settings page, permission
`settings.write`). `beam.be` itself keeps its Google Workspace SPF and MX; nothing below changes
them.

## 1. Add the domains in Resend

1. In BEAM's Resend account choose **Domains → Add domain**, region **EU (eu-west-1)**, once for
   `mail.beam.be` and once for `news.beam.be`.
2. Turn **open tracking and click tracking off** on both domains. BEAM tracks opens and clicks
   itself (`/api/public/track/open`, `/api/public/track/click`), for marketing messages only.
3. Copy each domain's id into `settings.email_config.resend_domain_ids`
   (`{ "mail.beam.be": "<id>", "news.beam.be": "<id>" }`). The daily domain check uses them.

## 2. DNS records

Create these records at the DNS host of `beam.be`, for each `<d>` in `mail.beam.be` and
`news.beam.be`:

| Type | Name | Value | Notes |
| --- | --- | --- | --- |
| MX | `send.<d>` | `feedback-smtp.eu-west-1.amazonses.com` | priority 10 (bounce return path) |
| TXT | `send.<d>` | `v=spf1 include:amazonses.com ~all` | SPF of the return path |
| TXT | `resend._domainkey.<d>` | the public key Resend shows for that domain | DKIM; copy it exactly, no line breaks |
| TXT | `_dmarc.<d>` | see below | DMARC |

DMARC value:

- Weeks 1 to 4 after go-live: `v=DMARC1; p=quarantine; pct=100; rua=mailto:dmarc@beam.be; adkim=r; aspf=r`
- From week 5, when the aggregate reports are clean (only Resend and Google as sources, aligned):
  `v=DMARC1; p=reject; pct=100; rua=mailto:dmarc@beam.be; adkim=r; aspf=r`

`dmarc@beam.be` is a Google group; Sidestream reads it weekly during warm-up and monthly after.

Release 3 adds Resend Inbound for `in.beam.be` (MX `inbound-smtp.eu-west-1.amazonaws.com`,
priority 10); email-P9 adds it to this runbook.

## 3. Verify

1. In Resend press **Verify** on each domain; every record must show `verified`. DNS changes can
   take up to an hour.
2. Check from a terminal: `dig +short TXT resend._domainkey.mail.beam.be`,
   `dig +short TXT _dmarc.news.beam.be`, `dig +short MX send.news.beam.be`.
3. Send a test email from `/admin/templates` (test send) to a Gmail and an Outlook address and
   check the headers show `dkim=pass`, `spf=pass` and `dmarc=pass`.

## 4. Webhook

1. In Resend choose **Webhooks → Add endpoint**: `https://beam.be/api/webhooks/resend`, events
   `email.sent`, `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.complained`,
   `email.opened`, `email.clicked`, `email.failed` (and, from Release 3, `email.received`).
2. Copy the signing secret (`whsec_...`) into the Vercel environment variable
   `RESEND_WEBHOOK_SECRET` (Production only) and redeploy. A request with a wrong signature or a
   timestamp older than 5 minutes is answered 401 and stored nowhere; more than 5 such failures in
   10 minutes post a Slack alert (rotate the secret on both sides if that happens).
3. `RESEND_API_KEY` (sending access, EU region) goes into the same environment. Preview and local
   environments keep `EMAIL_SINK` set: every message is rewritten to that address, and without it
   a real Resend client refuses to send (`email_sink_missing`).

## 5. Warm-up

`news.beam.be` starts cold. Set `settings.warmup_schedule.start_on` to the go-live date; the daily
caps are 1,000, 2,000, 4,000 and 8,000 messages in weeks 1 to 4, then no cap. Chunks that reach
the cap continue the next day at 09:00 Brussels. `mail.beam.be` has no cap. During warm-up send
to the most engaged contacts first (the campaign planner does this automatically).

## 6. Monitoring and alerts

- `email.check_domains` runs every day at 05:10 Brussels: any domain or record that is not
  `verified` posts a High alert (`email:domain:<domain>`) to `#beam-alerts`. Fix the record in DNS,
  press Verify in Resend, and the next run is quiet.
- Hard bounces and complaints suppress the address through crm (`suppressions`, scope `all`);
  three soft bounces in 30 days do the same. The suppression list is on crm's suppression screen.
- If Gmail or Yahoo start rejecting with `5.7.26` (unauthenticated), check DKIM and DMARC first,
  then the `List-Unsubscribe` headers of a marketing message (they must point at
  `https://beam.be/api/public/unsubscribe/<token>` with `List-Unsubscribe-Post`).

## 7. Erasure

Resend keeps delivery logs for 30 days. BEAM never creates Resend contacts or audiences; ops'
`privacy.erase_external` still calls `ResendClient.deleteContact(email)` defensively before the
local erasure steps.
