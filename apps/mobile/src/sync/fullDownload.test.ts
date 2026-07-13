import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

// fullDownload.ts cannot be imported here: it pulls in db/schema -> op-sqlite
// (native), which will not load under `node --test`. So assert against source.
//
// Why this test exists: the generic applyRows arm names INSERT columns from the
// SERVER row's keys. The server can be migrations ahead of this bundle (web
// deploys and field APKs lag the API), so those keys must be intersected with
// the LOCAL table's columns first — an unknown column in the INSERT kills
// first-launch enrollment ("table media has no column named location_note").
const SRC = readFileSync(join(dirname(new URL(import.meta.url).pathname), 'fullDownload.ts'), 'utf8');

test('generic upsert filters server row keys to local columns', () => {
  assert.ok(SRC.includes('PRAGMA table_info'), 'applyRows must read the local table columns');
  assert.match(
    SRC, /Object\.keys\(row\)\.filter\(c => known\.has\(c\)\)/,
    'server row keys must be intersected with local columns before building the INSERT',
  );
  assert.ok(!SRC.includes('Object.values(row)'),
    'values must come from the FILTERED column list, not the raw row');
});
