#!/usr/bin/env bash
# Generate the migration for the schema changes merged since the last one (section 5.3).
#   scripts/build/migrate-step.sh <name>      for example w04 (views: w04_views, protect: w04_protect)
# Commits packages/db/migrations when something was generated. Never answers a rename prompt.
set -euo pipefail
name="$1"
cd "$(dirname "$0")/../.."
[ -e apps/web/scripts/gen-indexes.ts ] && pnpm gen:indexes >/dev/null
before=$(ls packages/db/migrations/*.sql 2>/dev/null | wc -l)
out=$(timeout 600 pnpm --filter @beam/db exec drizzle-kit generate --name "$name" </dev/null 2>&1) || { echo "$out"; echo "drizzle-kit generate failed (a rename or drop prompt means a fixer must add a column instead)"; exit 1; }
echo "$out" | tail -5
new=$(ls -t packages/db/migrations/*_"$name".sql 2>/dev/null | head -1 || true)
if [ -e packages/db/scripts/views-sql.ts ]; then pnpm db:views --migration "${name}_views" | tail -5; fi
if [ -n "$new" ] && [ -e packages/db/src/schema/_shared.ts ]; then
  tables=$(node -e "const s=require('fs').readFileSync('packages/db/src/schema/_shared.ts','utf8');const m=s.match(/APPEND_ONLY_TABLES[^=]*=\\s*\\[([^\\]]*)\\]/);console.log(m?[...m[1].matchAll(/['\"]([a-z_]+)['\"]/g)].map(x=>x[1]).join('|'):'')")
  if [ -n "$tables" ] && grep -Eq "CREATE TABLE \"($tables)\"" "$new"; then
    timeout 300 pnpm --filter @beam/db exec drizzle-kit generate --custom --name "${name}_protect" </dev/null | tail -2
    echo "select beam_protect_append_only();" > "$(ls -t packages/db/migrations/*_"${name}"_protect.sql | head -1)"
  fi
fi
pnpm db:check-migrations
after=$(ls packages/db/migrations/*.sql 2>/dev/null | wc -l)
if [ "$after" -gt "$before" ]; then
  git add packages/db/migrations && git commit -q -m "db: migration $name" && echo "committed $((after - before)) migration file(s) for $name"
else
  echo "no schema changes for $name"
fi
