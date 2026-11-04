# Subprocessors

Controller: BEAM Vitality Center. Processor: Sidestream. This list is the annex to the data
processing agreement and is confirmed by BEAM at go-live (`go-live.md`). Accounts are in BEAM's
name unless stated.

## Processing subprocessors

| Subprocessor | Role | Location | Data processed | Transfer mechanism |
| --- | --- | --- | --- | --- |
| Neon (Databricks) | Postgres database (all application data, files, backups by point-in-time restore) | AWS eu-central-1, Frankfurt (EU) | all personal data, including encrypted sensitive data | none needed (EU); DPA with Neon |
| Vercel | hosting of the web app and functions, logs (ids only) | functions in fra1, Frankfurt (EU); edge network worldwide | request data in transit, IP addresses, logs without personal data | EU-US Data Privacy Framework and SCCs for the edge network and support |
| Resend | transactional and marketing email delivery | EU region (eu-west-1, Ireland) | email address, name, email content, delivery events | EU region; DPF and SCCs for the US company |
| Mollie | payments | Netherlands (EU) | name, email, amount, payment method data (held by Mollie) | none needed (EU) |
| Billit | invoicing and Peppol | Belgium (EU) | invoice customer data (name, address, VAT number, lines) | none needed (EU) |
| Google | calendar sync and analytics (R2), consent-gated | EU and US | calendar events (no health data), analytics identifiers after consent | DPF and SCCs |
| <a id="anthropic"></a>Anthropic | AI drafts and summaries through `callClaude()` (feature register on `/admin/system/ai`) | US | only the fields of each feature's `allowedFields`; no sensitive data (PL-54) | SCCs and DPF; API data is not used for training; 30-day retention by the provider |

## Operational subprocessors

| Subprocessor | Role | Location | Data processed | Transfer mechanism |
| --- | --- | --- | --- | --- |
| Sentry | error monitoring | EU (Frankfurt, `de.sentry.io`) | stack traces with ids; emails and phone numbers masked, request bodies and cookies removed (PL-72) | none needed (EU) |
| Better Stack | uptime monitoring and heartbeat | EU | no personal data (health endpoint and public form page only) | none needed |
| Slack | alerts and support channel | US (EU data residency where available) | alert texts with ids and references, no customer names | DPF and SCCs |
| Scaleway | off-provider backup storage (`age`-encrypted dumps) | Paris, fr-par (EU) | encrypted database dumps | none needed (EU) |
| GitHub | source code, CI, backup and restore-drill workflows | US | source code; CI runs with secrets but no production data at rest (dumps are streamed encrypted) | DPF and SCCs |

## Not a subprocessor

| Service | Why |
| --- | --- |
| Have I Been Pwned (Pwned Passwords) | The browser sends only the first 5 characters of a SHA-1 hash of a new password (k-anonymity); no personal data is processed (PL-1). |

## <a id="locations"></a>Locations

All primary storage is in the EU: database in Frankfurt, functions in Frankfurt, backups in
Paris. US-based services receive only the data listed above.

## <a id="transfers"></a>Transfers

Transfers outside the EEA (Vercel edge and support, Resend's US company, Google, Anthropic,
Slack, GitHub) rely on the EU-US Data Privacy Framework where the provider is certified and on
the European Commission's Standard Contractual Clauses otherwise. BEAM is informed of a new
subprocessor 30 days before it starts processing.
