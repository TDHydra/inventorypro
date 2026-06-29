---
name: deploy-android
description: Build and deploy the InventoryPro Android app — a local debug dev-client (Metro), a local release APK for field use, or an EAS cloud build for the Play Store. Use when the user wants an Android build/install/release.
---

# Deploy InventoryPro — Android

Working dir: `~/inventorypro/apps/mobile`. Device id (Pixel): `58060DLCQ001ZR`. Env in `~/.bashrc` (JAVA_HOME=~/jdk Temurin 21, ANDROID_HOME=~/Android/Sdk).

## Gotchas (always)
- **Gradle pinned to 8.13** in `android/gradle/wrapper/gradle-wrapper.properties`. `npx expo prebuild --clean` resets it to 9.3.1 → re-pin afterward (`sed -i 's#gradle-9.3.1-bin.zip#gradle-8.13-bin.zip#' android/gradle/wrapper/gradle-wrapper.properties`).
- **pnpm only.** Never run `npm install` / `npx expo install` without reconciling: `rm -f package-lock.json && pnpm install`, then verify `pnpm install --frozen-lockfile --filter api...` says "Lockfile is up to date".
- Release & debug builds use the **same applicationId** `com.inventorypro.app`. If `adb install -r` fails on signature, `adb uninstall com.inventorypro.app` first (wipes local data — it re-syncs from prod).
- A new **native dep** (e.g. expo-notifications) requires `npx expo prebuild` (re-pin gradle) before the build picks it up. JS-only changes don't.
- `EXPO_PUBLIC_API_URL` is **baked at bundle time** for release (set it on the gradle command); for the dev client it's read from the Metro process env.

## A. Field-use release APK (points at prod)
```bash
cd ~/inventorypro/apps/mobile/android
EXPO_PUBLIC_API_URL=https://api.plexcontrol.com ./gradlew assembleRelease
cp app/build/outputs/apk/release/app-release.apk ~/inventorypro/inventorypro-preview.apk
adb install -r ~/inventorypro/inventorypro-preview.apk   # uninstall first if signature mismatch
```
Verify: `unzip -p app/build/outputs/apk/release/app-release.apk assets/index.android.bundle | strings | grep -o api.plexcontrol.com` (URL baked) and `aapt2 dump permissions ...apk | grep POST_NOTIFICATIONS` (native perms present).

## B. Debug dev-client (for live debugging via Metro + hot reload)
```bash
cd ~/inventorypro/apps/mobile/android && ./gradlew assembleDebug   # do NOT run Metro concurrently — file-watcher race
adb install -r app/build/outputs/apk/debug/app-debug.apk           # uninstall release first (signature)
adb reverse tcp:8081 tcp:8081
# Metro must run non-interactively (no TTY in automation): CI=1 + stdin from /dev/null
cd ~/inventorypro/apps/mobile
EXPO_PUBLIC_API_URL=https://api.plexcontrol.com CI=1 nohup npx expo start --dev-client --localhost --port 8081 </dev/null >/tmp/metro.log 2>&1 &
adb shell am start -a android.intent.action.VIEW -d "exp+inventorypro://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081" com.inventorypro.app
```
The "React Native DevTools chrome-sandbox" error in Metro output is harmless. Read JS errors via `adb logcat ReactNativeJS:* '*:S'` or the on-device red box.

## C. Play Store (EAS cloud build) — when Google API/signing is set up
EAS project: `@tdhydra/inventorypro` (id d4244438-0520-46c3-9ad1-fd5da43f7f86). `eas.json` `preview`/`production` profiles set `EXPO_PUBLIC_API_URL=https://api.plexcontrol.com`.
```bash
cd ~/inventorypro/apps/mobile
eas build --platform android --profile production   # AAB for the Play Store
# eas submit --platform android   # once the Play Console + service account are configured
```

After any deploy, remind: the device must sync once (or has wiped data after an uninstall → re-login → first-launch full download).
