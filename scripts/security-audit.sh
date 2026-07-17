#!/usr/bin/env bash
# Dependency + artifact security audit.
#   1. `pnpm audit --prod` per workspace (advisories are reported, not fatal
#      per-workspace — the combined exit code is returned at the end).
#   2. When an artifact path (APK/AAB, optionally web dist dir) is passed,
#      delegates to check-bundle-secrets.sh.
#
# Usage: ./security-audit.sh [app.apk|app.aab] [web-dist-dir]
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARTIFACT="${1:-}"
WEB_DIST="${2:-}"
# A lone directory argument is a web dist, not an APK/AAB.
if [[ -n "$ARTIFACT" && -d "$ARTIFACT" && -z "$WEB_DIST" ]]; then
  WEB_DIST="$ARTIFACT"
  ARTIFACT=""
fi
STATUS=0

for ws in apps/mobile apps/api; do
  echo "=== pnpm audit --prod ($ws) ==="
  if ! (cd "$ROOT/$ws" && pnpm audit --prod); then
    echo "--- advisories found in $ws (continuing) ---" >&2
    STATUS=1
  fi
  echo
done

if [[ -n "$ARTIFACT" ]]; then
  echo "=== bundle secret scan ==="
  if ! "$ROOT/scripts/check-bundle-secrets.sh" "$ARTIFACT" ${WEB_DIST:+"$WEB_DIST"}; then
    STATUS=1
  fi
elif [[ -n "$WEB_DIST" ]]; then
  echo "=== web dist secret scan ==="
  if ! "$ROOT/scripts/check-bundle-secrets.sh" --web-only "$WEB_DIST"; then
    STATUS=1
  fi
fi

if [[ $STATUS -ne 0 ]]; then
  echo "security audit FAILED (see above)" >&2
else
  echo "security audit passed"
fi
exit $STATUS
