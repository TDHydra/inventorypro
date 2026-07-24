# Vehicles Schema Phase 0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One migration wave laying the DB groundwork for #152 (debris option+level), #155 (checkout opt-in), #167 (locked-by), #168 (gas-receipt fields on service records), so each item's UI phase is code-only.

**Architecture:** Two migration pairs — vehicles gains 4 columns (mobile 053 / API 065), vehicle_service_records gains 2 (mobile 054 / API 066). No new tables. Media pipeline gains entity type `'service_record'`. Payer list is an app_config key with a code default (no seed row). One behavior slice: `upsertVehicleState` stamps/clears `locked_by` via a pure helper.

**Tech Stack:** Expo RN (op-sqlite; sql.js web twin), Fastify + Postgres, node:test + tsx both sides.

**Spec:** `docs/superpowers/specs/2026-07-23-vehicles-schema-phase0-design.md` · Board #152/#155/#167/#168 · Branch `feat/vehicles-schema-phase0`.

## Global Constraints

- TEXT/BOOLEAN/INTEGER columns only — **never** a PG enum (prod crash-loop trap).
- **No backfills / no watermark UPDATEs** in either pair — column defaults converge on all three stores; existing rows must not re-download.
- Every mobile migration registered in **both** `apps/mobile/src/db/schema.ts` and `apps/mobile/src/db/schema.web.ts`.
- Sync checklist (`docs/SYNC-MIGRATION-CHECKLIST.md`) binds Tasks 5–7: server col lists and mobile `pull.ts` must move together; `pullColumns.test.ts` enforces.
- `locked_by` semantics: stamped with the acting user when `checkout_locked` flips 0→1, carried when 1→1, cleared to NULL on →0. `NULL` + locked = legacy pre-hierarchy lock.
- Migration numbers 053/054 (mobile) and 065/066 (API) — re-verify next-free immediately before creating each file; if something landed, take the next free and say so.
- **Never `git add -A`** (unrelated board-skill edits are dirty in the tree). Stage named files only.
- Every commit ends with the trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Commands: API tests `cd apps/api && node --import tsx --test <file>` (suite: `pnpm test`); mobile tests `cd apps/mobile && node --import tsx --import ./src/test/setupGlobals.mjs --test <file>` (suite: `pnpm test`); typecheck `npx tsc --noEmit` in each.

---

### Task 1: API migration 065_vehicle_options.sql (+ invariants tests)

**Files:**
- Create: `apps/api/src/db/migrations/065_vehicle_options.sql`
- Test: `apps/api/src/db/migrationSql.test.ts` (append)

**Interfaces:**
- Produces: PG columns `vehicles.debris_option BOOLEAN NOT NULL DEFAULT false`, `debris_level INTEGER NOT NULL DEFAULT 0`, `open_checkout BOOLEAN NOT NULL DEFAULT false`, `locked_by UUID NULL`. Tasks 5–7 rely on these names exactly.

- [ ] **Step 1: Write the failing tests** — append to `apps/api/src/db/migrationSql.test.ts`:

```ts
// ── Phase 0 (#152/#155/#167): vehicle options wave ───────────────────────────

test('065: four vehicle option columns, pinned defaults, never a PG enum', () => {
  const sql = read('065_vehicle_options.sql');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS debris_option BOOLEAN NOT NULL DEFAULT false/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS debris_level INTEGER NOT NULL DEFAULT 0/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS open_checkout BOOLEAN NOT NULL DEFAULT false/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS locked_by UUID/);
  assert.doesNotMatch(sql, /CREATE TYPE/i);
  assert.doesNotMatch(sql, /DROP COLUMN/i);
});

test('065: no backfill — defaults converge, no watermark bump wanted', () => {
  const sql = read('065_vehicle_options.sql');
  assert.doesNotMatch(sql, /UPDATE vehicles/i);
});
```

- [ ] **Step 2: Run to verify FAIL** — `cd /home/tdpotato/projects/InventoryPro/apps/api && node --import tsx --test src/db/migrationSql.test.ts` → the two new tests FAIL (ENOENT reading `065_vehicle_options.sql`).

- [ ] **Step 3: Create `apps/api/src/db/migrations/065_vehicle_options.sql`:**

```sql
-- Migration 065: vehicle options wave (#152/#155/#167). Mirrors mobile 053.
-- TEXT/BOOLEAN/INTEGER only — never a PG enum (prod crash-loop trap).
--   debris_option: per-vehicle toggle like truck_mount (#152)
--   debris_level:  0-100 drag-to-fill level (#152)
--   open_checkout: owner-assigned vehicles are opt-in for general checkout
--                  (#155; default false = existing owned vehicles go closed on
--                  deploy day — user-approved in the phase-0 spec)
--   locked_by:     who set checkout_locked (#167); NULL = legacy pre-hierarchy
--                  lock (anyone passing canManageVehicle may unlock)
-- No backfill: defaults converge identically on all three stores, so no
-- updated_at bump (no re-download storm).
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS debris_option BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS debris_level INTEGER NOT NULL DEFAULT 0;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS open_checkout BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS locked_by UUID;
```

- [ ] **Step 4: Run to verify PASS** — same command, whole file green.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/migrations/065_vehicle_options.sql apps/api/src/db/migrationSql.test.ts
git commit -m "feat(#152,#155,#167): API migration 065 — vehicle options wave

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Mobile migration 053_vehicle_options.ts + registration in BOTH schemas + sql.js test

**Files:**
- Create: `apps/mobile/src/db/migrations/053_vehicle_options.ts`
- Create: `apps/mobile/src/db/migrations/053_vehicle_options.test.ts`
- Modify: `apps/mobile/src/db/schema.ts` (import block ~line 139 + array line 140)
- Modify: `apps/mobile/src/db/schema.web.ts` (Promise.all array, after line 162 `052_media_audience`)

**Interfaces:**
- Produces: SQLite columns `debris_option INTEGER NOT NULL DEFAULT 0`, `debris_level INTEGER NOT NULL DEFAULT 0`, `open_checkout INTEGER NOT NULL DEFAULT 0`, `locked_by TEXT NULL` on `vehicles`. Tasks 6–7 rely on these.

- [ ] **Step 1: Write the failing test** — create `apps/mobile/src/db/migrations/053_vehicle_options.test.ts` (mirrors the `045_two_tanks.test.ts` idiom):

```ts
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqlJsDb } from './sqljsTestDb';
import { migration } from './053_vehicle_options';
import type { SqlDb } from '../types';

let db: SqlDb;
before(async () => {
  db = await makeSqlJsDb();
  // Pre-053 vehicles shape (042 + 045 + 050 DDL, condensed).
  db.executeSync(`CREATE TABLE vehicles (
    location_id TEXT PRIMARY KEY, truck_mount INTEGER NOT NULL DEFAULT 0,
    water_state TEXT, model TEXT, model_id TEXT, notes TEXT,
    updated_at TEXT NOT NULL, synced_at TEXT,
    water_tank TEXT NOT NULL DEFAULT 'empty', waste_tank TEXT NOT NULL DEFAULT 'clean',
    checkout_locked INTEGER NOT NULL DEFAULT 0
  )`);
  db.executeSync(`INSERT INTO vehicles (location_id, updated_at) VALUES ('v-1', '2026-07-01T00:00:00.000Z')`);
  migration.up(db);
});

test('053: existing rows get the four option defaults', () => {
  const r = db.executeSync(`SELECT debris_option, debris_level, open_checkout, locked_by FROM vehicles WHERE location_id = 'v-1'`).rows[0] as { debris_option: number; debris_level: number; open_checkout: number; locked_by: string | null };
  assert.equal(r.debris_option, 0);
  assert.equal(r.debris_level, 0);
  assert.equal(r.open_checkout, 0);
  assert.equal(r.locked_by, null);
});

test('053: updated_at untouched (no watermark bump — defaults converge)', () => {
  const r = db.executeSync(`SELECT updated_at FROM vehicles WHERE location_id = 'v-1'`).rows[0] as { updated_at: string };
  assert.equal(r.updated_at, '2026-07-01T00:00:00.000Z');
});
```

- [ ] **Step 2: Run to verify FAIL** — `cd /home/tdpotato/projects/InventoryPro/apps/mobile && node --import tsx --import ./src/test/setupGlobals.mjs --test src/db/migrations/053_vehicle_options.test.ts` → FAIL (cannot find module `./053_vehicle_options`).

- [ ] **Step 3: Create `apps/mobile/src/db/migrations/053_vehicle_options.ts`:**

```ts
import type { SqlDb } from '../types';

// Migration 053: vehicle options wave (#152/#155/#167). Mirrors API 065. SYNCED
// columns (docs/SYNC-MIGRATION-CHECKLIST.md — pull.ts TABLE_UPSERT_SQL/rowToValues
// and queries/vehicles.ts upsertVehicleState extended in the same change).
//   debris_option 0/1, debris_level 0-100 (#152); open_checkout 0/1 (#155,
//   default 0 = owner-assigned vehicles closed until opted in); locked_by TEXT
//   UUID (#167, NULL = legacy pre-hierarchy lock).
export const migration = {
  version: 53,
  up: (db: SqlDb): void => {
    db.executeSync(`ALTER TABLE vehicles ADD COLUMN debris_option INTEGER NOT NULL DEFAULT 0`);
    db.executeSync(`ALTER TABLE vehicles ADD COLUMN debris_level INTEGER NOT NULL DEFAULT 0`);
    db.executeSync(`ALTER TABLE vehicles ADD COLUMN open_checkout INTEGER NOT NULL DEFAULT 0`);
    db.executeSync(`ALTER TABLE vehicles ADD COLUMN locked_by TEXT`);
  },
};
```

- [ ] **Step 4: Run to verify PASS** — same command, both tests green.

- [ ] **Step 5: Register in `schema.ts`** — after the `052_media_audience` import line add:

```ts
  const { migration: m053 } = await import('./migrations/053_vehicle_options');
```

and append `m053` to the returned array (before `.sort`): `..., m051, m052, m053]`.

- [ ] **Step 6: Register in `schema.web.ts`** — in the `Promise.all([...])` import array, after `import('./migrations/052_media_audience'),` add:

```ts
    import('./migrations/053_vehicle_options'),
```

- [ ] **Step 7: Typecheck** — `cd /home/tdpotato/projects/InventoryPro/apps/mobile && npx tsc --noEmit` → clean.

- [ ] **Step 8: Commit**

```bash
git add apps/mobile/src/db/migrations/053_vehicle_options.ts apps/mobile/src/db/migrations/053_vehicle_options.test.ts apps/mobile/src/db/schema.ts apps/mobile/src/db/schema.web.ts
git commit -m "feat(#152,#155,#167): mobile migration 053 — vehicle options (schema.ts + schema.web.ts)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: API migration 066_receipt_fields.sql (+ invariants tests)

**Files:**
- Create: `apps/api/src/db/migrations/066_receipt_fields.sql`
- Test: `apps/api/src/db/migrationSql.test.ts` (append)

**Interfaces:**
- Produces: PG columns `vehicle_service_records.payer TEXT NULL`, `job_id UUID NULL`. Tasks 5–7 rely on these names.

- [ ] **Step 1: Write the failing test** — append to `migrationSql.test.ts`:

```ts
test('066: receipt fields are nullable TEXT/UUID adds, never enum, no backfill', () => {
  const sql = read('066_receipt_fields.sql');
  assert.match(sql, /ALTER TABLE vehicle_service_records ADD COLUMN IF NOT EXISTS payer TEXT/);
  assert.match(sql, /ALTER TABLE vehicle_service_records ADD COLUMN IF NOT EXISTS job_id UUID/);
  assert.doesNotMatch(sql, /CREATE TYPE/i);
  assert.doesNotMatch(sql, /NOT NULL/);
  assert.doesNotMatch(sql, /UPDATE vehicle_service_records/i);
});
```

- [ ] **Step 2: Run to verify FAIL** — `cd /home/tdpotato/projects/InventoryPro/apps/api && node --import tsx --test src/db/migrationSql.test.ts` → new test FAILS (ENOENT).

- [ ] **Step 3: Create `apps/api/src/db/migrations/066_receipt_fields.sql`:**

```sql
-- Migration 066: gas-receipt fields on service records (#168). Mirrors mobile 054.
-- A gas receipt is a type='fuel_up' service record — odometer/cost/history reuse.
--   payer:  'Teams' | 'Office' | ... from app_config key gas_receipt_payers
--           (adjustable list; TEXT, never a PG enum)
--   job_id: optional job, soft FK (style of vehicle_checkouts.job_id — no constraint)
-- Both nullable; existing records untouched (no backfill, no watermark bump).
ALTER TABLE vehicle_service_records ADD COLUMN IF NOT EXISTS payer TEXT;
ALTER TABLE vehicle_service_records ADD COLUMN IF NOT EXISTS job_id UUID;
```

- [ ] **Step 4: Run to verify PASS** — same command, whole file green.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/migrations/066_receipt_fields.sql apps/api/src/db/migrationSql.test.ts
git commit -m "feat(#168): API migration 066 — payer + job_id on service records

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Mobile migration 054_receipt_fields.ts + registration + sql.js test

**Files:**
- Create: `apps/mobile/src/db/migrations/054_receipt_fields.ts`
- Create: `apps/mobile/src/db/migrations/054_receipt_fields.test.ts`
- Modify: `apps/mobile/src/db/schema.ts`, `apps/mobile/src/db/schema.web.ts` (same registration spots as Task 2)

**Interfaces:**
- Produces: SQLite columns `vehicle_service_records.payer TEXT NULL`, `job_id TEXT NULL`.

- [ ] **Step 1: Write the failing test** — create `054_receipt_fields.test.ts`:

```ts
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqlJsDb } from './sqljsTestDb';
import { migration } from './054_receipt_fields';
import type { SqlDb } from '../types';

let db: SqlDb;
before(async () => {
  db = await makeSqlJsDb();
  // Pre-054 vehicle_service_records shape (042 DDL, condensed).
  db.executeSync(`CREATE TABLE vehicle_service_records (
    id TEXT PRIMARY KEY, vehicle_location_id TEXT NOT NULL, target TEXT NOT NULL,
    event_date TEXT NOT NULL, type TEXT NOT NULL, notes TEXT, odometer INTEGER,
    cost REAL, created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    synced_at TEXT
  )`);
  db.executeSync(`INSERT INTO vehicle_service_records (id, vehicle_location_id, target, event_date, type, created_at, updated_at)
    VALUES ('r-1', 'v-1', 'vehicle', '2026-07-01', 'fuel_up', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')`);
  migration.up(db);
});

test('054: payer and job_id exist, nullable, defaulting NULL', () => {
  const r = db.executeSync(`SELECT payer, job_id FROM vehicle_service_records WHERE id = 'r-1'`).rows[0] as { payer: string | null; job_id: string | null };
  assert.equal(r.payer, null);
  assert.equal(r.job_id, null);
});

test('054: updated_at untouched (no watermark bump)', () => {
  const r = db.executeSync(`SELECT updated_at FROM vehicle_service_records WHERE id = 'r-1'`).rows[0] as { updated_at: string };
  assert.equal(r.updated_at, '2026-07-01T00:00:00.000Z');
});
```

- [ ] **Step 2: Run to verify FAIL** — `cd /home/tdpotato/projects/InventoryPro/apps/mobile && node --import tsx --import ./src/test/setupGlobals.mjs --test src/db/migrations/054_receipt_fields.test.ts` → FAIL (module missing).

- [ ] **Step 3: Create `apps/mobile/src/db/migrations/054_receipt_fields.ts`:**

```ts
import type { SqlDb } from '../types';

// Migration 054: gas-receipt fields (#168). Mirrors API 066. SYNCED columns
// (docs/SYNC-MIGRATION-CHECKLIST.md — pull.ts + createServiceRecord extended in
// the same change). payer from app_config gas_receipt_payers; job_id soft FK.
export const migration = {
  version: 54,
  up: (db: SqlDb): void => {
    db.executeSync(`ALTER TABLE vehicle_service_records ADD COLUMN payer TEXT`);
    db.executeSync(`ALTER TABLE vehicle_service_records ADD COLUMN job_id TEXT`);
  },
};
```

- [ ] **Step 4: Run to verify PASS.**

- [ ] **Step 5: Register in BOTH schemas** — `schema.ts`: import `m054` after `m053`, append to array; `schema.web.ts`: `import('./migrations/054_receipt_fields'),` after the 053 line.

- [ ] **Step 6: Typecheck** — `npx tsc --noEmit` in `apps/mobile` → clean.

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/src/db/migrations/054_receipt_fields.ts apps/mobile/src/db/migrations/054_receipt_fields.test.ts apps/mobile/src/db/schema.ts apps/mobile/src/db/schema.web.ts
git commit -m "feat(#168): mobile migration 054 — receipt fields (schema.ts + schema.web.ts)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: API sync — column lists + media entity type 'service_record'

**Files:**
- Modify: `apps/api/src/lib/syncPolicy.ts` (line 229 `MEDIA_ENTITY_TYPES`; line 488 `VEHICLES_COLS`; line 489 `VEHICLE_SERVICE_RECORDS_BASE`)
- Test: `apps/api/src/lib/syncPolicy.test.ts` (append)

**Interfaces:**
- Consumes: columns from Tasks 1/3.
- Produces: pull/full-download for `vehicles` carries `debris_option, debris_level, open_checkout, locked_by`; `vehicle_service_records` carries `payer, job_id` in BASE (NOT financial-gated; `cost` stays gated). Media presign/save/list/sync accept `entity_type='service_record'`.

- [ ] **Step 1: Write the failing tests** — append to `syncPolicy.test.ts`:

```ts
// ── Phase 0 (#152/#155/#167/#168): vehicles wave sync surface ────────────────

test('media INSERT: service_record is an allowed entity type', () => {
  assert.ok(MEDIA_ENTITY_TYPES.has('service_record'));
  const err = validateMediaWrite('INSERT', {
    entity_type: 'service_record',
    entity_id: '9c9e2c1a-0000-4000-8000-000000000001',
    url: 'https://x/media/service_record/9c9e2c1a-0000-4000-8000-000000000001/a.jpg',
  });
  assert.equal(err, null);
});

test('vehicles + service-record col lists carry the phase-0 columns (source-text)', () => {
  const src = readFileSync(join(dirname(new URL(import.meta.url).pathname), 'syncPolicy.ts'), 'utf8');
  for (const col of ['debris_option', 'debris_level', 'open_checkout', 'locked_by']) {
    assert.ok(src.includes(col), `VEHICLES_COLS missing ${col}`);
  }
  const base = src.match(/const VEHICLE_SERVICE_RECORDS_BASE = '([^']+)'/)?.[1] ?? '';
  assert.ok(base.includes('payer'), 'BASE missing payer');
  assert.ok(base.includes('job_id'), 'BASE missing job_id');
  assert.ok(!base.includes('cost'), 'cost must stay financial-gated, not in BASE');
});
```

(If `syncPolicy.test.ts` lacks `readFileSync`/`join`/`dirname` imports, add them; `MEDIA_ENTITY_TYPES` and `validateMediaWrite` are already exported. If the test file is CommonJS-compiled like `migrationSql.test.ts`, use `__dirname` instead of `import.meta`.)

- [ ] **Step 2: Run to verify FAIL** — `cd /home/tdpotato/projects/InventoryPro/apps/api && node --import tsx --test src/lib/syncPolicy.test.ts` → both new tests FAIL.

- [ ] **Step 3: Implement** — in `syncPolicy.ts`:

Line 229, add `'service_record'`:

```ts
export const MEDIA_ENTITY_TYPES = new Set(['item', 'equipment_unit', 'job', 'location', 'repair', 'activity_log', 'message', 'pool', 'service_record']);
```

Lines 488–489:

```ts
const VEHICLES_COLS = 'location_id, truck_mount, water_state, model, model_id, notes, updated_at, water_tank, waste_tank, checkout_locked, debris_option, debris_level, open_checkout, locked_by';
const VEHICLE_SERVICE_RECORDS_BASE = 'id, vehicle_location_id, target, event_date, type, notes, odometer, created_by, created_at, updated_at, payer, job_id';
```

- [ ] **Step 4: Run to verify PASS**, then the whole API suite: `cd /home/tdpotato/projects/InventoryPro/apps/api && pnpm test` → all green (baseline 411+).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/syncPolicy.ts apps/api/src/lib/syncPolicy.test.ts
git commit -m "feat(#152,#155,#167,#168): sync phase-0 vehicle columns + service_record media type

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Mobile sync — pull.ts upserts + rowToValues + pullColumns tests

**Files:**
- Modify: `apps/mobile/src/sync/pull.ts` (lines 32–33 `TABLE_UPSERT_SQL`; lines 68, 71 `rowToValues`)
- Test: `apps/mobile/src/sync/pullColumns.test.ts` (append)

**Interfaces:**
- Consumes: server columns from Task 5, SQLite columns from Tasks 2/4.
- Produces: pulled vehicles/service-record rows land with the new columns; the arity guard covers them.

- [ ] **Step 1: Write the failing tests** — append to `pullColumns.test.ts` (same idiom as the `checkout_locked` test at line ~98):

```ts
// Migrations 053/054 / API 065/066 (phase 0, #152/#155/#167/#168): vehicles
// gained four option columns and service records gained receipt fields — the
// same "added a column to a synced table" trap as checkout_locked above.
test('vehicles syncs the phase-0 option columns', () => {
  const vehicles = upsertStatements().find(s => s.table === 'vehicles');
  assert.ok(vehicles, 'no vehicles upsert');
  for (const col of ['debris_option', 'debris_level', 'open_checkout', 'locked_by']) {
    assert.ok(vehicles.cols.includes(col), `vehicles upsert is missing ${col}`);
  }
});

test('vehicle_service_records syncs payer and job_id', () => {
  const recs = upsertStatements().find(s => s.table === 'vehicle_service_records');
  assert.ok(recs, 'no vehicle_service_records upsert');
  assert.ok(recs.cols.includes('payer'), 'missing payer');
  assert.ok(recs.cols.includes('job_id'), 'missing job_id');
});
```

- [ ] **Step 2: Run to verify FAIL** — `cd /home/tdpotato/projects/InventoryPro/apps/mobile && node --import tsx --import ./src/test/setupGlobals.mjs --test src/sync/pullColumns.test.ts`.

- [ ] **Step 3: Implement** — in `pull.ts`:

Line 32 (vehicles upsert — append 4 columns and 4 placeholders):

```ts
  vehicles: `INSERT OR REPLACE INTO vehicles (location_id, truck_mount, water_state, model, model_id, notes, updated_at, water_tank, waste_tank, checkout_locked, debris_option, debris_level, open_checkout, locked_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
```

Line 33 (service records — append 2):

```ts
  vehicle_service_records: `INSERT OR REPLACE INTO vehicle_service_records (id, vehicle_location_id, target, event_date, type, notes, odometer, cost, created_by, created_at, updated_at, payer, job_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
```

Line 68 (vehicles values — same order as the SQL):

```ts
    case 'vehicles': return [row.location_id, row.truck_mount ? 1 : 0, row.water_state ?? null, row.model ?? null, row.model_id ?? null, row.notes ?? null, row.updated_at, row.water_tank ?? 'empty', row.waste_tank ?? 'clean', row.checkout_locked ? 1 : 0, row.debris_option ? 1 : 0, row.debris_level ?? 0, row.open_checkout ? 1 : 0, row.locked_by ?? null];
```

Line 71 (service records):

```ts
    case 'vehicle_service_records': return [row.id, row.vehicle_location_id, row.target ?? 'vehicle', row.event_date, row.type, row.notes ?? null, row.odometer ?? null, row.cost ?? null, row.created_by ?? null, row.created_at, row.updated_at, row.payer ?? null, row.job_id ?? null];
```

- [ ] **Step 4: Run to verify PASS** — pullColumns file green (the arity assertions also re-validate every other table).

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/sync/pull.ts apps/mobile/src/sync/pullColumns.test.ts
git commit -m "feat(#152,#155,#167,#168): mobile pull carries phase-0 vehicle + receipt columns

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: queries/vehicles.ts — types, upsert, locked_by stamping (pure helper), createServiceRecord fields

**Files:**
- Modify: `apps/mobile/src/components/vehicles/vehicleSessionLogic.ts` (add pure helper)
- Test: `apps/mobile/src/components/vehicles/vehicleSessionLogic.test.ts` (append)
- Modify: `apps/mobile/src/db/queries/vehicles.ts` (`VehicleRow` :37, `VehicleServiceRecord` :51, `VehicleStatePatch` :92, `upsertVehicleState` :108–136, `createServiceRecord` :196–224)

**Interfaces:**
- Consumes: SQLite columns (Tasks 2/4).
- Produces: `resolveLockStamp(patch: { checkout_locked?: number }, existing: { checkout_locked: number; locked_by: string | null } | null, userId: string | null): string | null` — later phases (#167 UI) rely on `locked_by` being populated from here on. `VehicleStatePatch` gains `debris_option?`, `debris_level?`, `open_checkout?`. `createServiceRecord` input gains `payer?: string | null`, `jobId?: string | null`.

- [ ] **Step 1: Write the failing tests** — append to `vehicleSessionLogic.test.ts`:

```ts
// ── #167: locked_by stamping (phase 0 — write plumbing only, rule comes later)
import { resolveLockStamp } from './vehicleSessionLogic';

test('resolveLockStamp: 0→1 stamps the acting user', () => {
  assert.equal(resolveLockStamp({ checkout_locked: 1 }, { checkout_locked: 0, locked_by: null }, 'u-1'), 'u-1');
  assert.equal(resolveLockStamp({ checkout_locked: 1 }, null, 'u-1'), 'u-1');
});

test('resolveLockStamp: 1→1 keeps the original locker', () => {
  assert.equal(resolveLockStamp({ checkout_locked: 1 }, { checkout_locked: 1, locked_by: 'u-orig' }, 'u-2'), 'u-orig');
});

test('resolveLockStamp: 1→1 legacy lock (NULL locker) adopts the acting user', () => {
  assert.equal(resolveLockStamp({ checkout_locked: 1 }, { checkout_locked: 1, locked_by: null }, 'u-2'), 'u-2');
});

test('resolveLockStamp: →0 clears; untouched patch carries existing', () => {
  assert.equal(resolveLockStamp({ checkout_locked: 0 }, { checkout_locked: 1, locked_by: 'u-orig' }, 'u-2'), null);
  assert.equal(resolveLockStamp({}, { checkout_locked: 1, locked_by: 'u-orig' }, 'u-2'), 'u-orig');
  assert.equal(resolveLockStamp({}, null, 'u-2'), null);
});
```

- [ ] **Step 2: Run to verify FAIL** — `cd /home/tdpotato/projects/InventoryPro/apps/mobile && node --import tsx --import ./src/test/setupGlobals.mjs --test src/components/vehicles/vehicleSessionLogic.test.ts` → new tests FAIL (no export).

- [ ] **Step 3: Implement the helper** — append to `vehicleSessionLogic.ts`:

```ts
/**
 * #167 phase 0: who holds the lock after applying `patch`.
 * 0→1 stamps the acting user; 1→1 keeps the original locker (a legacy NULL
 * locker adopts the actor); →0 clears; a patch not touching checkout_locked
 * carries the existing stamp. The unlock RULE (tier comparison) is the #167
 * UI phase — this is write plumbing only.
 */
export function resolveLockStamp(
  patch: { checkout_locked?: number },
  existing: { checkout_locked: number; locked_by: string | null } | null,
  userId: string | null,
): string | null {
  if (patch.checkout_locked === undefined) return existing?.locked_by ?? null;
  if (!patch.checkout_locked) return null;
  if (existing?.checkout_locked) return existing.locked_by ?? userId;
  return userId;
}
```

- [ ] **Step 4: Run to verify PASS.**

- [ ] **Step 5: Wire `queries/vehicles.ts`** (no separate test — covered by the pure helper tests + pullColumns + tsc):

`VehicleRow` gains (after `checkout_locked` at line 46):

```ts
  debris_option: number; // 0/1 (#152): vehicle has the debris tracker
  debris_level: number; // 0-100 (#152)
  open_checkout: number; // 0/1 (#155): owner-assigned vehicle opted into general checkout
  locked_by: string | null; // UUID (#167): who set checkout_locked; NULL = legacy lock
```

`VehicleServiceRecord` gains (after `cost` at line 59):

```ts
  payer: string | null; // #168: gas-receipt payer from app_config gas_receipt_payers
  job_id: string | null; // #168: optional job (soft FK)
```

`VehicleStatePatch` gains:

```ts
  debris_option?: number; // #152
  debris_level?: number; // #152 (0-100; UI clamps)
  open_checkout?: number; // #155: owner opt-in toggle
```

`upsertVehicleState` — import `resolveLockStamp` from `../../components/vehicles/vehicleSessionLogic`; in `merged` add after `checkout_locked`:

```ts
      debris_option: patch.debris_option ?? existing?.debris_option ?? 0,
      debris_level: patch.debris_level ?? existing?.debris_level ?? 0,
      open_checkout: patch.open_checkout ?? existing?.open_checkout ?? 0,
      locked_by: resolveLockStamp(patch, existing, userId),
```

and extend the INSERT SQL + bind list (4 new columns appended, same order):

```ts
      `INSERT OR REPLACE INTO vehicles (location_id, truck_mount, water_state, model, model_id, notes, updated_at, synced_at, water_tank, waste_tank, checkout_locked, debris_option, debris_level, open_checkout, locked_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
      bindParams([merged.location_id, merged.truck_mount, merged.water_state, merged.model, merged.model_id, merged.notes, merged.updated_at, merged.water_tank, merged.waste_tank, merged.checkout_locked, merged.debris_option, merged.debris_level, merged.open_checkout, merged.locked_by]),
```

(The outbox `row` spread already picks up the four new fields from `merged` — no outbox change.)

`createServiceRecord` — input gains `payer?: string | null; jobId?: string | null;`; add `const payer = input.payer ?? null; const jobId = input.jobId ?? null;`, extend the INSERT to `(..., payer, job_id, synced_at) VALUES (..., ?, ?, NULL)` with `payer, jobId` appended to `bindParams`, and add `payer, job_id: jobId` to the `appendOutbox` object.

- [ ] **Step 6: Typecheck + affected suites** — `npx tsc --noEmit` in `apps/mobile`, then re-run `vehicleSessionLogic.test.ts` and `pullColumns.test.ts` → green.

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/src/components/vehicles/vehicleSessionLogic.ts apps/mobile/src/components/vehicles/vehicleSessionLogic.test.ts apps/mobile/src/db/queries/vehicles.ts
git commit -m "feat(#152,#155,#167,#168): vehicle row types + locked_by stamping + receipt fields on createServiceRecord

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: gas_receipt_payers config module (hiddenFields pattern)

**Files:**
- Create: `apps/mobile/src/db/gasReceiptPayers.ts`
- Create: `apps/mobile/src/db/gasReceiptPayers.logic.ts` (pure — importable under node without op-sqlite)
- Test: `apps/mobile/src/db/gasReceiptPayers.logic.test.ts`

**Interfaces:**
- Consumes: `getAppConfig`/`setAppConfigLocal` from `./appConfig`, `appendOutbox` from `../sync/outbox` (same as `hiddenFields.ts`).
- Produces: `DEFAULT_GAS_RECEIPT_PAYERS`, `parseGasReceiptPayers(raw: string | null): string[]`, `getGasReceiptPayers(): string[]`, `setGasReceiptPayers(list: string[]): void`, `subscribeGasReceiptPayers`/`getGasReceiptPayersVersion`/`notifyGasReceiptPayersChanged`. The #168 UI phase consumes these verbatim.

- [ ] **Step 1: Write the failing test** — create `gasReceiptPayers.logic.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGasReceiptPayers, DEFAULT_GAS_RECEIPT_PAYERS } from './gasReceiptPayers.logic';

test('missing key falls back to the code default (no seed row — watermark trap)', () => {
  assert.deepEqual(parseGasReceiptPayers(null), DEFAULT_GAS_RECEIPT_PAYERS);
  assert.deepEqual(DEFAULT_GAS_RECEIPT_PAYERS, ['Teams', 'Office', 'Contents', 'Construction']);
});

test('valid JSON array of strings is honored verbatim (adjustable list)', () => {
  assert.deepEqual(parseGasReceiptPayers('["Fleet","Office"]'), ['Fleet', 'Office']);
});

test('garbage falls back to the default', () => {
  assert.deepEqual(parseGasReceiptPayers('not json'), DEFAULT_GAS_RECEIPT_PAYERS);
  assert.deepEqual(parseGasReceiptPayers('{"a":1}'), DEFAULT_GAS_RECEIPT_PAYERS);
  assert.deepEqual(parseGasReceiptPayers('[1,2]'), DEFAULT_GAS_RECEIPT_PAYERS);
  assert.deepEqual(parseGasReceiptPayers('[]'), DEFAULT_GAS_RECEIPT_PAYERS);
});
```

- [ ] **Step 2: Run to verify FAIL** — `cd /home/tdpotato/projects/InventoryPro/apps/mobile && node --import tsx --import ./src/test/setupGlobals.mjs --test src/db/gasReceiptPayers.logic.test.ts`.

- [ ] **Step 3: Create `gasReceiptPayers.logic.ts`** (pure):

```ts
// #168: payer list parsing for gas receipts. Pure module — no db imports — so
// node tests can exercise it (op-sqlite can't load under node).

export const DEFAULT_GAS_RECEIPT_PAYERS = ['Teams', 'Office', 'Contents', 'Construction'];

/**
 * Parse the app_config gas_receipt_payers value. The default lives HERE, in
 * code, applied when the key is absent/invalid/empty — deliberately NOT seeded
 * by a migration (seeded rows miss enrolled devices via incremental pull).
 */
export function parseGasReceiptPayers(raw: string | null): string[] {
  try {
    if (!raw) return DEFAULT_GAS_RECEIPT_PAYERS;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return DEFAULT_GAS_RECEIPT_PAYERS;
    const valid = parsed.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
    return valid.length > 0 ? valid : DEFAULT_GAS_RECEIPT_PAYERS;
  } catch {
    return DEFAULT_GAS_RECEIPT_PAYERS;
  }
}
```

- [ ] **Step 4: Run to verify PASS.**

- [ ] **Step 5: Create `gasReceiptPayers.ts`** (db-facing twin of `hiddenFields.ts`):

```ts
import { getAppConfig, setAppConfigLocal } from './appConfig';
import { appendOutbox } from '../sync/outbox';
import { parseGasReceiptPayers } from './gasReceiptPayers.logic';

const GAS_RECEIPT_PAYERS_KEY = 'gas_receipt_payers';

// Version counter + listeners for sync reactivity (same pattern as
// hiddenFields.ts / permissions.ts). notifyGasReceiptPayersChanged is called:
// (a) by the settings screen after a save commit (#168 UI phase), and (b) by
// the sync engine after a pull.
let cacheVersion = 0;
const listeners = new Set<() => void>();

export function subscribeGasReceiptPayers(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function getGasReceiptPayersVersion(): number {
  return cacheVersion;
}

export function notifyGasReceiptPayersChanged(): void {
  cacheVersion++;
  listeners.forEach(l => l());
}

/** Current payer list; code default when the key is absent (never seeded). */
export function getGasReceiptPayers(): string[] {
  return parseGasReceiptPayers(getAppConfig(GAS_RECEIPT_PAYERS_KEY));
}

/**
 * Persist the full list and push through the outbox. Call
 * notifyGasReceiptPayersChanged() after the enclosing transaction commits.
 */
export function setGasReceiptPayers(list: string[]): void {
  const value = JSON.stringify(list);
  setAppConfigLocal(GAS_RECEIPT_PAYERS_KEY, value);
  appendOutbox('INSERT', 'app_config', {
    key: GAS_RECEIPT_PAYERS_KEY,
    value,
    updated_at: new Date().toISOString(),
  });
}
```

- [ ] **Step 6: Typecheck** — `npx tsc --noEmit` in `apps/mobile` → clean. (The sync-engine notify hookup mirrors hiddenFields and lands with the #168 UI phase — this phase ships the module only, so nothing imports it yet; `tsc` still compiles it.)

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/src/db/gasReceiptPayers.ts apps/mobile/src/db/gasReceiptPayers.logic.ts apps/mobile/src/db/gasReceiptPayers.logic.test.ts
git commit -m "feat(#168): gas_receipt_payers config module (code default, hiddenFields pattern)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Phase-0 verification gate

**Files:** none (fix commits only if something breaks).

- [ ] **Step 1:** `cd /home/tdpotato/projects/InventoryPro/apps/api && pnpm test` → all pass (411+ baseline plus the new migrationSql/syncPolicy tests).
- [ ] **Step 2:** `cd /home/tdpotato/projects/InventoryPro/apps/mobile && pnpm test` → all pass (561+ baseline plus 053/054/lockStamp/payers tests).
- [ ] **Step 3:** `cd /home/tdpotato/projects/InventoryPro/apps/api && npx tsc --noEmit && cd ../mobile && npx tsc --noEmit` → both clean.
- [ ] **Step 4:** If anything was fixed, commit the named files only (**never `git add -A`** — board-skill edits are dirty): `git commit -m "test(#152,#155,#167,#168): phase-0 verification fixes"` + trailer.
- [ ] **Step 5:** Per CLAUDE.md: use the repo `start-metro` skill to launch Metro + adb reverse, hotload the dev client, and walk the device: open a vehicle → no crash; toggle a lock → re-open, still locked (locked_by now stamped, visible only in DB); vehicles list renders. Migration 053/054 runs on app open.
- [ ] **Step 6:** Report device-check results to the user; board items stay In progress (UI phases remain) — annotate #152/#155/#167/#168 with the landed commit range.

## Deploy note (for later, not this branch)

API deploy auto-applies 065/066 on boot; ship API + mobile in lockstep. `open_checkout=false` default drops owner-assigned vehicles from other users' checkout lists on deploy day — expected, communicate to the crew.
