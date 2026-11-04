# Runbook: failed provider sync

Owner: Sidestream. Applies to Mollie (payments), Billit (invoices), Resend (email), Slack, Better
Stack, Google (R2) and the ads providers (R3). Requests never call providers; jobs do, through
`getIntegrations()`, and every call writes an `integration_calls` row (PL-75).

## Signals

- Slack alert: a provider with at least 10 failed calls and no successful call in the last 60
  minutes; webhook signature failures above 5 in 10 minutes; Mollie silence for 24 hours while
  orders were created; Billit failing for an hour (finance); payments pending over 15 minutes
  (commerce).
- `/admin/system/integrations`: health per provider (calls, errors, last success, last error) and
  the last 200 calls with status and error.
- Dead jobs of the provider's kinds (`dead-jobs.md`).

## Steps

1. Check the provider's status page. If the provider is down, wait: failed attempts back off (1,
   5, 15, 60 and 360 minutes) before a job turns dead.
2. Check credentials: a `401`/`403` in the call log means a rotated or expired key; fix it in
   Vercel (`rotate-keys.md`) and redeploy.
3. Check the payload: a `400`/`422` with the same error on every call is a bug or bad data; fix
   it and deploy before retrying.
4. Once calls succeed again, retry the dead jobs of that provider (`dead-jobs.md`).
5. Webhooks missed during an outage: resend them from the provider dashboard. Duplicates are
   ignored (`webhook_events` is unique on provider and event id). A stored event can be replayed
   from `/admin/system/webhooks/<id>` ("Replay event", audited `webhooks.replay`, key
   `webhook:<provider>:<event id>:replay:<n>`).
6. Reconcile: compare the provider dashboard with BEAM for the outage window (Mollie payments
   with `payments`, Billit invoices with `invoices`, Resend deliveries with `email_messages`). The
   module jobs reconcile on their next run; never edit rows by SQL.
7. Record a `normal` or `high` incident when customers noticed (`incident.md`).
