import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveLayout, parsePresetLayout, type LayoutPreset } from './resolve';
import { DEFAULT_LAYOUT, WIDGET_REGISTRY } from './widgets';

const validLayout = JSON.stringify([
  { widget: 'search', width: 'full' },
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
    { widget: 'search', width: 'full' },
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
  assert.equal(WIDGET_REGISTRY['manage-my-team'].kind, 'tile');
  assert.equal(WIDGET_REGISTRY['manage-my-team'].route, '/(app)/(myteam)');
  assert.equal(WIDGET_REGISTRY['manage-my-team'].requiredPermission, undefined);
  assert.equal(WIDGET_REGISTRY['on-call'].kind, 'block');
});

test('DEFAULT_LAYOUT: fast-checkout is the first tile; new widgets present once', () => {
  const widgets = DEFAULT_LAYOUT.map(b => b.widget);
  const firstTile = DEFAULT_LAYOUT.find(b => WIDGET_REGISTRY[b.widget].kind === 'tile');
  assert.equal(firstTile?.widget, 'fast-checkout');
  for (const w of ['fast-checkout', 'manage-my-team', 'on-call'] as const) {
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
