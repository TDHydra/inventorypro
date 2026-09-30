import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyLabelMap } from './labelResolve';

const MAP = new Map<string, string>([
  ['id-1', 'Renamed A'],
  ['id-2', 'Renamed B'],
]);

test('overwrites the label cache when the id resolves in the map', () => {
  const rows = [{ type_id: 'id-1', type: 'Old A' }];
  applyLabelMap(rows, 'type_id', 'type', MAP);
  assert.equal(rows[0].type, 'Renamed A');
});

test('keeps the cached label when the id is null (grace)', () => {
  const rows = [{ type_id: null, type: 'Free Typed' }];
  applyLabelMap(rows, 'type_id', 'type', MAP);
  assert.equal(rows[0].type, 'Free Typed');
});

test('keeps the cached label when the id is absent from the map', () => {
  const rows = [{ category_id: 'id-unknown', category: 'Stale' }];
  applyLabelMap(rows, 'category_id', 'category', MAP);
  assert.equal(rows[0].category, 'Stale');
});

test('resolves each row independently in a mixed list', () => {
  const rows = [
    { type_id: 'id-1', type: 'Old A' },
    { type_id: 'id-2', type: 'Old B' },
    { type_id: null, type: 'Custom' },
    { type_id: 'id-missing', type: 'Cached' },
  ];
  applyLabelMap(rows, 'type_id', 'type', MAP);
  assert.deepEqual(
    rows.map(r => r.type),
    ['Renamed A', 'Renamed B', 'Custom', 'Cached'],
  );
});

test('empty rows is a no-op and returns the same array', () => {
  const rows: { type_id: string; type: string }[] = [];
  assert.equal(applyLabelMap(rows, 'type_id', 'type', MAP), rows);
});
