# Vehicles/Lockers Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split vehicles/lockers into their own UX system (shared location storage), add per-action unit access with admin defaults, per-role dashboard picker, on-call rotation + coverage, and locations polish — spec `docs/superpowers/specs/2026-07-19-vehicles-lockers-oncall-redesign-design.md`, epic #122, board items #131–#136.

**Architecture:** Vehicles/lockers stay typed `locations` rows with extension tables keyed by `location_id`; all separation happens in UI/queries. New `unit_access` per-action table generalizes `locker_access`. On-call gains config-driven boundary + rotation autofill + synced `on_call_coverage`. Notifications ride the existing push/routing infra (new `on_call` channel).

**Tech Stack:** Expo SDK 56 / expo-router mobile (op-sqlite; sql.js on web), Fastify + Postgres API, node:test + tsx both sides.

## Global Constraints

- Never Postgres ENUMs — TEXT columns only (prod crash-loop trap).
- Migration ownership: API 057–059 + mobile 045–047 (A1), API 060 + mobile 048 (C). Every mobile migration registered in BOTH `schema.ts` and `schema.web.ts`.
- Watermark rule: rows written/mutated by migrations get `updated_at = NOW()` (incremental-pull visibility).
- `unit_access` DDL and `unitAccess.ts` exports are pinned (see A1); later phases consume them verbatim.
- Config gating UI must notify subscribers (`useSyncExternalStore`) — no read-once module caches.
- Every commit ends with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- After each phase: full test suites green (API + mobile), then dev-APK hotload + on-device user verification before the phase's board item leaves In review.

---



# Phase A1 — Schema (board #131)

## Phase A1 — Schema: two tanks, unit_access, flatten, dedupe, vehicle-name uniqueness (#129)

All paths absolute under `/home/tdpotato/projects/InventoryPro`. Branch: `feat/field-crew-122`. Test commands: API `cd apps/api && node --import tsx --test <file>`, mobile `cd apps/mobile && node --import tsx --import ./src/test/setupGlobals.mjs --test <file>`. Every commit message ends with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

**Watermark rule (applies to Tasks 1, 3, 5):** every row a migration writes or mutates gets `updated_at = NOW()` so already-enrolled devices receive it via incremental `/sync/pull`; fresh devices converge via full download. **PG-enum trap:** TEXT columns only, never `CREATE TYPE`.

### Task 1: API migration 057_two_tanks.sql (+ migration-SQL invariants test)

**Files**
- Create: `apps/api/src/db/migrations/057_two_tanks.sql`
- Test (create): `apps/api/src/db/migrationSql.test.ts` (source-text invariants — the repo's `pullColumns.test.ts` idiom; API tests have no live PG)

**Interfaces**
- Consumes: `vehicles.water_state` (TEXT, `'full' | 'empty_clean'`, migration 054).
- Produces: `vehicles.water_tank TEXT NOT NULL DEFAULT 'empty'` (`'full'|'empty'`), `vehicles.waste_tank TEXT NOT NULL DEFAULT 'clean'` (`'dirty'|'clean'`). `water_state` is kept (deprecated — stop reading it).

**Steps**
- [ ] Write the failing test `apps/api/src/db/migrationSql.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

// Phase A1 migrations run against prod PG on API boot — no live PG in CI, so
// assert the SQL text invariants (the pullColumns.test.ts source-text idiom).
const DIR = join(dirname(new URL(import.meta.url).pathname), 'migrations');
const read = (f: string) => readFileSync(join(DIR, f), 'utf8');

test('057: two TEXT tank columns with the pinned defaults, never a PG enum', () => {
  const sql = read('057_two_tanks.sql');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS water_tank TEXT NOT NULL DEFAULT 'empty'/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS waste_tank TEXT NOT NULL DEFAULT 'clean'/);
  assert.doesNotMatch(sql, /CREATE TYPE/i);
  assert.doesNotMatch(sql, /DROP COLUMN/i); // water_state stays
});

test('057: backfill maps water_state=full → water_tank=full and touches updated_at (watermark)', () => {
  const sql = read('057_two_tanks.sql');
  assert.match(sql, /SET water_tank = 'full', updated_at = NOW\(\)\s+WHERE water_state = 'full'/);
});
```
- [ ] Run it, confirm both tests FAIL (file missing): `cd /home/tdpotato/projects/InventoryPro/apps/api && node --import tsx --test src/db/migrationSql.test.ts`
- [ ] Create `apps/api/src/db/migrations/057_two_tanks.sql`:
```sql
-- Migration 057: two-tank vehicle state (#122 Phase A1). Mirrors mobile 045.
-- water_state stays as a dead column (old APKs still write it; nothing reads it
-- after Phase A2). TEXT, never a PG enum (prod crash-loop trap).
--   water_tank: 'full' | 'empty'
--   waste_tank: 'dirty' | 'clean'  (clean = emptied + cleaned + filter replaced)
-- Backfill: 'full' → water_tank='full'; 'empty_clean' → the column defaults
-- (water empty + waste clean) already say it. Changed rows get updated_at=NOW()
-- so enrolled devices pick them up on incremental pull (watermark rule).
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS water_tank TEXT NOT NULL DEFAULT 'empty';
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS waste_tank TEXT NOT NULL DEFAULT 'clean';
UPDATE vehicles SET water_tank = 'full', updated_at = NOW()
 WHERE water_state = 'full';
```
- [ ] Re-run the test file — both tests pass.
- [ ] Commit: `git add apps/api/src/db/migrations/057_two_tanks.sql apps/api/src/db/migrationSql.test.ts && git commit -m "feat(#122-A1): API migration 057 — two-tank vehicle state"`

### Task 2: Mobile migration 045_two_tanks.ts + sql.js test harness + registration in BOTH schemas

**Files**
- Create: `apps/mobile/src/db/migrations/045_two_tanks.ts`
- Create: `apps/mobile/src/db/migrations/sqljsTestDb.ts` (shared node-only harness; NOT `*.test.ts`)
- Test (create): `apps/mobile/src/db/migrations/045_two_tanks.test.ts`
- Modify: `apps/mobile/src/db/schema.ts` (loadMigrations: import + array) AND `apps/mobile/src/db/schema.web.ts` (Promise.all import array) — web NEVER runs a migration missing from its own array

**Interfaces**
- Produces: `export const migration = { version: 45, up(db: SqlDb): void }`; harness `export async function makeSqlJsDb(): Promise<SqlDb>`.

**Steps**
- [ ] Create the harness `apps/mobile/src/db/migrations/sqljsTestDb.ts` (executeSync wrapper copied from `locationsShelf.testdb.ts`, minus the module-hook — migration modules import nothing native):
```ts
import initSqlJs from 'sql.js';
import type { SqlDb } from '../types';

// Node-only in-memory SqlDb for migration unit tests. Same executeSync shape as
// locationsShelf.testdb.ts; each test builds its own pre-migration tables.
export async function makeSqlJsDb(): Promise<SqlDb> {
  const SQL = await initSqlJs();
  const raw = new SQL.Database();
  return {
    executeSync(sql: string, params?: unknown[]) {
      const rows: Record<string, unknown>[] = [];
      if (params && params.length > 0) {
        const stmt = raw.prepare(sql);
        stmt.bind(params as never[]);
        while (stmt.step()) rows.push(stmt.getAsObject());
        stmt.free();
      } else {
        for (const r of raw.exec(sql)) {
          for (const v of r.values) {
            const obj: Record<string, unknown> = {};
            r.columns.forEach((c, i) => { obj[c] = v[i]; });
            rows.push(obj);
          }
        }
      }
      return { rows };
    },
    close() { raw.close(); },
  };
}
```
- [ ] Write the failing test `apps/mobile/src/db/migrations/045_two_tanks.test.ts`:
```ts
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqlJsDb } from './sqljsTestDb';
import { migration } from './045_two_tanks';
import type { SqlDb } from '../types';

let db: SqlDb;
before(async () => {
  db = await makeSqlJsDb();
  // Pre-045 vehicles shape (migration 042 DDL verbatim).
  db.executeSync(`CREATE TABLE vehicles (
    location_id TEXT PRIMARY KEY, truck_mount INTEGER NOT NULL DEFAULT 0,
    water_state TEXT, model TEXT, model_id TEXT, notes TEXT,
    updated_at TEXT NOT NULL, synced_at TEXT
  )`);
  const seed = (id: string, ws: string | null) =>
    db.executeSync(`INSERT INTO vehicles (location_id, water_state, updated_at) VALUES (?, ?, '2026-07-01T00:00:00.000Z')`, [id, ws]);
  seed('v-full', 'full'); seed('v-empty', 'empty_clean'); seed('v-null', null);
  migration.up(db);
});

test('045: water_state full → water_tank full', () => {
  const r = db.executeSync(`SELECT water_tank, waste_tank FROM vehicles WHERE location_id = 'v-full'`).rows[0] as { water_tank: string; waste_tank: string };
  assert.equal(r.water_tank, 'full');
  assert.equal(r.waste_tank, 'clean');
});

test('045: empty_clean and NULL both land on the defaults (empty/clean)', () => {
  for (const id of ['v-empty', 'v-null']) {
    const r = db.executeSync(`SELECT water_tank, waste_tank FROM vehicles WHERE location_id = ?`, [id]).rows[0] as { water_tank: string; waste_tank: string };
    assert.equal(r.water_tank, 'empty');
    assert.equal(r.waste_tank, 'clean');
  }
});

test('045: water_state column survives (old writers keep working)', () => {
  const r = db.executeSync(`SELECT water_state FROM vehicles WHERE location_id = 'v-full'`).rows[0] as { water_state: string };
  assert.equal(r.water_state, 'full');
});
```
- [ ] Run it, confirm FAIL (module missing): `cd /home/tdpotato/projects/InventoryPro/apps/mobile && node --import tsx --import ./src/test/setupGlobals.mjs --test src/db/migrations/045_two_tanks.test.ts`
- [ ] Create `apps/mobile/src/db/migrations/045_two_tanks.ts`:
```ts
import type { SqlDb } from '../types';

// Migration 045: two-tank vehicle state (#122 Phase A1). Mirrors API 057.
// water_state stays (deprecated — no reader after Phase A2). Backfill: only
// 'full' needs mapping; 'empty_clean' is exactly the new columns' defaults.
export const migration = {
  version: 45,
  up: (db: SqlDb): void => {
    db.executeSync(`ALTER TABLE vehicles ADD COLUMN water_tank TEXT NOT NULL DEFAULT 'empty'`);
    db.executeSync(`ALTER TABLE vehicles ADD COLUMN waste_tank TEXT NOT NULL DEFAULT 'clean'`);
    db.executeSync(`UPDATE vehicles SET water_tank = 'full' WHERE water_state = 'full'`);
  },
};
```
- [ ] Register in `apps/mobile/src/db/schema.ts`: after the `044_on_call` import line add `const { migration: m045 } = await import('./migrations/045_two_tanks');` and append `, m045` inside the returned array (before `.sort`).
- [ ] Register in `apps/mobile/src/db/schema.web.ts`: after `import('./migrations/044_on_call'),` add `import('./migrations/045_two_tanks'),` in the `Promise.all` list.
- [ ] Re-run the test file — all pass.
- [ ] Commit: `git add apps/mobile/src/db/migrations/045_two_tanks.ts apps/mobile/src/db/migrations/045_two_tanks.test.ts apps/mobile/src/db/migrations/sqljsTestDb.ts apps/mobile/src/db/schema.ts apps/mobile/src/db/schema.web.ts && git commit -m "feat(#122-A1): mobile migration 045 — two-tank vehicle state (schema.ts + schema.web.ts)"`

### Task 3: API migration 058_unit_access.sql (table + locker_access copy)

**Files**
- Create: `apps/api/src/db/migrations/058_unit_access.sql`
- Test (modify): `apps/api/src/db/migrationSql.test.ts`

**Interfaces**
- Produces PG table `unit_access(location_id UUID, user_id UUID, can_view..can_grant BOOLEAN, granted_by UUID, created_at, updated_at, PK (location_id, user_id))`. `locker_access` stays (deprecated, stop reading).

**Steps**
- [ ] Add failing tests to `apps/api/src/db/migrationSql.test.ts`:
```ts
test('058: unit_access has the pinned columns, composite PK, and BOOLEAN (not enum) actions', () => {
  const sql = read('058_unit_access.sql');
  for (const col of ['can_view', 'can_add', 'can_remove', 'can_move', 'can_edit_details', 'can_grant']) {
    assert.match(sql, new RegExp(`${col}\\s+BOOLEAN NOT NULL DEFAULT`));
  }
  assert.match(sql, /PRIMARY KEY \(location_id, user_id\)/);
  assert.doesNotMatch(sql, /CREATE TYPE/i);
});

test('058: copies locker_access grants as view+add+remove+move with NOW() watermark', () => {
  const sql = read('058_unit_access.sql');
  assert.match(sql, /SELECT location_id, user_id, TRUE, TRUE, TRUE, TRUE, FALSE, FALSE, granted_by, created_at, NOW\(\)\s+FROM locker_access/);
  assert.match(sql, /ON CONFLICT \(location_id, user_id\) DO NOTHING/);
  assert.doesNotMatch(sql, /DROP TABLE/i); // locker_access stays
});
```
- [ ] Run `node --import tsx --test src/db/migrationSql.test.ts` — new tests FAIL.
- [ ] Create `apps/api/src/db/migrations/058_unit_access.sql`:
```sql
-- Migration 058: per-action unit access (#122 Phase A1). Mirrors mobile 046.
-- Generalizes locker_access to BOTH vehicles and lockers with per-action
-- booleans. locker_access is kept (deprecated — the ADJUST guard and access
-- kernel move to unit_access in code; nothing drops the old table). Soft FKs;
-- composite PK is the sync conflict target (locker_access pattern, 055).
-- Copy: an existing grant = view+add+remove+move (approved design, section B).
-- updated_at = NOW() on copied rows so enrolled devices pull them (watermark).
CREATE TABLE IF NOT EXISTS unit_access (
  location_id      UUID NOT NULL,
  user_id          UUID NOT NULL,
  can_view         BOOLEAN NOT NULL DEFAULT TRUE,
  can_add          BOOLEAN NOT NULL DEFAULT FALSE,
  can_remove       BOOLEAN NOT NULL DEFAULT FALSE,
  can_move         BOOLEAN NOT NULL DEFAULT FALSE,
  can_edit_details BOOLEAN NOT NULL DEFAULT FALSE,
  can_grant        BOOLEAN NOT NULL DEFAULT FALSE,
  granted_by       UUID,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (location_id, user_id)
);
CREATE INDEX IF NOT EXISTS unit_access_user_idx ON unit_access(user_id);

INSERT INTO unit_access (location_id, user_id, can_view, can_add, can_remove, can_move, can_edit_details, can_grant, granted_by, created_at, updated_at)
SELECT location_id, user_id, TRUE, TRUE, TRUE, TRUE, FALSE, FALSE, granted_by, created_at, NOW()
  FROM locker_access
ON CONFLICT (location_id, user_id) DO NOTHING;
```
- [ ] Re-run the test file — pass.
- [ ] Commit: `git add apps/api/src/db/migrations/058_unit_access.sql apps/api/src/db/migrationSql.test.ts && git commit -m "feat(#122-A1): API migration 058 — unit_access table + locker_access copy"`

### Task 4: Mobile migration 046_unit_access.ts + registration

**Files**
- Create: `apps/mobile/src/db/migrations/046_unit_access.ts`
- Test (create): `apps/mobile/src/db/migrations/046_unit_access.test.ts`
- Modify: `apps/mobile/src/db/schema.ts`, `apps/mobile/src/db/schema.web.ts`

**Interfaces**
- Produces SQLite table `unit_access` — same columns as PG but TEXT keys, INTEGER 0/1 booleans, plus local-only `synced_at`; `{ version: 46, up(db) }`.

**Steps**
- [ ] Write the failing test `apps/mobile/src/db/migrations/046_unit_access.test.ts`:
```ts
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqlJsDb } from './sqljsTestDb';
import { migration } from './046_unit_access';
import type { SqlDb } from '../types';

let db: SqlDb;
before(async () => {
  db = await makeSqlJsDb();
  // Pre-046 locker_access shape (migration 043 DDL verbatim).
  db.executeSync(`CREATE TABLE locker_access (
    location_id TEXT NOT NULL, user_id TEXT NOT NULL, granted_by TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, synced_at TEXT,
    PRIMARY KEY (location_id, user_id)
  )`);
  db.executeSync(`INSERT INTO locker_access VALUES ('loc-1', 'user-a', 'owner-1', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')`);
  migration.up(db);
});

test('046: legacy grant copied as view+add+remove+move, not edit/grant', () => {
  const r = db.executeSync(`SELECT * FROM unit_access WHERE location_id = 'loc-1' AND user_id = 'user-a'`).rows[0] as Record<string, unknown>;
  assert.ok(r, 'copied row exists');
  assert.equal(r.can_view, 1);
  assert.equal(r.can_add, 1);
  assert.equal(r.can_remove, 1);
  assert.equal(r.can_move, 1);
  assert.equal(r.can_edit_details, 0);
  assert.equal(r.can_grant, 0);
  assert.equal(r.granted_by, 'owner-1');
});

test('046: locker_access survives untouched (deprecated, not dropped)', () => {
  assert.equal(db.executeSync(`SELECT COUNT(*) AS n FROM locker_access`).rows[0]!.n, 1);
});
```
- [ ] Run it — FAIL (module missing).
- [ ] Create `apps/mobile/src/db/migrations/046_unit_access.ts`:
```ts
import type { SqlDb } from '../types';

// Migration 046: per-action unit access (#122 Phase A1). Mirrors API 058.
// Copies locker_access grants as view+add+remove+move (synced_at carried over —
// the server ran the same copy, so nothing needs re-pushing). locker_access
// stays; readers move to unit_access in code.
export const migration = {
  version: 46,
  up: (db: SqlDb): void => {
    db.executeSync(`CREATE TABLE IF NOT EXISTS unit_access (
      location_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      can_view INTEGER NOT NULL DEFAULT 1,
      can_add INTEGER NOT NULL DEFAULT 0,
      can_remove INTEGER NOT NULL DEFAULT 0,
      can_move INTEGER NOT NULL DEFAULT 0,
      can_edit_details INTEGER NOT NULL DEFAULT 0,
      can_grant INTEGER NOT NULL DEFAULT 0,
      granted_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      synced_at TEXT,
      PRIMARY KEY (location_id, user_id)
    )`);
    db.executeSync(`CREATE INDEX IF NOT EXISTS unit_access_user_idx ON unit_access(user_id)`);
    db.executeSync(
      `INSERT OR IGNORE INTO unit_access
         (location_id, user_id, can_view, can_add, can_remove, can_move, can_edit_details, can_grant, granted_by, created_at, updated_at, synced_at)
       SELECT location_id, user_id, 1, 1, 1, 1, 0, 0, granted_by, created_at, updated_at, synced_at
         FROM locker_access`,
    );
  },
};
```
- [ ] Register `m046` in `apps/mobile/src/db/schema.ts` (import + array entry after `m045`) and `import('./migrations/046_unit_access'),` in `apps/mobile/src/db/schema.web.ts`.
- [ ] Re-run the test file — pass.
- [ ] Commit: `git add apps/mobile/src/db/migrations/046_unit_access.ts apps/mobile/src/db/migrations/046_unit_access.test.ts apps/mobile/src/db/schema.ts apps/mobile/src/db/schema.web.ts && git commit -m "feat(#122-A1): mobile migration 046 — unit_access + locker_access copy"`

### Task 5: API migration 059_flatten_and_dedupe.sql

**Files**
- Create: `apps/api/src/db/migrations/059_flatten_and_dedupe.sql`
- Test (modify): `apps/api/src/db/migrationSql.test.ts`

**Interfaces**
- Consumes: `locations` (parent_id nesting, `type IN ('Vehicle','Locker')`), `stock_by_location` (PK `item_id, location_id`), `vehicle_checkouts`, `vehicle_service_records`, `vehicles`, `unit_access`, `equipment_units.current_location_id`.
- Produces: no descendants under Vehicle/Locker (children retired `active=FALSE`, stock summed onto the unit); one active Vehicle location per `LOWER(TRIM(name))` — survivor = oldest `updated_at`, tiebreak `id::text` (must match mobile 047's `ORDER BY updated_at ASC, id ASC` text ordering, hence the `::text` cast).

**Steps**
- [ ] Add failing tests to `apps/api/src/db/migrationSql.test.ts`:
```ts
test('059: flatten re-points stock with a summed upsert and zeroes+retires children with NOW()', () => {
  const sql = read('059_flatten_and_dedupe.sql');
  assert.match(sql, /WITH RECURSIVE/);
  assert.match(sql, /GROUP BY s\.item_id, uc\.unit_id/); // pre-aggregated: ON CONFLICT DO UPDATE may not hit a row twice
  assert.match(sql, /SET quantity = stock_by_location\.quantity \+ EXCLUDED\.quantity, updated_at = NOW\(\)/);
  assert.match(sql, /SET quantity = 0, updated_at = NOW\(\)/);
  assert.match(sql, /SET active = FALSE, updated_at = NOW\(\)/);
});

test('059: vehicle dedupe survivor choice matches mobile 047 (updated_at ASC, id::text ASC)', () => {
  const sql = read('059_flatten_and_dedupe.sql');
  assert.match(sql, /PARTITION BY LOWER\(TRIM\(name\)\) ORDER BY updated_at ASC, id::text ASC/);
  for (const t of ['vehicle_checkouts', 'vehicle_service_records', 'equipment_units']) {
    assert.ok(sql.includes(t), `${t} re-pointed`);
  }
});
```
- [ ] Run the file — new tests FAIL.
- [ ] Create `apps/api/src/db/migrations/059_flatten_and_dedupe.sql` (migrate.ts runs the whole file as one multi-statement query on one connection, so TEMP tables carry across statements):
```sql
-- Migration 059 (#122 Phase A1, bug #129): flatten Vehicle/Locker sub-areas
-- (construction van) and merge duplicate Vehicle locations by normalized name.
-- Mirrors mobile 047. Every touched row gets updated_at = NOW() (watermark) so
-- enrolled devices converge on incremental pull; deletes below only hit rows
-- whose parent location is simultaneously retired, so stale client copies are
-- unreachable rather than wrong.

-- ── 1. Flatten: no sub-areas under vehicles/lockers ─────────────────────────
CREATE TEMP TABLE unit_children AS
WITH RECURSIVE uc AS (
  SELECT c.id, c.parent_id AS unit_id
    FROM locations c JOIN locations p ON p.id = c.parent_id
   WHERE p.type IN ('Vehicle', 'Locker')
  UNION ALL
  SELECT c.id, uc.unit_id FROM locations c JOIN uc ON c.parent_id = uc.id
)
SELECT id, unit_id FROM uc;

INSERT INTO stock_by_location (item_id, location_id, quantity, updated_at)
SELECT s.item_id, uc.unit_id, SUM(s.quantity), NOW()
  FROM stock_by_location s JOIN unit_children uc ON s.location_id = uc.id
 WHERE s.quantity <> 0
 GROUP BY s.item_id, uc.unit_id
ON CONFLICT (item_id, location_id) DO UPDATE
   SET quantity = stock_by_location.quantity + EXCLUDED.quantity, updated_at = NOW();

UPDATE stock_by_location SET quantity = 0, updated_at = NOW()
 WHERE location_id IN (SELECT id FROM unit_children) AND quantity <> 0;

UPDATE locations SET active = FALSE, updated_at = NOW()
 WHERE id IN (SELECT id FROM unit_children) AND active = TRUE;

-- ── 2. Dedupe: one active Vehicle location per LOWER(TRIM(name)) ────────────
-- Survivor = oldest updated_at, tiebreak id::text (text compare matches SQLite).
CREATE TEMP TABLE vehicle_dupes AS
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (PARTITION BY LOWER(TRIM(name)) ORDER BY updated_at ASC, id::text ASC) AS rn,
         FIRST_VALUE(id) OVER (PARTITION BY LOWER(TRIM(name)) ORDER BY updated_at ASC, id::text ASC) AS survivor_id
    FROM locations
   WHERE type = 'Vehicle' AND active = TRUE
)
SELECT id AS dup_id, survivor_id FROM ranked WHERE rn > 1;

INSERT INTO stock_by_location (item_id, location_id, quantity, updated_at)
SELECT s.item_id, d.survivor_id, SUM(s.quantity), NOW()
  FROM stock_by_location s JOIN vehicle_dupes d ON s.location_id = d.dup_id
 WHERE s.quantity <> 0
 GROUP BY s.item_id, d.survivor_id
ON CONFLICT (item_id, location_id) DO UPDATE
   SET quantity = stock_by_location.quantity + EXCLUDED.quantity, updated_at = NOW();

UPDATE stock_by_location SET quantity = 0, updated_at = NOW()
 WHERE location_id IN (SELECT dup_id FROM vehicle_dupes) AND quantity <> 0;

UPDATE vehicle_checkouts vc SET vehicle_location_id = d.survivor_id, updated_at = NOW()
  FROM vehicle_dupes d WHERE vc.vehicle_location_id = d.dup_id;

UPDATE vehicle_service_records r SET vehicle_location_id = d.survivor_id, updated_at = NOW()
  FROM vehicle_dupes d WHERE r.vehicle_location_id = d.dup_id;

UPDATE equipment_units e SET current_location_id = d.survivor_id, updated_at = NOW()
  FROM vehicle_dupes d WHERE e.current_location_id = d.dup_id;

-- vehicles extension row: survivor's wins; adopt the dup's only when absent.
INSERT INTO vehicles (location_id, truck_mount, water_state, model, model_id, notes, updated_at, water_tank, waste_tank)
SELECT d.survivor_id, v.truck_mount, v.water_state, v.model, v.model_id, v.notes, NOW(), v.water_tank, v.waste_tank
  FROM vehicles v JOIN vehicle_dupes d ON v.location_id = d.dup_id
ON CONFLICT (location_id) DO NOTHING;
DELETE FROM vehicles WHERE location_id IN (SELECT dup_id FROM vehicle_dupes);

-- Grants move to the survivor; an existing survivor grant wins.
INSERT INTO unit_access (location_id, user_id, can_view, can_add, can_remove, can_move, can_edit_details, can_grant, granted_by, created_at, updated_at)
SELECT d.survivor_id, ua.user_id, ua.can_view, ua.can_add, ua.can_remove, ua.can_move, ua.can_edit_details, ua.can_grant, ua.granted_by, ua.created_at, NOW()
  FROM unit_access ua JOIN vehicle_dupes d ON ua.location_id = d.dup_id
ON CONFLICT (location_id, user_id) DO NOTHING;
DELETE FROM unit_access WHERE location_id IN (SELECT dup_id FROM vehicle_dupes);

UPDATE locations SET active = FALSE, updated_at = NOW()
 WHERE id IN (SELECT dup_id FROM vehicle_dupes);

DROP TABLE unit_children;
DROP TABLE vehicle_dupes;
```
- [ ] Re-run `node --import tsx --test src/db/migrationSql.test.ts` — pass.
- [ ] Commit: `git add apps/api/src/db/migrations/059_flatten_and_dedupe.sql apps/api/src/db/migrationSql.test.ts && git commit -m "feat(#122-A1,#129): API migration 059 — flatten van children + vehicle dedupe merge"`

### Task 6: Mobile migration 047_flatten_and_dedupe.ts + registration

**Files**
- Create: `apps/mobile/src/db/migrations/047_flatten_and_dedupe.ts`
- Test (create): `apps/mobile/src/db/migrations/047_flatten_and_dedupe.test.ts`
- Modify: `apps/mobile/src/db/schema.ts`, `apps/mobile/src/db/schema.web.ts`

**Interfaces**
- Produces `{ version: 47, up(db) }` — SQLite mirror of API 059 (same survivor ordering `updated_at ASC, id ASC`; SQLite compares TEXT ids exactly like PG's `id::text`). No outbox writes: the server runs its own 059; pushing merge results would double-apply.

**Steps**
- [ ] Write the failing test `apps/mobile/src/db/migrations/047_flatten_and_dedupe.test.ts`:
```ts
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqlJsDb } from './sqljsTestDb';
import { migration } from './047_flatten_and_dedupe';
import type { SqlDb } from '../types';

let db: SqlDb;
const T = '2026-07-01T00:00:00.000Z';
before(async () => {
  db = await makeSqlJsDb();
  db.executeSync(`CREATE TABLE locations (id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT, type TEXT, active INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, synced_at TEXT)`);
  db.executeSync(`CREATE TABLE stock_by_location (item_id TEXT NOT NULL, location_id TEXT NOT NULL, quantity REAL NOT NULL, updated_at TEXT NOT NULL, synced_at TEXT, PRIMARY KEY (item_id, location_id))`);
  db.executeSync(`CREATE TABLE vehicle_checkouts (id TEXT PRIMARY KEY, vehicle_location_id TEXT NOT NULL, user_id TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  db.executeSync(`CREATE TABLE vehicle_service_records (id TEXT PRIMARY KEY, vehicle_location_id TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  db.executeSync(`CREATE TABLE equipment_units (id TEXT PRIMARY KEY, current_location_id TEXT, updated_at TEXT NOT NULL)`);
  db.executeSync(`CREATE TABLE vehicles (location_id TEXT PRIMARY KEY, truck_mount INTEGER NOT NULL DEFAULT 0, water_state TEXT, model TEXT, model_id TEXT, notes TEXT, updated_at TEXT NOT NULL, synced_at TEXT, water_tank TEXT NOT NULL DEFAULT 'empty', waste_tank TEXT NOT NULL DEFAULT 'clean')`);
  db.executeSync(`CREATE TABLE unit_access (location_id TEXT NOT NULL, user_id TEXT NOT NULL, can_view INTEGER NOT NULL DEFAULT 1, can_add INTEGER NOT NULL DEFAULT 0, can_remove INTEGER NOT NULL DEFAULT 0, can_move INTEGER NOT NULL DEFAULT 0, can_edit_details INTEGER NOT NULL DEFAULT 0, can_grant INTEGER NOT NULL DEFAULT 0, granted_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, synced_at TEXT, PRIMARY KEY (location_id, user_id))`);
  const loc = (id: string, name: string, parent: string | null, type: string | null, updated = T) =>
    db.executeSync(`INSERT INTO locations (id, name, parent_id, type, active, updated_at) VALUES (?,?,?,?,1,?)`, [id, name, parent, type, updated]);
  // Construction van with a room and a shelf inside the room, each with stock.
  loc('van-c', 'Construction Van', null, 'Vehicle');
  loc('room-1', 'Back Shelving', 'van-c', 'Room');
  loc('shelf-1', 'Bin A', 'room-1', 'Shelf');
  db.executeSync(`INSERT INTO stock_by_location VALUES ('item-1', 'van-c', 2, ?, NULL), ('item-1', 'room-1', 3, ?, NULL), ('item-1', 'shelf-1', 5, ?, NULL)`, [T, T, T]);
  // Duplicate vehicles: 'Van 7' (older → survivor) and ' van 7 ' (dup).
  loc('veh-old', 'Van 7', null, 'Vehicle', '2026-06-01T00:00:00.000Z');
  loc('veh-dup', ' van 7 ', null, 'Vehicle', '2026-07-10T00:00:00.000Z');
  db.executeSync(`INSERT INTO stock_by_location VALUES ('item-2', 'veh-dup', 4, ?, NULL)`, [T]);
  db.executeSync(`INSERT INTO vehicle_checkouts VALUES ('co-1', 'veh-dup', 'user-a', ?)`, [T]);
  db.executeSync(`INSERT INTO vehicle_service_records VALUES ('sr-1', 'veh-dup', ?)`, [T]);
  db.executeSync(`INSERT INTO equipment_units VALUES ('eq-1', 'veh-dup', ?)`, [T]);
  db.executeSync(`INSERT INTO vehicles (location_id, truck_mount, updated_at) VALUES ('veh-dup', 1, ?)`, [T]);
  migration.up(db);
});

test('047 flatten: descendant stock summed onto the van, children zeroed and retired', () => {
  assert.equal(db.executeSync(`SELECT quantity FROM stock_by_location WHERE item_id='item-1' AND location_id='van-c'`).rows[0]!.quantity, 10);
  assert.equal(db.executeSync(`SELECT SUM(quantity) AS q FROM stock_by_location WHERE location_id IN ('room-1','shelf-1')`).rows[0]!.q, 0);
  assert.equal(db.executeSync(`SELECT COUNT(*) AS n FROM locations WHERE id IN ('room-1','shelf-1') AND active = 0`).rows[0]!.n, 2);
});

test('047 dedupe: oldest normalized-name vehicle survives; refs re-pointed; dup retired', () => {
  assert.equal(db.executeSync(`SELECT active FROM locations WHERE id='veh-dup'`).rows[0]!.active, 0);
  assert.equal(db.executeSync(`SELECT active FROM locations WHERE id='veh-old'`).rows[0]!.active, 1);
  assert.equal(db.executeSync(`SELECT quantity FROM stock_by_location WHERE item_id='item-2' AND location_id='veh-old'`).rows[0]!.quantity, 4);
  assert.equal(db.executeSync(`SELECT vehicle_location_id FROM vehicle_checkouts WHERE id='co-1'`).rows[0]!.vehicle_location_id, 'veh-old');
  assert.equal(db.executeSync(`SELECT vehicle_location_id FROM vehicle_service_records WHERE id='sr-1'`).rows[0]!.vehicle_location_id, 'veh-old');
  assert.equal(db.executeSync(`SELECT current_location_id FROM equipment_units WHERE id='eq-1'`).rows[0]!.current_location_id, 'veh-old');
  assert.equal(db.executeSync(`SELECT truck_mount FROM vehicles WHERE location_id='veh-old'`).rows[0]!.truck_mount, 1); // adopted (survivor had none)
  assert.equal(db.executeSync(`SELECT COUNT(*) AS n FROM vehicles WHERE location_id='veh-dup'`).rows[0]!.n, 0);
});
```
- [ ] Run it — FAIL (module missing).
- [ ] Create `apps/mobile/src/db/migrations/047_flatten_and_dedupe.ts`:
```ts
import type { SqlDb } from '../types';

// Migration 047 (#122 Phase A1, #129): SQLite mirror of API 059 — flatten
// Vehicle/Locker sub-areas, dedupe Vehicle locations by LOWER(TRIM(name)).
// Survivor ordering (updated_at ASC, id ASC) matches PG's (updated_at, id::text)
// so both sides pick the SAME survivor and converge without conflict. No outbox
// writes — the server runs 059 itself.
export const migration = {
  version: 47,
  up: (db: SqlDb): void => {
    const now = new Date().toISOString();
    // ── 1. Flatten ──────────────────────────────────────────────────────────
    db.executeSync(`CREATE TEMP TABLE unit_children AS
      WITH RECURSIVE uc(id, unit_id) AS (
        SELECT c.id, c.parent_id FROM locations c
          JOIN locations p ON p.id = c.parent_id
         WHERE p.type IN ('Vehicle', 'Locker')
        UNION ALL
        SELECT c.id, uc.unit_id FROM locations c JOIN uc ON c.parent_id = uc.id
      )
      SELECT id, unit_id FROM uc`);
    db.executeSync(
      `INSERT INTO stock_by_location (item_id, location_id, quantity, updated_at)
       SELECT s.item_id, uc.unit_id, SUM(s.quantity), ?
         FROM stock_by_location s JOIN unit_children uc ON s.location_id = uc.id
        WHERE s.quantity <> 0
        GROUP BY s.item_id, uc.unit_id
       ON CONFLICT (item_id, location_id) DO UPDATE
          SET quantity = quantity + excluded.quantity, updated_at = excluded.updated_at`,
      [now],
    );
    db.executeSync(`UPDATE stock_by_location SET quantity = 0, updated_at = ? WHERE location_id IN (SELECT id FROM unit_children) AND quantity <> 0`, [now]);
    db.executeSync(`UPDATE locations SET active = 0, updated_at = ? WHERE id IN (SELECT id FROM unit_children) AND active = 1`, [now]);
    // ── 2. Dedupe vehicles ─────────────────────────────────────────────────
    db.executeSync(`CREATE TEMP TABLE vehicle_dupes AS
      WITH ranked AS (
        SELECT id,
               ROW_NUMBER() OVER (PARTITION BY LOWER(TRIM(name)) ORDER BY updated_at ASC, id ASC) AS rn,
               FIRST_VALUE(id) OVER (PARTITION BY LOWER(TRIM(name)) ORDER BY updated_at ASC, id ASC) AS survivor_id
          FROM locations WHERE type = 'Vehicle' AND active = 1
      )
      SELECT id AS dup_id, survivor_id FROM ranked WHERE rn > 1`);
    db.executeSync(
      `INSERT INTO stock_by_location (item_id, location_id, quantity, updated_at)
       SELECT s.item_id, d.survivor_id, SUM(s.quantity), ?
         FROM stock_by_location s JOIN vehicle_dupes d ON s.location_id = d.dup_id
        WHERE s.quantity <> 0
        GROUP BY s.item_id, d.survivor_id
       ON CONFLICT (item_id, location_id) DO UPDATE
          SET quantity = quantity + excluded.quantity, updated_at = excluded.updated_at`,
      [now],
    );
    db.executeSync(`UPDATE stock_by_location SET quantity = 0, updated_at = ? WHERE location_id IN (SELECT dup_id FROM vehicle_dupes) AND quantity <> 0`, [now]);
    db.executeSync(`UPDATE vehicle_checkouts SET vehicle_location_id = (SELECT survivor_id FROM vehicle_dupes WHERE dup_id = vehicle_location_id), updated_at = ? WHERE vehicle_location_id IN (SELECT dup_id FROM vehicle_dupes)`, [now]);
    db.executeSync(`UPDATE vehicle_service_records SET vehicle_location_id = (SELECT survivor_id FROM vehicle_dupes WHERE dup_id = vehicle_location_id), updated_at = ? WHERE vehicle_location_id IN (SELECT dup_id FROM vehicle_dupes)`, [now]);
    db.executeSync(`UPDATE equipment_units SET current_location_id = (SELECT survivor_id FROM vehicle_dupes WHERE dup_id = current_location_id), updated_at = ? WHERE current_location_id IN (SELECT dup_id FROM vehicle_dupes)`, [now]);
    db.executeSync(
      `INSERT OR IGNORE INTO vehicles (location_id, truck_mount, water_state, model, model_id, notes, updated_at, synced_at, water_tank, waste_tank)
       SELECT d.survivor_id, v.truck_mount, v.water_state, v.model, v.model_id, v.notes, ?, NULL, v.water_tank, v.waste_tank
         FROM vehicles v JOIN vehicle_dupes d ON v.location_id = d.dup_id`,
      [now],
    );
    db.executeSync(`DELETE FROM vehicles WHERE location_id IN (SELECT dup_id FROM vehicle_dupes)`);
    db.executeSync(
      `INSERT OR IGNORE INTO unit_access (location_id, user_id, can_view, can_add, can_remove, can_move, can_edit_details, can_grant, granted_by, created_at, updated_at, synced_at)
       SELECT d.survivor_id, ua.user_id, ua.can_view, ua.can_add, ua.can_remove, ua.can_move, ua.can_edit_details, ua.can_grant, ua.granted_by, ua.created_at, ?, NULL
         FROM unit_access ua JOIN vehicle_dupes d ON ua.location_id = d.dup_id`,
      [now],
    );
    db.executeSync(`DELETE FROM unit_access WHERE location_id IN (SELECT dup_id FROM vehicle_dupes)`);
    db.executeSync(`UPDATE locations SET active = 0, updated_at = ? WHERE id IN (SELECT dup_id FROM vehicle_dupes)`, [now]);
    db.executeSync(`DROP TABLE unit_children`);
    db.executeSync(`DROP TABLE vehicle_dupes`);
  },
};
```
- [ ] Register `m047` in `apps/mobile/src/db/schema.ts` and `import('./migrations/047_flatten_and_dedupe'),` in `apps/mobile/src/db/schema.web.ts`.
- [ ] Run the test file — pass. Also re-run 045/046 tests to confirm no harness regression.
- [ ] Commit: `git add apps/mobile/src/db/migrations/047_flatten_and_dedupe.ts apps/mobile/src/db/migrations/047_flatten_and_dedupe.test.ts apps/mobile/src/db/schema.ts apps/mobile/src/db/schema.web.ts && git commit -m "feat(#122-A1,#129): mobile migration 047 — flatten + vehicle dedupe"`

### Task 7: API sync plumbing — unit_access synced + guarded, two-tank columns pulled

**Files**
- Modify: `apps/api/src/lib/syncPolicy.ts`, `apps/api/src/routes/sync.ts`
- Test (modify): `apps/api/src/lib/syncPolicy.test.ts`, `apps/api/src/routes/sync-guards.test.ts`

**Interfaces**
- Consumes: `applyWritePolicy`, `requiredOperationPerm`, `selectColumnsFor`, `ATTRIBUTION_COLUMNS`, sync.ts `ALLOWED_TABLES`/`FULL_TABLES`/`CONFLICT_TARGETS` and the existing `locker_access` per-row owner guard (~line 1248).
- Produces: `unit_access` fully synced (push+pull+full), guarded per-row exactly like `locker_access`; `VEHICLES_COLS` includes `water_tank, waste_tank`.

**Steps**
- [ ] Failing tests first. In `apps/api/src/lib/syncPolicy.test.ts` add:
```ts
test('unit_access: ops open to any authed user (real gate is the per-row owner guard in sync.ts)', () => {
  assert.equal(requiredOperationPerm('unit_access', 'INSERT'), null);
  assert.equal(requiredOperationPerm('unit_access', 'UPDATE'), null);
  assert.equal(requiredOperationPerm('unit_access', 'DELETE'), null);
});

test('unit_access: granted_by is attribution-forced to the caller', () => {
  const cols = new Map([['unit_access', new Set(['location_id', 'user_id', 'can_view', 'can_add', 'can_remove', 'can_move', 'can_edit_details', 'can_grant', 'granted_by', 'created_at', 'updated_at'])]]);
  const { row } = applyWritePolicy('unit_access', 'INSERT', { location_id: 'l1', user_id: 'u2', can_view: true, granted_by: 'someone-else' }, 'caller-1', cols, () => true);
  assert.equal(row.granted_by, 'caller-1');
});

test('selectColumnsFor: unit_access + two-tank vehicle columns', () => {
  assert.equal(selectColumnsFor('unit_access', false), 'location_id, user_id, can_view, can_add, can_remove, can_move, can_edit_details, can_grant, granted_by, created_at, updated_at');
  assert.match(selectColumnsFor('vehicles', false), /water_tank, waste_tank/);
});
```
(match the file's existing import list; add `requiredOperationPerm`/`applyWritePolicy`/`selectColumnsFor` imports if missing). Run `node --import tsx --test src/lib/syncPolicy.test.ts` — FAIL.
- [ ] In `apps/api/src/lib/syncPolicy.ts`:
  - `ATTRIBUTION_COLUMNS`: add `unit_access: ['granted_by'],` under the existing `locker_access: ['granted_by'],` line.
  - `OPERATION_PERM`: add `unit_access:               { INSERT: null, UPDATE: null, DELETE: null },` under the `locker_access` line (same rationale comment: the real gate is the per-row owner guard).
  - Change `const VEHICLES_COLS = 'location_id, truck_mount, water_state, model, model_id, notes, updated_at';` to `'location_id, truck_mount, water_state, model, model_id, notes, updated_at, water_tank, waste_tank'`.
  - Add `const UNIT_ACCESS_COLS = 'location_id, user_id, can_view, can_add, can_remove, can_move, can_edit_details, can_grant, granted_by, created_at, updated_at';` next to `LOCKER_ACCESS_COLS` and `if (table === 'unit_access') return UNIT_ACCESS_COLS;` in `selectColumnsFor` next to the `locker_access` branch.
- [ ] In `apps/api/src/routes/sync.ts`:
  - `ALLOWED_TABLES`: append `'unit_access',` after `'locker_access', 'on_call_shifts',`.
  - `FULL_TABLES` (~line 248): append `'unit_access',` the same way.
  - `CONFLICT_TARGETS`: add `unit_access: 'location_id, user_id',`.
  - Per-row guard (~line 1248): change `if (entry.table_name === 'locker_access') {` to `if (entry.table_name === 'locker_access' || entry.table_name === 'unit_access') {` and change the denial message line to `` conflicts.push({ id: entry.id, error: 'Forbidden: only the unit owner can manage access' }); `` (wording still matches the mobile permanent-rejection regex `/forbidden|cannot|not allowed/i`; update the missing-location message to `'Forbidden: unit location does not exist'`).
- [ ] In `apps/api/src/routes/sync-guards.test.ts`: add `unit_access: ['location_id', 'user_id', 'can_view', 'can_add', 'can_remove', 'can_move', 'can_edit_details', 'can_grant', 'granted_by', 'created_at', 'updated_at']` to the `COLUMNS` map, then add tests (mirror the four existing `locker_access` tests at lines 395–437):
```ts
test('unit_access: the unit OWNER may grant, and granted_by is forced to the caller', async () => {
  const pg = fakePg({ callerRole: 'mitigation_technician', lockerOwner: CALLER });
  const app = await buildApp(pg);
  const res = await app.inject({ method: 'POST', url: '/sync/push', payload: pushBody([
    { operation: 'INSERT', table_name: 'unit_access', payload: { location_id: 'loc-1', user_id: OTHER, can_view: true, can_add: true, can_remove: false, can_move: false, can_edit_details: false, can_grant: false, granted_by: OTHER, created_at: NOW, updated_at: NOW } },
  ]) });
  const body = res.json() as { ok: string[]; conflicts: unknown[] };
  assert.deepEqual(body.ok, ['e1']);
  const ins = pg.queries.find(q => q.sql.includes('INSERT INTO unit_access'));
  assert.ok(ins && ins.params.includes(CALLER), 'granted_by forced to caller');
  await app.close();
});

test('unit_access: a non-owner without org authority is a permanent rejection', async () => {
  const pg = fakePg({ callerRole: 'mitigation_technician', lockerOwner: OTHER });
  const app = await buildApp(pg);
  const res = await app.inject({ method: 'POST', url: '/sync/push', payload: pushBody([
    { operation: 'INSERT', table_name: 'unit_access', payload: { location_id: 'loc-1', user_id: CALLER, can_view: true, created_at: NOW, updated_at: NOW } },
    { operation: 'DELETE', table_name: 'unit_access', payload: { location_id: 'loc-1', user_id: OTHER } },
  ]) });
  const body = res.json() as { ok: string[]; conflicts: Array<{ error: string }> };
  assert.deepEqual(body.ok, []);
  assert.equal(body.conflicts.length, 2);
  for (const c of body.conflicts) assert.match(c.error, PERMANENT);
  await app.close();
});

test('unit_access: org authority may manage access to any unit', async () => {
  const pg = fakePg({ callerRole: 'full_admin', lockerOwner: OTHER });
  const app = await buildApp(pg);
  const res = await app.inject({ method: 'POST', url: '/sync/push', payload: pushBody([
    { operation: 'INSERT', table_name: 'unit_access', payload: { location_id: 'loc-1', user_id: CALLER, can_view: true, can_grant: true, created_at: NOW, updated_at: NOW } },
  ]) });
  assert.deepEqual((res.json() as { ok: string[] }).ok, ['e1']);
  await app.close();
});
```
- [ ] Run both files: `node --import tsx --test src/lib/syncPolicy.test.ts src/routes/sync-guards.test.ts` — all pass (the two pre-existing locker tests asserting the old denial wording may need their regexes relaxed to `PERMANENT` only if they matched "locker owner" verbatim — check and update those assertions, not the guard).
- [ ] Commit: `git add apps/api/src/lib/syncPolicy.ts apps/api/src/lib/syncPolicy.test.ts apps/api/src/routes/sync.ts apps/api/src/routes/sync-guards.test.ts && git commit -m "feat(#122-A1): sync unit_access (owner-guarded) + pull two-tank columns"`

### Task 8: Mobile sync plumbing — pull/full-download unit_access + two-tank carry-through in vehicles.ts

**Files**
- Modify: `apps/mobile/src/sync/pull.ts`, `apps/mobile/src/sync/fullDownload.ts`, `apps/mobile/src/db/queries/vehicles.ts`
- Test: `apps/mobile/src/sync/pullColumns.test.ts` (existing — arity check picks the changes up automatically; run it)

**Interfaces**
- Consumes: server rows now carrying `water_tank`/`waste_tank` and `unit_access` pages.
- Produces: `VehicleRow` gains `water_tank: 'full' | 'empty'` and `waste_tank: 'dirty' | 'clean'`; `VehicleStatePatch` gains optional `water_tank`/`waste_tank`. CRITICAL: every local `INSERT OR REPLACE INTO vehicles` must now name the tank columns or it silently resets them to defaults on each state write/pull.

**Steps**
- [ ] `apps/mobile/src/sync/pull.ts`:
  - Replace the `vehicles` upsert with: `` vehicles: `INSERT OR REPLACE INTO vehicles (location_id, truck_mount, water_state, model, model_id, notes, updated_at, water_tank, waste_tank) VALUES (?,?,?,?,?,?,?,?,?)`, ``
  - Replace the `vehicles` rowToValues case with: `case 'vehicles': return [row.location_id, row.truck_mount ? 1 : 0, row.water_state ?? null, row.model ?? null, row.model_id ?? null, row.notes ?? null, row.updated_at, row.water_tank ?? 'empty', row.waste_tank ?? 'clean'];`
  - Add after the `locker_access` upsert line: `` unit_access: `INSERT OR REPLACE INTO unit_access (location_id, user_id, can_view, can_add, can_remove, can_move, can_edit_details, can_grant, granted_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`, ``
  - Add after the `locker_access` case: `case 'unit_access': return [row.location_id, row.user_id, row.can_view ? 1 : 0, row.can_add ? 1 : 0, row.can_remove ? 1 : 0, row.can_move ? 1 : 0, row.can_edit_details ? 1 : 0, row.can_grant ? 1 : 0, row.granted_by ?? null, row.created_at, row.updated_at];`
- [ ] `apps/mobile/src/sync/fullDownload.ts`: in `SYNC_TABLES` change the last field-crew line to `'locker_access', 'unit_access', 'on_call_shifts',` (comment: unit_access is org-visible like locker_access — the access panel needs teammates' grants on a fresh device).
- [ ] `apps/mobile/src/db/queries/vehicles.ts` carry-through:
  - Add to `VehicleRow`: `water_tank: 'full' | 'empty';` and `waste_tank: 'dirty' | 'clean';` (after `water_state`).
  - Add to `VehicleStatePatch`: `water_tank?: 'full' | 'empty';` and `waste_tank?: 'dirty' | 'clean';`.
  - In `upsertVehicleState`, extend `merged` with `water_tank: patch.water_tank ?? existing?.water_tank ?? 'empty', waste_tank: patch.waste_tank ?? existing?.waste_tank ?? 'clean',` and change the SQL to `INSERT OR REPLACE INTO vehicles (location_id, truck_mount, water_state, model, model_id, notes, updated_at, synced_at, water_tank, waste_tank) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)` with `bindParams([..., merged.water_tank, merged.waste_tank])` (the outbox `row` spread now carries the tanks automatically — the server upserts them).
  - In `ensureVehicleRow`, change the SQL to `INSERT OR IGNORE INTO vehicles (location_id, truck_mount, water_state, model, model_id, notes, updated_at, synced_at, water_tank, waste_tank) VALUES (?, 0, NULL, ?, ?, NULL, ?, NULL, 'empty', 'clean')` and add `water_tank: 'empty', waste_tank: 'clean'` to its `appendOutbox` payload.
- [ ] Run `node --import tsx --import ./src/test/setupGlobals.mjs --test src/sync/pullColumns.test.ts` — the arity test passes (it would FAIL if any of the three edits desynced; this is the checklist's parity net).
- [ ] Typecheck: `cd /home/tdpotato/projects/InventoryPro/apps/mobile && npx tsc --noEmit`.
- [ ] Commit: `git add apps/mobile/src/sync/pull.ts apps/mobile/src/sync/fullDownload.ts apps/mobile/src/db/queries/vehicles.ts && git commit -m "feat(#122-A1): mobile sync unit_access + two-tank column carry-through"`

### Task 9: Mobile query module `unitAccess.ts` (pinned exports)

**Files**
- Create: `apps/mobile/src/db/queries/unitAccess.ts`
- Test (create): `apps/mobile/src/db/queries/unitAccess.test.ts` (Module._load redirect onto `locationsShelf.testdb.ts` — the locationsShelf.test.ts pattern)

**Interfaces (PINNED — other phases import these exact names)**
```ts
export interface UnitAccessRow { location_id: string; user_id: string; can_view: number; can_add: number; can_remove: number; can_move: number; can_edit_details: number; can_grant: number; granted_by: string | null; created_at: string; updated_at: string; synced_at: string | null; user_name?: string | null; }
export interface UnitPerms { view: boolean; add: boolean; remove: boolean; move: boolean; editDetails: boolean; grant: boolean; }
export function getUnitAccessRows(locationId: string): UnitAccessRow[];
export function getUserUnitPerms(userId: string, locationId: string): UnitPerms;
export type AccessFlag = boolean | 0 | 1; // widened so consumers may pass raw 0/1 grant rows (A2 T5, B T4, B T7)
export function upsertUnitAccess(row: { location_id: string; user_id: string; can_view: AccessFlag; can_add: AccessFlag; can_remove: AccessFlag; can_move: AccessFlag; can_edit_details: AccessFlag; can_grant: AccessFlag; granted_by: string | null; created_at?: string; updated_at?: string }): void; // timestamps optional — defaulted to now internally when absent
export function revokeUnitAccess(locationId: string, userId: string): void;
```

**Steps**
- [ ] Write the failing test `apps/mobile/src/db/queries/unitAccess.test.ts`: copy the `Module._load` redirect block from `locationsShelf.test.ts` VERBATIM (redirects `src/db/schema.ts` → `locationsShelf.testdb`, `src/telemetry/index.ts` → `{ track() {} }`, stubs `react-native-get-random-values` / `react-native` / `expo` / `expo-modules-core`). In `before()`, after `await testDb.initTestDb()`, create the extra tables the module touches:
```ts
testDb.getDb().executeSync(`
  CREATE TABLE unit_access (
    location_id TEXT NOT NULL, user_id TEXT NOT NULL,
    can_view INTEGER NOT NULL DEFAULT 1, can_add INTEGER NOT NULL DEFAULT 0,
    can_remove INTEGER NOT NULL DEFAULT 0, can_move INTEGER NOT NULL DEFAULT 0,
    can_edit_details INTEGER NOT NULL DEFAULT 0, can_grant INTEGER NOT NULL DEFAULT 0,
    granted_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, synced_at TEXT,
    PRIMARY KEY (location_id, user_id)
  );
  CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE activity_log (
    id TEXT PRIMARY KEY, user_id TEXT, team_id TEXT, action TEXT NOT NULL,
    entity_type TEXT NOT NULL, entity_id TEXT, from_location_id TEXT, to_location_id TEXT,
    quantity REAL, unit TEXT, job_id TEXT, note TEXT, metadata TEXT, device_id TEXT,
    created_at TEXT NOT NULL, synced_at TEXT, latitude REAL, longitude REAL, location_accuracy REAL
  );
`);
testDb.getDb().executeSync(`INSERT INTO users (id, name) VALUES ('user-a', 'Frank'), ('owner-1', 'Matt')`);
ua = requireCjs('./unitAccess') as typeof import('./unitAccess');
```
  Then the tests:
```ts
test('upsertUnitAccess writes the row, an outbox INSERT, and an activity log entry', () => {
  ua.upsertUnitAccess({ location_id: 'loc-1', user_id: 'user-a', can_view: true, can_add: true, can_remove: false, can_move: false, can_edit_details: false, can_grant: false, granted_by: 'owner-1' });
  const row = testDb.getDb().executeSync(`SELECT * FROM unit_access WHERE location_id='loc-1' AND user_id='user-a'`).rows[0] as Record<string, unknown>;
  assert.equal(row.can_add, 1);
  assert.equal(row.can_remove, 0);
  const ob = testDb.getDb().executeSync(`SELECT * FROM outbox WHERE table_name='unit_access' AND operation='INSERT'`).rows;
  assert.equal(ob.length, 1);
  const payload = JSON.parse(String((ob[0] as { payload: string }).payload)) as Record<string, unknown>;
  assert.equal(payload.can_view, 1); // 0/1, matches server BOOLEAN coercion via toBindable
  assert.ok(!('synced_at' in payload), 'local-only column never pushed');
});

test('getUserUnitPerms maps a row to booleans and defaults to all-false with no row', () => {
  assert.deepEqual(ua.getUserUnitPerms('user-a', 'loc-1'), { view: true, add: true, remove: false, move: false, editDetails: false, grant: false });
  assert.deepEqual(ua.getUserUnitPerms('nobody', 'loc-1'), { view: false, add: false, remove: false, move: false, editDetails: false, grant: false });
});

test('getUnitAccessRows joins user names, name order', () => {
  const rows = ua.getUnitAccessRows('loc-1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.user_name, 'Frank');
});

test('revokeUnitAccess deletes the row and queues a composite-key outbox DELETE', () => {
  ua.revokeUnitAccess('loc-1', 'user-a');
  assert.equal(testDb.getDb().executeSync(`SELECT COUNT(*) AS n FROM unit_access`).rows[0]!.n, 0);
  const del = testDb.getDb().executeSync(`SELECT payload FROM outbox WHERE table_name='unit_access' AND operation='DELETE'`).rows;
  assert.equal(del.length, 1);
  assert.deepEqual(JSON.parse(String((del[0] as { payload: string }).payload)), { location_id: 'loc-1', user_id: 'user-a' });
});
```
- [ ] Run it — FAIL (module missing).
- [ ] Create `apps/mobile/src/db/queries/unitAccess.ts` (mirrors `access.ts` grant/revoke shape; reuses the existing `locker_access_granted`/`locker_access_revoked` activity actions so the server allowlist needs no change):
```ts
import { getDb, rowsAs, bindParams } from '../schema';
import { appendOutbox } from '../../sync/outbox';
import { appendLog } from './log';
import { runInTransaction } from '../tx';

// Per-action unit access (#122 Phase A1) — successor to access.ts's binary
// locker_access grants. Server enforcement: owner-or-org-authority per-row
// guard in routes/sync.ts (shared with locker_access) + granted_by attribution.

export interface UnitAccessRow {
  location_id: string; user_id: string;
  can_view: number; can_add: number; can_remove: number; can_move: number;
  can_edit_details: number; can_grant: number;
  granted_by: string | null; created_at: string; updated_at: string;
  synced_at: string | null; // local-only
  user_name?: string | null; // present on getUnitAccessRows reads
}

export interface UnitPerms {
  view: boolean; add: boolean; remove: boolean; move: boolean;
  editDetails: boolean; grant: boolean;
}

/** Every grant on a unit, with user names, name order (access-panel listing). */
export function getUnitAccessRows(locationId: string): UnitAccessRow[] {
  const db = getDb();
  return rowsAs<UnitAccessRow>(db.executeSync(
    `SELECT ua.*, u.name AS user_name
       FROM unit_access ua LEFT JOIN users u ON u.id = ua.user_id
      WHERE ua.location_id = ?
      ORDER BY u.name NULLS LAST, ua.user_id`,
    [locationId],
  ).rows);
}

/** One user's per-action perms on one unit. No row → all false (fail closed). */
export function getUserUnitPerms(userId: string, locationId: string): UnitPerms {
  const db = getDb();
  const r = rowsAs<UnitAccessRow>(db.executeSync(
    `SELECT * FROM unit_access WHERE location_id = ? AND user_id = ?`,
    [locationId, userId],
  ).rows)[0];
  return {
    view: !!r?.can_view, add: !!r?.can_add, remove: !!r?.can_remove,
    move: !!r?.can_move, editDetails: !!r?.can_edit_details, grant: !!r?.can_grant,
  };
}

/** Grant flags accept booleans or raw 0/1 (later phases spread stored rows in). */
export type AccessFlag = boolean | 0 | 1;

export interface UnitAccessUpsert {
  location_id: string; user_id: string;
  can_view: AccessFlag; can_add: AccessFlag; can_remove: AccessFlag; can_move: AccessFlag;
  can_edit_details: AccessFlag; can_grant: AccessFlag;
  granted_by: string | null;
  /** Optional — defaulted to now when absent; grant EDITS may carry the original created_at. */
  created_at?: string; updated_at?: string;
}

/**
 * Create or edit a grant. Local upsert (composite PK) + outbox INSERT (the
 * server upserts on location_id,user_id and re-forces granted_by to the caller)
 * + activity log, atomic. Flags accept boolean or 0/1 and are stored 0/1;
 * created_at/updated_at default to now when the caller doesn't supply them.
 */
export function upsertUnitAccess(row: UnitAccessUpsert): void {
  const now = new Date().toISOString();
  const created = row.created_at ?? now;
  const updated = row.updated_at ?? now;
  const b = (v: AccessFlag) => (v ? 1 : 0);
  runInTransaction(() => {
    const db = getDb();
    db.executeSync(
      `INSERT OR REPLACE INTO unit_access
         (location_id, user_id, can_view, can_add, can_remove, can_move, can_edit_details, can_grant, granted_by, created_at, updated_at, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      bindParams([row.location_id, row.user_id, b(row.can_view), b(row.can_add), b(row.can_remove), b(row.can_move), b(row.can_edit_details), b(row.can_grant), row.granted_by, created, updated]),
    );
    appendOutbox('INSERT', 'unit_access', {
      location_id: row.location_id, user_id: row.user_id,
      can_view: b(row.can_view), can_add: b(row.can_add), can_remove: b(row.can_remove),
      can_move: b(row.can_move), can_edit_details: b(row.can_edit_details), can_grant: b(row.can_grant),
      granted_by: row.granted_by, created_at: created, updated_at: updated,
    });
    appendLog({
      action: 'locker_access_granted', entity_type: 'location', entity_id: row.location_id,
      user_id: row.granted_by, team_id: null, job_id: null,
      note: null, from_location_id: null, to_location_id: null, quantity: null, unit: null,
      metadata: JSON.stringify({ grantee_user_id: row.user_id, actions: { view: !!row.can_view, add: !!row.can_add, remove: !!row.can_remove, move: !!row.can_move, edit_details: !!row.can_edit_details, grant: !!row.can_grant } }),
      device_id: null,
    });
  });
}

/** Delete a grant. Composite-key outbox DELETE + activity log, atomic. */
export function revokeUnitAccess(locationId: string, userId: string): void {
  runInTransaction(() => {
    const db = getDb();
    db.executeSync(`DELETE FROM unit_access WHERE location_id = ? AND user_id = ?`, bindParams([locationId, userId]));
    appendOutbox('DELETE', 'unit_access', { location_id: locationId, user_id: userId });
    appendLog({
      action: 'locker_access_revoked', entity_type: 'location', entity_id: locationId,
      user_id: null, team_id: null, job_id: null,
      note: null, from_location_id: null, to_location_id: null, quantity: null, unit: null,
      metadata: JSON.stringify({ grantee_user_id: userId }), device_id: null,
    });
  });
}
```
- [ ] Run the test file — pass (if `appendLog`'s GPS path throws under the stubs, check how `locationsShelf.test.ts` handles `./log` and apply the same redirect for `src/db/queries/log.ts` → `{ appendLog() {} }`, then drop the activity_log assertions to outbox-only).
- [ ] Commit: `git add apps/mobile/src/db/queries/unitAccess.ts apps/mobile/src/db/queries/unitAccess.test.ts && git commit -m "feat(#122-A1): unitAccess query module (pinned exports)"`

### Task 10: Server push guards — Vehicle normalized-name merge (#129) + no sub-areas under units

**Files**
- Modify: `apps/api/src/routes/sync.ts`
- Test (modify): `apps/api/src/routes/sync-guards.test.ts`

**Interfaces**
- Produces: `/sync/push` response gains `merged: Array<{ id: string; duplicate_id: string; survivor_id: string }>` (`id` = outbox entry id; old clients ignore the field). A Vehicle-typed `locations` INSERT whose `LOWER(TRIM(name))` matches an existing active Vehicle is NOT inserted; its entry id lands in `ok` (outbox clears) and later entries in the batch have refs remapped dup→survivor. A `locations` INSERT/UPDATE whose `parent_id` resolves to a Vehicle/Locker-typed row is rejected permanently.

**Steps**
- [ ] Failing tests first, in `apps/api/src/routes/sync-guards.test.ts`. Add to `FakePgOpts`: `/** Vehicle name-uniqueness lookup: existing active Vehicle with same normalized name. */ vehicleDupSurvivor?: string;` and `/** parent-type lookup for the no-sub-areas guard. */ parentType?: string;`. Add to `fakePg`'s dispatcher (BEFORE the `SELECT owner_user_id FROM locations` branch):
```ts
// #129 vehicle name-uniqueness lookup.
if (sql.includes('LOWER(TRIM(name))')) {
  return { rows: opts.vehicleDupSurvivor ? [{ id: opts.vehicleDupSurvivor }] : [] };
}
// no-sub-areas guard parent lookup.
if (sql.includes('SELECT type FROM locations')) {
  return { rows: opts.parentType ? [{ type: opts.parentType }] : [] };
}
```
  Then the tests:
```ts
test('#129: a duplicate Vehicle INSERT is merged — ok\'d, reported in merged[], never inserted', async () => {
  const pg = fakePg({ vehicleDupSurvivor: 'veh-survivor' });
  const app = await buildApp(pg);
  const res = await app.inject({ method: 'POST', url: '/sync/push', payload: pushBody([
    { operation: 'INSERT', table_name: 'locations', payload: { id: 'veh-dup', name: ' van 7 ', type: 'Vehicle', active: true, updated_at: NOW } },
    { operation: 'INSERT', table_name: 'vehicles', payload: { location_id: 'veh-dup', truck_mount: false, updated_at: NOW } },
  ]) });
  const body = res.json() as { ok: string[]; conflicts: unknown[]; merged: Array<{ id: string; duplicate_id: string; survivor_id: string }> };
  assert.deepEqual(body.ok, ['e1', 'e2']);
  assert.deepEqual(body.merged, [{ id: 'e1', duplicate_id: 'veh-dup', survivor_id: 'veh-survivor' }]);
  assert.ok(!pg.queries.some(q => q.sql.includes('INSERT INTO locations')), 'dup row never inserted');
  // In-batch remap: the follow-up vehicles row landed on the survivor.
  const veh = pg.queries.find(q => q.sql.includes('INSERT INTO vehicles'));
  assert.ok(veh && veh.params.includes('veh-survivor') && !veh.params.includes('veh-dup'));
  await app.close();
});

test('#129: a Vehicle INSERT with a fresh name applies normally and merged[] is empty', async () => {
  const pg = fakePg();
  const app = await buildApp(pg);
  const res = await app.inject({ method: 'POST', url: '/sync/push', payload: pushBody([
    { operation: 'INSERT', table_name: 'locations', payload: { id: 'veh-new', name: 'Van 9', type: 'Vehicle', active: true, updated_at: NOW } },
  ]) });
  const body = res.json() as { ok: string[]; merged: unknown[] };
  assert.deepEqual(body.ok, ['e1']);
  assert.deepEqual(body.merged, []);
  assert.ok(pg.queries.some(q => q.sql.includes('INSERT INTO locations')));
  await app.close();
});

test('no sub-areas: parenting a location under a Vehicle/Locker is a permanent rejection', async () => {
  const pg = fakePg({ parentType: 'Vehicle' });
  const app = await buildApp(pg);
  const res = await app.inject({ method: 'POST', url: '/sync/push', payload: pushBody([
    { operation: 'INSERT', table_name: 'locations', payload: { id: 'room-x', name: 'Back Shelf', parent_id: 'veh-1', type: 'Room', active: true, updated_at: NOW } },
    { operation: 'UPDATE', table_name: 'locations', payload: { id: 'room-y', parent_id: 'veh-1' } },
  ]) });
  const body = res.json() as { ok: string[]; conflicts: Array<{ error: string }> };
  assert.deepEqual(body.ok, []);
  assert.equal(body.conflicts.length, 2);
  for (const c of body.conflicts) { assert.match(c.error, PERMANENT); assert.match(c.error, /sub-area/); }
  await app.close();
});

test('no sub-areas: a normal parent (Building) still accepts children', async () => {
  const pg = fakePg({ parentType: 'Building' });
  const app = await buildApp(pg);
  const res = await app.inject({ method: 'POST', url: '/sync/push', payload: pushBody([
    { operation: 'INSERT', table_name: 'locations', payload: { id: 'room-z', name: 'Product Room', parent_id: 'bldg-1', type: 'Room', active: true, updated_at: NOW } },
  ]) });
  assert.deepEqual((res.json() as { ok: string[] }).ok, ['e1']);
  await app.close();
});
```
  Run `node --import tsx --test src/routes/sync-guards.test.ts` — new tests FAIL.
- [ ] Implement in `apps/api/src/routes/sync.ts`, inside the push handler. Where `ok`/`conflicts` are declared, add:
```ts
// #129: merge map + response for duplicate Vehicle-typed location INSERTs.
const merged: Array<{ id: string; duplicate_id: string; survivor_id: string }> = [];
const vehicleAlias = new Map<string, string>(); // duplicate location id -> survivor id
```
  At the TOP of the per-entry guard section (before the subteams/locker_access guards), add:
```ts
// Remap in-batch references from an already-merged duplicate vehicle to its
// survivor, so the batch's follow-up rows (vehicles ext, stock, checkouts,
// activity) land on the row the server actually kept.
if (vehicleAlias.size > 0) {
  const refCols = ['location_id', 'vehicle_location_id', 'site_location_id', 'current_location_id', 'home_location_id', 'from_location_id', 'to_location_id', 'parent_id'];
  const cols = entry.table_name === 'locations' ? [...refCols, 'id'] : refCols;
  for (const col of cols) {
    const v = entry.payload[col];
    if (typeof v === 'string' && vehicleAlias.has(v)) entry.payload[col] = vehicleAlias.get(v);
  }
}

// No sub-areas under vehicles/lockers (#122 A1): migration 059 flattened the
// existing ones; block re-creation. Parent type comes from the DB, never the
// payload. Wording matches the mobile permanent-rejection regex.
if (entry.table_name === 'locations'
    && (entry.operation === 'INSERT' || entry.operation === 'UPDATE')
    && entry.payload.parent_id != null) {
  let parentType: string | null = null;
  try {
    const { rows: pRows } = await fastify.pg.query(
      `SELECT type FROM locations WHERE id = $1`, [entry.payload.parent_id],
    );
    parentType = pRows[0] ? String((pRows[0] as { type: string | null }).type ?? '') : null;
  } catch { parentType = null; }
  if (parentType === 'Vehicle' || parentType === 'Locker') {
    conflicts.push({ id: entry.id, error: 'Forbidden: vehicles and lockers cannot contain sub-areas' });
    continue;
  }
}

// #129: server-side normalized-name uniqueness for Vehicle-typed locations.
// A duplicate INSERT is MERGED into the existing row: the entry is ok'd (the
// client outbox clears), nothing is inserted, and the dup id aliases to the
// survivor for the rest of the batch + the merged[] response (the client
// re-points its local rows — see mobile engine).
if (entry.table_name === 'locations' && entry.operation === 'INSERT'
    && String(entry.payload.type ?? '') === 'Vehicle') {
  let survivorId: string | null = null;
  try {
    const { rows: dupRows } = await fastify.pg.query(
      `SELECT id FROM locations
        WHERE type = 'Vehicle' AND active = TRUE
          AND LOWER(TRIM(name)) = LOWER(TRIM($1)) AND id <> $2
        LIMIT 1`,
      [String(entry.payload.name ?? ''), entry.payload.id],
    );
    survivorId = dupRows[0] ? String((dupRows[0] as { id: string }).id) : null;
  } catch { survivorId = null; }
  if (survivorId) {
    vehicleAlias.set(String(entry.payload.id), survivorId);
    ok.push(entry.id);
    merged.push({ id: entry.id, duplicate_id: String(entry.payload.id), survivor_id: survivorId });
    continue;
  }
}
```
  Change the handler's return to `return { ok, conflicts, merged };`.
- [ ] Run `node --import tsx --test src/routes/sync-guards.test.ts` — all pass (including the pre-existing tests, which now also receive `merged: []`).
- [ ] Commit: `git add apps/api/src/routes/sync.ts apps/api/src/routes/sync-guards.test.ts && git commit -m "feat(#129): push-time vehicle name uniqueness (merge-into-existing) + no sub-areas under units"`

### Task 11: Mobile merge handling — `applyVehicleMerge` + engine wiring

**Files**
- Create: `apps/mobile/src/db/queries/vehicleMerge.ts`
- Modify: `apps/mobile/src/sync/engine.ts` (pushEntries result type + merged loop)
- Test (create): `apps/mobile/src/db/queries/vehicleMerge.test.ts`

**Interfaces**
- Produces: `export function applyVehicleMerge(duplicateId: string, survivorId: string): void` — re-points local `stock_by_location` (summed), `vehicles`, `vehicle_checkouts`, `vehicle_service_records`, `unit_access` to the survivor, deletes the local dup `locations` row (the server never accepted it), and rewrites un-synced outbox payloads (UUID string replace — ids are globally unique so a text REPLACE cannot false-match).
- Consumes (engine): push response `merged?: Array<{ id: string; duplicate_id: string; survivor_id: string }>`; `bumpTablesVersion` from `./dataVersion`.

**Steps**
- [ ] Write the failing test `apps/mobile/src/db/queries/vehicleMerge.test.ts` using the Module._load redirect from `locationsShelf.test.ts` (redirect `src/db/schema.ts` → `locationsShelf.testdb`; vehicleMerge imports only `../schema` and `../tx`, so no expo stubs beyond the standard block). In `before()`: `initTestDb()`, then create `stock_by_location`, `vehicles`, `vehicle_checkouts`, `vehicle_service_records`, `unit_access` with the same DDL as Task 6's test, seed: locations `veh-s` (survivor, server-known) + `veh-d` (local dup), stock `('item-1','veh-s',2)` and `('item-1','veh-d',3)`, one checkout + one service record + one unit_access grant on `veh-d`, and one pending outbox row `INSERT INTO outbox (id, operation, table_name, payload, created_at) VALUES ('ob-1','ADJUST','stock_by_location','{"item_id":"item-1","location_id":"veh-d","delta":3}','...')`. Tests:
```ts
test('applyVehicleMerge: stock summed onto survivor, refs re-pointed, dup location gone', () => {
  vm.applyVehicleMerge('veh-d', 'veh-s');
  assert.equal(db().executeSync(`SELECT quantity FROM stock_by_location WHERE item_id='item-1' AND location_id='veh-s'`).rows[0]!.quantity, 5);
  assert.equal(db().executeSync(`SELECT COUNT(*) AS n FROM stock_by_location WHERE location_id='veh-d'`).rows[0]!.n, 0);
  assert.equal(db().executeSync(`SELECT COUNT(*) AS n FROM locations WHERE id='veh-d'`).rows[0]!.n, 0);
  assert.equal(db().executeSync(`SELECT vehicle_location_id FROM vehicle_checkouts`).rows[0]!.vehicle_location_id, 'veh-s');
  assert.equal(db().executeSync(`SELECT location_id FROM unit_access`).rows[0]!.location_id, 'veh-s');
});

test('applyVehicleMerge: pending outbox payloads are rewritten to the survivor id', () => {
  const p = String(db().executeSync(`SELECT payload FROM outbox WHERE id='ob-1'`).rows[0]!.payload);
  assert.ok(p.includes('veh-s') && !p.includes('veh-d'));
});
```
  Run — FAIL (module missing).
- [ ] Create `apps/mobile/src/db/queries/vehicleMerge.ts`:
```ts
import { getDb } from '../schema';
import { runInTransaction } from '../tx';

// #129 client half of the server's merge-into-existing response: the server
// refused to create our duplicate Vehicle location and told us the survivor.
// Re-point everything local at the survivor and erase the dup (a hard DELETE,
// not a retire — the server never had this row, so nothing references it
// anywhere else). Outbox rewrite is a plain string REPLACE: both ids are
// UUIDs, globally unique, so a substring false-match is impossible.
export function applyVehicleMerge(duplicateId: string, survivorId: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  runInTransaction(() => {
    db.executeSync(
      `INSERT INTO stock_by_location (item_id, location_id, quantity, updated_at)
       SELECT item_id, ?, quantity, ? FROM stock_by_location WHERE location_id = ? AND quantity <> 0
       ON CONFLICT (item_id, location_id) DO UPDATE
          SET quantity = quantity + excluded.quantity, updated_at = excluded.updated_at`,
      [survivorId, now, duplicateId],
    );
    db.executeSync(`DELETE FROM stock_by_location WHERE location_id = ?`, [duplicateId]);
    db.executeSync(`UPDATE vehicle_checkouts SET vehicle_location_id = ? WHERE vehicle_location_id = ?`, [survivorId, duplicateId]);
    db.executeSync(`UPDATE vehicle_service_records SET vehicle_location_id = ? WHERE vehicle_location_id = ?`, [survivorId, duplicateId]);
    db.executeSync(
      `INSERT OR IGNORE INTO unit_access (location_id, user_id, can_view, can_add, can_remove, can_move, can_edit_details, can_grant, granted_by, created_at, updated_at, synced_at)
       SELECT ?, user_id, can_view, can_add, can_remove, can_move, can_edit_details, can_grant, granted_by, created_at, ?, NULL
         FROM unit_access WHERE location_id = ?`,
      [survivorId, now, duplicateId],
    );
    db.executeSync(`DELETE FROM unit_access WHERE location_id = ?`, [duplicateId]);
    db.executeSync(`DELETE FROM vehicles WHERE location_id = ?`, [duplicateId]);
    db.executeSync(`DELETE FROM locations WHERE id = ?`, [duplicateId]);
    db.executeSync(
      `UPDATE outbox SET payload = REPLACE(payload, ?, ?) WHERE synced_at IS NULL AND payload LIKE '%' || ? || '%'`,
      [duplicateId, survivorId, duplicateId],
    );
  });
}
```
- [ ] Wire the engine, `apps/mobile/src/sync/engine.ts` `pushEntries`: extend the result cast to
```ts
const result = await res.json() as {
  ok: string[];
  conflicts: Array<{ id: string; error?: string }>;
  merged?: Array<{ id: string; duplicate_id: string; survivor_id: string }>;
};
```
  and after `markOutboxSynced(result.ok);` add:
```ts
// #129: the server merged a duplicate vehicle we created offline — adopt its
// survivor locally before the conflict loop (the merged entry ids are already
// in ok, so the outbox rows are cleared; this re-points everything else).
if (result.merged?.length) {
  const { applyVehicleMerge } = await import('../db/queries/vehicleMerge');
  for (const m of result.merged) applyVehicleMerge(m.duplicate_id, m.survivor_id);
  bumpTablesVersion(['locations', 'stock_by_location', 'vehicles', 'vehicle_checkouts', 'vehicle_service_records', 'unit_access']);
}
```
  (add `import { bumpTablesVersion } from './dataVersion';` if engine.ts doesn't already import it; keep the dynamic `vehicleMerge` import — engine must stay loadable before the DB opens).
- [ ] Run the test file + `npx tsc --noEmit` in apps/mobile — pass.
- [ ] Commit: `git add apps/mobile/src/db/queries/vehicleMerge.ts apps/mobile/src/db/queries/vehicleMerge.test.ts apps/mobile/src/sync/engine.ts && git commit -m "feat(#129): client-side vehicle merge adoption (applyVehicleMerge + engine wiring)"`

### Task 12: Phase A1 verification gate

**Files**
- Test: full suites only; no source changes expected.

**Interfaces**
- Consumes: everything above. Produces: green suites — the merge/hotload gate for the A1 board item.

**Steps**
- [ ] `cd /home/tdpotato/projects/InventoryPro/apps/api && pnpm test` — expect all pass (252+ baseline plus the new migrationSql/syncPolicy/sync-guards tests).
- [ ] `cd /home/tdpotato/projects/InventoryPro/apps/mobile && pnpm test` — expect all pass (174+ baseline plus 045/046/047/unitAccess/vehicleMerge tests; `pullColumns` re-validates upsert arity).
- [ ] `cd /home/tdpotato/projects/InventoryPro/apps/api && npx tsc --noEmit && cd ../mobile && npx tsc --noEmit`.
- [ ] If anything was fixed during verification, commit it: `git add -A && git commit -m "test(#122-A1): phase A1 verification fixes"`.
- [ ] Per project instructions (CLAUDE.md): build the dev expo APK and hotload for on-device verification of the phase (dev-client + Metro, `--clear`, and re-run `adb reverse tcp:8081 tcp:8081` after any unplug). Device walkthrough: open a vehicle → confirm no crash with the new columns; confirm the construction van shows its merged stock; create "van 7" twice from two devices (one offline) → after sync exactly one Vehicle remains. Deploy note for later: shipping the API image auto-applies 057–059 on boot — deploy API and mobile in lockstep for this phase.


# Phase A2 — Vehicles/Lockers UX split (board #132)

## Phase A2 — UX split: unit widgets, redesigned screens, central exclusion, manage visibility (#130)

Depends on Phase A1 being merged first: mobile migrations 045–047 (in BOTH `schema.ts` and `schema.web.ts`), the `unit_access` table, and `apps/mobile/src/db/queries/unitAccess.ts` (`getUnitAccessRows(locationId)`, `getUserUnitPerms(userId, locationId) -> {view,add,remove,move,editDetails,grant}`, `upsertUnitAccess(row)`, `revokeUnitAccess(locationId, userId)`). No migrations are created in this phase. All paths below are relative to `/home/tdpotato/projects/InventoryPro`. All test commands run from `apps/mobile/` as `node --import tsx --import ./src/test/setupGlobals.mjs --test <file>`; typecheck is `npx tsc --noEmit`.

### Task 1: Two-tank model end-to-end on mobile (queries + logic + VehiclePanel + inline status)

**Files**
- Create: `apps/mobile/src/db/queries/vehiclesTanks.test.ts`
- Modify: `apps/mobile/src/db/queries/vehicles.ts`
- Modify: `apps/mobile/src/components/vehicles/vehicleSessionLogic.ts`
- Modify: `apps/mobile/src/components/vehicles/vehicleSessionLogic.test.ts`
- Modify: `apps/mobile/src/components/vehicles/VehiclePanel.tsx`
- Modify: `apps/mobile/src/components/vehicles/VehicleInlineStatus.tsx`
- Modify: `apps/mobile/src/sync/pull.ts` (only if Phase A1 did not already add the tank columns to the `vehicles` pull upsert)

**Interfaces**
- Consumes: `vehicles.water_tank TEXT NOT NULL DEFAULT 'empty'` / `waste_tank TEXT NOT NULL DEFAULT 'clean'` (Phase A1 migration 045). `water_state` stays in the table but is no longer read or written.
- Produces:
  - `export type WaterTank = 'full' | 'empty'` and `export type WasteTank = 'dirty' | 'clean'` (vehicles.ts)
  - `VehicleRow` gains `water_tank: WaterTank; waste_tank: WasteTank` (keeps `water_state: string | null` typed as deprecated, never written)
  - `VehicleStatePatch` gains `water_tank?: WaterTank; waste_tank?: WasteTank` and DROPS `water_state`
  - `VehicleInlineStatusRow = { water_tank: WaterTank | null; waste_tank: WasteTank | null; truck_mount: number | null; holder_name: string | null }`
  - `export function waterTankLabel(tank: string | null | undefined): string` and `export function wasteTankLabel(tank: string | null | undefined): string` (vehicleSessionLogic.ts); `waterStateLabel` is deleted along with its callers

**Steps**

- [ ] Add pure-label tests to `apps/mobile/src/components/vehicles/vehicleSessionLogic.test.ts`:
  ```ts
  test('waterTankLabel maps full/empty and blanks unknowns', () => {
    assert.equal(waterTankLabel('full'), 'Water: full');
    assert.equal(waterTankLabel('empty'), 'Water: empty');
    assert.equal(waterTankLabel(null), '');
    assert.equal(waterTankLabel('empty_clean'), ''); // legacy value never reaches labels
  });
  test('wasteTankLabel maps clean/dirty and blanks unknowns', () => {
    assert.equal(wasteTankLabel('clean'), 'Waste: clean');
    assert.equal(wasteTankLabel('dirty'), 'Waste: dirty');
    assert.equal(wasteTankLabel(undefined), '');
  });
  ```
- [ ] Create `apps/mobile/src/db/queries/vehiclesTanks.test.ts` following the `locationsShelf.test.ts` pattern exactly: copy its `Module._load` intercept verbatim (redirect `/src/db/schema.ts` → `./locationsShelf.testdb`, stub `react-native-get-random-values`, proxy `react-native`/`expo`/`expo-modules-core`, stub `/src/telemetry/index.ts`), then in `before()` run `await testDb.initTestDb()` and create the extra tables the vehicles helpers touch:
  ```ts
  testDb.getDb().executeSync(`
    CREATE TABLE vehicles (
      location_id TEXT PRIMARY KEY, truck_mount INTEGER NOT NULL DEFAULT 0,
      water_state TEXT, model TEXT, model_id TEXT, notes TEXT,
      water_tank TEXT NOT NULL DEFAULT 'empty', waste_tank TEXT NOT NULL DEFAULT 'clean',
      updated_at TEXT NOT NULL, synced_at TEXT
    );
    CREATE TABLE vehicle_checkouts (
      id TEXT PRIMARY KEY, vehicle_location_id TEXT NOT NULL, user_id TEXT NOT NULL,
      job_id TEXT, checked_out_at TEXT NOT NULL, checked_in_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, synced_at TEXT
    );
    CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE jobs (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE activity_log (
      id TEXT PRIMARY KEY, user_id TEXT, team_id TEXT, action TEXT NOT NULL,
      entity_type TEXT NOT NULL, entity_id TEXT, from_location_id TEXT, to_location_id TEXT,
      quantity REAL, unit TEXT, job_id TEXT, note TEXT, metadata TEXT, device_id TEXT,
      created_at TEXT NOT NULL, synced_at TEXT, latitude REAL, longitude REAL, location_accuracy REAL
    );
  `);
  veh = requireCjs('./vehicles') as typeof import('./vehicles');
  ```
  Tests (all against `veh`):
  ```ts
  test('ensureVehicleRow seeds two-tank defaults', () => {
    veh.ensureVehicleRow('van-1');
    const row = veh.getVehicle('van-1')!;
    assert.equal(row.water_tank, 'empty');
    assert.equal(row.waste_tank, 'clean');
  });
  test('upsertVehicleState patches one tank without clobbering the other', () => {
    veh.upsertVehicleState('van-1', { water_tank: 'full' }, 'u-matt');
    assert.equal(veh.getVehicle('van-1')!.waste_tank, 'clean');
    veh.upsertVehicleState('van-1', { waste_tank: 'dirty' }, 'u-matt');
    const row = veh.getVehicle('van-1')!;
    assert.equal(row.water_tank, 'full');
    assert.equal(row.waste_tank, 'dirty');
  });
  test('outbox payload carries both tanks and NO water_state key', () => {
    const rows = testDb.getDb().executeSync(
      `SELECT payload FROM outbox WHERE table_name = 'vehicles' ORDER BY created_at DESC LIMIT 1`).rows;
    const payload = JSON.parse((rows[0] as { payload: string }).payload);
    assert.equal(payload.water_tank, 'full');
    assert.equal(payload.waste_tank, 'dirty');
    assert.ok(!('water_state' in payload), 'legacy column must no longer be pushed');
  });
  test('getVehicleInlineStatus reads the two tanks', () => {
    const st = veh.getVehicleInlineStatus('van-1');
    assert.equal(st.water_tank, 'full');
    assert.equal(st.waste_tank, 'dirty');
  });
  ```
  Run: `node --import tsx --import ./src/test/setupGlobals.mjs --test src/db/queries/vehiclesTanks.test.ts` — expect FAIL (no `water_tank` on VehicleRow yet).
- [ ] Update `apps/mobile/src/db/queries/vehicles.ts` — BUILD ON A1 Task 8's version, which already added the tank columns to `VehicleRow`/`VehicleStatePatch`, the `upsertVehicleState` merge lines, both `INSERT` column lists, and `ensureVehicleRow`'s outbox payload (verify with `grep -n "water_tank" src/db/queries/vehicles.ts`; KEEP A1's column order in the SQL — do not rewrite those statements). The genuinely new A2 edits are:
  - ADD `export type WaterTank = 'full' | 'empty'` and `export type WasteTank = 'dirty' | 'clean'`, retyping the existing `water_tank`/`waste_tank` fields with them; delete `export type WaterState` (its two consumers are updated in this task).
  - Re-comment `water_state: string | null;` on `VehicleRow` as `// DEPRECATED (#122 A2): legacy single-tank column — kept in the table, never read/written`, and DELETE `water_state` from `VehicleStatePatch`; in the `upsertVehicleState` merge keep A1's tank lines and make the legacy line `water_state: existing?.water_state ?? null, // carried through, never patched`.
  - Change the outbox strip to `const { synced_at: _s, water_state: _w, ...row } = merged;` (the legacy column must no longer be pushed).
  - Rewrite `getVehicleInlineStatus` subqueries to select `water_tank` and `waste_tank` (drop `water_state`), returning the new `VehicleInlineStatusRow`.
- [ ] Implement `waterTankLabel`/`wasteTankLabel` in `vehicleSessionLogic.ts` (exact bodies the tests assert) and delete `waterStateLabel`.
- [ ] Update `VehiclePanel.tsx`: replace `WATER_SEGMENTS` with
  ```ts
  const WATER_SEGMENTS = [ { id: 'full', label: 'Full' }, { id: 'empty', label: 'Empty' } ];
  const WASTE_SEGMENTS = [ { id: 'clean', label: 'Clean' }, { id: 'dirty', label: 'Dirty' } ];
  ```
  replace `setWater` with `setWaterTank(id: string)` → `upsertVehicleState(locationId, { water_tank: id as WaterTank }, user?.id ?? null)` and add `setWasteTank` for `waste_tank`. In the State card render two labelled selectors (locked → plain text via the new label fns):
  ```tsx
  <FieldLabel style={s.waterLabel}>Water tank</FieldLabel>
  {locked ? <Text style={s.muted}>{waterTankLabel(vehicle?.water_tank ?? 'empty')}</Text>
          : <SegmentedControl segments={WATER_SEGMENTS} value={vehicle?.water_tank ?? 'empty'} onChange={setWaterTank} size="sm" />}
  <FieldLabel style={s.waterLabel}>Waste tank</FieldLabel>
  {locked ? <Text style={s.muted}>{wasteTankLabel(vehicle?.waste_tank ?? 'clean')}</Text>
          : <SegmentedControl segments={WASTE_SEGMENTS} value={vehicle?.waste_tank ?? 'clean'} onChange={setWasteTank} size="sm" />}
  ```
  In `statusPills` replace the single water pill with two: `<StatusPill label={waterTankLabel(vehicle?.water_tank ?? 'empty')} tone={vehicle?.water_tank === 'full' ? 'primary' : 'neutral'} />` and `<StatusPill label={wasteTankLabel(vehicle?.waste_tank ?? 'clean')} tone={vehicle?.waste_tank === 'dirty' ? 'warning' : 'neutral'} />`.
- [ ] Update `VehicleInlineStatus.tsx` to the new row shape — show only noteworthy states (quiet defaults render nothing):
  ```tsx
  const hasHolder = !!status.holder_name;
  const waterFull = status.water_tank === 'full';
  const wasteDirty = status.waste_tank === 'dirty';
  if (!hasHolder && !waterFull && !wasteDirty) return null;
  ...
  {hasHolder && <StatusPill label={`Out · ${status.holder_name}`} tone="warning" />}
  {waterFull && <StatusPill label="💧 Water full" tone="primary" />}
  {wasteDirty && <StatusPill label="⚠️ Waste dirty" tone="warning" />}
  ```
- [ ] Check `apps/mobile/src/sync/pull.ts` lines 32/65: if Phase A1 did not already extend them, update to
  ```ts
  vehicles: `INSERT OR REPLACE INTO vehicles (location_id, truck_mount, water_state, water_tank, waste_tank, model, model_id, notes, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`,
  case 'vehicles': return [row.location_id, row.truck_mount ? 1 : 0, row.water_state ?? null, row.water_tank ?? 'empty', row.waste_tank ?? 'clean', row.model ?? null, row.model_id ?? null, row.notes ?? null, row.updated_at];
  ```
- [ ] Run both test files + `npx tsc --noEmit` — expect PASS/clean (tsc will also catch any missed `WaterState`/`waterStateLabel` consumer).
- [ ] Commit: `git add -A && git commit -m "feat(#122): A2 — two-tank vehicle state (water_tank/waste_tank) across queries, panel, inline status

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`

### Task 2: Central exclusion of Vehicle/Locker units from places surfaces

**Files**
- Modify: `apps/mobile/src/db/queries/locations.ts`
- Modify: `apps/mobile/src/db/queries/locationsShelf.test.ts`
- Modify: `apps/mobile/app/(app)/(locations)/index.tsx`

**Interfaces**
- Produces (locations.ts):
  - `export function isUnitLocation(l: Pick<Location, 'type'>): boolean` — true for `type === 'Vehicle' || type === 'Locker'`
  - `export function getUnitLocations(kind: 'Vehicle' | 'Locker'): Location[]` — active units of that type, name order (backs the new list screens + visibility queries)
  - `getBrowsableLocations()` / `getNonShelfLocations()` now ALSO exclude units — this single change covers the Locations tab tree, parent pickers, `LocationPicker`, `LocationShelfPicker` (add-stock destination, MoveStockModal destination, admin main-location setting), which all self-source from these two functions.
- Consumers unaffected on purpose: `getAllLocations()` still returns units (access queries, `add.tsx`'s `locationById` preselect map, search).

**Steps**

- [ ] Update `apps/mobile/src/db/queries/locationsShelf.test.ts` first: in `before()` add `seedLocation({ id: 'locker-1', name: "Frank's Locker", type: 'Locker' });`. Flip the existing line-66 assertion to `assert.ok(!ids.includes('van-1'), 'units are not first-class picker options (#122 A2)');` and add:
  ```ts
  test('units excluded from browse/tree and picker lists (#122 A2)', () => {
    const browsable = loc.getBrowsableLocations().map(l => l.id);
    assert.ok(!browsable.includes('van-1'));
    assert.ok(!browsable.includes('locker-1'));
    assert.ok(browsable.includes('shop-1'), 'real places still browsable');
    assert.ok(!loc.getNonShelfLocations().map(l => l.id).includes('locker-1'));
  });
  test('getUnitLocations partitions by kind', () => {
    assert.deepEqual(loc.getUnitLocations('Vehicle').map(l => l.id), ['van-1']);
    assert.deepEqual(loc.getUnitLocations('Locker').map(l => l.id), ['locker-1']);
  });
  test('no sub-areas under units: creation helpers refuse a Vehicle/Locker parent (#122 A2)', () => {
    assert.equal(loc.findOrCreateShelf('van-1', 'V1'), null);
    assert.equal(loc.findOrCreateShelf('locker-1', 'L1'), null);
  });
  ```
  Run the file — expect FAIL (`getUnitLocations` missing, exclusion not applied).
- [ ] Implement in `locations.ts` (place after `getAllLocations`):
  ```ts
  // Vehicles & lockers are UNITS (#122 A2 — their own system, not places). This is
  // THE central exclusion: every browse/tree/picker surface flows through
  // getBrowsableLocations/getNonShelfLocations, so filtering here removes units
  // from the Locations tab, parent pickers, and main-location pickers everywhere.
  export function isUnitLocation(l: Pick<Location, 'type'>): boolean {
    return l.type === 'Vehicle' || l.type === 'Locker';
  }
  export function getUnitLocations(kind: 'Vehicle' | 'Locker'): Location[] {
    return getAllLocations().filter(l => l.type === kind);
  }
  ```
  Change `getBrowsableLocations` to `.filter(l => !(l.type === 'Shelf' && l.parent_id != null) && !isUnitLocation(l))` and `getNonShelfLocations` to `.filter(l => l.type !== 'Shelf' && !isUnitLocation(l))`.
- [ ] Mobile query-layer guard (mirrors A1 Task 10's server rejection — the server rule alone leaves a hole: a legacy deep link, preset parent param, or future code path could still write a child under a unit locally, producing a permanent push rejection and a stuck-looking local row): in `locations.ts`, at the top of `findOrCreateShelf` AND of the create-location write path the create form uses, look up the parent row's `type` and bail out when it is a unit — e.g. `const parent = parentId ? getLocationById(parentId) : null; if (parent && isUnitLocation(parent)) return null;` (`findOrCreateShelf`'s contract already allows `null` on failure; the create path should refuse the same way). The new test above pins this.
- [ ] In `apps/mobile/app/(app)/(locations)/index.tsx`: filter units out of the section chips and create-form type options — line 79 becomes `getLocationTypes().filter(t => !['Shelf', 'Vehicle', 'Locker'].includes(t.label))` and the top-level branch of `locationTypeOptions` becomes `getLocationTypesWithFallback().filter(t => !['Shelf', 'Vehicle', 'Locker'].includes(t.label))`. Remove the now-dead unit-row info plumbing (units never appear in this list anymore): the `infoTarget`/`infoOpen` state, `openInfo`, the `VehicleSheet`/`LockerSheet`/`VehicleInlineStatus` imports and their render sites. Keep the `if (payload.type === 'Vehicle') ensureVehicleRow(id)` guard in the create handler (harmless, defends synced/legacy paths).
- [ ] Run `node --import tsx --import ./src/test/setupGlobals.mjs --test src/db/queries/locationsShelf.test.ts` and `npx tsc --noEmit` — PASS/clean.
- [ ] Commit: `git add -A && git commit -m "feat(#122): A2 — central Vehicle/Locker exclusion from Locations tab, browse tree, and location pickers

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`

### Task 3: Unit visibility (#130) — manage-context "see all" kernel + day-to-day reads move to unit_access

**Files**
- Modify: `apps/mobile/src/access/accessResolution.ts`
- Modify: `apps/mobile/src/access/accessResolution.test.ts`
- Modify: `apps/mobile/src/db/queries/access.ts`

**Interfaces**
- Consumes: `unit_access` table (Phase A1), `ROLE_TIER` from `src/constants/roles`, `team_members.is_manager`, `getUnitLocations`/`isUnitLocation` (Task 2).
- Produces:
  - `export function canSeeAllUnitsInManage(ctx: { roleTier: number; isTeamManager: boolean; ownsAnyUnit: boolean; isProductionManager: boolean }): boolean` (pure, accessResolution.ts) — `tier >= 3 || isProductionManager || isTeamManager || ownsAnyUnit` (the pinned #130 rule: tier-3+/Production Managers/owners/team managers see all units in manage contexts; `production_manager` is tier 2, so the spec's PM callout needs the explicit fact — mirrors B Task 1's privileged set)
  - `export interface VisibleUnits { units: Location[]; showsAll: boolean }` and `export function getVisibleUnits(user: UserSession, kind: 'Vehicle' | 'Locker'): VisibleUnits` (access.ts)
  - `export function isTeamManagerAnywhere(userId: string): boolean` and `export function sharesTeamWithOwner(userId: string, ownerUserId: string | null): boolean` (access.ts; the latter is consumed by Task 4)
  - `getAccessibleSourceLocations` (day-to-day: fast-checkout picker, Manage My Team) now sources grants from `unit_access WHERE can_view = 1` instead of the deprecated `locker_access`.

**Steps**

- [ ] Add pure tests to `accessResolution.test.ts`:
  ```ts
  test('#130: ownerless locker stays invisible day-to-day without a grant', () => {
    const result = getAccessibleLocationIds(input([{ id: 'L1', ownerUserId: null }]), 'matt');
    assert.equal(result.size, 0);
  });
  test('#130: manage context — tier-3+, PMs, team managers, and unit owners see all', () => {
    assert.ok(canSeeAllUnitsInManage({ roleTier: 4, isTeamManager: false, ownsAnyUnit: false, isProductionManager: false }));
    assert.ok(canSeeAllUnitsInManage({ roleTier: 1, isTeamManager: true, ownsAnyUnit: false, isProductionManager: false }));
    assert.ok(canSeeAllUnitsInManage({ roleTier: 2, isTeamManager: false, ownsAnyUnit: true, isProductionManager: false }));
    // production_manager is tier 2, so the spec's PM callout needs its own fact:
    // a PM who manages no team and owns no unit must STILL see all units here.
    assert.ok(canSeeAllUnitsInManage({ roleTier: 2, isTeamManager: false, ownsAnyUnit: false, isProductionManager: true }));
    assert.ok(!canSeeAllUnitsInManage({ roleTier: 2, isTeamManager: false, ownsAnyUnit: false, isProductionManager: false }));
  });
  ```
  Run — FAIL (`canSeeAllUnitsInManage` missing).
- [ ] Implement `canSeeAllUnitsInManage` in `accessResolution.ts` (pure, no imports — stays `node --test`-safe):
  ```ts
  /**
   * #130 (Frank's Locker invisible to Matt): manage contexts list ALL units for
   * tier-3+ org authority, Production Managers (tier 2 — the spec names them, so
   * an explicit fact, mirroring B Task 1's privileged set), team managers
   * (team_members.is_manager), and unit owners. Day-to-day surfaces
   * (fast-checkout picker) keep using getAccessibleLocationIds — explicit
   * visibility via unit_access.can_view.
   */
  export function canSeeAllUnitsInManage(ctx: { roleTier: number; isTeamManager: boolean; ownsAnyUnit: boolean; isProductionManager: boolean }): boolean {
    return ctx.roleTier >= 3 || ctx.isProductionManager || ctx.isTeamManager || ctx.ownsAnyUnit;
  }
  ```
- [ ] In `access.ts`: swap the grants source inside `getAccessibleSourceLocations` (locker_access stays on disk, deprecated — stop reading it):
  ```ts
  const grants: AccessGrantRow[] = rowsAs<{ location_id: string; user_id: string }>(
    db.executeSync(`SELECT location_id, user_id FROM unit_access WHERE can_view = 1`).rows,
  ).map(g => ({ locationId: g.location_id, userId: g.user_id }));
  ```
  and add:
  ```ts
  export function isTeamManagerAnywhere(userId: string): boolean {
    const db = getDb();
    return (rowsAs<{ n: number }>(db.executeSync(
      `SELECT COUNT(*) AS n FROM team_members WHERE user_id = ? AND is_manager = 1`, [userId],
    ).rows)[0]?.n ?? 0) > 0;
  }

  export function sharesTeamWithOwner(userId: string, ownerUserId: string | null): boolean {
    if (!ownerUserId) return false;
    if (ownerUserId === userId) return true;
    const db = getDb();
    return (rowsAs<{ n: number }>(db.executeSync(
      `SELECT COUNT(*) AS n FROM team_members a JOIN team_members b ON b.team_id = a.team_id
        WHERE a.user_id = ? AND b.user_id = ?`, [userId, ownerUserId],
    ).rows)[0]?.n ?? 0) > 0;
  }

  export interface VisibleUnits { units: Location[]; showsAll: boolean; }

  /** Unit list for the Vehicles/Lockers screens (#130): full census for managers, accessible-only otherwise. */
  export function getVisibleUnits(user: UserSession, kind: 'Vehicle' | 'Locker'): VisibleUnits {
    const ctx = {
      roleTier: ROLE_TIER[user.role] ?? 0,
      isTeamManager: isTeamManagerAnywhere(user.id),
      ownsAnyUnit: getAllLocations().some(l => isUnitLocation(l) && l.owner_user_id === user.id),
      isProductionManager: user.role === 'production_manager',
    };
    if (canSeeAllUnitsInManage(ctx)) return { units: getUnitLocations(kind), showsAll: true };
    const acc = getAccessibleSourceLocations(user.id);
    return { units: kind === 'Vehicle' ? acc.vehicles : acc.lockers, showsAll: false };
  }
  ```
  (imports to add: `canSeeAllUnitsInManage` from `../../access/accessResolution`, `getUnitLocations, isUnitLocation` from `./locations`.)
- [ ] Run `src/access/accessResolution.test.ts` + `npx tsc --noEmit` — PASS/clean.
- [ ] Commit: `git add -A && git commit -m "feat(#122,#130): A2 — manage-context see-all unit visibility; day-to-day grants read unit_access.can_view

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`

### Task 4: Per-action perms kernel + UnitContentsPanel (gated add/remove/move contents)

**Files**
- Modify: `apps/mobile/src/access/accessResolution.ts`
- Modify: `apps/mobile/src/access/accessResolution.test.ts`
- Create: `apps/mobile/src/components/units/UnitContentsPanel.tsx`

**Interfaces**
- Consumes: `getUserUnitPerms(userId, locationId) -> {view,add,remove,move,editDetails,grant}` from `apps/mobile/src/db/queries/unitAccess.ts` (READ that file first — Phase A1 wrote it; all-false object when no row). `sharesTeamWithOwner` (Task 3), `getStockAtLocation`, `MoveStockModal` (default export, props `{visible, fromLocationId, fromLocationName, onClose, onDone}`), add-stock route param `locationId` (already supported by `add.tsx` via `getAllLocations`-based `locationById`), hub scoping param `loc`.
- Produces:
  - `export interface UnitActionPerms { view: boolean; add: boolean; remove: boolean; move: boolean; editDetails: boolean; grant: boolean }` (accessResolution.ts)
  - `export function resolveUnitActionPerms(input: { isOwner: boolean; roleTier: number; isTeammateOfOwner: boolean; rowPerms: UnitActionPerms }): UnitActionPerms` (pure)
  - `export function UnitContentsPanel({ locationId, onNavigate }: { locationId: string; onNavigate?: (href: string) => void }): JSX.Element | null`
- Action mapping (documented in the component header): **view** → the contents list itself; **add** → "+ Add Stock Here" → `/(app)/(inventory)/add?locationId=`; **remove** → "Check out from here" → `/(app)/(hub)?loc=` (checkout is how stock leaves a unit); **move** → "Move Stock" → `MoveStockModal`.

**Steps**

- [ ] Tests first in `accessResolution.test.ts`:
  ```ts
  const NONE = { view: false, add: false, remove: false, move: false, editDetails: false, grant: false };
  test('unit perms: owner and tier-3+ get everything', () => {
    for (const p of [
      resolveUnitActionPerms({ isOwner: true, roleTier: 1, isTeammateOfOwner: false, rowPerms: NONE }),
      resolveUnitActionPerms({ isOwner: false, roleTier: 3, isTeammateOfOwner: false, rowPerms: NONE }),
    ]) assert.deepEqual(p, { view: true, add: true, remove: true, move: true, editDetails: true, grant: true });
  });
  test('unit perms: teammate-of-owner keeps implicit work access, never edit/grant', () => {
    assert.deepEqual(
      resolveUnitActionPerms({ isOwner: false, roleTier: 1, isTeammateOfOwner: true, rowPerms: NONE }),
      { view: true, add: true, remove: true, move: true, editDetails: false, grant: false });
  });
  test('unit perms: explicit grant unions with teammate fallback; stranger gets row perms only', () => {
    const row = { ...NONE, view: true, editDetails: true };
    assert.deepEqual(
      resolveUnitActionPerms({ isOwner: false, roleTier: 1, isTeammateOfOwner: false, rowPerms: row }),
      { view: true, add: false, remove: false, move: false, editDetails: true, grant: false });
  });
  ```
  Run — FAIL.
- [ ] Implement in `accessResolution.ts`:
  ```ts
  export interface UnitActionPerms {
    view: boolean; add: boolean; remove: boolean; move: boolean; editDetails: boolean; grant: boolean;
  }

  /**
   * Effective per-action perms on a unit: owner/tier-3+ → everything; otherwise the
   * explicit unit_access row (getUserUnitPerms; all-false when no row) UNIONed with
   * the implicit teammate-of-owner work access (view/add/remove/move — preserves the
   * pre-#122 team rule so grants only ever ADD access). editDetails/grant are never
   * implicit.
   */
  export function resolveUnitActionPerms(input: {
    isOwner: boolean; roleTier: number; isTeammateOfOwner: boolean; rowPerms: UnitActionPerms;
  }): UnitActionPerms {
    if (input.isOwner || input.roleTier >= 3) {
      return { view: true, add: true, remove: true, move: true, editDetails: true, grant: true };
    }
    const t = input.isTeammateOfOwner;
    return {
      view: input.rowPerms.view || t,
      add: input.rowPerms.add || t,
      remove: input.rowPerms.remove || t,
      move: input.rowPerms.move || t,
      editDetails: input.rowPerms.editDetails,
      grant: input.rowPerms.grant,
    };
  }
  ```
- [ ] Create `apps/mobile/src/components/units/UnitContentsPanel.tsx` — themed Card section (follow LockerPanel's style constants) that self-loads and gates every action:
  ```tsx
  import { useMemo, useState } from 'react';
  import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
  import { useRouter } from 'expo-router';
  import { getLocationById, getStockAtLocation } from '../../db/queries/locations';
  import { getUserUnitPerms } from '../../db/queries/unitAccess';
  import { sharesTeamWithOwner } from '../../db/queries/access';
  import { resolveUnitActionPerms } from '../../access/accessResolution';
  import { ROLE_TIER } from '../../constants/roles';
  import { useSession } from '../../hooks/useSession';
  import { useFocusOrDataRefresh } from '../../hooks/useFocusOrDataRefresh';
  import MoveStockModal from '../MoveStockModal';
  import { PrimaryButton } from '../ui/PrimaryButton';
  import type { Theme } from '../../themes/types';
  import { useThemedStyles } from '../../hooks/useThemedStyles';

  const PREVIEW_ROWS = 8;

  interface Props { locationId: string; onNavigate?: (href: string) => void; }

  export function UnitContentsPanel({ locationId, onNavigate }: Props) {
    const s = useThemedStyles(makeStyles);
    const router = useRouter();
    const { user } = useSession();
    const refreshKey = useFocusOrDataRefresh();
    const [localBump, setLocalBump] = useState(0);
    const key = refreshKey + localBump;

    const location = useMemo(() => getLocationById(locationId), [locationId, key]);
    const stock = useMemo(() => getStockAtLocation(locationId), [locationId, key]);
    const perms = useMemo(() => {
      if (!user || !location) return null;
      return resolveUnitActionPerms({
        isOwner: location.owner_user_id != null && location.owner_user_id === user.id,
        roleTier: ROLE_TIER[user.role] ?? 0,
        isTeammateOfOwner: sharesTeamWithOwner(user.id, location.owner_user_id ?? null),
        rowPerms: getUserUnitPerms(user.id, locationId),
      });
    }, [user?.id, location?.owner_user_id, locationId, key]);

    const [showMove, setShowMove] = useState(false);
    if (!location || !perms || !perms.view) return null;

    function go(pathname: string, params: Record<string, string>) {
      if (onNavigate) { onNavigate(`${pathname}?${new URLSearchParams(params)}`); return; }
      router.push({ pathname, params } as never);
    }
    const totalQty = stock.reduce((sum, r) => sum + r.quantity, 0);
    const preview = stock.slice(0, PREVIEW_ROWS);

    return (
      <View style={s.section}>
        <Text style={s.sectionLabel}>
          Contents · {stock.length} item{stock.length === 1 ? '' : 's'}{stock.length > 0 ? ` · ${totalQty} total` : ''}
        </Text>
        {stock.length === 0 ? <Text style={s.muted}>Nothing stored here right now.</Text> : (
          <>
            {preview.map(row => (
              <View key={row.item_id} style={s.stockRow}>
                <Text style={s.stockName} numberOfLines={1}>{row.name}</Text>
                <Text style={s.stockQty}>{row.quantity}</Text>
              </View>
            ))}
            {stock.length > preview.length && <Text style={s.muted}>+{stock.length - preview.length} more</Text>}
          </>
        )}
        {perms.remove && (
          <PrimaryButton label="Check out from here" style={s.btn}
            onPress={() => go('/(app)/(hub)', { loc: locationId })} />
        )}
        <View style={s.actionRow}>
          {perms.add && (
            <TouchableOpacity onPress={() => go('/(app)/(inventory)/add', { locationId })}>
              <Text style={s.link}>+ Add Stock Here</Text>
            </TouchableOpacity>
          )}
          {perms.move && stock.length > 0 && (
            <TouchableOpacity onPress={() => setShowMove(true)}>
              <Text style={s.link}>Move Stock</Text>
            </TouchableOpacity>
          )}
        </View>
        <MoveStockModal
          visible={showMove}
          fromLocationId={locationId}
          fromLocationName={location.name}
          onClose={() => setShowMove(false)}
          onDone={() => { setShowMove(false); setLocalBump(b => b + 1); }}
        />
      </View>
    );
  }

  const makeStyles = (t: Theme) => StyleSheet.create({
    section: { marginTop: t.spacing.base },
    sectionLabel: { fontSize: 12, fontWeight: '700', color: t.colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 },
    muted: { fontSize: 13, color: t.colors.textMuted },
    stockRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },
    stockName: { fontSize: 14, color: t.colors.textPrimary, flex: 1, marginRight: 12 },
    stockQty: { fontSize: 14, color: t.colors.textSecondary, fontWeight: '600' },
    btn: { marginTop: t.spacing.base },
    actionRow: { flexDirection: 'row', gap: 16, marginTop: t.spacing.sm },
    link: { color: t.colors.primary, fontSize: 13, fontWeight: '700' },
  });
  ```
- [ ] Run `src/access/accessResolution.test.ts` + `npx tsc --noEmit` — PASS/clean.
- [ ] Commit: `git add -A && git commit -m "feat(#122): A2 — per-action unit perms kernel + UnitContentsPanel gated by getUserUnitPerms

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`

### Task 5: Embed the contents panel; LockerPanel writes unit_access

**Files**
- Modify: `apps/mobile/src/components/lockers/LockerPanel.tsx`
- Modify: `apps/mobile/src/components/vehicles/VehiclePanel.tsx`

**Interfaces**
- Consumes: `UnitContentsPanel` (Task 4); `getUnitAccessRows`, `upsertUnitAccess`, `revokeUnitAccess` from `apps/mobile/src/db/queries/unitAccess.ts` (READ the file first for the exact row type — contract columns: `location_id, user_id, can_view, can_add, can_remove, can_move, can_edit_details, can_grant, granted_by, created_at, updated_at`).
- Produces: LockerPanel no longer reads/writes `locker_access` (module `queries/access.ts`'s `getLockerAccessList`/`grantLockerAccess`/`revokeLockerAccess` lose their last UI caller — leave them in place, Phase B deletes); grants created here default to view+add+remove+move (matches A1's locker_access copy semantics; the `unit_access_defaults` app_config template is Phase B).

**Steps**

- [ ] `LockerPanel.tsx`: replace the contents-preview block, the `getStockAtLocation` read, and the "Check out from here" button/`handleCheckoutFromHere` with `{variant === 'full' && <UnitContentsPanel locationId={locationId} onNavigate={onNavigate} />}` (summary variant: host screen already shows stock). Swap the access list read to `const accessList = useMemo(() => getUnitAccessRows(locationId), [locationId, key]);` and resolve display names with `getUserById(g.user_id)?.name` / `getUserById(g.granted_by)?.name` when the A1 row shape doesn't join names. Replace the write handlers:
  ```ts
  function handleGrant(opt: PickerOption) {
    if (isWriteBlocked()) throw new Error('write blocked');
    const now = new Date().toISOString();
    upsertUnitAccess({
      location_id: locationId, user_id: opt.id,
      can_view: 1, can_add: 1, can_remove: 1, can_move: 1, can_edit_details: 0, can_grant: 0,
      granted_by: user?.id ?? null, created_at: now, updated_at: now,
    });
    setLocalBump(b => b + 1);
  }
  function handleRevoke(entry: AccessEntry) {
    if (isWriteBlocked()) throw new Error('write blocked');
    revokeUnitAccess(locationId, entry.userId);
    setLocalBump(b => b + 1);
  }
  ```
  Keep `canManageLockerAccess` as the manage gate but widen it with the explicit grant bit: `const canManage = canManageLockerAccess(user, location) || (user ? getUserUnitPerms(user.id, locationId).grant : false);`. Note in a comment: A1's migration copied `locker_access` → `unit_access` and the seeded-row watermark gotcha applies (backfilled rows written at deploy time reach enrolled devices via full download / A1's touched `updated_at` — nothing to do here, just don't "fix" missing rows by re-granting blindly).
- [ ] `VehiclePanel.tsx` (full variant only): add a Contents section between the Checkout card and `ServiceRecordList`:
  ```tsx
  <Text style={s.sectionLabel}>Contents</Text>
  <Card variant="detail">
    <UnitContentsPanel locationId={locationId} />
  </Card>
  ```
- [ ] `npx tsc --noEmit` — clean. Run the full mobile suite (`pnpm --filter mobile test`) — all green.
- [ ] Commit: `git add -A && git commit -m "feat(#122): A2 — contents panel embedded in vehicle/locker panels; locker grants write unit_access

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`

### Task 6: Redesigned Vehicles/Lockers list + locker detail routes

**Files**
- Create: `apps/mobile/app/(app)/(vehicles)/index.tsx`
- Create: `apps/mobile/app/(app)/(lockers)/index.tsx`
- Create: `apps/mobile/app/(app)/(lockers)/[id].tsx`
- Modify: `apps/mobile/src/components/lockers/LockerSheet.tsx`

**Interfaces**
- Consumes: `getVisibleUnits(user, kind)` (Task 3), `VehicleInlineStatus`, `VehicleSheet`, `LockerSheet`, `LockerPanel`, `EmptyState`, `useFocusOrDataRefresh`, `renderIcon`, `getUserById`. Expo-router auto-registers the new `(lockers)` group (precedent: `(vehicles)` has no `_layout`).
- Produces: routes `/(app)/(vehicles)` (list), `/(app)/(lockers)` (list), `/(app)/(lockers)/[id]` (thin `LockerPanel` full page mirroring `(vehicles)/[id].tsx`). `LockerSheet`'s "Open full page" now targets `/(app)/(lockers)/[id]` instead of `/(app)/(locations)/[id]`.

**Steps**

- [ ] Create `apps/mobile/app/(app)/(vehicles)/index.tsx` (patterns: `(crew)/index.tsx` for data/refresh, `(locations)/index.tsx` rows for the ⓘ sheet):
  ```tsx
  import { useMemo, useState } from 'react';
  import { View, Text, ScrollView, TouchableOpacity, StyleSheet } from 'react-native';
  import { Stack, useRouter } from 'expo-router';
  import { EmptyState } from '../../../src/components/ui/EmptyState';
  import { VehicleInlineStatus } from '../../../src/components/vehicles/VehicleInlineStatus';
  import { VehicleSheet } from '../../../src/components/vehicles/VehicleSheet';
  import { getVisibleUnits } from '../../../src/db/queries/access';
  import { getUserById } from '../../../src/db/queries/users';
  import { renderIcon } from '../../../src/constants/locationStyles';
  import { useSession } from '../../../src/hooks/useSession';
  import { useFocusOrDataRefresh } from '../../../src/hooks/useFocusOrDataRefresh';
  import type { Theme } from '../../../src/themes/types';
  import { useThemedStyles } from '../../../src/hooks/useThemedStyles';

  export default function VehiclesScreen() {
    const s = useThemedStyles(makeStyles);
    const router = useRouter();
    const { user } = useSession();
    const refreshKey = useFocusOrDataRefresh();
    const { units, showsAll } = useMemo(
      () => (user ? getVisibleUnits(user, 'Vehicle') : { units: [], showsAll: false }),
      [user?.id, refreshKey],
    );
    // ⓘ target persists after close so ModalSheet's exit animation has a valid id.
    const [infoId, setInfoId] = useState<string | null>(null);
    const [infoOpen, setInfoOpen] = useState(false);

    return (
      <>
        <Stack.Screen options={{ title: 'Vehicles', headerShown: true }} />
        <ScrollView style={s.screen} contentContainerStyle={s.content}>
          {units.length === 0 ? (
            <EmptyState icon="🚐" title="No vehicles yet"
              subtitle="Vehicles you own, share a team with, or were granted access to show up here." />
          ) : (
            <>
              {showsAll && <Text style={s.caption}>Manager view — showing every vehicle.</Text>}
              {units.map(loc => (
                <TouchableOpacity key={loc.id} style={s.row}
                  onPress={() => router.push({ pathname: '/(app)/(vehicles)/[id]', params: { id: loc.id } })}>
                  <View style={s.rowMain}>
                    <Text style={s.rowName}>{loc.icon ? `${renderIcon(loc.icon)} ` : ''}{loc.name}</Text>
                    <Text style={s.rowSub}>{loc.owner_user_id ? getUserById(loc.owner_user_id)?.name ?? 'Owner' : 'No owner'}</Text>
                    <VehicleInlineStatus locationId={loc.id} />
                  </View>
                  <TouchableOpacity hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    onPress={() => { setInfoId(loc.id); setInfoOpen(true); }}>
                    <Text style={s.info}>ⓘ</Text>
                  </TouchableOpacity>
                </TouchableOpacity>
              ))}
            </>
          )}
        </ScrollView>
        {infoId && <VehicleSheet locationId={infoId} visible={infoOpen} onClose={() => setInfoOpen(false)} />}
      </>
    );
  }

  const makeStyles = (t: Theme) => StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.colors.background },
    content: { padding: t.spacing.base, gap: t.spacing.sm, paddingBottom: 48 },
    caption: { fontSize: 12, color: t.colors.textMuted },
    row: {
      flexDirection: 'row', alignItems: 'center', backgroundColor: t.colors.surface,
      borderRadius: 12, borderWidth: 1, borderColor: t.colors.border, padding: t.spacing.base,
    },
    rowMain: { flex: 1 },
    rowName: { fontSize: 15, fontWeight: '600', color: t.colors.textPrimary },
    rowSub: { fontSize: 12, color: t.colors.textSecondary, marginTop: 2 },
    info: { fontSize: 18, color: t.colors.primary, paddingHorizontal: 6 },
  });
  ```
- [ ] Create `apps/mobile/app/(app)/(lockers)/index.tsx` — same screen with `getVisibleUnits(user, 'Locker')`, icon `🔒`, title `Lockers`, `LockerSheet` for ⓘ, no `VehicleInlineStatus`, row push to `{ pathname: '/(app)/(lockers)/[id]', params: { id: loc.id } }`, empty-state subtitle "Lockers you own, share a team with, or were granted access to show up here."
- [ ] Create `apps/mobile/app/(app)/(lockers)/[id].tsx` mirroring `(vehicles)/[id].tsx` exactly but rendering `<LockerPanel locationId={id} variant="full" />` with title fallback `'Locker'`.
- [ ] `LockerSheet.tsx`: change the full-page push to `router.push({ pathname: '/(app)/(lockers)/[id]', params: { id: locationId } });` and update the comment (a locker now HAS a dedicated route).
- [ ] `npx tsc --noEmit` — clean.
- [ ] Commit: `git add -A && git commit -m "feat(#122): A2 — Vehicles/Lockers list screens + locker detail route

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`

### Task 7: Dashboard widgets 'vehicles' and 'lockers'

**Files**
- Modify: `apps/mobile/src/dashboard/widgets.ts`
- Test: `apps/mobile/src/dashboard/store.test.ts`

**Interfaces**
- Produces: `WidgetType` union gains `'vehicles' | 'lockers'`; `WIDGET_REGISTRY.vehicles = { label: 'Vehicles', icon: '🚐', route: '/(app)/(vehicles)', kind: 'tile' }` and `WIDGET_REGISTRY.lockers = { label: 'Lockers', icon: '🔒', route: '/(app)/(lockers)', kind: 'tile' }` — NO `requiredPermission` (visibility is data-driven like `fast-checkout`/`manage-my-team`; the screens render an EmptyState). `DEFAULT_LAYOUT` gains a half/half pair right after the `locations` tile. `(dashboard)/index.tsx` needs no change — unrecognized-to-it tiles render via the generic `renderTile` path.

**Steps**

- [ ] Test first — append to `store.test.ts`:
  ```ts
  test('A2 unit widgets: vehicles/lockers tiles, data-driven (no permission gate)', () => {
    assert.equal(WIDGET_REGISTRY.vehicles.kind, 'tile');
    assert.equal(WIDGET_REGISTRY.vehicles.route, '/(app)/(vehicles)');
    assert.equal(WIDGET_REGISTRY.vehicles.requiredPermission, undefined);
    assert.equal(WIDGET_REGISTRY.lockers.kind, 'tile');
    assert.equal(WIDGET_REGISTRY.lockers.route, '/(app)/(lockers)');
    assert.equal(WIDGET_REGISTRY.lockers.requiredPermission, undefined);
    const widgets = DEFAULT_LAYOUT.map(b => b.widget);
    for (const w of ['vehicles', 'lockers'] as const) {
      assert.equal(widgets.filter(x => x === w).length, 1, `${w} appears exactly once`);
    }
    assert.ok(widgets.indexOf('vehicles') > widgets.indexOf('locations'), 'unit tiles follow Manage Locations');
  });
  ```
  Run `src/dashboard/store.test.ts` — FAIL.
- [ ] Implement: add `| 'vehicles' | 'lockers'` to the tile row of the `WidgetType` union; in `WIDGET_REGISTRY` under `locations` add:
  ```ts
  // Vehicles/lockers as their own system (#122 A2): no requiredPermission —
  // visibility is data-driven (getVisibleUnits); the screens render an EmptyState.
  vehicles:      { label: 'Vehicles',                icon: '🚐',  route: '/(app)/(vehicles)',      kind: 'tile' },
  lockers:       { label: 'Lockers',                 icon: '🔒',  route: '/(app)/(lockers)',       kind: 'tile' },
  ```
  and in `DEFAULT_LAYOUT` insert after `{ widget: 'locations', width: 'full' }`:
  ```ts
  { widget: 'vehicles', width: 'half' },
  { widget: 'lockers', width: 'half' },
  ```
- [ ] Run `src/dashboard/store.test.ts` + `npx tsc --noEmit` — PASS/clean.
- [ ] Commit: `git add -A && git commit -m "feat(#122): A2 — vehicles/lockers dashboard widgets in WIDGET_REGISTRY + default layout

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`

### Task 8: Phase A2 verification — full suite, hotload device walkthrough, board

**Files**
- No new source files (fixes only, if the walkthrough finds regressions).

**Interfaces**
- Consumes: `deploy-android` skill (§B hotload: debug dev-client + Metro, NO `CI=1`, `--clear`; if "failed to load bundle" run `adb reverse tcp:8081 tcp:8081` first), `board` skill (`gh_move`).

**Steps**

- [ ] `cd /home/tdpotato/projects/InventoryPro/apps/mobile && pnpm test && npx tsc --noEmit` — everything green before touching the device.
- [ ] Hotload per project instructions (CLAUDE.md: build the dev expo APK / hotload after each phase): invoke the `deploy-android` skill §B — the phone already has the dev client, so start Metro with `--clear` and re-run `adb reverse tcp:8081 tcp:8081`.
- [ ] Device walkthrough (never blind-tap — confirm each screen visually with the user):
  1. Dashboard shows the Vehicles/Lockers half-tile pair after Manage Locations.
  2. Vehicles list → detail: Water tank Full/Empty + Waste tank Clean/Dirty selectors write and re-render; inline pills show `💧 Water full` / `⚠️ Waste dirty` only when noteworthy.
  3. Lockers list as Matt (tier-4): Frank's ownerless locker IS listed with the "Manager view" caption (#130 fix); as a tier-1 test account it is NOT listed without a `can_view` grant.
  4. Locker detail contents panel: Add/Move/Check-out buttons appear/disappear per `unit_access` grants (toggle a grant from the access editor and re-check).
  5. Locations tab: no Vehicle/Locker rows, no Vehicle/Locker filter chips or create-type options; add-stock and Move Stock destination pickers offer no units, but "+ Add Stock Here" from a vehicle's contents panel still pre-selects the vehicle.
  6. Data fix (#130's closing requirement — step 3's tier-1 invisibility must not persist for Frank's actual crew): as an admin on-device, set Frank's Locker `owner_user_id` to Frank and create the intended `unit_access` grants via the new access editor (or a prod psql one-liner — if psql, set `updated_at = NOW()` on the touched rows so already-enrolled devices pull them, per the seed-sync watermark rule). Then re-check as a granted tier-1 account: the locker now IS listed day-to-day.
- [ ] Move the Phase A2 board item to In review: `python3 .claude/skills/board/scripts/gh_move.py <A2-item> "In review"` (exact usage per the board skill).
- [ ] Commit any walkthrough fixes: `git add -A && git commit -m "fix(#122): A2 — device-walkthrough fixes

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`

# Phase B — Per-action access defaults + Teams-tab sheet (board #133)

## Phase B — Access defaults + editing (unit_access defaults template, Teams-tab permissions sheet, dashboard preset filtering, server grant-edit enforcement)

Phase B assumes Phase A1 has landed: `unit_access` exists on both sides (API 058, mobile 046 in **both** `schema.ts` and `schema.web.ts`), and `apps/mobile/src/db/queries/unitAccess.ts` exports exactly `getUnitAccessRows(locationId)`, `getUserUnitPerms(userId, locationId)`, `upsertUnitAccess(row)`, `revokeUnitAccess(locationId, userId)`. **Phase B creates NO migrations.** The `unit_access_defaults` app_config row is runtime-written (settings UI → outbox push), so the migration-seeded-row watermark gotcha does not apply to this phase — nothing here is seeded at deploy time.

Reactivity rule for this phase (module-cache trap): `unit_access_defaults` is synced config that gates UI. Every read path goes through a version-counter + listener store (the `hiddenFields.ts` pattern) and the sync engine notifies subscribers after each pull — never a bare module cache.

### Task 1: API pure policy — `canManageUnitAccess`

Single source of truth for who may create/edit/revoke a `unit_access` grant: unit owner ∪ managers of a team the owner is on ∪ production managers ∪ tier-3+ org authority, with every non-owner editor also required to out-tier the grantee via `canActOnTarget` (fail closed on unknown roles / missing users).

**Files**
- Create: `apps/api/src/lib/unitAccessPolicy.ts`
- Test: `apps/api/src/lib/unitAccessPolicy.test.ts`

**Interfaces**
- Consumes: `canActOnTarget(callerRole, targetRole): boolean`, `effectiveTier(role): number | undefined` from `apps/api/src/lib/permissions.ts`.
- Produces: `interface UnitAccessEditFacts { callerId: string; callerRole: string | null | undefined; ownerUserId: string | null; callerManagesOwnersTeam: boolean; granteeRole: string | null }` and `function canManageUnitAccess(f: UnitAccessEditFacts): boolean`.

**Steps**

- [ ] Write the failing test `apps/api/src/lib/unitAccessPolicy.test.ts` (node:test pattern from `apps/api/src/lib/permissions.test.ts`):

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canManageUnitAccess } from './unitAccessPolicy';

const base = {
  callerId: 'caller-1',
  ownerUserId: 'owner-1',
  callerManagesOwnersTeam: false,
  granteeRole: 'mitigation_technician' as string | null,
};

test('the unit OWNER may always manage grants, regardless of role/tier', () => {
  assert.equal(canManageUnitAccess({ ...base, callerId: 'owner-1', callerRole: 'temporary_employee' }), true);
});

test('an ownerless unit does not owner-match a null-ish caller path', () => {
  assert.equal(canManageUnitAccess({ ...base, ownerUserId: null, callerRole: 'construction_crew' }), false);
});

test('a production_manager may grant to a tier-1 grantee', () => {
  assert.equal(canManageUnitAccess({ ...base, callerRole: 'production_manager' }), true);
});

test('a production_manager may NOT grant to a full_admin (canActOnTarget tier guard)', () => {
  assert.equal(canManageUnitAccess({ ...base, callerRole: 'production_manager', granteeRole: 'full_admin' }), false);
});

test('a manager of a team the owner is on may grant (tier-2 lead, tier-1 grantee)', () => {
  assert.equal(canManageUnitAccess({ ...base, callerRole: 'head_of_contents', callerManagesOwnersTeam: true }), true);
});

test('a non-manager tier-2 who does not manage the owner and is not a PM is denied', () => {
  assert.equal(canManageUnitAccess({ ...base, callerRole: 'carpet_cleaning_manager' }), false);
});

test('tier-3+ org authority may manage any unit (grantee at/below their tier)', () => {
  assert.equal(canManageUnitAccess({ ...base, callerRole: 'office_manager' }), true);
  assert.equal(canManageUnitAccess({ ...base, callerRole: 'full_admin', granteeRole: 'full_admin' }), true);
});

test('unknown grantee role (missing user) fails closed for every non-owner', () => {
  assert.equal(canManageUnitAccess({ ...base, callerRole: 'production_manager', granteeRole: null }), false);
  assert.equal(canManageUnitAccess({ ...base, callerRole: 'full_admin', granteeRole: null }), true); // apex out-tiers the fail-closed tier-4 default
});

test('unknown caller role is denied outright (non-owner)', () => {
  assert.equal(canManageUnitAccess({ ...base, callerRole: 'not_a_role' }), false);
  assert.equal(canManageUnitAccess({ ...base, callerRole: null }), false);
});
```

- [ ] Run it and watch it fail: `cd /home/tdpotato/projects/InventoryPro/apps/api && node --import tsx --test src/lib/unitAccessPolicy.test.ts`
- [ ] Create `apps/api/src/lib/unitAccessPolicy.ts`:

```ts
import { canActOnTarget, effectiveTier } from './permissions';

// Who may create/edit/revoke a unit_access grant (#122 Phase B) — the single
// policy the /sync/push per-row guard (routes/sync.ts) enforces and the mobile
// mirror (apps/mobile/src/access/unitAccessPolicy.ts) copies for courtesy
// gating. KEEP IN SYNC with mobile.
//
//   owner                                → always (it's their unit)
//   manager of a team the owner is on ──┐
//   production_manager                  ├─ only when they out-tier the GRANTEE
//   tier-3+ org authority             ──┘  (canActOnTarget — fails closed on
//                                           unknown roles / missing users)
export interface UnitAccessEditFacts {
  callerId: string;
  callerRole: string | null | undefined;
  /** locations.owner_user_id — DB truth, never the payload's. */
  ownerUserId: string | null;
  /** caller has is_manager on a team the owner belongs to. */
  callerManagesOwnersTeam: boolean;
  /** users.role of the grant's target user (null = unknown user → fail closed). */
  granteeRole: string | null;
}

export function canManageUnitAccess(f: UnitAccessEditFacts): boolean {
  if (f.ownerUserId != null && f.ownerUserId === f.callerId) return true;
  const privileged =
    (effectiveTier(f.callerRole) ?? 0) >= 3
    || f.callerRole === 'production_manager'
    || f.callerManagesOwnersTeam;
  if (!privileged) return false;
  return canActOnTarget(f.callerRole, f.granteeRole);
}
```

- [ ] Re-run the test file — all green. Then the whole API suite: `cd /home/tdpotato/projects/InventoryPro/apps/api && pnpm test`
- [ ] Commit: `git add apps/api/src/lib/unitAccessPolicy.ts apps/api/src/lib/unitAccessPolicy.test.ts && git commit -m "feat(#122-B): canManageUnitAccess policy — owner/team-manager/PM/org-authority grant editing"`

### Task 2: API — `/sync/push` per-row guard for `unit_access` + sync wiring

Mirror of the `locker_access` guard (`apps/api/src/routes/sync.ts:1248–1272`) but widened per Task 1's policy. NOTE: Phase A1 Task 7 already wired `unit_access` into the table lists / conflict targets / syncPolicy AND enforced it by WIDENING the locker_access guard condition to `locker_access || unit_access` (owner-only), with three unit_access tests plus a `unit_access` COLUMNS entry in sync-guards.test.ts. This task takes OWNERSHIP of the guard — executed literally without the reconciliation below, unit_access entries would hit A1's owner-only guard first (rejecting the PM/team-manager cases with `continue`), and A1's tests (which drive the `lockerOwner` opt) would break once the new fact query dispatches on `manages_owner_team`. So: (1) revert A1's widened condition so unit_access is handled ONLY by the new canManageUnitAccess block; (2) DELETE A1's three unit_access tests + its `unit_access` COLUMNS entry and replace them with this task's versions (one reuses the same test name — leave no duplicates); (3) for the remaining wiring, verify first and only add what is missing.

**Files**
- Modify: `apps/api/src/routes/sync.ts`, `apps/api/src/lib/syncPolicy.ts`
- Test: `apps/api/src/routes/sync-guards.test.ts`, `apps/api/src/lib/syncPolicy.test.ts`

**Interfaces**
- Consumes: `canManageUnitAccess` (Task 1); existing `fakePg`/`push`/`pushBody` harness in `sync-guards.test.ts`.
- Produces: permanent-rejection guard for `unit_access` writes; wording matches the mobile engine's permanent regex `/forbidden|cannot|not allowed/i`.

**Steps**

- [ ] Extend the `sync-guards.test.ts` harness: REPLACE A1 Task 7's `unit_access` entry in `COLUMNS` (same column list — just ensure exactly one entry remains; a duplicate object key is a silent overwrite and a lint error):

```ts
unit_access: ['location_id', 'user_id', 'can_view', 'can_add', 'can_remove', 'can_move', 'can_edit_details', 'can_grant', 'granted_by', 'created_at', 'updated_at'],
```

add to `FakePgOpts`:

```ts
/** unit_access guard facts (single fact query, aliased manages_owner_team). */
unitOwner?: string | null;
unitLocMissing?: boolean;
granteeRole?: string | null;
managesOwnerTeam?: boolean;
```

and add a dispatch branch in `fakePg` BEFORE the `SELECT owner_user_id FROM locations` branch (the unit query also selects owner_user_id, so match on the alias first):

```ts
// unit_access guard fact query (#122 Phase B).
if (sql.includes('manages_owner_team')) {
  return { rows: opts.unitLocMissing ? [] : [{
    owner_user_id: opts.unitOwner ?? null,
    grantee_role: opts.granteeRole ?? 'mitigation_technician',
    manages_owner_team: opts.managesOwnerTeam ?? false,
  }] };
}
```

- [ ] DELETE A1 Task 7's three `unit_access` tests from `sync-guards.test.ts` ('unit_access: the unit OWNER may grant…', 'unit_access: a non-owner without org authority…', 'unit_access: org authority may manage access to any unit' — they set `lockerOwner`, which the new fact-query dispatch no longer feeds, and the first shares its name with a test below), then add the failing route tests (same shape as the `#126: locker_access` block):

```ts
// ── #122 Phase B: unit_access owner/manager/PM guard ─────────────────────────

const GRANT_ROW = {
  location_id: 'loc-1', user_id: OTHER, can_view: true, can_add: true, can_remove: true,
  can_move: true, can_edit_details: false, can_grant: false, granted_by: 'forged-id',
  created_at: NOW, updated_at: NOW,
};

test('unit_access: the unit OWNER may grant, and granted_by is forced to the caller', async () => {
  const pg = fakePg({ callerRole: 'construction_crew', unitOwner: CALLER });
  const body = await push(pg, [{ operation: 'INSERT', table_name: 'unit_access', payload: { ...GRANT_ROW } }]);
  assert.deepEqual(body.ok, ['e1']);
  const ins = pg.queries.find(q => q.sql.includes('INSERT INTO unit_access'));
  assert.ok(ins, 'the grant must reach SQL');
  assert.ok(ins!.params.includes(CALLER), 'granted_by must be the authenticated caller');
  assert.ok(!ins!.params.includes('forged-id'), 'a forged granted_by must not survive');
});

test('unit_access: a production_manager may edit grants for a tier-1 grantee on any unit', async () => {
  const pg = fakePg({ callerRole: 'production_manager', unitOwner: OTHER, granteeRole: 'mitigation_technician' });
  const body = await push(pg, [{ operation: 'UPDATE', table_name: 'unit_access', payload: { ...GRANT_ROW, can_remove: false } }]);
  assert.deepEqual(body.ok, ['e1']);
});

test('unit_access: a production_manager may NOT touch a full_admin grantee (permanent)', async () => {
  const pg = fakePg({ callerRole: 'production_manager', unitOwner: OTHER, granteeRole: 'full_admin' });
  const body = await push(pg, [{ operation: 'INSERT', table_name: 'unit_access', payload: { ...GRANT_ROW } }]);
  assert.deepEqual(body.ok, []);
  assert.match(body.conflicts[0].error, PERMANENT);
});

test('unit_access: a manager of a team the owner is on may grant', async () => {
  const pg = fakePg({ callerRole: 'head_of_contents', unitOwner: OTHER, managesOwnerTeam: true });
  const body = await push(pg, [{ operation: 'INSERT', table_name: 'unit_access', payload: { ...GRANT_ROW } }]);
  assert.deepEqual(body.ok, ['e1']);
});

test('unit_access: an unrelated crew caller is a permanent rejection (grant and revoke)', async () => {
  const pg = fakePg({ callerRole: 'construction_crew', unitOwner: OTHER });
  const body = await push(pg, [
    { operation: 'INSERT', table_name: 'unit_access', payload: { ...GRANT_ROW } },
    { operation: 'DELETE', table_name: 'unit_access', payload: { location_id: 'loc-1', user_id: OTHER } },
  ]);
  assert.deepEqual(body.ok, []);
  assert.equal(body.conflicts.length, 2);
  for (const c of body.conflicts) assert.match(c.error, PERMANENT);
  assert.ok(!pg.queries.some(q => q.sql.includes('INSERT INTO unit_access') || q.sql.includes('DELETE FROM unit_access')));
});

test('unit_access: a write against a missing location fails closed (permanent)', async () => {
  const pg = fakePg({ callerRole: 'full_admin', unitLocMissing: true });
  const body = await push(pg, [{ operation: 'INSERT', table_name: 'unit_access', payload: { ...GRANT_ROW, location_id: 'loc-ghost' } }]);
  assert.deepEqual(body.ok, []);
  assert.match(body.conflicts[0].error, PERMANENT);
});
```

Run and watch them fail: `node --import tsx --test src/routes/sync-guards.test.ts`

- [ ] Wire `apps/api/src/routes/sync.ts` (verify-then-add; A1 may have done some):
  - `ALLOWED_TABLES` (line ~44) and the pull table list (line ~250) get `'unit_access',` next to `'locker_access',`.
  - `CONFLICT_TARGETS` (line ~93): `unit_access: 'location_id, user_id',`.
  - Import: `import { canManageUnitAccess } from '../lib/unitAccessPolicy';`
- [ ] Wire `apps/api/src/lib/syncPolicy.ts` (verify-then-add):
  - `ATTRIBUTION_COLUMNS` (line ~160): `unit_access: ['granted_by'],`
  - `OPERATION_PERM` (line ~349): `unit_access: { INSERT: null, UPDATE: null, DELETE: null },  // real gate = per-row canManageUnitAccess guard in routes/sync.ts`
  - Allowed activity actions list (line ~393): add `'unit_access_granted', 'unit_access_revoked', 'unit_access_changed',`
  - `selectColumnsFor` (line ~471): add `const UNIT_ACCESS_COLS = 'location_id, user_id, can_view, can_add, can_remove, can_move, can_edit_details, can_grant, granted_by, created_at, updated_at';` and `if (table === 'unit_access') return UNIT_ACCESS_COLS;`
  - Add a `syncPolicy.test.ts` case: `assert.equal(requiredOperationPerm('unit_access', 'DELETE'), null);` and `assert.equal(isAllowedActivity('unit_access_changed', 'location'), true);` — `isAllowedActivity(action, entityType)` takes BOTH args (syncPolicy.ts:402; a one-arg call is a type error and returns false regardless); unit actions log against entity_type `'location'`, already in `ACTIVITY_ENTITY_TYPES`.
- [ ] Mobile action switch (the allowlist now accepts the unit-specific actions): in `apps/mobile/src/db/queries/unitAccess.ts` change the `appendLog` actions `locker_access_granted` → `unit_access_granted` and `locker_access_revoked` → `unit_access_revoked`, and update the module's rationale comment (A1 reused the locker actions only because the allowlist hadn't been widened yet). Deploy note: ship the API before (or in lockstep with) mobile — an old server rejects the new action strings.
- [ ] In `apps/api/src/routes/sync.ts`, revert A1 Task 7's widened guard condition back to `if (entry.table_name === 'locker_access') {` (the locker guard keeps whatever denial wording A1 left it — still matches `PERMANENT`), then add the per-row `unit_access` guard immediately AFTER the `locker_access` guard block (after line ~1272):

```ts
      // unit_access (#122 Phase B): per-action grants gate vehicle/locker stock
      // access, so writes are owner ∪ manager-of-owner's-team ∪ production
      // manager ∪ tier-3+ — and every non-owner editor must out-tier the
      // GRANTEE (canManageUnitAccess, lib/unitAccessPolicy.ts). All facts come
      // from the DB, never the payload; a missing location fails closed with
      // permanent wording (matches the mobile engine's drop regex).
      if (entry.table_name === 'unit_access') {
        let uaFacts:
          | { owner_user_id: string | null; grantee_role: string | null; manages_owner_team: boolean }
          | undefined;
        try {
          const { rows: uaRows } = await fastify.pg.query(
            `SELECT l.owner_user_id,
                    (SELECT role FROM users WHERE id = $2) AS grantee_role,
                    EXISTS (SELECT 1 FROM team_members om
                              JOIN team_members cm ON cm.team_id = om.team_id AND cm.is_manager = TRUE
                             WHERE om.user_id = l.owner_user_id AND cm.user_id = $3) AS manages_owner_team
               FROM locations l WHERE l.id = $1`,
            [entry.payload.location_id, entry.payload.user_id, userId],
          );
          uaFacts = uaRows[0] as typeof uaFacts;
        } catch { uaFacts = undefined; }
        if (!uaFacts) {
          conflicts.push({ id: entry.id, error: 'Forbidden: unit location does not exist' });
          continue;
        }
        const allowed = canManageUnitAccess({
          callerId: userId,
          callerRole: caller.role,
          ownerUserId: uaFacts.owner_user_id == null ? null : String(uaFacts.owner_user_id),
          callerManagesOwnersTeam: uaFacts.manages_owner_team === true,
          granteeRole: uaFacts.grantee_role == null ? null : String(uaFacts.grantee_role),
        });
        if (!allowed) {
          request.log.warn(
            { userId, role: caller.role, locationId: entry.payload.location_id, operation: entry.operation },
            'sync push unit_access denied (not owner/team-manager/PM)',
          );
          conflicts.push({ id: entry.id, error: 'Forbidden: you cannot manage access to this unit' });
          continue;
        }
      }
```

- [ ] Run: `cd /home/tdpotato/projects/InventoryPro/apps/api && node --import tsx --test src/routes/sync-guards.test.ts src/lib/syncPolicy.test.ts` — green; then full `pnpm test`.
- [ ] Commit: `git add apps/api/src/routes/sync.ts apps/api/src/lib/syncPolicy.ts apps/api/src/routes/sync-guards.test.ts apps/api/src/lib/syncPolicy.test.ts && git commit -m "feat(#122-B): unit_access per-row sync guard (owner/team-manager/PM) + policy wiring"`

### Task 3: Mobile — reactive `unit_access_defaults` store module + hook + sync notify

The per-role defaults template lives in app_config key `unit_access_defaults` (JSON `role -> action booleans`). Module-cache reactivity is mandatory: copy the `hiddenFields.ts` version-counter/listener pattern and notify from the sync engine after pulls, or the settings screen and grant flows show stale defaults until remount.

**Files**
- Create: `apps/mobile/src/db/unitAccessDefaults.ts`, `apps/mobile/src/hooks/useUnitAccessDefaults.ts`
- Modify: `apps/mobile/src/sync/engine.ts` (line ~252, next to `notifyHiddenFieldsChanged()`)
- Test: `apps/mobile/src/db/unitAccessDefaults.test.ts`

**Interfaces**
- Consumes: `getAppConfig(key)`, `setAppConfigLocal(key, value)` from `apps/mobile/src/db/appConfig.ts`; `appendOutbox` from `apps/mobile/src/sync/outbox.ts`; `ROLE_TIER` from `apps/mobile/src/constants/roles.ts`.
- Produces:
  - `type UnitAccessActions = { view: boolean; add: boolean; remove: boolean; move: boolean; editDetails: boolean; grant: boolean }`
  - `UNIT_ACCESS_DEFAULTS_KEY = 'unit_access_defaults'`, `FALLBACK_ACTIONS: UnitAccessActions`
  - `parseUnitAccessDefaults(raw: string | null): Record<string, UnitAccessActions>` (pure)
  - `getUnitAccessDefaults(): Record<string, UnitAccessActions>`, `getDefaultActionsForRole(role: string): UnitAccessActions`, `setUnitAccessDefaults(map): void`
  - `subscribeUnitAccessDefaults(cb)`, `getUnitAccessDefaultsVersion()`, `notifyUnitAccessDefaultsChanged()`
  - hook `useUnitAccessDefaults(): Record<string, UnitAccessActions>`

**Steps**

- [ ] Write the failing test `apps/mobile/src/db/unitAccessDefaults.test.ts` (node:test, run with the repo's setupGlobals shim like the other `src/db` tests):

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUnitAccessDefaults, FALLBACK_ACTIONS } from './unitAccessDefaults';

test('missing key / bad JSON / non-object → empty map (callers fall back per-role)', () => {
  assert.deepEqual(parseUnitAccessDefaults(null), {});
  assert.deepEqual(parseUnitAccessDefaults('{not json'), {});
  assert.deepEqual(parseUnitAccessDefaults('[1,2]'), {});
});

test('unknown roles and junk values are dropped; partial action maps backfill from FALLBACK_ACTIONS', () => {
  const raw = JSON.stringify({
    mitigation_technician: { view: true, add: true, remove: true, move: false, editDetails: false, grant: false },
    not_a_role: { view: true },
    production_manager: { grant: true },   // partial → other actions from fallback
    contents_crew: 'junk',
  });
  const out = parseUnitAccessDefaults(raw);
  assert.deepEqual(Object.keys(out).sort(), ['mitigation_technician', 'production_manager']);
  assert.equal(out.mitigation_technician.move, false);
  assert.deepEqual(out.production_manager, { ...FALLBACK_ACTIONS, grant: true });
});

test('fallback matches the A1 migration copy semantics (view+add+remove+move on, editDetails/grant off)', () => {
  assert.deepEqual(FALLBACK_ACTIONS, { view: true, add: true, remove: true, move: true, editDetails: false, grant: false });
});
```

Run: `cd /home/tdpotato/projects/InventoryPro/apps/mobile && node --import tsx --import ./src/test/setupGlobals.mjs --test src/db/unitAccessDefaults.test.ts` — fails.

- [ ] Create `apps/mobile/src/db/unitAccessDefaults.ts`:

```ts
import { getAppConfig, setAppConfigLocal } from './appConfig';
import { appendOutbox } from '../sync/outbox';
import { ROLE_TIER } from '../constants/roles';

// Admin-configured per-role defaults for NEW unit_access grants (#122 Phase B),
// synced via app_config. Version counter + listeners (hiddenFields.ts pattern):
// synced config that gates UI must notify subscribers or changes don't show
// until remount. notifyUnitAccessDefaultsChanged is called by the settings
// screen after each commit and by the sync engine after every pull.
export const UNIT_ACCESS_DEFAULTS_KEY = 'unit_access_defaults';

export interface UnitAccessActions {
  view: boolean; add: boolean; remove: boolean; move: boolean;
  editDetails: boolean; grant: boolean;
}

// What a brand-new grant confers when the admin hasn't configured the role —
// identical to what migration 046/058 gave copied locker_access rows.
export const FALLBACK_ACTIONS: UnitAccessActions = {
  view: true, add: true, remove: true, move: true, editDetails: false, grant: false,
};

let cacheVersion = 0;
const listeners = new Set<() => void>();
export function subscribeUnitAccessDefaults(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}
export function getUnitAccessDefaultsVersion(): number { return cacheVersion; }
export function notifyUnitAccessDefaultsChanged(): void { cacheVersion++; listeners.forEach(l => l()); }

const ACTION_KEYS = ['view', 'add', 'remove', 'move', 'editDetails', 'grant'] as const;

/** Pure parse — tolerant of missing key, bad JSON, unknown roles, partial maps. */
export function parseUnitAccessDefaults(raw: string | null): Record<string, UnitAccessActions> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, UnitAccessActions> = {};
    for (const [role, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (!(role in ROLE_TIER) || v === null || typeof v !== 'object' || Array.isArray(v)) continue;
      const m = v as Record<string, unknown>;
      const actions = { ...FALLBACK_ACTIONS };
      for (const k of ACTION_KEYS) {
        if (typeof m[k] === 'boolean') actions[k] = m[k] as boolean;
      }
      out[role] = actions;
    }
    return out;
  } catch {
    return {};
  }
}

export function getUnitAccessDefaults(): Record<string, UnitAccessActions> {
  return parseUnitAccessDefaults(getAppConfig(UNIT_ACCESS_DEFAULTS_KEY));
}

/** The actions a new grant for `role` should start with. */
export function getDefaultActionsForRole(role: string): UnitAccessActions {
  return getUnitAccessDefaults()[role] ?? FALLBACK_ACTIONS;
}

/**
 * Persist the whole template + push through the outbox (server gates app_config
 * on system_settings). Does NOT bump the version — call
 * notifyUnitAccessDefaultsChanged() after the enclosing transaction commits.
 */
export function setUnitAccessDefaults(map: Record<string, UnitAccessActions>): void {
  const value = JSON.stringify(map);
  setAppConfigLocal(UNIT_ACCESS_DEFAULTS_KEY, value);
  appendOutbox('INSERT', 'app_config', {
    key: UNIT_ACCESS_DEFAULTS_KEY, value, updated_at: new Date().toISOString(),
  });
}
```

- [ ] Create `apps/mobile/src/hooks/useUnitAccessDefaults.ts` (mirror of `useHiddenFields.ts`):

```ts
import { useSyncExternalStore } from 'react';
import {
  getUnitAccessDefaults, subscribeUnitAccessDefaults, getUnitAccessDefaultsVersion,
  type UnitAccessActions,
} from '../db/unitAccessDefaults';

/** Reactive per-role unit-access defaults — re-renders on local edits AND sync pulls. */
export function useUnitAccessDefaults(): Record<string, UnitAccessActions> {
  useSyncExternalStore(subscribeUnitAccessDefaults, getUnitAccessDefaultsVersion, getUnitAccessDefaultsVersion);
  return getUnitAccessDefaults();
}
```

- [ ] In `apps/mobile/src/sync/engine.ts`, next to the existing `notifyHiddenFieldsChanged()` call after a pull (line ~252), add `import { notifyUnitAccessDefaultsChanged } from '../db/unitAccessDefaults';` (top, line ~14) and `notifyUnitAccessDefaultsChanged();` on the line after `notifyHiddenFieldsChanged();`.
- [ ] Run the test file (green) then the full mobile suite: `cd /home/tdpotato/projects/InventoryPro/apps/mobile && pnpm test` and `pnpm exec tsc --noEmit`.
- [ ] Commit: `git add apps/mobile/src/db/unitAccessDefaults.ts apps/mobile/src/db/unitAccessDefaults.test.ts apps/mobile/src/hooks/useUnitAccessDefaults.ts apps/mobile/src/sync/engine.ts && git commit -m "feat(#122-B): reactive unit_access_defaults app_config store + hook + pull notify"`

### Task 4: Mobile — auto-apply defaults on grant creation + policy mirror

Grant creation goes through one helper that reads the admin template for the grantee's role and shapes the `unit_access` row; the server policy from Task 1 is mirrored as a pure function for courtesy gating (server stays the enforcement of record).

**Files**
- Create: `apps/mobile/src/access/unitGrants.ts`, `apps/mobile/src/access/unitAccessPolicy.ts`
- Modify: `apps/mobile/src/db/queries/access.ts` (add `getManagedOwnerIds`, `getUserUnitGrants`, `getGrantableUnits`)
- Test: `apps/mobile/src/access/unitGrants.test.ts`, `apps/mobile/src/access/unitAccessPolicy.test.ts`

**Interfaces**
- Consumes: `upsertUnitAccess(row)` from `apps/mobile/src/db/queries/unitAccess.ts` (A1 contract, pinned to accept boolean OR 0/1 flags plus optional created_at/updated_at — owns local upsert + outbox + activity log `unit_access_granted`, the action Task 2's switch step renames from A1's `locker_access_granted`); `getDefaultActionsForRole(role)` (Task 3); `ROLE_TIER`, `canActOnTarget`, `UserRole` from `constants/roles`; `getAllLocations`, `Location` from `db/queries/locations`; `UserSession` from `auth/permissions`.
- Produces:
  - `buildDefaultGrantRow(locationId, userId, actions: UnitAccessActions, actorUserId: string | null, nowIso: string): UnitAccessUpsert` (pure — returns A1's widened upsert input shape: 0/1 flags + explicit timestamps, which `upsertUnitAccess` accepts verbatim)
  - `grantUnitAccessWithDefaults(locationId: string, userId: string, granteeRole: string, actorUserId: string | null): void`
  - `canManageUnitAccess(f: UnitAccessEditFacts): boolean` (mobile mirror, same facts shape as API)
  - `getManagedOwnerIds(callerId: string): Set<string>`
  - `getUserUnitGrants(userId: string): UserUnitGrant[]` where `UserUnitGrant = { location_id; user_id; can_view; can_add; can_remove; can_move; can_edit_details; can_grant; granted_by; created_at; updated_at; location_name; location_type; owner_user_id }` (INTEGER 0/1 flags)
  - `getGrantableUnits(user: UserSession, granteeRole: string | null): Location[]`

**Steps**

- [ ] Write failing tests. `apps/mobile/src/access/unitGrants.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDefaultGrantRow } from './unitGrants';

test('buildDefaultGrantRow maps template booleans to 0/1 columns with attribution + timestamps', () => {
  const row = buildDefaultGrantRow('loc-1', 'user-2',
    { view: true, add: true, remove: true, move: false, editDetails: false, grant: false },
    'actor-9', '2026-07-19T00:00:00.000Z');
  assert.deepEqual(row, {
    location_id: 'loc-1', user_id: 'user-2',
    can_view: 1, can_add: 1, can_remove: 1, can_move: 0, can_edit_details: 0, can_grant: 0,
    granted_by: 'actor-9', created_at: '2026-07-19T00:00:00.000Z', updated_at: '2026-07-19T00:00:00.000Z',
  });
});
```

`apps/mobile/src/access/unitAccessPolicy.test.ts`: port the Task 1 test matrix verbatim (same cases, importing from `./unitAccessPolicy`) so mobile/server parity is asserted by identical fixtures.

- [ ] Create `apps/mobile/src/access/unitAccessPolicy.ts` (mirror — KEEP IN SYNC with `apps/api/src/lib/unitAccessPolicy.ts`):

```ts
import { ROLE_TIER, canActOnTarget, type UserRole } from '../constants/roles';

// Mobile mirror of the server's unit_access write policy
// (apps/api/src/lib/unitAccessPolicy.ts) — courtesy gating only; /sync/push is
// the enforcement of record. KEEP IN SYNC.
export interface UnitAccessEditFacts {
  callerId: string;
  callerRole: string | null | undefined;
  ownerUserId: string | null;
  callerManagesOwnersTeam: boolean;
  granteeRole: string | null;
}

export function canManageUnitAccess(f: UnitAccessEditFacts): boolean {
  if (f.ownerUserId != null && f.ownerUserId === f.callerId) return true;
  const privileged =
    (f.callerRole != null && (ROLE_TIER[f.callerRole as UserRole] ?? 0) >= 3)
    || f.callerRole === 'production_manager'
    || f.callerManagesOwnersTeam;
  if (!privileged) return false;
  return canActOnTarget((f.callerRole ?? '') as UserRole, (f.granteeRole ?? '') as UserRole);
}
```

- [ ] Create `apps/mobile/src/access/unitGrants.ts`:

```ts
import { upsertUnitAccess } from '../db/queries/unitAccess';
import { getDefaultActionsForRole, type UnitAccessActions } from '../db/unitAccessDefaults';

/** Pure row shaper — exported for tests. */
export function buildDefaultGrantRow(
  locationId: string, userId: string, actions: UnitAccessActions,
  actorUserId: string | null, nowIso: string,
) {
  return {
    location_id: locationId, user_id: userId,
    can_view: actions.view ? 1 : 0, can_add: actions.add ? 1 : 0,
    can_remove: actions.remove ? 1 : 0, can_move: actions.move ? 1 : 0,
    can_edit_details: actions.editDetails ? 1 : 0, can_grant: actions.grant ? 1 : 0,
    granted_by: actorUserId, created_at: nowIso, updated_at: nowIso,
  };
}

/**
 * Create a grant with the admin's per-role defaults auto-applied (#122 Phase B).
 * upsertUnitAccess (A1) owns the local write + outbox + activity log; editing
 * the grant afterwards goes through upsertUnitAccess directly.
 */
export function grantUnitAccessWithDefaults(
  locationId: string, userId: string, granteeRole: string, actorUserId: string | null,
): void {
  upsertUnitAccess(buildDefaultGrantRow(
    locationId, userId, getDefaultActionsForRole(granteeRole), actorUserId, new Date().toISOString(),
  ));
}
```

- [ ] Add the three queries to `apps/mobile/src/db/queries/access.ts` (below `getLockerAccessList`):

```ts
/** User ids who share a team on which `callerId` is a manager (is_manager=1). */
export function getManagedOwnerIds(callerId: string): Set<string> {
  const db = getDb();
  const rows = rowsAs<{ user_id: string }>(db.executeSync(
    `SELECT DISTINCT om.user_id
       FROM team_members om
       JOIN team_members cm ON cm.team_id = om.team_id
      WHERE cm.user_id = ? AND cm.is_manager = 1`,
    [callerId],
  ).rows);
  return new Set(rows.map(r => r.user_id));
}

export interface UserUnitGrant {
  location_id: string; user_id: string;
  can_view: number; can_add: number; can_remove: number; can_move: number;
  can_edit_details: number; can_grant: number;
  granted_by: string | null; created_at: string; updated_at: string;
  location_name: string; location_type: string; owner_user_id: string | null;
}

/** Every unit_access grant `userId` holds, joined with the unit it's on. */
export function getUserUnitGrants(userId: string): UserUnitGrant[] {
  const db = getDb();
  return rowsAs<UserUnitGrant>(db.executeSync(
    `SELECT ua.location_id, ua.user_id, ua.can_view, ua.can_add, ua.can_remove, ua.can_move,
            ua.can_edit_details, ua.can_grant, ua.granted_by, ua.created_at, ua.updated_at,
            l.name AS location_name, l.type AS location_type, l.owner_user_id
       FROM unit_access ua
       JOIN locations l ON l.id = ua.location_id
      WHERE ua.user_id = ? AND l.active = 1
      ORDER BY l.type, l.name`,
    [userId],
  ).rows);
}

/** Units `user` may create a grant on for `granteeRole` (canManageUnitAccess per unit). */
export function getGrantableUnits(user: UserSession, granteeRole: string | null): Location[] {
  const managed = getManagedOwnerIds(user.id);
  return getAllLocations()
    .filter(l => l.type === 'Vehicle' || l.type === 'Locker')
    .filter(l => canManageUnitAccess({
      callerId: user.id,
      callerRole: user.role,
      ownerUserId: l.owner_user_id,
      callerManagesOwnersTeam: l.owner_user_id != null && managed.has(l.owner_user_id),
      granteeRole,
    }));
}
```

with `import { canManageUnitAccess } from '../../access/unitAccessPolicy';` added to the imports.

- [ ] Run both new test files + `pnpm exec tsc --noEmit` + `pnpm test` — green.
- [ ] Commit: `git add apps/mobile/src/access apps/mobile/src/db/queries/access.ts && git commit -m "feat(#122-B): grant-with-defaults helper, mobile unit-access policy mirror, grant queries"`

### Task 5: Mobile — admin settings UI for the defaults template

Standalone admin sub-screen (the `hidden-fields.tsx` idiom: `system_settings`-gated, per-toggle immediate commit, reactive via the Task 3 hook) plus a link row on the Settings screen.

**Files**
- Create: `apps/mobile/app/(app)/(admin)/unit-access-defaults.tsx`
- Modify: `apps/mobile/app/(app)/(admin)/settings.tsx` (new link card after the Hidden Fields card, line ~835)

**Interfaces**
- Consumes: `useUnitAccessDefaults`, `setUnitAccessDefaults`, `notifyUnitAccessDefaultsChanged`, `getDefaultActionsForRole`, `FALLBACK_ACTIONS`, `UnitAccessActions` (Task 3); `usePermission('system_settings')`; `ROLE_TIER`, `ROLE_DISPLAY_NAMES`, `UserRole` from `constants/roles`; `runInTransaction` from `db/tx`; `isWriteBlocked` from `db/maintenance`.
- Produces: route `/(app)/(admin)/unit-access-defaults`.

**Steps**

- [ ] Create `apps/mobile/app/(app)/(admin)/unit-access-defaults.tsx` — structure copied from `hidden-fields.tsx` (same imports/styles/guard), body:

```tsx
const ROLES_ORDERED = (Object.keys(ROLE_TIER) as UserRole[]).sort(
  (a, b) => ROLE_TIER[b] - ROLE_TIER[a] || ROLE_DISPLAY_NAMES[a].localeCompare(ROLE_DISPLAY_NAMES[b]),
);

const ACTION_LABELS: Record<keyof UnitAccessActions, string> = {
  view: 'See contents', add: 'Add stock', remove: 'Take stock', move: 'Move stock',
  editDetails: 'Edit details', grant: 'Grant access to others',
};
const ACTION_KEYS = Object.keys(ACTION_LABELS) as (keyof UnitAccessActions)[];

export default function UnitAccessDefaultsScreen() {
  const s = useThemedStyles(makeStyles);
  const t = useTheme();
  const isAdmin = usePermission('system_settings');
  const defaults = useUnitAccessDefaults();   // reactive — sync pulls re-render this screen

  function handleToggle(role: UserRole, action: keyof UnitAccessActions, value: boolean) {
    if (isWriteBlocked()) return;
    const next = {
      ...defaults,
      [role]: { ...(defaults[role] ?? FALLBACK_ACTIONS), [action]: value },
    };
    try {
      runInTransaction(() => setUnitAccessDefaults(next));
    } catch (e) {
      Alert.alert('Could not save defaults', e instanceof Error ? e.message : 'Please try again.');
      return;
    }
    notifyUnitAccessDefaultsChanged();
  }

  if (!isAdmin) {
    return (
      <View style={s.center}>
        <Stack.Screen options={{ title: 'Unit Access Defaults', headerShown: true }} />
        <Text style={s.muted}>You don’t have access to unit access defaults.</Text>
      </View>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: 'Unit Access Defaults', headerShown: true }} />
      <ScrollView style={s.container} contentContainerStyle={s.content}>
        <View style={s.intro}>
          <Text style={s.introTitle}>New-grant defaults per role</Text>
          <Text style={s.introBody}>
            When someone is granted access to a vehicle or locker, their grant starts
            with these actions (based on their role). Individual grants can be edited
            afterwards from the member's permissions sheet.
          </Text>
        </View>
        {ROLES_ORDERED.map(role => {
          const actions = defaults[role] ?? FALLBACK_ACTIONS;
          return (
            <View key={role} style={s.card}>
              <Text style={s.roleTitle}>{ROLE_DISPLAY_NAMES[role]}</Text>
              {ACTION_KEYS.map((k, idx) => (
                <View key={k}>
                  {idx > 0 && <View style={s.divider} />}
                  <View style={s.row}>
                    <Text style={s.rowLabel}>{ACTION_LABELS[k]}</Text>
                    <Switch
                      value={actions[k]}
                      onValueChange={(v) => handleToggle(role, k, v)}
                      trackColor={{ true: t.colors.primary, false: t.colors.border }}
                    />
                  </View>
                </View>
              ))}
            </View>
          );
        })}
      </ScrollView>
    </>
  );
}
```

(`makeStyles` copied from `hidden-fields.tsx` plus `roleTitle: { fontSize: 15, fontWeight: '700', color: t.colors.textPrimary, paddingTop: t.spacing.sm, paddingHorizontal: t.spacing.base }`.)

- [ ] Add the Settings link card in `apps/mobile/app/(app)/(admin)/settings.tsx` directly after the Hidden Fields card (line ~835), same markup as the Hidden Fields row:

```tsx
        {/* ── Unit Access Defaults (admin only — synced via app_config) ── */}
        {isAdmin && (
          <View>
            <Text style={s.sectionTitle}>Unit Access</Text>
            <View style={s.card}>
              <TouchableOpacity
                style={s.row}
                onPress={() => router.push('/(app)/(admin)/unit-access-defaults')}
              >
                <View style={{ flex: 1 }}>
                  <Text style={s.rowLabel}>🔑 Unit Access Defaults</Text>
                  <Text style={s.rowSub}>What a new vehicle/locker grant allows, per role.</Text>
                </View>
                <Text style={s.rowSub}>›</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
```

- [ ] Verify: `pnpm exec tsc --noEmit` clean; `pnpm test` green (no new tests — screen is assembled from tested modules).
- [ ] Commit: `git add "apps/mobile/app/(app)/(admin)/unit-access-defaults.tsx" "apps/mobile/app/(app)/(admin)/settings.tsx" && git commit -m "feat(#122-B): Unit Access Defaults admin screen + settings link"`

### Task 6: Mobile — dashboard preset editor filters widgets by the target's permissions

When a preset is assigned to role(s), the add-widget picker only offers tiles every assigned role passes (`requiredPermission` resolved as role default + role_settings override — the same resolution `PermissionGate` uses at runtime, which stays as the backstop). Also adds the `roleHasPermission` primitive Task 7 reuses.

**Files**
- Create: `apps/mobile/src/dashboard/presetFilter.ts`
- Modify: `apps/mobile/src/auth/permissions.ts` (add `roleHasPermission`), `apps/mobile/app/(app)/(admin)/dashboards.tsx`
- Test: `apps/mobile/src/dashboard/presetFilter.test.ts`

**Interfaces**
- Consumes: `WIDGET_REGISTRY`, `WidgetType` from `./widgets` (which Phase A2 extends with `'vehicles'`/`'lockers'` tiles — this filter picks them up automatically); `Permission`, `UserRole`, `ROLE_DEFAULTS` from `constants/roles`; module-cached `roleOverridesCache` (already reactive via `loadRolePermissionCache`).
- Produces:
  - `roleHasPermission(role: UserRole, permission: Permission): boolean` in `auth/permissions.ts`
  - `filterTilesForRoles(tiles: WidgetType[], targetRoles: string[], roleHasPerm: (role: string, perm: Permission) => boolean): WidgetType[]`

**Steps**

- [ ] Write the failing test `apps/mobile/src/dashboard/presetFilter.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterTilesForRoles } from './presetFilter';
import type { WidgetType } from './widgets';

// checkout requires checkout_inventory; users requires manage_users;
// fast-checkout and manage-my-team have NO requiredPermission (data-driven).
const TILES: WidgetType[] = ['fast-checkout', 'checkout', 'users', 'manage-my-team'];

test('no assigned roles → every tile is offered (nothing to check against)', () => {
  assert.deepEqual(filterTilesForRoles(TILES, [], () => false), TILES);
});

test('permissionless tiles are always offered', () => {
  const out = filterTilesForRoles(TILES, ['construction_crew'], () => false);
  assert.deepEqual(out, ['fast-checkout', 'manage-my-team']);
});

test('a gated tile needs EVERY assigned role to pass', () => {
  const perms: Record<string, string[]> = {
    construction_crew: ['checkout_inventory'],
    hr_manager: ['manage_users'],
  };
  const roleHasPerm = (role: string, perm: string) => (perms[role] ?? []).includes(perm);
  assert.deepEqual(
    filterTilesForRoles(TILES, ['construction_crew', 'hr_manager'], roleHasPerm),
    ['fast-checkout', 'manage-my-team'],   // neither tile passes BOTH roles
  );
  assert.deepEqual(
    filterTilesForRoles(TILES, ['construction_crew'], roleHasPerm),
    ['fast-checkout', 'checkout', 'manage-my-team'],
  );
});
```

Run it — fails.

- [ ] Create `apps/mobile/src/dashboard/presetFilter.ts`:

```ts
import { WIDGET_REGISTRY, type WidgetType } from './widgets';
import type { Permission } from '../constants/roles';

// Which tile widgets the preset editor should OFFER for a preset assigned to
// `targetRoles` (#122 Phase B): a tile is offered when it carries no
// requiredPermission, when the preset has no role assignments yet, or when
// EVERY assigned role passes the tile's requiredPermission. Purely advisory —
// the hub's PermissionGate stays as the runtime backstop.
export function filterTilesForRoles(
  tiles: WidgetType[],
  targetRoles: string[],
  roleHasPerm: (role: string, perm: Permission) => boolean,
): WidgetType[] {
  if (targetRoles.length === 0) return tiles;
  return tiles.filter(w => {
    const perm = WIDGET_REGISTRY[w].requiredPermission;
    if (!perm) return true;
    return targetRoles.every(r => roleHasPerm(r, perm));
  });
}
```

- [ ] Add `roleHasPermission` to `apps/mobile/src/auth/permissions.ts` (below `hasPermission`, reusing the module's `roleOverridesCache` + `FULL_ADMIN_FLOOR`):

```ts
/**
 * A ROLE's effective permission (default + role_settings override) — no user or
 * team layer. Drives the preset editor's widget filtering and the Teams sheet's
 * baseline values. Reactive via the same roleOverridesCache that
 * loadRolePermissionCache refreshes + notifies on.
 */
export function roleHasPermission(role: UserRole, permission: Permission): boolean {
  if (role === 'full_admin' && FULL_ADMIN_FLOOR.includes(permission)) return true;
  let result = ROLE_DEFAULTS[role]?.[permission] ?? false;
  const ov = roleOverridesCache[role];
  if (ov && permission in ov) result = ov[permission];
  return result;
}
```

- [ ] Wire `apps/mobile/app/(app)/(admin)/dashboards.tsx`:
  - Imports: `import { filterTilesForRoles } from '../../../src/dashboard/presetFilter';` and `import { roleHasPermission } from '../../../src/auth/permissions';` (plus `Permission` type from constants if not present).
  - Below `editingPreset` (line ~106):

```ts
  // Roles currently assigned to the preset being edited — the add-widget picker
  // offers only tiles every one of them passes (requiredPermission).
  const assignedRoles = useMemo(
    () => Object.entries(roleMap).filter(([, id]) => id === editingId).map(([role]) => role),
    [roleMap, editingId],
  );
  const offeredTiles = filterTilesForRoles(
    TILE_WIDGETS, assignedRoles,
    (role, perm) => roleHasPermission(role as UserRole, perm),
  );
  const hiddenTileCount = TILE_WIDGETS.length - offeredTiles.length;
```

  - In the add-widget modal (line ~418) replace the `TILE_WIDGETS.map(...)` grid source with `offeredTiles.map(...)` and add after the tiles grid:

```tsx
              {hiddenTileCount > 0 && (
                <Text style={s.pickNote}>
                  {hiddenTileCount} widget{hiddenTileCount === 1 ? '' : 's'} hidden — the assigned
                  role{assignedRoles.length === 1 ? ' doesn’t' : 's don’t'} have permission for {hiddenTileCount === 1 ? 'it' : 'them'}.
                </Text>
              )}
```

  with style `pickNote: { fontSize: 12, color: t.colors.textMuted, marginTop: 8 }` added to `makeStyles`.
- [ ] Scope note (explicit deviation from the spec's "user/role" wording — record it in the commit body for the spec owner): the filter considers ROLE assignments only. Presets assigned directly to individual users (`users.dashboard_preset_id`, set from the Users screen via `setUserDashboardPreset`) are NOT factored in, so the editor may still offer a tile such a user's permissions fail — `PermissionGate` remains the runtime backstop that hides it. Extending the intersection to user targets (query `users WHERE dashboard_preset_id = ?`, then resolve each user's effective permissions via the existing role-default + role-override + user-override resolution) is deliberate follow-up work, not part of this task.
- [ ] Run `node --import tsx --import ./src/test/setupGlobals.mjs --test src/dashboard/presetFilter.test.ts` then `pnpm test` + `pnpm exec tsc --noEmit` — green.
- [ ] Commit: `git add apps/mobile/src/dashboard/presetFilter.ts apps/mobile/src/dashboard/presetFilter.test.ts apps/mobile/src/auth/permissions.ts "apps/mobile/app/(app)/(admin)/dashboards.tsx" && git commit -m "feat(#122-B): preset editor offers only widgets the assigned roles pass"`

### Task 7: Mobile — combined Member Permissions sheet on the Teams tab

One sheet per member = their team permission overrides (moved verbatim from `(teams)/[id].tsx`'s inline ModalSheet, lines ~843–895) PLUS their per-unit `unit_access` grants (per-action switches, revoke, grant-new-unit with Task 4's defaults auto-applied). Also switches the remaining `grantLockerAccess` creation sites to the defaults-applying helper.

**Files**
- Create: `apps/mobile/src/components/crew/MemberPermissionsSheet.tsx`
- Modify: `apps/mobile/app/(app)/(teams)/[id].tsx` (replace inline perm ModalSheet + its draft state with the component), `apps/mobile/app/(app)/(myteam)/index.tsx` (grants apply defaults; watch `unit_access`)

**Interfaces**
- Consumes: `getUserUnitGrants`, `getGrantableUnits`, `getManagedOwnerIds` (Task 4 additions to `queries/access.ts`); `upsertUnitAccess`, `revokeUnitAccess` (A1, `queries/unitAccess.ts`); `grantUnitAccessWithDefaults` (Task 4); `canManageUnitAccess` (mobile mirror); `setMemberPermissionOverridesOnline`, `TeamMember` from `queries/teams.ts`; `TEAM_OVERRIDABLE_PERMISSIONS`/`TEAM_PERMISSION_LABELS` (as imported by `[id].tsx` today); `roleHasPermission` (Task 6); `AccessListEditor`-family UI kit (`ModalSheet`, `SearchablePicker`, `PrimaryButton`, `confirmSheet`).
- Produces:

```ts
export function MemberPermissionsSheet(props: {
  visible: boolean;
  onClose: () => void;
  teamId: string;
  teamName: string;
  member: TeamMember | null;
  /** bump the host screen's local version after any write */
  onChanged: () => void;
}): JSX.Element
```

**Steps**

- [ ] Create `apps/mobile/src/components/crew/MemberPermissionsSheet.tsx`. Internals (all logic lifted, not reinvented):
  - **State:** `permDraft` seeded via `useEffect` on `member` from `parsePermissionOverrides(member.team_permission_overrides)`; `savingPerms`; `grantRefresh` counter; `addUnitOpen` + `selectedUnit: PickerOption | null`.
  - **Team section** (verbatim move of the `[id].tsx` sheet body): baseline now comes from Task 6's primitive — `const base = roleHasPermission((member.user_role ?? '') as UserRole, perm);` replacing `baseTeamPermValue`; toggle/save handlers `togglePermDraft` and `handleSavePermDraft` moved as-is (`setMemberPermissionOverridesOnline(teamId, member.user_id, permDraft)` then `onChanged()`).
  - **Unit section** below a divider header `Unit access` :

```tsx
const grants = useMemo(
  () => (member ? getUserUnitGrants(member.user_id) : []),
  [member?.user_id, grantRefresh],
);
const managedOwners = useMemo(() => (user ? getManagedOwnerIds(user.id) : new Set<string>()), [user?.id, grantRefresh]);

function canEditGrant(g: UserUnitGrant): boolean {
  return !!user && canManageUnitAccess({
    callerId: user.id, callerRole: user.role, ownerUserId: g.owner_user_id,
    callerManagesOwnersTeam: g.owner_user_id != null && managedOwners.has(g.owner_user_id),
    granteeRole: member?.user_role ?? null,
  });
}

const UNIT_ACTIONS = [
  ['can_view', 'See contents'], ['can_add', 'Add stock'], ['can_remove', 'Take stock'],
  ['can_move', 'Move stock'], ['can_edit_details', 'Edit details'], ['can_grant', 'Grant access'],
] as const;

function toggleUnitAction(g: UserUnitGrant, col: typeof UNIT_ACTIONS[number][0]) {
  if (isWriteBlocked()) return;
  const { location_name, location_type, owner_user_id, ...row } = g;
  upsertUnitAccess({ ...row, [col]: g[col] ? 0 : 1, updated_at: new Date().toISOString() });
  setGrantRefresh(n => n + 1);
  onChanged();
}

async function handleRevoke(g: UserUnitGrant) {
  const ok = await confirmSheet({
    title: 'Revoke', message: `Remove ${member?.user_name ?? 'this member'}'s access to ${g.location_name}?`,
    confirmLabel: 'Revoke', destructive: true,
  });
  if (!ok || isWriteBlocked()) return;
  revokeUnitAccess(g.location_id, g.user_id);
  setGrantRefresh(n => n + 1);
  onChanged();
}

function handleGrantUnit() {
  if (!member || !selectedUnit || isWriteBlocked()) return;
  grantUnitAccessWithDefaults(selectedUnit.id, member.user_id, member.user_role ?? '', user?.id ?? null);
  setSelectedUnit(null); setAddUnitOpen(false);
  setGrantRefresh(n => n + 1);
  onChanged();
}
```

  - Each grant renders as a card: `{location_type === 'Vehicle' ? '🚐' : '🔒'} {location_name}`, six labeled `Switch`es (`value={!!g[col]}`, `disabled={locked || !canEditGrant(g)}`, `onValueChange={() => toggleUnitAction(g, col)}`), and a `Revoke` link (AccessListEditor's `removeText` style) when `canEditGrant(g)`.
  - "**+ Grant access to a unit**" link opens a `SearchablePicker` over `getGrantableUnits(user, member.user_role)` minus units already granted (`new Set(grants.map(g => g.location_id))`), options `{ id: l.id, label: l.name, sublabel: l.type }`, confirmed by a `PrimaryButton` calling `handleGrantUnit` — the auto-apply-defaults path in action.
  - Styles: copy `makeStyles` idiom from `AccessListEditor.tsx` (title/list/row/divider/removeText) plus a `sectionLabel` matching `(myteam)/index.tsx`.
- [ ] Rewire `apps/mobile/app/(app)/(teams)/[id].tsx`: delete `permDraft`/`savingPerms` state, `baseTeamPermValue`, `togglePermDraft`, `handleSavePermDraft`, and the inline perm `ModalSheet` (lines ~843–895); keep `permMember` + `openPermEditor` (now just `setPermMember(member)`); render instead:

```tsx
      <MemberPermissionsSheet
        visible={!!permMember}
        onClose={() => setPermMember(null)}
        teamId={team.id}
        teamName={team.name}
        member={permMember}
        onChanged={() => setMembers(getTeamMembers(team.id))}
      />
```

  The `Perms` button's `disabled={locked || !canActMember}` row gate stays; the sheet re-checks `canActOnTarget` internally as before (safety net moved with the JSX).
- [ ] `apps/mobile/app/(app)/(myteam)/index.tsx`: add `'unit_access'` to the `useTableVersion([...])` list (line ~53) and change `handleGrant` (line ~181) to apply defaults:

```ts
  function handleGrant(opt: PickerOption) {
    if (!accessLocker || isWriteBlocked()) throw new Error('write blocked');
    const grantee = getAllActiveUsers().find(u => u.id === opt.id);
    grantUnitAccessWithDefaults(accessLocker.id, opt.id, grantee?.role ?? '', user?.id ?? null);
    bump();
  }
```

  and `handleRevoke` to `revokeUnitAccess(accessLocker.id, entry.userId)`. If Phase A2 already migrated this screen (and `LockerPanel`) off `grantLockerAccess`/`getLockerAccessList` onto `unit_access`, swap whatever bare `upsertUnitAccess` grant-creation call it left for `grantUnitAccessWithDefaults` — grep first: `grep -rn "grantLockerAccess\|upsertUnitAccess" apps/mobile/src apps/mobile/app`. Every grant-CREATION site must go through the defaults helper; per-action EDITS keep calling `upsertUnitAccess` directly.
- [ ] Cleanup A2 Task 5 promised ("Phase B deletes"): with myteam + LockerPanel rewired, delete `getLockerAccessList`/`grantLockerAccess`/`revokeLockerAccess` from `apps/mobile/src/db/queries/access.ts` and confirm zero callers remain: `grep -rn "getLockerAccessList\|grantLockerAccess\|revokeLockerAccess" apps/mobile/src apps/mobile/app` (Task 4 anchored its new queries "below getLockerAccessList" — after this deletion that anchor is gone, which is fine; the queries themselves stay).
- [ ] Verify: `pnpm exec tsc --noEmit` clean, `pnpm test` green (component logic is assembled from Task 4's tested policy/builders; the JSX is device-verified in Task 8).
- [ ] Commit: `git add apps/mobile/src/components/crew/MemberPermissionsSheet.tsx "apps/mobile/app/(app)/(teams)/[id].tsx" "apps/mobile/app/(app)/(myteam)/index.tsx" && git commit -m "feat(#122-B): combined member permissions sheet (team overrides + unit grants) with defaults auto-apply"`

### Task 8: Full verification + device hotload walkthrough

**Files**
- No new files (verification only).

**Interfaces**
- Consumes: everything above; `deploy-android` skill §B (debug dev-client + Metro, NO `CI=1`, `--clear`, and `adb reverse tcp:8081 tcp:8081` after any unplug).

**Steps**

- [ ] Full suites both sides: `cd /home/tdpotato/projects/InventoryPro/apps/api && pnpm test` (all green, count ≥ current 252) and `cd /home/tdpotato/projects/InventoryPro/apps/mobile && pnpm test && pnpm exec tsc --noEmit`.
- [ ] Confirm no phase-boundary violations: `git diff main --stat -- '*migrations*'` shows NO new Phase-B migrations, and `grep -rn "unit_access_defaults" apps/api/src/db` is empty (the key is runtime-written; no seeded row, so the incremental-pull watermark gotcha is moot for this phase).
- [ ] Hotload the dev APK per project CLAUDE.md (deploy-android §B — dev client already installed; `adb reverse tcp:8081 tcp:8081` first) and walk through on device:
  1. Settings → Unit Access Defaults: toggle Mitigation Technician to view+add+remove only; kill nothing, open a second device/web → change appears without remount (reactivity check).
  2. Teams tab → member row → Perms: sheet shows team overrides AND unit grants; grant a locker to a mitigation tech → new grant shows view/add/remove ON, move/editDetails/grant OFF (defaults applied); flip one action; revoke.
  3. As a non-owner crew login, craft nothing — just confirm the Perms sheet hides editing on units they can't manage, and a PM login can edit any unit's grants.
  4. Dashboards → edit a preset assigned to a crew role → add-widget picker omits admin tiles and shows the hidden-count note; unassign the role → all tiles return.
  5. Sync dot stays clean (no wedged outbox entries — permanent-rejection wording verified in Task 2 tests).
- [ ] Update the board (`board` skill): move the Phase B item to In review with a comment linking the commits; per project convention it only moves past In review after this device walkthrough passes.


# Phase B2 — Per-role dashboard preset picker (board #136)

## Feature: Per-role dashboard preset selector on Roles & Permissions

The data model (migration 039), sync policy columns, server tier guard, mobile resolution (`resolve.ts`/`store.ts`), and even the write helper `setRoleDashboardPreset()` already exist. This section is UI wiring + reactivity + regression tests only. **No new migrations, no API production code changes.**

### Task 1: Pure preset-options helper (TDD)

**Files**
- Create: `apps/mobile/src/dashboard/presetOptions.ts`
- Test: `apps/mobile/src/dashboard/presetOptions.test.ts`

**Interfaces**
- Consumes: `DashboardPreset` (type-only import from `apps/mobile/src/db/queries/dashboards.ts` — `{ id: string; name: string; layout: string; active: number; updated_at: string }`)
- Produces: `export function dashboardPresetOptions(presets: DashboardPreset[], assignedId: string | null): PresetOption[]` where `export interface PresetOption { id: string; label: string; sublabel?: string }` (structurally compatible with `SelectOption` in `apps/mobile/src/components/ui/SelectField.tsx`)

**Steps**

- [ ] Write the failing test first (`apps/mobile/src/dashboard/presetOptions.test.ts`, node:test pattern copied from sibling `store.test.ts` — do NOT import `store.ts` or the query module at runtime; they pull in op-sqlite):
  ```ts
  import { test } from 'node:test';
  import assert from 'node:assert/strict';
  import { dashboardPresetOptions } from './presetOptions';
  import type { DashboardPreset } from '../db/queries/dashboards';

  const p = (id: string, name: string, active: number): DashboardPreset =>
    ({ id, name, layout: '[]', active, updated_at: '2026-07-19T00:00:00.000Z' });

  test('lists only active presets when nothing is assigned', () => {
    assert.deepEqual(
      dashboardPresetOptions([p('a', 'Crew', 1), p('b', 'Office', 0)], null),
      [{ id: 'a', label: 'Crew' }],
    );
  });

  test('keeps the assigned-but-deactivated preset, marked inactive', () => {
    assert.deepEqual(
      dashboardPresetOptions([p('a', 'Crew', 1), p('b', 'Office', 0)], 'b'),
      [{ id: 'a', label: 'Crew' }, { id: 'b', label: 'Office', sublabel: 'inactive' }],
    );
  });

  test('empty preset list → empty options (SelectField shows only Default via placeholder)', () => {
    assert.deepEqual(dashboardPresetOptions([], null), []);
  });
  ```
- [ ] Run it and confirm it fails for the right reason (module not found): `cd /home/tdpotato/projects/InventoryPro/apps/mobile && npm test 2>&1 | grep -A3 presetOptions`
- [ ] Implement `apps/mobile/src/dashboard/presetOptions.ts` (type-only import keeps it DB-free/unit-testable, same idiom as `resolve.ts`):
  ```ts
  import type { DashboardPreset } from '../db/queries/dashboards';

  export interface PresetOption { id: string; label: string; sublabel?: string }

  // Options for the per-role dashboard SelectField on the Roles & Permissions
  // screen: every ACTIVE preset (getDashboardPresets already name-sorts), plus
  // the currently-assigned preset even if deactivated — marked 'inactive' so the
  // field never hides a live assignment. The "Default" (null) choice is NOT an
  // option row; it's the SelectField placeholder + Clear row.
  export function dashboardPresetOptions(
    presets: DashboardPreset[],
    assignedId: string | null,
  ): PresetOption[] {
    return presets
      .filter(x => x.active === 1 || x.id === assignedId)
      .map(x => x.active === 1
        ? { id: x.id, label: x.name }
        : { id: x.id, label: x.name, sublabel: 'inactive' });
  }
  ```
- [ ] Green: `cd /home/tdpotato/projects/InventoryPro/apps/mobile && npm test` (full suite green, +3 tests over whatever the pre-task count is — Phases A1/A2/B have grown the suite well past the old 174 baseline, so never gate on absolute totals)
- [ ] Commit:
  ```bash
  cd /home/tdpotato/projects/InventoryPro && git add apps/mobile/src/dashboard/presetOptions.ts apps/mobile/src/dashboard/presetOptions.test.ts && git commit -m "feat(mobile): dashboardPresetOptions helper for role preset selector"
  ```

### Task 2: SelectField per role in the Roles & Permissions screen + reactive cache wiring

**Files**
- Modify: `apps/mobile/app/(app)/(admin)/roles.tsx`
- Modify: `apps/mobile/app/(app)/(admin)/dashboards.tsx` (1-line latent-bug fix: `assignRole` never notifies the dashboard store)
- Test: covered by Task 1 unit tests + `npx tsc --noEmit` + Task 4 device verification (no RN component-test infra exists in this repo)

**Interfaces**
- Consumes: `setRoleDashboardPreset(role: string, presetId: string | null): string` and `getRoleDashboardPresetIds(): Record<string, string | null>` and `getDashboardPresets(): DashboardPreset[]` (all already in `apps/mobile/src/db/queries/dashboards.ts` — **`setRoleDashboardPreset` already appends the `role_settings` outbox UPDATE internally; do NOT call `appendOutbox` again or the row double-syncs**, same trap as `setRolePermission`); `loadDashboardCache(): void` from `apps/mobile/src/dashboard/store.ts`; `SelectField` (`value: string | null`, `options: SelectOption[]`, `onSelect(id)`, `onClear?`, `placeholder?`, `disabled?`) from `apps/mobile/src/components/ui/SelectField.tsx`; existing screen guards `canManage` / `locked` / `canActThisRole` (`canActOnTarget` mirror of the server tier guard).
- Produces: `changeRolePreset(role: UserRole, presetId: string | null): void` inside `RolesScreen`.

**Steps**

- [ ] Add imports to `apps/mobile/app/(app)/(admin)/roles.tsx`:
  ```tsx
  import {
    getDashboardPresets, getRoleDashboardPresetIds, setRoleDashboardPreset,
  } from '../../../src/db/queries/dashboards';
  import { loadDashboardCache } from '../../../src/dashboard/store';
  import { dashboardPresetOptions } from '../../../src/dashboard/presetOptions';
  import { SelectField } from '../../../src/components/ui/SelectField';
  ```
- [ ] Add state next to the existing `roleColors` state (lazy initializers, same pattern):
  ```tsx
  const [rolePresets, setRolePresets] = useState<Record<string, string | null>>(() => getRoleDashboardPresetIds());
  const [presets] = useState(() => getDashboardPresets());
  ```
- [ ] Add the handler, modeled exactly on `changeRoleColor` (transaction + log + post-commit refresh) but ending with the **reactive-cache notify** — this is the gotcha that has bitten before (see `loadRolePermissionCache` precedent; `useDashboardLayout` subscribes via `useSyncExternalStore`, so this one call makes every mounted dashboard of that role re-resolve without remount):
  ```tsx
  function changeRolePreset(role: UserRole, presetId: string | null) {
    if (!canManage) return;
    if (isWriteBlocked()) return;
    const presetName = presetId ? (presets.find(x => x.id === presetId)?.name ?? presetId) : 'default';
    try {
      // Write + log land atomically. setRoleDashboardPreset already mirrors the
      // role_settings UPDATE to the sync outbox internally (see queries/dashboards.ts)
      // — do NOT appendOutbox here or the row double-syncs.
      runInTransaction(() => {
        setRoleDashboardPreset(role, presetId);
        appendLog({
          action: 'role_dashboard_preset_changed',
          entity_type: 'role_settings',
          // Role keys aren't UUIDs — entity_id must stay null (see role_permission_changed above).
          entity_id: null,
          user_id: sessionUser?.id ?? null,
          note: `${role} dashboard → ${presetName}`,
          team_id: null, from_location_id: null, to_location_id: null,
          quantity: null, unit: null, job_id: null, metadata: JSON.stringify({ role }), device_id: null,
        });
      });
    } catch (e) {
      Alert.alert(
        'Could not change dashboard preset',
        e instanceof Error ? e.message : 'The change was not saved. Please try again.'
      );
      return;
    }
    setRolePresets(getRoleDashboardPresetIds()); // refresh this screen's map
    loadDashboardCache(); // notify subscribers → affected dashboards re-render live (no remount)
  }
  ```
- [ ] Render the selector inside the expanded card, between the color section and the permission matrix (after the `{isOpen && (() => { ... color ... })()}` block), disabled under the same three guards as every other control on the card:
  ```tsx
  {/* Per-role dashboard preset (users.dashboard_preset_id overrides win; NULL → built-in default) */}
  {isOpen && (
    <View style={s.presetSection}>
      <SelectField
        label="Dashboard preset"
        hint="The dashboard this role sees. Per-user assignments override it."
        placeholder="Default"
        value={rolePresets[role] ?? null}
        options={dashboardPresetOptions(presets, rolePresets[role] ?? null)}
        onSelect={(id) => changeRolePreset(role, id)}
        onClear={rolePresets[role] ? () => changeRolePreset(role, null) : undefined}
        disabled={!canManage || locked || !canActThisRole}
      />
    </View>
  )}
  ```
  and add to `makeStyles`: `presetSection: { paddingHorizontal: t.spacing.base, paddingBottom: t.spacing.sm },`
- [ ] Fix the same reactivity gap in the existing assignment surface — in `apps/mobile/app/(app)/(admin)/dashboards.tsx` `assignRole()` (line ~266), add `loadDashboardCache();` after `setRoleMap(getRoleDashboardPresetIds());` (import `loadDashboardCache` from `../../../src/dashboard/store`). Today that screen writes the row but never notifies subscribers, so the admin's own dashboard doesn't update until the next sync pull.
- [ ] Verify types + suite: `cd /home/tdpotato/projects/InventoryPro/apps/mobile && npx tsc --noEmit && npm test`
- [ ] Commit:
  ```bash
  cd /home/tdpotato/projects/InventoryPro && git add "apps/mobile/app/(app)/(admin)/roles.tsx" "apps/mobile/app/(app)/(admin)/dashboards.tsx" && git commit -m "feat(mobile): per-role dashboard preset selector on Roles & Permissions; notify dashboard store on assignment"
  ```

### Task 3: API regression tests — role preset assignment rides the existing role_settings guards

Server enforcement already exists and needs no changes: `/sync/push` gates `role_settings` on `manage_roles_permissions` (`PRIVILEGED_TABLE_PERM`, `apps/api/src/routes/sync.ts:66` — the `role_settings: 'manage_roles_permissions'` entry two lines below) + the `canActOnTarget` tier guard (`sync.ts:841`), and `dashboard_preset_id` is already in `ROLE_SETTINGS_COLS` (`apps/api/src/lib/syncPolicy.ts:432`). These tests pin that behavior so it can't regress.

**Files**
- Test: `apps/api/src/routes/sync-guards.test.ts` (existing fake-pg harness; `callerRole` opt + `push()` helper already there)
- Test: `apps/api/src/lib/syncPolicy.test.ts` (one projection assertion)

**Interfaces**
- Consumes: existing `fakePg({ callerRole })`, `push(pg, entries)` → `{ ok: string[]; conflicts: { id: string; error: string }[] }`, `PERMANENT = /forbidden|cannot|not allowed/i`, `COLUMNS` map; `selectColumnsFor(table: string, canViewFinancial: boolean): string` from `apps/api/src/lib/syncPolicy.ts`.
- Produces: three new tests, zero production changes.

**Steps**

- [ ] In `sync-guards.test.ts`, add the table to the boot-time introspection map `COLUMNS` (without this, `keepRealColumns` drops every column and the write can't be exercised):
  ```ts
  role_settings: ['role', 'min_pin_length', 'permission_overrides', 'color', 'dashboard_preset_id', 'updated_at'],
  ```
- [ ] Add the tier-guard regression pair (franchise_manager is tier 4 with `manage_roles_permissions`, but only apex `full_admin` may touch the `full_admin` row — exact server rule in `sync.ts:846`):
  ```ts
  // ── role dashboard presets: assignment is a role_settings write → existing guards apply ──

  test('role_settings: dashboard_preset_id on a role above the caller is a permanent rejection', async () => {
    const pg = fakePg({ callerRole: 'franchise_manager' });
    const body = await push(pg, [
      { operation: 'UPDATE', table_name: 'role_settings', payload: { role: 'full_admin', dashboard_preset_id: 'preset-1', updated_at: NOW } },
    ]);
    assert.deepEqual(body.ok, []);
    assert.match(body.conflicts[0].error, PERMANENT);
    assert.ok(!pg.queries.some(q => q.sql.includes('INSERT INTO role_settings')), 'the write must never reach SQL');
  });

  test('role_settings: a manage_roles_permissions holder may assign a preset to a role below them', async () => {
    const pg = fakePg({ callerRole: 'franchise_manager' });
    const body = await push(pg, [
      { operation: 'UPDATE', table_name: 'role_settings', payload: { role: 'hr_manager', dashboard_preset_id: 'preset-1', updated_at: NOW } },
    ]);
    assert.deepEqual(body.ok, ['e1']);
    assert.ok(pg.queries.some(q => /role_settings/.test(q.sql) && q.params.includes('preset-1')), 'dashboard_preset_id must survive the column policy');
  });
  ```
- [ ] In `syncPolicy.test.ts`, pin the pull projection so the assignment always syncs down to every device:
  ```ts
  test('role_settings projection carries dashboard_preset_id (role assignment syncs to all devices)', () => {
    assert.match(selectColumnsFor('role_settings', false), /dashboard_preset_id/);
  });
  ```
- [ ] Run: `cd /home/tdpotato/projects/InventoryPro/apps/api && npm test` (full suite green, +3 tests over whatever the pre-task count is — earlier phases have grown the suite past the old 252 baseline, so don't gate on absolute totals; these are characterization tests of existing enforcement). If the tier-guard rejection test FAILS, stop: that is a real server hole — do not weaken the test.
- [ ] Commit:
  ```bash
  cd /home/tdpotato/projects/InventoryPro && git add apps/api/src/routes/sync-guards.test.ts apps/api/src/lib/syncPolicy.test.ts && git commit -m "test(api): pin role_settings guards + projection for dashboard_preset_id assignment"
  ```

### Task 4: Hotload + on-device verification

**Files**
- None (verification only; per project instructions, hotload the dev client after the phase)

**Interfaces**
- Consumes: existing debug dev-client on the phone + Metro (memory: `project_inventorypro_dev_hotload.md` — NO `CI=1`, use `--clear`; "failed to load bundle" usually means the `adb reverse` was dropped).

**Steps**

- [ ] Re-establish the USB tunnel first (the usual failure), then start Metro:
  ```bash
  adb reverse tcp:8081 tcp:8081
  cd /home/tdpotato/projects/InventoryPro/apps/mobile && npx expo start --dev-client --clear
  ```
- [ ] On device (do not blind-tap — describe each screen before acting): as a full_admin, open Admin → Roles & Permissions, expand a tier-1 role (e.g. Carpet Cleaning Crew), verify the "Dashboard preset" SelectField shows "Default" and lists only active presets; pick a preset created under Admin → Dashboards.
- [ ] Reactivity check (the core acceptance): with a second device/user logged in under that role (or by switching to a test user of that role on the same device WITHOUT killing the app), confirm the hub re-renders to the preset layout after the sync pull lands — no remount/restart. Then set the selector back to "Default" and confirm the hub reverts live.
- [ ] Guard check: as a tier-3 user holding `manage_roles_permissions` (grant temporarily if needed), confirm the selector is disabled on tier-4 role cards (lock note shows) and enabled below.
- [ ] Confirm no stuck outbox: tap the sync dot — pending should drain to 0 (a permanent `role_settings` rejection here means the server guard fired; investigate, don't retry-loop).
- [ ] Move the board card for this feature to Done via the `board` skill scripts once verified.


# Phase C — On-call rotation + coverage (board #134)

## Phase C — On-call: settings, rotation, coverage, `on_call` channel

> Files verified against branch `feat/field-crew-122` @ 0691366. Mobile migration numbering assumes Phase A1 has landed 045–047 (this phase adds ONLY 048). API on-call table shipped as `056_on_call.sql`; this phase adds ONLY `060_on_call_coverage.sql`.

### Task 1: Boundary-aware week math + deterministic rotation index (pure, TDD)

**Files**
- Modify: `apps/mobile/src/components/oncall/weekMath.ts`
- Test: `apps/mobile/src/components/oncall/weekMath.test.ts`

**Interfaces**
- Consumes: existing `weekStartIso(dateIso, weekStartsOn)`, `addDaysIso(dateIso, days)` (same file; keep them unchanged — callers across #128 depend on them).
- Produces:
  - `export interface WeekBoundary { day: WeekStartsOn; hour: number }`
  - `export const DEFAULT_WEEK_BOUNDARY: WeekBoundary = { day: 4, hour: 8 }` (Thursday 08:00)
  - `export function parseWeekBoundary(raw: string | null): WeekBoundary`
  - `export function boundaryWeekStartIso(dateIso: string, hourOfDay: number, b: WeekBoundary): string`
  - `export function rotationIndexForWeek(weekStartIso: string, rotationLength: number): number`

**Steps**
- [ ] Append failing tests to `apps/mobile/src/components/oncall/weekMath.test.ts` (file stays pure `node:test`, no RN imports):
  ```ts
  import { parseWeekBoundary, boundaryWeekStartIso, rotationIndexForWeek, DEFAULT_WEEK_BOUNDARY } from './weekMath';

  test('parseWeekBoundary: null/malformed/out-of-range → Thursday 08:00 default', () => {
    assert.deepEqual(parseWeekBoundary(null), { day: 4, hour: 8 });
    assert.deepEqual(parseWeekBoundary('not json'), { day: 4, hour: 8 });
    assert.deepEqual(parseWeekBoundary('{"day":9,"hour":-1}'), { day: 4, hour: 8 });
    assert.deepEqual(parseWeekBoundary('{"day":1,"hour":0}'), { day: 1, hour: 0 });
  });

  test('boundaryWeekStartIso: mid-week date maps to its Thursday', () => {
    // 2026-07-18 is a Saturday; the Thursday of that boundary week is 2026-07-16
    assert.equal(boundaryWeekStartIso('2026-07-18', 12, DEFAULT_WEEK_BOUNDARY), '2026-07-16');
    // Wednesday belongs to the PREVIOUS Thursday-start week
    assert.equal(boundaryWeekStartIso('2026-07-15', 12, DEFAULT_WEEK_BOUNDARY), '2026-07-09');
  });

  test('boundaryWeekStartIso: on the boundary day, the hour decides the week', () => {
    // Thursday 2026-07-16 at 07:59 → still last week; at 08:00 → new week
    assert.equal(boundaryWeekStartIso('2026-07-16', 7, DEFAULT_WEEK_BOUNDARY), '2026-07-09');
    assert.equal(boundaryWeekStartIso('2026-07-16', 8, DEFAULT_WEEK_BOUNDARY), '2026-07-16');
  });

  test('boundaryWeekStartIso: Monday boundary at hour 0 degrades to plain weekStartIso', () => {
    assert.equal(boundaryWeekStartIso('2026-07-13', 0, { day: 1, hour: 0 }), '2026-07-13');
    assert.equal(boundaryWeekStartIso('2026-07-19', 23, { day: 1, hour: 0 }), '2026-07-13');
  });

  test('rotationIndexForWeek: consecutive weeks get consecutive indices mod length', () => {
    const i0 = rotationIndexForWeek('2026-07-16', 3);
    assert.equal(rotationIndexForWeek('2026-07-23', 3), (i0 + 1) % 3);
    assert.equal(rotationIndexForWeek('2026-07-30', 3), (i0 + 2) % 3);
    assert.equal(rotationIndexForWeek('2026-08-06', 3), i0); // full cycle
  });

  test('rotationIndexForWeek: deterministic (calendar-anchored) and safe on length<=0', () => {
    assert.equal(rotationIndexForWeek('2026-07-16', 2), rotationIndexForWeek('2026-07-16', 2));
    assert.equal(rotationIndexForWeek('2026-07-16', 0), 0);
  });
  ```
- [ ] Run and watch them fail: `cd /home/tdpotato/projects/InventoryPro/apps/mobile && node --import tsx --import ./src/test/setupGlobals.mjs --test src/components/oncall/weekMath.test.ts`
- [ ] Implement in `weekMath.ts` (below `weekStartIso`; keep the file free of React/DB imports — the `node --test` constraint documented in its header):
  ```ts
  /** Admin-configured week boundary: day-of-week (0=Sun…6=Sat) + local hour (0–23). */
  export interface WeekBoundary { day: WeekStartsOn; hour: number }

  /** Default per spec: on-call weeks flip Thursday 08:00 local. */
  export const DEFAULT_WEEK_BOUNDARY: WeekBoundary = { day: 4, hour: 8 };

  /** Tolerant parse of the app_config 'on_call_week_boundary' JSON. */
  export function parseWeekBoundary(raw: string | null): WeekBoundary {
    if (!raw) return DEFAULT_WEEK_BOUNDARY;
    try {
      const p = JSON.parse(raw) as { day?: unknown; hour?: unknown };
      const day = Number(p.day);
      const hour = Number(p.hour);
      return {
        day: (Number.isInteger(day) && day >= 0 && day <= 6 ? day : DEFAULT_WEEK_BOUNDARY.day) as WeekStartsOn,
        hour: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : DEFAULT_WEEK_BOUNDARY.hour,
      };
    } catch {
      return DEFAULT_WEEK_BOUNDARY;
    }
  }

  /**
   * Start date of the boundary week containing the local instant
   * (dateIso, hourOfDay). On the boundary day itself, hours BEFORE b.hour
   * still belong to the previous week.
   */
  export function boundaryWeekStartIso(dateIso: string, hourOfDay: number, b: WeekBoundary): string {
    const base = weekStartIso(dateIso, b.day);
    return base === dateIso && hourOfDay < b.hour ? addDaysIso(base, -7) : base;
  }

  /**
   * Calendar-anchored rotation slot for a week: floor(epochDays/7) mod length.
   * Purely a function of the week date, so every device fills the SAME crew for
   * the same week (offline double-fill converges via the week_start upsert) and
   * a manual override of one week never shifts the others.
   */
  export function rotationIndexForWeek(weekStartIso: string, rotationLength: number): number {
    if (rotationLength <= 0) return 0;
    const days = Math.round(toUtcDate(weekStartIso).getTime() / DAY_MS);
    const weekNo = Math.floor(days / 7);
    return ((weekNo % rotationLength) + rotationLength) % rotationLength;
  }
  ```
- [ ] Re-run the test file → all pass. Then full mobile suite: `pnpm test` in `apps/mobile`.
- [ ] Commit: `git add apps/mobile/src/components/oncall/weekMath.ts apps/mobile/src/components/oncall/weekMath.test.ts && git commit -m "feat(#122/C): boundary-aware week math + rotation index (weekMath)"`

### Task 2: Migrations — `on_call_coverage` table, config seeds, week-start re-key

**Files**
- Create: `apps/api/src/db/migrations/060_on_call_coverage.sql`
- Create: `apps/mobile/src/db/migrations/048_on_call_coverage.ts`
- Modify: `apps/mobile/src/db/schema.ts` (migration import array)
- Modify: `apps/mobile/src/db/schema.web.ts` (its OWN import array — web never runs the migration otherwise)

**Interfaces**
- Produces: table `on_call_coverage(id, date_start, date_end, user_off, covering_user, note, created_by, created_at)` on both sides (+ server `updated_at`, mobile `updated_at`/`synced_at` — required by the incremental-pull watermark and outbox machinery; the pinned column names are unchanged). Seeds `app_config` keys `on_call_week_boundary` = `{"day":4,"hour":8}` and `on_call_rotation` = `[]`. Re-keys existing Monday-keyed `on_call_shifts.week_start` to the Thursday boundary date.

**Steps**
- [ ] Write `apps/api/src/db/migrations/060_on_call_coverage.sql` (NO Postgres ENUMs — TEXT only; dates are TEXT `YYYY-MM-DD` to match `week_start`'s string-compare convention):
  ```sql
  -- Migration 060: on-call coverage/time-off (#122 Phase C). Mirrors mobile 048.
  -- Coverage rows are PM-authored ("X is covering for Y from A to B"); dates are
  -- TEXT ISO yyyy-mm-dd (string-comparable, the week_start convention). user_off/
  -- covering_user are soft FKs to users (sync-order-safe, no constraint).
  CREATE TABLE IF NOT EXISTS on_call_coverage (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    date_start    TEXT NOT NULL,
    date_end      TEXT NOT NULL,
    user_off      UUID,
    covering_user UUID,
    note          TEXT,
    created_by    UUID,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  -- Settings defaults (admin-editable via the synced app_config path). updated_at
  -- is NOW() so already-enrolled devices receive the seeds via incremental pull
  -- (the migration-seeded-rows watermark gotcha).
  INSERT INTO app_config (key, value, updated_at) VALUES
    ('on_call_week_boundary', '{"day":4,"hour":8}', NOW()),
    ('on_call_rotation', '[]', NOW())
  ON CONFLICT (key) DO NOTHING;

  -- Re-key existing Monday-keyed shifts to the Thursday-boundary week that
  -- CONTAINS that Monday (Monday minus 4 days = the preceding Thursday). A
  -- constant shift preserves UNIQUE(week_start). Guarded to DOW=1 so the
  -- statement is a no-op on already-boundary-keyed rows. updated_at bumps so
  -- enrolled devices pull the re-keyed rows.
  UPDATE on_call_shifts
     SET week_start = to_char(week_start::date - 4, 'YYYY-MM-DD'),
         updated_at = NOW()
   WHERE EXTRACT(DOW FROM week_start::date) = 1;
  ```
- [ ] Write `apps/mobile/src/db/migrations/048_on_call_coverage.ts`:
  ```ts
  import type { SqlDb } from '../types';

  // Migration 048: on-call coverage/time-off (#122 Phase C). Mirrors API 060.
  // Also re-keys existing Monday-keyed on_call_shifts to the Thursday boundary
  // (guarded to %w='1' so rows already re-keyed via pull are untouched).
  export const migration = {
    version: 48,
    up: (db: SqlDb): void => {
      db.executeSync(`CREATE TABLE IF NOT EXISTS on_call_coverage (
        id TEXT PRIMARY KEY,
        date_start TEXT NOT NULL,
        date_end TEXT NOT NULL,
        user_off TEXT,
        covering_user TEXT,
        note TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        synced_at TEXT
      )`);
      db.executeSync(
        `UPDATE on_call_shifts SET week_start = date(week_start, '-4 days')
          WHERE strftime('%w', week_start) = '1'`,
      );
    },
  };
  ```
- [ ] Register in BOTH schema files (after Phase A1's `m047` line):
  - `apps/mobile/src/db/schema.ts`: add `const { migration: m048 } = await import('./migrations/048_on_call_coverage');` and append `m048` to the migrations array.
  - `apps/mobile/src/db/schema.web.ts`: same two edits in ITS import array.
- [ ] Verify: `cd /home/tdpotato/projects/InventoryPro/apps/api && npx tsc --noEmit && pnpm test` (migration runner picks up `060_*.sql` from `src/db/migrations` by filename — no registration needed), and `cd ../mobile && npx tsc --noEmit && pnpm test`.
- [ ] Commit: `git add apps/api/src/db/migrations/060_on_call_coverage.sql apps/mobile/src/db/migrations/048_on_call_coverage.ts apps/mobile/src/db/schema.ts apps/mobile/src/db/schema.web.ts && git commit -m "feat(#122/C): on_call_coverage migrations (API 060 / mobile 048) + boundary re-key + config seeds"`

### Task 3: API sync policy + push/pull plumbing for `on_call_coverage` (TDD)

**Files**
- Modify: `apps/api/src/lib/syncPolicy.ts`
- Modify: `apps/api/src/routes/sync.ts`
- Test: `apps/api/src/lib/syncPolicy.test.ts`

**Interfaces**
- Consumes: `requiredOperationPerm(table, op)`, `applyWritePolicy(...)`, `selectColumnsFor(table, canViewFinancial)`, `isAllowedActivity(action, entityType)` (all existing exports of `syncPolicy.ts`).
- Produces: `on_call_coverage` allowed through generic sync, gated `manage_teams` for INSERT/UPDATE/DELETE, `created_by` attribution-forced, explicit pull projection, and `on_call_coverage_added` in the activity allowlist.

**Steps**
- [ ] Add failing tests to `apps/api/src/lib/syncPolicy.test.ts` (follow its existing `test(...)` style):
  ```ts
  test('on_call_coverage: all ops gated on manage_teams', () => {
    assert.equal(requiredOperationPerm('on_call_coverage', 'INSERT'), 'manage_teams');
    assert.equal(requiredOperationPerm('on_call_coverage', 'UPDATE'), 'manage_teams');
    assert.equal(requiredOperationPerm('on_call_coverage', 'DELETE'), 'manage_teams');
  });

  test('on_call_coverage: created_by is attribution-forced to the caller', () => {
    const realColumns = new Map([[ 'on_call_coverage', new Set(['id','date_start','date_end','user_off','covering_user','note','created_by','created_at','updated_at']) ]]);
    const { row } = applyWritePolicy('on_call_coverage', 'INSERT',
      { id: 'c1', date_start: '2026-07-20', date_end: '2026-07-22', user_off: 'u1', covering_user: 'u2', created_by: 'forged' },
      'caller-1', realColumns, () => true);
    assert.equal(row.created_by, 'caller-1');
  });

  test('on_call_coverage: explicit pull projection, never *', () => {
    assert.equal(selectColumnsFor('on_call_coverage', false),
      'id, date_start, date_end, user_off, covering_user, note, created_by, created_at, updated_at');
  });

  test('on_call_coverage_added is an allowed activity against team', () => {
    assert.equal(isAllowedActivity('on_call_coverage_added', 'team'), true);
  });
  ```
  Run: `cd /home/tdpotato/projects/InventoryPro/apps/api && node --import tsx --test src/lib/syncPolicy.test.ts` → fails.
- [ ] Implement in `apps/api/src/lib/syncPolicy.ts`:
  - `ATTRIBUTION_COLUMNS`: add `on_call_coverage: ['created_by'],` under the existing `on_call_shifts: ['created_by'],` line.
  - `OPERATION_PERM`: add under `on_call_shifts`:
    ```ts
    // Coverage rows change who is effectively on call → same roster gate.
    on_call_coverage:          { INSERT: 'manage_teams', UPDATE: 'manage_teams', DELETE: 'manage_teams' },
    ```
  - Column list + projection:
    ```ts
    const ON_CALL_COVERAGE_COLS = 'id, date_start, date_end, user_off, covering_user, note, created_by, created_at, updated_at';
    ```
    and in `selectColumnsFor`, after the `on_call_shifts` branch: `if (table === 'on_call_coverage') return ON_CALL_COVERAGE_COLS;`
  - `ACTIVITY_ACTIONS`: append `'on_call_coverage_added',` to the field-crew group (line with `'subteam_created', 'subteam_updated', 'on_call_assigned',`).
- [ ] Implement in `apps/api/src/routes/sync.ts`:
  - `ALLOWED_TABLES` (line ~52): APPEND `'on_call_coverage',` so the group reads `'locker_access', 'on_call_shifts', 'unit_access', 'on_call_coverage',` — `'unit_access'` has been on that line since Phase A1 Task 7; do NOT drop it (removing it would permanently reject every unit_access grant push).
  - The pull table list at line ~257 (same `'locker_access', 'on_call_shifts',` grouping): add `'on_call_coverage',`. No `CONFLICT_TARGETS` entry (default `id` is correct — coverage rows are id-keyed, unlike week-keyed shifts).
- [ ] Run `pnpm test` in `apps/api` → green.
- [ ] Commit: `git commit -am "feat(#122/C): on_call_coverage sync policy + push/pull plumbing (manage_teams-gated)"`

### Task 4: `on_call` notification channel + coverage fan-out (TDD)

**Files**
- Modify: `apps/api/src/lib/notifications.ts`
- Modify: `apps/api/src/routes/sync.ts` (INSERT hook in `applyEntry`)
- Modify: `apps/mobile/src/components/NotificationRoutingEditor.tsx` (admin routing UI gains the channel)
- Test: `apps/api/src/lib/notifications.test.ts`
- Test (modify): `apps/api/src/routes/sync-guards.test.ts` (route-level fan-out wiring test — the spec's Testing section requires the coverage fan-out exercised through `/sync/push`, not just the resolver units)

**Interfaces**
- Consumes: `resolveRoleRecipients`, `resolveRecipients`, `deliver`, `claimEvent`, `dedupKeys`, `getNotifyConfig` (existing, `apps/api/src/lib/notifications.ts`); `sendPush` fires transitively via `deliver` (`apps/api/src/lib/push.ts` — no changes needed there).
- Produces: channel key `'on_call'` (admin routing key `notify_route_on_call`), `dedupKeys.coverage(id)`, fire-and-forget fan-out on `on_call_coverage` INSERT.

**Steps**
- [ ] Add failing tests to `apps/api/src/lib/notifications.test.ts` (mocked-pg style already in the file):
  ```ts
  test('resolveRecipients on_call: other production managers, actor excluded', async () => {
    const pg = { query: async (sql: string, params: unknown[]) => {
      if (sql.includes('app_config')) return { rows: [] as any[] };
      if (sql.includes('FROM users WHERE role = ANY')) {
        assert.deepEqual(params[0], ['production_manager']);
        return { rows: [{ id: 'pm1' }, { id: 'pm2' }] };
      }
      if (sql.includes('id = ANY') && sql.includes('active = TRUE')) {
        return { rows: (params[0] as string[]).map(id => ({ id })) };
      }
      return { rows: [] as any[] };
    } };
    assert.deepEqual(await resolveRecipients(pg as any, 'on_call', { actorId: 'pm1' }), ['pm2']);
  });

  test('resolveRecipients on_call: unions notify_route_on_call users', async () => {
    const cfg = JSON.stringify({ roles: [], teams: [], users: ['boss1'] });
    const pg = { query: async (sql: string, params: unknown[]) => {
      if (sql.includes('app_config')) return { rows: [{ value: cfg }] };
      if (sql.includes('FROM users WHERE role = ANY')) return { rows: [{ id: 'pm2' }] };
      if (sql.includes('id = ANY') && sql.includes('active = TRUE')) {
        return { rows: (params[0] as string[]).map(id => ({ id })) };
      }
      return { rows: [] as any[] };
    } };
    assert.deepEqual((await resolveRecipients(pg as any, 'on_call', { actorId: 'pm1' })).sort(), ['boss1', 'pm2']);
  });

  test('dedupKeys.coverage is stable', () => {
    assert.equal(dedupKeys.coverage('c1'), 'oncall:coverage:c1');
  });
  ```
  Run `node --import tsx --test src/lib/notifications.test.ts` → fails (`'on_call'` is not a channel key yet — type error is the failure).
- [ ] Implement in `apps/api/src/lib/notifications.ts`:
  - `dedupKeys`: add `coverage: (id: string) => \`oncall:coverage:${id}\`,`.
  - `INTRINSIC`: add after `approvals`:
    ```ts
    // Coverage saves concern the PM bench: every other active production_manager
    // (the actor already knows — they wrote it). notify_route_on_call unions on top.
    on_call:       async (pg, ctx) => {
      const pms = await resolveRoleRecipients(pg, ['production_manager']);
      return ctx.actorId ? pms.filter(id => id !== ctx.actorId) : pms;
    },
    ```
- [ ] Implement the fan-out hook in `apps/api/src/routes/sync.ts`, inside `applyEntry` directly after the existing `approval_requests` notify block (line ~607), same fire-and-forget shape:
  ```ts
  // New coverage row → notify the other PMs + notify_route_on_call once
  // (deduped on the coverage id so a retried push doesn't re-notify).
  if (table_name === 'on_call_coverage' && row.id) {
    const covId = String(row.id);
    const dateStart = String(row.date_start ?? '');
    const dateEnd = String(row.date_end ?? '');
    const offId = row.user_off != null ? String(row.user_off) : null;
    const coverId = row.covering_user != null ? String(row.covering_user) : null;
    void (async () => {
      try {
        if (!(await getNotifyConfig(pg)).enabled) return;
        if (await claimEvent(pg, dedupKeys.coverage(covId))) {
          const { rows: nameRows } = await pg.query(
            `SELECT id, name FROM users WHERE id = ANY($1)`,
            [[offId, coverId].filter(Boolean)]);
          const nameOf = (id: string | null) =>
            (nameRows as { id: string; name: string }[]).find(r => String(r.id) === id)?.name ?? 'Someone';
          const to = await resolveRecipients(pg, 'on_call', { actorId: callerUserId });
          await deliver(pg, to, {
            type: 'on_call',
            title: 'On-call coverage',
            body: `${nameOf(coverId)} is covering for ${nameOf(offId)} (${dateStart} – ${dateEnd}).`,
            data: { screen: 'dashboard' },
            createdBy: callerUserId,
          });
        }
      } catch { /* never disrupt sync */ }
    })();
  }
  ```
- [ ] Route-level fan-out test in `apps/api/src/routes/sync-guards.test.ts` (without it, a wiring mistake in the `applyEntry` hook — wrong table check, `deliver` never called, swallowed error — passes the whole suite): push an `on_call_coverage` INSERT as a `manage_teams` caller (add `on_call_coverage: ['id', 'date_start', 'date_end', 'user_off', 'covering_user', 'note', 'created_by', 'created_at', 'updated_at']` to `COLUMNS` if Task 3 didn't). Extend `fakePg`'s dispatcher to answer the `getNotifyConfig` app_config read (enabled) and the PM roster query (`FROM users WHERE role = ANY` → two PM ids), let the fire-and-forget promise settle after the inject resolves (`await new Promise(r => setImmediate(r))` — verify first in `lib/notifications.ts` which tables `claimEvent` and `deliver` actually write and match on those), then assert `pg.queries` contains the claimEvent insert for `dedupKeys.coverage(<id>)` and a delivery write addressed to the resolved PM recipients.
- [ ] Surface the channel in the admin routing UI, `apps/mobile/src/components/NotificationRoutingEditor.tsx`:
  - `export type RoutingChannel = 'assignment' | 'low_stock' | 'checkout_idle' | 'approvals' | 'on_call';`
  - `CHANNELS` gains: `{ key: 'on_call', label: 'On-call coverage', note: 'Added to the other Production Managers.' },`
  (Persistence/write path is unchanged — the editor already writes `notify_route_<key>` via the synced `app_config` path.)
- [ ] `pnpm test` in `apps/api`; `npx tsc --noEmit` in `apps/mobile`.
- [ ] Commit: `git commit -am "feat(#122/C): 'on_call' notification channel + coverage fan-out (PMs + notify_route_on_call)"`

### Task 5: Mobile queries — boundary read, rotation auto-fill, coverage CRUD + pull wiring (TDD)

**Files**
- Modify: `apps/mobile/src/db/queries/oncall.ts`
- Modify: `apps/mobile/src/sync/pull.ts`
- Modify: `apps/mobile/src/sync/fullDownload.ts`
- Test: Create `apps/mobile/src/db/queries/oncall.test.ts`

**Interfaces**
- Consumes: `getAppConfig(key)` (`apps/mobile/src/db/appConfig.ts`), `parseWeekBoundary` / `boundaryWeekStartIso` / `rotationIndexForWeek` / `enumerateWeeks` / `addDaysIso` (Task 1), `appendOutbox`, `appendLog`, `runInTransaction`, `generateUUID` (already imported by `oncall.ts`).
- Produces (in `apps/mobile/src/db/queries/oncall.ts`):
  - `export function getWeekBoundary(): WeekBoundary`
  - `export function getRotation(): string[]`
  - `export const ROTATION_FILL_WEEKS = 9;` (current + 8 forward — matches `OnCallCalendar`'s `weeksForward` default)
  - `export function ensureRotationFill(todayIso: string, hourOfDay: number, userId: string | null): number` (returns rows inserted)
  - `export function getCurrentShift(todayIso: string, hourOfDay: number): OnCallShift | null` (SIGNATURE CHANGE — was Monday-only `getCurrentShift(todayIso)`)
  - `export interface CoverageRow { id: string; date_start: string; date_end: string; user_off: string | null; covering_user: string | null; note: string | null; created_by: string | null; created_at: string; updated_at: string; synced_at: string | null; user_off_name: string | null; covering_user_name: string | null }`
  - `export function getCoverage(fromIso: string, toIso: string): CoverageRow[]` (rows overlapping the range, ascending `date_start`)
  - `export function createCoverage(input: { dateStart: string; dateEnd: string; userOff: string; coveringUser: string; note: string | null; createdBy: string | null }): string` (returns new id)

**Steps**
- [ ] Create `apps/mobile/src/db/queries/oncall.test.ts` using the `chat.test.ts` harness verbatim (the `Module._load` redirect of `db/schema` → `locationsShelf.testdb`, `react-native-get-random-values` → `{}`, `telemetry` → `{ track() {} }`; dynamic-import `./oncall` after the hook). In `before()`, after `initTestDb()`, create the on-call tables (mirror mobile migrations 044 + 048 DDL exactly) plus `subteams`, `teams`, `users`, `app_config`:
  ```ts
  exec(`
    CREATE TABLE on_call_shifts (
      id TEXT PRIMARY KEY, subteam_id TEXT, week_start TEXT NOT NULL UNIQUE,
      created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, synced_at TEXT
    );
    CREATE TABLE on_call_coverage (
      id TEXT PRIMARY KEY, date_start TEXT NOT NULL, date_end TEXT NOT NULL,
      user_off TEXT, covering_user TEXT, note TEXT, created_by TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, synced_at TEXT
    );
    CREATE TABLE subteams (id TEXT PRIMARY KEY, team_id TEXT, name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT, updated_at TEXT, synced_at TEXT);
    CREATE TABLE teams (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE app_config (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
  `);
  ```
  Tests (write first, watch fail):
  1. `ensureRotationFill` with rotation `[A, B]` and boundary `{"day":4,"hour":8}` seeded into `app_config` fills exactly `ROTATION_FILL_WEEKS` Thursday-keyed weeks, alternating crews per `rotationIndexForWeek`; a second call inserts 0 (idempotent); every insert queued an outbox `INSERT` on `on_call_shifts`.
  2. Sticky override: pre-assign one mid-range week to crew B via `assignWeek(week, B, 'u1')`, then fill → that week stays B and every OTHER week matches the deterministic rotation slot (no shifting).
  3. Empty/absent `on_call_rotation` → `ensureRotationFill` returns 0 and writes nothing.
  4. `getCurrentShift('2026-07-16', 7)` returns the shift keyed `2026-07-09`; `getCurrentShift('2026-07-16', 9)` returns the one keyed `2026-07-16` (seed both rows directly).
  5. `createCoverage` inserts the row, queues an outbox `INSERT` on `on_call_coverage` with payload keys `id, date_start, date_end, user_off, covering_user, note, created_by, created_at, updated_at`, and appends an `activity_log` outbox entry with `action='on_call_coverage_added'`, `entity_type='team'`, `entity_id=null` (UUID-column trap: names/dates go in `note`/`metadata`, never `entity_id`). `getCoverage` range-overlap returns it.
- [ ] Implement in `apps/mobile/src/db/queries/oncall.ts` (import `parseWeekBoundary, boundaryWeekStartIso, rotationIndexForWeek, enumerateWeeks, type WeekBoundary` from `../../components/oncall/weekMath` and `getAppConfig` from `../appConfig`):
  ```ts
  export function getWeekBoundary(): WeekBoundary {
    return parseWeekBoundary(getAppConfig('on_call_week_boundary'));
  }

  export function getRotation(): string[] {
    try {
      const parsed = JSON.parse(getAppConfig('on_call_rotation') ?? '[]');
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
    } catch { return []; }
  }

  export const ROTATION_FILL_WEEKS = 9;

  // Materialize the rotation into on_call_shifts for the current + next 8
  // boundary weeks. Fills ONLY empty weeks (a manual assignWeek override is a
  // real row → sticky, and never shifts the rest: slots are calendar-anchored
  // via rotationIndexForWeek). Caller MUST hold manage_teams (server gate on
  // on_call_shifts INSERT) — gate at the call site. No activity log per row
  // (autofill is mechanical, not a user action).
  export function ensureRotationFill(todayIso: string, hourOfDay: number, userId: string | null): number {
    const rotation = getRotation();
    if (rotation.length === 0) return 0;
    const boundary = getWeekBoundary();
    const weeks = enumerateWeeks(
      boundaryWeekStartIso(todayIso, hourOfDay, boundary), ROTATION_FILL_WEEKS, boundary.day);
    const have = new Set(getShifts(weeks[0], weeks[weeks.length - 1]).map(s => s.week_start));
    const missing = weeks.filter(w => !have.has(w));
    if (missing.length === 0) return 0;
    const now = new Date().toISOString();
    runInTransaction(() => {
      for (const week of missing) {
        const id = generateUUID();
        const subteamId = rotation[rotationIndexForWeek(week, rotation.length)];
        getDb().executeSync(
          `INSERT OR REPLACE INTO on_call_shifts (id, subteam_id, week_start, created_by, created_at, updated_at, synced_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL)`,
          bindParams([id, subteamId, week, userId, now, now]),
        );
        appendOutbox('INSERT', 'on_call_shifts', {
          id, subteam_id: subteamId, week_start: week,
          created_by: userId, created_at: now, updated_at: now,
        });
      }
    });
    return missing.length;
  }
  ```
  Change `getCurrentShift` to `(todayIso: string, hourOfDay: number)` and replace its `[weekStartIso(todayIso)]` bind with `[boundaryWeekStartIso(todayIso, hourOfDay, getWeekBoundary())]` (drop the now-unused `weekStartIso` import if nothing else uses it). Add `getCoverage` (LEFT JOIN `users` twice for `user_off_name`/`covering_user_name`; `WHERE date_end >= ? AND date_start <= ? ORDER BY date_start ASC`) and `createCoverage` (INSERT + `appendOutbox('INSERT', 'on_call_coverage', {...})` + `appendLog({ action: 'on_call_coverage_added', entity_type: 'team', entity_id: null, ..., note: \`Coverage: ${coveringUser name lookup} for ${userOff name lookup}, ${dateStart} – ${dateEnd}\`, metadata: JSON.stringify({ coverage_id: id, date_start, date_end, user_off, covering_user }) })` — follow the `assignWeek` transaction shape).
- [ ] Wire pull, `apps/mobile/src/sync/pull.ts` (mirror the `on_call_shifts` entries at lines ~36/~71):
  ```ts
  on_call_coverage: `INSERT OR REPLACE INTO on_call_coverage (id, date_start, date_end, user_off, covering_user, note, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`,
  ```
  ```ts
  case 'on_call_coverage': return [row.id, row.date_start, row.date_end, row.user_off ?? null, row.covering_user ?? null, row.note ?? null, row.created_by ?? null, row.created_at, row.updated_at];
  ```
  (no pulled-tables list exists in `pull.ts` — `pullChanges` simply iterates the server response's tables against the upsert map, so these two edits are the complete client-side wiring; the pulled-tables list that contains `'on_call_shifts'` is the server-side `FULL_TABLES` in `apps/api/src/routes/sync.ts`, already extended by Task 3).
- [ ] Wire full download, `apps/mobile/src/sync/fullDownload.ts`: add `'on_call_coverage',` to the tables array (line ~32, after `'on_call_shifts'`) and add `case 'on_call_coverage':` into the generic-upsert case group (line ~157, next to `case 'on_call_shifts':`).
- [ ] Run: `cd /home/tdpotato/projects/InventoryPro/apps/mobile && node --import tsx --import ./src/test/setupGlobals.mjs --test src/db/queries/oncall.test.ts` → green; then full `pnpm test` + `npx tsc --noEmit`.
- [ ] Commit: `git add -A apps/mobile/src && git commit -m "feat(#122/C): rotation auto-fill + boundary-aware current shift + coverage queries/pull wiring"`

### Task 6: Replace Monday-only logic in the calendar + widget; trigger auto-fill

**Files**
- Modify: `apps/mobile/src/components/oncall/OnCallCalendar.tsx`
- Modify: `apps/mobile/src/components/oncall/OnCallWidget.tsx`

**Interfaces**
- Consumes: `getWeekBoundary`, `ensureRotationFill`, `getCurrentShift(todayIso, hourOfDay)` (Task 5); `boundaryWeekStartIso`, `enumerateWeeks`, `addDaysIso`, `formatWeekRange` (Task 1 / existing).
- Produces: `export function localNowHour(now: Date = new Date()): number` in `OnCallCalendar.tsx` (next to `localTodayIso` — local wall-clock hour, the boundary is a wall-clock concept).

**Steps**
- [ ] `OnCallCalendar.tsx`:
  - Add `export function localNowHour(now: Date = new Date()): number { return now.getHours(); }` under `localTodayIso`.
  - Subscribe to config changes: `const version = useTableVersion(['on_call_shifts', 'subteams', 'app_config']);` (boundary/rotation live in `app_config`; without this a synced settings change wouldn't re-render — the reactive-cache gotcha).
  - Replace the week enumeration:
    ```ts
    const today = localTodayIso();
    const hour = localNowHour();
    const boundary = useMemo(() => getWeekBoundary(), [version]);
    const currentWeek = boundaryWeekStartIso(today, hour, boundary);
    const weeks = useMemo(
      () => enumerateWeeks(addDaysIso(currentWeek, -7 * weeksBack), weeksBack + 1 + weeksForward, boundary.day),
      [currentWeek, weeksBack, weeksForward, boundary.day],
    );
    ```
  - Replace the highlight test `const current = isCurrentWeek(week, today);` with `const current = week === currentWeek;` (drop the `isCurrentWeek`/`weekStartIso` imports; on the boundary day before the flip hour, `isCurrentWeek`'s date-only window would highlight the wrong row).
  - Auto-fill on open, editors only (non-editors would get server `manage_teams` conflicts on push):
    ```ts
    useEffect(() => {
      if (!canEdit) return;
      if (ensureRotationFill(today, hour, user?.id ?? null) > 0) setLocalBump(v => v + 1);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [canEdit, today, version]);
    ```
- [ ] `OnCallWidget.tsx`: import `localNowHour` alongside `localTodayIso`; change the current-shift read to `getCurrentShift(today, localNowHour())`; add `'app_config'` to its `useTableVersion` list; change the sheet subtitle to use the boundary week: `Week of {formatWeekRange(boundaryWeekStartIso(today, localNowHour(), getWeekBoundary()))}` (imports from `./weekMath` / `../../db/queries/oncall`, replacing the `weekStartIso` import).
- [ ] `npx tsc --noEmit` in `apps/mobile`; `pnpm test` (weekMath + oncall suites stay green).
- [ ] Commit: `git commit -am "feat(#122/C): boundary-aware on-call calendar/widget + rotation auto-fill on open"`

### Task 7: PM-gated coverage form + upcoming-coverage list in the on-call popup

**Files**
- Create: `apps/mobile/src/components/oncall/CoverageSheet.tsx`
- Modify: `apps/mobile/src/components/oncall/OnCallWidget.tsx`

**Interfaces**
- Consumes: `FormSheet` (`../ui/FormSheet` — dirty-guard + busy/submit, the `AddServiceRecordSheet` pattern), `DateField` (`../ui/DateField`, props `{ label, value, onChange, min?, required? }`), `SelectField` (`../ui/SelectField`, `{ label, value, options, onSelect, required? }` — searchable auto-enables >12 options), `TextField`, `getAllActiveUsers` (`../../db/queries/users`), `createCoverage`/`getCoverage` (Task 5), `useSession`, `usePermission`, `isWriteBlocked` (`../../db/maintenance`), `ROLE_TIER, type UserRole` (`../../constants/roles`).
- Produces: `export function CoverageSheet({ visible, onClose }: { visible: boolean; onClose: () => void })`.

**Steps**
- [ ] Build `CoverageSheet.tsx` mirroring `apps/mobile/src/components/vehicles/AddServiceRecordSheet.tsx` structure exactly (state reset on `visible`, `dirty` calc, validation → `Alert.alert`, `FormSheet` wrapper):
  - Fields: `DateField label="First day off" value={dateStart} min={localTodayIso()} required`, `DateField label="Last day off" value={dateEnd} min={dateStart || localTodayIso()} required`, `SelectField label="Who is off" required value={userOff} options={users}`, `SelectField label="Covering person" required value={coveringUser} options={users}`, `TextField label="Note (optional)" multiline`.
  - `const users = useMemo<SelectOption[]>(() => getAllActiveUsers().map(u => ({ id: u.id, label: u.name })), []);`
  - `submit()`: guard `isWriteBlocked()`; require all four; reject `dateEnd < dateStart` (`Alert.alert('Invalid range', 'Last day must be on or after the first day.')`); reject `userOff === coveringUser`; then
    ```ts
    createCoverage({ dateStart, dateEnd, userOff, coveringUser, note: note.trim() || null, createdBy: user?.id ?? null });
    onClose();
    ```
- [ ] Wire into `OnCallWidget.tsx`'s existing `ModalSheet`:
  - Gate (spec: PM-gated — `manage_teams` AND Production Manager; PM is tier 2, so an explicit role check + tier-3+ org authority, matching B Task 1's privileged set — a plain `roleTier >= 2` would over-admit every tier-2 manager. Server enforces `manage_teams`; this is the UI shape of the spec's PM rule):
    ```ts
    const { user } = useSession();
    const roleTier = user ? ROLE_TIER[user.role as UserRole] ?? 0 : 0;
    const canCoverage = canEdit && (user?.role === 'production_manager' || roleTier >= 3);
    const [coverageOpen, setCoverageOpen] = useState(false);
    ```
  - Below `<OnCallCalendar …/>`: an "Upcoming coverage" section listing `getCoverage(today, addDaysIso(today, 60))` (memo on `[today, version, localBump]`, `useTableVersion` list gains `'on_call_coverage'`) — one row per entry: `{covering_user_name ?? 'Someone'} covers {user_off_name ?? 'someone'}` with `formatWeekRange`-free plain dates `({date_start} – {date_end})` and the note in muted text; empty → render nothing.
  - For `canCoverage`: a `PrimaryButton` (`../ui/PrimaryButton`) "Add coverage" that opens `<CoverageSheet visible={coverageOpen} onClose={() => { setCoverageOpen(false); setLocalBump(v => v + 1); }} />` (mounted OUTSIDE the `ModalSheet`, sibling to it — `FormSheet` stacks its own sheet; the `AddServiceRecordSheet` host pattern).
- [ ] `npx tsc --noEmit` in `apps/mobile`.
- [ ] Commit: `git commit -am "feat(#122/C): PM-gated coverage form + upcoming-coverage list in on-call popup"`

### Task 8: Admin on-call settings screen (boundary + rotation order) + device verify

**Files**
- Create: `apps/mobile/app/(app)/(admin)/on-call-settings.tsx`
- Modify: `apps/mobile/app/(app)/(admin)/settings.tsx` (link row)

**Interfaces**
- Consumes: `setAppConfigSynced` pattern from `notification-routing.tsx` (`setAppConfigLocal` + `appendOutbox('INSERT', 'app_config', { key, value, updated_at })` — server upserts on `key`), `usePermission('system_settings')`, `SelectField`, `DragList` (`items/keyExtractor/rowHeight/onReorder/renderRow`), `getAssignableCrews` (`../../../src/db/queries/oncall`), `getWeekBoundary`/`getRotation` (Task 5), `useTableVersion(['app_config','subteams'])`.
- Produces: admin screen writing `app_config` keys `on_call_week_boundary` (JSON `{day,hour}`) and `on_call_rotation` (JSON ordered subteam-id array).

**Steps**
- [ ] Create `on-call-settings.tsx` modeled on `notification-routing.tsx` (same `setAppConfigSynced` local helper, same `system_settings` gate + denied fallback, `Stack.Screen title="On-Call Settings"`):
  - Boundary card:
    ```ts
    const DAY_OPTIONS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']
      .map((label, i) => ({ id: String(i), label }));
    const HOUR_OPTIONS = Array.from({ length: 24 }, (_, h) => ({ id: String(h), label: `${String(h).padStart(2, '0')}:00` }));
    ```
    Two `SelectField`s (`label="Week flips on"` / `label="At (local time)"`) backed by `useState(getWeekBoundary())`; each `onSelect` updates state and writes `setAppConfigSynced('on_call_week_boundary', JSON.stringify({ day: Number(dayId), hour: Number(hourId) }))`. Helper copy: "Existing week assignments keep their dates; future weeks re-fill on the new boundary."
  - Rotation card: `const crews = getAssignableCrews();` (memo on version); `useState<string[]>(getRotation())`; a `DragList` of the selected ids (`rowHeight={56}`, `keyExtractor={id => id}`, `renderRow` shows crew name — `crews.find(c => c.id === id)?.name ?? 'Unknown crew'` — plus a Remove `TouchableOpacity`), `onReorder={orderedKeys => save(orderedKeys)}`; below it a `SelectField label="Add crew to rotation"` whose options are crews NOT yet in the list, `onSelect={id => save([...rotation, id])}`; where `save` = `setRotation(next); setAppConfigSynced('on_call_rotation', JSON.stringify(next));`. Helper copy: "Weeks auto-fill by cycling this list. Manually assigning a week overrides just that week."
- [ ] Add the settings link row in `settings.tsx` directly after the Notification Routing block (line ~812), same markup with `onPress={() => router.push('/(app)/(admin)/on-call-settings')}`, label `📅 On-Call Settings`, sub "Week boundary and crew rotation order".
- [ ] Full verification: `cd /home/tdpotato/projects/InventoryPro/apps/mobile && npx tsc --noEmit && pnpm test` and `cd ../api && npx tsc --noEmit && pnpm test`.
- [ ] Commit: `git commit -am "feat(#122/C): admin on-call settings — week boundary + rotation order (DragList)"`
- [ ] Phase-C device verify (project rule: hotload after each phase — `deploy-android` skill, debug dev-client + Metro, remember `adb reverse tcp:8081 tcp:8081`): set boundary Thursday 08:00 + a 2-crew rotation as admin → open the on-call widget as a PM → weeks show Thursday ranges and auto-filled alternating crews; manually override one week and confirm neighbors don't shift; add a coverage entry and confirm the other PM account gets the `on_call` notification (inbox row + push) after sync.


# Phase D — Locations polish (board #135)

## Phase D — Locations polish (rooms/shelves flow)

Phase D makes the Locations tab a "real places only" browser (consuming Phase A2's central Vehicle/Locker filter — never re-implementing it), polishes the create-room/create-shelf flow under a building (e.g. Lexington Park → Maintenance Room / Product Room / Garage with shelves), and proves stock placement at nested sub-areas/shelves still works end-to-end. No migrations in this phase (A1/C own all migrations). All tests extend the existing sql.js harness in `apps/mobile/src/db/queries/locationsShelf.test.ts` (module-hook redirect to `locationsShelf.testdb.ts`); run with:

```bash
cd /home/tdpotato/projects/InventoryPro/apps/mobile && node --import tsx --import ./src/test/setupGlobals.mjs --test src/db/queries/locationsShelf.test.ts
```

Note on test ordering: `node --test` runs a file's tests in declaration order against one shared sql.js DB — append all new tests at the end of the file and never assert whole-table equality (earlier tests leave rows behind, e.g. the existing outbox assertion at line 117 must stay the only full-table `deepEqual`).

### Task 1: Locations tab lists only real places — consume A2's filter, strip dead Vehicle/Locker UI

**Files**
- Test: `apps/mobile/src/db/queries/locationsShelf.test.ts` (extend)
- Modify: `apps/mobile/app/(app)/(locations)/index.tsx`

**Interfaces**
- Consumes: `getBrowsableLocations(): Location[]` and `getLocationTree(): LocationWithChildren[]` from `apps/mobile/src/db/queries/locations.ts` — Phase A2 has already added the `type IN ('Vehicle','Locker')` exclusion inside these (its "central filter"). This task only pins it with a regression test and removes now-dead consumers. Do NOT add another Vehicle/Locker filter to `locations.ts`.
- Consumes: `getLocationTypes()` / `getLocationTypesWithFallback()` from `apps/mobile/src/db/queries/taxonomy.ts`.

**Steps**

- [ ] Append a regression test to `apps/mobile/src/db/queries/locationsShelf.test.ts` (the `before()` block already seeds `van-1` with `type: 'Vehicle'`; seed a locker inside the test):
  ```ts
  test('getBrowsableLocations/getLocationTree exclude Vehicle- and Locker-typed rows (A2 central filter)', () => {
    seedLocation({ id: 'locker-frank', name: "Frank's Locker", type: 'Locker' });
    const ids = loc.getBrowsableLocations().map(l => l.id);
    assert.ok(ids.includes('shop-1'));
    assert.ok(!ids.includes('van-1'), 'vehicles are their own system — not in the Locations browser');
    assert.ok(!ids.includes('locker-frank'), 'lockers are their own system — not in the Locations browser');
    const topIds = loc.getLocationTree().map(n => n.id);
    assert.ok(!topIds.includes('van-1') && !topIds.includes('locker-frank'));
  });
  ```
- [ ] Run the file: `cd /home/tdpotato/projects/InventoryPro/apps/mobile && node --import tsx --import ./src/test/setupGlobals.mjs --test src/db/queries/locationsShelf.test.ts`. This must PASS already (A2 shipped the filter). If it FAILS, stop — Phase A2 is incomplete; do not implement the filter here (report the sequencing problem instead). Also confirm A2 updated the older assertion at line ~66 (`getNonShelfLocations` test previously asserted `ids.includes('van-1')` — main-location pickers must exclude vehicles too).
- [ ] Check what Vehicle/Locker residue A2 left on the Locations tab:
  ```bash
  grep -n "VehicleSheet\|LockerSheet\|VehicleInlineStatus\|ensureVehicleRow\|infoTarget\|openInfo" "/home/tdpotato/projects/InventoryPro/apps/mobile/app/(app)/(locations)/index.tsx"
  ```
  If the grep is empty, A2 already stripped the screen — mark the next two steps done and skip to the chip step.
- [ ] Remove the dead Vehicle/Locker affordances from `index.tsx` (these rows can never render now that `getLocationTree()` excludes units): the `infoTarget`/`infoOpen` state + `openInfo()` (lines ~60–65), the `ⓘ` quick-view buttons and `VehicleInlineStatus` renders inside `renderFlatCard` (lines ~301–313) and `renderNode` (lines ~351–363), the `VehicleSheet`/`LockerSheet` mounts at the bottom (lines ~576–582), and the imports of `VehicleInlineStatus`, `VehicleSheet`, `LockerSheet` (lines 19–21).
- [ ] Remove the dead Vehicle-create path in `doCreate()` (line ~211): delete `if (payload.type === 'Vehicle') ensureVehicleRow(id);` and the `ensureVehicleRow` import (line 18) — vehicle creation lives in the Vehicles screens (A2) and `findOrCreateVehicleByName`.
- [ ] Drop Vehicle/Locker from the tab's type-filter chips and the create-form's top-level Type options (they'd be dead chips / create-then-vanish traps). In `index.tsx` line ~79:
  ```ts
  const locationTypes = useMemo(
    () => getLocationTypes().filter(t => !['Shelf', 'Vehicle', 'Locker'].includes(t.label)),
    [],
  );
  ```
  and in `locationTypeOptions` (line ~154–160) change the top-level branch to:
  ```ts
  : getLocationTypesWithFallback().filter(t => !['Shelf', 'Vehicle', 'Locker'].includes(t.label)),
  ```
  Leave the sub-area branch (`getLocationSubtypesWithFallback()`) untouched — 'Shelf' stays a valid sub-area type.
- [ ] Verify: `cd /home/tdpotato/projects/InventoryPro/apps/mobile && npx tsc --noEmit && npm test`
- [ ] Commit: `git add -A && git commit -m "feat(#122): locations tab = real places only — pin A2 filter, strip dead vehicle/locker UI

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`

### Task 2: Create-room polish — Sub-areas section on location detail + add-room via the existing create form

**Files**
- Test: `apps/mobile/src/db/queries/locationsShelf.test.ts` (extend)
- Modify: `apps/mobile/src/db/queries/locations.ts`
- Modify: `apps/mobile/app/(app)/(locations)/[id].tsx`
- Modify: `apps/mobile/app/(app)/(locations)/index.tsx`

**Interfaces**
- Produces: `getRoomsForParent(parentId: string): Location[]` in `apps/mobile/src/db/queries/locations.ts` — non-shelf active children of a location (its "rooms"); shelves render in the separate Shelves section.
- Produces: route param `createUnder?: string` on `/(app)/(locations)` — auto-opens the existing full create modal (subtype chips incl. Shelf, dup warning, owner gate via `subareas_require_owner`) preset to that parent. Reuses `openCreate(presetParent)`; no duplicated form.
- Consumes: `getSubAreas(parentId)` (locations.ts:108), `openCreate` (index.tsx:184), `useFocusOrDataRefresh` (already wired in `[id].tsx` as `refreshKey`).

**Steps**

- [ ] Failing test first — append to `locationsShelf.test.ts`:
  ```ts
  test('getRoomsForParent lists non-shelf children only', () => {
    seedLocation({ id: 'room-maint', name: 'Maintenance Room', parent_id: 'shop-1', type: 'Storage' });
    const rooms = loc.getRoomsForParent('shop-1');
    assert.ok(rooms.some(r => r.id === 'room-maint'), 'a room child is listed');
    assert.ok(!rooms.some(r => r.id === 'shelf-a1'), 'shelf children are not rooms');
  });
  ```
  Run it (command from the phase header) — fails with `loc.getRoomsForParent is not a function`.
- [ ] Implement in `apps/mobile/src/db/queries/locations.ts`, directly below `getSubAreas` (line ~115):
  ```ts
  // Non-shelf children of a location — the "rooms" of a building (Maintenance
  // Room, Product Room, Garage, …) for the detail screen's Sub-areas section.
  // Shelves are excluded: they have their own dedicated section + queries.
  export function getRoomsForParent(parentId: string): Location[] {
    return getSubAreas(parentId).filter(l => l.type !== 'Shelf');
  }
  ```
  Re-run the test — passes.
- [ ] In `index.tsx`, accept the preset-parent param (add `useLocalSearchParams` to the existing `expo-router` import):
  ```ts
  const { createUnder } = useLocalSearchParams<{ createUnder?: string }>();
  // Deep-link from a location detail's "+ Add Sub-area": open the create modal
  // preset to that parent, then clear the param so re-focusing doesn't re-open.
  useEffect(() => {
    if (createUnder && canManage) {
      openCreate(createUnder);
      router.setParams({ createUnder: undefined });
    }
  }, [createUnder, canManage]);
  ```
- [ ] In `[id].tsx`, load rooms alongside the existing shelves state (line ~129):
  ```ts
  const [rooms, setRooms] = useState<Location[]>(() => getRoomsForParent(id));
  useEffect(() => { setRooms(getRoomsForParent(id)); }, [id, refreshKey]);
  ```
  (add `getRoomsForParent` to the `queries/locations` import). Then render a Sub-areas section between "Stock here" and "Shelves" (~line 442). Units cannot contain rooms (A1's guard), so gate the affordance:
  ```tsx
  {(rooms.length > 0 || (canManage && location.active === 1 && location.type !== 'Vehicle' && location.type !== 'Locker')) && (
    <>
      <Text style={s.sectionLabel}>Sub-areas</Text>
      <View style={s.card}>
        {rooms.length === 0 ? (
          <Text style={s.muted}>No sub-areas yet. Add rooms (e.g. Maintenance Room, Product Room, Garage) to organize this place.</Text>
        ) : (
          rooms.map((room, i) => (
            <TouchableOpacity
              key={room.id}
              style={[s.stockRow, i < rooms.length - 1 && s.divider]}
              onPress={() => router.push({ pathname: '/(app)/(locations)/[id]', params: { id: room.id } })}
            >
              <Text style={s.stockName} numberOfLines={1}>
                {room.type ? `${renderIcon(typeIconByLabel.get(room.type) ?? null)} ` : ''}{room.name}
              </Text>
              <Text style={s.attrVal}>›</Text>
            </TouchableOpacity>
          ))
        )}
        {canManage && location.active === 1 && location.type !== 'Vehicle' && location.type !== 'Locker' && (
          <TouchableOpacity
            style={s.addStockBtn}
            onPress={() => router.push({ pathname: '/(app)/(locations)', params: { createUnder: id } })}
          >
            <Text style={s.addStockBtnText}>+ Add Sub-area</Text>
          </TouchableOpacity>
        )}
      </View>
    </>
  )}
  ```
- [ ] Verify: `cd /home/tdpotato/projects/InventoryPro/apps/mobile && npx tsc --noEmit && npm test`
- [ ] Commit: `git add -A && git commit -m "feat(#122): location detail Sub-areas section + add-room via preset create form

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`

### Task 3: Create-shelf polish — inline "+ Add shelf" on the location detail Shelves section

**Files**
- Test: `apps/mobile/src/db/queries/locationsShelf.test.ts` (extend)
- Modify: `apps/mobile/app/(app)/(locations)/[id].tsx`

**Interfaces**
- Consumes: `findOrCreateShelf(parentId: string, name: string): string | null` (locations.ts:271) — already transactional (upsert + outbox atomic), case-insensitive dedupe, `null` on failure (callers MUST null-check per its contract). No query changes needed.
- Consumes: `getShelvesForParent(parentId: string): Location[]` (locations.ts:252), `isWriteBlocked()` from `src/db/maintenance`.

**Steps**

- [ ] Failing-first coverage of the exact flow the button will use — append to `locationsShelf.test.ts` (passes immediately since `findOrCreateShelf` exists; it pins the dedupe + nested-room behavior the UI relies on, and the room seeded in Task 2's test is reused):
  ```ts
  test('findOrCreateShelf under a ROOM creates once and dedupes case-insensitively', () => {
    const first = loc.findOrCreateShelf('room-maint', 'M1');
    assert.ok(first, 'shelf created under a nested room');
    const again = loc.findOrCreateShelf('room-maint', 'm1');
    assert.equal(again, first, 'same name (any case) returns the existing shelf');
    assert.ok(loc.getShelvesForParent('room-maint').some(sh => sh.id === first));
    assert.equal(loc.getLocationById(first!)?.type, 'Shelf');
  });
  ```
  Run the file — green.
- [ ] In `[id].tsx`, add state + handler next to the existing shelf-color state (~line 132):
  ```ts
  const [newShelfName, setNewShelfName] = useState('');
  function handleAddShelf() {
    const trimmed = newShelfName.trim();
    if (!trimmed || isWriteBlocked()) return;
    const createdId = findOrCreateShelf(id, trimmed);
    if (createdId === null) {
      Alert.alert('Add failed', `Couldn't create shelf "${trimmed}". Nothing was changed — please try again.`);
      return;
    }
    setNewShelfName('');
    setShelves(getShelvesForParent(id));
  }
  ```
  (add `findOrCreateShelf` to the `queries/locations` import.)
- [ ] Render the add row at the bottom of the Shelves card (after the `shelves.map(...)` block, inside the same `<View style={s.card}>`, ~line 497), gated like other write affordances:
  ```tsx
  {canManage && location.active === 1 && location.has_shelves === 1 && (
    <View style={s.addShelfRow}>
      <View style={{ flex: 1 }}>
        <AppInput placeholder="New shelf name (e.g. A1)" value={newShelfName} onChangeText={setNewShelfName} />
      </View>
      <TouchableOpacity onPress={handleAddShelf} disabled={locked || !newShelfName.trim()} style={s.addShelfBtn}>
        <Text style={s.addShelfBtnText}>+ Add</Text>
      </TouchableOpacity>
    </View>
  )}
  ```
  with styles added to `makeStyles`:
  ```ts
  addShelfRow: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm, marginTop: t.spacing.md },
  addShelfBtn: { backgroundColor: t.colors.primaryBg, borderRadius: t.radii.md, paddingHorizontal: t.spacing.lg, paddingVertical: 10 },
  addShelfBtnText: { color: t.colors.primary, fontWeight: '700', fontSize: t.typography.fontSizes.body },
  ```
- [ ] Update the empty-state copy (line ~453) now that a direct affordance exists: `No shelves yet. Add one below, or type a new shelf name while adding stock here.`
- [ ] Verify: `cd /home/tdpotato/projects/InventoryPro/apps/mobile && npx tsc --noEmit && npm test`
- [ ] Commit: `git add -A && git commit -m "feat(#122): inline add-shelf on location detail Shelves section

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`

### Task 4: Verify stock placement at nested sub-areas/shelves end-to-end + device walkthrough

**Files**
- Modify: `apps/mobile/src/db/queries/locationsShelf.testdb.ts` (add the two stock tables)
- Test: `apps/mobile/src/db/queries/locationsShelf.test.ts` (extend)
- Test (modify): `apps/mobile/src/db/queries/vehicleMerge.test.ts` (de-collide its own `stock_by_location` CREATE with the new shared testdb table)

**Interfaces**
- Consumes: `resolveLocationShelfSelection(location, shelf)` (locations.ts:320 — the single chokepoint Quick Add / add-stock use to turn a (location, shelf) pick into the stored location id), `resolveLocationShelf(locationId)` (locations.ts:85 — the reverse mapping that seeds pickers), `getLocationPath(id)` (locations.ts:143), `getStockAtLocation(locationId)` (locations.ts:202).
- No production code changes expected — this task is verification; any failure is a real Phase A1/A2 regression to fix at its source.

**Steps**

- [ ] Extend the testdb DDL in `locationsShelf.testdb.ts` (inside the `db.executeSync(\`...\`)` schema block) with the stock tables `getStockAtLocation` joins:
  ```sql
  CREATE TABLE inventory_items (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE stock_by_location (
    item_id TEXT NOT NULL, location_id TEXT NOT NULL,
    quantity REAL NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, synced_at TEXT,
    PRIMARY KEY (item_id, location_id)
  );
  ```
  (`synced_at TEXT` matches A1 Task 11's `vehicleMerge.test.ts` DDL so either table definition satisfies both suites — `applyVehicleMerge` and `getStockAtLocation` only touch item_id/location_id/quantity/updated_at, so the extra column is safe.)
- [ ] De-collide `vehicleMerge.test.ts`: A1 Task 11's `before()` runs `initTestDb()` — which now creates `stock_by_location` — and then executes its own `CREATE TABLE stock_by_location ...`, which would fail with "table stock_by_location already exists" and turn the A1 merge test red. Change that statement to `CREATE TABLE IF NOT EXISTS stock_by_location (...)` (or delete it entirely and rely on the shared testdb table), then confirm: `node --import tsx --import ./src/test/setupGlobals.mjs --test src/db/queries/vehicleMerge.test.ts` stays green.
- [ ] Append the end-to-end test (building → room → shelf → stock):
  ```ts
  test('end-to-end: stock placed at a shelf inside a room inside a building', () => {
    seedLocation({ id: 'bldg-lex', name: 'Lexington Park' });
    seedLocation({ id: 'room-prod', name: 'Product Room', parent_id: 'bldg-lex', type: 'Storage', has_shelves: 1 });
    // Two-stage picker: pick the room, type a NEW shelf → shelf created under the room.
    const res = loc.resolveLocationShelfSelection(
      { id: 'room-prod', label: 'Product Room' },
      { id: '__new__', label: 'S1' },
    );
    assert.equal(res.ok, true);
    const shelfId = (res as { ok: true; id: string }).id!;
    assert.equal(loc.getLocationById(shelfId)?.parent_id, 'room-prod');
    assert.equal(loc.getLocationPath(shelfId), 'Lexington Park › Product Room › S1');
    // Reverse mapping seeds the picker back to (room, shelf).
    assert.deepEqual(loc.resolveLocationShelf(shelfId), {
      location: { id: 'room-prod', label: 'Product Room' },
      shelf: { id: shelfId, label: 'S1' },
    });
    // Stock tracked against the shelf id is readable at the shelf.
    testDb.getDb().executeSync(
      `INSERT INTO inventory_items (id, name, active) VALUES ('item-tape', 'Duct Tape', 1)`,
    );
    testDb.getDb().executeSync(
      `INSERT INTO stock_by_location (item_id, location_id, quantity, updated_at) VALUES ('item-tape', ?, 12, ?)`,
      [shelfId, NOW],
    );
    const stock = loc.getStockAtLocation(shelfId);
    assert.deepEqual(stock.map(r => ({ name: r.name, quantity: r.quantity })), [{ name: 'Duct Tape', quantity: 12 }]);
  });
  ```
- [ ] Run the full suite: `cd /home/tdpotato/projects/InventoryPro/apps/mobile && npx tsc --noEmit && npm test` — all green. If `resolveLocationShelfSelection` or the exclusion tests fail, debug the A1/A2 source (do not patch around it in Phase D).
- [ ] Commit: `git add -A && git commit -m "test(#122): end-to-end nested room/shelf stock placement verification

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`
- [ ] Device verification (per project CLAUDE.md, phase completion signal — hotload the debug dev-client per the `deploy-android` / dev-hotload skill: Metro with `--clear`, NO `CI=1`, and re-run `adb reverse tcp:8081 tcp:8081` if the bundle fails to load). Walkthrough: (1) Locations tab shows no vehicles/lockers anywhere (tree, chips, create Type options); (2) open a building → "+ Add Sub-area" → create "Product Room" (subtype Storage, has_shelves on) → it appears in the building's Sub-areas section; (3) open Product Room → "+ Add shelf" "S1" → shelf listed; (4) Add Stock at Product Room picking shelf S1 → stock shows on the shelf's parent flow and `Lexington Park › Product Room › S1` renders in pickers; (5) confirm the sync dot clears (outbox pushed). Do NOT blind-tap the phone — narrate each step and wait for the user at the device.
- [ ] Move the Phase D board card to "In review" via the `board` skill scripts (`gh_move`), noting device verification is the gate to Done.

# Phase E — Admin org-default theme (board #138)

## Phase E — Admin org-default theme (#138)

New precedence: `user_prefs.theme` (personal, synced) → `app_config 'default_theme_id'` (org default, synced + admin-settable) → `DEFAULT_THEME_ID` ('original'). No new tables and no migrations: `app_config` already syncs both ways (pull.ts line 18, fullDownload.ts line 140), pushes to it are already gated server-side by `PRIVILEGED_TABLE_PERM['app_config'] = 'system_settings'` (apps/api/src/routes/sync.ts line 69), and an unset key means "built-in default". Device cache for the pre-login screen is the local `app_config` table itself (it exists pre-auth — same DB the login picker reads); fresh installs seed it from the public `/auth/roster` response. `app_settings 'theme_last'` becomes a personal-choice cache only: org-default applies use `persist: false`, and boot falls back `theme_last → app_config → built-in`.

### Task 1: Expose `default_theme_id` on the public `/auth/roster` response

**Files**
- Test: `apps/api/src/routes/auth-default-theme.test.ts` (create)
- Modify: `apps/api/src/routes/auth.ts` (the `GET /roster` handler, ~lines 135–184)

**Interfaces**
- Consumes: `app_config` row `key = 'default_theme_id'` (may be absent).
- Produces: roster response gains one top-level field — `{ users: [...], default_theme_id: string | null }`. A theme id is public BY DESIGN (the sign-in screen must render it before any login); it exposes no business data.

**Steps**

- [ ] Write the failing test `apps/api/src/routes/auth-default-theme.test.ts`, modeled on `auth-demo.test.ts` (same Fastify + fakePg + stubGate harness):

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import authRoutes from './auth';
import type { DemoModeGate } from '../lib/demoMode';

// Phase E (#138) — /auth/roster piggybacks the org default theme so the
// sign-in screen and fresh installs are themed before any login. A theme id
// is public by design; the field must be null (not absent) when unset.
const SECRET = 'unit-test-secret-that-is-at-least-32-chars!!';
const ROSTER_ROWS = [
  { id: '5f0c1a2b-3d4e-4f60-8a9b-0c1d2e3f4a5b', name: 'Alice', role: 'admin',
    pin_length_required: 4, pin_set: true, is_test: false, test_code: null },
];

function fakePg(orgTheme: string | null) {
  return {
    query: async (sql: string) => {
      if (sql.includes(`key = 'default_theme_id'`)) {
        return { rows: orgTheme ? [{ value: orgTheme }] : [] };
      }
      if (sql.includes('pin_hash IS NOT NULL')) return { rows: ROSTER_ROWS };
      return { rows: [] };
    },
  };
}

const gate: DemoModeGate = { isEnabled: async () => false, invalidate() {} };

async function buildApp(orgTheme: string | null) {
  const app = Fastify();
  app.decorate('pg', fakePg(orgTheme) as never);
  await app.register(fastifyJwt, { secret: SECRET });
  await app.register(authRoutes, { prefix: '/auth', demoGate: gate });
  await app.ready();
  return app;
}

test('roster carries default_theme_id when app_config has one', async () => {
  const app = await buildApp('futuristic');
  const res = await app.inject({ method: 'GET', url: '/auth/roster' });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { users: unknown[]; default_theme_id: string | null };
  assert.equal(body.default_theme_id, 'futuristic');
  assert.equal(body.users.length, 1);
  await app.close();
});

test('roster sends default_theme_id: null when the key is unset', async () => {
  const app = await buildApp(null);
  const res = await app.inject({ method: 'GET', url: '/auth/roster' });
  assert.equal(res.statusCode, 200);
  assert.equal((res.json() as { default_theme_id: string | null }).default_theme_id, null);
  await app.close();
});
```

- [ ] Run it and watch it fail: `cd /home/tdpotato/projects/InventoryPro/apps/api && pnpm test` (`default_theme_id` is `undefined`).
- [ ] In `apps/api/src/routes/auth.ts`, inside the `/roster` handler after `const demoOn = await demoGate.isEnabled();`, add the lookup:

```ts
    // Org default theme (Phase E, #138): public BY DESIGN — a theme id is not
    // sensitive, and a brand-new device must theme the sign-in screen before
    // any token exists. Absent row → null → client falls back to built-in.
    const { rows: themeRows } = await fastify.pg.query<{ value: string }>(
      `SELECT value FROM app_config WHERE key = 'default_theme_id'`, []
    );
```

- [ ] Add the field to the existing `reply.send({ users: ... })` object:

```ts
    return reply.send({
      default_theme_id: themeRows[0]?.value ?? null,
      users: rows.map(u => ({
```

- [ ] Verify: `pnpm test` in `apps/api` — new tests green, and the existing `auth-demo.test.ts` roster tests still pass (its fakePg returns `{ rows: [] }` for the new query → `null`, which is valid).
- [ ] Commit: `feat(#138): expose org default theme on public /auth/roster`

### Task 2: Mobile org-default resolution — `orgTheme.ts`, boot fallback, sync + login wiring

**Files**
- Modify: `apps/mobile/src/db/appConfig.ts` (add `ORG_THEME_KEY` constant)
- Create: `apps/mobile/src/db/orgTheme.ts`
- Modify: `apps/mobile/src/themes/store.ts` (`loadThemeFromSettings` fallback)
- Modify: `apps/mobile/src/sync/engine.ts` (post-pull hook, ~line 256)
- Modify: `apps/mobile/src/auth/finishLogin.ts` (~line 93)
- Test: `apps/mobile/src/db/orgTheme.test.ts` (create)

**Interfaces**
- Consumes: `getAppConfig`/`setAppConfigLocal` (db/appConfig.ts), `getUserTheme` (db/userPrefs.ts), `setThemeId(id, { persist })` (themes/store.ts), `resolveTheme` (themes/registry.ts), `appendOutbox('INSERT', 'app_config', row)` — the exact `setMaintenanceMode` write path (db/maintenance.ts lines 44–55).
- Produces:
  - `export const ORG_THEME_KEY = 'default_theme_id'` (appConfig.ts — a leaf module, so both store.ts and orgTheme.ts can import it without a cycle; orgTheme→store is one-way)
  - `getOrgDefaultThemeId(): string | null`
  - `applyOrgDefaultTheme(userId: string | null): void` — no-op when `userId` has a personal `user_prefs` theme; `null` = pre-login, always applies
  - `setOrgDefaultTheme(themeId: string, currentUserId: string | null): void` — admin write: local upsert + outbox INSERT + immediate local apply

**Steps**

- [ ] Write the failing test `apps/mobile/src/db/orgTheme.test.ts` using the `chat.test.ts` `Module._load` redirect pattern (real sql.js DB via `./queries/locationsShelf.testdb`):

```ts
import { createRequire } from 'node:module';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// Phase E (#138) — org default theme resolution. Precedence under test:
// user_prefs.theme -> app_config 'default_theme_id' -> DEFAULT_THEME_ID.
const requireCjs = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Module = requireCjs('node:module') as any;
const testDb = requireCjs('./queries/locationsShelf.testdb') as typeof import('./queries/locationsShelf.testdb');

const origLoad = Module._load;
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'react-native-get-random-values') return {};
  let resolved = '';
  try { resolved = Module._resolveFilename(request, parent); } catch { /* not ours */ }
  if (resolved.endsWith('/src/db/schema.ts')) return testDb;
  if (resolved.endsWith('/src/telemetry/index.ts')) return { track() {} };
  return origLoad.call(this, request, parent, isMain);
};

let orgTheme: typeof import('./orgTheme');
let store: typeof import('../themes/store');
let userPrefs: typeof import('./userPrefs');

const ALICE = 'user-alice';

function exec(sql: string, params?: unknown[]) {
  return testDb.getDb().executeSync(sql, params);
}

before(async () => {
  await testDb.initTestDb(); // locations/taxonomy_types/outbox
  // Mirrors mobile migrations 010 (app_config), 040 (user_prefs) + app_settings.
  exec(`
    CREATE TABLE app_config (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
    CREATE TABLE user_prefs (user_id TEXT PRIMARY KEY, theme TEXT, updated_at TEXT NOT NULL);
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  orgTheme = requireCjs('./orgTheme') as typeof import('./orgTheme');
  store = requireCjs('../themes/store') as typeof import('../themes/store');
  userPrefs = requireCjs('./userPrefs') as typeof import('./userPrefs');
});

test('pre-login (userId null): org default applies', () => {
  exec(`INSERT OR REPLACE INTO app_config (key, value, updated_at) VALUES ('default_theme_id', 'futuristic', '2026-07-19')`);
  orgTheme.applyOrgDefaultTheme(null);
  assert.equal(store.getTheme().id, 'futuristic');
});

test('boot fallback: no theme_last -> loadThemeFromSettings reads app_config', () => {
  exec(`DELETE FROM app_settings WHERE key = 'theme_last'`);
  store.loadThemeFromSettings();
  assert.equal(store.getTheme().id, 'futuristic');
});

test('a personal user_prefs theme beats the org default', () => {
  userPrefs.chooseTheme(ALICE, 'modern');
  orgTheme.applyOrgDefaultTheme(ALICE); // must NOT re-skin
  assert.equal(store.getTheme().id, 'modern');
});

test('signed-in user without a personal theme gets the org default', () => {
  exec(`DELETE FROM user_prefs WHERE user_id = ?`, [ALICE]);
  orgTheme.applyOrgDefaultTheme(ALICE);
  assert.equal(store.getTheme().id, 'futuristic');
});

test('setOrgDefaultTheme writes app_config locally, queues an outbox INSERT, and applies', () => {
  exec(`DELETE FROM outbox`);
  orgTheme.setOrgDefaultTheme('classic', null);
  const cfg = exec(`SELECT value FROM app_config WHERE key = 'default_theme_id'`).rows as { value: string }[];
  assert.equal(cfg[0].value, 'classic');
  const ops = exec(`SELECT operation, table_name, payload FROM outbox`).rows as
    Array<{ operation: string; table_name: string; payload: string }>;
  assert.equal(ops.length, 1);
  assert.equal(ops[0].operation, 'INSERT');
  assert.equal(ops[0].table_name, 'app_config');
  assert.equal((JSON.parse(ops[0].payload) as { key: string }).key, 'default_theme_id');
  assert.equal(store.getTheme().id, 'classic');
});

test('unknown org theme id falls back to the built-in default', () => {
  exec(`INSERT OR REPLACE INTO app_config (key, value, updated_at) VALUES ('default_theme_id', 'no-such-theme', '2026-07-19')`);
  orgTheme.applyOrgDefaultTheme(null);
  assert.equal(store.getTheme().id, 'original');
});
```

- [ ] Run and watch it fail: `cd /home/tdpotato/projects/InventoryPro/apps/mobile && pnpm test` (module `./orgTheme` doesn't exist).
- [ ] In `apps/mobile/src/db/appConfig.ts`, add above `getAppConfig`:

```ts
/** app_config key for the org-wide default theme (Phase E, #138). */
export const ORG_THEME_KEY = 'default_theme_id';
```

- [ ] Create `apps/mobile/src/db/orgTheme.ts`:

```ts
import { getAppConfig, setAppConfigLocal, ORG_THEME_KEY } from './appConfig';
import { getUserTheme } from './userPrefs';
import { appendOutbox } from '../sync/outbox';
import { setThemeId } from '../themes/store';
import { resolveTheme } from '../themes/registry';

/**
 * Org-wide default theme (app_config 'default_theme_id', synced). Precedence:
 * user_prefs.theme -> this -> DEFAULT_THEME_ID. Same admin write path as
 * setMaintenanceMode (local upsert + outbox INSERT; server upserts on key and
 * gates the push behind PRIVILEGED_TABLE_PERM app_config -> system_settings).
 */

/** The org default theme id, or null when the admin never set one. */
export function getOrgDefaultThemeId(): string | null {
  return getAppConfig(ORG_THEME_KEY);
}

/**
 * Re-theme THIS device to the org default — unless `userId` chose their own
 * theme (user_prefs wins). `null` = pre-login (sign-in screen / fresh install),
 * which always applies. persist:false keeps app_settings 'theme_last' a
 * personal-choice cache only; boot falls back to app_config itself.
 */
export function applyOrgDefaultTheme(userId: string | null): void {
  if (userId && getUserTheme(userId)) return;
  const id = getOrgDefaultThemeId();
  if (!id) return;
  setThemeId(resolveTheme(id).id, { persist: false });
}

/** Admin action: set the org default, sync it everywhere, apply it here. */
export function setOrgDefaultTheme(themeId: string, currentUserId: string | null): void {
  const id = resolveTheme(themeId).id;
  setAppConfigLocal(ORG_THEME_KEY, id);
  appendOutbox('INSERT', 'app_config', {
    key: ORG_THEME_KEY,
    value: id,
    updated_at: new Date().toISOString(),
  });
  applyOrgDefaultTheme(currentUserId);
}
```

- [ ] In `apps/mobile/src/themes/store.ts`, import `import { getAppConfig, ORG_THEME_KEY } from '../db/appConfig';` and change `loadThemeFromSettings` (lines 74–80) to fall back through the org default:

```ts
export function loadThemeFromSettings(): void {
  let id: string | null = null;
  try { id = getAppSetting(THEME_LAST_KEY); } catch { /* DB not ready */ }
  // No personal/device choice cached -> org default (synced app_config, also
  // seeded from the public roster on fresh installs) -> built-in default.
  if (!id) id = getAppConfig(ORG_THEME_KEY);
  activeTheme = resolveTheme(id);
  applyWebColorScheme(activeTheme);
  // No notify: callers run this before the first render.
}
```

  Also update the precedence comment block at the top of the file (lines 11–15) to list the new layer 3: `app_config 'default_theme_id'` before `DEFAULT_THEME_ID`. Reactivity needs no new work: `applyOrgDefaultTheme` goes through `setThemeId`, which bumps the version counter and notifies the existing `useSyncExternalStore` subscribers — the module-cache gotcha is exactly why it must NOT set state any other way.
- [ ] Wire the post-pull hook in `apps/mobile/src/sync/engine.ts`: add `import { applyOrgDefaultTheme } from '../db/orgTheme';` to the imports, and replace the theme hook at ~line 253–256:

```ts
    // A pull may also have changed the org default theme (app_config
    // 'default_theme_id') — silently re-theme users who never picked their own
    // (no prompt: they never chose, so following the org default is the intent),
    // then run the personal-theme prompt path for users who did.
    void getSavedUserId().then(id => {
      applyOrgDefaultTheme(id ?? null);
      if (id) applyUserTheme(id, { prompt: true });
    });
```

- [ ] Wire login in `apps/mobile/src/auth/finishLogin.ts` (~line 93) — org default first, personal pref overrides (applyOrgDefaultTheme self-no-ops when a pref exists, so order is safe either way):

```ts
  // Theme precedence at login: org default (app_config, arrived with the full
  // download) unless this user picked their own; then their synced pick.
  try { applyOrgDefaultTheme(session.id); applyUserTheme(session.id); } catch { /* keep the device theme */ }
```

  Add `import { applyOrgDefaultTheme } from '../db/orgTheme';` next to the existing `applyUserTheme` import.
- [ ] Verify: `pnpm test` in `apps/mobile` (all suites, not just the new file) and `npx tsc --noEmit`.
- [ ] Commit: `feat(#138): org default theme — resolution, boot fallback, sync + login wiring`

### Task 3: Sign-in screen + fresh installs — piggyback on the public roster fetch

**Files**
- Modify: `apps/mobile/src/auth/roster.ts`
- Modify: `apps/mobile/app/(auth)/login.tsx` (the `loadRoster` fetch branch, ~lines 91–95)

**Interfaces**
- Consumes: Task 1's `{ users, default_theme_id }` response; `setAppConfigLocal` + `ORG_THEME_KEY` (db/appConfig.ts); `applyOrgDefaultTheme` (db/orgTheme.ts).
- Produces: `fetchRoster(): Promise<RosterResponse>` where `interface RosterResponse { users: RosterUser[]; default_theme_id: string | null }` — a signature change with exactly one caller (login.tsx line 91; verified by grep).

**Steps**

- [ ] In `apps/mobile/src/auth/roster.ts`, change the return shape:

```ts
export interface RosterResponse {
  users: RosterUser[];
  /** Org default theme id (app_config 'default_theme_id'); null when unset. */
  default_theme_id: string | null;
}

/** Fetches the sign-in roster. Used only when the local DB is empty (new device). */
export async function fetchRoster(): Promise<RosterResponse> {
  const res = await fetch(`${API_BASE}/auth/roster`);
  if (!res.ok) throw new Error(`Could not load the sign-in list (${res.status}).`);
  const data = (await res.json()) as { users: RosterUser[]; default_theme_id?: string | null };
  return { users: data.users ?? [], default_theme_id: data.default_theme_id ?? null };
}
```

- [ ] In `apps/mobile/app/(auth)/login.tsx`, update the empty-local-DB branch of `loadRoster` (~line 91). Add imports `import { setAppConfigLocal, ORG_THEME_KEY } from '../../src/db/appConfig';` (the file already imports `getAppConfig` from there — merge into one line) and `import { applyOrgDefaultTheme } from '../../src/db/orgTheme';`, then:

```ts
    fetchRoster()
      .then(({ users: fetched, default_theme_id }) => {
        setUsers(hideDemo(fetched));
        setNeedsFullSync(true);
        // Fresh install: cache the org default in the local app_config table
        // (the DB opens pre-auth) so later offline boots theme the sign-in
        // screen, and apply it now — setThemeId notifies useTheme, so this
        // very screen re-skins without a remount.
        if (default_theme_id) {
          try { setAppConfigLocal(ORG_THEME_KEY, default_theme_id); } catch { /* DB not ready */ }
          applyOrgDefaultTheme(null);
        }
      })
      .catch(e => setRosterError((e as Error).message || 'Could not reach the server. Connect to the internet to set up this device.'))
      .finally(() => setRosterLoading(false));
```

  Returning devices need nothing here: their local `app_config` already has the key via sync, and boot (`loadThemeFromSettings`, Task 2) resolves it.
- [ ] Verify: `npx tsc --noEmit` in `apps/mobile` (catches any missed `fetchRoster` caller) and `pnpm test`.
- [ ] Commit: `feat(#138): sign-in + fresh-install theming via public roster default_theme_id`

### Task 4: Admin settings picker + device verification

**Files**
- Modify: `apps/mobile/app/(app)/(admin)/settings.tsx`

**Interfaces**
- Consumes: `getOrgDefaultThemeId`, `setOrgDefaultTheme` (db/orgTheme.ts); existing screen locals — `isAdmin` (`usePermission('system_settings')`, line 112, matching the server-side push gate for `app_config`), `user`, `themeList()`, styles `s.sectionTitle/card/row/rowLabel/rowSub/divider/infoBlock`, and the `useFocusEffect` refresh block (~line 232).
- Produces: an "Org default theme" card rendered directly below the existing per-user Theme card (line ~554), visible only to `system_settings` holders.

**Steps**

- [ ] Add imports: `import { getOrgDefaultThemeId, setOrgDefaultTheme } from '../../../src/db/orgTheme';`
- [ ] Add state next to the other config states (~line 129): `const [orgThemeId, setOrgThemeId] = useState<string | null>(() => getOrgDefaultThemeId());`
- [ ] Add `setOrgThemeId(getOrgDefaultThemeId());` inside the existing `useFocusEffect` callback (~line 232, beside `setMaintOn(isMaintenanceActive())`) so another admin's synced change shows on focus.
- [ ] Render the section immediately after the per-user Theme `</View>` (after line ~554), following the maintenance-toggle write-guard pattern (`try { ... } catch { /* blocked write — ignore */ }`):

```tsx
        {/* ── Org default theme (admins; app_config, synced) ────────────── */}
        {isAdmin && (
          <View>
            <Text style={s.sectionTitle}>Org default theme</Text>
            <View style={s.card}>
              {themeList().map((th, i) => (
                <View key={th.id}>
                  {i > 0 && <View style={s.divider} />}
                  <TouchableOpacity
                    style={s.row}
                    onPress={() => {
                      try { setOrgDefaultTheme(th.id, user?.id ?? null); setOrgThemeId(th.id); }
                      catch { /* blocked write — ignore */ }
                    }}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={s.rowLabel}>{th.name}</Text>
                    </View>
                    {[th.colors.background, th.colors.surface, th.colors.primary, th.colors.accent].map((c, j) => (
                      <View
                        key={j}
                        style={{
                          width: 18, height: 18, borderRadius: 9, backgroundColor: c,
                          borderWidth: 1, borderColor: th.colors.border, marginLeft: 4,
                        }}
                      />
                    ))}
                    <Text style={[s.rowSub, { marginLeft: t.spacing.md, width: 18 }]}>
                      {orgThemeId === th.id ? '✓' : ''}
                    </Text>
                  </TouchableOpacity>
                </View>
              ))}
              <View style={s.divider} />
              <View style={s.infoBlock}>
                <Text style={s.rowSub}>
                  Applies to the sign-in screen, new installs, and everyone who hasn't picked their own theme. Personal picks above always win.
                </Text>
              </View>
            </View>
          </View>
        )}
```

- [ ] Verify: `npx tsc --noEmit` and `pnpm test` in `apps/mobile`; `pnpm test` in `apps/api` (full-suite regression).
- [ ] Device verification (per project CLAUDE.md: hotload the dev APK after the phase — debug dev-client + Metro, NO CI=1, `--clear`; re-run `adb reverse tcp:8081 tcp:8081` if the bundle fails to load). Check on the phone: (1) admin sets org default to Futuristic → an account with no personal theme re-skins after the next sync WITHOUT remount, and the admin's own personal theme survives; (2) sign-out → sign-in screen renders the org default; (3) a user's personal pick still overrides; (4) picker section hidden for a non-`system_settings` role.
- [ ] Commit: `feat(#138): admin org-default theme picker in settings`