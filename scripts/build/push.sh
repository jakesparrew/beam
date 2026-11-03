#!/usr/bin/env bash
# Push the integration branch with a per-attempt timeout and backoff (2, 4, 8, 16 s).
cd "$(dirname "$0")/../.."
for i in 1 2 3 4 5; do
  if timeout 90 git push -u origin claude/focused-hopper-gpky3y >/tmp/beam-push.log 2>&1; then tail -1 /tmp/beam-push.log; exit 0; fi
  echo "push attempt $i failed: $(tail -1 /tmp/beam-push.log)"; sleep $((2**i))
done
exit 1
