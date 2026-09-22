import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfigCache } from './createConfigCache';

test('fallback until first reload; reload swaps the snapshot and notifies', () => {
  let value = { a: 1 };
  const cache = createConfigCache({ name: 't', load: () => value, fallback: { a: 0 } });
  assert.deepEqual(cache.get(), { a: 0 });

  let notified = 0;
  cache.subscribe(() => notified++);
  cache.reload();
  assert.deepEqual(cache.get(), { a: 1 });
  assert.equal(notified, 1);
  assert.equal(cache.version(), 1);
});

test('a throwing load keeps the previous snapshot but still notifies', () => {
  let fail = false;
  const cache = createConfigCache({
    name: 't',
    load: () => { if (fail) throw new Error('db gone'); return 42; },
    fallback: 0,
  });
  cache.reload();
  assert.equal(cache.get(), 42);
  fail = true;
  cache.reload();
  assert.equal(cache.get(), 42, 'previous snapshot kept');
  assert.equal(cache.version(), 2, 'version still bumps so subscribers settle');
});

test('afterPullHook carries the table scope and reloads on run', async () => {
  let loads = 0;
  const cache = createConfigCache({ name: 't', tables: ['role_settings'], load: () => ++loads, fallback: 0 });
  assert.deepEqual(cache.afterPullHook.tables, ['role_settings']);
  assert.equal(cache.afterPullHook.name, 'cache:t');
  await cache.afterPullHook.run(new Set(['role_settings']));
  assert.equal(cache.get(), 1);
});
