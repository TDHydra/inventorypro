import { createRequire } from 'node:module';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// Ported from apps/mobile/src/media/uploadCore.test.ts (#87/#148 pool-share
// audience columns + #173 room tagging) onto the v2 manifest-DDL harness
// (same Module._load redirect as chat.test.ts). The insert under test moved
// from uploadCore into repos/media.ts in v2 (repos own all writes), so this
// exercises repoInsertMediaRow directly — same semantics, same assertions:
// audience columns are pool-entity-only, room_id is job-entity-only, and both
// must land in the outbox payload when written.
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

let media: typeof import('./media');

function exec(sql: string, params?: unknown[]) {
  return testDb.getDb().executeSync(sql, params);
}

let idCounter = 0;
const nextId = () => `media-${String(++idCounter).padStart(4, '0')}`;

before(async () => {
  await testDb.initTestDb(['media', 'app_config', 'outbox']);
  media = requireCjs('./media') as typeof import('./media');
});

test('insertMediaRow: pool share writes audience columns + caption and outboxes them', () => {
  const out = media.insertMediaRow({
    entityType: 'pool', entityId: 'user-1', mediaType: 'image', url: 'https://x/pool/a.jpg',
    userId: 'user-1', locationNote: 'Kitchen', caption: 'ceiling stain',
    audience: 'users', audienceUserIds: ['6f1e1c2a-9b3d-4e5f-8a7b-0c1d2e3f4a5b'],
  }, nextId());
  const row = testDb.rowsAs<{ audience: string | null; caption: string | null; audience_user_ids: string | null }>(
    exec(`SELECT * FROM media WHERE id = ?`, [out.id]).rows,
  )[0];
  assert.equal(row.audience, 'users');
  assert.equal(row.caption, 'ceiling stain');
  assert.equal(JSON.parse(row.audience_user_ids as string)[0], '6f1e1c2a-9b3d-4e5f-8a7b-0c1d2e3f4a5b');

  const ob = testDb.rowsAs<{ payload: string }>(
    exec(`SELECT payload FROM outbox ORDER BY rowid DESC LIMIT 1`).rows,
  )[0];
  const payload = JSON.parse(ob.payload);
  assert.equal(payload.audience, 'users');
  assert.equal(payload.caption, 'ceiling stain');
});

test('insertMediaRow: job photo leaves audience columns null (unchanged path)', () => {
  const out = media.insertMediaRow({
    entityType: 'job', entityId: 'job-1', mediaType: 'image', url: 'https://x/job/a.jpg',
    userId: 'user-1', locationNote: null,
  }, nextId());
  const row = testDb.rowsAs<{ audience: string | null; audience_user_ids: string | null; caption: string | null }>(
    exec(`SELECT audience, audience_user_ids, caption FROM media WHERE id = ?`, [out.id]).rows,
  )[0];
  assert.equal(row.audience, null);
  assert.equal(row.audience_user_ids, null);
  assert.equal(row.caption, null);
});

test('insertMediaRow: #173 job photo writes room_id + is outboxed', () => {
  const out = media.insertMediaRow({
    entityType: 'job', entityId: 'job-1', mediaType: 'image', url: 'https://x/job/b.jpg',
    userId: 'user-1', caption: 'water damage', roomId: 'room-kitchen',
  }, nextId());
  const row = testDb.rowsAs<{ room_id: string | null }>(
    exec(`SELECT room_id FROM media WHERE id = ?`, [out.id]).rows,
  )[0];
  assert.equal(row.room_id, 'room-kitchen');

  const ob = testDb.rowsAs<{ payload: string }>(
    exec(`SELECT payload FROM outbox ORDER BY rowid DESC LIMIT 1`).rows,
  )[0];
  const payload = JSON.parse(ob.payload);
  assert.equal(payload.room_id, 'room-kitchen');
});

test('insertMediaRow: #173 roomId is dropped for a non-job entity (pool photo)', () => {
  const out = media.insertMediaRow({
    entityType: 'pool', entityId: 'user-1', mediaType: 'image', url: 'https://x/pool/b.jpg',
    userId: 'user-1', roomId: 'room-kitchen',
  }, nextId());
  const row = testDb.rowsAs<{ room_id: string | null }>(
    exec(`SELECT room_id FROM media WHERE id = ?`, [out.id]).rows,
  )[0];
  assert.equal(row.room_id, null, 'room tagging is job-entity-only');
});
