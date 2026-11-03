#!/usr/bin/env bash
# Integration gate (BS-13), adapted to per-merge batches.
#   scripts/build/gate.sh quick <label>   install, gen, migrations, typecheck, lint, i18n, tests, gdpr
#   scripts/build/gate.sh full  <label>   quick + production build
#   scripts/build/gate.sh e2e   <label>   full + beam_dev migrate, demo seed, Playwright
# Steps whose script does not exist yet (early waves) are skipped and say so.
set -uo pipefail
mode="${1:-quick}"; label="${2:-adhoc}"
cd "$(dirname "$0")/../.."
logs=docs/build/logs; mkdir -p "$logs"
if grep -Eq '^DATABASE_URL(_UNPOOLED)?=.*/neondb' .env.local 2>/dev/null || grep -q '/neondb' <<<"${DATABASE_URL:-}${DATABASE_URL_UNPOOLED:-}"; then
  echo "refusing: database points at production"; exit 9
fi
export INTEGRATIONS=fake EMAIL_SINK=sink@beam.be APP_ENV=local
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=6144}"
peak=0; ( while sleep 2; do free -m | awk 'NR==2{print $3}'; done ) > "$logs/$label-mem.log" & memp=$!
trap 'kill $memp 2>/dev/null' EXIT
t0=$(date +%s)
step() {
  local name="$1"; shift
  local s=$(date +%s)
  echo "== $name"
  if "$@" >"$logs/$label-$name.log" 2>&1; then echo "   ok ($(( $(date +%s) - s ))s)"; else
    echo "RED: $name after $(( $(date +%s) - s ))s (log: $logs/$label-$name.log)"; tail -60 "$logs/$label-$name.log"; exit 1; fi
}
skip() { echo "== $1 (skipped: $2)"; }
has() { [ -e "$1" ]; }

step install pnpm install --offline --frozen-lockfile
if has apps/web/scripts/gen-indexes.ts; then step gen pnpm gen:indexes; else skip gen "no generator yet"; fi
step check-migr pnpm db:check-migrations
if has packages/db/scripts/views-sql.ts; then step views pnpm db:views --check; else skip views "no views script yet"; fi
if has packages/db/scripts/append-only-sql.ts; then step append-only pnpm db:append-only --check; else skip append-only "no append-only script yet"; fi
step migr-db pnpm --filter @beam/db test:migrations
step typecheck pnpm typecheck
if has eslint.config.js; then step lint pnpm lint; else skip lint "no eslint config yet"; fi
if has packages/core/scripts/i18n-check.ts; then step i18n pnpm i18n:check; else skip i18n "no i18n check yet"; fi
step test pnpm test
if has apps/web/test/gdpr-coverage.test.ts; then step gdpr pnpm gdpr:coverage; else skip gdpr "no gdpr coverage test yet"; fi
if [ "$mode" = full ] || [ "$mode" = e2e ]; then step build pnpm build; fi
if [ "$mode" = e2e ]; then
  export DATABASE_DRIVER=neon-ws NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt
  step migrate pnpm db:migrate
  step seed pnpm seed:demo
  step e2e pnpm test:e2e
fi
kill $memp 2>/dev/null
peak=$(sort -n "$logs/$label-mem.log" | tail -1)
echo "GREEN: $mode gate $label in $(( $(date +%s) - t0 ))s; peak used RAM ${peak:-?} MB"
