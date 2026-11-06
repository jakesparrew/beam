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

Read the `beam_dev` run for function, not for speed. It ran from the build container, where every
database round trip to Neon in Frankfurt costs about 120 ms (Vercel fra1 to the same database: about
1 to 2 ms). The booking page makes about 16 sequential queries, so it took about 2 s here at any
load; at full counts it answered every request with 200 and no errors, and its p95 is the threshold
to judge on `staging`. Enqueuing 5,000 jobs one by one would take about an hour from here, so the
job scenarios ran at reduced counts (`--smoke`): each did its whole flow and passed. The full-count
thresholds are measured on `staging` before go-live.

<!-- load-run:beam_dev:start -->
Run 2026-11-06T03:49:17.796Z on commit `d55097e90a74` against http://localhost:3100.
Tick: run by the load test process with the fake integrations.
Verdict: **thresholds not met**.

| Scenario | Threshold | Result | Duration |
| --- | --- | --- | --- |
| 100 concurrent visitors on /nl/account/book for 60 s | p95 below 800 ms and no 5xx | FAIL (reduced counts) | 11.8 s |
| 50 concurrent magic-link requests | every email.send job succeeded within 2 minutes | PASS (reduced counts) | 55.8 s |
| 5,000 queued email.send jobs drained by the tick | every job succeeded within 15 minutes | PASS (reduced counts) | 42.6 s |
| 20,000-recipient campaign on the fake Resend adapter | campaign sent within 15 minutes | PASS (reduced counts) | 82.6 s |

#### 100 concurrent visitors on /nl/account/book for 60 s

| Measure | Value |
| --- | --- |
| Connections / duration | 10 / 10 s |
| Responses | 30 |
| Throughput | 3 req/s |
| p50 / p95 / p99 | 2255 ms / 3773 ms / 3792 ms |
| 5xx | 0 |
| Other non-2xx (a redirect means the session was not accepted) | 0 |
| Errors / timeouts | 0 / 0 |
| Status codes | 200: 30 |

#### 50 concurrent magic-link requests

| Measure | Value |
| --- | --- |
| Requests (failed) | 5 (0) |
| All requests answered after | 1891 ms |
| email.send jobs | succeeded 5 |
| Last job succeeded after | 55.8 s |
| Ticks run here (failed) | 1 (0) |

#### 5,000 queued email.send jobs drained by the tick

| Measure | Value |
| --- | --- |
| Jobs queued | 50 in 26.5 s |
| Job statuses | succeeded 50 |
| Drained after | 16.1 s |
| Throughput | 186 jobs/min |
| Ticks run here (failed) | 3 (0) |

#### 20,000-recipient campaign on the fake Resend adapter

| Measure | Value |
| --- | --- |
| Audience prepared | 100 persons in 1564 ms |
| Planned after | 80.7 s |
| Campaign status | sent |
| Recipients | sent 100 |
| Messages sent | 100 |
| Sent after | 80.7 s |
| Ticks run here (failed) | 2 (0) |
<!-- load-run:beam_dev:end -->

## Latest run: `staging`

<!-- load-run:staging:start -->
Not run yet.
<!-- load-run:staging:end -->
