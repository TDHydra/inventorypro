---
name: deploy-ios
description: Build and deploy the InventoryPro iOS app via EAS cloud build (TestFlight / App Store). Use when the user wants an iOS build. Requires an Apple Developer account + credentials (no local Mac needed — EAS builds in the cloud).
---

# Deploy InventoryPro — iOS

iOS builds require **EAS cloud build** (you have no Mac locally). EAS project: `@tdhydra/inventorypro`.

## Prerequisites (one-time, the user's "Apple stuff")
- An **Apple Developer Program** membership ($99/yr) → an App Store Connect app record (bundle id e.g. `com.inventorypro.app`).
- EAS handles signing: `eas credentials` (or it prompts on first build) provisions the distribution cert + provisioning profile from the Apple account.
- Set the iOS bundle identifier in `app.json` (`expo.ios.bundleIdentifier`) — add it if absent.
- Confirm `eas.json` has a `preview` (internal/ad-hoc) and `production` (App Store) profile; both should set `EXPO_PUBLIC_API_URL=https://api.invenpro.app` (mirror the Android profiles).

## Native-module check
The app uses expo-camera, expo-notifications (needs an APNs key in App Store Connect for push — local notifications work without it), expo-local-authentication (Face ID — ensure `NSFaceIDUsageDescription` is set; the expo-local-authentication plugin in app.json already adds it), expo-print, react-native-webview, expo-file-system. All have iOS support — no code changes needed, but the **APNs key** must be uploaded to EAS for push.

## Build + distribute
```bash
cd ~/inventorypro/apps/mobile
eas build --platform ios --profile preview      # internal testing (ad-hoc / TestFlight internal)
# or:
eas build --platform ios --profile production   # App Store build
eas submit --platform ios                       # upload to App Store Connect / TestFlight
```
Then invite the iPhone users to **TestFlight** for at-work testing before full App Store release.

## Note
Until the Apple account + credentials exist, iOS can't build. In the meantime the **web** build (see `deploy-web`) is the stopgap for iPhone users at work.
