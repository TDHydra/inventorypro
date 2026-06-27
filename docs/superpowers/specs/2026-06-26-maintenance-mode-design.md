# Maintenance Mode — Design Spec

*Date: 2026-06-26 · Branch: `feat/maintenance-mode` · Program Phase 3b of 4 (3a done / 3b / 3c)*

## Context

A tier-4 admin needs an app-wide "stop the line" switch: flip it on → it syncs to every
device → non-admins go read-only behind a "System under maintenance" banner, while tier-4
admins (`full_admin`, `franchise_manager`) keep full write access so they can correct data
and turn it back off. This is Phase 3b of the Settings program; the Settings screen (Phase 3a)
and the synced-migration discipline (`docs/SYNC-MIGRATION-CHECKLIST.md`) are already in place.

### Decisions locked with the user
- **Who is blocked when ON:** non-admins only. Tier-4 (`full_admin`, `franchise_manager`)
  keep writing — they flip the switch and fix data while locked.
- **Enforcement:** UI **and** write-layer. Banner + disabled write CTAs (primary UX) **and**
  a hard guard at the outbox chokepoint that throws so any missed path also refuses.
- **Storage:** a new **synced** `app_config(key, value, updated_at)` table (migration 010),
  distinct from the existing local-only `app_settings`.

## Global Constraints

- Expo SDK 56 — consult `https://docs.expo.dev/versions/v56.0.0/` before native/API code.
- op-sqlite bind params: only `string | number | null | ArrayBuffer`.
- **Synced migration:** migration 010 adds a synced table → MUST update `apps/api/src/routes/sync.ts`
  (`ALLOWED_TABLES`, `FULL_TABLES`, `CONFLICT_TARGETS`) AND `apps/mobile/src/sync/pull.ts`
  (`TABLE_UPSERT_SQL` + `rowToValues`) in the same change, per `docs/SYNC-MIGRATION-CHECKLIST.md`.
- `app_config` (synced) is NOT the same table as `app_settings` (local-only: idle pref,
  last_pulled_at, schema_version). Keep them separate; never sync `app_settings`.

## Shared Context Pack

- **Synced storage today** — `apps/api/src/routes/sync.ts`: `ALLOWED_TABLES` (Set, push allowlist,
  line ~15), `FULL_TABLES` (array, pull list, line ~38), `CONFLICT_TARGETS` (composite-key upsert
  targets, line ~24; default `'id'`). `apps/mobile/src/sync/pull.ts`: `TABLE_UPSERT_SQL`
  (`Record<string,string>`, line ~6, `INSERT OR REPLACE` per table) + `rowToValues(table,row)`
  switch (line ~20). Column count MUST equal placeholder count.
- **SQLite migrations** — `apps/mobile/src/db/migrations/NNN_*.ts` export
  `{ version: N, up(db): void }`. Registered in `apps/mobile/src/db/schema.ts` `loadMigrations()`
  (static `import` + push into the sorted array, ~line 86–95). Latest is 009 (version 9);
  next is **010 (version 10)**. Runner applies `version > currentVersion` and records
  `app_settings.schema_version`.
- **Postgres migrations** — `apps/api/src/db/migrations/NNN_*.sql`, run on API boot by
  `apps/api/src/db/migrate.ts` (called from `apps/api/src/index.ts`). Latest 009; next **010**.
- **Outbox chokepoint** — `apps/mobile/src/sync/outbox.ts` `appendOutbox(operation, table_name, payload): void`
  is called by every local mutation (including `appendLog` → activity_log). Synchronous.
- **Session/role** — `src/hooks/useSession.ts` → `{ user, logout }`; `user.role: UserRole`.
  `src/constants/roles.ts` `ROLE_TIER: Record<UserRole,1|2|3|4>` (`full_admin`/`franchise_manager` = 4).
  `buildUserSession` (session.ts) builds `{ id, name, role, ... }`.
- **App layout** — `app/(app)/_layout.tsx`: `const { user, logout } = useSession()`; returns null
  when no user; wraps `<Stack>` in a touch-capture `<View style={{flex:1}}>` (idle-logout, Phase 3a).
  Banner mounts inside that View, above the Stack.
- **Settings** — `app/(app)/(admin)/settings.tsx`: gated Developer-tools row uses a permission gate;
  add the maintenance toggle to a tier-4-gated section (`manage_roles_permissions` is tier-4-only in
  `ROLE_DEFAULTS`). `usePermission`/`PermissionGate` exist.
- **app_settings access pattern** — `src/db/appSettings.ts` shows the `INSERT OR REPLACE INTO
  app_settings (key,value) VALUES (?,?)` + `SELECT value ... WHERE key=?` idiom to mirror for
  `app_config`.

---

## Architecture (6 units)

### Unit 1 — Synced `app_config` table (migration 010, both sides)
- **Postgres** `apps/api/src/db/migrations/010_app_config.sql`:
  ```sql
  CREATE TABLE IF NOT EXISTS app_config (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  ```
- **SQLite** `apps/mobile/src/db/migrations/010_app_config.ts` (`version: 10`):
  ```sql
  CREATE TABLE IF NOT EXISTS app_config (
    key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT
  );
  ```
  Register in `schema.ts` `loadMigrations()` (import `m010`, push, keep the `.sort` by version).
- **Sync wiring:** `sync.ts` — add `'app_config'` to `ALLOWED_TABLES` **and** `FULL_TABLES`;
  add `CONFLICT_TARGETS['app_config'] = 'key'`. `pull.ts` — add
  `TABLE_UPSERT_SQL['app_config'] = "INSERT OR REPLACE INTO app_config (key, value, updated_at) VALUES (?, ?, ?)"`
  and a `rowToValues` case `'app_config': return [row.key, row.value, row.updated_at]`.
  (3 columns / 3 placeholders — verify parity.)

### Unit 2 — Local `app_config` read/write helper (`src/db/appConfig.ts`)
- `getAppConfig(key: string): string | null` — `SELECT value FROM app_config WHERE key=?`.
- `setAppConfigLocal(key, value): void` — `INSERT OR REPLACE INTO app_config (key,value,updated_at) VALUES (?,?,?)`
  with `new Date().toISOString()`. (Local write only; Unit 5 pairs it with an outbox push.)

### Unit 3 — Maintenance guard module (`src/db/maintenance.ts`)
Single source of truth; no user param threaded through call sites.
- Module state: `let exemptRole = false;` (true when current user is tier-4).
- `setMaintenanceRole(role: UserRole | null): void` — `exemptRole = role != null && ROLE_TIER[role] === 4`.
- `isMaintenanceActive(): boolean` — `getAppConfig('maintenance_mode') === '1'`.
- `isWriteBlocked(): boolean` — `isMaintenanceActive() && !exemptRole`.
- `assertWritable(): void` — `if (isWriteBlocked()) throw new MaintenanceLockedError()`.
- `export class MaintenanceLockedError extends Error` (named so callers/UI can match).

### Unit 4 — Write-layer enforcement (the belt)
- `appendOutbox()` (outbox.ts) calls `assertWritable()` as its first statement. Any local mutation
  that reaches the outbox without a UI gate throws and writes nothing. Admins (exempt) pass through.
  During a lockout, non-admins perform no mutations, so the `appendLog`→activity_log path is idle too
  (no special-casing needed).
- `setMaintenanceRole(user?.role ?? null)` is wired where the session resolves: call it in
  `(app)/_layout.tsx` (effect on `user`) so the exempt flag tracks login/switch-user. Default
  `exemptRole=false` means before a session loads nothing is wrongly exempted.

### Unit 5 — Admin toggle (Settings) + sync push
- `setMaintenanceMode(on: boolean): void` (in `src/db/maintenance.ts` or `appConfig.ts`):
  `setAppConfigLocal('maintenance_mode', on ? '1' : '0')` **and**
  `appendOutbox('UPSERT', 'app_config', { key: 'maintenance_mode', value: on ? '1':'0', updated_at: <iso> })`.
  Admin is exempt, so this write is never blocked — they can turn it both on and off.
- Settings screen: a tier-4-gated section ("System") with a `Switch` bound to `isMaintenanceActive()`,
  `onValueChange` → `setMaintenanceMode(v)` then refresh. Short helper text: "Locks the app to
  read-only for all non-admin users on every device once it syncs."

### Unit 6 — Banner + UI gating (the suspenders)
- `src/hooks/useMaintenanceMode.ts` → `{ active: boolean, locked: boolean }` where
  `locked = active && ROLE_TIER[user.role] !== 4`. Reads on mount; re-reads on screen focus
  (`useFocusEffect`) and after a sync pull. (Simplest refresh: re-read on focus + on an AppState/
  pull tick; a lightweight module event from `pull.ts` is acceptable but not required — focus-refresh
  is sufficient for v1; note this explicitly so the implementer doesn't over-build.)
- **Banner** in `(app)/_layout.tsx` above `<Stack>`:
  - `locked` → amber bar: "⚠ System under maintenance — read-only".
  - admin while `active` → subdued bar: "Maintenance mode is ON — you have admin override".
  - neither → render nothing.
- **Write CTAs:** the primary entry points (quick-add, add-item/location/equipment, checkout/checkin
  confirm, job create) disable their submit button when `locked` and show "Read-only during maintenance".
  This is the visible UX; the Unit 4 throw is the backstop for anything missed.

---

## File map

| Unit | Files |
|---|---|
| 1 | `apps/api/src/db/migrations/010_app_config.sql` (new), `apps/mobile/src/db/migrations/010_app_config.ts` (new), `apps/mobile/src/db/schema.ts`, `apps/api/src/routes/sync.ts`, `apps/mobile/src/sync/pull.ts` |
| 2 | `apps/mobile/src/db/appConfig.ts` (new) |
| 3 | `apps/mobile/src/db/maintenance.ts` (new) |
| 4 | `apps/mobile/src/sync/outbox.ts`, `apps/mobile/app/(app)/_layout.tsx` |
| 5 | `apps/mobile/src/db/maintenance.ts` (or appConfig.ts), `apps/mobile/app/(app)/(admin)/settings.tsx` |
| 6 | `apps/mobile/src/hooks/useMaintenanceMode.ts` (new), `apps/mobile/app/(app)/_layout.tsx`, write-CTA screens (quick-add, inventory/location/equipment add, checkout/checkin confirm, job add) |

## Verification
- `tsc --noEmit` clean (mobile + api).
- Migration: prod API boot applies 010 (`schema_migrations` has 010; `app_config` table exists);
  device applies SQLite v10 (schema_version=10; `app_config` table exists). Column/placeholder parity
  in `pull.ts` (3/3).
- Manual:
  - Admin flips switch ON in Settings → row persists → second device pulls → its banner appears,
    its write CTAs disable, a write attempt by a non-admin is refused (throw caught / button disabled).
  - Admin device shows the subdued "admin override" banner and can still create/edit.
  - Admin flips OFF → syncs → banners clear, writes resume everywhere.
  - Offline: toggle ON offline → queues in outbox → syncs on reconnect (admin write not blocked).

## Out of scope (3c)
- Simple/Detailed form-mode toggle + field-hiding across forms (Phase 3c) — a separate `app_config`
  key could reuse this same synced table later, but its UI/enforcement is 3c's work.
- Per-screen maintenance scheduling / timed windows (not requested).
- A real-time push (devices learn of maintenance on their next pull, not instantly) — acceptable for v1.

## Ship
- Branch `feat/maintenance-mode` → SDD build → whole-branch review (opus) → merge.
- Deploy: rebuild + ship the API image (migration 010 auto-runs on boot); verify `app_config`.
- **Migration 010 changes the native SQLite schema**, so the **dev client AND release APK must be
  rebuilt** (not a JS-only Metro reload) to bundle `010_app_config.ts`.
