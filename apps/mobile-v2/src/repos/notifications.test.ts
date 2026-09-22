import { createRequire } from 'node:module';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// Same harness as approvals.test.ts/rooms.test.ts/teams.test.ts — notifications.ts
// can't load under `node --test` as-is (db/schema imports the native op-sqlite
// binding; utils/uuid imports react-native-get-random-values).
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

let notifications: typeof import('./notifications');

function seedRow(id: string, overrides: Partial<{ read_at: string | null; created_at: string }> = {}) {
  testDb.getDb().executeSync(
    `INSERT INTO notifications (id, user_id, type, title, body, data, read_at, created_by, created_at, updated_at)
     VALUES (?, 'u-1', 'assignment', 'Title ' || ?, 'Body', NULL, ?, NULL, ?, ?)`,
    [id, id, overrides.read_at ?? null, overrides.created_at ?? new Date().toISOString(), new Date().toISOString()],
  );
}

before(async () => {
  await testDb.initTestDb(['notifications', 'outbox']);
  notifications = requireCjs('./notifications') as typeof import('./notifications');
});

test('listNotifications returns rows newest first', () => {
  seedRow('n-1', { created_at: '2026-01-01T00:00:00.000Z' });
  seedRow('n-2', { created_at: '2026-01-02T00:00:00.000Z' });
  const rows = notifications.listNotifications();
  assert.ok(rows.length >= 2);
  const idx1 = rows.findIndex(r => r.id === 'n-1');
  const idx2 = rows.findIndex(r => r.id === 'n-2');
  assert.ok(idx2 < idx1);
});

test('countUnread counts only rows with a null read_at', () => {
  seedRow('n-3');
  seedRow('n-4', { read_at: '2026-01-01T00:00:00.000Z' });
  const before1 = notifications.countUnread();
  assert.ok(before1 >= 1);
});

test('markRead stamps read_at + updated_at locally and mirrors a minimal {id, read_at} outbox payload', () => {
  seedRow('n-5');
  const unreadBefore = notifications.countUnread();
  notifications.markRead('n-5');
  const unreadAfter = notifications.countUnread();
  assert.equal(unreadAfter, unreadBefore - 1);

  const row = testDb.getDb().executeSync(`SELECT read_at, updated_at FROM notifications WHERE id = ?`, ['n-5']).rows[0] as { read_at: string; updated_at: string };
  assert.ok(row.read_at);
  assert.ok(row.updated_at);

  const ob = testDb.getDb().executeSync(
    `SELECT payload FROM outbox WHERE table_name='notifications' AND operation='UPDATE' ORDER BY rowid DESC LIMIT 1`,
  ).rows[0] as { payload: string };
  const payload = JSON.parse(ob.payload) as Record<string, unknown>;
  assert.deepEqual(Object.keys(payload).sort(), ['id', 'read_at']);
  assert.equal(payload.id, 'n-5');
});

test('markRead on an already-read row is a no-op (no duplicate outbox entry)', () => {
  seedRow('n-6');
  notifications.markRead('n-6');
  const countBefore = (testDb.getDb().executeSync(`SELECT COUNT(*) AS c FROM outbox WHERE table_name='notifications'`).rows[0] as { c: number }).c;
  notifications.markRead('n-6');
  const countAfter = (testDb.getDb().executeSync(`SELECT COUNT(*) AS c FROM outbox WHERE table_name='notifications'`).rows[0] as { c: number }).c;
  assert.equal(countAfter, countBefore);
});

test('markAllRead clears every unread row', () => {
  seedRow('n-7');
  seedRow('n-8');
  notifications.markAllRead();
  assert.equal(notifications.countUnread(), 0);
});
