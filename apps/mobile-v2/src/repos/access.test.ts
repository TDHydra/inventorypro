import { createRequire } from 'node:module';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// access.ts can't load under `node --test` as-is: db/schema imports the
// native op-sqlite binding. Same harness as teams.test.ts/locations.ts's
// dependents: swap db/schema for a REAL sql.js database (./testDb).
const requireCjs = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Module = requireCjs('node:module') as any;
const testDb = requireCjs('./testDb') as typeof import('./testDb');

const origLoad = Module._load;
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'react-native-get-random-values') return {};
  if (request === 'react-native' || request === 'expo' || request === 'expo-modules-core') {
    return new Proxy({ __esModule: true }, { get: (_t, p) => (p === '__esModule' ? true : () => {}) });
  }
  let resolved = '';
  try { resolved = Module._resolveFilename(request, parent); } catch { /* not ours — fall through */ }
  if (resolved.endsWith('/src/db/schema.ts')) return testDb;
  return origLoad.call(this, request, parent, isMain);
};

let access: typeof import('./access');

const NOW = '2026-09-01T00:00:00.000Z';

function seedUser(id: string, name: string, role = 'construction_crew', overrides: Record<string, boolean> = {}) {
  testDb.getDb().executeSync(
    `INSERT INTO users (id, name, role, pin_length_required, permission_overrides, active, created_at, updated_at)
     VALUES (?, ?, ?, 4, ?, 1, ?, ?)`,
    [id, name, role, JSON.stringify(overrides), NOW, NOW],
  );
}
function seedLocker(id: string, name: string, ownerUserId: string | null, active = 1) {
  testDb.getDb().executeSync(
    `INSERT INTO locations (id, name, parent_id, color, icon, owner_user_id, active, updated_at, synced_at, type, has_shelves)
     VALUES (?, ?, NULL, NULL, NULL, ?, ?, ?, NULL, 'Locker', 0)`,
    [id, name, ownerUserId, active, NOW],
  );
}
function seedTeam(id: string, name: string) {
  testDb.getDb().executeSync(
    `INSERT INTO teams (id, name, type, updated_at, synced_at) VALUES (?, ?, 'Construction', ?, NULL)`,
    [id, name, NOW],
  );
}
function seedMember(teamId: string, userId: string, isManager = 0) {
  testDb.getDb().executeSync(
    `INSERT INTO team_members (team_id, user_id, team_permission_overrides, added_by, joined_at, is_manager, updated_at)
     VALUES (?, ?, '{}', NULL, ?, ?, ?)`,
    [teamId, userId, NOW, isManager, NOW],
  );
}

before(async () => {
  await testDb.initTestDb([
    'unit_access', 'locations', 'users', 'teams', 'team_members', 'role_settings',
    'taxonomy_types', 'app_config', 'outbox',
  ]);
  access = requireCjs('./access') as typeof import('./access');

  seedUser('owner-1', 'Olivia');
  seedUser('grantee-1', 'Gary');
  seedUser('foreign-1', 'Fiona');
  seedUser('mgr-1', 'Mona', 'production_manager');
  seedLocker('locker-1', "Olivia's Locker", 'owner-1');
  // owner-1 + grantee-1 share a team — backs the getUnitInventoryLock
  // "unlocked for a teammate" case below; foreign-1 is deliberately left off
  // every team so it exercises the "locked" (no shared team) case.
  seedTeam('team-shared', 'Shared Team');
  seedMember('team-shared', 'owner-1');
  seedMember('team-shared', 'grantee-1');
});

// ── grant / revoke (no self-log) ────────────────────────────────────────────

test('upsertUnitAccess inserts locally + queues an outbox INSERT with RAW boolean flags', () => {
  access.upsertUnitAccess({
    location_id: 'locker-1', user_id: 'grantee-1',
    can_view: true, can_add: true, can_remove: false, can_move: false,
    can_edit_details: false, can_grant: false, granted_by: 'owner-1',
  });
  const row = testDb.getDb().executeSync(
    `SELECT can_view, can_add, can_remove FROM unit_access WHERE location_id = ? AND user_id = ?`,
    ['locker-1', 'grantee-1'],
  ).rows[0] as { can_view: number; can_add: number; can_remove: number };
  assert.equal(row.can_view, 1);
  assert.equal(row.can_add, 1);
  assert.equal(row.can_remove, 0);

  const ob = testDb.getDb().executeSync(
    `SELECT payload FROM outbox WHERE table_name='unit_access' AND operation='INSERT'`,
  ).rows[0] as { payload: string };
  const payload = JSON.parse(ob.payload) as Record<string, unknown>;
  assert.equal(payload.can_view, true, 'outbox payload keeps a RAW boolean, not 0/1');
  assert.equal(payload.can_add, true);
  assert.equal(payload.can_remove, false);
});

test('upsertUnitAccess is a no-self-log write — repos/access.ts never touches activity_log', () => {
  const before = testDb.getDb().executeSync(`SELECT COUNT(*) AS n FROM outbox WHERE table_name='activity_log'`).rows[0] as { n: number };
  access.upsertUnitAccess({
    location_id: 'locker-1', user_id: 'foreign-1',
    can_view: true, can_add: false, can_remove: false, can_move: false,
    can_edit_details: false, can_grant: false, granted_by: 'owner-1',
  });
  const after = testDb.getDb().executeSync(`SELECT COUNT(*) AS n FROM outbox WHERE table_name='activity_log'`).rows[0] as { n: number };
  assert.equal(after.n, before.n, 'caller owns the log write, not the repo');
});

test('upsertUnitAccess on an existing grant edits in place (INSERT OR REPLACE), no duplicate row', () => {
  const beforeCount = testDb.getDb().executeSync(`SELECT COUNT(*) AS n FROM unit_access WHERE location_id='locker-1' AND user_id='grantee-1'`).rows[0] as { n: number };
  access.upsertUnitAccess({
    location_id: 'locker-1', user_id: 'grantee-1',
    can_view: true, can_add: true, can_remove: true, can_move: false,
    can_edit_details: false, can_grant: false, granted_by: 'owner-1',
    created_at: NOW,
  });
  const afterCount = testDb.getDb().executeSync(`SELECT COUNT(*) AS n FROM unit_access WHERE location_id='locker-1' AND user_id='grantee-1'`).rows[0] as { n: number };
  assert.equal(afterCount.n, beforeCount.n);
  const row = testDb.getDb().executeSync(
    `SELECT can_remove, created_at FROM unit_access WHERE location_id='locker-1' AND user_id='grantee-1'`,
  ).rows[0] as { can_remove: number; created_at: string };
  assert.equal(row.can_remove, 1);
  assert.equal(row.created_at, NOW, 'caller-supplied created_at survives the edit');
});

test('revokeUnitAccess deletes the row and queues an outbox DELETE', () => {
  access.upsertUnitAccess({
    location_id: 'locker-1', user_id: 'foreign-1',
    can_view: true, can_add: false, can_remove: false, can_move: false,
    can_edit_details: false, can_grant: false, granted_by: 'owner-1',
  });
  access.revokeUnitAccess('locker-1', 'foreign-1');
  const row = testDb.getDb().executeSync(
    `SELECT 1 AS x FROM unit_access WHERE location_id='locker-1' AND user_id='foreign-1'`,
  ).rows[0];
  assert.equal(row, undefined);
  const ob = testDb.getDb().executeSync(
    `SELECT payload FROM outbox WHERE table_name='unit_access' AND operation='DELETE' ORDER BY rowid DESC LIMIT 1`,
  ).rows[0] as { payload: string };
  const payload = JSON.parse(ob.payload) as Record<string, unknown>;
  assert.equal(payload.location_id, 'locker-1');
  assert.equal(payload.user_id, 'foreign-1');
});

test('grantUnitAccessWithDefaults applies FALLBACK_ACTIONS (no admin template configured)', () => {
  access.grantUnitAccessWithDefaults('locker-1', 'foreign-1', 'construction_crew', 'owner-1');
  const perms = access.getUserUnitPerms('foreign-1', 'locker-1');
  assert.deepEqual(perms, { view: true, add: true, remove: true, move: true, editDetails: false, grant: false });
});

// ── reads ────────────────────────────────────────────────────────────────

test('getUnitAccessRows joins the grantee name, ordered by name', () => {
  const rows = access.getUnitAccessRows('locker-1');
  assert.ok(rows.every(r => r.user_name));
  const names = rows.map(r => r.user_name);
  assert.deepEqual([...names].sort(), names);
});

test('getUserUnitPerms returns all-false for a user with no grant row (fail closed)', () => {
  seedUser('nobody-1', 'Nobody');
  const perms = access.getUserUnitPerms('nobody-1', 'locker-1');
  assert.deepEqual(perms, { view: false, add: false, remove: false, move: false, editDetails: false, grant: false });
});

test('getUserUnitGrants returns only active-unit grants for that user, joined with the unit', () => {
  const grants = access.getUserUnitGrants('grantee-1');
  assert.equal(grants.length, 1);
  assert.equal(grants[0].location_name, "Olivia's Locker");
  assert.equal(grants[0].location_type, 'Locker');
});

test('getAllUnitAccessGrants only returns grants on active Locker units', () => {
  seedLocker('locker-retired', 'Retired Locker', 'owner-1', 0);
  access.upsertUnitAccess({
    location_id: 'locker-retired', user_id: 'grantee-1',
    can_view: true, can_add: false, can_remove: false, can_move: false,
    can_edit_details: false, can_grant: false, granted_by: 'owner-1',
  });
  const grants = access.getAllUnitAccessGrants();
  assert.ok(grants.every(g => g.location_type === 'Locker'));
  assert.ok(!grants.some(g => g.location_id === 'locker-retired'), 'retired locker excluded');
});

test('getManagedOwnerIds returns teammates of a team the caller manages', () => {
  seedTeam('team-1', 'Roofing');
  seedMember('team-1', 'mgr-1', 1);
  seedMember('team-1', 'grantee-1', 0);
  const managed = access.getManagedOwnerIds('mgr-1');
  assert.ok(managed.has('grantee-1'));
  assert.ok(!managed.has('foreign-1'));
});

test('getGrantableUnits only offers Locker units the caller can manage access on (owner-only for a peer role)', () => {
  const units = access.getGrantableUnits(
    { id: 'grantee-1', name: 'Gary', role: 'construction_crew', permission_overrides: {}, pin_length_required: 4, active: 1, expires_at: null } as never,
    'construction_crew',
  );
  assert.ok(!units.some(u => u.id === 'locker-1'), 'not owner, not privileged tier — locker-1 not grantable');
});

// ── #162 team-scoped unit inventory lock ────────────────────────────────────

test('getUnitInventoryLock: unlocked for a teammate of the unit owner', () => {
  const lock = access.getUnitInventoryLock(
    { id: 'grantee-1', role: 'construction_crew', permission_overrides: {} } as never,
    'locker-1',
  );
  assert.equal(lock.locked, false);
});

test('getUnitInventoryLock: locked for a non-teammate without manage_other_team_inventory', () => {
  const lock = access.getUnitInventoryLock(
    { id: 'foreign-1', role: 'construction_crew', permission_overrides: {} } as never,
    'locker-1',
  );
  assert.equal(lock.locked, true);
  assert.match(lock.reason ?? '', /Team inventory/);
});

test('getUnitInventoryLock: unlocked when the actor holds manage_other_team_inventory via a user override', () => {
  const lock = access.getUnitInventoryLock(
    { id: 'foreign-1', role: 'construction_crew', permission_overrides: { manage_other_team_inventory: true } } as never,
    'locker-1',
  );
  assert.equal(lock.locked, false);
});

test('getUnitInventoryLock: unlocked for non-unit / unowned / missing location ids', () => {
  assert.equal(access.getUnitInventoryLock({ id: 'foreign-1', role: 'construction_crew', permission_overrides: {} } as never, null).locked, false);
  assert.equal(access.getUnitInventoryLock({ id: 'foreign-1', role: 'construction_crew', permission_overrides: {} } as never, 'nonexistent').locked, false);
});

test('getUnitInventoryLockForUserId resolves the actor by id from the local users table', () => {
  const lock = access.getUnitInventoryLockForUserId('foreign-1', 'locker-1');
  assert.equal(lock.locked, true);
  const unknownUserLock = access.getUnitInventoryLockForUserId('does-not-exist', 'locker-1');
  assert.equal(unknownUserLock.locked, false, 'unknown actor is unlocked locally — the server still enforces on push');
});
