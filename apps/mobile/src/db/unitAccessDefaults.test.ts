import { createRequire } from 'node:module';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// unitAccessDefaults.ts can't load under `node --test` as-is: appConfig /
// outbox pull in db/schema (native op-sqlite binding) and utils/uuid imports
// react-native-get-random-values. Same harness as unitAccess.test.ts:
// intercept Module._load (tsx runs this package's TS as CommonJS, so ESM
// loader hooks would not see the transitive requires) and swap those for
// node-safe stand-ins. These tests only exercise the PURE exports
// (parseUnitAccessDefaults / FALLBACK_ACTIONS), so schema is a throwing stub.
const requireCjs = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Module = requireCjs('node:module') as any;

const origLoad = Module._load;
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  // Side-effect-only crypto polyfill; node already has crypto.getRandomValues.
  if (request === 'react-native-get-random-values') return {};
  let resolved = '';
  try { resolved = Module._resolveFilename(request, parent); } catch { /* not ours — fall through */ }
  if (resolved.endsWith('/src/db/schema.ts')) {
    return { getDb() { throw new Error('db not available in pure-parse tests'); } };
  }
  return origLoad.call(this, request, parent, isMain);
};

let mod: typeof import('./unitAccessDefaults');
before(() => {
  mod = requireCjs('./unitAccessDefaults') as typeof import('./unitAccessDefaults');
});

test('missing key / bad JSON / non-object → empty map (callers fall back per-role)', () => {
  const { parseUnitAccessDefaults } = mod;
  assert.deepEqual(parseUnitAccessDefaults(null), {});
  assert.deepEqual(parseUnitAccessDefaults('{not json'), {});
  assert.deepEqual(parseUnitAccessDefaults('[1,2]'), {});
});

test('unknown roles and junk values are dropped; partial action maps backfill from FALLBACK_ACTIONS', () => {
  const { parseUnitAccessDefaults, FALLBACK_ACTIONS } = mod;
  const raw = JSON.stringify({
    mitigation_technician: { view: true, add: true, remove: true, move: false, editDetails: false, grant: false },
    not_a_role: { view: true },
    production_manager: { grant: true },   // partial → other actions from fallback
    contents_crew: 'junk',
  });
  const out = parseUnitAccessDefaults(raw);
  assert.deepEqual(Object.keys(out).sort(), ['mitigation_technician', 'production_manager']);
  assert.equal(out.mitigation_technician.move, false);
  assert.deepEqual(out.production_manager, { ...FALLBACK_ACTIONS, grant: true });
});

test('fallback matches the A1 migration copy semantics (view+add+remove+move on, editDetails/grant off)', () => {
  const { FALLBACK_ACTIONS } = mod;
  assert.deepEqual(FALLBACK_ACTIONS, { view: true, add: true, remove: true, move: true, editDetails: false, grant: false });
});
