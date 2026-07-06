# Spec — Push notifications: delivery foundation (sub-project #1)

## Context
We want server-sent push notifications. This **reopens** the backlog's "decided
against: server push / Firebase / device_push_tokens / Send push" item — the user
has reversed that decision. The full ask is a notifications *platform*, decomposed
into sub-projects; **this spec is only #1, the delivery foundation** — the plumbing
that lets the server reliably push to specific users' devices. Product logic
(triggers, admin-configurable rules, broadcast composer, approvals) is #2–#5, each
its own later spec.

Mechanism: **Expo Push service, Android-first.** Chosen over `@react-native-firebase`
because the latter needs `expo prebuild`, which resets the pinned Gradle 8.13 and
complicates the local-build flow. Firebase project already exists on the account:
**`invenpro-e6aaf`** ("InvenPro"). Delivery uses FCM under the hood via Expo's relay.

## Hard external dependency (cannot be fully automated)
- **Automatable now (via the Firebase MCP, logged in as mattcampbell51294@gmail.com):**
  register the Android app on `invenpro-e6aaf`, fetch the SDK config /
  `google-services.json`, add the signing SHA.
- **User action (Expo/GCP side, not the MCP):** generate the **FCM V1 service-account
  key** and upload it to **EAS** (`eas credentials`); produce a **credentialed EAS
  build**. Push will NOT deliver through the local gradle-pinned APK — an EAS build
  (or an EAS dev-client) with the FCM credential is required to receive push.
- iOS deferred to a later pass (needs an Apple Developer account + APNs key).

## Architecture
Client obtains an Expo push token and registers it with the API. A server-side
`sendPush()` primitive looks up a user's tokens and relays to Expo's push API, then
reconciles receipts to disable dead tokens. This foundation exposes exactly one
reusable primitive — `sendPush(userIds, payload)` — that later sub-projects call.
It is **separate from the existing local alerts** (`localAlerts.ts`); those stay for
on-device/offline alerts, push is the server-initiated channel.

## Data model (server-only — NOT synced)
- New **`device_push_tokens`** table (next sequential API migration file — `029` if
  built before the planned telemetry migration, else the next number; **server-only**,
  NOT in `ALLOWED_TABLES`/`FULL_TABLES`/`pull.ts`):
  `id UUID PK, user_id UUID REFERENCES users(id) ON DELETE CASCADE, expo_push_token
  TEXT UNIQUE, platform TEXT, device_id TEXT, disabled BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(), last_seen TIMESTAMPTZ DEFAULT NOW()`.
  Index on `user_id`.
- No mobile migration: the device doesn't store a token table; it reads its Expo
  token from `expo-notifications` and remembers the last-registered value in
  `app_settings` (to skip redundant re-registration).

## Token lifecycle (client)
- After the OS **notification permission** is granted, call
  `Notifications.getExpoPushTokenAsync({ projectId })` and `POST /push/register
  { token, platform, device_id }` on login / app-foreground.
- Re-register when the token changes; `POST /push/unregister { token }` (or mark
  `disabled`) on logout. Registration is best-effort (never blocks login).
- Gate on the same `app_config` kill-switch pattern + `EXPO_PUBLIC_PUSH` build flag.

## Server sender (`apps/api/src/lib/push.ts`)
- `sendPush(userIds: string[], payload: { title; body; data? }): Promise<void>` —
  select active (`disabled=false`) tokens for those users, chunk into ≤100-message
  batches, POST to `https://exp.host/--/api/v2/push/send`, then read the push
  **receipts** and set `disabled=true` for any token returning `DeviceNotRegistered`
  / `InvalidCredentials`. Fire-and-forget from callers' perspective; never throws
  into business logic.
- Routes (`apps/api/src/routes/push.ts`, authed): `POST /push/register`,
  `POST /push/unregister`, and `POST /push/test` (sends a test push to the caller's
  own devices — used to validate delivery after the credentialed build). Rate-limited
  + body-validated like other routes.

## Client handling
- Request notification permission at a sensible moment (not cold on first launch).
- Foreground notification handler (show a banner); tapping a push deep-links via its
  `data` payload (e.g. `{ screen: 'repairs/[id]', id }`) using expo-router.

## Privacy / security
- Tokens are opaque device identifiers, attributed to `user_id` via JWT `sub`.
  `/push/*` authenticated, rate-limited, size-capped, schema-validated (same
  discipline as the security hardening). Token cleanup on 401/logout/invalid.
- Push **payloads carry no PII beyond a title/body the sender chose** + a small
  `data` routing object (ids only).

## Verification
- `node:test` for `sendPush`'s token-batching + invalid-token-disable logic (pure,
  mock the fetch).
- Firebase MCP: confirm the Android app + config on `invenpro-e6aaf`.
- End-to-end (requires the user's EAS creds + credentialed build): register on
  device → `POST /push/test` → device receives the notification; disabling a token
  (uninstall) → next send marks it `DeviceNotRegistered`+disabled.

## Out of scope (later sub-projects)
- #2 event triggers (assignment / SLA / low-stock / checkout-session-complete),
- #3 admin-configurable notification rules UI,
- #4 broadcast composer + `send_notifications` permission,
- #5 approvals workflow,
- iOS/APNs.
