#!/usr/bin/env bash
# Land one finished package (OD-3): record done, ownership check and merge, migration when the
# schema changed, gate; green -> record merged, remove the worktree, log, commit, push;
# red -> undo the merge with git reset --keep and mark the package red.
#   scripts/build/land.sh <id> <branch-sha> [minutes] [gate-mode: merge|quick|full]
set -uo pipefail
cd "$(dirname "$0")/../.."
id="$1"; sha="$2"; minutes="${3:-}"; mode="${4:-merge}"
if [ -n "$(git status --porcelain --untracked-files=no | grep -v ' docs/build/state.json$')" ]; then echo "dirty tree:"; git status --short; exit 2; fi
node scripts/build/state.mjs done "$id" "$sha" $minutes >/dev/null
pre=$(git rev-parse --short HEAD)
last=$(ls docs/build/logs 2>/dev/null | sed -nE 's#^g([0-9]+)-.*#\1#p' | sort -n | tail -1)
label=$(printf 'g%02d-%s' $(( 10#${last:-0} + 1 )) "$id")
echo "== land $id ($sha) on $pre as $label"
scripts/build/merge.sh "$id" >/tmp/beam-merge.log 2>&1 || { tail -15 /tmp/beam-merge.log; node scripts/build/state.mjs set "$id" status red >/dev/null; echo "MERGE FAILED"; exit 3; }
wave=$(node -e "const p=require('./docs/plan/build-packages.json');const s=require('./docs/build/state.json');const id='$id';const k=p.packages.find(x=>x.id===id);const w=k?k.wave:(p.packages.find(x=>x.id===(s.packages[id]?.from||[])[0])?.wave??99);console.log(String(w).padStart(2,'0'))")
if ! git diff --quiet "$pre" HEAD -- packages/db/src/schema; then
  scripts/build/migrate-step.sh "w$wave" || { git reset -q --keep "$pre"; node scripts/build/state.mjs set "$id" status red >/dev/null; echo "MIGRATION FAILED; undone to $pre"; exit 4; }
fi
if scripts/build/gate.sh "$mode" "$label" "$pre"; then
  m=$(git log --merges -1 --format=%h)
  node scripts/build/state.mjs merged "$id" "$m" >/dev/null
  w=$(git worktree list --porcelain | awk -v b="refs/heads/build/$id" '$1=="worktree"{w=$2} $1=="branch" && $2==b {print w}')
  [ -n "$w" ] && git worktree remove --force "$w"; git worktree prune
  mig=$(git diff --name-only "$pre" HEAD -- packages/db/migrations | grep '\.sql$' | xargs -r -n1 basename | paste -sd' ' -)
  peak=$(sort -n "docs/build/logs/$label-mem.log" 2>/dev/null | tail -1)
  echo "- $id: ${minutes:+$minutes min, }merged as \`$m\`${mig:+, migrations $mig}; gate \`$label\` ($mode) green, peak ${peak:-?} MB." >> docs/build/wave-log.md
  git add docs/build && git commit -q -m "build: $id merged

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01X2PxHy6ScckZAnxuNtmbHY"
  scripts/build/push.sh >/dev/null && echo "LANDED $id as $m (pushed)" || echo "LANDED $id as $m (push failed, retry later)"
else
  git reset -q --keep "$pre"; node scripts/build/state.mjs set "$id" status red >/dev/null
  echo "RED: $id undone to $pre; logs docs/build/logs/$label-*.log"; exit 1
fi
