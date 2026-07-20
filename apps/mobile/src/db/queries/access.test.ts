import { createRequire } from 'node:module';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// access.ts can't load under `node --test` as-is: db/schema imports the
// native op-sqlite binding, utils/uuid imports react-native-get-random-values,
// and log.ts pulls telemetry (expo-constants / react-native). Same harness as
// locationsShelf.test.ts / unitAccess.test.ts: intercept Module._load (tsx runs
// this package's TS as CommonJS, so ESM loader hooks would not see the
// transitive requires) and swap those for node-safe stand-ins — db/schema
// becomes a REAL sql.js database (locationsShelf.testdb.ts) — so these tests
// exercise getAccessibleSourceLocations end-to-end against real tables.
const requireCjs = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Module = requireCjs('node:module') as any;
const testDb = requireCjs('./locationsShelf.testdb') as typeof import('./locationsShelf.testdb');

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

let access: typeof import('./access');

before(async () => {
  await testDb.initTestDb();
  // initTestDb creates locations/taxonomy_types/outbox; add the access tables.
  testDb.getDb().executeSync(`
    CREATE TABLE unit_access (
      location_id TEXT NOT NULL, user_id TEXT NOT NULL,
      can_view INTEGER NOT NULL DEFAULT 1, can_add INTEGER NOT NULL DEFAULT 0,
      can_remove INTEGER NOT NULL DEFAULT 0, can_move INTEGER NOT NULL DEFAULT 0,
      can_edit_details INTEGER NOT NULL DEFAULT 0, can_grant INTEGER NOT NULL DEFAULT 0,
      granted_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, synced_at TEXT,
      PRIMARY KEY (location_id, user_id)
    );
    CREATE TABLE locker_access (
      location_id TEXT NOT NULL, user_id TEXT NOT NULL, granted_by TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, synced_at TEXT,
      PRIMARY KEY (location_id, user_id)
    );
    CREATE TABLE team_members (
      team_id TEXT NOT NULL, user_id TEXT NOT NULL,
      is_manager INTEGER NOT NULL DEFAULT 0,
      subteam_id TEXT, subteam_role TEXT,
      PRIMARY KEY (team_id, user_id)
    );
  `);
  // All units ownerless so the ONLY route to access is an explicit grant —
  // isolates the grants source from the owned/teammate paths.
  testDb.getDb().executeSync(`
    INSERT INTO locations (id, name, type, owner_user_id, active, updated_at) VALUES
      ('lock-g',   'Granted Locker', 'Locker',  NULL, 1, '2026-07-19T00:00:00.000Z'),
      ('lock-nv',  'No-view Locker', 'Locker',  NULL, 1, '2026-07-19T00:00:00.000Z'),
      ('lock-old', 'Legacy Locker',  'Locker',  NULL, 1, '2026-07-19T00:00:00.000Z'),
      ('veh-g',    'Granted Van',    'Vehicle', NULL, 1, '2026-07-19T00:00:00.000Z');
    INSERT INTO unit_access (location_id, user_id, can_view, created_at, updated_at) VALUES
      ('lock-g',  'user-a', 1, '2026-07-19T00:00:00.000Z', '2026-07-19T00:00:00.000Z'),
      ('lock-nv', 'user-a', 0, '2026-07-19T00:00:00.000Z', '2026-07-19T00:00:00.000Z'),
      ('veh-g',   'user-a', 1, '2026-07-19T00:00:00.000Z', '2026-07-19T00:00:00.000Z');
    INSERT INTO locker_access (location_id, user_id, granted_by, created_at, updated_at) VALUES
      ('lock-old', 'user-a', 'owner-1', '2026-07-19T00:00:00.000Z', '2026-07-19T00:00:00.000Z');
  `);
  access = requireCjs('./access') as typeof import('./access');
});

test('day-to-day grants come from unit_access can_view=1, partitioned by type', () => {
  const acc = access.getAccessibleSourceLocations('user-a');
  assert.deepEqual(acc.lockers.map(l => l.id), ['lock-g']);
  assert.deepEqual(acc.vehicles.map(v => v.id), ['veh-g']);
});

test('a can_view=0 grant and a legacy locker_access-only row do not grant access', () => {
  const acc = access.getAccessibleSourceLocations('user-a');
  const ids = [...acc.lockers, ...acc.vehicles].map(l => l.id);
  assert.ok(!ids.includes('lock-nv'), 'can_view=0 must not grant day-to-day access');
  assert.ok(!ids.includes('lock-old'), 'deprecated locker_access must no longer be read');
});

test('#139: getCheckoutSourceLocations adds stock-holding main locations, keeps units', () => {
  const db = testDb.getDb();
  db.executeSync(`
    INSERT INTO locations (id, name, type, owner_user_id, active, updated_at) VALUES
      ('loc-shop',  'Main Shop',   'Shop',  NULL, 1, '2026-07-19T00:00:00.000Z'),
      ('loc-empty', 'Empty Bay',   'Shop',  NULL, 1, '2026-07-19T00:00:00.000Z'),
      ('loc-inact', 'Closed Yard', 'Shop',  NULL, 0, '2026-07-19T00:00:00.000Z');
    INSERT INTO inventory_items (id, name, active) VALUES ('it-1','Air mover',1);
    INSERT INTO stock_by_location (item_id, location_id, quantity, updated_at) VALUES
      ('it-1','loc-shop', 5, '2026-07-19T00:00:00.000Z'),
      ('it-1','lock-g',   2, '2026-07-19T00:00:00.000Z'),
      ('it-1','loc-inact',9, '2026-07-19T00:00:00.000Z');
  `);
  const src = access.getCheckoutSourceLocations('user-a');
  // #158: ALL active main locations — empty ones included (a restock can start
  // at an empty warehouse); still NOT inactive, NOT units.
  assert.deepEqual(src.locations.map(l => l.id).sort(), ['loc-empty', 'loc-shop']);
  // Unit partitions are unchanged (still the accessible locker/vehicle).
  assert.deepEqual(src.lockers.map(l => l.id), ['lock-g']);
  assert.deepEqual(src.vehicles.map(v => v.id), ['veh-g']);
  // A Locker holding stock must NOT leak into the main-locations list.
  assert.ok(!src.locations.some(l => l.id === 'lock-g'), 'units never appear as main locations');
});

test('#157: every Vehicle is visible to everyone; Locker gating is unchanged', () => {
  const db = testDb.getDb();
  // owner-z shares NO team with user-a and grants nothing — pre-#157 both of
  // these would be invisible to user-a.
  db.executeSync(`
    INSERT INTO locations (id, name, type, owner_user_id, active, updated_at) VALUES
      ('veh-other',  'Unshared Van',    'Vehicle', 'owner-z', 1, '2026-07-20T00:00:00.000Z'),
      ('lock-other', 'Unshared Locker', 'Locker',  'owner-z', 1, '2026-07-20T00:00:00.000Z');
  `);
  const acc = access.getAccessibleSourceLocations('user-a');
  assert.deepEqual(acc.vehicles.map(v => v.id).sort(), ['veh-g', 'veh-other']);
  assert.ok(!acc.lockers.some(l => l.id === 'lock-other'), 'lockers stay access-gated');
  // The checkout picker inherits the full vehicle set.
  const src = access.getCheckoutSourceLocations('user-a');
  assert.deepEqual(src.vehicles.map(v => v.id).sort(), ['veh-g', 'veh-other']);
  // getVisibleUnits for a plain crew user (no tier authority, not a manager,
  // owns nothing): full vehicle census, lockers still accessible-only.
  const crew = {
    id: 'user-a', name: 'User A', role: 'construction_crew',
    permission_overrides: {}, pin_length_required: 4, active: 1, expires_at: null,
  } as import('../../auth/permissions').UserSession;
  const veh = access.getVisibleUnits(crew, 'Vehicle');
  assert.deepEqual(veh.units.map(v => v.id).sort(), ['veh-g', 'veh-other']);
  assert.equal(veh.showsAll, false);
  const lock = access.getVisibleUnits(crew, 'Locker');
  assert.ok(!lock.units.some(l => l.id === 'lock-other'), 'locker census unchanged for crew');
});

test('getTeamUnits: kernel-only set (owned ∪ granted ∪ teammate) — no #157 all-vehicles bypass', () => {
  const mkUser = (id: string) => ({
    id, name: id, role: 'construction_crew',
    permission_overrides: {}, pin_length_required: 4, active: 1, expires_at: null,
  } as import('../../auth/permissions').UserSession);

  // user-a holds a can_view grant on veh-g/lock-g only; owner-z's unshared
  // units must NOT leak in (the #157 bypass would have added veh-other).
  assert.deepEqual(access.getTeamUnits(mkUser('user-a'), 'Vehicle').map(v => v.id), ['veh-g']);
  assert.deepEqual(access.getTeamUnits(mkUser('user-a'), 'Locker').map(l => l.id), ['lock-g']);

  // Teammate path: user-b shares team-z with owner-z → owner-z's units become
  // accessible via the parent-team rule, filtered to the requested kind.
  testDb.getDb().executeSync(`
    INSERT INTO team_members (team_id, user_id, is_manager) VALUES
      ('team-z', 'user-b', 0),
      ('team-z', 'owner-z', 0);
  `);
  assert.deepEqual(access.getTeamUnits(mkUser('user-b'), 'Vehicle').map(v => v.id), ['veh-other']);
  assert.deepEqual(access.getTeamUnits(mkUser('user-b'), 'Locker').map(l => l.id), ['lock-other']);

  // A user with no grants, no owned units, and no team gets the empty set —
  // the Vehicles screen falls back to the All segment for them.
  assert.deepEqual(access.getTeamUnits(mkUser('user-nobody'), 'Vehicle'), []);
});

test('#162: getUnitInventoryLock — foreign-team unit locked; own/team/ownerless/main/perm-holder unlocked', () => {
  const db = testDb.getDb();
  // Tables the lock helper reads that the earlier tests didn't need.
  db.executeSync(`
    CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, role TEXT, permission_overrides TEXT);
    CREATE TABLE teams (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE role_settings (role TEXT PRIMARY KEY, permission_overrides TEXT);
    INSERT INTO users (id, name, role, permission_overrides) VALUES
      ('owner-z', 'Zed', 'construction_crew', '{}'),
      ('user-a',  'Ann', 'construction_crew', '{}'),
      ('user-ov', 'Ova', 'construction_crew', '{"manage_other_team_inventory":true}');
    INSERT INTO teams (id, name) VALUES ('team-z', 'Mitigation');
  `);
  const mkUser = (id: string, role = 'construction_crew') => ({
    id, name: id, role,
    permission_overrides: {}, pin_length_required: 4, active: 1, expires_at: null,
  } as import('../../auth/permissions').UserSession);

  // veh-other is owned by owner-z (team-z 'Mitigation'); user-a shares no team.
  const locked = access.getUnitInventoryLock(mkUser('user-a'), 'veh-other');
  assert.equal(locked.locked, true);
  assert.match(locked.reason!, /Team inventory/);
  assert.match(locked.reason!, /Mitigation/, 'the reason names the owning team');

  // Same team (user-b joined team-z in the earlier test), the owner, an
  // ownerless unit, a main location, and a null id are all unlocked.
  assert.equal(access.getUnitInventoryLock(mkUser('user-b'), 'veh-other').locked, false);
  assert.equal(access.getUnitInventoryLock(mkUser('owner-z'), 'veh-other').locked, false);
  assert.equal(access.getUnitInventoryLock(mkUser('user-a'), 'veh-g').locked, false);
  assert.equal(access.getUnitInventoryLock(mkUser('user-a'), 'loc-shop').locked, false);
  assert.equal(access.getUnitInventoryLock(mkUser('user-a'), null).locked, false);

  // Tier-4 role default and an explicit user override both unlock.
  assert.equal(access.getUnitInventoryLock(mkUser('user-a', 'full_admin'), 'veh-other').locked, false);
  assert.equal(
    access.getUnitInventoryLock(
      { ...mkUser('user-a'), permission_overrides: { manage_other_team_inventory: true } },
      'veh-other',
    ).locked,
    false,
  );

  // The user-id variant resolves role + overrides from the local users table.
  assert.equal(access.getUnitInventoryLockForUserId('user-a', 'veh-other').locked, true);
  assert.equal(access.getUnitInventoryLockForUserId('user-ov', 'veh-other').locked, false);
  assert.equal(access.getUnitInventoryLockForUserId('user-unknown', 'veh-other').locked, false);

  // A role_settings override grants it role-wide (server resolution order).
  db.executeSync(`INSERT INTO role_settings (role, permission_overrides) VALUES
    ('construction_crew', '{"manage_other_team_inventory":true}')`);
  assert.equal(access.getUnitInventoryLock(mkUser('user-a'), 'veh-other').locked, false);
  db.executeSync(`DELETE FROM role_settings WHERE role = 'construction_crew'`);
});
