# Load test results

Written by `apps/web/scripts/load/report.ts` when `pnpm test:load` runs (platform spec, platform-P11;
proposal section 5). Do not edit the sections between the markers by hand: the next run of the same
target replaces its section. A failed threshold is a `high` support request (see `support.md`).

## Scenarios and thresholds

| Scenario | Threshold |
| --- | --- |
| 100 concurrent visitors on /nl/account/book for 60 s | p95 below 800 ms and no 5xx |
| 50 concurrent magic-link requests | every email.send job succeeded within 2 minutes |
| 5,000 queued email.send jobs drained by the tick | every job succeeded within 15 minutes |
| 20,000-recipient campaign on the fake Resend adapter | campaign sent within 15 minutes |

Seat oversell under concurrent booking is covered separately by booking's `book.load.test.ts`.

## How to run

```bash
# beam_dev (wave 11 checkpoint): next start on the laptop, demo seed loaded
pnpm seed:demo
BASE_URL=http://localhost:3000 pnpm test:load --target beam_dev
# staging, before go-live (DATABASE_URL_UNPOOLED of the staging branch)
BASE_URL=https://staging.beam.be pnpm test:load --target staging
```

Options: `--only portal_booking,magic_links,email_drain,campaign_send` runs a subset; `--no-drive-tick`
waits for the deployed cron tick instead of running it in the load test process. The scenarios create
`load-<run>-...@demo.beam.be` test persons and messages that stay in the database.

## Latest run: `beam_dev`

<!-- load-run:beam_dev:start -->
Not run yet.
<!-- load-run:beam_dev:end -->

## Latest run: `staging`

<!-- load-run:staging:start -->
Not run yet.
<!-- load-run:staging:end -->
