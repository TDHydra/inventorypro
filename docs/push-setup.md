# Push & Play Store credential runbook

State as verified 2026-07-25. This is the "Task 6" runbook promised by
`docs/archive/plans/2026-07-01-push-foundation.md`. Architecture recap: Expo Push
service on top of FCM V1 — **no** `@react-native-firebase` (would force prebuild and
reset the Gradle 8.13 pin), server relays via `exp.host` (`apps/api/src/lib/push.ts`),
client registers in `apps/mobile/src/push/register.ts`.

## Current verified state (2026-07-25)

| Piece | State |
|---|---|
| Firebase project | `invenpro-e6aaf` (account `mattcampbell51294@gmail.com`), single Android app `com.inventorypro.app` (app id `1:875828199065:android:05665f0c769fcc54884208`); legacy `com.MattCampbell.InvenPro` client deleted |
| SHA hashes | Release-keystore SHA-1 + SHA-256 registered on the Firebase Android app (2026-07-25) |
| FCM V1 service-account key | Uploaded to EAS (`firebase-adminsdk-fbsvc@invenpro-e6aaf.iam.gserviceaccount.com`, ~2026-07-02) — push delivers on any EAS-credentialed build |
| `google-services.json` | `apps/mobile/google-services.json` (gitignored) + `GOOGLE_SERVICES_JSON` **file** env var in EAS environments development/preview/production; wired by `apps/mobile/app.config.js` |
| Keystore | ONE keystore everywhere: `apps/mobile/@tdhydra__inventorypro.jks` = `credentials/android/keystore.jks` = EAS "InvApp (Default)" (SHA-1 `07:0E:B3:23:…:10:DA`). Local sideloads and Play builds are cross-installable. |
| Versioning | `eas.json`: `appVersionSource: "remote"` + production `autoIncrement: true`; remote versionCode seeded to 10 on 2026-07-25 (sideloaded APKs were 1) |
| Play submission key | See `eas.json` `submit.production` — service-account JSON under `apps/mobile/` (gitignored) |

## Key facts / gotchas

- **Push does NOT deliver on locally gradle-signed APKs** (deploy-android §A builds).
  Token registration works, delivery silently doesn't. Use an EAS build
  (development/preview/production profile) to test delivery.
- `eas credentials -p android` is the one place to see everything: FCM V1 key,
  keystores, Play submission key.
- The FCM **Legacy** key is also uploaded but unused; FCM V1 is what matters.

## Recipes

### Refresh google-services.json (after any Firebase app change)
```bash
# via Firebase MCP: firebase_get_sdk_config(app_id 1:875828199065:android:05665f0c769fcc54884208)
# or Firebase console → Project settings → your Android app → download
# write to apps/mobile/google-services.json, then push to EAS for cloud builds:
cd apps/mobile
for e in development preview production; do
  npx eas-cli env:update --variable-name GOOGLE_SERVICES_JSON --type file \
    --value ./google-services.json --variable-environment $e --non-interactive
done
```

### Rotate the FCM V1 key
Firebase console → Project settings → Service accounts → Generate new private key
(file is `*-adminsdk-*.json`, already gitignored) → `eas credentials -p android` →
Google Service Account → Manage FCM V1 key → upload → delete the old key in
Google Cloud IAM.

### Add a SHA hash (new keystore / Play App Signing key)
After Play App Signing enrollment, add **Google's** app-signing certificate too
(Play Console → Setup → App signing): Firebase MCP `firebase_create_android_sha`
or console. Then refresh google-services.json (recipe above).

### Version management
- `version` in `app.json` = human-readable (bump by hand per release).
- `versionCode` lives on EAS servers (`appVersionSource: remote`), auto-increments
  each production build. Inspect/set: `eas build:version:get|set -p android`.
  Never reuse a versionCode Play has already seen.

### Build & submit
```bash
cd apps/mobile
npx eas-cli build -p android --profile production      # AAB, auto-increments versionCode
npx eas-cli submit -p android --latest                 # uses eas.json submit.production
```

### Verify push end-to-end
1. Install an EAS build, log in → row appears in `device_push_tokens` (prod psql).
2. `POST /push/test` (authed route, `apps/api/src/routes/push.ts`).
3. Server logs show ticket ok; receipts re-polled ~15 min later; bad tokens
   auto-disabled (`DeviceNotRegistered`).
