import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTaxonomyValue, defaultTaxonomyValue } from './resolveTaxonomyValue';

const types = [
  { id: 'id-a', label: 'Alpha' },
  { id: 'id-b', label: 'Beta' },
];

test('id match returns that type id+label', () => {
  assert.deepEqual(resolveTaxonomyValue(types, 'id-b', null), { id: 'id-b', label: 'Beta' });
});

test('label match returns that type id+label', () => {
  assert.deepEqual(resolveTaxonomyValue(types, null, 'Alpha'), { id: 'id-a', label: 'Alpha' });
});

test('id wins over a conflicting label', () => {
  // id points at Beta, label says Alpha — the id must win.
  assert.deepEqual(resolveTaxonomyValue(types, 'id-b', 'Alpha'), { id: 'id-b', label: 'Beta' });
});

test('unresolved id survives (archived type)', () => {
  assert.deepEqual(resolveTaxonomyValue(types, 'id-gone', null), { id: 'id-gone', label: null });
});

test('unresolved label survives (archived type)', () => {
  assert.deepEqual(resolveTaxonomyValue(types, null, 'Gamma'), { id: null, label: 'Gamma' });
});

test('unresolved id + unresolved label both survive', () => {
  assert.deepEqual(resolveTaxonomyValue(types, 'id-gone', 'Gamma'), { id: 'id-gone', label: 'Gamma' });
});

test('label match is case-sensitive', () => {
  // 'alpha' must NOT match 'Alpha' — it falls through to the raw value.
  assert.deepEqual(resolveTaxonomyValue(types, null, 'alpha'), { id: null, label: 'alpha' });
});

test('empty types array returns raw value', () => {
  assert.deepEqual(resolveTaxonomyValue([], 'id-a', 'Alpha'), { id: 'id-a', label: 'Alpha' });
});

test('null/undefined inputs yield empty value', () => {
  assert.deepEqual(resolveTaxonomyValue(types, null, null), { id: null, label: null });
  assert.deepEqual(resolveTaxonomyValue(types), { id: null, label: null });
});

test('empty-string valueId is treated as no id (falls to label)', () => {
  assert.deepEqual(resolveTaxonomyValue(types, '', 'Beta'), { id: 'id-b', label: 'Beta' });
});

test('defaultTaxonomyValue returns first type', () => {
  assert.deepEqual(defaultTaxonomyValue(types), { id: 'id-a', label: 'Alpha' });
});

test('defaultTaxonomyValue on empty list is null/null', () => {
  assert.deepEqual(defaultTaxonomyValue([]), { id: null, label: null });
});
