import { createRequire } from 'node:module';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// unitGrants.ts can't load under `node --test` as-is: its upsertUnitAccess
// import pulls db/schema (native op-sqlite binding), sync/outbox → utils/uuid
// (react-native-get-random-values), and queries/log → telemetry / expo-location
// (react-native / expo, which don't parse outside Metro). Same harness as
// unitAccessDefaults.test.ts: intercept Module._load (tsx runs this package's
// TS as CommonJS, so ESM loader hooks would not see the transitive requires)
// and swap those for node-safe stand-ins. These tests only exercise the PURE
// export (buildDefaultGrantRow), so schema is a throwing stub.
const requireCjs = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Module = requireCjs('node:module') as any;

const origLoad = Module._load;
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  // Side-effect-only crypto polyfill; node already has crypto.getRandomValues.
  if (request === 'react-native-get-random-values') return {};
  // The GPS-stamping log path (#33) transitively imports expo-location, which
  // pulls in expo / expo-modules-core / react-native — none of which parse under
  // tsx/esbuild (react-native/index.js is Flow-typed) or run outside Metro. These
  // tests never exercise logging, so hand back a benign no-op stub for each.
  if (request === 'react-native' || request === 'expo' || request === 'expo-modules-core') {
    return new Proxy({ __esModule: true }, { get: (_t, p) => (p === '__esModule' ? true : () => {}) });
  }
  let resolved = '';
  try { resolved = Module._resolveFilename(request, parent); } catch { /* not ours — fall through */ }
  if (resolved.endsWith('/src/db/schema.ts')) {
    return { getDb() { throw new Error('db not available in pure row-shaper tests'); } };
  }
  if (resolved.endsWith('/src/telemetry/index.ts')) return { track() {} };
  return origLoad.call(this, request, parent, isMain);
};

let mod: typeof import('./unitGrants');
before(() => {
  mod = requireCjs('./unitGrants') as typeof import('./unitGrants');
});

test('buildDefaultGrantRow maps template booleans to 0/1 columns with attribution + timestamps', () => {
  const { buildDefaultGrantRow } = mod;
  const row = buildDefaultGrantRow('loc-1', 'user-2',
    { view: true, add: true, remove: true, move: false, editDetails: false, grant: false },
    'actor-9', '2026-07-19T00:00:00.000Z');
  assert.deepEqual(row, {
    location_id: 'loc-1', user_id: 'user-2',
    can_view: 1, can_add: 1, can_remove: 1, can_move: 0, can_edit_details: 0, can_grant: 0,
    granted_by: 'actor-9', created_at: '2026-07-19T00:00:00.000Z', updated_at: '2026-07-19T00:00:00.000Z',
  });
});
