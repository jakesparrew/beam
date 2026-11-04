#!/usr/bin/env bash
# Land several finished packages with one gate (OD-3 batches).
#   scripts/build/land-batch.sh <id>:<sha>[:<minutes>] ...
# Merges each (ownership check), generates one migration for the batch, runs one merge gate.
# Green: records every package merged, removes worktrees, logs, commits, pushes.
# Red: undoes the whole batch, then lands the packages one by one with land.sh to find the culprit.
set -uo pipefail
cd "$(dirname "$0")/../.."
if [ -n "$(git status --porcelain --untracked-files=no | grep -v ' docs/build/state.json$')" ]; then echo "dirty tree:"; git status --short; exit 2; fi
ids=(); for spec in "$@"; do IFS=: read -r id sha min <<<"$spec"; ids+=("$id"); node scripts/build/state.mjs done "$id" "$sha" ${min:-} >/dev/null; done
pre=$(git rev-parse --short HEAD)
last=$(ls docs/build/logs 2>/dev/null | sed -nE 's#^g([0-9]+)-.*#\1#p' | sort -n | tail -1)
label=$(printf 'g%02d-batch' $(( 10#${last:-0} + 1 )))
echo "== batch ${ids[*]} on $pre as $label"
merged=()
for id in "${ids[@]}"; do
  if scripts/build/merge.sh "$id" >/tmp/beam-merge.log 2>&1; then merged+=("$id"); else echo "merge failed for $id:"; tail -8 /tmp/beam-merge.log; node scripts/build/state.mjs set "$id" status red >/dev/null; fi
done
[ ${#merged[@]} -gt 0 ] || { echo "nothing merged"; exit 3; }
wave=$(node -e "const p=require('./docs/plan/build-packages.json');const ids=process.argv.slice(1);console.log(String(Math.max(...ids.map(i=>p.packages.find(x=>x.id===i)?.wave??0))).padStart(2,'0'))" "${merged[@]}")
if ! git diff --quiet "$pre" HEAD -- packages/db/src/schema; then
  scripts/build/migrate-step.sh "w$wave" || { git reset -q --keep "$pre"; echo "MIGRATION FAILED; batch undone"; exit 4; }
fi
if scripts/build/gate.sh merge "$label" "$pre"; then
  peak=$(sort -n "docs/build/logs/$label-mem.log" 2>/dev/null | tail -1)
  mig=$(git diff --name-only "$pre" HEAD -- packages/db/migrations | grep '\.sql$' | xargs -r -n1 basename | paste -sd' ' -)
  for id in "${merged[@]}"; do
    m=$(git log --merges --format='%h %s' "$pre"..HEAD | awk -v id="$id" '$0 ~ "merge: "id" " {print $1; exit}')
    node scripts/build/state.mjs merged "$id" "$m" >/dev/null
    w=$(git worktree list --porcelain | awk -v b="refs/heads/build/$id" '$1=="worktree"{w=$2} $1=="branch" && $2==b {print w}')
    [ -n "$w" ] && git worktree remove --force "$w"
    echo "- $id: merged as \`$m\` in batch \`$label\`." >> docs/build/wave-log.md
  done
  git worktree prune
  echo "- Batch \`$label\` (${merged[*]}): ${mig:+migrations $mig; }merge gate green, peak ${peak:-?} MB." >> docs/build/wave-log.md
  git add docs/build && git commit -q -m "build: merged ${merged[*]}

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01X2PxHy6ScckZAnxuNtmbHY"
  scripts/build/push.sh >/dev/null && echo "LANDED ${merged[*]} (pushed)" || echo "LANDED ${merged[*]} (push failed)"
else
  git reset -q --keep "$pre"
  echo "RED batch: undone to $pre; landing one by one"
  for spec in "$@"; do IFS=: read -r id sha min <<<"$spec"; [[ " ${merged[*]} " == *" $id "* ]] || continue; scripts/build/land.sh "$id" "$sha" "${min:-}" 2>&1 | grep -E "^(LANDED|RED|MERGE|MIGRATION|== land)"; done
fi
