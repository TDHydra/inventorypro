import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMediaHubQuery } from './mediaHubQuery';

test('open filter: job media on open jobs only', () => {
  const { sql, params } = buildMediaHubQuery('open', '', 30, 0);
  assert.ok(sql.includes(`m.entity_type = 'job'`));
  assert.ok(sql.includes(`j.status = 'open'`));
  assert.deepEqual(params, [30, 0]);
});

test('all filter: job media regardless of status', () => {
  const { sql } = buildMediaHubQuery('all', '', 30, 0);
  assert.ok(sql.includes(`WHERE m.entity_type = 'job'`));
  // j.status appears in the SELECT list (job_status display column) but must
  // not be filtered on.
  assert.ok(!sql.includes(`j.status = 'open'`));
});

test('everything filter: no entity restriction at all', () => {
  const { sql } = buildMediaHubQuery('everything', '', 30, 0);
  assert.ok(!sql.includes('WHERE'));
  // the display joins must still be present for job/uploader names
  assert.ok(sql.includes('LEFT JOIN jobs'));
  assert.ok(sql.includes('LEFT JOIN users'));
});

test('search adds one LIKE param per searched column, always parameterized', () => {
  const { sql, params } = buildMediaHubQuery('open', 'master bedroom', 30, 60);
  assert.ok(sql.includes('j.name LIKE ?'));
  assert.ok(sql.includes('m.location_note LIKE ?'));
  assert.ok(sql.includes('m.caption LIKE ?'));
  assert.ok(sql.includes('u.name LIKE ?'));
  // 4 LIKEs + limit + offset; the search text NEVER lands in the SQL string
  assert.deepEqual(params, ['%master bedroom%', '%master bedroom%', '%master bedroom%', '%master bedroom%', 30, 60]);
  assert.ok(!sql.includes('master bedroom'));
});

test('whitespace-only search is ignored; pagination params always trail', () => {
  const { sql, params } = buildMediaHubQuery('all', '   ', 30, 90);
  assert.ok(!sql.includes('LIKE'));
  assert.deepEqual(params, [30, 90]);
  assert.ok(sql.trimEnd().endsWith('LIMIT ? OFFSET ?'));
});

test('newest-first ordering', () => {
  const { sql } = buildMediaHubQuery('everything', '', 30, 0);
  assert.ok(sql.includes('ORDER BY m.created_at DESC'));
});
