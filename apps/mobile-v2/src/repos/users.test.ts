import { createRequire } from 'node:module';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// users.ts can't load under `node --test` as-is: db/schema imports the native
// op-sqlite binding, and auth/session (getValidJwt, for the online-only PIN
// paths) imports expo-secure-store. Same harness as rooms.test.ts: swap
// db/schema for a REAL sql.js database (./testDb) and auth/session for a
// stub whose getValidJwt() resolves null (offline) — enough to exercise
// every offline-capable write and the online paths' "no session" guard.
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
  if (resolved.endsWith('/src/auth/session.ts')) return { getValidJwt: async () => null };
  return origLoad.call(this, request, parent, isMain);
};

let users: typeof import('./users');

const NOW = '2026-09-01T00:00:00.000Z';

function seedUser(row: { id: string; name: string; role?: string; active?: number; expires_at?: string | null }) {
  testDb.getDb().executeSync(
    `INSERT INTO users (id, name, role, pin_length_required, permission_overrides, active, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, 4, '{}', ?, ?, ?, ?)`,
    [row.id, row.name, row.role ?? 'construction_crew', row.active ?? 1, row.expires_at ?? null, NOW, NOW],
  );
}

before(async () => {
  await testDb.initTestDb(['users', 'outbox']);
  users = requireCjs('./users') as typeof import('./users');
  seedUser({ id: 'u-frank', name: 'Frank' });
  seedUser({ id: 'u-matt', name: 'Matt', role: 'production_manager' });
  seedUser({ id: 'u-old', name: 'Retired Rita', active: 0 });
});

test('getAllUsers returns everyone (active + inactive), getAllActiveUsers only active', () => {
  assert.equal(users.getAllUsers().length, 3);
  const activeNames = users.getAllActiveUsers().map(u => u.name);
  assert.ok(activeNames.includes('Frank'));
  assert.ok(!activeNames.includes('Retired Rita'));
});

test('getUsersByRole / getManagerTierUsers filter correctly', () => {
  assert.deepEqual(users.getUsersByRole('production_manager').map(u => u.id), ['u-matt']);
  const managerIds = users.getManagerTierUsers().map(u => u.id);
  assert.ok(managerIds.includes('u-matt'), 'production_manager is manager-tier');
  assert.ok(!managerIds.includes('u-frank'), 'construction_crew is not manager-tier');
});

test('setUserActive flips active + updated_at and mirrors to the outbox', () => {
  const now = users.setUserActive('u-frank', false);
  assert.ok(now);
  const row = testDb.getDb().executeSync(`SELECT active FROM users WHERE id = 'u-frank'`).rows[0] as { active: number };
  assert.equal(row.active, 0);
  const ob = testDb.getDb().executeSync(`SELECT COUNT(*) AS n FROM outbox WHERE table_name='users'`).rows[0] as { n: number };
  assert.ok(ob.n >= 1);
  users.setUserActive('u-frank', true); // restore for later tests
});

test('saveUserFields partial-updates only the given fields', () => {
  users.saveUserFields('u-frank', { email: 'frank@example.com' });
  const row = testDb.getDb().executeSync(`SELECT name, email FROM users WHERE id = 'u-frank'`).rows[0] as { name: string; email: string };
  assert.equal(row.name, 'Frank', 'untouched field preserved');
  assert.equal(row.email, 'frank@example.com');
});

test('setUserRole (same-length change) updates role without touching pin_length_required when omitted', () => {
  const before_ = testDb.getDb().executeSync(`SELECT pin_length_required FROM users WHERE id = 'u-frank'`).rows[0] as { pin_length_required: number };
  users.setUserRole('u-frank', 'carpet_cleaning_crew');
  const after = testDb.getDb().executeSync(`SELECT role, pin_length_required FROM users WHERE id = 'u-frank'`).rows[0] as { role: string; pin_length_required: number };
  assert.equal(after.role, 'carpet_cleaning_crew');
  assert.equal(after.pin_length_required, before_.pin_length_required);
});

test('setUserRole with pinLengthRequired updates both columns together', () => {
  users.setUserRole('u-frank', 'production_manager', 6);
  const row = testDb.getDb().executeSync(`SELECT role, pin_length_required FROM users WHERE id = 'u-frank'`).rows[0] as { role: string; pin_length_required: number };
  assert.equal(row.role, 'production_manager');
  assert.equal(row.pin_length_required, 6);
});

test('setUserPermissionOverrides stores a real JSON object over the outbox', () => {
  users.setUserPermissionOverrides('u-matt', { delete_inventory: true });
  const row = testDb.getDb().executeSync(`SELECT permission_overrides FROM users WHERE id = 'u-matt'`).rows[0] as { permission_overrides: string };
  assert.deepEqual(JSON.parse(row.permission_overrides), { delete_inventory: true });
  const ob = testDb.getDb().executeSync(
    `SELECT payload FROM outbox WHERE table_name='users' AND operation='UPDATE' ORDER BY rowid DESC LIMIT 1`,
  ).rows[0] as { payload: string };
  const payload = JSON.parse(ob.payload) as Record<string, unknown>;
  assert.deepEqual(payload.permission_overrides, { delete_inventory: true });
});

test('markUserPinSet / markUserPinReset are local-only (no outbox row)', () => {
  const before_ = testDb.getDb().executeSync(`SELECT COUNT(*) AS n FROM outbox`).rows[0] as { n: number };
  users.markUserPinSet('u-frank', 6);
  users.markUserPinReset('u-frank');
  const after = testDb.getDb().executeSync(`SELECT COUNT(*) AS n FROM outbox`).rows[0] as { n: number };
  assert.equal(after.n, before_.n, 'PIN bookkeeping never queues an outbox row');
  const row = testDb.getDb().executeSync(`SELECT pin_set FROM users WHERE id = 'u-frank'`).rows[0] as { pin_set: number };
  assert.equal(row.pin_set, 0, 'markUserPinReset ran last');
});

test('createUserOnline / changeRoleOnline / resetUserPinOnline reject without a session', async () => {
  await assert.rejects(() => users.createUserOnline('New Guy', 'construction_crew'));
  await assert.rejects(() => users.changeRoleOnline('u-frank', 'office_manager'));
  await assert.rejects(() => users.resetUserPinOnline('u-frank'));
});
