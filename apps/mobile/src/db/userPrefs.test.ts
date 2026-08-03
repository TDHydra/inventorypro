import { createRequire } from 'node:module';
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// #193/#196 regression: dashboard_prefs (migration 060) multiplexed BOTH the
// personal layout override and the starred-widget set into one JSON blob, so
// every setter had to read-merge-write the whole column with no version
// check — a stale local replica silently clobbered whichever field the OTHER
// device had already synced. Migration 062 splits them into their own
// columns; these tests exercise db/userPrefs.ts's rewritten setters against a
// REAL sql.js database end-to-end (same Module._load-interception harness as
// oncall.test.ts / orgTheme.test.ts — userPrefs.ts transitively pulls in
// db/schema (native op-sqlite), utils/uuid (react-native-get-random-values)
// and themes/store.ts (react-native's Easing)).
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

let userPrefs: typeof import('./userPrefs');

const ALICE = 'user-alice';

function exec(sql: string, params?: unknown[]) {
  return testDb.getDb().executeSync(sql, params);
}

interface OutboxRow { operation: string; table_name: string; payload: Record<string, unknown> }
function outboxEntries(): OutboxRow[] {
  const rows = exec(`SELECT operation, table_name, payload FROM outbox ORDER BY rowid ASC`).rows as
    Array<{ operation: string; table_name: string; payload: string }>;
  return rows.map(r => ({ operation: r.operation, table_name: r.table_name, payload: JSON.parse(r.payload) }));
}

before(async () => {
  await testDb.initTestDb(); // locations/taxonomy_types/outbox
  // Mirrors mobile migrations 040 (user_prefs) + 060 (dashboard_prefs) + 062
  // (dashboard_layout/starred_widgets split) + app_config (010)/app_settings.
  exec(`
    CREATE TABLE app_config (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
    CREATE TABLE user_prefs (
      user_id TEXT PRIMARY KEY,
      theme TEXT,
      dashboard_prefs TEXT,
      dashboard_layout TEXT,
      starred_widgets TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  userPrefs = requireCjs('./userPrefs') as typeof import('./userPrefs');
});

beforeEach(() => {
  exec(`DELETE FROM user_prefs`);
  exec(`DELETE FROM outbox`);
});

test('setDashboardLayout writes ONLY dashboard_layout locally and in the outbox payload', () => {
  exec(`INSERT INTO user_prefs (user_id, theme, starred_widgets, updated_at) VALUES (?, 'modern', ?, '2026-07-01T00:00:00.000Z')`,
    [ALICE, JSON.stringify(['chat', 'low-stock'])]);

  userPrefs.setDashboardLayout(ALICE, [{ widget: 'quick-add', width: 'full' }]);

  const row = exec(`SELECT theme, dashboard_layout, starred_widgets FROM user_prefs WHERE user_id = ?`, [ALICE]).rows[0] as
    { theme: string; dashboard_layout: string; starred_widgets: string };
  assert.equal(row.theme, 'modern', 'theme must survive a layout-only write');
  assert.deepEqual(JSON.parse(row.starred_widgets), ['chat', 'low-stock'], 'starred_widgets must survive a layout-only write (the #193/#196 clobber this fixes)');
  assert.deepEqual(JSON.parse(row.dashboard_layout), [{ widget: 'quick-add', width: 'full' }]);

  const ops = outboxEntries();
  assert.equal(ops.length, 1);
  assert.equal(ops[0].table_name, 'user_prefs');
  // THE regression assertion: the outbox payload — what gets pushed to the
  // server and could clobber another device's sync — must not carry
  // starred_widgets (or theme) at all, only the field this write touched.
  assert.ok('dashboard_layout' in ops[0].payload);
  assert.ok(!('starred_widgets' in ops[0].payload), 'layout write must not push starred_widgets');
  assert.ok(!('theme' in ops[0].payload), 'layout write must not push theme');
  assert.ok('user_id' in ops[0].payload && 'updated_at' in ops[0].payload);
});

test('setStarredWidgets writes ONLY starred_widgets locally and in the outbox payload', () => {
  exec(`INSERT INTO user_prefs (user_id, theme, dashboard_layout, updated_at) VALUES (?, 'classic', ?, '2026-07-01T00:00:00.000Z')`,
    [ALICE, JSON.stringify([{ widget: 'quick-add', width: 'full' }])]);

  userPrefs.setStarredWidgets(ALICE, ['on-call']);

  const row = exec(`SELECT theme, dashboard_layout, starred_widgets FROM user_prefs WHERE user_id = ?`, [ALICE]).rows[0] as
    { theme: string; dashboard_layout: string; starred_widgets: string };
  assert.equal(row.theme, 'classic');
  assert.deepEqual(JSON.parse(row.dashboard_layout), [{ widget: 'quick-add', width: 'full' }], 'dashboard_layout must survive a starred-only write');
  assert.deepEqual(JSON.parse(row.starred_widgets), ['on-call']);

  const ops = outboxEntries();
  assert.equal(ops.length, 1);
  assert.ok('starred_widgets' in ops[0].payload);
  assert.ok(!('dashboard_layout' in ops[0].payload), 'starred write must not push dashboard_layout');
  assert.ok(!('theme' in ops[0].payload), 'starred write must not push theme');
});

test('setDashboardLayout(null) clears the override (writes \'[]\', not NULL — #240) without touching starred_widgets', () => {
  exec(`INSERT INTO user_prefs (user_id, dashboard_layout, starred_widgets, updated_at) VALUES (?, ?, ?, '2026-07-01T00:00:00.000Z')`,
    [ALICE, JSON.stringify([{ widget: 'quick-add', width: 'full' }]), JSON.stringify(['chat'])]);

  userPrefs.setDashboardLayout(ALICE, null);

  const row = exec(`SELECT dashboard_layout, starred_widgets FROM user_prefs WHERE user_id = ?`, [ALICE]).rows[0] as
    { dashboard_layout: string | null; starred_widgets: string };
  // '[]', not NULL: NULL would mean "un-backfilled row" and reactivate the
  // legacy dashboard_prefs blob fallback, resurrecting the layout just cleared.
  assert.equal(row.dashboard_layout, '[]');
  assert.deepEqual(JSON.parse(row.starred_widgets), ['chat']);
});

test('toggleStarredWidget adds then removes a widget, and never touches dashboard_layout', () => {
  exec(`INSERT INTO user_prefs (user_id, dashboard_layout, updated_at) VALUES (?, ?, '2026-07-01T00:00:00.000Z')`,
    [ALICE, JSON.stringify([{ widget: 'quick-add', width: 'full' }])]);

  const afterAdd = userPrefs.toggleStarredWidget(ALICE, 'on-call');
  assert.deepEqual(afterAdd, ['on-call']);
  const afterRemove = userPrefs.toggleStarredWidget(ALICE, 'on-call');
  assert.deepEqual(afterRemove, []);

  const row = exec(`SELECT dashboard_layout FROM user_prefs WHERE user_id = ?`, [ALICE]).rows[0] as { dashboard_layout: string };
  assert.deepEqual(JSON.parse(row.dashboard_layout), [{ widget: 'quick-add', width: 'full' }]);
});

test('getDashboardPrefs composes both split columns for a fully-migrated row', () => {
  exec(`INSERT INTO user_prefs (user_id, dashboard_layout, starred_widgets, updated_at) VALUES (?, ?, ?, '2026-07-01T00:00:00.000Z')`,
    [ALICE, JSON.stringify([{ widget: 'quick-add', width: 'full' }]), JSON.stringify(['chat'])]);
  assert.deepEqual(userPrefs.getDashboardPrefs(ALICE), {
    layout: [{ widget: 'quick-add', width: 'full' }],
    starred: ['chat'],
  });
});

test('getDashboardPrefs falls back to the legacy dashboard_prefs blob when the split columns are NULL', () => {
  // Simulates a row this device pulled before running migration 062 locally.
  exec(`INSERT INTO user_prefs (user_id, dashboard_prefs, updated_at) VALUES (?, ?, '2026-07-01T00:00:00.000Z')`,
    [ALICE, JSON.stringify({ layout: [{ widget: 'low-stock', width: 'half' }], starred: ['on-call'] })]);
  assert.deepEqual(userPrefs.getDashboardPrefs(ALICE), {
    layout: [{ widget: 'low-stock', width: 'half' }],
    starred: ['on-call'],
  });
});

test('getDashboardPrefs returns null when nothing has been customized', () => {
  exec(`INSERT INTO user_prefs (user_id, theme, updated_at) VALUES (?, 'modern', '2026-07-01T00:00:00.000Z')`, [ALICE]);
  assert.equal(userPrefs.getDashboardPrefs(ALICE), null);
});

// ── #240: "Reset to default" vs the legacy-blob fallback ─────────────────────
// A row can carry BOTH a legacy dashboard_prefs blob (pre-062 write) and the
// split columns. Clearing a split column must not drop the field back into the
// blob fallback — that resurrected the old layout after an in-app reset (the
// reset synced fine but the dashboard never changed, even across cold starts).

test('setDashboardLayout(null) on a row with a legacy blob: the blob layout must not resurrect', () => {
  exec(`INSERT INTO user_prefs (user_id, dashboard_prefs, dashboard_layout, updated_at) VALUES (?, ?, ?, '2026-07-01T00:00:00.000Z')`,
    [ALICE,
      JSON.stringify({ layout: [{ widget: 'low-stock', width: 'half' }], starred: ['on-call'] }),
      JSON.stringify([{ widget: 'quick-add', width: 'full' }])]);

  userPrefs.setDashboardLayout(ALICE, null);

  const prefs = userPrefs.getDashboardPrefs(ALICE);
  assert.equal(prefs?.layout, undefined, 'a cleared layout must stay cleared, not fall back to the blob');
  // Per-field fallback is preserved: starred_widgets is still NULL (never
  // written on this row), so the blob's starred set remains visible.
  assert.deepEqual(prefs?.starred, ['on-call']);
});

test('setStarredWidgets([]) on a row with a legacy blob: the blob stars must not resurrect', () => {
  exec(`INSERT INTO user_prefs (user_id, dashboard_prefs, starred_widgets, updated_at) VALUES (?, ?, ?, '2026-07-01T00:00:00.000Z')`,
    [ALICE,
      JSON.stringify({ layout: [{ widget: 'low-stock', width: 'half' }], starred: ['on-call'] }),
      JSON.stringify(['chat'])]);

  userPrefs.setStarredWidgets(ALICE, []);

  const prefs = userPrefs.getDashboardPrefs(ALICE);
  assert.equal(prefs?.starred, undefined, 'a cleared star set must stay cleared, not fall back to the blob');
  assert.deepEqual(prefs?.layout, [{ widget: 'low-stock', width: 'half' }]);
});
