#!/usr/bin/env bash
# Merge finished package branches into the integration branch (section 5.3, per batch).
#   scripts/build/merge.sh <id> [<id>...]
# Checks ownership of each branch against its recorded base, then merges with --no-ff.
# Prints the pre-merge commit so a red gate can be undone with: git reset --keep <sha>
set -euo pipefail
cd "$(dirname "$0")/../.."
pre=$(git rev-parse HEAD)
echo "pre-merge: $pre"
for id in "$@"; do
  git rev-parse --verify -q "build/$id" >/dev/null || { echo "missing branch build/$id"; exit 2; }
  base=$(node -e "const s=require('./docs/build/state.json');console.log(s.packages['$id']?.baseSha||'')")
  [ -n "$base" ] || { echo "no base recorded for $id"; exit 2; }
  node scripts/build/ownership.mjs --check "$id" "$base" "build/$id" || { echo "OWNERSHIP $id"; exit 4; }
  wave=$(node -e "const p=require('./docs/plan/build-packages.json');console.log(p.packages.find(x=>x.id==='$id')?.wave??'fix')")
  if ! git merge --no-ff --no-edit -m "merge: $id (wave $wave)" "build/$id"; then
    # OD-16: parallel fixers each delete their own known-red line; that file merges as a set.
    # OD-17: message catalogues merge key by key; any other conflicted file stays a conflict.
    conflicted=$(git diff --name-only --diff-filter=U)
    other=$(echo "$conflicted" | grep -vE '^(docs/build/known-red\.txt|packages/core/src/i18n/messages/[^/]+/[^/]+\.json)$' || true)
    if [ -z "$other" ]; then
      ok=1
      if echo "$conflicted" | grep -qx 'docs/build/known-red.txt'; then node scripts/build/merge-known-red.mjs || ok=0; fi
      cats=$(echo "$conflicted" | grep -E '^packages/core/src/i18n/messages/' || true)
      if [ -n "$cats" ] && [ $ok = 1 ]; then node scripts/build/merge-catalogues.mjs $cats || ok=0; fi
      if [ $ok = 1 ]; then git add $conflicted && git commit -q --no-edit && continue; fi
    fi
    echo "CONFLICT in $id"; git diff --name-only --diff-filter=U; git merge --abort; exit 3
  fi
done
echo "merged: $*"
