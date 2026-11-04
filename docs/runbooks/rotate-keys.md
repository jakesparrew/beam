# Runbook: rotate keys and secrets

Owner: Sidestream (executes), BEAM owner (starts the re-encryption). Every secret is rotated at
least once a year and at once after a suspected leak. Secrets live only in Vercel environment
groups and `.env.local`; `.env.example` lists the names (architecture section 9).

## Sensitive-data key (`SENSITIVE_DATA_KEY_V<n>`, PL-69, PL-70)

Sensitive columns (`person_sensitive_fields`, `form_sensitive_answers`, sensitive
`activity_events`, `users.totp_secret_enc`, `users.recovery_codes_enc`) are AES-256-GCM encrypted
with a key version per row.

1. Generate 32 random bytes: `openssl rand -base64 32`.
2. Add it as `SENSITIVE_DATA_KEY_V<current + 1>` to every Vercel environment group (production,
   staging, preview) and to the GitHub Actions secrets used by jobs. Keep the old key.
3. Redeploy so the new variable is loaded.
4. As owner, open `/admin/system/security`, tick "I added SENSITIVE_DATA_KEY_V<n>" and start the
   re-encryption (`startRekey`, audited `security.rekey_started`). It refuses a version that is not
   current + 1 or whose key is missing.
5. The `security.rekey` job re-encrypts 500 rows per job and continues by itself, table by table.
   Reads keep working mid-way because each row names its key version. Watch "Key versions" on the
   same page until no row uses an older version.
6. `settings.security.current_key_version` is now `<n>`. Keep the old key for 30 days (backups
   made before the rotation still need it to be readable after a restore), then remove it.

## Other secrets

| Secret | How to rotate | Then |
| --- | --- | --- |
| `AUTH_SECRET` | new 32-byte value in Vercel | redeploy; all sessions and signed file links end (staff sign in again) |
| `CRON_SECRET` | new value in Vercel and in the Vercel cron config | redeploy; check `/admin/system` tick age |
| `DATABASE_URL`, `DATABASE_URL_UNPOOLED` | reset the role password in Neon | update Vercel and GitHub secrets, redeploy |
| `MOLLIE_API_KEY`, `MOLLIE_WEBHOOK_SECRET` | Mollie dashboard | update Vercel, redeploy, send a test webhook |
| `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET` | Resend dashboard | update Vercel, redeploy, send a test email |
| `BILLIT_API_KEY` | Billit settings | update Vercel, redeploy |
| `ANTHROPIC_API_KEY` | Anthropic console (organisation in BEAM's name) | update Vercel, redeploy |
| `SLACK_WEBHOOK_URL` | Slack app settings | update Vercel and GitHub |
| `SENTRY_DSN`, `BETTERSTACK_HEARTBEAT_URL` | provider settings | update Vercel |
| `BACKUP_AGE_PUBLIC_KEY` | new `age-keygen` pair, private key offline with BEAM and Sidestream | update the GitHub secret; keep the old private key until the last dump made with it expires (12 months) |

Each rotation is noted with its date in the monthly report notes. gitleaks in CI catches a secret
committed by mistake; treat such a finding as a leak: rotate at once and open an incident.
