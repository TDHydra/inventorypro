# Batch: settings domain

Run: `cd apps/mobile-v2 && npx jest 'app/\(app\)/settings'` -> 7 suites, 49 tests passed.

- settings/index.tsx — 13 tests (render, signed-out, header, admin links, gating, 6 nav pushes, theme pref write, form-detail override)
- settings/org.tsx — 7
- settings/security.tsx — 7
- settings/sync.tsx — 5
- settings/fields.tsx — 5
- settings/notifications.tsx — 8
- settings/access-defaults.tsx — 4

## Shortcuts taken
- Outbox/app_config/user_prefs are seeded or asserted through the real DB; no sync module mocking. "Sync now" press is NOT tested (syncNow hits the network).
- security.tsx: local `jest.mock` of `src/auth/session` (getValidJwt -> null) so the apex demo-mode fetch never fires; demo toggle PATCH flow untested. QrSigningSection only rendered, not exercised.
- notifications.tsx: local `jest.mock` of `src/notifications/localAlerts`; the device toggle (OS permission path) and NotificationRoutingEditor internals untested (only its section header).
- org.tsx: main-storage SearchablePicker, shelf sub-picker and threshold commit-on-blur not exercised; theme pick asserted loosely (any app_config row).
- Permission gating uses `role: 'contents_crew'`, not `permissions: { system_settings: false }`.
- fields.tsx toggle test seeds a `users` row because the write appends an activity_log row (FK on user_id).

## Harness gaps found
- Docs say to run `npx jest "app/(app)/settings"`; jest treats the arg as a regex so the parens are groups and it matches 0 files. Use `'app/\(app\)/settings'`.
- `renderScreen` `permissions` overrides cannot gate `full_admin` for permissions in FULL_ADMIN_FLOOR (system_settings is one): hasPermission returns true before reading overrides. Gating tests must use a lower role. Worth a line in PAGE-TESTS.md.
