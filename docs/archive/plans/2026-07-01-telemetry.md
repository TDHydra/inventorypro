# Behavioral Telemetry Pipeline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A first-party, offline-native telemetry pipeline that captures screen views, labeled-control taps, errors/friction, and an audit blend — buffered on-device and flushed in batches to our own Postgres — so we can see what users do and where they struggle, in dev and prod.

**Architecture:** Client `track()` enqueues events into a capped local SQLite ring buffer (never blocks UI, survives restart); a batched, fire-and-forget `POST /telemetry` ships them to a server-only `telemetry_events` table. Telemetry is **completely separate from the business sync outbox** — its own buffer, its own endpoint, never pulled back to devices; `activity_log` stays the authoritative business audit. Spec: `docs/superpowers/specs/2026-07-01-telemetry-design.md`.

**Tech Stack:** Fastify + `@fastify/postgres` (API), Expo SDK 56 + op-sqlite/sql.js (mobile), `node:test` for pure-logic unit tests.

## Global Constraints
- **Migrations: API next = 029, mobile next = 024.** `telemetry_events` is **server-only** (NOT in `ALLOWED_TABLES`/`FULL_TABLES`/`pull.ts`); `telemetry_buffer` is **mobile-local-only** (NOT in the sync outbox). Neither touches the sync-migration checklist.
- **Never capture** PINs, raw field values, or PII. `props` is a **safe-key allowlist** (ids, counts, durations, error codes, boolean flags) — names not content.
- Telemetry loss is acceptable; **must never block the UI or the business sync**. Fire-and-forget: drop on repeated failure.
- Retention: prune `telemetry_events` older than **90 days**.
- Kill-switch: `app_config.telemetry_enabled` (remote) + `EXPO_PUBLIC_TELEMETRY` build default gate both capture and flush.
- Verify per task: `cd apps/api && npx tsc --noEmit && npm test`; `cd apps/mobile && npx tsc --noEmit -p tsconfig.json` (+ `npm test` once the mobile harness lands in Task 4).

---

## Phase A — Server ingest (independent of mobile; build first)

### Task 1: `telemetry_events` table + migration + 90-day prune
**Files:** Create `apps/api/src/db/migrations/029_telemetry_events.sql`; Modify `apps/api/src/db/migrate.ts`.

- [ ] **Step 1: Write the migration**
```sql
-- Server-only behavioral telemetry sink. NOT synced to devices (absent from
-- ALLOWED_TABLES/FULL_TABLES/pull.ts). Lossy by design; pruned at 90 days.
CREATE TABLE IF NOT EXISTS telemetry_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   TEXT NOT NULL,
  user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  device_id    TEXT,
  platform     TEXT,
  app_version  TEXT,
  type         TEXT NOT NULL,          -- screen | action | error | audit
  name         TEXT NOT NULL,
  screen       TEXT,
  props        JSONB,
  client_ts    TIMESTAMPTZ,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS telemetry_received_idx ON telemetry_events(received_at);
CREATE INDEX IF NOT EXISTS telemetry_type_name_idx ON telemetry_events(type, name);
CREATE INDEX IF NOT EXISTS telemetry_user_idx ON telemetry_events(user_id);
```

- [ ] **Step 2: Add the retention prune** in `migrate.ts`, right after the existing `processed_outbox` prune (mirror it exactly):
```ts
    const prunedTel = await client.query(
      `DELETE FROM telemetry_events WHERE received_at < NOW() - INTERVAL '90 days'`
    );
    if (prunedTel.rowCount) {
      console.log(`✓ Pruned ${prunedTel.rowCount} stale telemetry_events row(s).`);
    }
```

- [ ] **Step 3: Verify + commit**
Run: `cd apps/api && npx tsc --noEmit && npm test` → clean, 23/23.
```bash
git add apps/api/src/db/migrations/029_telemetry_events.sql apps/api/src/db/migrate.ts
git commit -m "feat(telemetry): telemetry_events table (server-only) + 90d prune"
```

### Task 2: `POST /telemetry` batched ingest + payload validator
**Files:** Create `apps/api/src/routes/telemetry.ts`, `apps/api/src/lib/telemetry.ts`, `apps/api/src/lib/telemetry.test.ts`; Modify `apps/api/src/index.ts`.

**Interfaces:**
- Produces: `sanitizeEvent(raw): CleanEvent | null` (drops events with bad type/name; allowlists `props` keys; caps sizes) and `TELEMETRY_PROP_ALLOWLIST: Set<string>`. `POST /telemetry` body `{ events: RawEvent[] }` (max 100), returns `{ accepted: number }`.

- [ ] **Step 1: Write the failing test** `apps/api/src/lib/telemetry.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeEvent } from './telemetry';

test('drops event with unknown type', () => {
  assert.equal(sanitizeEvent({ type: 'evil', name: 'x' }), null);
});
test('keeps only allowlisted prop keys, drops PII-ish keys', () => {
  const e = sanitizeEvent({ type: 'action', name: 'tap', screen: 'inventory',
    props: { itemId: 'i1', durationMs: 12, pin: '1234', customerName: 'Bob' } });
  assert.deepEqual(Object.keys(e!.props).sort(), ['durationMs', 'itemId']);
});
test('truncates over-long name', () => {
  const e = sanitizeEvent({ type: 'screen', name: 'x'.repeat(500) });
  assert.ok(e!.name.length <= 200);
});
```

- [ ] **Step 2: Run test → FAIL** (`Cannot find module './telemetry'`). Run: `cd apps/api && npm test`.

- [ ] **Step 3: Implement `apps/api/src/lib/telemetry.ts`:**
```ts
const TYPES = new Set(['screen', 'action', 'error', 'audit']);
// Safe, non-PII prop keys. Names/ids/metrics only — never field contents.
export const TELEMETRY_PROP_ALLOWLIST = new Set([
  'itemId', 'unitId', 'locationId', 'jobId', 'teamId', 'repairId', 'userId',
  'count', 'qty', 'durationMs', 'ms', 'code', 'status', 'httpStatus', 'ok',
  'reason', 'table', 'operation', 'attempts', 'kind', 'mode', 'from', 'to', 'tab',
]);
export interface CleanEvent {
  type: string; name: string; screen: string | null;
  props: Record<string, unknown>; client_ts: string | null;
}
export function sanitizeEvent(raw: any): CleanEvent | null {
  if (!raw || typeof raw.type !== 'string' || !TYPES.has(raw.type)) return null;
  if (typeof raw.name !== 'string' || !raw.name) return null;
  const props: Record<string, unknown> = {};
  if (raw.props && typeof raw.props === 'object') {
    for (const k of Object.keys(raw.props)) {
      if (!TELEMETRY_PROP_ALLOWLIST.has(k)) continue;
      const v = raw.props[k];
      if (typeof v === 'string') props[k] = v.slice(0, 200);
      else if (typeof v === 'number' || typeof v === 'boolean') props[k] = v;
    }
  }
  return {
    type: raw.type,
    name: raw.name.slice(0, 200),
    screen: typeof raw.screen === 'string' ? raw.screen.slice(0, 200) : null,
    props,
    client_ts: typeof raw.client_ts === 'string' ? raw.client_ts.slice(0, 40) : null,
  };
}
```

- [ ] **Step 4: Run test → PASS.**

- [ ] **Step 5: Implement the route** `apps/api/src/routes/telemetry.ts` (authenticated, batch ≤100, rate-limited via `overRateLimit`, fire-and-forget insert; a bad event is skipped, never 500s the batch):
```ts
import { FastifyPluginAsync } from 'fastify';
import { overRateLimit } from '../lib/rateLimit';
import { sanitizeEvent } from '../lib/telemetry';

const routes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: { events?: unknown[] } }>('/', {
    preHandler: [(fastify as any).authenticate],
    schema: { body: { type: 'object', required: ['events'],
      properties: { events: { type: 'array', maxItems: 100, items: { type: 'object' } } } } },
  }, async (request, reply) => {
    const userId = (request.user as { sub?: string })?.sub ?? null;
    if (overRateLimit(`telemetry:${userId ?? request.ip}`)) return reply.status(429).send({ error: 'rate' });
    const sid = (request.headers['x-telemetry-session'] as string || 'anon').slice(0, 64);
    const dev = (request.headers['x-telemetry-device'] as string || null)?.slice(0, 64) ?? null;
    const plat = (request.headers['x-telemetry-platform'] as string || null)?.slice(0, 20) ?? null;
    const ver = (request.headers['x-telemetry-appver'] as string || null)?.slice(0, 40) ?? null;
    let accepted = 0;
    for (const raw of request.body.events ?? []) {
      const e = sanitizeEvent(raw);
      if (!e) continue;
      try {
        await fastify.pg.query(
          `INSERT INTO telemetry_events (session_id,user_id,device_id,platform,app_version,type,name,screen,props,client_ts)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [sid, userId, dev, plat, ver, e.type, e.name, e.screen, JSON.stringify(e.props), e.client_ts],
        );
        accepted++;
      } catch { /* fire-and-forget: never fail the batch on one bad row */ }
    }
    return { accepted };
  });
};
export default routes;
```

- [ ] **Step 6: Register** in `index.ts`: `import telemetryRoutes from './routes/telemetry';` and `await fastify.register(telemetryRoutes, { prefix: '/telemetry' });` (after `mediaRoutes`). Confirm the global mutation-rate-limit preHandler doesn't double-block (the route's own `overRateLimit` key is distinct; fine).

- [ ] **Step 7: Verify + commit**
Run: `cd apps/api && npx tsc --noEmit && npm test` → clean, 26/26 (23 + 3 new).
```bash
git add apps/api/src/routes/telemetry.ts apps/api/src/lib/telemetry.ts apps/api/src/lib/telemetry.test.ts apps/api/src/index.ts
git commit -m "feat(telemetry): POST /telemetry batched fire-and-forget ingest + prop allowlist"
```

---

## Phase B — Mobile foundation (can start in parallel with Phase A)

### Task 3: `telemetry_buffer` local table (mobile migration 024)
**Files:** Create `apps/mobile/src/db/migrations/024_telemetry_buffer.ts`; Modify `apps/mobile/src/db/schema.ts`, `apps/mobile/src/db/schema.web.ts`.

- [ ] **Step 1: Write the migration** (local-only ring buffer; `seq` autoincrement drives oldest-first eviction + FIFO flush):
```ts
import type { SqlDb } from '../types';
export const migration = {
  version: 24,
  up: (db: SqlDb): void => {
    db.executeSync(`CREATE TABLE IF NOT EXISTS telemetry_buffer (
      seq        INTEGER PRIMARY KEY AUTOINCREMENT,
      type       TEXT NOT NULL, name TEXT NOT NULL, screen TEXT,
      props      TEXT, client_ts TEXT NOT NULL
    )`);
  },
};
```

- [ ] **Step 2: Register `m024`** in `schema.ts` AND `schema.web.ts` (import + push into the sorted array, mirroring `m023`).

- [ ] **Step 3: Verify + commit**
Run: `cd apps/mobile && npx tsc --noEmit -p tsconfig.json` → clean.
```bash
git add apps/mobile/src/db/migrations/024_telemetry_buffer.ts apps/mobile/src/db/schema.ts apps/mobile/src/db/schema.web.ts
git commit -m "feat(telemetry): local telemetry_buffer ring-buffer table (m024)"
```

### Task 4: Mobile test harness + pure tracker utils (redactor + ring cap)
**Files:** Modify `apps/mobile/package.json`; Create `apps/mobile/src/telemetry/redact.ts`, `apps/mobile/src/telemetry/redact.test.ts`.

**Interfaces:**
- Produces: `redactProps(obj): Record<string, unknown>` (client mirror of the server allowlist), `TELEMETRY_PROP_ALLOWLIST`, and `BUFFER_CAP = 2000`.

- [ ] **Step 1: Add a `node:test` script** to `apps/mobile/package.json` scripts: `"test": "node --import tsx --test $(find src -name '*.test.ts')"` (mirrors the API harness; these pure utils import no React Native, so they run under plain node+tsx).

- [ ] **Step 2: Write the failing test** `apps/mobile/src/telemetry/redact.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactProps } from './redact';
test('keeps allowlisted keys, drops content/PII keys', () => {
  const out = redactProps({ itemId: 'i', durationMs: 5, pin: '1234', note: 'secret', name2: 'x' });
  assert.deepEqual(Object.keys(out).sort(), ['durationMs', 'itemId']);
});
```

- [ ] **Step 3: Run → FAIL.** Run: `cd apps/mobile && npm test`.

- [ ] **Step 4: Implement `redact.ts`** (keep the allowlist identical to the server's `TELEMETRY_PROP_ALLOWLIST`):
```ts
export const TELEMETRY_PROP_ALLOWLIST = new Set([
  'itemId','unitId','locationId','jobId','teamId','repairId','userId',
  'count','qty','durationMs','ms','code','status','httpStatus','ok',
  'reason','table','operation','attempts','kind','mode','from','to','tab',
]);
export const BUFFER_CAP = 2000;
export function redactProps(obj: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!obj) return out;
  for (const k of Object.keys(obj)) {
    if (!TELEMETRY_PROP_ALLOWLIST.has(k)) continue;
    const v = obj[k];
    if (typeof v === 'string') out[k] = v.slice(0, 200);
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  }
  return out;
}
```

- [ ] **Step 5: Run → PASS. Commit.**
```bash
git add apps/mobile/package.json apps/mobile/src/telemetry/redact.ts apps/mobile/src/telemetry/redact.test.ts
git commit -m "test(mobile): node:test harness + telemetry prop redactor"
```

### Task 5: Tracker core — `track()` / buffer write + cap / context / kill-switch
**Files:** Create `apps/mobile/src/telemetry/index.ts` (the tracker).

**Interfaces:**
- Consumes: `redactProps`, `BUFFER_CAP` (Task 4); `getDb` (`db/schema`); `getAppConfig`/`app_config` read for `telemetry_enabled`; a random `session_id` per launch.
- Produces: `track(type, name, opts?: { screen?; props? })`, `isTelemetryEnabled()`, `TELEMETRY_CONTEXT` (device_id, platform, app_version, session_id).

- [ ] **Step 1: Implement `index.ts`** — `track()` redacts props, checks the enabled flag (`EXPO_PUBLIC_TELEMETRY !== '0'` AND the synced `app_config.telemetry_enabled !== '0'`), inserts into `telemetry_buffer`, and enforces the cap by deleting the lowest `seq` rows when count exceeds `BUFFER_CAP`. In `__DEV__`, also `console.log('[telemetry]', type, name, props)`. Never throws (wrap in try/catch — telemetry must never break the app). Derive `session_id` from a module-scoped random id at import; `device_id`/`platform`/`app_version` from `expo-constants`/`Platform`.

- [ ] **Step 2: Verify + commit**
Run: `cd apps/mobile && npx tsc --noEmit -p tsconfig.json` → clean.
```bash
git add apps/mobile/src/telemetry/index.ts
git commit -m "feat(telemetry): tracker core — track()/buffer/cap/kill-switch/dev-log"
```

---

## Phase C — Capture, transport, wiring (after A + B)

### Task 6: Transport — batched flush to `POST /telemetry`
**Files:** Create `apps/mobile/src/telemetry/flush.ts`; Modify `apps/mobile/src/sync/engine.ts`.

**Interfaces:**
- Consumes: `telemetry_buffer` rows, `TELEMETRY_CONTEXT`, `getValidJwt` (`auth/session`), `API_BASE`.
- Produces: `flushTelemetry()` — reads up to 100 oldest buffered rows, POSTs them to `${API_BASE}/telemetry` with the `x-telemetry-*` headers + bearer, and **deletes the sent rows on 2xx** (on failure: leave them, bounded by the ring cap; never throw).

- [ ] **Step 1: Implement `flush.ts`** (fire-and-forget; if offline/erroring, rows stay buffered and are dropped by the cap eventually — telemetry loss is acceptable).
- [ ] **Step 2: Hook the cadence** — in `sync/engine.ts` after the existing post-pull work (`loadRolePermissionCache()` / `runLocalAlertChecks()`), call `flushTelemetry().catch(()=>{})`. This reuses the ~60s sync loop + reconnect trigger; do NOT put telemetry on the business push request.
- [ ] **Step 3: Verify + commit**
Run: `cd apps/mobile && npx tsc --noEmit -p tsconfig.json` → clean.
```bash
git add apps/mobile/src/telemetry/flush.ts apps/mobile/src/sync/engine.ts
git commit -m "feat(telemetry): batched fire-and-forget flush hooked to the sync cadence"
```

### Task 7: Capture layer — screens, taps, errors, friction
**Files:** Create `apps/mobile/src/telemetry/capture.tsx` (error boundary + `TrackablePressable`), `apps/mobile/src/telemetry/useScreenTracking.ts`; Modify `apps/mobile/app/_layout.tsx`, `apps/mobile/src/sync/outbox.ts`.

- [ ] **Step 1: Screen views** — `useScreenTracking()` uses expo-router's `usePathname()`/navigation state; on route change, `track('screen', <routeName>, { durationMs: <time on previous> })`.
- [ ] **Step 2: Errors** — a `<TelemetryErrorBoundary>` (React class component) whose `componentDidCatch` calls `track('error', 'render_crash', { reason: error.name })` (name only, no message content/PII), then renders the existing fallback; add a global `ErrorUtils.setGlobalHandler` / unhandled-rejection hook that `track('error','unhandled', { reason })`.
- [ ] **Step 3: Friction** — in `sync/outbox.ts`, when an entry hits `attempts >= MAX` (dead) call `track('error','outbox_dead',{ table, operation, attempts })`; when a push returns a conflict, `track('error','push_conflict',{ table, reason })` (reason = the server's short error, already non-PII). 
- [ ] **Step 4: Taps** — a `TrackablePressable` wrapper over the app's base pressable that, on press, `track('action','tap',{ }, screen)` tagged by the element's `testID`/`accessibilityLabel` as `name`. Adopt it in the highest-traffic components (hub tiles, quick-add save buttons, checkout/checkin) — NOT a global DOM hijack. (Web: a capture-phase click delegate on `data-tel` attributes is optional/follow-on.)
- [ ] **Step 5: Wire root** — in `app/_layout.tsx`, wrap the `<Stack/>` in `<TelemetryErrorBoundary>` and call `useScreenTracking()` inside the provider.
- [ ] **Step 6: Verify + commit**
Run: `cd apps/mobile && npx tsc --noEmit -p tsconfig.json` → clean.
```bash
git add apps/mobile/src/telemetry/capture.tsx apps/mobile/src/telemetry/useScreenTracking.ts "apps/mobile/app/_layout.tsx" apps/mobile/src/sync/outbox.ts
git commit -m "feat(telemetry): capture screens, taps, render/unhandled errors, sync friction"
```

### Task 8: Audit blend + dashboards doc + kill-switch config
**Files:** Modify `apps/mobile/src/db/queries/log.ts` (or the `appendLog` wrapper); Create `docs/telemetry-queries.md`; Modify the API seed/`app_config` default.

- [ ] **Step 1: Audit blend** — in the shared `appendLog(...)` path, also emit `track('audit', <action>, { entity: <type> })` (names only) so business actions show up in telemetry without instrumenting each call site.
- [ ] **Step 2: Kill-switch default** — ensure `app_config` has a `telemetry_enabled` row (default `'1'`); document that setting it `'0'` (via the existing app_config sync/admin path) disables capture+flush remotely.
- [ ] **Step 3: Dashboards v1** — `docs/telemetry-queries.md` with ready SQL: top screens by views, screen drop-off (last screen before session end), error rate by screen, most-tapped controls, per-user activity, dead-outbox counts by table.
- [ ] **Step 4: Commit**
```bash
git add apps/mobile/src/db/queries/log.ts docs/telemetry-queries.md apps/api/src/db/seeds/seed.sql
git commit -m "feat(telemetry): audit-event blend + kill-switch default + v1 SQL dashboards"
```

---

## Verification (end-to-end)
- API: `npx tsc --noEmit && npm test` green (26 tests). Mobile: `npx tsc --noEmit` + `npm test` (redactor) green.
- Deploy API (migration 029, gated) → `telemetry_events` exists; `POST /telemetry` accepts an authed batch, 401s unauth, 429s over the limit, skips a bad event without failing the batch.
- On device: navigate screens, tap instrumented controls, force a render error, kill the network then restore → events buffer offline and flush in a batch; **grep `props` in `telemetry_events` to confirm no PIN/field content ever lands**; set `app_config.telemetry_enabled='0'` → capture + flush stop.

## Self-Review
- **Spec coverage:** scope (screens/taps/errors/audit) → T5/T7/T8; data model → T1 (server) + T3 (buffer); transport/separate-from-sync → T2 + T6; privacy allowlist → T2 + T4; retention → T1; dev/prod + kill-switch → T5 + T8; dashboards follow-on/SQL v1 → T8. Metabase correctly deferred (out of scope).
- **Placeholders:** none — concrete code + exact migration numbers (029/024), allowlist, cap (2000), batch (100), retention (90d).
- **Type consistency:** `sanitizeEvent`/`redactProps` share the identical allowlist (server + client); `track(type,name,opts)` used consistently in T5→T7→T8; `flushTelemetry()` name consistent T6.
