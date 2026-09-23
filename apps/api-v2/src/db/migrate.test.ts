import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// #238: no live PG in CI (same constraint as migrationSql.test.ts), so this
// asserts the source-text shape of the advisory-lock wrap instead of actually
// racing two migration runs against a real database.
const src = readFileSync(join(__dirname, 'migrate.ts'), 'utf8');

test('runMigrations takes a pg_advisory_lock before touching schema_migrations', () => {
  const lockIdx = src.indexOf('pg_advisory_lock');
  const createTableIdx = src.indexOf('CREATE TABLE IF NOT EXISTS schema_migrations');
  assert.ok(lockIdx >= 0, 'expected a pg_advisory_lock call');
  assert.ok(createTableIdx >= 0, 'expected the schema_migrations bootstrap');
  assert.ok(lockIdx < createTableIdx, 'the lock must be acquired before migrations run');
});

test('the lock and unlock use the same constant key', () => {
  const lockKeyMatch = src.match(/pg_advisory_lock\(\$1\)',\s*\[(\w+)\]/);
  const unlockKeyMatch = src.match(/pg_advisory_unlock\(\$1\)',\s*\[(\w+)\]/);
  assert.ok(lockKeyMatch, 'lock call should pass a bound key param');
  assert.ok(unlockKeyMatch, 'unlock call should pass a bound key param');
  assert.equal(lockKeyMatch![1], unlockKeyMatch![1]);
});

test('the unlock runs in a finally so it fires even if a migration throws', () => {
  const tryIdx = src.indexOf('try {\n      await runMigrationsLocked(client);');
  const finallyIdx = src.indexOf('pg_advisory_unlock');
  assert.ok(tryIdx >= 0, 'expected the locked run to be wrapped in try/finally');
  assert.ok(finallyIdx > tryIdx);
});

test('the lock/unlock queries run on the dedicated Client, not a pool helper', () => {
  // Advisory locks are session-scoped: a pool-per-query helper (fastify.pg.query,
  // a `pool.query(...)` convenience wrapper, etc.) can hand each call a different
  // physical connection, silently breaking the lock. Every advisory-lock line
  // here must call `client.query`, the single Client instance held for the
  // whole run.
  const lockLines = src.split('\n').filter(l => /pg_advisory_(un)?lock\(\$1\)/.test(l));
  assert.ok(lockLines.length >= 2);
  for (const line of lockLines) {
    assert.match(line, /^\s*await client\.query\(/, `expected client.query, got: ${line}`);
  }
});

test('runMigrations still closes the connection (client.end) even if the locked run throws', () => {
  // The outer try/finally around client.connect()/client.end() must remain —
  // losing it would leak a connection on every failed migration.
  const outerTryIdx = src.indexOf('await client.connect();');
  const endIdx = src.lastIndexOf('await client.end();');
  assert.ok(outerTryIdx >= 0 && endIdx > outerTryIdx);
});
