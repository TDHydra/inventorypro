import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LIST_SEPARATOR, splitList, normalizeList, lastSegment, listHas,
  appendSegment, dedupeSegments, dedupeLabels,
} from './multiValueText';

test('splitList drops blanks and trims, keeping order', () => {
  assert.deepEqual(splitList('Fuel filter, Oil filter'), ['Fuel filter', 'Oil filter']);
  assert.deepEqual(splitList('a, b ,, c '), ['a', 'b', 'c']);
  assert.deepEqual(splitList(''), []);
  assert.deepEqual(splitList('   '), []);
  assert.deepEqual(splitList(', , '), []);
});

test('normalizeList is what gets stored — no trailing separator survives', () => {
  // appendSegment deliberately leaves a trailing ', ' as the "add another"
  // affordance; if that reached the DB every row would end in a comma.
  assert.equal(normalizeList('Fuel filter, Oil filter, '), 'Fuel filter, Oil filter');
  assert.equal(normalizeList('a,b,  c'), `a${LIST_SEPARATOR}b${LIST_SEPARATOR}c`);
  assert.equal(normalizeList(''), '');
  assert.equal(normalizeList(', '), '');
  // Idempotent — saving twice must not drift the spelling.
  assert.equal(normalizeList(normalizeList('a,b')), normalizeList('a,b'));
});

test('lastSegment is the typeahead query, not the whole field', () => {
  // The whole point: with two parts already committed, typing "oil f" must
  // filter on "oil f" — filtering on the full string matches nothing.
  assert.equal(lastSegment('Fuel filter, oil f'), 'oil f');
  assert.equal(lastSegment('oil f'), 'oil f');
  // Just after a pick the trailing segment is empty → show the whole pool.
  assert.equal(lastSegment('Fuel filter, '), '');
  assert.equal(lastSegment(''), '');
});

test('appendSegment replaces the typed fragment and invites the next one', () => {
  assert.equal(appendSegment('', 'Oil filter'), 'Oil filter, ');
  assert.equal(appendSegment('oil f', 'Oil filter'), 'Oil filter, ');
  assert.equal(appendSegment('Fuel filter, oil f', 'Oil filter'), 'Fuel filter, Oil filter, ');
  assert.equal(appendSegment('Fuel filter, ', 'Oil filter'), 'Fuel filter, Oil filter, ');
});

test('appendSegment never duplicates a part, however it was spelled', () => {
  // Double-tapping a row, or picking something already in the list, is a no-op
  // apart from clearing the fragment that surfaced it.
  assert.equal(appendSegment('Oil filter, oil f', 'Oil filter'), 'Oil filter, ');
  assert.equal(appendSegment('Oil filter, oil f', 'OIL FILTER'), 'Oil filter, ');
  assert.equal(appendSegment('Oil filter, ', 'Oil filter'), 'Oil filter, ');
});

test('appendSegment with nothing to add leaves the committed list alone', () => {
  assert.equal(appendSegment('Fuel filter, oil f', '   '), 'Fuel filter, ');
  // Nothing committed and nothing to add → empty, NOT a lone separator.
  assert.equal(appendSegment('oil f', ''), '');
  assert.equal(appendSegment('', ''), '');
});

test('listHas is case-insensitive over committed AND typed segments', () => {
  assert.equal(listHas('Fuel filter, Oil filter', 'oil FILTER'), true);
  assert.equal(listHas('Fuel filter, oil f', 'oil f'), true);
  assert.equal(listHas('Fuel filter', 'Oil filter'), false);
  assert.equal(listHas('Fuel filter', '  '), false);
  assert.equal(listHas('', 'Oil filter'), false);
});

test('dedupeSegments flattens prior list-values into individual parts', () => {
  // A stored parts_needed row IS a list, so history contributes its segments —
  // otherwise the dropdown would offer "Fuel filter, Oil filter" as one entry.
  assert.deepEqual(
    dedupeSegments(['Fuel filter, Oil filter', 'Oil filter, 3/8 hose']),
    ['Fuel filter', 'Oil filter', '3/8 hose'],
  );
});

test('dedupeSegments keeps the FIRST spelling — the catalog wins over free text', () => {
  // Callers pass catalog names first on purpose: "Oil Filter" from the catalog
  // must not be shadowed by a hand-typed "oil filter" from an old ticket.
  assert.deepEqual(dedupeSegments(['Oil Filter', 'oil filter, Fuel filter']), ['Oil Filter', 'Fuel filter']);
});

test('dedupeLabels dedupes whole values without splitting on commas', () => {
  // Replace-mode fields (Notes) are single values that may legitimately contain
  // commas — splitting them would shred a sentence into fragments.
  assert.deepEqual(
    dedupeLabels(['Leaks at the pump, needs a gasket', 'leaks at the pump, needs a gasket', 'Dead battery']),
    ['Leaks at the pump, needs a gasket', 'Dead battery'],
  );
  assert.deepEqual(dedupeLabels(['', '  ']), []);
});
