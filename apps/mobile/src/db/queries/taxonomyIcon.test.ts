import { createRequire } from 'node:module';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// taxonomy.ts can't load under `node --test` as-is: db/schema imports the native
// op-sqlite binding (which drags in expo) and utils/uuid imports
// react-native-get-random-values. Intercept Module._load (tsx runs this package
// as CommonJS) and swap db/schema for a REAL sql.js database
// (locationsShelf.testdb.ts, which already provisions taxonomy_types) so
// getTypeIcon runs end-to-end against actual SQLite — including its new
// per-category default-icon fallback.
const requireCjs = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Module = requireCjs('node:module') as any;
const testDb = requireCjs('./locationsShelf.testdb') as typeof import('./locationsShelf.testdb');

const origLoad = Module._load;
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'react-native-get-random-values') return {};
  let resolved = '';
  try { resolved = Module._resolveFilename(request, parent); } catch { /* not ours — fall through */ }
  if (resolved.endsWith('/src/db/schema.ts')) return testDb;
  return origLoad.call(this, request, parent, isMain);
};

let taxonomy: typeof import('./taxonomy');
let styles: typeof import('../../constants/locationStyles');

const NOW = '2026-07-17T00:00:00.000Z';

function seedType(row: { category: string; label: string; icon: string | null }) {
  testDb.getDb().executeSync(
    `INSERT INTO taxonomy_types (id, category, label, icon, sort_order, active, updated_at)
     VALUES (?, ?, ?, ?, 0, 1, ?)`,
    [`${row.category}:${row.label}`, row.category, row.label, row.icon, NOW],
  );
}

before(async () => {
  await testDb.initTestDb();
  taxonomy = requireCjs('./taxonomy') as typeof import('./taxonomy');
  styles = requireCjs('../../constants/locationStyles') as typeof import('../../constants/locationStyles');
  seedType({ category: taxonomy.EQUIPMENT_CATEGORY, label: 'Air Mover', icon: '🌀' });
  seedType({ category: taxonomy.EQUIPMENT_CATEGORY, label: 'Ladder', icon: null });
  seedType({ category: taxonomy.JOB_CATEGORY, label: 'Water Damage', icon: null });
});

test('returns the row\'s own icon when one is set', () => {
  assert.equal(taxonomy.getTypeIcon(taxonomy.EQUIPMENT_CATEGORY, 'Air Mover'), '🌀');
});

test('falls back to the category default when the row icon is null', () => {
  assert.equal(
    taxonomy.getTypeIcon(taxonomy.EQUIPMENT_CATEGORY, 'Ladder'),
    styles.CATEGORY_DEFAULT_ICON[taxonomy.EQUIPMENT_CATEGORY],
  );
  assert.equal(
    taxonomy.getTypeIcon(taxonomy.JOB_CATEGORY, 'Water Damage'),
    styles.CATEGORY_DEFAULT_ICON[taxonomy.JOB_CATEGORY],
  );
});

test('falls back to the category default when NO taxonomy row exists (free-typed label)', () => {
  assert.equal(
    taxonomy.getTypeIcon(taxonomy.TEAM_CATEGORY, 'Some Ad-hoc Crew'),
    styles.CATEGORY_DEFAULT_ICON[taxonomy.TEAM_CATEGORY],
  );
});

test('returns null for an unknown category with no row and no default', () => {
  assert.equal(taxonomy.getTypeIcon('not_a_real_category', 'X'), null);
});

test('every known taxonomy category has a distinct default icon', () => {
  const cats = [
    taxonomy.ITEM_CATEGORY, taxonomy.JOB_CATEGORY, taxonomy.TEAM_CATEGORY,
    taxonomy.EQUIPMENT_CATEGORY, taxonomy.LOCATION_TYPE, taxonomy.LOCATION_SUBTYPE,
    taxonomy.REPAIR_STATUS, 'product_class',
  ];
  const icons = cats.map(c => styles.CATEGORY_DEFAULT_ICON[c]);
  for (const c of cats) assert.ok(styles.CATEGORY_DEFAULT_ICON[c], `missing default for ${c}`);
  assert.equal(new Set(icons).size, icons.length, 'category default icons must be distinct');
});
