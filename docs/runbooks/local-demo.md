# Run BEAM locally with demo data

This runbook starts the whole app on a laptop with its own local Postgres and the demo data, so
you can click through the website, the customer portal and the back-office. Nothing here talks
to Neon. Never point a local run at `neondb` (production), and don't use `beam_dev` either: its
demo accounts already exist with older passwords, and the seed never changes an existing user.

## Requirements

- Node 22 or later, and pnpm 10 (`corepack enable` picks the version from `package.json`).
- Docker, or another Postgres 16 you can reach.
- A free port for the app. `pnpm dev` uses 3000; if another project already runs there, start
  Next directly on another port, as below (3010 here).

## Steps

```bash
git clone -b claude/focused-hopper-gpky3y https://github.com/jakesparrew/beam.git
cd beam
pnpm install

# A local Postgres on port 5433, so it does not clash with another database on 5432
docker run -d --name beam-pg -p 5433:5432 \
  -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=beam_local postgres:16

cp .env.example .env.local
```

In `.env.local` (git-ignored, never commit it), set:

| Variable | Value |
| --- | --- |
| `APP_URL` | `http://localhost:3010`, the same port the app runs on (sign-in links use it) |
| `DATABASE_URL`, `DATABASE_URL_UNPOOLED` | `"postgresql://postgres@127.0.0.1:5433/beam_local"` |
| `DATABASE_DRIVER` | `pg` (the default) |
| `AUTH_SECRET`, `SENSITIVE_DATA_KEY_V1` | `openssl rand -base64 32`, each its own value |
| `CRON_SECRET`, `VOUCHER_CODE_SECRET`, `AUTOMATION_WEBHOOK_SECRET` | `openssl rand -hex 32`, each its own value |
| `DEMO_STAFF_PASSWORD` | a password of 12 characters or more, for every demo staff user |
| `DEMO_TOTP_SECRET` | a base32 secret, e.g. `python3 -c "import base64,os;print(base64.b32encode(os.urandom(20)).decode())"` |

Keep `INTEGRATIONS=fake`, `EMAIL_SINK` and `LOCAL_TICK_MS=5000` as they are: every provider uses
its fake, no email leaves the machine and background jobs run inside the dev server.

```bash
pnpm gen:indexes      # git-ignored registries; the app does not compile without them
pnpm db:migrate
pnpm seed:demo        # set DEMO_STAFF_PASSWORD and DEMO_TOTP_SECRET first, or staff users are skipped
cd apps/web && npx next dev -p 3010
```

Check: `curl http://localhost:3010/api/health` returns `"status":"ok"`. The first visit to each
page takes a few seconds while Next compiles it.

## Logins

**Back-office:** `http://localhost:3010/admin/login`

- `owner@demo.beam.be` with `DEMO_STAFF_PASSWORD`, then a code from an authenticator app in which
  `DEMO_TOTP_SECRET` was added as a manual key.
- The other roles use the same password and code: `management`, `customer_service`, `sales`,
  `marketing`, `finance`, `reception`, `technical_admin` and `external_partner`, each
  `@demo.beam.be`.

**Customer portal:** `http://localhost:3010/nl/account/login`

- `customer1@example.com` (and `customer2@`, `customer3@`, ...). Customers sign in with an email
  link. Locally that email lands in the database instead of an inbox; after requesting it, print
  the link with:

```bash
psql postgresql://postgres@127.0.0.1:5433/beam_local -At -c "
  select convert_from(f.bytes, 'UTF8') from email_messages m
  join files f on f.id = m.rendered_file_id
  where lower(m.to_email) = 'customer1@example.com'
  order by m.created_at desc limit 1" | grep -o 'http://localhost:3010/[^"]*verify[^"]*' | head -1 | sed 's/&amp;/\&/g'
```

## When something goes wrong

- **The page shows another project:** something else runs on that port. Use another port and
  update `APP_URL` to match.
- **The dev server stops answering** (a page stays on "Compiling"): stop it and start it again.
- **Starting over with fresh data:** `docker rm -f beam-pg`, then run the `docker run` command
  and the three `pnpm` steps again.
