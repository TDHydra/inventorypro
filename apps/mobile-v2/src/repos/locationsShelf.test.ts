import { createRequire } from 'node:module';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// locations.ts can't load under `node --test` as-is: db/schema imports the
// native op-sqlite binding, utils/uuid imports react-native-get-random-values,
// and log.ts pulls telemetry (expo-constants / react-native). Rather than
// falling back to source-text assertions, intercept Module._load (tsx runs
// this package's TS as CommonJS, so ESM loader hooks would not see the
// transitive requires) and swap those for node-safe stand-ins — db/schema
// becomes a REAL sql.js database (./testDb) — so these tests exercise the
// actual helpers end-to-end, including findOrCreateShelf's transactional
// writes and outbox side effects. testDb also wires @invenpro/core's
// provider/config seam, since locations.ts writes through
// createRepository()/mirror() rather than a hand-rolled write+appendOutbox pair.
//
// NOTE: findOrCreateVehicleByName / retireVehicle were CUT from repos/locations.ts
// (they need the unported vehicles.ts domain — see the PORT NOTE at the top of
// that file) but this test file never exercised them, so it ports unmodified.
const requireCjs = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Module = requireCjs('node:module') as any;
const testDb = requireCjs('./testDb') as typeof import('./testDb');

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
  if (resolved.endsWith('/src/db/queries/log.ts')) return { appendLog() {} };
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
  await testDb.initTestDb(['locations', 'taxonomy_types', 'inventory_items', 'stock_by_location', 'equipment_units', 'outbox']);
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
    for (const ddl of testDb.outboxDdl()) testDb.getDb().executeSync(ddl);
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
  // Stock tracked against the shelf id is readable at the shelf. inventory_items'
  // unit_category/unit/updated_at are NOT NULL with no DDL default (see the real
  // manifest DDL) — supplied here, unlike the old hand-rolled test-only schema.
  testDb.getDb().executeSync(
    `INSERT INTO inventory_items (id, name, unit_category, unit, updated_at, active) VALUES ('item-tape', 'Duct Tape', 'each', 'each', ?, 1)`,
    [NOW],
  );
  testDb.getDb().executeSync(
    `INSERT INTO stock_by_location (item_id, location_id, quantity, updated_at) VALUES ('item-tape', ?, 12, ?)`,
    [shelfId, NOW],
  );
  const stock = loc.getStockAtLocation(shelfId);
  assert.deepEqual(stock.map(r => ({ name: r.name, quantity: r.quantity })), [{ name: 'Duct Tape', quantity: 12 }]);
});

// ── Shelf management (#290) ──────────────────────────────────────────────────
// Each of these seeds its OWN parent: the tests above share shop-1/room-maint
// and a rename or removal there would reach backwards into them.

test('shelves list by sort_order then name — all-zero rows read as alphabetical', () => {
  seedLocation({ id: 'ord-parent', name: 'Order Shop', type: 'Shop', has_shelves: 1 });
  // Seeded directly (sort_order defaults to 0), i.e. the state every row is in
  // immediately after migration 002.
  seedLocation({ id: 'ord-c', name: 'C1', parent_id: 'ord-parent', type: 'Shelf' });
  seedLocation({ id: 'ord-a', name: 'A1', parent_id: 'ord-parent', type: 'Shelf' });
  seedLocation({ id: 'ord-b', name: 'B1', parent_id: 'ord-parent', type: 'Shelf' });
  assert.deepEqual(loc.getShelvesForParent('ord-parent').map(sh => sh.name), ['A1', 'B1', 'C1']);
});

test('reorderShelves renumbers 0..n-1 and the new order sticks', () => {
  const ids = ['ord-c', 'ord-a', 'ord-b'];
  assert.deepEqual(loc.reorderShelves('ord-parent', ids, 'user-1'), { ok: true });
  assert.deepEqual(loc.getShelvesForParent('ord-parent').map(sh => sh.id), ids);
  assert.deepEqual(
    loc.getShelvesForParent('ord-parent').map(sh => sh.sort_order),
    [0, 1, 2],
    'normalized from all-zeros, so no migration backfill is needed',
  );
  // Idempotent: committing the same order again is a no-op success.
  assert.deepEqual(loc.reorderShelves('ord-parent', ids, 'user-1'), { ok: true });
  assert.deepEqual(loc.getShelvesForParent('ord-parent').map(sh => sh.id), ids);
});

test('reorderShelves refuses a STALE list instead of renumbering around it', () => {
  // Missing one id, a duplicate, and an id from another parent — each is the
  // same bug (the caller rendered before someone else changed the wall).
  for (const bad of [['ord-c', 'ord-a'], ['ord-c', 'ord-c', 'ord-a'], ['ord-c', 'ord-a', 'shelf-a1']]) {
    const res = loc.reorderShelves('ord-parent', bad, 'user-1');
    assert.equal(res.ok, false, `refused: ${bad.join()}`);
  }
  // …and nothing moved.
  assert.deepEqual(loc.getShelvesForParent('ord-parent').map(sh => sh.id), ['ord-c', 'ord-a', 'ord-b']);
});

test('a shelf created after a reorder appends LAST, never jumping to the top', () => {
  const created = loc.findOrCreateShelf('ord-parent', 'A0');
  assert.ok(created);
  assert.deepEqual(
    loc.getShelvesForParent('ord-parent').map(sh => sh.name),
    ['C1', 'A1', 'B1', 'A0'],
    'alphabetically first, but added last — a 0 default would have put it on top',
  );
});

test('renameShelf trims, and refuses a name an active sibling already uses', () => {
  assert.deepEqual(loc.renameShelf('ord-a', '  A1-left  ', 'user-1'), { ok: true });
  assert.equal(loc.getLocationById('ord-a')?.name, 'A1-left');
  // Case-insensitive clash with a sibling — the same rule findOrCreateShelf
  // dedupes on, so a rename can't create a pair that helper would merge.
  const clash = loc.renameShelf('ord-a', 'b1', 'user-1');
  assert.equal(clash.ok, false);
  assert.match((clash as { ok: false; reason: string }).reason, /already a shelf called "B1"/);
  assert.equal(loc.getLocationById('ord-a')?.name, 'A1-left', 'refusal wrote nothing');
  // Blank is refused; renaming to the SAME name is a no-op success.
  assert.equal(loc.renameShelf('ord-a', '   ', 'user-1').ok, false);
  assert.deepEqual(loc.renameShelf('ord-a', 'A1-left', 'user-1'), { ok: true });
  // A shelf under a DIFFERENT parent may reuse the name.
  assert.deepEqual(loc.renameShelf('shelf-a1', 'B1', 'user-1'), { ok: true });
});

test('removeShelf soft-deletes: the row survives, the shelf leaves the list', () => {
  assert.deepEqual(loc.removeShelf('ord-b', 'user-1'), { ok: true });
  assert.equal(loc.getLocationById('ord-b')?.active, 0, 'locations are never hard-deleted');
  assert.ok(!loc.getShelvesForParent('ord-parent').some(sh => sh.id === 'ord-b'));
  // Already removed → no-op success (a double tap must not error).
  assert.deepEqual(loc.removeShelf('ord-b', 'user-1'), { ok: true });
  // Not a shelf at all.
  assert.equal(loc.removeShelf('ord-parent', 'user-1').ok, false);
});

test('removeShelf refuses while the shelf holds stock, and names what is on it', () => {
  seedLocation({ id: 'rm-parent', name: 'Remove Shop', type: 'Shop', has_shelves: 1 });
  seedLocation({ id: 'rm-stock', name: 'S1', parent_id: 'rm-parent', type: 'Shelf' });
  testDb.getDb().executeSync(
    `INSERT INTO inventory_items (id, name, unit_category, unit, updated_at, active) VALUES ('item-screws', 'Deck Screws', 'each', 'each', ?, 1)`,
    [NOW],
  );
  testDb.getDb().executeSync(
    `INSERT INTO stock_by_location (item_id, location_id, quantity, updated_at) VALUES ('item-screws', 'rm-stock', 40, ?)`,
    [NOW],
  );
  const res = loc.removeShelf('rm-stock', 'user-1');
  assert.equal(res.ok, false);
  assert.match((res as { ok: false; reason: string }).reason, /still holds stock \(Deck Screws\)/);
  assert.equal(loc.getLocationById('rm-stock')?.active, 1, 'refusal wrote nothing');
  // Emptying the shelf clears the refusal.
  testDb.getDb().executeSync(`UPDATE stock_by_location SET quantity = 0 WHERE location_id = 'rm-stock'`);
  assert.deepEqual(loc.removeShelf('rm-stock', 'user-1'), { ok: true });
});

test('removeShelf refuses while an item is HOMED to it', () => {
  seedLocation({ id: 'rm-home', name: 'H1', parent_id: 'rm-parent', type: 'Shelf' });
  testDb.getDb().executeSync(
    `UPDATE inventory_items SET home_location_id = 'rm-home' WHERE id = 'item-screws'`,
  );
  const res = loc.removeShelf('rm-home', 'user-1');
  assert.equal(res.ok, false);
  assert.match((res as { ok: false; reason: string }).reason, /home location for Deck Screws.*new home location/s);
  testDb.getDb().executeSync(`UPDATE inventory_items SET home_location_id = NULL WHERE id = 'item-screws'`);
  assert.deepEqual(loc.removeShelf('rm-home', 'user-1'), { ok: true });
});

test('removeShelf refuses while an equipment unit is parked on it', () => {
  seedLocation({ id: 'rm-unit', name: 'U1', parent_id: 'rm-parent', type: 'Shelf' });
  testDb.getDb().executeSync(
    `INSERT INTO equipment_units (id, item_id, asset_tag, status, current_location_id, created_at, updated_at)
     VALUES ('eq-1', 'item-screws', 'TOOL-7', 'available', 'rm-unit', ?, ?)`,
    [NOW, NOW],
  );
  const res = loc.removeShelf('rm-unit', 'user-1');
  assert.equal(res.ok, false);
  assert.match((res as { ok: false; reason: string }).reason, /TOOL-7 is on U1/);
  testDb.getDb().executeSync(`UPDATE equipment_units SET current_location_id = NULL WHERE id = 'eq-1'`);
  assert.deepEqual(loc.removeShelf('rm-unit', 'user-1'), { ok: true });
});

test('upsertLocation does not reset a shelf order it was not told about', () => {
  // The clobber this guards: upsertLocation's local write is INSERT OR REPLACE,
  // so any edit path that rebuilds a Location without sort_order would send the
  // whole wall back to alphabetical.
  const before = loc.getLocationById('ord-c')!;
  assert.equal(before.sort_order, 0);
  loc.upsertLocation({ ...before, sort_order: undefined, name: 'C1-renamed' });
  assert.equal(loc.getLocationById('ord-c')?.name, 'C1-renamed');
  assert.equal(loc.getLocationById('ord-c')?.sort_order, 0);
  // And an explicit value still wins.
  loc.upsertLocation({ ...before, sort_order: 7 });
  assert.equal(loc.getLocationById('ord-c')?.sort_order, 7);
});
