import { createRequire } from 'node:module';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// locations.ts can't load under `node --test` as-is: db/schema imports the
// native op-sqlite binding, utils/uuid imports react-native-get-random-values,
// and log.ts pulls telemetry (expo-constants / react-native). Rather than
// falling back to source-text assertions (the pullColumns.test.ts pattern),
// intercept Module._load (tsx runs this package's TS as CommonJS, so ESM
// loader hooks would not see the transitive requires) and swap those three for
// node-safe stand-ins — db/schema becomes a REAL sql.js database
// (locationsShelf.testdb.ts) — so these tests exercise the actual helpers
// end-to-end, including findOrCreateShelf's transactional writes and outbox
// side effects.
const requireCjs = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Module = requireCjs('node:module') as any;
const testDb = requireCjs('./locationsShelf.testdb') as typeof import('./locationsShelf.testdb');

const origLoad = Module._load;
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  // Side-effect-only crypto polyfill; node already has crypto.getRandomValues.
  if (request === 'react-native-get-random-values') return {};
  let resolved = '';
  try { resolved = Module._resolveFilename(request, parent); } catch { /* not ours — fall through */ }
  if (resolved.endsWith('/src/db/schema.ts')) return testDb;
  if (resolved.endsWith('/src/telemetry/index.ts')) return { track() {} };
  return origLoad.call(this, request, parent, isMain);
};

let loc: typeof import('./locations');

const NOW = '2026-07-14T00:00:00.000Z';

function seedLocation(row: {
  id: string; name: string; parent_id?: string | null; type?: string | null; has_shelves?: number;
}) {
  testDb.getDb().executeSync(
    `INSERT INTO locations (id, name, parent_id, active, updated_at, type, has_shelves)
     VALUES (?, ?, ?, 1, ?, ?, ?)`,
    [row.id, row.name, row.parent_id ?? null, NOW, row.type ?? null, row.has_shelves ?? 0],
  );
}

before(async () => {
  await testDb.initTestDb();
  loc = requireCjs('./locations') as typeof import('./locations');
  seedLocation({ id: 'shop-1', name: 'Shop', type: 'Shop', has_shelves: 1 });
  seedLocation({ id: 'shelf-a1', name: 'A1', parent_id: 'shop-1', type: 'Shelf' });
  seedLocation({ id: 'van-1', name: 'Van 1', type: 'Vehicle' });
  // Top-level shelf (parent_id null) — e.g. created by findOrCreateShelfByName.
  seedLocation({ id: 'shelf-top', name: 'WH-B2', type: 'Shelf' });
});

test('getNonShelfLocations excludes parented AND top-level shelves', () => {
  const ids = loc.getNonShelfLocations().map(l => l.id);
  assert.ok(ids.includes('shop-1'));
  assert.ok(ids.includes('van-1'));
  assert.ok(!ids.includes('shelf-a1'), 'parented shelf must not be a first-class option');
  assert.ok(!ids.includes('shelf-top'), 'top-level shelf must not be a first-class option');
});

test('resolve: null location → { ok: true, id: null }', () => {
  assert.deepEqual(loc.resolveLocationShelfSelection(null, null), { ok: true, id: null });
});

test('resolve: non-shelf-bearing location, no shelf → the location id', () => {
  assert.deepEqual(
    loc.resolveLocationShelfSelection({ id: 'van-1', label: 'Van 1' }, null),
    { ok: true, id: 'van-1' },
  );
});

test('resolve: a stale shelf value is IGNORED when has_shelves !== 1', () => {
  const before_ = countLocations();
  assert.deepEqual(
    loc.resolveLocationShelfSelection(
      { id: 'van-1', label: 'Van 1' },
      { id: '__new__', label: 'Ghost Shelf' },
    ),
    { ok: true, id: 'van-1' },
  );
  assert.equal(countLocations(), before_, 'must not create a shelf under a non-shelf location');
});

test('resolve: existing shelf → the shelf id', () => {
  assert.deepEqual(
    loc.resolveLocationShelfSelection(
      { id: 'shop-1', label: 'Shop' },
      { id: 'shelf-a1', label: 'A1' },
    ),
    { ok: true, id: 'shelf-a1' },
  );
});

test('resolve: __new__ shelf is created under the parent and its id returned', () => {
  const res = loc.resolveLocationShelfSelection(
    { id: 'shop-1', label: 'Shop' },
    { id: '__new__', label: 'B7' },
  );
  assert.equal(res.ok, true);
  const id = (res as { ok: true; id: string }).id;
  assert.ok(id && id !== 'shop-1');
  const created = loc.getLocationById(id);
  assert.equal(created?.type, 'Shelf');
  assert.equal(created?.parent_id, 'shop-1');
  assert.equal(created?.name, 'B7');
  // The create must also be queued for sync.
  const outbox = testDb.getDb().executeSync(
    `SELECT operation, table_name FROM outbox`,
  ).rows as { operation: string; table_name: string }[];
  assert.deepEqual(outbox, [{ operation: 'INSERT', table_name: 'locations' }]);
  // …and the new shelf is offered under its parent from now on.
  assert.ok(loc.getShelvesForParent('shop-1').some(s => s.id === id));
});

test('resolve: failed __new__ create → { ok: false, shelfLabel } and nothing persists', () => {
  // Force findOrCreateShelf's transaction to fail on its outbox write.
  testDb.getDb().executeSync('DROP TABLE outbox');
  try {
    assert.deepEqual(
      loc.resolveLocationShelfSelection(
        { id: 'shop-1', label: 'Shop' },
        { id: '__new__', label: 'C9' },
      ),
      { ok: false, shelfLabel: 'C9' },
    );
    // The transaction must have rolled the shelf row back.
    assert.ok(!loc.getShelvesForParent('shop-1').some(s => s.name === 'C9'));
  } finally {
    testDb.getDb().executeSync(testDb.OUTBOX_DDL);
  }
});

function countLocations(): number {
  const rows = testDb.getDb().executeSync(`SELECT COUNT(*) AS n FROM locations`).rows as { n: number }[];
  return rows[0].n;
}
