import { createRequire } from 'node:module';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// Same harness as src/repos/oncall.test.ts/access.test.ts — unitAccessDefaults.ts
// can't load under `node --test` as-is (db/schema imports the native op-sqlite
// binding via queries/log.ts; utils/uuid imports react-native-get-random-values).
const requireCjs = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Module = requireCjs('node:module') as any;
const testDb = requireCjs('../repos/testDb') as typeof import('../repos/testDb');

const origLoad = Module._load;
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'react-native-get-random-values') return {};
  if (request === 'react-native' || request === 'expo' || request === 'expo-modules-core') {
    return new Proxy({ __esModule: true }, { get: (_t, p) => (p === '__esModule' ? true : () => {}) });
  }
  let resolved = '';
  try { resolved = Module._resolveFilename(request, parent); } catch { /* not ours — fall through */ }
  if (resolved.endsWith('/src/db/schema.ts')) return testDb;
  return origLoad.call(this, request, parent, isMain);
};

let mod: typeof import('./unitAccessDefaults');

const TABLES = ['app_config', 'activity_log', 'outbox'];

function exec(sql: string, params?: unknown[]) {
  return testDb.getDb().executeSync(sql, params);
}
function countLog(action: string): number {
  return (exec(`SELECT COUNT(*) AS n FROM activity_log WHERE action = ?`, [action]).rows[0] as { n: number }).n;
}
function outboxCountFor(key: string): number {
  const rows = exec(`SELECT payload FROM outbox WHERE table_name = 'app_config'`).rows as Array<{ payload: string }>;
  return rows.filter(r => JSON.parse(r.payload).key === key).length;
}

before(async () => {
  await testDb.initTestDb(TABLES);
  mod = requireCjs('./unitAccessDefaults') as typeof import('./unitAccessDefaults');
});

test('missing key / bad JSON / non-object -> empty map (callers fall back per-role)', () => {
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
    production_manager: { grant: true }, // partial -> other actions from fallback
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

test('getDefaultActionsForRole falls back to FALLBACK_ACTIONS for an unconfigured role', () => {
  const { getDefaultActionsForRole, FALLBACK_ACTIONS } = mod;
  assert.deepEqual(getDefaultActionsForRole('contents_crew'), FALLBACK_ACTIONS);
});

test('setUnitAccessDefaults + getUnitAccessDefaults round-trip locally and queue an outbox INSERT', () => {
  const { setUnitAccessDefaults, getUnitAccessDefaults, FALLBACK_ACTIONS } = mod;
  setUnitAccessDefaults({ office_manager: { ...FALLBACK_ACTIONS, grant: true } });
  assert.deepEqual(getUnitAccessDefaults(), { office_manager: { ...FALLBACK_ACTIONS, grant: true } });
  assert.equal(outboxCountFor('unit_access_defaults') >= 1, true);
});

test('toggleUnitAccessDefault flips a single cell, preserves the rest of the template, and self-logs', () => {
  const { toggleUnitAccessDefault, setUnitAccessDefaults, getDefaultActionsForRole, FALLBACK_ACTIONS } = mod;
  setUnitAccessDefaults({ head_of_contents: { ...FALLBACK_ACTIONS } });
  const before = countLog('unit_access_defaults_changed');
  toggleUnitAccessDefault('head_of_contents', 'editDetails', true, 'user-1');
  const actions = getDefaultActionsForRole('head_of_contents');
  assert.equal(actions.editDetails, true);
  assert.equal(actions.view, FALLBACK_ACTIONS.view); // untouched cell preserved
  assert.equal(countLog('unit_access_defaults_changed'), before + 1);
});

test('subscribeUnitAccessDefaults / notifyUnitAccessDefaultsChanged notify listeners and bump the version', () => {
  const { subscribeUnitAccessDefaults, notifyUnitAccessDefaultsChanged, getUnitAccessDefaultsVersion } = mod;
  const v0 = getUnitAccessDefaultsVersion();
  let calls = 0;
  const unsubscribe = subscribeUnitAccessDefaults(() => { calls += 1; });
  notifyUnitAccessDefaultsChanged();
  assert.equal(calls, 1);
  assert.equal(getUnitAccessDefaultsVersion(), v0 + 1);
  unsubscribe();
  notifyUnitAccessDefaultsChanged();
  assert.equal(calls, 1); // unsubscribed — no further notifications
});
