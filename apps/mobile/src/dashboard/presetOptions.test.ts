import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dashboardPresetOptions } from './presetOptions';
import type { DashboardPreset } from '../db/queries/dashboards';

const p = (id: string, name: string, active: number): DashboardPreset =>
  ({ id, name, layout: '[]', active, updated_at: '2026-07-19T00:00:00.000Z' });

test('lists only active presets when nothing is assigned', () => {
  assert.deepEqual(
    dashboardPresetOptions([p('a', 'Crew', 1), p('b', 'Office', 0)], null),
    [{ id: 'a', label: 'Crew' }],
  );
});

test('keeps the assigned-but-deactivated preset, marked inactive', () => {
  assert.deepEqual(
    dashboardPresetOptions([p('a', 'Crew', 1), p('b', 'Office', 0)], 'b'),
    [{ id: 'a', label: 'Crew' }, { id: 'b', label: 'Office', sublabel: 'inactive' }],
  );
});

test('empty preset list → empty options (SelectField shows only Default via placeholder)', () => {
  assert.deepEqual(dashboardPresetOptions([], null), []);
});
