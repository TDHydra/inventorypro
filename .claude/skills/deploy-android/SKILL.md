---
name: deploy-android
description: Build and deploy the InventoryPro Android app — a local debug dev-client (Metro), a local release APK for field use, or an EAS cloud build for the Play Store. Use when the user wants an Android build/install/release.
---

# Deploy InventoryPro — Android

Working dir: `~/inventorypro/apps/mobile`. Target device: **Samsung S24 Ultra** (`R5CXA06AQQM`) — always deploy/test on this one. (The Pixel `58060DLCQ001ZR` screen is broken; do NOT use it.) Env in `~/.bashrc` (JAVA_HOME=~/jdk Temurin 21, ANDROID_HOME=~/Android/Sdk).

## Gotchas (always)
- **Gradle pinned to 8.13** in `android/gradle/wrapper/gradle-wrapper.properties`. `npx expo prebuild --clean` resets it to 9.3.1 → re-pin afterward (`sed -i 's#gradle-9.3.1-bin.zip#gradle-8.13-bin.zip#' android/gradle/wrapper/gradle-wrapper.properties`).
- **pnpm only.** Never run `npm install` / `npx expo install` without reconciling: `rm -f package-lock.json && pnpm install`, then verify `pnpm install --frozen-lockfile --filter api...` says "Lockfile is up to date".
- Release & debug builds use the **same applicationId** `com.inventorypro.app`. If `adb install -r` fails on signature, `adb uninstall com.inventorypro.app` first (wipes local data — it re-syncs from prod).
- A new **native dep** just needs a rebuild (`./gradlew assembleDebug` + `adb install -r`) — Expo **autolinking** picks it up, NO `prebuild` needed (confirmed 2026-07-18 adding `react-native-keyboard-controller` with only `pnpm --filter mobile add …` + `assembleDebug`). Run `prebuild` ONLY when a dep ships a config plugin / needs `app.json` native changes — and re-pin gradle afterward. JS-only changes need no rebuild at all.
- `EXPO_PUBLIC_API_URL` is **baked at bundle time** for release (set it on the gradle command); for the dev client it's read from the Metro process env.

## A. Field-use release APK (points at prod)
```bash
cd ~/inventorypro/apps/mobile/android
EXPO_PUBLIC_API_URL=https://api.invenpro.app ./gradlew assembleRelease
cp app/build/outputs/apk/release/app-release.apk ~/inventorypro/inventorypro-preview.apk
adb install -r ~/inventorypro/inventorypro-preview.apk   # uninstall first if signature mismatch
```
Verify: `unzip -p app/build/outputs/apk/release/app-release.apk assets/index.android.bundle | strings | grep -o api.invenpro.app` (URL baked) and `aapt2 dump permissions ...apk | grep POST_NOTIFICATIONS` (native perms present).

## B. Debug dev-client (for live debugging via Metro + hot reload)

**JS-only change + dev-client already installed?** Skip `assembleDebug` entirely — just (re)start Metro and cold-launch the app (steps 1-4 below). Only run `assembleDebug` + `adb install -r` for a native change (new native dep) or a first install.

```bash
# 0. (native change / first install only) build + install the debug dev-client
cd ~/inventorypro/apps/mobile/android && ./gradlew assembleDebug   # do NOT run Metro concurrently — file-watcher race
adb install -r app/build/outputs/apk/debug/app-debug.apk           # uninstall release first if signature mismatch

# 1. ALWAYS free port 8081 first — a prior Metro/watcher lingers almost every hotload.
#    `fuser -k` (by PORT) is the reliable one; the real Metro process is
#    `node …/expo/bin/cli start …` and does NOT contain the string "expo start",
#    so `pkill -f "expo start"` MISSES it — use `expo/bin/cli start`. Loop until free.
for _ in 1 2 3; do fuser -k 8081/tcp 2>/dev/null; pkill -9 -f 'expo/bin/cli start' 2>/dev/null; sleep 1; fuser 8081/tcp 2>/dev/null || break; done
fuser 8081/tcp 2>/dev/null && echo "8081 STILL busy — kill the printed pid manually" || echo "8081 free"

# 2. reverse the port to the device
adb reverse tcp:8081 tcp:8081

# 3. start Metro non-interactively (stdin from /dev/null is enough — do NOT set CI=1:
#    CI=1 FREEZES the file watcher, so every JS edit after startup serves a stale bundle
#    and hot reload silently never happens; this has burned us twice). ALWAYS pass --clear:
#    Metro's transform cache otherwise serves a STALE bundle — a new migration/module
#    silently won't load (e.g. app logs "schema vN ready" one version behind, migration skipped).
cd ~/inventorypro/apps/mobile
EXPO_PUBLIC_API_URL=https://api.invenpro.app nohup npx expo start --dev-client --localhost --port 8081 --clear </dev/null >/tmp/metro.log 2>&1 &
# wait for "Waiting on http://localhost:8081" in /tmp/metro.log (first --clear build takes ~1 min)

# 4. COLD-launch (force-stop first) so DB migrations re-run on startup:
adb shell am force-stop com.inventorypro.app
adb shell am start -a android.intent.action.VIEW -d "exp+inventorypro://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081" com.inventorypro.app
```
Verify: `adb logcat` shows `[DB] ✓ SQLite migration vN applied` / `schema vN ready` (for a migration) and no red box. The "React Native DevTools chrome-sandbox" error in Metro output is harmless. Read JS errors via `adb logcat ReactNativeJS:* '*:S'`. On-device SQLite check: `adb exec-out run-as com.inventorypro.app cat /data/data/com.inventorypro.app/databases/inventorypro.sqlite > /tmp/dev.sqlite` then inspect with python3/sqlite3 (schema_version lives in `app_settings`, key `schema_version`).

### ⚠️ Running Metro from inside Claude Code (agent harness) — learned 2026-07-18
The shell in the Claude Code agent harness is sandboxed and reaps background process-groups, so the `nohup … &` detach in step 3 above **does not survive** here (Metro reaches "Waiting on http://localhost:8081" then gets `Killed` a few seconds later, and the launching Bash call returns a spurious `exit 1` with empty output). Rules that actually work in this harness:
- **Launch Metro as a `run_in_background: true` Bash call with the `npx expo start …` command in the job's FOREGROUND — no trailing `&`, no `exec`, no `nohup`/`setsid`, no `disown`.** Double-backgrounding (`run_in_background` **and** `&`) is what gets it SIGKILL'd when the wrapper shell exits.
- **Set `dangerouslyDisableSandbox: true`** on that call (and on the adb/curl calls that drive it). The sandbox otherwise silently blocks the socket bind / `fuser -k` / `pkill` and you get `exit 1` with no output.
- **Foreground `sleep` is blocked** by the harness ("use Monitor with an until-loop"). So the `for … sleep 1 … done` port-free loop and any readiness wait must live INSIDE the backgrounded job, or use `until curl -s -o /dev/null -w '%{http_code}' http://localhost:8081/status | grep -q 200; do sleep 2; done` (sleep inside an `until` is allowed).
- **Do NOT trust the job's exit code** to decide if Metro is up — it often reports failed/`exit 1` while Metro is actually serving. Confirm readiness with `curl … :8081/status` == `200` locally AND device-side `adb shell curl -s -o /dev/null -w '%{http_code}' http://localhost:8081/status` == `200`.
- Don't prefix every follow-up command with `pkill -f 'expo/bin/cli start'` — it kills the Metro you just started. Kill once, before the launch, then leave it alone.
- Once the dev client has fetched+built the first bundle and rendered (`ReactNativeJS: …` / `Running "main"` in logcat), the JS runs in-memory; if Metro later dies you only lose HMR, so a screenshot-based on-device verification still succeeds. First `--clear` build takes ~1 min — keep Metro alive that long before launching the deep link.
- On this device the keyboard-controller edge-to-edge log line `com.reactnativekeyboardcontroller.modules.statusbar.StatusBarManagerCompatModuleImpl: Ignored status bar change, current activity is edge-to-edge` is normal (the native module loaded), not an error.

## C. Play Store (EAS cloud build) — when Google API/signing is set up
EAS project: `@tdhydra/inventorypro` (id d4244438-0520-46c3-9ad1-fd5da43f7f86). `eas.json` `preview`/`production` profiles set `EXPO_PUBLIC_API_URL=https://api.invenpro.app`.
```bash
cd ~/inventorypro/apps/mobile
eas build --platform android --profile production   # AAB for the Play Store
# eas submit --platform android   # once the Play Console + service account are configured
```

After any deploy, remind: the device must sync once (or has wiped data after an uninstall → re-login → first-launch full download).
