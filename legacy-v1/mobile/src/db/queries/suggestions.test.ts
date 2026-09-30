import { createRequire } from 'node:module';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// suggestions.ts can't load under `node --test` as-is: db/schema imports the
// native op-sqlite binding (which drags in expo). Reuse the Module._load
// redirect established by locationsShelf.test.ts / chat.test.ts /
// taxonomyIcon.test.ts: db/schema becomes the REAL sql.js database
// (locationsShelf.testdb.ts), so getDistinctColumnValues runs its actual SQL
// against actual SQLite rather than a source-text stand-in. That testdb only
// provisions the tables locations.ts needs (locations/taxonomy_types/outbox +
// minimal stock tables), so this file adds the jobs table and re-creates
// inventory_items itself, scoped to just the whitelisted columns under test.
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

let suggestions: typeof import('./suggestions');

before(async () => {
  await testDb.initTestDb();
  suggestions = requireCjs('./suggestions') as typeof import('./suggestions');

  const db = testDb.getDb();
  // The shared testdb now provisions a minimal inventory_items (id/name/active,
  // for getStockAtLocation in locationsShelf.test.ts). This suite asserts on the
  // suggestion-whitelist columns (supplier/sku/model/unit), so replace it with
  // the wider shape rather than colliding on CREATE.
  db.executeSync(`DROP TABLE IF EXISTS inventory_items`);
  db.executeSync(`
    CREATE TABLE inventory_items (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, sku TEXT, supplier TEXT,
      model TEXT, unit TEXT NOT NULL DEFAULT 'ea', updated_at TEXT
    )
  `);
  db.executeSync(`
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, customer_name TEXT,
      insurance_carrier TEXT, site_address TEXT, reference_number TEXT,
      updated_at TEXT
    )
  `);

  // inventory_items.supplier — mixed case, dupes, blanks/whitespace/NULL to
  // exclude, for the row-mapping + ordering assertions below.
  const items: [string, string | null][] = [
    ['item-1', 'phoenix supply'],
    ['item-2', 'Ace Hardware'],
    ['item-3', 'phoenix supply'], // dup of item-1's value — DISTINCT must collapse it
    ['item-4', '  '], // whitespace-only — excluded
    ['item-5', null], // NULL — excluded
    ['item-6', 'ACE HARDWARE'], // same value, different case as item-2 — DISTINCT is case-sensitive on the raw value, both must survive; ordering is case-insensitive
    ['item-7', 'Zenith Tools'],
  ];
  for (const [id, supplier] of items) {
    db.executeSync(
      `INSERT INTO inventory_items (id, name, supplier, unit, updated_at) VALUES (?, 'Widget', ?, 'ea', '2026-07-18T00:00:00.000Z')`,
      [id, supplier],
    );
  }

  db.executeSync(
    `INSERT INTO jobs (id, name, customer_name, updated_at) VALUES ('job-1', 'J1', 'Smith Residence', '2026-07-18T00:00:00.000Z')`,
  );
  db.executeSync(
    `INSERT INTO locations (id, name, active, updated_at) VALUES ('loc-1', 'Main Shop', 1, '2026-07-18T00:00:00.000Z')`,
  );
});

test('throws for a non-whitelisted column on a whitelisted table', () => {
  assert.throws(
    () => suggestions.getDistinctColumnValues('inventory_items', 'category' as never),
    /not a suggestible column/,
  );
});

test('throws for a non-whitelisted table entirely', () => {
  assert.throws(
    () => suggestions.getDistinctColumnValues('users' as never, 'name' as never),
    /not a suggestible column/,
  );
});

test('rejects a SQL-injection-shaped column before it ever reaches a query string', () => {
  // If the whitelist guard ran after (or not at all), this would either throw
  // a raw SQLite syntax error or — worse — execute. Asserting the specific
  // whitelist message (not just "throws") proves the guard, not the SQL
  // engine, is what stops it.
  assert.throws(
    () => suggestions.getDistinctColumnValues('inventory_items', "sku; DROP TABLE inventory_items; --" as never),
    /not a suggestible column/,
  );
});

test('returns distinct, non-blank values, case-insensitively ordered', () => {
  const values = suggestions.getDistinctColumnValues('inventory_items', 'supplier');
  // blanks/NULL excluded; the 'phoenix supply' dup collapses to one entry;
  // 'Ace Hardware' and 'ACE HARDWARE' are distinct raw strings (SQLite
  // DISTINCT is case-sensitive) and both survive.
  assert.deepEqual(values, ['Ace Hardware', 'ACE HARDWARE', 'phoenix supply', 'Zenith Tools']);
});

test('works for jobs and locations tables too', () => {
  assert.deepEqual(suggestions.getDistinctColumnValues('jobs', 'customer_name'), ['Smith Residence']);
  assert.deepEqual(suggestions.getDistinctColumnValues('locations', 'name'), ['Main Shop']);
});

test('a column absent from a row set returns an empty array, not an error', () => {
  assert.deepEqual(suggestions.getDistinctColumnValues('jobs', 'reference_number'), []);
});
