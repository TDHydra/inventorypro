---
name: start-metro
description: Start or restart the InventoryPro Metro dev server cleanly. Kills any Metro/Expo instance squatting on ports 8081-8085 (including ones started from sibling worktrees), starts a fresh detached server, health-checks it, and wires adb reverse for the dev client. Use whenever the user says "start metro", "restart metro", "metro is stuck", "port 8081 is in use", "bundle won't load", "hotload the app", or before any on-device dev-client testing session — and whenever YOU need Metro running (e.g. after switching branches/worktrees or when a phase requires hotload verification). Prefer this over hand-rolling expo start commands; it avoids every known Metro pitfall in this repo.
---

# start-metro

One command replaces the whole kill-find-restart-reverse dance:

```bash
.claude/skills/start-metro/scripts/start-metro.sh
```

All options are environment variables — compose any Metro setup:

| Variable | Default | Meaning |
|---|---|---|
| `METRO_PORT` | `8081` | Port to start Metro on (keep within 8081-8085) |
| `APP_DIR` | auto | Expo app dir. Auto-detects `$PWD/apps/mobile`, else falls back to `~/projects/InventoryPro/apps/mobile`. **Set this explicitly when serving a worktree** (e.g. `APP_DIR=~/projects/InventoryPro-reactivity/apps/mobile`) |
| `SCAN_FROM` / `SCAN_TO` | `8081` / `8085` | Port range scanned for existing Metro instances to kill |
| `CLEAR` | `1` | `1` → `--clear` (reset bundler cache) |
| `DEV_CLIENT` | `1` | `1` → `--dev-client` |
| `ADB_REVERSE` | `1` | `1` → `adb reverse tcp:8081 tcp:$METRO_PORT` (device always dials 8081) |
| `EXTRA_ARGS` | | Extra flags appended to `expo start` (e.g. `"--host lan"`, `"--web"`) |
| `LOG_FILE` | `/tmp/metro-<port>.log` | Where server output goes |
| `WAIT_SECS` | `90` | Health-check timeout |
| `EXPO_PUBLIC_API_URL` | `https://api.invenpro.app` | Baked into the bundle; without it the app syncs against the dead localhost:3000 stack |

Examples:

```bash
# Serve a specific worktree on the default port
APP_DIR=~/projects/InventoryPro-reactivity/apps/mobile .claude/skills/start-metro/scripts/start-metro.sh

# Second instance on 8082 without nuking caches
METRO_PORT=8082 CLEAR=0 .claude/skills/start-metro/scripts/start-metro.sh
```

## What it does

1. Scans ports `SCAN_FROM`-`SCAN_TO`; kills only listeners whose cmdline looks like Metro/Expo (non-Metro servers are left alone with a warning).
2. Starts `npx expo start` detached via `nohup` (never with `CI=1` — that breaks the dev server).
3. Waits for `http://localhost:$METRO_PORT/status` to report `packager-status:running` — this endpoint is the source of truth, **not** the CLI process.
4. Sets `adb reverse tcp:8081 tcp:$METRO_PORT` so the dev client reaches whichever port was chosen. Warns instead of failing when no phone is attached.

## Known gotchas this script already accounts for

- **The expo CLI wrapper often dies (exit 137) with a React Native DevTools `chrome-sandbox` FATAL on this machine while Metro keeps serving.** That's why health = `/status`, not the process. Permanent fix needs sudo: `sudo chown root:root '<path>/chrome-sandbox' && sudo chmod 4755 '<path>/chrome-sandbox'` (path is in the FATAL message).
- **Sibling worktrees steal 8081**: a Metro from another checkout means the phone silently loads the WRONG code. The kill-scan handles it; after starting, the script's log (`Starting project at ...`) tells you which checkout is being served.
- `adb reverse` drops on unplug/reboot — "failed to load bundle" on device usually means re-run this script (or just the adb reverse line), not a broken bundle.
- After a force-stop the dev client may open its launcher screen instead of auto-connecting; the user then taps the `localhost:8081` entry on the phone. Do not blind-tap the phone.
- Dev-client deep link scheme is **`exp+inventorypro://`**, NOT `com.inventorypro.app://` (the latter fails with "unable to resolve Intent"). Launch: `adb shell am start -a android.intent.action.VIEW -d "exp+inventorypro://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081"`.
- The full hotload lore (release-vs-debug builds, data-wipe traps, stale-cache symptoms) lives in the `project_inventorypro_dev_hotload` memory and `deploy-android` skill §B.
