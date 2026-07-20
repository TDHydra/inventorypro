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
  seedLocation({ id: 'locker-1', name: "Frank's Locker", type: 'Locker' });
  // Top-level shelf (parent_id null) — e.g. created by findOrCreateShelfByName.
  seedLocation({ id: 'shelf-top', name: 'WH-B2', type: 'Shelf' });
});

test('getNonShelfLocations excludes parented AND top-level shelves', () => {
  const ids = loc.getNonShelfLocations().map(l => l.id);
  assert.ok(ids.includes('shop-1'));
  assert.ok(!ids.includes('van-1'), 'units are not first-class picker options (#122 A2)');
  assert.ok(!ids.includes('shelf-a1'), 'parented shelf must not be a first-class option');
  assert.ok(!ids.includes('shelf-top'), 'top-level shelf must not be a first-class option');
});

test('type-less locations are hidden from item/checkout pickers but stay browsable', () => {
  // A legacy/malformed row with no resolved type (no type_id). JS null-comparison
  // (`null !== 'Shelf'`) let these slip into getNonShelfLocations before the guard.
  seedLocation({ id: 'typeless-1', name: 'Warehouser', type: null });
  const pickerIds = loc.getNonShelfLocations().map(l => l.id);
  assert.ok(!pickerIds.includes('typeless-1'), 'a type-less location is not a picker option');
  // …but it must remain in the Locations browser so it can be given a type or retired.
  const browsable = loc.getBrowsableLocations().map(l => l.id);
  assert.ok(browsable.includes('typeless-1'), 'type-less location stays browsable/fixable');
});

test('includeTypeless opt-in (#158): checkout destinations offer type-less rows, still never shelves/units', () => {
  // The fast/hub checkout DestinationPicker widens the list: any real place is
  // a valid destination even before it has a type.
  const ids = loc.getNonShelfLocations({ includeTypeless: true }).map(l => l.id);
  assert.ok(ids.includes('typeless-1'), 'type-less location IS a checkout destination');
  assert.ok(ids.includes('shop-1'), 'typed locations still listed');
  assert.ok(!ids.includes('shelf-a1'), 'parented shelf still excluded (reached via has_shelves sub-picker)');
  assert.ok(!ids.includes('shelf-top'), 'top-level shelf still excluded');
  assert.ok(!ids.includes('van-1'), 'vehicles still excluded (own flow)');
  assert.ok(!ids.includes('locker-1'), 'lockers still excluded (own flow)');
  // Explicit false and omitted opts behave identically (strict default).
  assert.deepEqual(
    loc.getNonShelfLocations({ includeTypeless: false }).map(l => l.id),
    loc.getNonShelfLocations().map(l => l.id),
  );
});

test('units excluded from browse/tree and picker lists (#122 A2)', () => {
  const browsable = loc.getBrowsableLocations().map(l => l.id);
  assert.ok(!browsable.includes('van-1'));
  assert.ok(!browsable.includes('locker-1'));
  assert.ok(browsable.includes('shop-1'), 'real places still browsable');
  assert.ok(!loc.getNonShelfLocations().map(l => l.id).includes('locker-1'));
});

test('getUnitLocations partitions by kind', () => {
  assert.deepEqual(loc.getUnitLocations('Vehicle').map(l => l.id), ['van-1']);
  assert.deepEqual(loc.getUnitLocations('Locker').map(l => l.id), ['locker-1']);
});

test('no sub-areas under units: creation helpers refuse a Vehicle/Locker parent (#122 A2)', () => {
  assert.equal(loc.findOrCreateShelf('van-1', 'V1'), null);
  assert.equal(loc.findOrCreateShelf('locker-1', 'L1'), null);
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

test('getBrowsableLocations/getLocationTree exclude Vehicle- and Locker-typed rows (A2 central filter)', () => {
  seedLocation({ id: 'locker-frank', name: "Frank's Locker", type: 'Locker' });
  const ids = loc.getBrowsableLocations().map(l => l.id);
  assert.ok(ids.includes('shop-1'));
  assert.ok(!ids.includes('van-1'), 'vehicles are their own system — not in the Locations browser');
  assert.ok(!ids.includes('locker-frank'), 'lockers are their own system — not in the Locations browser');
  const topIds = loc.getLocationTree().map(n => n.id);
  assert.ok(!topIds.includes('van-1') && !topIds.includes('locker-frank'));
});

test('getRoomsForParent lists non-shelf children only', () => {
  seedLocation({ id: 'room-maint', name: 'Maintenance Room', parent_id: 'shop-1', type: 'Storage' });
  const rooms = loc.getRoomsForParent('shop-1');
  assert.ok(rooms.some(r => r.id === 'room-maint'), 'a room child is listed');
  assert.ok(!rooms.some(r => r.id === 'shelf-a1'), 'shelf children are not rooms');
});

test('findOrCreateShelf under a ROOM creates once and dedupes case-insensitively', () => {
  const first = loc.findOrCreateShelf('room-maint', 'M1');
  assert.ok(first, 'shelf created under a nested room');
  const again = loc.findOrCreateShelf('room-maint', 'm1');
  assert.equal(again, first, 'same name (any case) returns the existing shelf');
  assert.ok(loc.getShelvesForParent('room-maint').some(sh => sh.id === first));
  assert.equal(loc.getLocationById(first!)?.type, 'Shelf');
});

test('end-to-end: stock placed at a shelf inside a room inside a building', () => {
  seedLocation({ id: 'bldg-lex', name: 'Lexington Park' });
  seedLocation({ id: 'room-prod', name: 'Product Room', parent_id: 'bldg-lex', type: 'Storage', has_shelves: 1 });
  // Two-stage picker: pick the room, type a NEW shelf → shelf created under the room.
  const res = loc.resolveLocationShelfSelection(
    { id: 'room-prod', label: 'Product Room' },
    { id: '__new__', label: 'S1' },
  );
  assert.equal(res.ok, true);
  const shelfId = (res as { ok: true; id: string }).id!;
  assert.equal(loc.getLocationById(shelfId)?.parent_id, 'room-prod');
  assert.equal(loc.getLocationPath(shelfId), 'Lexington Park › Product Room › S1');
  // Reverse mapping seeds the picker back to (room, shelf).
  assert.deepEqual(loc.resolveLocationShelf(shelfId), {
    location: { id: 'room-prod', label: 'Product Room' },
    shelf: { id: shelfId, label: 'S1' },
  });
  // Stock tracked against the shelf id is readable at the shelf.
  testDb.getDb().executeSync(
    `INSERT INTO inventory_items (id, name, active) VALUES ('item-tape', 'Duct Tape', 1)`,
  );
  testDb.getDb().executeSync(
    `INSERT INTO stock_by_location (item_id, location_id, quantity, updated_at) VALUES ('item-tape', ?, 12, ?)`,
    [shelfId, NOW],
  );
  const stock = loc.getStockAtLocation(shelfId);
  assert.deepEqual(stock.map(r => ({ name: r.name, quantity: r.quantity })), [{ name: 'Duct Tape', quantity: 12 }]);
});
