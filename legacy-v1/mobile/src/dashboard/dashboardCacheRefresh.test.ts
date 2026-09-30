import { createRequire } from 'node:module';
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// store.ts can't be imported here as-is: it pulls in db/queries/dashboards and
// db/userPrefs, both of which import db/schema -> op-sqlite (native, can't
// load under `node --test`). Reuse the Module._load redirect established by
// tx.test.ts / locationsShelf.test.ts: db/queries/dashboards becomes the
// in-memory fake (dashboards.testdb.ts) and db/userPrefs becomes a trivial
// stub (no personal layout), so loadDashboardCache()/resolveLayoutFor() run
// as REAL store.ts logic against controllable state.
//
// Regression for #192: dashboards.tsx's persist() (the single choke point for
// reorder/toggleWidth/removeBlock/addWidget/saveBlockConfig) wrote the new
// layout via setDashboardPresetLayout but never called loadDashboardCache()
// afterwards. presetsById is a module-level cache read by resolveLayoutFor —
// refreshed only at boot/sync-pull — so the editing admin (and everyone else
// resolved onto that preset) kept rendering the OLD layout until the next
// pull or app restart. This test proves the exact mechanism the fix depends
// on: a preset write is invisible to resolveLayoutFor until
// loadDashboardCache() runs, and becomes visible immediately once it does.
const requireCjs = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Module = requireCjs('node:module') as any;
const fakeDashboards = requireCjs('../db/queries/dashboards.testdb') as typeof import('../db/queries/dashboards.testdb');

const origLoad = Module._load;
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'react-native-get-random-values') return {};
  let resolved = '';
  try { resolved = Module._resolveFilename(request, parent); } catch { /* not ours — fall through */ }
  if (resolved.endsWith('/src/db/queries/dashboards.ts')) return fakeDashboards;
  if (resolved.endsWith('/src/db/userPrefs.ts')) return { getDashboardPrefs: () => null };
  return origLoad.call(this, request, parent, isMain);
};

let store: typeof import('./store');

before(async () => {
  store = requireCjs('./store') as typeof import('./store');
});

beforeEach(() => {
  fakeDashboards.__reset();
});

const ADMIN = {
  id: 'u1',
  name: 'Admin',
  role: 'full_admin' as const,
  permission_overrides: {},
  pin_length_required: 4,
  active: 1,
  expires_at: null,
};

const ORIGINAL_LAYOUT = [{ widget: 'checkout', width: 'full' as const }];
const EDITED_LAYOUT = [{ widget: 'jobs', width: 'full' as const }, { widget: 'checkout', width: 'half' as const }];

function seedPresetAssignedToRole(): void {
  fakeDashboards.__seedPreset({
    id: 'p1',
    name: 'Ops preset',
    layout: JSON.stringify(ORIGINAL_LAYOUT),
    active: 1,
    updated_at: '2026-01-01T00:00:00.000Z',
  });
  fakeDashboards.__seedRolePreset('full_admin', 'p1');
}

test('resolveLayoutFor reflects the assigned preset once the cache is (re)loaded', () => {
  seedPresetAssignedToRole();
  store.loadDashboardCache();
  assert.deepEqual(store.resolveLayoutFor(ADMIN), ORIGINAL_LAYOUT);
});

test('#192 regression: a preset write is INVISIBLE until loadDashboardCache() runs', () => {
  seedPresetAssignedToRole();
  store.loadDashboardCache();
  assert.deepEqual(store.resolveLayoutFor(ADMIN), ORIGINAL_LAYOUT);

  // Simulate dashboards.tsx's persist() writing the edited layout to the DB —
  // this is the real write path (setDashboardPresetLayout), just against the
  // fake. Deliberately do NOT call loadDashboardCache() yet.
  fakeDashboards.setDashboardPresetLayout('p1', EDITED_LAYOUT);

  // The bug: presetsById is stale, so the resolver still returns the OLD
  // layout — this is what the editing admin saw before #192 was fixed.
  assert.deepEqual(store.resolveLayoutFor(ADMIN), ORIGINAL_LAYOUT);

  // The fix: dashboards.tsx's persist() must call loadDashboardCache() right
  // after the write. Once it does, the resolver sees the new layout live.
  store.loadDashboardCache();
  assert.deepEqual(store.resolveLayoutFor(ADMIN), EDITED_LAYOUT);
});

test('loadDashboardCache() notifies subscribers (useDashboardLayout/useSyncExternalStore wiring)', () => {
  seedPresetAssignedToRole();
  store.loadDashboardCache();
  let fired = 0;
  const off = store.subscribeDashboard(() => { fired++; });
  const versionBefore = store.getDashboardVersion();
  fakeDashboards.setDashboardPresetLayout('p1', EDITED_LAYOUT);
  store.loadDashboardCache();
  assert.equal(fired, 1);
  assert.equal(store.getDashboardVersion(), versionBefore + 1);
  off();
});
