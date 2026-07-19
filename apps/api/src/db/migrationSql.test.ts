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
