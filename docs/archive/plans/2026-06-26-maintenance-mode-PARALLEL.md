# Maintenance Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use `- [ ]`. **Verification gate:** no unit-test runner — the gate per task is `npx tsc --noEmit` clean (controller, app-wide) + the task's manual check. Implementer agents do **NO git and NO tsc**; the controller runs unified tsc, commits per task, reviews.

**Goal:** An admin-controlled, app-wide read-only lockout: a tier-4 admin flips a switch that syncs to every device, putting non-admins into read-only behind a "System under maintenance" banner while tier-4 admins keep full write access.

**Architecture:** Maintenance state lives in a new **synced** `app_config(key,value,updated_at)` table (migration 010). A guard module caches the flag + whether the current user is tier-4-exempt; `appendOutbox()` calls it as a hard write-layer backstop, while a hook + banner + disabled CTAs provide the visible UX. The admin toggle writes the flag locally and pushes it through the outbox.

**Tech Stack:** Expo SDK 56, expo-router, `@op-engineering/op-sqlite`, Fastify + Postgres (api), React Native `Switch`.

## Global Constraints

- Expo SDK 56 — consult `https://docs.expo.dev/versions/v56.0.0/` before native/API code.
- op-sqlite bind params: only `string | number | null | ArrayBuffer`.
- **Synced migration discipline:** migration 010 adds a synced table → MUST update, in the same change, `apps/api/src/routes/sync.ts` (`ALLOWED_TABLES` + `FULL_TABLES` + `CONFLICT_TARGETS`) AND `apps/mobile/src/sync/pull.ts` (`TABLE_UPSERT_SQL` + `rowToValues`), per `docs/SYNC-MIGRATION-CHECKLIST.md`. Column count = placeholder count (3/3).
- `app_config` (synced) is a DIFFERENT table from `app_settings` (local-only: idle pref, last_pulled_at, schema_version). Never sync `app_settings`.
- Tier-4 = `full_admin`, `franchise_manager` (`ROLE_TIER[role] === 4`). `usePermission('system_settings')` is tier-4-exclusive and is the toggle's visibility gate.
- Full Shared Context Pack in the spec: `docs/superpowers/specs/2026-06-26-maintenance-mode-design.md` — every brief ships with it.

---

# WAVE 0 (T1, T2 disjoint — parallel)

### Task 1: Migration 010 — synced `app_config` table + sync wiring

**Files:**
- Create: `apps/api/src/db/migrations/010_app_config.sql`
- Create: `apps/mobile/src/db/migrations/010_app_config.ts`
- Modify: `apps/mobile/src/db/schema.ts` (register migration in `loadMigrations`)
- Modify: `apps/api/src/routes/sync.ts` (`ALLOWED_TABLES`, `FULL_TABLES`, `CONFLICT_TARGETS`)
- Modify: `apps/mobile/src/sync/pull.ts` (`TABLE_UPSERT_SQL`, `rowToValues`)

**Interfaces:**
- Produces: a synced `app_config(key TEXT PK, value TEXT NOT NULL, updated_at)` table on both Postgres and SQLite, reachable through push (`appendOutbox('UPSERT','app_config',…)`) and pull.

- [ ] **Step 1:** Create `apps/api/src/db/migrations/010_app_config.sql`:
```sql
CREATE TABLE IF NOT EXISTS app_config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

- [ ] **Step 2:** Create `apps/mobile/src/db/migrations/010_app_config.ts`:
```typescript
import { DB } from '@op-engineering/op-sqlite';

export const migration = {
  version: 10,
  up: (db: DB): void => {
    db.executeSync(
      `CREATE TABLE IF NOT EXISTS app_config (
         key TEXT PRIMARY KEY,
         value TEXT NOT NULL,
         updated_at TEXT
       )`
    );
  },
};
```

- [ ] **Step 3:** In `apps/mobile/src/db/schema.ts` `loadMigrations()` (the static-import block, ~lines 86–95): add after the m009 line `const { migration: m010 } = await import('./migrations/010_app_config');` and add `m010` to the returned array: `return [m001, m002, m003, m004, m005, m006, m007, m008, m009, m010].sort((a, b) => a.version - b.version);`.

- [ ] **Step 4:** In `apps/api/src/routes/sync.ts`: add `'app_config'` to `ALLOWED_TABLES` (the Set, ~line 15) and to `FULL_TABLES` (the array, ~line 38); add to `CONFLICT_TARGETS` (~line 24): `app_config: 'key',`.

- [ ] **Step 5:** In `apps/mobile/src/sync/pull.ts`: add to `TABLE_UPSERT_SQL` (after `media`): `app_config: \`INSERT OR REPLACE INTO app_config (key, value, updated_at) VALUES (?, ?, ?)\`,` and add a `rowToValues` case before `default`: `case 'app_config': return [row.key, row.value, row.updated_at];`.

- [ ] **Step 6 (controller): verify** `cd apps/mobile && npx tsc --noEmit` clean; `cd apps/api && npx tsc --noEmit` clean. Sanity: `app_config` appears in both `ALLOWED_TABLES` and `FULL_TABLES`; `TABLE_UPSERT_SQL.app_config` has 3 placeholders matching the 3-element `rowToValues` array.

- [ ] **Step 7 (controller): commit** `feat(sync): migration 010 — synced app_config table + sync wiring`.

---

### Task 2: `app_config` local helper + maintenance guard module

**Files:**
- Create: `apps/mobile/src/db/appConfig.ts`
- Create: `apps/mobile/src/db/maintenance.ts`

**Interfaces:**
- Consumes: the `app_config` table name (Task 1) — referenced as a SQL string only, so this task does not depend on Task 1 compiling.
- Produces:
  - `appConfig.ts`: `getAppConfig(key: string): string | null`, `setAppConfigLocal(key: string, value: string): void`.
  - `maintenance.ts`: `class MaintenanceLockedError extends Error`; `setMaintenanceRole(role: UserRole | null): void`; `isMaintenanceActive(): boolean`; `isWriteBlocked(): boolean`; `assertWritable(): void`; `setMaintenanceMode(on: boolean): void`.

- [ ] **Step 1:** Create `apps/mobile/src/db/appConfig.ts`:
```typescript
import { getDb } from './schema';

/** Reads a synced app_config value, or null if unset. */
export function getAppConfig(key: string): string | null {
  try {
    const rows = getDb().executeSync(
      `SELECT value FROM app_config WHERE key = ?`,
      [key],
    ).rows as { value: string }[];
    return rows.length ? rows[0].value : null;
  } catch {
    return null;
  }
}

/** Writes a synced app_config value LOCALLY (does not push — see setMaintenanceMode). */
export function setAppConfigLocal(key: string, value: string): void {
  getDb().executeSync(
    `INSERT OR REPLACE INTO app_config (key, value, updated_at) VALUES (?, ?, ?)`,
    [key, value, new Date().toISOString()],
  );
}
```

- [ ] **Step 2:** Create `apps/mobile/src/db/maintenance.ts`:
```typescript
import { UserRole, ROLE_TIER } from '../constants/roles';
import { getAppConfig, setAppConfigLocal } from './appConfig';
import { appendOutbox } from '../sync/outbox';

const MAINTENANCE_KEY = 'maintenance_mode';

/** Thrown by the write-layer guard when a non-exempt user writes during maintenance. */
export class MaintenanceLockedError extends Error {
  constructor() {
    super('System is under maintenance (read-only).');
    this.name = 'MaintenanceLockedError';
  }
}

// Cached: is the current user tier-4 (exempt from the lockout)? Defaults to
// false so nothing is wrongly exempted before a session resolves.
let exemptRole = false;

/** Wire the current user's role so the guard knows whether they're exempt. */
export function setMaintenanceRole(role: UserRole | null): void {
  exemptRole = role != null && ROLE_TIER[role] === 4;
}

/** Is app-wide maintenance currently ON? */
export function isMaintenanceActive(): boolean {
  return getAppConfig(MAINTENANCE_KEY) === '1';
}

/** Should the current user's writes be blocked right now? */
export function isWriteBlocked(): boolean {
  return isMaintenanceActive() && !exemptRole;
}

/** Hard guard — throws when writes are blocked. Called from appendOutbox. */
export function assertWritable(): void {
  if (isWriteBlocked()) throw new MaintenanceLockedError();
}

/**
 * Admin action: set maintenance ON/OFF. Writes locally AND pushes through the
 * outbox so it syncs to every device. Admins are exempt, so this is never
 * blocked — they can flip it both on and off.
 */
export function setMaintenanceMode(on: boolean): void {
  const value = on ? '1' : '0';
  setAppConfigLocal(MAINTENANCE_KEY, value);
  // 'INSERT' is the outbox's full-row upsert op; the server applies it as
  // INSERT ... ON CONFLICT (key) DO UPDATE (CONFLICT_TARGETS['app_config']='key'
  // from Task 1), so re-toggling updates value + updated_at in place.
  appendOutbox('INSERT', 'app_config', {
    key: MAINTENANCE_KEY,
    value,
    updated_at: new Date().toISOString(),
  });
}
```
Note: `outbox.ts` gains `assertWritable()` at its top in Task 3. Importing `appendOutbox` here while Task 3 adds a `maintenance` import to `outbox.ts` is fine — the cycle is runtime-safe (the guard call happens at append time, not module load) and TypeScript permits it.

- [ ] **Step 3 (controller): verify** `cd apps/mobile && npx tsc --noEmit` clean. (`UserRole` and `ROLE_TIER` are exported from `src/constants/roles.ts`; `OutboxOperation` is `'INSERT' | 'UPDATE' | 'DELETE'` and `setMaintenanceMode` uses `'INSERT'` — verified against `outbox.ts`.)

- [ ] **Step 4 (controller): commit** `feat(maintenance): app_config helper + guard module (flag, role-exempt, assertWritable, toggle)`.

---

# WAVE 1 (after T2 — T3, T4 disjoint, parallel)

### Task 3: Write-layer guard + role wiring + banner + hook

**Files:**
- Modify: `apps/mobile/src/sync/outbox.ts` (call `assertWritable()` in `appendOutbox`)
- Create: `apps/mobile/src/hooks/useMaintenanceMode.ts`
- Modify: `apps/mobile/app/(app)/_layout.tsx` (wire `setMaintenanceRole`, render banner)

**Interfaces:**
- Consumes: `assertWritable`, `isMaintenanceActive`, `setMaintenanceRole` (Task 2); `useSession()` → `{ user }`; `ROLE_TIER` (roles.ts).
- Produces: `useMaintenanceMode(): { active: boolean; locked: boolean }`.

- [ ] **Step 1:** In `apps/mobile/src/sync/outbox.ts`, add at the top of the file: `import { assertWritable } from '../db/maintenance';`. Make `assertWritable()` the **first statement** inside `appendOutbox(...)` (before `const db = getDb();`). Non-exempt writes during maintenance now throw `MaintenanceLockedError` and persist nothing.

- [ ] **Step 2:** Create `apps/mobile/src/hooks/useMaintenanceMode.ts`:
```typescript
import { useState, useCallback } from 'react';
import { useFocusEffect } from 'expo-router';
import { useSession } from './useSession';
import { ROLE_TIER } from '../constants/roles';
import { isMaintenanceActive } from '../db/maintenance';

/**
 * Reactive view of maintenance state for UI. `active` = flag is ON;
 * `locked` = active AND the current user is not tier-4 (so they're read-only).
 * Re-reads on screen focus (covers post-sync-pull changes for v1).
 */
export function useMaintenanceMode(): { active: boolean; locked: boolean } {
  const { user } = useSession();
  const [active, setActive] = useState<boolean>(() => isMaintenanceActive());

  useFocusEffect(
    useCallback(() => {
      setActive(isMaintenanceActive());
    }, []),
  );

  const isTier4 = user != null && ROLE_TIER[user.role] === 4;
  return { active, locked: active && !isTier4 };
}
```

- [ ] **Step 3:** In `apps/mobile/app/(app)/_layout.tsx`:
  - Add imports: `import { Text } from 'react-native';` is already present; add `import { setMaintenanceRole } from '../../src/db/maintenance';` and `import { useMaintenanceMode } from '../../src/hooks/useMaintenanceMode';`.
  - Inside `AppLayout`, after `const { reset } = useIdleLogout(logout);`, add `const maint = useMaintenanceMode();`.
  - Add an effect (after the existing guard effect) to keep the exempt flag in sync:
```typescript
  useEffect(() => {
    setMaintenanceRole(user?.role ?? null);
  }, [user]);
```
  - Render the banner inside the touch-capture `<View>`, immediately above `<Stack>`:
```tsx
      {maint.locked && (
        <View style={styles.banLocked}>
          <Text style={styles.banLockedText}>⚠ System under maintenance — read-only</Text>
        </View>
      )}
      {maint.active && !maint.locked && (
        <View style={styles.banAdmin}>
          <Text style={styles.banAdminText}>Maintenance mode is ON — you have admin override</Text>
        </View>
      )}
```
  - Add to the `StyleSheet.create({...})`:
```typescript
  banLocked: { backgroundColor: '#B45309', paddingVertical: 8, paddingHorizontal: 12 },
  banLockedText: { color: '#fff', fontWeight: '700', textAlign: 'center' },
  banAdmin: { backgroundColor: '#374151', paddingVertical: 6, paddingHorizontal: 12 },
  banAdminText: { color: '#E5E7EB', fontSize: 12, textAlign: 'center' },
```

- [ ] **Step 4 (controller): verify** `cd apps/mobile && npx tsc --noEmit` clean.

- [ ] **Step 5 (controller): commit** `feat(maintenance): write-layer guard + role wiring + banner/hook`.

---

### Task 4: Admin toggle in Settings

**Files:**
- Modify: `apps/mobile/app/(app)/(admin)/settings.tsx`

**Interfaces:**
- Consumes: `setMaintenanceMode`, `isMaintenanceActive` (Task 2); existing `isAdmin = usePermission('system_settings')`, `useFocusEffect`.

- [ ] **Step 1:** In `settings.tsx`, add imports: `import { Switch } from 'react-native';` (add to the existing `react-native` import line) and `import { setMaintenanceMode, isMaintenanceActive } from '../../../src/db/maintenance';`.

- [ ] **Step 2:** Add local state + focus-refresh inside `SettingsScreen` (near the existing state): `const [maintOn, setMaintOn] = useState<boolean>(() => isMaintenanceActive());` and inside an existing or new `useFocusEffect(useCallback(() => { setMaintOn(isMaintenanceActive()); }, []))` (the screen already imports `useFocusEffect`/`useCallback`).

- [ ] **Step 3:** Add a tier-4-gated "System" section in the returned JSX (place it just above the Developer Tools section at ~line 176, inside the same `isAdmin && (...)` style gate the Developer Tools row uses):
```tsx
        {isAdmin && (
          <View style={s.section}>
            <Text style={s.sectionTitle}>System</Text>
            <View style={s.row}>
              <View style={{ flex: 1 }}>
                <Text style={s.rowLabel}>🔧 Maintenance mode</Text>
                <Text style={s.rowSub}>
                  Locks the app to read-only for all non-admin users on every device once it syncs.
                </Text>
              </View>
              <Switch
                value={maintOn}
                onValueChange={(v) => { setMaintenanceMode(v); setMaintOn(v); }}
              />
            </View>
          </View>
        )}
```
(Use the existing `s.section` / `s.sectionTitle` / `s.row` / `s.rowLabel` / `s.rowSub` styles already defined in this file — match whatever the Developer Tools / Account sections use; if a `row` style isn't present, reuse the pattern from the Account card.)

- [ ] **Step 4 (controller): verify** `cd apps/mobile && npx tsc --noEmit` clean. Manual: as a tier-4 user the System section + switch appear; as a tier-1 user they do not.

- [ ] **Step 5 (controller): commit** `feat(settings): maintenance-mode admin toggle`.

---

# WAVE 2 (after T3 — needs the hook)

### Task 5: Disable write CTAs during lockout

**Files (modify — disable the primary submit/confirm control when locked):**
- `apps/mobile/app/(app)/(admin)/quick-add.tsx` (and/or its `src/components/quickadd/*QuickAdd.tsx` submit buttons)
- `apps/mobile/app/(app)/(inventory)/add.tsx`
- `apps/mobile/app/(app)/(locations)/add.tsx`
- `apps/mobile/app/(app)/(jobs)/add.tsx`
- `apps/mobile/app/(app)/(checkout)/` confirm screen and `(checkin)/` confirm screen (the final "Confirm" action)

**Interfaces:**
- Consumes: `useMaintenanceMode()` → `{ locked }` (Task 3).

- [ ] **Step 1:** For each screen above, call `const { locked } = useMaintenanceMode();` at the top of the component (import from `../../../src/hooks/useMaintenanceMode` — adjust depth per file). The implementer must first **read each screen** to find its actual primary submit/confirm `TouchableOpacity`/button and its existing `disabled`/handler.

- [ ] **Step 2:** On that primary control, OR `locked` into the existing disabled condition (e.g. `disabled={saving || locked}`) and, when `locked`, render a short inline note near it: `{locked && <Text style={{ color: '#B45309', marginTop: 8 }}>Read-only during maintenance</Text>}`. Do not change any other behavior. (This is the visible UX; the Task 3 write-layer throw is the backstop for anything not covered here.)

- [ ] **Step 3:** If a screen has no single obvious submit control (e.g. quick-add has four sub-forms), gate each sub-form's save button the same way. Keep edits minimal and local to the submit path.

- [ ] **Step 4 (controller): verify** `cd apps/mobile && npx tsc --noEmit` clean. Manual: with maintenance ON as a non-admin, each listed screen's submit/confirm is disabled and shows the note; as a tier-4 admin the controls remain enabled.

- [ ] **Step 5 (controller): commit** `feat(maintenance): disable write CTAs during lockout`.

---

# SHIP (controller, after all tasks merge)

- [ ] App-wide `npx tsc --noEmit` (mobile + api) clean; whole-branch review (opus, `merge-base..HEAD`).
- [ ] Merge `feat/maintenance-mode` → `main`.
- [ ] **Deploy migration 010 to prod:** build + ship the API image (migration 010 auto-runs on boot); verify `schema_migrations` has 010 and `app_config` exists (`docker exec ... psql`).
- [ ] **Rebuild the dev client AND release APK** — migration 010 changes the native SQLite schema, so this is NOT a JS-only Metro reload; the new `010_app_config.ts` must be bundled. Verify device reaches `schema_version=10` and `app_config` exists.
- [ ] End-to-end: admin flips ON → second device pulls → banner + read-only there; admin OFF → clears everywhere.

## Self-Review (controller checklist)

- **Spec coverage:** U1→T1; U2→T2 (appConfig.ts); U3→T2 (maintenance.ts); U4→T3 (outbox guard + role wiring); U5→T2 `setMaintenanceMode` + T4 (Settings toggle); U6→T3 (hook+banner) + T5 (CTA gating). ✔
- **Placeholder scan:** all code literal; T5 intentionally instructs reading each screen (existing controls vary) but specifies the exact transform (OR `locked` into disabled + note) — no vague "handle it".
- **Type consistency:** `assertWritable`/`isMaintenanceActive`/`setMaintenanceRole`/`setMaintenanceMode`/`isWriteBlocked` defined in T2, consumed by T3/T4/T5 with matching names; `useMaintenanceMode(): {active,locked}` defined T3, consumed T5; `getAppConfig`/`setAppConfigLocal` T2-internal. `setMaintenanceMode` uses `appendOutbox('INSERT',…)` (the real upsert op; server does `ON CONFLICT (key) DO UPDATE`) — verified against `OutboxOperation = 'INSERT'|'UPDATE'|'DELETE'`.
- **File-collision check:** T1 = migrations+schema.ts+sync.ts+pull.ts; T2 = appConfig.ts+maintenance.ts (new); T3 = outbox.ts+useMaintenanceMode.ts+_layout.tsx; T4 = settings.tsx; T5 = add/confirm screens. T1∥T2 (Wave 0). T3∥T4 after T2 (Wave 1). T5 after T3 (Wave 2). All disjoint within a wave. ✔
- **Sync checklist:** T1 touches both `sync.ts` and `pull.ts` in one task with a 3/3 parity check — satisfies `docs/SYNC-MIGRATION-CHECKLIST.md`. ✔
