import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSection, composeLayout } from './bundles';
import { WIDGET_REGISTRY, type WidgetType } from './widgetRegistry';

// #189/#190/#191: ONE composition mechanism for role dashboards. These tests
// pin buildSection()'s ordering/width behavior and composeLayout()'s
// flattening directly — the real regression proof (byte-identical
// DEFAULT_LAYOUT/ADMIN_LAYOUT output) lives in roleLayouts.test.ts and
// store.test.ts, which must keep passing UNMODIFIED.

test('buildSection: leads with a section header carrying the given title', () => {
  const section = buildSection('admin', 'Admin');
  assert.deepEqual(section[0], { widget: 'section', width: 'full', config: { sectionTitle: 'Admin' } });
});

test('buildSection: includes every registry tile tagged with this sectionKey, none from others', () => {
  const inventory = buildSection('inventory', 'Inventory Management');
  const widgets = inventory.slice(1).map(b => b.widget);
  assert.deepEqual(widgets, ['add-stock', 'equipment', 'repairs', 'locations', 'vehicles', 'lockers', 'item-catalog']);
  // Sanity: none of these are tagged for a different section.
  for (const w of widgets) assert.equal(WIDGET_REGISTRY[w as WidgetType].section, 'inventory');
});

test('buildSection: orders tiles by ascending weight', () => {
  const operations = buildSection('operations', 'Operations');
  const widgets = operations.slice(1).map(b => b.widget);
  assert.deepEqual(widgets, ['chat', 'jobs', 'teams', 'manage-my-team', 'schedule', 'media', 'logs']);
  const weights = widgets.map(w => WIDGET_REGISTRY[w as WidgetType].weight);
  for (let i = 1; i < weights.length; i++) {
    assert.ok((weights[i] ?? 0) >= (weights[i - 1] ?? 0), `${widgets[i]} should not sort before ${widgets[i - 1]}`);
  }
});

test('buildSection: an unknown sectionKey yields just the header (no matching tiles)', () => {
  const section = buildSection('nonexistent', 'Nothing Here');
  assert.deepEqual(section, [{ widget: 'section', width: 'full', config: { sectionTitle: 'Nothing Here' } }]);
});

test('buildSection: preserves the current width values (vehicles/lockers stay half, everything else full)', () => {
  const inventory = buildSection('inventory', 'Inventory Management');
  const widthByWidget = Object.fromEntries(inventory.map(b => [b.widget, b.width]));
  assert.equal(widthByWidget['vehicles'], 'half');
  assert.equal(widthByWidget['lockers'], 'half');
  for (const w of ['add-stock', 'equipment', 'repairs', 'locations', 'item-catalog']) {
    assert.equal(widthByWidget[w], 'full', `${w} should be full width`);
  }

  const admin = buildSection('admin', 'Admin');
  for (const b of admin.slice(1)) assert.equal(b.width, 'full', `${b.widget} should be full width`);
});

test('composeLayout: flattens a mix of single blocks and Layout arrays, in order', () => {
  const out = composeLayout(
    { widget: 'quick-add', width: 'full' },
    [{ widget: 'checkout', width: 'half' }, { widget: 'checkin', width: 'half' }],
    { widget: 'logs', width: 'full' },
  );
  assert.deepEqual(out, [
    { widget: 'quick-add', width: 'full' },
    { widget: 'checkout', width: 'half' },
    { widget: 'checkin', width: 'half' },
    { widget: 'logs', width: 'full' },
  ]);
});

test('composeLayout: no parts → empty layout', () => {
  assert.deepEqual(composeLayout(), []);
});

test('composeLayout: a single Layout part flattens to itself', () => {
  const section = buildSection('admin', 'Admin');
  assert.deepEqual(composeLayout(section), section);
});
