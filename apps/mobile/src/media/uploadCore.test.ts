import { createRequire } from 'node:module';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// insertMediaRow tests for the #87/#148 pool-share audience columns
// (migration 052). uploadCore.ts can't load under `node --test` as-is:
// db/schema imports the native op-sqlite binding, utils/uuid imports
// react-native-get-random-values, auth/session imports expo-secure-store (and
// transitively permissions -> users query -> teams query -> sync/engine, a
// heavy network module we never want in this test), and db/queries/log (pulled
// in transitively via db/queries/media) imports telemetry. Same Module._load
// intercept pattern as vehiclesLock.test.ts — db/schema becomes a real sql.js
// database (locationsShelf.testdb.ts), auth/session and telemetry become inert
// stubs. expo-location/expo-secure-store are left to load for real: they don't
// throw at import time (only when their native-bridge functions are actually
// called), and insertMediaRow never calls them.
const requireCjs = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Module = requireCjs('node:module') as any;
const testDb = requireCjs('../db/queries/locationsShelf.testdb') as typeof import('../db/queries/locationsShelf.testdb');

const origLoad = Module._load;
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  // Side-effect-only crypto polyfill; node already has crypto.getRandomValues.
  if (request === 'react-native-get-random-values') return {};
  // Same react-native/expo/expo-modules-core stub as vehiclesLock.test.ts —
  // these are Flow-typed / native-bridge modules that don't parse under
  // tsx/esbuild. Nothing here exercises them.
  if (request === 'react-native' || request === 'expo' || request === 'expo-modules-core') {
    return new Proxy({ __esModule: true }, { get: (_t, p) => (p === '__esModule' ? true : () => {}) });
  }
  let resolved = '';
  try { resolved = Module._resolveFilename(request, parent); } catch { /* not ours — fall through */ }
  if (resolved.endsWith('/src/db/schema.ts')) return testDb;
  // auth/session pulls in expo-secure-store + (transitively, through
  // permissions/users/teams) sync/engine — none of which insertMediaRow needs.
  if (resolved.endsWith('/src/auth/session.ts')) return { getValidJwt: async () => null };
  if (resolved.endsWith('/src/telemetry/index.ts')) return { track() {} };
  return origLoad.call(this, request, parent, isMain);
};

let core: typeof import('./uploadCore');
const db = testDb;

before(async () => {
  await testDb.initTestDb(); // creates locations/taxonomy_types/inventory_items/stock_by_location/outbox
  // Media table matching migration 001 (base) + 036 (location_note, updated_at)
  // + 052 (audience, audience_user_ids) — the REAL synced shape.
  testDb.getDb().executeSync(`
    CREATE TABLE media (
      id            TEXT PRIMARY KEY,
      entity_type   TEXT NOT NULL,
      entity_id     TEXT NOT NULL,
      media_type    TEXT NOT NULL,
      url           TEXT NOT NULL,
      thumbnail_url TEXT,
      caption       TEXT,
      is_primary    INTEGER NOT NULL DEFAULT 0,
      uploaded_by   TEXT,
      created_at    TEXT NOT NULL,
      synced_at     TEXT,
      location_note TEXT,
      updated_at    TEXT,
      audience      TEXT,
      audience_user_ids TEXT
    );
  `);
  core = requireCjs('./uploadCore') as typeof import('./uploadCore');
});

test('insertMediaRow: pool share writes audience columns + caption and outboxes them', () => {
  const out = core.insertMediaRow({
    entityType: 'pool', entityId: 'user-1', mediaType: 'image', ext: 'jpg',
    userId: 'user-1', locationNote: 'Kitchen', caption: 'ceiling stain',
    audience: 'users', audienceUserIds: ['6f1e1c2a-9b3d-4e5f-8a7b-0c1d2e3f4a5b'],
  }, 'https://x/pool/a.jpg');
  const row = db.rowsAs<{ audience: string | null; caption: string | null; audience_user_ids: string | null }>(
    db.getDb().executeSync(`SELECT * FROM media WHERE id = ?`, [out.id]).rows
  )[0];
  assert.equal(row.audience, 'users');
  assert.equal(row.caption, 'ceiling stain');
  assert.equal(JSON.parse(row.audience_user_ids as string)[0], '6f1e1c2a-9b3d-4e5f-8a7b-0c1d2e3f4a5b');

  const ob = db.rowsAs<{ payload: string }>(
    db.getDb().executeSync(`SELECT payload FROM outbox ORDER BY created_at DESC LIMIT 1`).rows
  )[0];
  const payload = JSON.parse(ob.payload);
  assert.equal(payload.audience, 'users');
  assert.equal(payload.caption, 'ceiling stain');
});

test('insertMediaRow: job photo leaves audience columns null (unchanged path)', () => {
  const out = core.insertMediaRow({
    entityType: 'job', entityId: 'job-1', mediaType: 'image', ext: 'jpg',
    userId: 'user-1', locationNote: null,
  }, 'https://x/job/a.jpg');
  const row = db.rowsAs<{ audience: string | null; audience_user_ids: string | null; caption: string | null }>(
    db.getDb().executeSync(`SELECT audience, audience_user_ids, caption FROM media WHERE id = ?`, [out.id]).rows
  )[0];
  assert.equal(row.audience, null);
  assert.equal(row.audience_user_ids, null);
  assert.equal(row.caption, null);
});
