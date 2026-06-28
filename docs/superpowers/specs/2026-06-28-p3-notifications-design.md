# P3 · Notifications (v1, on-device local) — Design Spec

*Date: 2026-06-28 · Program P3 (last program). Branch: `feat/p3-notifications`.*

## Context
Low-stock alerts + temp-employee-expiry warnings. **v1 = on-device local notifications** computed after each
sync (no server cron, no push tokens). `expo-notifications@~56.0.18` is already installed (pnpm lockfile reconciled).
v2 (server-scheduled push + `device_push_tokens`) is explicitly **out of scope**.

### Decisions
- **Native dep** → requires a dev-client + APK rebuild to run on-device (done as the final step after merge).
- **Triggered post-sync:** `runDrainAndPull()` in `src/sync/engine.ts` already refreshes caches after each cycle;
  add the alert check there (fire-and-forget, errors swallowed).
- **Local-only, immediate notifications** via `Notifications.scheduleNotificationAsync({content, trigger: null})`.
- **Permission-scoped** so crews aren't spammed: low-stock alerts only fire for users who can see inventory;
  expiry alerts only for users who can manage users. (Use the existing Permission keys — pick the closest:
  low-stock = the key the inventory list/low-stock view uses; expiry = `manage_users`.)
- **User pref toggle** in Settings (`app_settings` key `notifications_enabled`, default true) + OS permission.
- **Dedup** so an alert fires once per episode, not every 60s sync: track fired keys in `app_settings`
  (`alert:lowstock:<itemId>`, `alert:expiry:<userId>`); clear a key when the item recovers / user leaves the
  expiry window so it can re-fire next time.

## Global Constraints
- Expo SDK 56 (RN 0.85.3). Native dep already added. No migration, no sync-table change, no new permission KEY.
- `npx expo install` used npm — pnpm-lock.yaml already reconciled; do NOT run npm again.
- tsc gate: `npx tsc --noEmit` clean (mobile).
- Read the exact SDK-56 expo-notifications API at https://docs.expo.dev/versions/v56.0.0/sdk/notifications/ before coding.

## Shared Context Pack
- **Data sources:** `getLowStockItems()` (src/db/queries/items.ts — items where total_stock ≤ min_qty_alert);
  temp employees = `users` with `active=1 AND expires_at` within the next 7 days (add `getExpiringUsers(days)` to
  src/db/queries/users.ts mirroring existing queries).
- **k/v store:** `getAppSetting(key)` / `setAppSetting(key,value)` (src/db/appSettings.ts). Add
  `deleteAppSetting(key)` and `getAppSettingKeysByPrefix(prefix)` there for dedup-key housekeeping.
- **Permissions:** `hasPermission(user, key)` / the `usePermission` hook; `Permission` union in src/constants/roles.ts.
- **Session user:** `getSessionUser()`/`useSession` (whatever the engine can call non-hook — read how other
  non-component code reads the current user; if none, read it from the local DB/session module).
- **Hook point:** `src/sync/engine.ts` `runDrainAndPull()` — after `loadRolePermissionCache()`.
- **App entry:** `app/_layout.tsx` (calls `startSyncEngine()`); **Settings:** `app/(app)/(admin)/settings.tsx`.

---

## Architecture (units — one cohesive vertical)

### Unit 1 — Notification core module  `src/notifications/localAlerts.ts` (new)
- `setNotificationHandler` at module load (show alert + sound in foreground).
- `initNotifications()`: create the Android channel (`alerts`, importance HIGH); call once at app start.
- `ensureNotificationPermission(): Promise<boolean>`: `getPermissionsAsync` → if undetermined, `requestPermissionsAsync`; return granted.
- `runLocalAlertChecks(): Promise<void>`:
  - return early if `getAppSetting('notifications_enabled') === 'false'`.
  - return early if OS permission not granted (do NOT prompt here — prompting happens at app start / settings toggle).
  - resolve the current session user + permissions.
  - **Low-stock** (if user may see inventory): `lowIds = getLowStockItems().map(id)`. For each low item with no
    `alert:lowstock:<id>` key → `scheduleNotificationAsync` ("Low stock: <name> — <n> left") + set the key. Then for
    every existing `alert:lowstock:*` key whose id ∉ lowIds → `deleteAppSetting` (recovered).
  - **Expiry** (if `manage_users`): `getExpiringUsers(7)`; same dedup pattern with `alert:expiry:<userId>`
    ("Access expiring: <name> on <date>"). Clear keys for users no longer expiring.
  - Wrap everything so a failure can't throw into the sync cycle.
- [ ] tsc clean.

### Unit 2 — Wire-in
- `app/_layout.tsx`: import + call `initNotifications()` and `ensureNotificationPermission()` once on mount
  (alongside `startSyncEngine()`), guarded so it no-ops if the pref is off.
- `src/sync/engine.ts`: in `runDrainAndPull()` after `loadRolePermissionCache()`, `void runLocalAlertChecks();`
  (or await inside the try) — must not change the existing catch/return behavior.
- `src/db/appSettings.ts`: add `deleteAppSetting(key)` + `getAppSettingKeysByPrefix(prefix): string[]`.
- `src/db/queries/users.ts`: add `getExpiringUsers(days: number): User[]` (active, expires_at between now and now+days).
- [ ] tsc clean.

### Unit 3 — Settings toggle
- `app/(app)/(admin)/settings.tsx`: a "Stock & expiry alerts" switch bound to `notifications_enabled`
  (default on). Turning it ON calls `ensureNotificationPermission()` and, if denied, shows a hint to enable
  notifications in OS settings. Match the screen's existing row/switch styling.
- [ ] tsc clean.

### Unit 4 — Native config
- `app.json`: add `"expo-notifications"` to `plugins` (optionally with `{ color }`); the plugin adds the Android
  POST_NOTIFICATIONS permission automatically. Keep config minimal/valid for SDK 56.

---

## File map
| Unit | Files |
|---|---|
| 1 | `src/notifications/localAlerts.ts` (new) |
| 2 | `app/_layout.tsx`, `src/sync/engine.ts`, `src/db/appSettings.ts`, `src/db/queries/users.ts` |
| 3 | `app/(app)/(admin)/settings.tsx` |
| 4 | `app.json` |

## Verification
- `tsc --noEmit` clean (mobile).
- Logic review: alerts fire once per episode (dedup), recover-and-refire works, permission-scoped, pref-gated,
  never throws into the sync cycle, no migration/sync-table change.
- On-device (after native rebuild): with the pref on + permission granted, an item dropping to/below its
  min_qty_alert fires exactly one notification; restocking then re-dropping fires again. A temp employee within
  7 days of `expires_at` fires once.

## Out of scope (v2)
- Server-scheduled push, `device_push_tokens`, background delivery when the app is closed.
- The deferred P5 5c "Send push" user-bulk action (build on this once v1 lands).
