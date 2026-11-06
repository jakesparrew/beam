# Open items: where the build stopped

State on 6 November 2026. The full gate is green on the final code (commit `42e2000` and later
docs), and the last full end-to-end run passed 151 of 151 against a clean local Postgres. The
whole report is `docs/build/final-report.md`.

## To build or check in the next session

1. **Clock sweep (interrupted).** 65 test files pin dates between today and December 2026. One
   of them failed today because production code read the database clock instead of `ctx.now`
   (fixed for automation step runs). Run the web unit suite once with the clock moved past
   every pinned date and fix each leak it shows. The preload is a 12-line `Date` shim, loaded
   with `NODE_OPTIONS="--require <shim>"` and `SHIFT_TO=2027-03-01T12:00:00Z`, then
   `pnpm --filter @beam/web exec vitest run`.
2. **Rare invoice deadlock.** Credit-note issuing and the invoice PDF job still deadlock now and
   then (twice in five full runs). It does no harm: the job retries within seconds. Find the lock
   order between the two (`modules/finance`, `modules/commerce/server/refunds.ts`) and make it
   consistent.
3. **Booking page under load.** 100 visitors at once: no errors, p95 1.7 s on three processes on
   a 4-CPU machine (about 25 ms CPU per page). Measure on staging (`pnpm test:load --target
   staging`); if Vercel does not meet 800 ms, cache the session list per day.
4. **Native mobile app.** The contract includes one; the build has an installable web app. If
   the contract keeps it, build a thin native wrapper around the customer portal.
5. **Contract follow-ups.** Say in article 3 that the 12 instalments start at the V1 go-live, as
   article 5 now says for the €299 monthly fee (only if wanted). Draft the data processing
   agreement.

## Needs BEAM or you before go-live

6. **Staging:** a Vercel project and a Neon staging branch; then run the V1 acceptance and the
   load test there.
7. **Production accounts and keys** in BEAM's name: Mollie (live), Resend, Billit, YouTube, Meta,
   Google Ads, Anthropic, Better Stack, Sentry, Vercel, Neon. `/api/health` lists what is missing.
8. **Go-live checklist:** the 13 confirmations on `/admin/system/go-live`
   (`docs/runbooks/go-live.md`).
9. **A `main` branch**, created from `claude/focused-hopper-gpky3y`; the runbooks deploy from
   `main`.
10. **Data migration** from the current tools (`docs/runbooks/data-migration.md`), dry run first.
11. **Releases 2 to 4:** switch on their flags; for R2 and R3 also run `pnpm release:activate R2`
    (or `R3`) once on production.
