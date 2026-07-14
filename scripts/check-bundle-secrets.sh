#!/usr/bin/env bash
# Scans a built artifact for secrets that must never ship to clients.
# Extracts the JS bundle + dex files from an APK/AAB and greps them (plus an
# optional web dist dir) against a denylist: connection strings, MinIO/AWS key
# shapes, JWT-secret-ish literals, internal hostnames/IPs, PIN/backdoor markers.
# Exits non-zero when anything matches, printing every hit.
#
# Usage: ./check-bundle-secrets.sh <app.apk|app.aab> [web-dist-dir]
#        ./check-bundle-secrets.sh --web-only <web-dist-dir>
set -uo pipefail

usage() {
  echo "Usage: $0 <app.apk|app.aab> [web-dist-dir]" >&2
  echo "       $0 --web-only <web-dist-dir>" >&2
  exit 2
}

[[ $# -ge 1 ]] || usage

ARTIFACT=""
WEB_DIST=""
if [[ "$1" == "--web-only" ]]; then
  [[ $# -ge 2 ]] || usage
  WEB_DIST="$2"
else
  ARTIFACT="$1"
  WEB_DIST="${2:-}"
fi

# Denylist of patterns (extended regex, case-insensitive). Each is a shape that
# indicates a leaked credential or internal detail — not app strings.
DENYLIST=(
  'postgres(ql)?://'                          # DB connection strings
  'AKIA[0-9A-Z]{16}'                          # AWS access key id shape
  'minioadmin'                                # MinIO default credentials
  'MINIO_(ROOT_USER|ROOT_PASSWORD|ACCESS_KEY|SECRET_KEY)'
  'AWS_SECRET_ACCESS_KEY'
  'JWT_SECRET'
  'jwt[_-]?secret["'"'"':= ]+[A-Za-z0-9+/_-]{8,}'  # inlined jwt secret literal
  '192\.168\.[0-9]{1,3}\.[0-9]{1,3}'          # internal LAN IPs
  '10\.0\.30\.[0-9]{1,3}'                     # internal VLAN IPs
  'unraid'                                    # internal hostname
  'backdoor'
  'master[_-]?pin'
  'debug[_-]?pin'
)

FOUND=0

scan_stream() { # $1 = label; stdin = text to scan
  local label="$1" hits
  for pat in "${DENYLIST[@]}"; do
    hits=$(grep -Eio "$pat" <<<"$STREAM_BUF" | sort -u | head -20)
    if [[ -n "$hits" ]]; then
      FOUND=1
      echo "MATCH [$label] pattern '$pat':"
      sed 's/^/    /' <<<"$hits"
    fi
  done
}

scan_file_strings() { # $1 = file, $2 = label
  STREAM_BUF="$(strings -a "$1" 2>/dev/null || true)"
  scan_stream "$2"
}

if [[ -n "$ARTIFACT" ]]; then
  [[ -f "$ARTIFACT" ]] || { echo "artifact not found: $ARTIFACT" >&2; exit 2; }
  command -v strings >/dev/null || { echo "'strings' (binutils) is required" >&2; exit 2; }
  WORK=$(mktemp -d)
  trap 'rm -rf "$WORK"' EXIT

  # APK: assets/... at root; AAB: nested under base/. Pull both layouts.
  unzip -qq -o "$ARTIFACT" \
    'assets/index.android.bundle' 'classes*.dex' \
    'base/assets/index.android.bundle' 'base/dex/classes*.dex' \
    -d "$WORK" 2>/dev/null

  mapfile -t BUNDLES < <(find "$WORK" -name 'index.android.bundle')
  mapfile -t DEXES < <(find "$WORK" -name 'classes*.dex')
  if [[ ${#BUNDLES[@]} -eq 0 && ${#DEXES[@]} -eq 0 ]]; then
    echo "no JS bundle or dex files found inside $ARTIFACT — wrong file?" >&2
    exit 2
  fi
  for f in "${BUNDLES[@]}" "${DEXES[@]}"; do
    scan_file_strings "$f" "$(basename "$ARTIFACT")!${f#"$WORK"/}"
  done
fi

if [[ -n "$WEB_DIST" ]]; then
  [[ -d "$WEB_DIST" ]] || { echo "web dist dir not found: $WEB_DIST" >&2; exit 2; }
  # Text assets only; .wasm/.png etc. are binary noise (sql.js wasm trips 'strings').
  while IFS= read -r f; do
    STREAM_BUF="$(cat "$f")"
    scan_stream "web:${f#"$WEB_DIST"/}"
  done < <(find "$WEB_DIST" -type f \( -name '*.js' -o -name '*.html' -o -name '*.css' -o -name '*.json' -o -name '*.map' \))
fi

if [[ $FOUND -ne 0 ]]; then
  echo "FAIL: potential secrets found in shipped artifact(s)." >&2
  exit 1
fi
echo "OK: no denylisted secrets found."
