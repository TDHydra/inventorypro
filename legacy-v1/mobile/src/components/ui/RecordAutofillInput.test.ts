import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterRecordOptions, RecordOption } from './recordAutofillFilter';

const opts: RecordOption<{ id: number }>[] = [
  { label: 'Acme Corp', sublabel: 'Last job 2026-01-01', record: { id: 1 } },
  { label: 'Acme Industrial', record: { id: 2 } },
  { label: 'Beta LLC', record: { id: 3 } },
];

test('filterRecordOptions: empty query returns all up to max', () => {
  const r = filterRecordOptions(opts, '', 8);
  assert.equal(r.length, 3);
});

test('filterRecordOptions: case-insensitive includes match', () => {
  const r = filterRecordOptions(opts, 'acme', 8);
  assert.deepEqual(r.map(o => o.label), ['Acme Corp', 'Acme Industrial']);
});

test('filterRecordOptions: exact label match (case-insensitive) is hidden', () => {
  const r = filterRecordOptions(opts, 'Beta LLC', 8);
  assert.equal(r.length, 0);
});

test('filterRecordOptions: no match returns empty', () => {
  const r = filterRecordOptions(opts, 'zzz', 8);
  assert.equal(r.length, 0);
});

test('filterRecordOptions: respects maxSuggestions', () => {
  const r = filterRecordOptions(opts, 'a', 1);
  assert.equal(r.length, 1);
});
