import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveLayout, parsePresetLayout, type LayoutPreset } from './resolve';
import { DEFAULT_LAYOUT } from './widgets';

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
