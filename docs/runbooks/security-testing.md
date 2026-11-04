# Runbook: ethical-hacking tests

Owner: Sidestream (organises and runs), BEAM owner or technical_admin (records). Source: platform
spec PL-85.

## Schedule

- Before go-live, then once per quarter (every 92 days at most).
- From 7 days before `settings.security.next_pentest_due_on`, `platform.check_alerts` posts one
  reminder per day to Slack.

## Scope (OWASP ASVS level 2)

Authentication (password, TOTP, recovery codes, magic links, lockout), access control (roles,
`action()` permissions, partner scope, customer data isolation), sessions (expiry, revocation,
cookie flags), input handling (Zod on every boundary, Server Actions origin check, CSP), file
access (signed links, public images, no SVG), webhooks (signatures, replay), rate limits (WAF
and `rate_limits`). Test on staging with seeded data, never on production data.

## Steps

1. Agree the window with BEAM; announce it in Slack.
2. Run the test; store the report in BEAM's shared drive (never in the platform or the
   repository).
3. Record it on `/admin/system/security` → "Record an ethical-hacking test": date, summary (no
   vulnerability details that help an attacker), number of critical or high findings. The next due
   date is set to the test date + 92 days.
4. Each critical or high finding opens a `security_incidents` row (`incident.md`); fix it, retest,
   resolve the incident.
5. Go-live: the gate item `security_confirmed` can be confirmed only when the last test is at most
   30 days old and no critical or high incident is open.
