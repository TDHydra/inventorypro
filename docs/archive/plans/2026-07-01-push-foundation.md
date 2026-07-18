# Push Delivery Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The server can reliably send a push notification to a specific user's devices, via Expo Push (Android/FCM), with device tokens registered from the app — the reusable foundation for the notifications platform (#2–#5 build on `sendPush`).

**Architecture:** Client gets an Expo push token (`expo-notifications`) and registers it at `POST /push/register`; a server `sendPush(userIds, payload)` primitive looks up tokens and POSTs to Expo's push API (`exp.host`), disabling tokens Expo reports as unregistered. Easiest path deliberately chosen: **Expo Push + an EAS build** (EAS handles the native FCM config, avoiding `expo prebuild`/Gradle-pin churn). Server needs **no** `firebase-admin`. Spec: `docs/superpowers/specs/2026-07-01-push-foundation-design.md`.

**Tech Stack:** Fastify + `@fastify/postgres`; Expo SDK 56 `expo-notifications`; Expo Push HTTP API; `node:test`.

## Global Constraints
- **Expo Push, Android-first.** Server sends via `https://exp.host/--/api/v2/push/send` — no `firebase-admin`, no service-account key on our server. The FCM V1 service-account key (`~/Downloads/invenpro-e6aaf-firebase-adminsdk-*.json`) is a **secret** → uploaded to **EAS only** (`eas credentials`), never committed or bundled.
- `device_push_tokens` is **server-only** (NOT in `ALLOWED_TABLES`/`FULL_TABLES`/`pull.ts`) — bypasses sync entirely, like `telemetry_events`.
- **Next API migration file = `029`** (push is built before the planned telemetry migration; if telemetry lands first, it takes 029 and this becomes 030).
- Registration is **best-effort** — never blocks login or the UI.
- `/push/*` authenticated, rate-limited (`overRateLimit`), body-validated.
- The push-capable app is an **EAS build**; the local gradle APK will not deliver push.
- Verify per task: `cd apps/api && npx tsc --noEmit && npm test`; `cd apps/mobile && npx tsc --noEmit -p tsconfig.json`.

---

## Task 1: `device_push_tokens` table (server-only) + migration 029
**Files:** Create `apps/api/src/db/migrations/029_device_push_tokens.sql`.

- [ ] **Step 1: Write the migration**
```sql
-- Server-only push token registry. NOT synced (absent from ALLOWED_TABLES/
-- FULL_TABLES/pull.ts). One row per (user, device token); disabled when Expo
-- reports the token unregistered.
CREATE TABLE IF NOT EXISTS device_push_tokens (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expo_push_token TEXT NOT NULL UNIQUE,
  platform       TEXT,
  device_id      TEXT,
  disabled       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS device_push_tokens_user_idx ON device_push_tokens(user_id) WHERE disabled = FALSE;
```

- [ ] **Step 2: Verify + commit**
Run: `cd apps/api && npx tsc --noEmit && npm test` → clean.
```bash
git add apps/api/src/db/migrations/029_device_push_tokens.sql
git commit -m "feat(push): device_push_tokens table (server-only)"
```

## Task 2: `sendPush()` core + Expo receipts handling (unit-tested)
**Files:** Create `apps/api/src/lib/push.ts`, `apps/api/src/lib/push.test.ts`.

**Interfaces:**
- Produces: `chunk<T>(arr, size): T[][]`; `buildMessages(tokens, payload): ExpoMessage[]`; `deadTokensFromReceipts(receipts, ticketTokens): string[]`; and `sendPush(pg, userIds, payload): Promise<{ sent: number }>`.

- [ ] **Step 1: Write the failing test** `apps/api/src/lib/push.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunk, buildMessages, deadTokensFromReceipts } from './push';

test('chunk splits into batches of size', () => {
  assert.deepEqual(chunk([1,2,3,4,5], 2), [[1,2],[3,4],[5]]);
});
test('buildMessages maps tokens to expo messages with payload', () => {
  const msgs = buildMessages(['ExpoTok1','ExpoTok2'], { title: 'Hi', body: 'B', data: { screen: 's' } });
  assert.equal(msgs.length, 2);
  assert.deepEqual(msgs[0], { to: 'ExpoTok1', title: 'Hi', body: 'B', data: { screen: 's' } });
});
test('deadTokensFromReceipts returns DeviceNotRegistered tokens', () => {
  const receipts = { r1: { status: 'ok' }, r2: { status: 'error', details: { error: 'DeviceNotRegistered' } } };
  const dead = deadTokensFromReceipts(receipts, { r1: 'tokA', r2: 'tokB' });
  assert.deepEqual(dead, ['tokB']);
});
```

- [ ] **Step 2: Run test → FAIL.** `cd apps/api && npm test`.

- [ ] **Step 3: Implement `apps/api/src/lib/push.ts`:**
```ts
type Pg = { query: (sql: string, params: unknown[]) => Promise<{ rows: any[] }> };
export interface PushPayload { title: string; body: string; data?: Record<string, unknown>; }
export interface ExpoMessage { to: string; title: string; body: string; data?: Record<string, unknown>; }

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
export function buildMessages(tokens: string[], p: PushPayload): ExpoMessage[] {
  return tokens.map(to => ({ to, title: p.title, body: p.body, ...(p.data ? { data: p.data } : {}) }));
}
export function deadTokensFromReceipts(
  receipts: Record<string, { status: string; details?: { error?: string } }>,
  ticketTokens: Record<string, string>,
): string[] {
  const dead: string[] = [];
  for (const [id, r] of Object.entries(receipts)) {
    if (r.status === 'error' && (r.details?.error === 'DeviceNotRegistered' || r.details?.error === 'InvalidCredentials')) {
      if (ticketTokens[id]) dead.push(ticketTokens[id]);
    }
  }
  return dead;
}
async function disableTokens(pg: Pg, tokens: string[]): Promise<void> {
  if (!tokens.length) return;
  await pg.query(`UPDATE device_push_tokens SET disabled = TRUE WHERE expo_push_token = ANY($1)`, [tokens]);
}
// Fire-and-forget from callers' view; never throws into business logic.
export async function sendPush(pg: Pg, userIds: string[], payload: PushPayload): Promise<{ sent: number }> {
  try {
    if (!userIds.length) return { sent: 0 };
    const { rows } = await pg.query(
      `SELECT expo_push_token FROM device_push_tokens WHERE user_id = ANY($1) AND disabled = FALSE`, [userIds]);
    const tokens = rows.map(r => r.expo_push_token as string);
    if (!tokens.length) return { sent: 0 };
    let sent = 0;
    for (const batch of chunk(tokens, 100)) {
      const res = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(buildMessages(batch, payload)),
      });
      const json = await res.json().catch(() => null) as any;
      const tickets = json?.data ?? [];
      // Immediate ticket errors that are DeviceNotRegistered → disable now.
      const deadNow: string[] = [];
      tickets.forEach((t: any, i: number) => {
        if (t?.status === 'error' && t?.details?.error === 'DeviceNotRegistered') deadNow.push(batch[i]);
        if (t?.status === 'ok') sent++;
      });
      await disableTokens(pg, deadNow);
    }
    return { sent };
  } catch {
    return { sent: 0 }; // push failures never propagate
  }
}
```
(Note: `deadTokensFromReceipts` is exported for the receipts-polling path; v1 disables on immediate ticket errors, which covers the common `DeviceNotRegistered` case. A follow-on can poll the receipts endpoint using it.)

- [ ] **Step 4: Run test → PASS. Commit.**
```bash
git add apps/api/src/lib/push.ts apps/api/src/lib/push.test.ts
git commit -m "feat(push): sendPush() via Expo Push API + dead-token disable (unit-tested)"
```

## Task 3: `/push` routes — register / unregister / test
**Files:** Create `apps/api/src/routes/push.ts`; Modify `apps/api/src/index.ts`.

**Interfaces:**
- Consumes: `sendPush` (Task 2), `overRateLimit`.
- Produces: `POST /push/register {expo_push_token, platform?, device_id?}`, `POST /push/unregister {expo_push_token}`, `POST /push/test`.

- [ ] **Step 1: Implement `apps/api/src/routes/push.ts`:**
```ts
import { FastifyPluginAsync } from 'fastify';
import { overRateLimit } from '../lib/rateLimit';
import { sendPush } from '../lib/push';

const routes: FastifyPluginAsync = async (fastify) => {
  const auth = { preHandler: [(fastify as any).authenticate] };

  fastify.post<{ Body: { expo_push_token: string; platform?: string; device_id?: string } }>('/register', {
    ...auth,
    schema: { body: { type: 'object', required: ['expo_push_token'],
      properties: { expo_push_token: { type: 'string' }, platform: { type: 'string' }, device_id: { type: 'string' } } } },
  }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const { expo_push_token, platform = null, device_id = null } = request.body;
    if (overRateLimit(`push-reg:${userId}`)) return reply.status(429).send({ error: 'rate' });
    // Re-registration moves the token to this user + reactivates it.
    await fastify.pg.query(
      `INSERT INTO device_push_tokens (user_id, expo_push_token, platform, device_id, disabled, last_seen)
       VALUES ($1,$2,$3,$4,FALSE,NOW())
       ON CONFLICT (expo_push_token) DO UPDATE
         SET user_id = EXCLUDED.user_id, platform = EXCLUDED.platform,
             device_id = EXCLUDED.device_id, disabled = FALSE, last_seen = NOW()`,
      [userId, expo_push_token, platform, device_id],
    );
    return { ok: true };
  });

  fastify.post<{ Body: { expo_push_token: string } }>('/unregister', {
    ...auth,
    schema: { body: { type: 'object', required: ['expo_push_token'], properties: { expo_push_token: { type: 'string' } } } },
  }, async (request) => {
    await fastify.pg.query(`UPDATE device_push_tokens SET disabled = TRUE WHERE expo_push_token = $1`, [request.body.expo_push_token]);
    return { ok: true };
  });

  fastify.post('/test', auth, async (request) => {
    const userId = (request.user as { sub: string }).sub;
    const r = await sendPush(fastify.pg, [userId], { title: 'InvenPro test', body: 'Push is working 🎉', data: { screen: 'dashboard' } });
    return { ...r };
  });
};
export default routes;
```

- [ ] **Step 2: Register** in `index.ts`: `import pushRoutes from './routes/push';` and `await fastify.register(pushRoutes, { prefix: '/push' });` (after the other routes).

- [ ] **Step 3: Verify + commit**
Run: `cd apps/api && npx tsc --noEmit && npm test` → clean.
```bash
git add apps/api/src/routes/push.ts apps/api/src/index.ts
git commit -m "feat(push): /push register|unregister|test routes"
```

## Task 4: Client — permission + token registration
**Files:** Create `apps/mobile/src/push/register.ts`; Modify `apps/mobile/app.json` (expo-notifications plugin + projectId), `apps/mobile/src/auth/finishLogin.ts` (or the post-login hook) and logout path.

- [ ] **Step 1: Config** — in `app.json`: ensure `expo.plugins` includes `expo-notifications`, `expo.android.googleServicesFile: "./google-services.json"`, and `expo.extra.eas.projectId` is set (from `eas.json`/`app.json`). (The `google-services.json` is fetched via the Firebase MCP in the setup runbook, Task 6.)
- [ ] **Step 2: Implement `apps/mobile/src/push/register.ts`** — `registerForPush()`:
  request notification permission (`Notifications.requestPermissionsAsync()`); if granted, `const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data`; if it differs from the last-registered token stored in `app_settings` (`push_token`), `POST ${API_BASE}/push/register { expo_push_token: token, platform: Platform.OS, device_id }` (bearer via `getValidJwt`), then save it. Best-effort: wrap in try/catch, never throw. `unregisterPush()` → `POST /push/unregister` + clear the stored token. Gate on `EXPO_PUBLIC_PUSH !== '0'` and the `app_config` kill-switch.
- [ ] **Step 3: Wire** — call `registerForPush()` from the post-login success path (`finishLogin.ts`) and on app-foreground; call `unregisterPush()` on logout.
- [ ] **Step 4: Verify + commit**
Run: `cd apps/mobile && npx tsc --noEmit -p tsconfig.json` → clean.
```bash
git add apps/mobile/src/push/register.ts apps/mobile/app.json "apps/mobile/src/auth/finishLogin.ts"
git commit -m "feat(push): client permission + Expo token registration"
```

## Task 5: Client — foreground handling + tap deep-link
**Files:** Create `apps/mobile/src/push/handlers.ts`; Modify `apps/mobile/app/_layout.tsx`.

- [ ] **Step 1: Implement `handlers.ts`** — set `Notifications.setNotificationHandler(...)` (show banner in foreground); a `useNotificationObservers()` hook that on `addNotificationResponseReceivedListener` reads `response.notification.request.content.data.screen`/`id` and `router.push(...)` to deep-link; cleans up listeners on unmount.
- [ ] **Step 2: Wire** — call `useNotificationObservers()` in the root `_layout.tsx` inside the session provider; set the notification handler at module import.
- [ ] **Step 3: Verify + commit**
Run: `cd apps/mobile && npx tsc --noEmit -p tsconfig.json` → clean.
```bash
git add apps/mobile/src/push/handlers.ts "apps/mobile/app/_layout.tsx"
git commit -m "feat(push): foreground notification handler + tap deep-linking"
```

## Task 6: Setup runbook (Firebase MCP + EAS) + kill-switch default
**Files:** Create `docs/push-setup.md`; Modify the API seed/`app_config` default.

- [ ] **Step 1: Firebase MCP steps (controller-run, logged in)** — register the Android app `com.inventorypro.app` on project `invenpro-e6aaf` (`firebase_create_app`); fetch the SDK config / `google-services.json` (`firebase_get_sdk_config`) and place it at `apps/mobile/google-services.json` (**gitignore it** — it's config, keep out of the repo per convention); add the release signing SHA (`firebase_create_android_sha`).
- [ ] **Step 2: Document the USER steps** in `docs/push-setup.md`: `eas login`; `eas credentials` → Android → upload the **FCM V1 service-account key** (`~/Downloads/invenpro-e6aaf-firebase-adminsdk-*.json`) — **never commit it**; `eas build -p android --profile preview`; install that build (not the local gradle APK). Then validate: sign in → the app registers a token → `POST /push/test` (or paste the token into expo.dev/notifications) → device shows the notification.
- [ ] **Step 3: Kill-switch default** — ensure `app_config` has `push_enabled = '1'` (default); document that `'0'` disables client registration + server sends.
- [ ] **Step 4: Commit**
```bash
git add docs/push-setup.md apps/api/src/db/seeds/seed.sql .gitignore
git commit -m "docs(push): Firebase/EAS setup runbook + push_enabled kill-switch"
```

---

## Verification (end-to-end)
- API: `npx tsc --noEmit && npm test` green (3 new push tests). Mobile: `npx tsc --noEmit` clean.
- Deploy API (migration 029, gated) → `device_push_tokens` exists; `/push/register` upserts, `/push/test` returns `{sent}`.
- After the EAS build + EAS FCM creds (user): install the EAS build → sign in → token registers → `POST /push/test` → **device receives the notification**; uninstall one device → next send marks its token `DeviceNotRegistered`+disabled.

## Self-Review
- **Spec coverage:** Expo Push/Android-first → Global Constraints + T2; device_push_tokens server-only → T1; token lifecycle → T4; sender + receipts/disable → T2; routes incl /push/test → T3; client handling/deep-link → T5; credentials (MCP + EAS) → T6; kill-switch → T4/T6; separate from local alerts → new modules, `localAlerts.ts` untouched. iOS/triggers/rules/broadcast/approvals correctly deferred (spec out-of-scope).
- **Placeholders:** none — concrete code, migration 029, exact endpoints/payloads.
- **Type consistency:** `sendPush(pg, userIds, payload)` used in T2→T3; `PushPayload {title,body,data}` consistent; `registerForPush`/`unregisterPush` names consistent T4→wiring.
