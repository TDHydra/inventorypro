#!/usr/bin/env bash
# Keeps the USB reverse tunnels alive for the Pixel dev client, so the app never
# hits the "can't find Expo server" screen when USB/adb resets.
#   tcp:8081 -> Metro (JS bundle)
#   tcp:3000 -> Fastify API
# Usage: ./adb-tunnel-watch.sh [interval-seconds]   (default 5)

export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
export PATH="$PATH:$ANDROID_HOME/platform-tools"

PORTS=(8081 3000)
INTERVAL="${1:-5}"

echo "[tunnel-watch] started $(date '+%H:%M:%S') — ensuring tcp:8081 + tcp:3000 every ${INTERVAL}s"

while true; do
  # Only act when a single device is connected and authorized.
  if adb get-state >/dev/null 2>&1; then
    current="$(adb reverse --list 2>/dev/null)"
    for p in "${PORTS[@]}"; do
      if ! grep -q "tcp:$p tcp:$p" <<<"$current"; then
        if adb reverse "tcp:$p" "tcp:$p" >/dev/null 2>&1; then
          echo "[tunnel-watch] $(date '+%H:%M:%S') re-applied tcp:$p"
        fi
      fi
    done
  fi
  sleep "$INTERVAL"
done
