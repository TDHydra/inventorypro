import { createRequire } from 'node:module';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// Covers both item_category.meta boolean flags end to end at the repo layer:
//   `parts`      — "Use parts" searches only repair parts: the flag plus the
//                  set-valued category filter it feeds into searchItems.
//   `repairable` — #283, gates ItemCard's "Report repair"; opt-in, so the
//                  interesting cases are the negative ones.
// Same module-hook harness
// as roleSettings.test.ts — db/schema is the native op-sqlite binding, so it is
// swapped for a real sql.js DB (./testDb), which also wires @invenpro/core's
// provider/config seam that createRepository()/mirror() write through.
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

let taxonomy: typeof import('./taxonomy');
let items: typeof import('./items');

// Category ids, filled in by the seed below.
let partsId = '';
let otherPartsId = '';
let chemicalsId = '';
let archivedPartsId = '';

function categoryId(label: string): string {
  const row = testDb.getDb().executeSync(
    `SELECT id FROM taxonomy_types WHERE category = 'item_category' AND label = ?`,
    [label],
  ).rows[0] as { id: string } | undefined;
  assert.ok(row, `seed missing item_category "${label}"`);
  return row.id;
}

function addItem(name: string, categoryIdValue: string | null) {
  const db = testDb.getDb();
  db.executeSync(
    `INSERT INTO inventory_items
       (id, name, unit_category, unit, min_qty_alert, active, updated_at, kind,
        category_id, returnable, unit_tracked, needs_cleaning)
     VALUES (?, ?, 'piece', 'each', 0, 1, ?, 'product', ?, 0, 0, 0)`,
    [`item-${name}`, name, new Date().toISOString(), categoryIdValue],
  );
}

before(async () => {
  await testDb.initTestDb([
    'taxonomy_types', 'inventory_items', 'stock_by_location', 'equipment_units', 'outbox',
  ]);
  taxonomy = requireCjs('./taxonomy') as typeof import('./taxonomy');
  items = requireCjs('./items') as typeof import('./items');

  taxonomy.addTaxonomyType({
    category: 'item_category', label: 'Equipment Part', icon: '🔧',
    meta: JSON.stringify({ units: ['each'], classId: 'class-pieces', parts: true }),
  });
  taxonomy.addTaxonomyType({
    category: 'item_category', label: 'Filter Part', icon: '🌬️',
    meta: JSON.stringify({ units: ['each'], parts: true }),
  });
  taxonomy.addTaxonomyType({
    category: 'item_category', label: 'Chemicals', icon: '🧪',
    meta: JSON.stringify({ units: ['gallon'], classId: 'class-liquid' }),
  });
  taxonomy.addTaxonomyType({
    category: 'item_category', label: 'Retired Part', icon: null,
    meta: JSON.stringify({ parts: true }),
  });

  partsId = categoryId('Equipment Part');
  otherPartsId = categoryId('Filter Part');
  chemicalsId = categoryId('Chemicals');
  archivedPartsId = categoryId('Retired Part');
  taxonomy.setTaxonomyActive(archivedPartsId, false);

  addItem('Blower Wheel', partsId);
  addItem('HEPA Cartridge', otherPartsId);
  addItem('Degreaser', chemicalsId);
  addItem('Legacy Gasket', archivedPartsId);
  addItem('Uncategorized Widget', null);
});

// ── the flag ────────────────────────────────────────────────────────────────

test('parseItemTypeMeta reads parts=true and defaults it to false', () => {
  assert.equal(taxonomy.parseItemTypeMeta('{"parts":true}').parts, true);
  assert.equal(taxonomy.parseItemTypeMeta('{"units":["each"]}').parts, false);
  assert.equal(taxonomy.parseItemTypeMeta(null).parts, false);
  // Malformed JSON must not throw into a picker's render.
  assert.equal(taxonomy.parseItemTypeMeta('{nope').parts, false);
  // Only a real boolean true counts — a truthy string must not flag a category.
  assert.equal(taxonomy.parseItemTypeMeta('{"parts":"yes"}').parts, false);
});

test('getPartsCategoryIds returns every ACTIVE flagged category and nothing else', () => {
  const ids = taxonomy.getPartsCategoryIds();
  assert.deepEqual([...ids].sort(), [partsId, otherPartsId].sort());
  assert.equal(ids.includes(chemicalsId), false);
  // Archiving a category must drop it from the parts search.
  assert.equal(ids.includes(archivedPartsId), false);
});

test('setTaxonomyParts toggles meta.parts while preserving units and classId', () => {
  taxonomy.setTaxonomyParts(chemicalsId, true);
  let meta = taxonomy.parseItemTypeMeta(
    taxonomy.getItemTypes().find(t => t.id === chemicalsId)?.meta,
  );
  assert.equal(meta.parts, true);
  assert.deepEqual(meta.units, ['gallon'], 'units must survive the flag write');
  assert.equal(meta.classId, 'class-liquid', 'classId must survive the flag write');
  assert.ok(taxonomy.getPartsCategoryIds().includes(chemicalsId));

  // Unflagging removes the key rather than storing `false`, so a category that
  // was never flagged and one that was unflagged serialize identically.
  taxonomy.setTaxonomyParts(chemicalsId, false);
  const raw = taxonomy.getItemTypes().find(t => t.id === chemicalsId)?.meta ?? '';
  assert.equal(raw.includes('parts'), false);
  meta = taxonomy.parseItemTypeMeta(raw);
  assert.equal(meta.parts, false);
  assert.deepEqual(meta.units, ['gallon']);
  assert.equal(taxonomy.getPartsCategoryIds().includes(chemicalsId), false);
});

test('setTaxonomyParts mirrors the write to the outbox so the flag syncs', () => {
  const before = (testDb.getDb().executeSync(
    `SELECT COUNT(*) AS n FROM outbox WHERE table_name = 'taxonomy_types'`,
  ).rows[0] as { n: number }).n;
  taxonomy.setTaxonomyParts(partsId, true);
  const after = (testDb.getDb().executeSync(
    `SELECT COUNT(*) AS n FROM outbox WHERE table_name = 'taxonomy_types'`,
  ).rows[0] as { n: number }).n;
  assert.ok(after > before, 'expected a taxonomy_types outbox row');
});

// ── the filter ──────────────────────────────────────────────────────────────

test('searchItems with a category-id ARRAY returns only items in those categories', () => {
  const names = items.searchItems('', 50, 0, undefined, undefined, undefined,
    [partsId, otherPartsId]).map(i => i.name).sort();
  assert.deepEqual(names, ['Blower Wheel', 'HEPA Cartridge']);
});

test('searchItems array filter still honours the text query', () => {
  const names = items.searchItems('blower', 50, 0, undefined, undefined, undefined,
    [partsId, otherPartsId]).map(i => i.name);
  assert.deepEqual(names, ['Blower Wheel']);
});

test('searchItems with an EMPTY category array matches nothing, not everything', () => {
  // The whole point of the scope: "no category is flagged as parts" must not
  // fall back to offering the entire catalog in the Use-parts sheet.
  assert.deepEqual(
    items.searchItems('', 50, 0, undefined, undefined, undefined, []),
    [],
  );
});

test('searchItems with a single category-id STRING is unchanged', () => {
  const names = items.searchItems('', 50, 0, undefined, undefined, undefined, chemicalsId)
    .map(i => i.name);
  assert.deepEqual(names, ['Degreaser']);
});

test('searchItems with no category filter still returns the whole catalog', () => {
  const names = items.searchItems('', 50).map(i => i.name).sort();
  assert.deepEqual(names, [
    'Blower Wheel', 'Degreaser', 'HEPA Cartridge', 'Legacy Gasket', 'Uncategorized Widget',
  ]);
});

// ── the repairable flag (#283) ──────────────────────────────────────────────

test('parseItemTypeMeta reads repairable=true and defaults it to false', () => {
  assert.equal(taxonomy.parseItemTypeMeta('{"repairable":true}').repairable, true);
  assert.equal(taxonomy.parseItemTypeMeta('{"units":["each"]}').repairable, false);
  assert.equal(taxonomy.parseItemTypeMeta(null).repairable, false);
  assert.equal(taxonomy.parseItemTypeMeta('{nope').repairable, false);
  assert.equal(taxonomy.parseItemTypeMeta('{"repairable":"yes"}').repairable, false);
  // The two flags are independent — a parts category is not repairable by
  // default, and vice versa.
  assert.equal(taxonomy.parseItemTypeMeta('{"parts":true}').repairable, false);
  assert.equal(taxonomy.parseItemTypeMeta('{"repairable":true}').parts, false);
});

test('getRepairableCategoryIds is OPT-IN: empty until a category is flagged', () => {
  // The whole point of #283. Nothing in the seed sets `repairable`, so no item
  // anywhere offers "Report repair" until an admin ticks a category.
  assert.deepEqual(taxonomy.getRepairableCategoryIds(), []);

  taxonomy.setTaxonomyRepairable(partsId, true);
  assert.deepEqual(taxonomy.getRepairableCategoryIds(), [partsId]);
  // Flagging one category must not drag the others in.
  assert.equal(taxonomy.getRepairableCategoryIds().includes(chemicalsId), false);
});

test('setTaxonomyRepairable preserves the other meta keys and unsets cleanly', () => {
  taxonomy.setTaxonomyRepairable(chemicalsId, true);
  let meta = taxonomy.parseItemTypeMeta(
    taxonomy.getItemTypes().find(t => t.id === chemicalsId)?.meta,
  );
  assert.equal(meta.repairable, true);
  assert.deepEqual(meta.units, ['gallon'], 'units must survive the flag write');
  assert.equal(meta.classId, 'class-liquid', 'classId must survive the flag write');

  taxonomy.setTaxonomyRepairable(chemicalsId, false);
  const raw = taxonomy.getItemTypes().find(t => t.id === chemicalsId)?.meta ?? '';
  assert.equal(raw.includes('repairable'), false, 'off must DELETE the key, not store false');
  assert.deepEqual(taxonomy.parseItemTypeMeta(raw).units, ['gallon']);
  assert.equal(taxonomy.getRepairableCategoryIds().includes(chemicalsId), false);
});

test('archiving a category drops it from the repairable set', () => {
  taxonomy.setTaxonomyRepairable(archivedPartsId, true);
  assert.equal(taxonomy.getRepairableCategoryIds().includes(archivedPartsId), false);
});

test('the two flags coexist on one category without clobbering each other', () => {
  taxonomy.setTaxonomyParts(otherPartsId, true);
  taxonomy.setTaxonomyRepairable(otherPartsId, true);
  const meta = taxonomy.parseItemTypeMeta(
    taxonomy.getItemTypes().find(t => t.id === otherPartsId)?.meta,
  );
  assert.equal(meta.parts, true);
  assert.equal(meta.repairable, true);

  // Turning one off leaves the other standing — the #283 patcher writes a
  // single key rather than rewriting the whole blob.
  taxonomy.setTaxonomyParts(otherPartsId, false);
  const after = taxonomy.parseItemTypeMeta(
    taxonomy.getItemTypes().find(t => t.id === otherPartsId)?.meta,
  );
  assert.equal(after.parts, false);
  assert.equal(after.repairable, true);
});

test('setTaxonomyRepairable mirrors the write to the outbox so the flag syncs', () => {
  const count = () => (testDb.getDb().executeSync(
    `SELECT COUNT(*) AS n FROM outbox WHERE table_name = 'taxonomy_types'`,
  ).rows[0] as { n: number }).n;
  const before = count();
  taxonomy.setTaxonomyRepairable(chemicalsId, true);
  assert.ok(count() > before, 'expected a taxonomy_types outbox row');
});
