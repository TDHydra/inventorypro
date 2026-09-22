import { createRequire } from 'node:module';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// roleSettings.ts can't load under `node --test` as-is: db/schema imports the
// native op-sqlite binding. Same harness as rooms.test.ts/locationsShelf.test.ts:
// intercept Module._load and swap db/schema for a REAL sql.js database
// (./testDb), which also wires @invenpro/core's provider/config seam since
// roleSettings.ts writes through createRepository()/mirror().
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

let roleSettings: typeof import('./roleSettings');

before(async () => {
  await testDb.initTestDb(['role_settings', 'outbox']);
  roleSettings = requireCjs('./roleSettings') as typeof import('./roleSettings');
});

test('getRoleSettings/getRoleIdleReauthMinutes default to empty for a table with no rows', () => {
  assert.deepEqual(roleSettings.getRoleSettings(), {});
  assert.deepEqual(roleSettings.getRoleIdleReauthMinutes(), {});
});

test('setRoleIdleReauthMinutes upserts a role_settings row that did not exist yet', () => {
  const now = roleSettings.setRoleIdleReauthMinutes('office_manager', 30);
  assert.ok(now);
  assert.deepEqual(roleSettings.getRoleIdleReauthMinutes(), { office_manager: 30 });
  const ob = testDb.getDb().executeSync(
    `SELECT operation, table_name FROM outbox WHERE table_name = 'role_settings'`,
  ).rows as { operation: string; table_name: string }[];
  assert.equal(ob.length, 1);
  assert.equal(ob[0].operation, 'UPDATE');
});

test('setRoleColor then setRoleIdleReauthMinutes on the SAME role does not clobber the other column (mig-060 regression)', () => {
  roleSettings.setRoleColor('office_manager', '#336699');
  roleSettings.setRoleIdleReauthMinutes('office_manager', 45);
  assert.deepEqual(roleSettings.getRoleColorMap(), { office_manager: '#336699' });
  assert.deepEqual(roleSettings.getRoleIdleReauthMinutes(), { office_manager: 45 });
});

test('setRoleColor(null) clears an override; roleColor() falls back to resolveRoleColor default', () => {
  roleSettings.setRoleColor('hr_manager', '#abcdef');
  assert.equal(roleSettings.roleColor('hr_manager'), '#abcdef');
  roleSettings.setRoleColor('hr_manager', null);
  assert.deepEqual(roleSettings.getRoleColorMap().hr_manager, undefined);
});

test('setRolePermission sets, then allowed=null cleanly deletes the override key', () => {
  roleSettings.setRolePermission('production_manager', 'delete_inventory', true);
  assert.deepEqual(roleSettings.getRolePermissionOverrides().production_manager, { delete_inventory: true });
  roleSettings.setRolePermission('production_manager', 'delete_inventory', null);
  assert.deepEqual(roleSettings.getRolePermissionOverrides().production_manager, {});
});

test('setRolePermission read-modify-write preserves other permission keys on the same role', () => {
  roleSettings.setRolePermission('carpet_cleaning_manager', 'add_inventory', true);
  roleSettings.setRolePermission('carpet_cleaning_manager', 'edit_inventory', false);
  assert.deepEqual(roleSettings.getRolePermissionOverrides().carpet_cleaning_manager, {
    add_inventory: true,
    edit_inventory: false,
  });
});

test('setRoleMinPin upserts min_pin_length without touching other columns', () => {
  roleSettings.setRoleMinPin('temporary_employee', 6);
  assert.deepEqual(roleSettings.getRoleSettings().temporary_employee, 6);
  // First write for this role — the row is newly created, so idle_reauth_minutes
  // reads its DDL default (0), not an inherited value from some other write.
  assert.equal(roleSettings.getRoleIdleReauthMinutes().temporary_employee, 0);
});
