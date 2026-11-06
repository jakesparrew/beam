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
# local: next start against a local Postgres with the demo seed (DATABASE_DRIVER=pg)
BASE_URL=http://localhost:3200 pnpm test:load --target local
# beam_dev (wave 11 checkpoint): next start on the laptop, demo seed loaded
pnpm seed:demo
BASE_URL=http://localhost:3000 pnpm test:load --target beam_dev
# staging, before go-live (DATABASE_URL_UNPOOLED of the staging branch)
BASE_URL=https://staging.beam.be pnpm test:load --target staging
```

Options: `--only portal_booking,magic_links,email_drain,campaign_send` runs a subset; `--no-drive-tick`
waits for the deployed cron tick instead of running it in the load test process. The scenarios create
`load-<run>-...@demo.beam.be` test persons and messages that stay in the database.

## Latest run: `local`

The production build on a Postgres 16 next to it (no network between app and database): the platform's own throughput and query cost, without Neon or Vercel. Full counts. The run of record used three app processes (Node cluster) on a 4-CPU machine that also ran Postgres and the load generator: the booking page costs about 25 ms of CPU per request and throughput grew linearly from one process (49 req/s) to three (101 req/s), so its p95 is a matter of instances, which Vercel adds under load.

<!-- load-run:local:start -->
Run 2026-11-06T07:03:24.413Z on commit `097c150c86c8` against http://localhost:3400.
Tick: run by the load test process with the fake integrations.
Verdict: **thresholds not met**.

| Scenario | Threshold | Result | Duration |
| --- | --- | --- | --- |
| 100 concurrent visitors on /nl/account/book for 60 s | p95 below 800 ms and no 5xx | FAIL | 60.3 s |
| 50 concurrent magic-link requests | every email.send job succeeded within 2 minutes | PASS | 1.8 s |
| 5,000 queued email.send jobs drained by the tick | every job succeeded within 15 minutes | PASS | 27.4 s |
| 20,000-recipient campaign on the fake Resend adapter | campaign sent within 15 minutes | PASS | 263.4 s |

#### 100 concurrent visitors on /nl/account/book for 60 s

| Measure | Value |
| --- | --- |
| Connections / duration | 100 / 60 s |
| Responses | 6076 |
| Throughput | 101 req/s |
| p50 / p95 / p99 | 938 ms / 1663 ms / 2372 ms |
| 5xx | 0 |
| Other non-2xx (a redirect means the session was not accepted) | 0 |
| Errors / timeouts | 0 / 0 |
| Status codes | 200: 6076 |

#### 50 concurrent magic-link requests

| Measure | Value |
| --- | --- |
| Requests (failed) | 50 (0) |
| All requests answered after | 934 ms |
| email.send jobs | succeeded 50 |
| Last job succeeded after | 1802 ms |
| Ticks run here (failed) | 1 (0) |

#### 5,000 queued email.send jobs drained by the tick

| Measure | Value |
| --- | --- |
| Jobs queued | 5000 in 17.1 s |
| Job statuses | succeeded 5000 |
| Drained after | 10.3 s |
| Throughput | 29254 jobs/min |
| Ticks run here (failed) | 2 (0) |

#### 20,000-recipient campaign on the fake Resend adapter

| Measure | Value |
| --- | --- |
| Audience prepared | 20000 persons in 5351 ms |
| Planned after | 185.8 s |
| Campaign status | sent |
| Recipients | sent 20000 |
| Messages sent | 20000 |
| Sent after | 258.0 s |
| Warm-up cap lifted for the run | yes (restored afterwards) |
| Ticks run here (failed) | 132 (0) |
<!-- load-run:local:end -->

## Latest run: `beam_dev`

Read for function, not for speed: from the build container every database round trip to Neon in Frankfurt costs about 120 ms (from Vercel fra1 about 1 to 2 ms). The booking page answered every request without errors, but its p95 and the job scenarios' durations measure that distance; the job scenarios ran at reduced counts (`--smoke`).

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

The thresholds that decide go-live: Vercel fra1 and the staging branch of Neon, full counts.

<!-- load-run:staging:start -->
Not run yet.
<!-- load-run:staging:end -->
