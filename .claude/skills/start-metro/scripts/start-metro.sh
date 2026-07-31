#!/usr/bin/env bash
# start-metro.sh — kill any Metro/Expo dev servers on ports 8081-8085, then
# start a fresh one, detached, with a real health check.
#
# Every knob is an env variable so callers can compose any Metro setup:
#   METRO_PORT=8083 CLEAR=0 EXTRA_ARGS="--host lan" ./start-metro.sh
#
# Exit code reflects Metro's actual health (/status endpoint), NOT the expo CLI
# wrapper process: on this machine the wrapper regularly dies from a React
# Native DevTools chrome-sandbox FATAL while the Metro bundler it spawned keeps
# serving fine. Never gate on the wrapper.
set -uo pipefail

METRO_PORT="${METRO_PORT:-8081}"    # port to start Metro on (8081-8085)
APP_DIR="${APP_DIR:-}"              # Expo app dir; auto-detected when empty
SCAN_FROM="${SCAN_FROM:-8081}"      # kill-scan range start
SCAN_TO="${SCAN_TO:-8085}"          # kill-scan range end
CLEAR="${CLEAR:-1}"                 # 1 → pass --clear (reset bundler cache)
DEV_CLIENT="${DEV_CLIENT:-1}"       # 1 → pass --dev-client
ADB_REVERSE="${ADB_REVERSE:-1}"     # 1 → map device-side 8081 → host METRO_PORT
EXTRA_ARGS="${EXTRA_ARGS:-}"        # extra flags appended to `expo start`
LOG_FILE="${LOG_FILE:-/tmp/metro-${METRO_PORT}.log}"
WAIT_SECS="${WAIT_SECS:-90}"        # how long to wait for /status
# Without this the app silently syncs against the ancient localhost:3000 Docker
# stack (burned us before — see project_inventorypro_dev_hotload memory).
export EXPO_PUBLIC_API_URL="${EXPO_PUBLIC_API_URL:-https://api.invenpro.app}"

if [ "$METRO_PORT" -lt "$SCAN_FROM" ] || [ "$METRO_PORT" -gt "$SCAN_TO" ]; then
  echo "WARN: METRO_PORT=$METRO_PORT is outside the managed range $SCAN_FROM-$SCAN_TO" >&2
fi

# --- Locate the app -----------------------------------------------------------
if [ -z "$APP_DIR" ]; then
  if [ -d "$PWD/apps/mobile" ]; then
    APP_DIR="$PWD/apps/mobile"
  elif [[ "$PWD" == */apps/mobile* ]]; then
    APP_DIR="${PWD%%/apps/mobile*}/apps/mobile"
  else
    APP_DIR="$HOME/projects/InventoryPro/apps/mobile"
  fi
fi
if [ ! -f "$APP_DIR/package.json" ]; then
  echo "ERROR: no package.json in APP_DIR=$APP_DIR" >&2
  exit 1
fi
echo "App dir: $APP_DIR"

# --- Kill existing Metro instances on $SCAN_FROM-$SCAN_TO ---------------------
# Only kills processes whose cmdline looks like Metro/Expo — a non-Metro server
# parked on one of these ports is left alone (with a warning) so we never
# torpedo something unrelated.
for port in $(seq "$SCAN_FROM" "$SCAN_TO"); do
  pids=$(ss -ltnp 2>/dev/null | awk -v p=":$port" '$4 ~ p"$"' | grep -oP 'pid=\K[0-9]+' | sort -u)
  for pid in $pids; do
    cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)
    if echo "$cmd" | grep -qiE 'metro|expo|react-native'; then
      echo "Killing Metro on :$port (pid $pid)"
      kill "$pid" 2>/dev/null
      for _ in 1 2 3 4 5; do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
      kill -9 "$pid" 2>/dev/null || true
    else
      echo "WARN: port $port held by non-Metro process (pid $pid: ${cmd:0:80}) — leaving it" >&2
    fi
  done
done

# --- Start Metro (detached) ---------------------------------------------------
args=(start --port "$METRO_PORT")
[ "$DEV_CLIENT" = "1" ] && args+=(--dev-client)
[ "$CLEAR" = "1" ] && args+=(--clear)
# shellcheck disable=SC2086  # EXTRA_ARGS is intentionally word-split
cd "$APP_DIR" && nohup npx expo "${args[@]}" $EXTRA_ARGS > "$LOG_FILE" 2>&1 &
echo "Launched: npx expo ${args[*]} $EXTRA_ARGS (log: $LOG_FILE, API: $EXPO_PUBLIC_API_URL)"
# Deliberately NOT setting CI=1 — it disables the interactive dev server.

# --- Health check: trust /status, not the wrapper process ---------------------
up=""
for _ in $(seq 1 "$WAIT_SECS"); do
  if curl -sf -m 2 "http://localhost:$METRO_PORT/status" | grep -q running; then up=1; break; fi
  sleep 1
done
if [ -z "$up" ]; then
  echo "ERROR: Metro did not report running on :$METRO_PORT within ${WAIT_SECS}s. Last log lines:" >&2
  tail -15 "$LOG_FILE" >&2
  exit 1
fi
echo "Metro RUNNING on http://localhost:$METRO_PORT"

# --- adb reverse: the dev client always dials device-side 8081 ---------------
if [ "$ADB_REVERSE" = "1" ] && command -v adb >/dev/null; then
  if adb get-state >/dev/null 2>&1; then
    adb reverse "tcp:8081" "tcp:$METRO_PORT" \
      && echo "adb reverse: device 8081 -> host $METRO_PORT" \
      || echo "WARN: adb reverse failed — run it manually after reconnecting the phone" >&2
  else
    echo "WARN: no adb device connected — remember 'adb reverse tcp:8081 tcp:$METRO_PORT' after plugging in" >&2
  fi
fi
echo "OK"
