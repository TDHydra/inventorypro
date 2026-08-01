import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveLayout, parsePresetLayout, type LayoutPreset } from './resolve';
import { DEFAULT_LAYOUT, WIDGET_REGISTRY, isWidgetType, type Layout } from './widgets';
import { ROLE_DEFAULT_LAYOUTS } from './roleLayouts';

const validLayout = JSON.stringify([
  { widget: 'quick-add', width: 'full' },
  { widget: 'checkout', width: 'half' },
]);

const byId: Record<string, LayoutPreset> = {
  'p-user': { layout: validLayout },
  'p-role': { layout: JSON.stringify([{ widget: 'jobs', width: 'full' }]) },
  'p-bad': { layout: '{not valid json' },
  'p-empty': { layout: '[]' },
  'p-junk': { layout: JSON.stringify([{ widget: 'not-a-widget', width: 'full' }]) },
};

test('no assignment → DEFAULT_LAYOUT', () => {
  assert.equal(resolveLayout(null, null, byId), DEFAULT_LAYOUT);
});

test('user preset wins over role preset (precedence)', () => {
  const layout = resolveLayout('p-user', 'p-role', byId);
  assert.deepEqual(layout, [
    { widget: 'quick-add', width: 'full' },
    { widget: 'checkout', width: 'half' },
  ]);
});

test('falls back to role preset when user has none', () => {
  const layout = resolveLayout(null, 'p-role', byId);
  assert.deepEqual(layout, [{ widget: 'jobs', width: 'full' }]);
});

test('resolved-but-missing preset id → DEFAULT_LAYOUT', () => {
  assert.equal(resolveLayout('does-not-exist', null, byId), DEFAULT_LAYOUT);
});

test('bad JSON layout → DEFAULT_LAYOUT', () => {
  assert.equal(resolveLayout('p-bad', null, byId), DEFAULT_LAYOUT);
});

test('empty-array layout → DEFAULT_LAYOUT', () => {
  assert.equal(resolveLayout('p-empty', null, byId), DEFAULT_LAYOUT);
});

test('layout with only unknown widgets → DEFAULT_LAYOUT', () => {
  assert.equal(resolveLayout('p-junk', null, byId), DEFAULT_LAYOUT);
});

test('parsePresetLayout drops unknown widgets but keeps valid ones', () => {
  const raw = JSON.stringify([
    { widget: 'bogus', width: 'full' },
    { widget: 'teams', width: 'half' },
  ]);
  assert.deepEqual(parsePresetLayout(raw), [{ widget: 'teams', width: 'half' }]);
});

test('parsePresetLayout defaults an invalid width to full', () => {
  const raw = JSON.stringify([{ widget: 'teams', width: 'weird' }]);
  assert.deepEqual(parsePresetLayout(raw), [{ widget: 'teams', width: 'full' }]);
});

test('parsePresetLayout null/empty → null', () => {
  assert.equal(parsePresetLayout(null), null);
  assert.equal(parsePresetLayout(''), null);
  assert.equal(parsePresetLayout('[]'), null);
});

// --- Field-crew widgets (#122: fast-checkout #127, manage-my-team #124, on-call #128) ---

test('field-crew widget types are valid layout widgets', () => {
  const raw = JSON.stringify([
    { widget: 'fast-checkout', width: 'full' },
    { widget: 'manage-my-team', width: 'half' },
    { widget: 'on-call', width: 'full' },
  ]);
  assert.deepEqual(parsePresetLayout(raw), [
    { widget: 'fast-checkout', width: 'full' },
    { widget: 'manage-my-team', width: 'half' },
    { widget: 'on-call', width: 'full' },
  ]);
});

test('field-crew registry entries: kinds, routes, no permission gates', () => {
  assert.equal(WIDGET_REGISTRY['fast-checkout'].kind, 'tile');
  assert.equal(WIDGET_REGISTRY['fast-checkout'].route, '/(app)/(crew)');
  assert.equal(WIDGET_REGISTRY['fast-checkout'].requiredPermission, undefined);
  // Fast check-in (#83): same crew picker in return mode, also data-driven.
  assert.equal(WIDGET_REGISTRY['fast-checkin'].kind, 'tile');
  assert.equal(WIDGET_REGISTRY['fast-checkin'].route, '/(app)/(crew)?dir=in');
  assert.equal(WIDGET_REGISTRY['fast-checkin'].requiredPermission, undefined);
  assert.equal(WIDGET_REGISTRY['manage-my-team'].kind, 'tile');
  assert.equal(WIDGET_REGISTRY['manage-my-team'].route, '/(app)/(myteam)');
  assert.equal(WIDGET_REGISTRY['manage-my-team'].requiredPermission, undefined);
  assert.equal(WIDGET_REGISTRY['on-call'].kind, 'block');
});

test('DEFAULT_LAYOUT: fast-checkout is the first tile; new widgets present once', () => {
  const widgets = DEFAULT_LAYOUT.map(b => b.widget);
  const firstTile = DEFAULT_LAYOUT.find(b => WIDGET_REGISTRY[b.widget].kind === 'tile');
  assert.equal(firstTile?.widget, 'fast-checkout');
  for (const w of ['fast-checkout', 'fast-checkin', 'manage-my-team', 'on-call'] as const) {
    assert.equal(widgets.filter(x => x === w).length, 1, `${w} appears exactly once`);
  }
  // manage-my-team lives in the Operations section (after its header, before Admin's).
  const ops = widgets.indexOf('teams');
  const admin = widgets.indexOf('users');
  const myTeam = widgets.indexOf('manage-my-team');
  assert.ok(myTeam > ops && myTeam < admin, 'manage-my-team sits in Operations');
  // on-call block renders after the existing low-stock block.
  assert.ok(widgets.indexOf('on-call') > widgets.indexOf('low-stock'));
});

test('A2 unit widgets: vehicles/lockers tiles, data-driven (no permission gate)', () => {
  assert.equal(WIDGET_REGISTRY.vehicles.kind, 'tile');
  assert.equal(WIDGET_REGISTRY.vehicles.route, '/(app)/(vehicles)');
  assert.equal(WIDGET_REGISTRY.vehicles.requiredPermission, undefined);
  assert.equal(WIDGET_REGISTRY.lockers.kind, 'tile');
  assert.equal(WIDGET_REGISTRY.lockers.route, '/(app)/(lockers)');
  assert.equal(WIDGET_REGISTRY.lockers.requiredPermission, undefined);
  const widgets = DEFAULT_LAYOUT.map(b => b.widget);
  for (const w of ['vehicles', 'lockers'] as const) {
    assert.equal(widgets.filter(x => x === w).length, 1, `${w} appears exactly once`);
  }
  assert.ok(widgets.indexOf('vehicles') > widgets.indexOf('locations'), 'unit tiles follow Manage Locations');
});

// --- Role dashboards: role code-defaults in the resolution chain (§1) --------

const roleDefault: Layout = [
  { widget: 'fast-checkout', width: 'half' },
  { widget: 'fast-checkin', width: 'half' },
  { widget: 'stat-tiles', width: 'full', config: { stats: ['my-checkouts', 'units-due-service'] } },
];

test('no assignments + role default → role default', () => {
  assert.equal(resolveLayout(null, null, byId, roleDefault), roleDefault);
});

test('no assignments + no role default → DEFAULT_LAYOUT', () => {
  assert.equal(resolveLayout(null, null, byId, null), DEFAULT_LAYOUT);
  assert.equal(resolveLayout(null, null, byId, undefined), DEFAULT_LAYOUT);
});

test('user preset wins over role default', () => {
  assert.deepEqual(resolveLayout('p-user', null, byId, roleDefault), [
    { widget: 'quick-add', width: 'full' },
    { widget: 'checkout', width: 'half' },
  ]);
});

test('role preset (DB) wins over role default', () => {
  assert.deepEqual(resolveLayout(null, 'p-role', byId, roleDefault), [
    { widget: 'jobs', width: 'full' },
  ]);
});

test('missing/invalid/empty assigned preset falls through to role default', () => {
  assert.equal(resolveLayout('does-not-exist', null, byId, roleDefault), roleDefault);
  assert.equal(resolveLayout('p-bad', null, byId, roleDefault), roleDefault);
  assert.equal(resolveLayout('p-empty', null, byId, roleDefault), roleDefault);
  assert.equal(resolveLayout('p-junk', null, byId, roleDefault), roleDefault);
});

test('missing/invalid user preset falls through to the ROLE PRESET (DB), not past it', () => {
  // §1 chain: user preset → role preset (DB) → role default → DEFAULT_LAYOUT.
  // A broken personal preset must not skip the admin-curated role preset.
  const rolePresetLayout = [{ widget: 'jobs', width: 'full' }];
  assert.deepEqual(resolveLayout('does-not-exist', 'p-role', byId, roleDefault), rolePresetLayout);
  assert.deepEqual(resolveLayout('p-bad', 'p-role', byId, roleDefault), rolePresetLayout);
  assert.deepEqual(resolveLayout('p-empty', 'p-role', byId, roleDefault), rolePresetLayout);
  assert.deepEqual(resolveLayout('p-junk', 'p-role', byId, roleDefault), rolePresetLayout);
  // Both levels broken → role default → DEFAULT_LAYOUT.
  assert.equal(resolveLayout('p-bad', 'p-empty', byId, roleDefault), roleDefault);
  assert.equal(resolveLayout('p-bad', 'p-empty', byId), DEFAULT_LAYOUT);
});

// --- Personal dashboard layout (#193): NEW top precedence tier --------------
// store.ts's resolveLayoutFor() (not exported here — it pulls in op-sqlite via
// db/userPrefs/db/queries/dashboards, same reason resolveLayoutFor itself has
// no direct test in this DB-free file today) composes exactly:
//   const personal = personalRaw ? parsePresetLayout(JSON.stringify(personalRaw)) : null;
//   if (personal) return personal;
//   return resolveLayout(userPresetId, rolePresetId, byId, roleDefault);
// Mirrored here over the same two pure primitives store.ts actually calls, so
// a regression in either primitive — or in the precedence composition itself —
// is caught without needing a DB. (A bug introduced purely in store.ts's own
// glue, e.g. swapping the `if (personal) return personal` order, would not be
// caught by this file — same pre-existing gap as the real DB-backed
// userPresetId/rolePresetId selection, which is likewise untested here.)
function resolveWithPersonal(
  personalRaw: unknown,
  userPresetId: string | null,
  rolePresetId: string | null,
  byIdArg: Record<string, LayoutPreset>,
  roleDefaultArg?: Layout | null,
): Layout {
  const personal = personalRaw ? parsePresetLayout(JSON.stringify(personalRaw)) : null;
  if (personal) return personal;
  return resolveLayout(userPresetId, rolePresetId, byIdArg, roleDefaultArg);
}

test('personal layout wins over user preset, role preset, AND role default', () => {
  const personal = [{ widget: 'chat', width: 'full' }];
  assert.deepEqual(
    resolveWithPersonal(personal, 'p-user', 'p-role', byId, roleDefault),
    [{ widget: 'chat', width: 'full' }],
  );
});

test('missing personal layout falls through to the existing preset chain (user preset wins)', () => {
  assert.deepEqual(resolveWithPersonal(undefined, 'p-user', 'p-role', byId, roleDefault), [
    { widget: 'quick-add', width: 'full' },
    { widget: 'checkout', width: 'half' },
  ]);
});

test('empty personal layout falls through to the existing preset chain, not past it', () => {
  assert.deepEqual(resolveWithPersonal([], 'p-user', 'p-role', byId, roleDefault), [
    { widget: 'quick-add', width: 'full' },
    { widget: 'checkout', width: 'half' },
  ]);
});

test('personal layout with only unknown widgets falls through to role default', () => {
  const junk = [{ widget: 'not-a-widget', width: 'full' }];
  assert.equal(resolveWithPersonal(junk, null, null, byId, roleDefault), roleDefault);
});

test('personal layout drops unknown widgets but keeps valid ones (same validator as presets)', () => {
  const mixed = [{ widget: 'bogus', width: 'full' }, { widget: 'teams', width: 'half' }];
  assert.deepEqual(
    resolveWithPersonal(mixed, null, null, byId, roleDefault),
    [{ widget: 'teams', width: 'half' }],
  );
});

test('no personal layout, no assignments, no role default → DEFAULT_LAYOUT', () => {
  assert.equal(resolveWithPersonal(undefined, null, null, byId), DEFAULT_LAYOUT);
});

test('ROLE_DEFAULT_LAYOUTS entries (as filled in) are valid layouts', () => {
  // The map ships empty and is filled role by role — this guards every entry a
  // follow-up adds: real widget types only, sane widths.
  for (const [role, layout] of Object.entries(ROLE_DEFAULT_LAYOUTS)) {
    assert.ok(Array.isArray(layout) && layout.length > 0, `${role}: non-empty layout`);
    for (const b of layout!) {
      assert.ok(isWidgetType(b.widget), `${role}: '${b.widget}' is a registered widget`);
      assert.ok(b.width === 'full' || b.width === 'half', `${role}: valid width`);
    }
  }
});

// --- Role dashboards: pinned search (§1) -------------------------------------

test("'search' is no longer a widget type; DEFAULT_LAYOUT carries no search block", () => {
  assert.equal(isWidgetType('search'), false);
  assert.ok(!DEFAULT_LAYOUT.some(b => (b.widget as string) === 'search'));
});

test("old presets containing 'search' parse fine — search skipped, not duplicated", () => {
  const raw = JSON.stringify([
    { widget: 'search', width: 'full' },
    { widget: 'checkout', width: 'full' },
    { widget: 'search', width: 'full' },
  ]);
  assert.deepEqual(parsePresetLayout(raw), [{ widget: 'checkout', width: 'full' }]);
});

test("old preset with ONLY a search block → null (falls back down the chain)", () => {
  const raw = JSON.stringify([{ widget: 'search', width: 'full' }]);
  assert.equal(parsePresetLayout(raw), null);
});

// --- Role dashboards: config payloads + new data widgets (§2) ----------------

// --- Role dashboards: Settings reachable by ALL roles (§4) -------------------

test('settings tile carries no permission gate (My Profile is all-roles)', () => {
  // The settings screen renders for everyone and self-gates its admin
  // sections; gating the tile would strand non-tier-4 roles with no path to
  // Change PIN / email / phone, Theme, or Logout.
  assert.equal(WIDGET_REGISTRY.settings.kind, 'tile');
  assert.equal(WIDGET_REGISTRY.settings.route, '/(app)/(admin)/settings');
  assert.equal(WIDGET_REGISTRY.settings.requiredPermission, undefined);
});

test('new data widgets registered: kinds + permission gates', () => {
  assert.equal(WIDGET_REGISTRY['stat-tiles'].kind, 'block');
  assert.equal(WIDGET_REGISTRY['stat-tiles'].requiredPermission, undefined);
  assert.equal(WIDGET_REGISTRY['work-list'].kind, 'block');
  assert.equal(WIDGET_REGISTRY['work-list'].requiredPermission, undefined);
  assert.equal(WIDGET_REGISTRY['activity-preview'].kind, 'block');
  // Same gate as the Activity Logs tile.
  assert.equal(WIDGET_REGISTRY['activity-preview'].requiredPermission, 'view_all_logs');
});

test('parsePresetLayout keeps per-widget config payloads intact', () => {
  const raw = JSON.stringify([
    { widget: 'stat-tiles', width: 'full', config: { stats: ['open-jobs', 'low-stock'] } },
    { widget: 'work-list', width: 'full', config: { source: 'open-jobs', title: 'Open jobs', limit: 3 } },
    { widget: 'activity-preview', width: 'full', config: { limit: 10 } },
  ]);
  assert.deepEqual(parsePresetLayout(raw), [
    { widget: 'stat-tiles', width: 'full', config: { stats: ['open-jobs', 'low-stock'] } },
    { widget: 'work-list', width: 'full', config: { source: 'open-jobs', title: 'Open jobs', limit: 3 } },
    { widget: 'activity-preview', width: 'full', config: { limit: 10 } },
  ]);
});

test('parsePresetLayout tolerates unknown config fields and non-object configs', () => {
  // Unknown fields (newer app version) ride along untouched…
  const withUnknown = JSON.stringify([
    { widget: 'work-list', width: 'full', config: { source: 'low-stock', futureKnob: true } },
  ]);
  assert.deepEqual(parsePresetLayout(withUnknown), [
    { widget: 'work-list', width: 'full', config: { source: 'low-stock', futureKnob: true } },
  ]);
  // …and a junk config value is dropped, not crashed on.
  const junkCfg = JSON.stringify([{ widget: 'checkout', width: 'full', config: 'nope' }]);
  assert.deepEqual(parsePresetLayout(junkCfg), [{ widget: 'checkout', width: 'full' }]);
});

test('parsePresetLayout drops unknown widget types but keeps configured known ones', () => {
  const raw = JSON.stringify([
    { widget: 'hologram-3d', width: 'full', config: { beam: 'up' } },
    { widget: 'stat-tiles', width: 'full', config: { stats: ['team-members'] } },
  ]);
  assert.deepEqual(parsePresetLayout(raw), [
    { widget: 'stat-tiles', width: 'full', config: { stats: ['team-members'] } },
  ]);
});
