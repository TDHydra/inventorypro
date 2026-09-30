import { createRequire } from 'node:module';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// #65 — loadClassConfigCache() must notify subscribers so class-decimals UI
// re-renders after a sync pull. units.ts can't load under `node --test` as-is:
// it imports db/queries/taxonomy, which pulls db/schema -> the native op-sqlite
// binding (won't load in node) and utils/uuid -> react-native-get-random-values.
// Following the locationsShelf.test.ts / chat.test.ts Module._load redirect
// (tsx runs this package's TS as CommonJS, so ESM loader hooks would not see the
// transitive requires), stub the ONE dependency units.ts actually imports —
// db/queries/taxonomy — with a node-safe fake. This is the minimal surface: the
// real DB never loads, and getProductClasses returns a controllable list so
// loadClassConfigCache's happy path runs end-to-end.
const requireCjs = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Module = requireCjs('node:module') as any;

let classes: Array<{ id: string; allowDecimals: boolean }> = [];
const taxonomyStub = {
  getProductClasses: () => classes,
  getProductClassById: () => null,
};

const origLoad = Module._load;
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  let resolved = '';
  try { resolved = Module._resolveFilename(request, parent); } catch { /* not ours — fall through */ }
  if (resolved.endsWith('/src/db/queries/taxonomy.ts')) return taxonomyStub;
  return origLoad.call(this, request, parent, isMain);
};

let units: typeof import('./units');

before(() => {
  units = requireCjs('./units') as typeof import('./units');
});

test('a subscriber is notified and the version advances when loadClassConfigCache runs', () => {
  let calls = 0;
  const unsub = units.subscribeClassConfig(() => { calls++; });

  const before = units.getClassConfigVersion();
  classes = [{ id: 'c-liquid', allowDecimals: true }];
  units.loadClassConfigCache();

  assert.equal(calls, 1, 'registered subscriber must be invoked exactly once');
  assert.equal(units.getClassConfigVersion(), before + 1, 'version must advance');

  units.loadClassConfigCache();
  assert.equal(calls, 2, 'each reload notifies again');
  assert.equal(units.getClassConfigVersion(), before + 2, 'version advances on every reload');

  unsub();
});

test('unsubscribe stops further notifications', () => {
  let calls = 0;
  const unsub = units.subscribeClassConfig(() => { calls++; });

  units.loadClassConfigCache();
  assert.equal(calls, 1, 'subscriber notified while registered');

  unsub();
  const versionAfterUnsub = units.getClassConfigVersion();
  units.loadClassConfigCache();

  assert.equal(calls, 1, 'no further notifications after unsubscribe');
  assert.equal(
    units.getClassConfigVersion(),
    versionAfterUnsub + 1,
    'version still advances even with no listeners',
  );
});

test('notify still fires when the underlying DB read throws (cache kept, UI refreshes)', () => {
  let calls = 0;
  const unsub = units.subscribeClassConfig(() => { calls++; });

  const before = units.getClassConfigVersion();
  classes = null as unknown as Array<{ id: string; allowDecimals: boolean }>; // getProductClasses() -> iterate null throws
  units.loadClassConfigCache();

  assert.equal(calls, 1, 'subscribers must still be notified after a swallowed load failure');
  assert.equal(units.getClassConfigVersion(), before + 1, 'version advances even on the catch path');

  unsub();
});
