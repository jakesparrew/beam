# Seam issues, R3 (platform-P14)

Seam failures found by the end-of-R3 seam package (platform spec section 12, platform-P14; PL-95,
PL-96, gap G12). Handled as in platform-P12 (`docs/build/seam-issues-v1.md`): each open issue
names the package whose files hold the fix; the orchestrator runs one fix package per issue
(`fix-<module>-<n>`, owning only that module's files) before wave 22 starts, then turns the
marked case back into a plain test (`it.fails` -> `it`). This package edits no other module.

## Result of the R3 route seam

`apps/web/test/routes-r3.test.ts` reads the route tree from disk with `resolveRoute`
(`apps/web/test/support/route-map.ts`, platform-P12):

| Check | Result |
| --- | --- |
| `/admin/reports/marketing`, `/admin/reports/attribution`, `/admin/reports/ads` resolve to `app/(admin)/admin/reports/{marketing,attribution,ads}/page.tsx` (ops-P8), the static folders winning over `[report]`; their CSVs and the management CSV resolve to `app/(admin)/admin/reports/[report]/csv/route.ts` | passes |
| `/admin/dashboard/management` resolves to `app/(admin)/admin/dashboard/management/page.tsx` (ops-P8) | passes |
| `/admin/finance/dashboard` resolves to `app/(admin)/admin/finance/dashboard/page.tsx` (finance-P8); the `(admin)` shell's `error.tsx` and `layout.tsx` apply | passes |
| The four ops pages have `loading.tsx` and a `"use client"` `error.tsx` in their own folder | passes |
| No `packages/db/src/dashboard/` or `packages/db/src/reports/` folder exists (PL-96) | passes |

## Result of the R3 registry seam

`apps/web/test/seams-r3.test.ts` runs on PGlite after the full demo seed (`runSeed` with the
generated `DEMO_SEEDS`, clock pinned to 2026-10-15 12:00 Brussels), with the Meta and Google Ads
fakes pulled through ops' `ads.pull_yesterday` job function for three days. No module function is
mocked; only `next/headers` and `next/server`.

| Check | Result |
| --- | --- |
| `REPORT_CSV` from `apps/web/modules/ops/reports/registry.ts` has the keys `marketing`, `attribution` and `ads`; each generator yields rows of its `REPORT_CSV_COLUMNS` width, and `toCsv` frames them with that header row (the ads CSV holds the pulled fake campaigns) | passes |
| `GET /admin/reports/{marketing,attribution,ads}/csv` answers 200 for a signed-in owner with the registry header | passes |
| Exactly one source file under `apps/web` and `packages` defines `REPORT_CSV` (PL-96); the dashboard card registry `CARDS` carries the R3 `b2b_proposals` card | passes |
| `getManagementDashboard(ctx)` for the seeded owner returns the customers (`CUSTOMER_TILES`), sales mix (by kind and channel), retention (`RETENTION_TILES`) and B2B tile groups; the open B2B count matches the seeded open opportunities | passes |
| A seeded reception user (no `reports.read`) gets `ForbiddenError` from `getMarketingDashboard`, `getAttributionReport`, `getCampaignFunnel`, `getAdsReport` and `getManagementDashboard`, a 404 from the pages' guard `staffReadCtx({ permission: "reports.read" })`, and a 403 from the four CSVs | passes |

No seam blocks wave 22.

## Open issues

None.

## Closed issues

None yet.
