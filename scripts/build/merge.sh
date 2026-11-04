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
    if [ "$(git diff --name-only --diff-filter=U)" = "docs/build/known-red.txt" ] && node scripts/build/merge-known-red.mjs; then
      git add docs/build/known-red.txt && git commit -q --no-edit && continue
    fi
    echo "CONFLICT in $id"; git diff --name-only --diff-filter=U; git merge --abort; exit 3
  fi
done
echo "merged: $*"
