#!/usr/bin/env bash
# Integration gate (BS-13), adapted to per-merge batches (OD-3).
#   scripts/build/gate.sh merge <label> <since-sha>   after each merge batch: install, gen, migrations,
#                                                     whole-repo typecheck, lint and Vitest for what changed since <since-sha>
#   scripts/build/gate.sh quick <label>               install, gen, migrations, typecheck, lint, i18n, all tests, gdpr
#   scripts/build/gate.sh full  <label>               quick + production build
#   scripts/build/gate.sh e2e   <label>               full + beam_dev migrate, demo seed, Playwright
# Steps whose script does not exist yet (early waves) are skipped and say so.
set -uo pipefail
mode="${1:-quick}"; label="${2:-adhoc}"; since="${3:-}"
cd "$(dirname "$0")/../.."
logs=docs/build/logs; mkdir -p "$logs"
# OD-13: every landing waits on the gate, so it runs ahead of the agents' own test runs.
renice -n -10 -p $$ >/dev/null 2>&1 || true
# The production database is the path segment /neondb (the role name neondb_owner is not it).
prod_db='\.neon\.tech/neondb([?"'"'"'[:space:]]|$)'
if grep -Eq "^DATABASE_URL(_UNPOOLED)?=.*${prod_db}" .env.local 2>/dev/null || grep -Eq "$prod_db" <<<"${DATABASE_URL:-} ${DATABASE_URL_UNPOOLED:-}"; then
  echo "refusing: database points at production"; exit 9
fi
if [ "$mode" = merge ] && [ -z "$since" ]; then echo "merge mode needs <since-sha>"; exit 2; fi
# OD-14: Vitest's CLI parses an all-digit short SHA (e.g. 3436055) as a number and then ignores it,
# selecting no tests at all; a full SHA is a string.
if [ -n "$since" ]; then since=$(git rev-parse --verify "$since^{commit}") || { echo "unknown commit $since"; exit 2; }; fi
export INTEGRATIONS=fake EMAIL_SINK=sink@beam.be APP_ENV=local
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=6144"  # appended: the container already sets NODE_OPTIONS (OD-18)
( while sleep 2; do free -m | awk 'NR==2{print $3}'; done ) > "$logs/$label-mem.log" & memp=$!
trap 'kill $memp 2>/dev/null' EXIT
t0=$(date +%s)
step() {
  local name="$1"; shift
  local s=$(date +%s)
  echo "== $name"
  if "$@" >"$logs/$label-$name.log" 2>&1; then echo "   ok ($(( $(date +%s) - s ))s)"; grep -h "^TIMEOUT-RETRY" "$logs/$label-$name.log" || true; else
    echo "RED: $name after $(( $(date +%s) - s ))s (log: $logs/$label-$name.log)"; tail -80 "$logs/$label-$name.log"; exit 1; fi
}
skip() { echo "== $1 (skipped: $2)"; }
has() { [ -e "$1" ]; }

changed_lint() {
  local files
  files=$(git diff --name-only --diff-filter=ACMR "$since" -- '*.ts' '*.tsx' '*.js' '*.mjs' | grep -v '\.generated\.ts$' | grep -v '^packages/db/migrations/' || true)
  [ -z "$files" ] && { echo "no changed lintable files"; return 0; }
  # shellcheck disable=SC2086
  pnpm exec eslint --no-warn-ignored $files
}
# Known-red test files (docs/build/known-red.txt: "<repo path> <fixer id> <reason>") are excluded
# until their fixer lands; every exclusion is printed so it never goes unnoticed.
known_red_excludes() {
  local ws="$1"
  [ -f docs/build/known-red.txt ] || return 0
  grep -v '^#' docs/build/known-red.txt | awk -v ws="$ws/" '$1 ~ "^"ws {sub("^"ws, "", $1); printf " --exclude %s", $1}'
}
# One workspace's Vitest run. When it is red and every failed file failed on a timeout (CPU
# contention from the parallel agents), exactly those files are re-run once, alone, and accepted
# only if they pass (OD-13). Any other failure stays red.
vitest_ws() {
  local ws="$1" root="$PWD" rep files; shift
  rep="$root/$logs/$label-timeouts-${ws//\//-}.json"; rm -f "$rep"
  if (cd "$ws" && BEAM_TIMEOUT_REPORT="$rep" pnpm exec vitest run "$@" --reporter=default --reporter="$root/scripts/build/timeout-reporter.mjs"); then return 0; fi
  files=$(node scripts/build/timeout-reporter.mjs --retryable "$rep" "$ws") || return 1
  echo "--- only timeouts failed in $ws; re-running alone: $files"
  # shellcheck disable=SC2086
  (cd "$ws" && pnpm exec vitest run --maxWorkers=1 --passWithNoTests $files) || return 1
  echo "TIMEOUT-RETRY green in $ws: $files"
}
changed_tests() {
  local ws dir rc=0 ex out root_logs="$PWD/$logs"
  for ws in apps/web packages/db packages/core packages/email packages/integrations packages/ui packages/config; do
    [ -e "$ws/vitest.config.ts" ] || continue
    if git diff --quiet "$since" -- "$ws"; then continue; fi
    ex=$(known_red_excludes "$ws")
    echo "--- vitest --changed in $ws${ex:+ (known red excluded:$ex)}"
    out="$root_logs/$label-changed-${ws//\//-}.out"
    # shellcheck disable=SC2086
    vitest_ws "$ws" --changed "$since" --passWithNoTests $ex 2>&1 | tee "$out"
    if [ "${PIPESTATUS[0]}" -ne 0 ]; then rc=1
    elif grep -q "No affected test files found" "$out" && git diff --name-only "$since" -- "$ws" | grep -qE '\.(ts|tsx|mts|mjs|js)$'; then
      # Sources changed but nothing was selected: never trust an empty selection (OD-14).
      echo "--- no affected test files although $ws sources changed; running all of $ws"
      # shellcheck disable=SC2086
      vitest_ws "$ws" --passWithNoTests $ex || rc=1
    fi
    rm -f "$out"
  done
  return $rc
}
all_tests() {
  local ws rc=0 ex
  for ws in apps/web packages/db packages/core packages/email packages/integrations packages/ui packages/config; do
    [ -e "$ws/vitest.config.ts" ] || continue
    ex=$(known_red_excludes "$ws")
    echo "--- vitest in $ws${ex:+ (known red excluded:$ex)}"
    # shellcheck disable=SC2086
    vitest_ws "$ws" --passWithNoTests $ex || rc=1
  done
  return $rc
}

step install pnpm install --offline --frozen-lockfile
if has apps/web/scripts/gen-indexes.ts; then step gen pnpm gen:indexes; else skip gen "no generator yet"; fi
step check-migr pnpm db:check-migrations
if has packages/db/scripts/views-sql.ts; then step views pnpm db:views --check; else skip views "no views script yet"; fi
if has packages/db/scripts/append-only-sql.ts; then step append-only pnpm db:append-only --check; else skip append-only "no append-only script yet"; fi
step migr-db pnpm --filter @beam/db test:migrations
step typecheck pnpm typecheck
if has eslint.config.js; then
  if [ "$mode" = merge ]; then step lint changed_lint; else step lint pnpm lint; fi
else skip lint "no eslint config yet"; fi
if has packages/core/scripts/i18n-check.ts; then step i18n pnpm i18n:check; else skip i18n "no i18n check yet"; fi
if [ -s docs/build/known-red.txt ] && grep -qv '^#' docs/build/known-red.txt; then echo "   known red (excluded until their fixer lands):"; grep -v '^#' docs/build/known-red.txt | sed 's/^/     /'; fi
if [ "$mode" = merge ]; then step test changed_tests; else step test all_tests; fi
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
