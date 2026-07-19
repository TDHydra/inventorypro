import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

// Phase A1 migrations run against prod PG on API boot — no live PG in CI, so
// assert the SQL text invariants (the pullColumns.test.ts source-text idiom).
const DIR = join(dirname(new URL(import.meta.url).pathname), 'migrations');
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
