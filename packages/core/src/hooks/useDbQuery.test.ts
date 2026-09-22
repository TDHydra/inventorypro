import { test } from 'node:test';
import assert from 'node:assert/strict';
import { subscribeFor, snapshotFor } from './useDbQuery';
import { bumpTablesVersion, bumpDataVersion } from '../sync/dataVersion';

// useDbQuery is a thin useSyncExternalStore + useMemo composition around
// subscribeFor/snapshotFor — React's own useMemo/useSyncExternalStore
// machinery isn't re-tested here (no component renderer is wired into this
// repo's `node --test` harness; every other hook test in this repo tests
// extracted pure logic the same way, e.g. sameRows in useReactiveRows.test.ts).
// What IS this hook's own logic — which pair of (subscribe, getSnapshot) gets
// used for a given `tables` argument — is exercised directly below.

test('snapshotFor(tables): per-table version, unaffected by an unrelated table bump (#64)', () => {
  const before = snapshotFor(['inventory_items']);
  bumpTablesVersion(['inventory_items']);
  assert.equal(snapshotFor(['inventory_items']), before + 1);
  // an unrelated table's bump must not change this call site's snapshot — the
  // crux of the per-table perf win useDbQuery(fn, deps, tables) exists for.
  const unrelatedBefore = snapshotFor(['messages']);
  bumpTablesVersion(['inventory_items']);
  assert.equal(snapshotFor(['messages']), unrelatedBefore);
});

test('subscribeFor(tables): fires only when a subscribed table changes', () => {
  let calls = 0;
  const unsub = subscribeFor(['jobs', 'taxonomy_types'], () => { calls++; });
  bumpTablesVersion(['messages']);           // unrelated → no fire
  assert.equal(calls, 0);
  bumpTablesVersion(['taxonomy_types']);     // subscribed → fire once
  assert.equal(calls, 1);
  unsub();
  bumpTablesVersion(['jobs']);               // after unsub → no fire
  assert.equal(calls, 1);
});

test('snapshotFor(undefined): falls back to the global data-version counter', () => {
  const before = snapshotFor(undefined);
  bumpTablesVersion(['anything']);  // per-table bump also bumps the global counter
  assert.equal(snapshotFor(undefined), before + 1);
  bumpDataVersion();
  assert.equal(snapshotFor(undefined), before + 2);
});

test('subscribeFor(undefined): fires on ANY table bump (global subscription)', () => {
  let calls = 0;
  const unsub = subscribeFor(undefined, () => { calls++; });
  bumpTablesVersion(['some_table']);
  assert.equal(calls, 1);
  bumpTablesVersion(['a_completely_different_table']);
  assert.equal(calls, 2);
  unsub();
  bumpDataVersion();
  assert.equal(calls, 2);
});
