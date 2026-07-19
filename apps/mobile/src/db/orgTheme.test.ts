import { createRequire } from 'node:module';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// Phase E (#138) — org default theme resolution. Precedence under test:
// user_prefs.theme -> app_config 'default_theme_id' -> DEFAULT_THEME_ID.
const requireCjs = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Module = requireCjs('node:module') as any;
const testDb = requireCjs('./queries/locationsShelf.testdb') as typeof import('./queries/locationsShelf.testdb');

const origLoad = Module._load;
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'react-native-get-random-values') return {};
  // Theme modules call Easing.out(Easing.quad|cubic|linear) at load time; the
  // real react-native package can't parse under node --test (Flow syntax).
  if (request === 'react-native') {
    const fn = (x: unknown) => x;
    return { Easing: { in: fn, out: fn, inOut: fn, linear: fn, ease: fn, quad: fn, cubic: fn, bezier: () => fn } };
  }
  let resolved = '';
  try { resolved = Module._resolveFilename(request, parent); } catch { /* not ours */ }
  if (resolved.endsWith('/src/db/schema.ts')) return testDb;
  if (resolved.endsWith('/src/telemetry/index.ts')) return { track() {} };
  return origLoad.call(this, request, parent, isMain);
};

let orgTheme: typeof import('./orgTheme');
let store: typeof import('../themes/store');
let userPrefs: typeof import('./userPrefs');

const ALICE = 'user-alice';

function exec(sql: string, params?: unknown[]) {
  return testDb.getDb().executeSync(sql, params);
}

before(async () => {
  await testDb.initTestDb(); // locations/taxonomy_types/outbox
  // Mirrors mobile migrations 010 (app_config), 040 (user_prefs) + app_settings.
  exec(`
    CREATE TABLE app_config (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
    CREATE TABLE user_prefs (user_id TEXT PRIMARY KEY, theme TEXT, updated_at TEXT NOT NULL);
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  orgTheme = requireCjs('./orgTheme') as typeof import('./orgTheme');
  store = requireCjs('../themes/store') as typeof import('../themes/store');
  userPrefs = requireCjs('./userPrefs') as typeof import('./userPrefs');
});

test('pre-login (userId null): org default applies', () => {
  exec(`INSERT OR REPLACE INTO app_config (key, value, updated_at) VALUES ('default_theme_id', 'futuristic', '2026-07-19')`);
  orgTheme.applyOrgDefaultTheme(null);
  assert.equal(store.getTheme().id, 'futuristic');
});

test('boot fallback: no theme_last -> loadThemeFromSettings reads app_config', () => {
  exec(`DELETE FROM app_settings WHERE key = 'theme_last'`);
  store.loadThemeFromSettings();
  assert.equal(store.getTheme().id, 'futuristic');
});

test('a personal user_prefs theme beats the org default', () => {
  userPrefs.chooseTheme(ALICE, 'modern');
  orgTheme.applyOrgDefaultTheme(ALICE); // must NOT re-skin
  assert.equal(store.getTheme().id, 'modern');
});

test('signed-in user without a personal theme gets the org default', () => {
  exec(`DELETE FROM user_prefs WHERE user_id = ?`, [ALICE]);
  orgTheme.applyOrgDefaultTheme(ALICE);
  assert.equal(store.getTheme().id, 'futuristic');
});

test('setOrgDefaultTheme writes app_config locally, queues an outbox INSERT, and applies', () => {
  exec(`DELETE FROM outbox`);
  orgTheme.setOrgDefaultTheme('classic', null);
  const cfg = exec(`SELECT value FROM app_config WHERE key = 'default_theme_id'`).rows as { value: string }[];
  assert.equal(cfg[0].value, 'classic');
  const ops = exec(`SELECT operation, table_name, payload FROM outbox`).rows as
    Array<{ operation: string; table_name: string; payload: string }>;
  assert.equal(ops.length, 1);
  assert.equal(ops[0].operation, 'INSERT');
  assert.equal(ops[0].table_name, 'app_config');
  assert.equal((JSON.parse(ops[0].payload) as { key: string }).key, 'default_theme_id');
  assert.equal(store.getTheme().id, 'classic');
});

test('unknown org theme id falls back to the built-in default', () => {
  exec(`INSERT OR REPLACE INTO app_config (key, value, updated_at) VALUES ('default_theme_id', 'no-such-theme', '2026-07-19')`);
  orgTheme.applyOrgDefaultTheme(null);
  assert.equal(store.getTheme().id, 'original');
});
