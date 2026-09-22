import { test } from 'node:test';
import assert from 'node:assert';
import {
  bumpTablesVersion, subscribeTables, getTablesVersion,
  bumpDataVersion, subscribeDataVersion, getDataVersion,
} from './dataVersion';

test('bumpTablesVersion bumps only the changed tables (#64)', () => {
  const invBefore = getTablesVersion(['inventory_items']);
  const msgBefore = getTablesVersion(['messages']);
  bumpTablesVersion(['inventory_items']);
  assert.equal(getTablesVersion(['inventory_items']), invBefore + 1);
  // an unrelated table is untouched — the crux of the perf fix
  assert.equal(getTablesVersion(['messages']), msgBefore);
});

test('subscribeTables fires only when a subscribed table changes', () => {
  let calls = 0;
  const unsub = subscribeTables(['inventory_items', 'stock_by_location'], () => { calls++; });
  bumpTablesVersion(['messages']);          // unrelated → no fire
  assert.equal(calls, 0);
  bumpTablesVersion(['stock_by_location']); // subscribed → fire once
  assert.equal(calls, 1);
  unsub();
  bumpTablesVersion(['inventory_items']);   // after unsub → no fire
  assert.equal(calls, 1);
});

test('bumpTablesVersion also bumps the global counter (backward compatible)', () => {
  const before = getDataVersion();
  bumpTablesVersion(['taxonomy_types']);
  assert.equal(getDataVersion(), before + 1);
  // an empty change set is a no-op — no global bump, no listener churn
  const after = getDataVersion();
  bumpTablesVersion([]);
  assert.equal(getDataVersion(), after);
});

test('global useDataVersion subscribers still fire on any per-table bump', () => {
  let calls = 0;
  const unsub = subscribeDataVersion(() => { calls++; });
  bumpTablesVersion(['inventory_items']); // per-table bump reaches global listeners
  assert.equal(calls, 1);
  bumpDataVersion();                       // legacy path still works
  assert.equal(calls, 2);
  unsub();
});
