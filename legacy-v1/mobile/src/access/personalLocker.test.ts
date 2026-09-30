import { createRequire } from 'node:module';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// personalLocker.ts can't load under `node --test` as-is: db/schema imports the
// native op-sqlite binding, utils/uuid imports react-native-get-random-values,
// and log.ts pulls telemetry (expo-constants / react-native). Same harness as
// access.test.ts / unitAccess.test.ts: intercept Module._load (tsx runs this
// package's TS as CommonJS, so ESM loader hooks would not see the transitive
// requires) and swap those for node-safe stand-ins — db/schema becomes a REAL
// sql.js database (locationsShelf.testdb.ts) — so these tests exercise the
// enable/disable orchestration end-to-end: locations find-or-create/reactivate/
// retire, outbox writes, and the unit_access grant with role defaults applied.
const requireCjs = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Module = requireCjs('node:module') as any;
const testDb = requireCjs('../db/queries/locationsShelf.testdb') as typeof import('../db/queries/locationsShelf.testdb');

const origLoad = Module._load;
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  // Side-effect-only crypto polyfill; node already has crypto.getRandomValues.
  if (request === 'react-native-get-random-values') return {};
  // The GPS-stamping log path (#33) transitively imports expo-location, which
  // pulls in expo / expo-modules-core / react-native — none of which parse under
  // tsx/esbuild (react-native/index.js is Flow-typed) or run outside Metro. These
  // tests never exercise GPS, so hand back a benign no-op stub for each; every
  // property access returns a no-op fn so any polyfill init on load stays inert.
  if (request === 'react-native' || request === 'expo' || request === 'expo-modules-core') {
    return new Proxy({ __esModule: true }, { get: (_t, p) => (p === '__esModule' ? true : () => {}) });
  }
  let resolved = '';
  try { resolved = Module._resolveFilename(request, parent); } catch { /* not ours — fall through */ }
  if (resolved.endsWith('/src/db/schema.ts')) return testDb;
  if (resolved.endsWith('/src/telemetry/index.ts')) return { track() {} };
  return origLoad.call(this, request, parent, isMain);
};

let pl: typeof import('./personalLocker');

function db() { return testDb.getDb(); }

function lockerRow(id: string): Record<string, unknown> {
  return db().executeSync(`SELECT * FROM locations WHERE id = ?`, [id]).rows[0] as Record<string, unknown>;
}

function ownedLockers(userId: string): Record<string, unknown>[] {
  return db().executeSync(
    `SELECT * FROM locations WHERE type = 'Locker' AND owner_user_id = ?`, [userId],
  ).rows as Record<string, unknown>[];
}

function lastLocationsOutbox(): { operation: string; payload: Record<string, unknown> } {
  const rows = db().executeSync(
    `SELECT * FROM outbox WHERE table_name = 'locations' ORDER BY created_at, rowid`,
  ).rows as { operation: string; payload: string }[];
  const last = rows[rows.length - 1];
  return { operation: last.operation, payload: JSON.parse(last.payload) as Record<string, unknown> };
}

before(async () => {
  await testDb.initTestDb();
  // initTestDb creates locations/taxonomy_types/inventory_items/stock_by_location/
  // outbox; add the tables the grant path (upsertUnitAccess → appendLog) and the
  // role-defaults template (app_config) read/write.
  db().executeSync(`
    CREATE TABLE unit_access (
      location_id TEXT NOT NULL, user_id TEXT NOT NULL,
      can_view INTEGER NOT NULL DEFAULT 1, can_add INTEGER NOT NULL DEFAULT 0,
      can_remove INTEGER NOT NULL DEFAULT 0, can_move INTEGER NOT NULL DEFAULT 0,
      can_edit_details INTEGER NOT NULL DEFAULT 0, can_grant INTEGER NOT NULL DEFAULT 0,
      granted_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, synced_at TEXT,
      PRIMARY KEY (location_id, user_id)
    );
    CREATE TABLE activity_log (
      id TEXT PRIMARY KEY, user_id TEXT, team_id TEXT, action TEXT NOT NULL,
      entity_type TEXT NOT NULL, entity_id TEXT, from_location_id TEXT, to_location_id TEXT,
      quantity REAL, unit TEXT, job_id TEXT, note TEXT, metadata TEXT, device_id TEXT,
      created_at TEXT NOT NULL, synced_at TEXT, latitude REAL, longitude REAL, location_accuracy REAL
    );
    CREATE TABLE app_config (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT);
  `);
  // Admin-configured defaults for mitigation_technician deviate from
  // FALLBACK_ACTIONS (remove/move true there) so the grant row proves the ROLE
  // template was applied, not the fallback.
  db().executeSync(
    `INSERT INTO app_config (key, value, updated_at) VALUES ('unit_access_defaults', ?, '2026-07-19T00:00:00.000Z')`,
    [JSON.stringify({ mitigation_technician: { view: true, add: true, remove: false, move: false, editDetails: false, grant: false } })],
  );
  pl = requireCjs('./personalLocker') as typeof import('./personalLocker');
});

test('enable creates an owned Locker named after the user, queues an outbox INSERT, and applies role defaults', () => {
  const res = pl.enablePersonalLocker('user-1', 'Frank', 'mitigation_technician', 'admin-1');
  assert.ok(res.ok, 'enable must succeed');
  const lockerId = (res as { ok: true; lockerId: string }).lockerId;
  assert.ok(lockerId, 'a locker id is returned');

  const row = lockerRow(lockerId);
  assert.equal(row.type, 'Locker');
  assert.equal(row.owner_user_id, 'user-1');
  assert.equal(row.active, 1);
  assert.equal(row.name, "Frank's Locker");

  const { operation, payload } = lastLocationsOutbox();
  assert.equal(operation, 'INSERT');
  assert.equal(payload.owner_user_id, 'user-1');
  assert.equal(payload.type, 'Locker');
  assert.equal(payload.active, true);

  // Grant carries the role's configured defaults (remove/move OFF — fallback
  // would have them ON), attributed to the actor.
  const grant = db().executeSync(
    `SELECT * FROM unit_access WHERE location_id = ? AND user_id = 'user-1'`, [lockerId],
  ).rows[0] as Record<string, unknown>;
  assert.ok(grant, 'a unit_access grant row was created');
  assert.equal(grant.can_view, 1);
  assert.equal(grant.can_add, 1);
  assert.equal(grant.can_remove, 0);
  assert.equal(grant.can_move, 0);
  assert.equal(grant.granted_by, 'admin-1');
});

test('enable is idempotent while the locker is active — same id, no duplicate, existing grant untouched', () => {
  const first = pl.getPersonalLocker('user-1');
  assert.ok(first, 'user-1 has an active personal locker');
  // Admin customized the grant since — re-enabling must not clobber it back to defaults.
  db().executeSync(`UPDATE unit_access SET can_add = 0 WHERE location_id = ? AND user_id = 'user-1'`, [first!.id]);

  const res = pl.enablePersonalLocker('user-1', 'Frank', 'mitigation_technician', 'admin-1');
  assert.ok(res.ok);
  assert.equal((res as { ok: true; lockerId: string }).lockerId, first!.id);
  assert.equal(ownedLockers('user-1').length, 1, 'no duplicate locker created');
  const grant = db().executeSync(
    `SELECT can_add FROM unit_access WHERE location_id = ? AND user_id = 'user-1'`, [first!.id],
  ).rows[0] as { can_add: number };
  assert.equal(grant.can_add, 0, 'customized grant survives a redundant enable');
});

test('enable reactivates an inactive owned locker instead of creating a duplicate', () => {
  const on = pl.enablePersonalLocker('user-2', 'Dana', 'mitigation_technician', 'admin-1');
  assert.ok(on.ok);
  const lockerId = (on as { ok: true; lockerId: string }).lockerId!;
  const off = pl.disablePersonalLocker('user-2');
  assert.ok(off.ok, 'empty locker retires cleanly');
  assert.equal(lockerRow(lockerId).active, 0);

  const again = pl.enablePersonalLocker('user-2', 'Dana', 'mitigation_technician', 'admin-1');
  assert.ok(again.ok);
  assert.equal((again as { ok: true; lockerId: string }).lockerId, lockerId, 'retired locker is reactivated, not duplicated');
  assert.equal(ownedLockers('user-2').length, 1);
  assert.equal(lockerRow(lockerId).active, 1);
  const { operation, payload } = lastLocationsOutbox();
  assert.equal(operation, 'UPDATE');
  assert.equal(payload.id, lockerId);
  assert.equal(payload.active, true);
  assert.ok(typeof payload.updated_at === 'string', 'reactivation carries a fresh updated_at watermark');
});

test('disable refuses while the locker still holds stock — locker stays active', () => {
  const on = pl.enablePersonalLocker('user-3', 'Ravi', 'mitigation_technician', 'admin-1');
  assert.ok(on.ok);
  const lockerId = (on as { ok: true; lockerId: string }).lockerId!;
  db().executeSync(`INSERT INTO inventory_items (id, name, active) VALUES ('item-1', 'Dehumidifier', 1)`);
  db().executeSync(
    `INSERT INTO stock_by_location (item_id, location_id, quantity, updated_at) VALUES ('item-1', ?, 3, '2026-07-19T00:00:00.000Z')`,
    [lockerId],
  );

  const res = pl.disablePersonalLocker('user-3');
  assert.equal(res.ok, false, 'disable must refuse while stock is present');
  assert.match((res as { ok: false; reason: string }).reason, /stock/i, 'refusal reason mentions the stock');
  assert.equal(lockerRow(lockerId).active, 1, 'locker not retired');
});

test('disable retires an empty locker (active=0 outbox UPDATE, never a hard delete); qty-0 rows do not block', () => {
  const on = pl.enablePersonalLocker('user-4', 'Mia', 'mitigation_technician', 'admin-1');
  assert.ok(on.ok);
  const lockerId = (on as { ok: true; lockerId: string }).lockerId!;
  // A drained stock row (quantity 0) must not count as "stock present".
  db().executeSync(
    `INSERT INTO stock_by_location (item_id, location_id, quantity, updated_at) VALUES ('item-1', ?, 0, '2026-07-19T00:00:00.000Z')`,
    [lockerId],
  );

  const res = pl.disablePersonalLocker('user-4');
  assert.ok(res.ok, 'empty locker retires');
  assert.equal((res as { ok: true; lockerId: string | null }).lockerId, lockerId);
  const row = lockerRow(lockerId);
  assert.ok(row, 'row still exists — retired, not deleted');
  assert.equal(row.active, 0);
  const { operation, payload } = lastLocationsOutbox();
  assert.equal(operation, 'UPDATE');
  assert.deepEqual(
    { id: payload.id, active: payload.active },
    { id: lockerId, active: false },
  );
  assert.ok(typeof payload.updated_at === 'string', 'retire carries a fresh updated_at watermark');
  assert.equal(pl.getPersonalLocker('user-4'), null, 'toggle now reads OFF');
});

test('disable with no active locker is a no-op success', () => {
  const res = pl.disablePersonalLocker('nobody');
  assert.deepEqual(res, { ok: true, lockerId: null });
});

test('getPersonalLocker returns the active owned locker, or null when retired/absent', () => {
  const locker = pl.getPersonalLocker('user-1');
  assert.ok(locker);
  assert.equal(locker!.type, 'Locker');
  assert.equal(locker!.owner_user_id, 'user-1');
  assert.ok(pl.getPersonalLocker('user-2'), 'user-2 was re-enabled above so their locker reads ON');
  assert.equal(pl.getPersonalLocker('user-4'), null, 'user-4 retired theirs — reads OFF');
  assert.equal(pl.getPersonalLocker('nobody'), null);
});
