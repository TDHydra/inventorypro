#!/usr/bin/env bash
# Stop hook: remind Claude to reconcile the board when a commit landed this turn.
# Silent on conversational turns. Records the SHA before signalling, so it fires
# at most once per commit and can never loop.
set -euo pipefail

cd "${CLAUDE_PROJECT_DIR:-$PWD}" || exit 0
git rev-parse --git-dir >/dev/null 2>&1 || exit 0

branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
[ "$branch" = "main" ] && exit 0
[ -z "$branch" ] && exit 0

head=$(git rev-parse HEAD 2>/dev/null || exit 0)
seen_file="$(git rev-parse --git-dir)/board-last-seen"
seen=$(cat "$seen_file" 2>/dev/null || echo "")

[ "$head" = "$seen" ] && exit 0

# Record BEFORE signalling: if we exit 2 first and the write never happens,
# the next Stop fires again on the same SHA and the session cannot end.
printf '%s' "$head" > "$seen_file"

subject=$(git log -1 --format=%s)
cat >&2 <<EOF
A commit landed this turn: ${head:0:8} — ${subject}

Reconcile the board (skill: board). Which item does this commit belong to?
  - Move it to 'In progress' or 'In review' if that reflects reality (no need to ask).
  - If the work is finished AND you hotloaded the dev APK and the user confirmed it
    works, run gh_done.py. Otherwise propose Done and wait.
  - If this commit revealed new work, gh_add.py it.
EOF
exit 2
