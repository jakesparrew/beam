# Runbook: security controls

Owner: Sidestream; reviewed with BEAM before go-live and after each ethical-hacking test. Source:
architecture section 10, platform spec PL-67 to PL-72, PL-83, PL-84, blueprint 64. Each safeguard
has one implementation and one proof. `/admin/system/security` links here.

## Safeguards

| Safeguard | Implementation | Proof |
| --- | --- | --- |
| <a id="encryption-transit"></a>Encryption in transit | TLS on Vercel and Neon (`sslmode=require` in both database URLs), HSTS preload (PL-67) | `proxy.test.ts` header assertion; the health check refuses a `DATABASE_URL` without `sslmode=require` in production |
| <a id="encryption-rest"></a>Encryption at rest | Neon storage encrypted (AES-256) by the provider; sensitive columns and TOTP secrets additionally AES-256-GCM with key versions (PL-69); backups `age`-encrypted (PL-78) | `sensitive.test.ts`; backup workflow log; key versions on `/admin/system/security` |
| <a id="mfa"></a>Multi-factor authentication | TOTP for every staff and partner account (PL-3, PL-4) | `auth.test.ts`; MFA coverage on `/admin/system/security` |
| <a id="rbac"></a>Role-based access | `action({ permission })`, nav filtering, nine roles (PL-15, PL-19) | `permissions.test.ts` in every module; `/admin/settings/roles` |
| <a id="passwords"></a>Password policies | 12 characters, zxcvbn 3, not the email, HIBP range check in the browser, argon2id, lockout after 10 failures (PL-1, PL-2, PL-6, PL-13) | `password.test.ts` |
| <a id="logging"></a>Logging | `audit_log` for every staff write and sensitive read, `integration_calls`, Sentry EU, ids-only logs with pino redaction (PL-20, PL-21, PL-72) | `audit.test.ts`, `logger.test.ts`; `/admin/system/audit` |
| <a id="backup"></a>Backup and recovery | Neon PITR (7 days, RPO 1 min, RTO 1 h) and daily `age`-encrypted dumps in Scaleway Paris (35 daily, 12 monthly; RPO 24 h, RTO 8 h) (PL-78) | quarterly restore drill result on `/admin/system/security`; `backup.md`, `restore.md` |
| <a id="api"></a>API security | signed webhooks (PL-37), Zod on every route handler, Server Actions origin check (PL-71), CSP with per-request nonces (PL-67) | `webhooks.test.ts`, route tests, `csp.test.ts` |
| <a id="rate-limiting"></a>Rate limiting | application limits in `rate_limits` (PL-68) plus the Vercel WAF rules below | `rate-limit.test.ts`; go-live check of the WAF rules |
| <a id="vulnerability-testing"></a>Vulnerability testing | ethical-hacking test before go-live and every quarter (PL-85) | pentest report in BEAM's drive; `settings.security.last_pentest_on`; `security-testing.md` |
| <a id="dependencies"></a>Dependency management | Renovate weekly (Monday before 06:00 Brussels) and immediate security updates; `pnpm audit --audit-level high --prod` in CI (PL-84) | CI logs |
| <a id="secrets"></a>Secret management | secrets only in Vercel environment groups and `.env.local` (gitignored); `.env.example` lists names only; gitleaks in CI; yearly rotation | gitleaks job; `rotate-keys.md` |

## Vercel WAF rules (configure in the Vercel dashboard, project BEAM, Firewall)

| Rule | Paths | Limit | Action |
| --- | --- | --- | --- |
| API per IP | `/api/*` **except** `/api/webinar/heartbeat` and `/api/webinar/state` | 60 requests per minute per IP | deny (429) |
| Staff login per IP | `/admin/login` | 60 requests per minute per IP | deny (429) |
| Customer login per IP | `/nl/account/login`, `/fr/account/login`, `/en/account/login` | 60 requests per minute per IP | deny (429) |
| Public forms per IP | `/api/public/forms/*` | 20 requests per minute per IP | deny (429) |

The webinar heartbeat and state endpoints are exempt from the per-IP rule because a room of
viewers behind one venue NAT would otherwise be blocked. They are limited per registration in the
application instead: heartbeat 8 per minute (bucket `webinar_heartbeat`), state 30 per minute
(bucket `webinar_state`) (PL-68).

Application limits on top (PL-68): password login 10 per IP per minute and 20 per account per
hour; magic link 5 per address per hour.

Check at go-live (item `security_confirmed`): the four rules exist with these limits and the
exception list contains exactly the two webinar paths; a burst of 70 requests to `/api/health`
from one IP gets 429s; a burst to `/api/webinar/state` with distinct registrations does not.

## Headers and CSP

`proxy.ts` sets a CSP with a per-request nonce and `strict-dynamic` (`buildCsp()` in
`apps/web/lib/csp.ts`), `frame-ancestors 'none'` everywhere except `/:locale/f/*` (embeddable
forms), HSTS, `X-Content-Type-Options: nosniff` and `Referrer-Policy`. `next.config.ts` sends no
CSP or frame header of its own.
