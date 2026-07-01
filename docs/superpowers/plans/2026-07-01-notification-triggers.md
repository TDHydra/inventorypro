# Notification Event Triggers (#2) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Wire three real events to the existing `sendPush` — repair/job **assignment** and **low-stock** (both detected in `/sync/push`), and a **checkout-idle timer** (an in-process API scheduler) — each deduped, config-driven, and PII-free.

**Architecture:** A shared `notifications` lib (dedup claim/release, recipient resolution, config read) is consumed by two detection paths: write-triggered hooks inside `/sync/push`, and a single `setInterval` timer in the API. Everything routes through `sendPush(pg, userIds, payload)`, which is already fire-and-forget.

**Tech Stack:** Fastify + `@fastify/postgres`, `node:test`, Expo SDK 56 (admin settings screen).

## Global Constraints
- **API migration `031`** — `notification_dedup`, **server-only** (NOT in `ALLOWED_TABLES`/`FULL_TABLES`/`pull.ts`).
- All sends go through `sendPush` and must be **fire-and-forget** — a trigger failure never blocks the sync write or crashes the timer (wrap every trigger in try/catch).
- **Payloads are PII-free:** fixed message + ids + item *name* + counts only. Never item lists, customer content, or field values.
- Every trigger is **deduped** via `notification_dedup`; low-stock **re-arms** (deletes its key) when stock climbs back above `min_qty_alert`.
- Durations are config-driven: `app_config` keys `notify_enabled` ('1'), `notify_poll_interval_min` ('5'), `notify_checkout_idle_min` ('15').
- Checkout actions in `activity_log` are `'checkout'` and `'checkout_to_job'`. Low-stock recipients: roles `full_admin` + `franchise_manager`.
- Verify each task: `cd apps/api && npx tsc --noEmit && npm test`. Mobile task: `cd apps/mobile && npx tsc --noEmit -p tsconfig.json`.

## Parallelization
**Task 1 is the shared foundation — build it first.** Then **Tasks 2, 3, 4 are disjoint-file and run in parallel** (Task 2 → `routes/sync.ts`; Task 3 → new `lib/notificationTimer.ts` + `index.ts`; Task 4 → mobile `settings.tsx` + `seed.sql`). No shared-file contention among 2/3/4.

---

## Task 1: `notification_dedup` table + `notifications` core lib
**Files:** Create `apps/api/src/db/migrations/031_notification_dedup.sql`, `apps/api/src/lib/notifications.ts`, `apps/api/src/lib/notifications.test.ts`.

**Interfaces (Produces):**
- `dedupKeys.assign(repairId, assignee)`, `dedupKeys.lowstock(itemId)`, `dedupKeys.session(userId, lastTs)` → `string`
- `claimEvent(pg, key): Promise<boolean>` (true if newly claimed), `releaseEvent(pg, key): Promise<void>`
- `resolveTeamManagers(pg, userId): Promise<string[]>`, `resolveRoleRecipients(pg, roles: string[]): Promise<string[]>`
- `getNotifyConfig(pg): Promise<{ enabled: boolean; pollMin: number; idleMin: number }>`

- [ ] **Step 1: Migration** `031_notification_dedup.sql`:
```sql
-- Server-only notification idempotency ledger. NOT synced (absent from
-- ALLOWED_TABLES/FULL_TABLES/pull.ts). A trigger fires only if its key is absent;
-- low-stock deletes its key to re-arm.
CREATE TABLE IF NOT EXISTS notification_dedup (
  event_key   TEXT PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

- [ ] **Step 2: Failing test** `notifications.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dedupKeys, getNotifyConfig } from './notifications';

test('dedupKeys build stable keys', () => {
  assert.equal(dedupKeys.assign('r1', 'u1'), 'assign:repair:r1:u1');
  assert.equal(dedupKeys.lowstock('i1'), 'lowstock:item:i1');
  assert.equal(dedupKeys.session('u1', '2026-07-01T10:00:00Z'), 'session:user:u1:2026-07-01T10:00:00Z');
});
test('getNotifyConfig applies defaults + parses + clamps + disable flag', async () => {
  const pgEmpty = { query: async () => ({ rows: [] }) };
  assert.deepEqual(await getNotifyConfig(pgEmpty as any), { enabled: true, pollMin: 5, idleMin: 15 });
  const pgSet = { query: async () => ({ rows: [
    { key: 'notify_enabled', value: '0' },
    { key: 'notify_poll_interval_min', value: '2' },
    { key: 'notify_checkout_idle_min', value: '30' },
  ] }) };
  assert.deepEqual(await getNotifyConfig(pgSet as any), { enabled: false, pollMin: 2, idleMin: 30 });
});
```

- [ ] **Step 3: Run → FAIL.** `cd apps/api && npm test`.

- [ ] **Step 4: Implement `notifications.ts`:**
```ts
type Pg = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

export const dedupKeys = {
  assign: (repairId: string, assignee: string) => `assign:repair:${repairId}:${assignee}`,
  lowstock: (itemId: string) => `lowstock:item:${itemId}`,
  session: (userId: string, lastTs: string) => `session:user:${userId}:${lastTs}`,
};

// Returns true only if this key was newly inserted (i.e. the caller "won" the
// right to notify). A retry / concurrent tick finds the row present → false.
export async function claimEvent(pg: Pg, key: string): Promise<boolean> {
  const { rows } = await pg.query(
    `INSERT INTO notification_dedup (event_key) VALUES ($1)
     ON CONFLICT (event_key) DO NOTHING RETURNING event_key`, [key]);
  return rows.length > 0;
}
export async function releaseEvent(pg: Pg, key: string): Promise<void> {
  await pg.query(`DELETE FROM notification_dedup WHERE event_key = $1`, [key]);
}

// Managers (is_manager) of every team the user is on, excluding the user themself.
export async function resolveTeamManagers(pg: Pg, userId: string): Promise<string[]> {
  const { rows } = await pg.query(
    `SELECT DISTINCT tm2.user_id FROM team_members tm
       JOIN team_members tm2 ON tm2.team_id = tm.team_id AND tm2.is_manager = TRUE
      WHERE tm.user_id = $1 AND tm2.user_id <> $1`, [userId]);
  return rows.map(r => r.user_id as string);
}
export async function resolveRoleRecipients(pg: Pg, roles: string[]): Promise<string[]> {
  const { rows } = await pg.query(
    `SELECT id FROM users WHERE role = ANY($1) AND active = TRUE`, [roles]);
  return rows.map(r => r.id as string);
}

export async function getNotifyConfig(pg: Pg): Promise<{ enabled: boolean; pollMin: number; idleMin: number }> {
  const { rows } = await pg.query(
    `SELECT key, value FROM app_config WHERE key = ANY($1)`,
    [['notify_enabled', 'notify_poll_interval_min', 'notify_checkout_idle_min']]);
  const m: Record<string, string> = Object.fromEntries(rows.map(r => [r.key, r.value]));
  const toInt = (v: string | undefined, d: number) => Math.max(1, parseInt(v ?? '', 10) || d);
  return {
    enabled: (m.notify_enabled ?? '1') !== '0',
    pollMin: toInt(m.notify_poll_interval_min, 5),
    idleMin: toInt(m.notify_checkout_idle_min, 15),
  };
}
```

- [ ] **Step 5: Run → PASS. Commit.**
```bash
git add apps/api/src/db/migrations/031_notification_dedup.sql apps/api/src/lib/notifications.ts apps/api/src/lib/notifications.test.ts
git commit -m "feat(notify): notification_dedup table + core lib (dedup/recipients/config)"
```

---

## Task 2: Write-triggered hooks — assignment + low-stock (`/sync/push`)
**Files:** Modify `apps/api/src/routes/sync.ts`. **Consumes** Task 1.

**Interfaces:** Consumes `claimEvent`, `releaseEvent`, `dedupKeys`, `resolveRoleRecipients` (Task 1) + `sendPush` (`../lib/push`).

- [ ] **Step 1: Import** at top of `sync.ts`:
```ts
import { sendPush } from '../lib/push';
import { claimEvent, releaseEvent, dedupKeys, resolveRoleRecipients, getNotifyConfig } from '../lib/notifications';
```
Both trigger blocks below first check the master kill-switch: `if (!(await getNotifyConfig(pg)).enabled) return;` at the top of each fire-and-forget IIFE (shown inline below).

- [ ] **Step 2: Low-stock — after the ADJUST upsert** (right before the `return;` that ends the `operation === 'ADJUST' && table_name === 'stock_by_location'` block), add a fire-and-forget check. Only fires on a decrease (`delta < 0`):
```ts
    // Low-stock notification (fire-and-forget; never blocks the stock write).
    if (typeof delta === 'number' && delta < 0) {
      (async () => {
        try {
          if (!(await getNotifyConfig(pg)).enabled) return;
          const { rows } = await pg.query(
            `SELECT i.name, i.min_qty_alert,
                    COALESCE((SELECT SUM(quantity) FROM stock_by_location WHERE item_id = i.id), 0) AS on_hand
               FROM inventory_items i WHERE i.id = $1`, [itemId]);
          const it = rows[0];
          if (!it) return;
          const key = dedupKeys.lowstock(itemId);
          if (Number(it.on_hand) <= Number(it.min_qty_alert)) {
            if (await claimEvent(pg, key)) {
              const to = await resolveRoleRecipients(pg, ['full_admin', 'franchise_manager']);
              await sendPush(pg, to, { title: 'Low stock', body: `${it.name} is at or below its alert level.`, data: { screen: 'inventory', itemId } });
            }
          } else {
            await releaseEvent(pg, key); // back above threshold → re-arm
          }
        } catch { /* telemetry-grade: never disrupt sync */ }
      })();
    }
```

- [ ] **Step 3: Assignment — after a `repairs` UPDATE applies.** In the `operation === 'UPDATE'` branch, after the row is written, add (fire-and-forget). Fires when the payload carries a non-null `assignee_id`:
```ts
    if (table_name === 'repairs' && payload.assignee_id) {
      const assignee = String(payload.assignee_id);
      const repairId = String(payload.id);
      (async () => {
        try {
          if (!(await getNotifyConfig(pg)).enabled) return;
          if (await claimEvent(pg, dedupKeys.assign(repairId, assignee))) {
            await sendPush(pg, [assignee], { title: 'New assignment', body: 'You have been assigned a repair.', data: { screen: 'repairs/[id]', id: repairId } });
          }
        } catch { /* never disrupt sync */ }
      })();
    }
```
*(Planning note: if the `jobs` table has an assignee column, mirror this block for jobs with `data.screen: 'jobs/[id]'`; if not, repairs-only is correct — the implementer confirms via `\d jobs`.)*

- [ ] **Step 4: Verify + commit**
Run: `cd apps/api && npx tsc --noEmit && npm test` → clean.
```bash
git add apps/api/src/routes/sync.ts
git commit -m "feat(notify): assignment + low-stock push triggers in /sync/push"
```

---

## Task 3: Checkout-idle timer + wiring
**Files:** Create `apps/api/src/lib/notificationTimer.ts`; Modify `apps/api/src/index.ts`. **Consumes** Task 1.

**Interfaces:** Produces `startNotificationTimer(pg): void`. Consumes `getNotifyConfig`, `claimEvent`, `dedupKeys`, `resolveTeamManagers` (Task 1), `sendPush`.

- [ ] **Step 1: Implement `notificationTimer.ts`.** Each tick: read config; if disabled, skip. Detect completed checkout sessions via a window-function query (session = checkouts with gaps < idle; a trailing gap ≥ idle closes it), notify team managers once per session with a count:
```ts
import { getNotifyConfig, claimEvent, dedupKeys, resolveTeamManagers } from './notifications';
import { sendPush } from './push';

type Pg = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

async function runCheckoutIdleCheck(pg: Pg, idleMin: number, pollMin: number): Promise<void> {
  // Group each user's checkouts into sessions (new session when the gap from the
  // previous checkout >= idleMin). Emit sessions whose LAST checkout is now idle
  // (>= idleMin ago) but recent enough to be *newly* idle (dedup covers overlap).
  const { rows } = await pg.query(
    `WITH ck AS (
       SELECT user_id, created_at,
              LAG(created_at) OVER (PARTITION BY user_id ORDER BY created_at) AS prev_at
         FROM activity_log
        WHERE action IN ('checkout','checkout_to_job') AND created_at > NOW() - INTERVAL '1 day'
     ),
     sessioned AS (
       SELECT user_id, created_at,
              SUM(CASE WHEN prev_at IS NULL OR created_at - prev_at >= ($1||' min')::interval THEN 1 ELSE 0 END)
                OVER (PARTITION BY user_id ORDER BY created_at) AS session_no
         FROM ck
     )
     SELECT user_id, MAX(created_at) AS last_ts, COUNT(*) AS cnt
       FROM sessioned GROUP BY user_id, session_no
      HAVING MAX(created_at) <  NOW() - ($1||' min')::interval
         AND MAX(created_at) >  NOW() - (($1::int + $2::int * 2)||' min')::interval`,
    [String(idleMin), String(pollMin)]);
  for (const r of rows) {
    const userId = String(r.user_id);
    const lastTs = new Date(r.last_ts).toISOString();
    if (!(await claimEvent(pg, dedupKeys.session(userId, lastTs)))) continue;
    const managers = await resolveTeamManagers(pg, userId);
    if (!managers.length) continue;
    const { rows: u } = await pg.query(`SELECT name FROM users WHERE id = $1`, [userId]);
    const who = u[0]?.name ?? 'A team member';
    await sendPush(pg, managers, { title: 'Checkout complete', body: `${who} finished checking out — ${r.cnt} item(s).`, data: { screen: 'activity' } });
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
let currentPollMin = 0;
export function startNotificationTimer(pg: Pg): void {
  const schedule = (pollMin: number) => {
    if (timer) clearInterval(timer);
    currentPollMin = pollMin;
    timer = setInterval(tick, pollMin * 60_000);
  };
  const tick = async () => {
    try {
      const cfg = await getNotifyConfig(pg);
      if (cfg.pollMin !== currentPollMin) schedule(cfg.pollMin); // apply interval changes live
      if (!cfg.enabled) return;
      await runCheckoutIdleCheck(pg, cfg.idleMin, cfg.pollMin);
    } catch (e) { console.error('[notify] tick failed', e); } // never let the timer die
  };
  schedule(5); // default cadence until first tick reads config
}
```

- [ ] **Step 2: Wire in `index.ts`** — after the server is listening (inside the `listen` callback, after the error check), start the timer:
```ts
      // Start the notification timer (checkout-idle etc.) once we're serving.
      import('./lib/notificationTimer').then(({ startNotificationTimer }) => startNotificationTimer(app.pg));
```
(Or a top-level `import` + call — match the file's existing import style. `app.pg` is the `@fastify/postgres` decorator.)

- [ ] **Step 3: Verify + commit**
Run: `cd apps/api && npx tsc --noEmit && npm test` → clean.
```bash
git add apps/api/src/lib/notificationTimer.ts apps/api/src/index.ts
git commit -m "feat(notify): in-process checkout-idle timer + startup wiring"
```

---

## Task 4: `app_config` defaults + admin settings UI
**Files:** Modify the API seed that inserts `app_config` defaults (`apps/api/src/db/seeds/seed.sql` — grep for existing `app_config` inserts like `maintenance_mode`); Modify `apps/mobile/app/(app)/(admin)/settings.tsx`. Disjoint from Tasks 2/3.

- [ ] **Step 1: Seed defaults** — add the three keys where `app_config` defaults are seeded (idempotent `ON CONFLICT (key) DO NOTHING`):
```sql
INSERT INTO app_config (key, value) VALUES
  ('notify_enabled', '1'),
  ('notify_poll_interval_min', '5'),
  ('notify_checkout_idle_min', '15')
ON CONFLICT (key) DO NOTHING;
```
(If defaults are seeded elsewhere/differently, follow that file's exact pattern. These are also created lazily by `getNotifyConfig` defaults, so the seed is a convenience, not a hard dependency.)

- [ ] **Step 2: Settings UI** — in `settings.tsx`, add a "Notifications" section (gated on the same `system_settings` check the screen already uses) with a toggle for `notify_enabled` and two numeric inputs for `notify_poll_interval_min` / `notify_checkout_idle_min`, reading via `getAppConfig(key)` and writing through the **same synced-config write path the screen already uses for `maintenance_mode`** (so edits push to the server the API reads). Reuse the existing `AppInput` (numeric) + toggle components rather than ad-hoc controls. Validate to integers ≥ 1.

- [ ] **Step 3: Verify + commit**
Run: `cd apps/mobile && npx tsc --noEmit -p tsconfig.json` → clean.
```bash
git add apps/api/src/db/seeds/seed.sql "apps/mobile/app/(app)/(admin)/settings.tsx"
git commit -m "feat(notify): app_config defaults + admin settings controls (enable/poll/idle)"
```

---

## Verification (end-to-end)
- API: `npx tsc --noEmit && npm test` green (Task 1 tests + existing 31). Mobile: `npx tsc --noEmit` clean.
- Deploy API (migration 031, gated) → `notification_dedup` exists; the timer logs a tick.
- On device (after the EAS push build): assign a repair → assignee gets a push; drop an item to ≤ `min_qty_alert` → managers get one push (not repeated); check out several items, wait the idle gap → the team manager gets one "finished checking out — N" push; flip `notify_enabled='0'` in admin settings → triggers stop.

## Self-Review
- **Spec coverage:** assignment/low-stock write-triggers → T2; checkout-idle timer → T3; `notification_dedup` (031) + config read + recipient resolution → T1; `app_config` keys + settings UI → T4; kill-switch → T1 (`getNotifyConfig.enabled`) enforced in T3 + honored in T2 (see note); PII-free payloads → T2/T3 (name/count/id only). Repair-overdue correctly absent.
- **Kill-switch on write-triggers:** both T2 blocks gate on `(await getNotifyConfig(pg)).enabled` (folded into the inline code) — so `notify_enabled='0'` stops write-triggers as well as the timer.
- **Placeholders:** none — concrete SQL, keys, defaults (031, 5, 15), recipient roles.
- **Type consistency:** `claimEvent`/`releaseEvent`/`dedupKeys`/`resolveTeamManagers`/`resolveRoleRecipients`/`getNotifyConfig` names identical across T1→T2→T3; `sendPush(pg, userIds, payload)` matches #1's signature.
