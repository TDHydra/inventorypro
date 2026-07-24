import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Phase A1 migrations run against prod PG on API boot — no live PG in CI, so
// assert the SQL text invariants (the pullColumns.test.ts source-text idiom).
const DIR = join(__dirname, 'migrations');
const read = (f: string) => readFileSync(join(DIR, f), 'utf8');

test('057: two TEXT tank columns with the pinned defaults, never a PG enum', () => {
  const sql = read('057_two_tanks.sql');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS water_tank TEXT NOT NULL DEFAULT 'empty'/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS waste_tank TEXT NOT NULL DEFAULT 'clean'/);
  assert.doesNotMatch(sql, /CREATE TYPE/i);
  assert.doesNotMatch(sql, /DROP COLUMN/i); // water_state stays
});

test('057: backfill maps water_state=full → water_tank=full and touches updated_at (watermark)', () => {
  const sql = read('057_two_tanks.sql');
  assert.match(sql, /SET water_tank = 'full', updated_at = NOW\(\)\s+WHERE water_state = 'full'/);
});

test('058: unit_access has the pinned columns, composite PK, and BOOLEAN (not enum) actions', () => {
  const sql = read('058_unit_access.sql');
  for (const col of ['can_view', 'can_add', 'can_remove', 'can_move', 'can_edit_details', 'can_grant']) {
    assert.match(sql, new RegExp(`${col}\\s+BOOLEAN NOT NULL DEFAULT`));
  }
  assert.match(sql, /PRIMARY KEY \(location_id, user_id\)/);
  assert.doesNotMatch(sql, /CREATE TYPE/i);
});

test('058: copies locker_access grants as view+add+remove+move with NOW() watermark', () => {
  const sql = read('058_unit_access.sql');
  assert.match(sql, /SELECT location_id, user_id, TRUE, TRUE, TRUE, TRUE, FALSE, FALSE, granted_by, created_at, NOW\(\)\s+FROM locker_access/);
  assert.match(sql, /ON CONFLICT \(location_id, user_id\) DO NOTHING/);
  assert.doesNotMatch(sql, /DROP TABLE/i); // locker_access stays
});

test('059: flatten re-points stock with a summed upsert and zeroes+retires children with NOW()', () => {
  const sql = read('059_flatten_and_dedupe.sql');
  assert.match(sql, /WITH RECURSIVE/);
  assert.match(sql, /GROUP BY s\.item_id, uc\.unit_id/); // pre-aggregated: ON CONFLICT DO UPDATE may not hit a row twice
  assert.match(sql, /SET quantity = stock_by_location\.quantity \+ EXCLUDED\.quantity, updated_at = NOW\(\)/);
  assert.match(sql, /SET quantity = 0, updated_at = NOW\(\)/);
  assert.match(sql, /SET active = FALSE, updated_at = NOW\(\)/);
});

test('059: vehicle dedupe survivor choice matches mobile 047 (updated_at ASC, id::text ASC)', () => {
  const sql = read('059_flatten_and_dedupe.sql');
  assert.match(sql, /PARTITION BY LOWER\(TRIM\(name\)\) ORDER BY updated_at ASC, id::text ASC/);
  for (const t of ['vehicle_checkouts', 'vehicle_service_records', 'equipment_units']) {
    assert.ok(sql.includes(t), `${t} re-pointed`);
  }
});

// ── Phase 0 (#152/#155/#167): vehicle options wave ───────────────────────────

test('065: four vehicle option columns, pinned defaults, never a PG enum', () => {
  const sql = read('065_vehicle_options.sql');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS debris_option BOOLEAN NOT NULL DEFAULT false/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS debris_level INTEGER NOT NULL DEFAULT 0/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS open_checkout BOOLEAN NOT NULL DEFAULT false/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS locked_by UUID/);
  assert.doesNotMatch(sql, /CREATE TYPE/i);
  assert.doesNotMatch(sql, /DROP COLUMN/i);
});

test('065: no backfill — defaults converge, no watermark bump wanted', () => {
  const sql = read('065_vehicle_options.sql');
  assert.doesNotMatch(sql, /UPDATE vehicles/i);
});
