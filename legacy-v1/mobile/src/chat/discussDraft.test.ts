import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDiscussDraft } from './discussDraft';

test('job with number and name', () => {
  assert.equal(
    buildDiscussDraft({ kind: 'job', label: 'Kitchen fire', ref: '#123' }),
    'Re job #123 · Kitchen fire: ',
  );
});

test('missing ref drops the ref segment', () => {
  assert.equal(
    buildDiscussDraft({ kind: 'repair', label: 'Dehumidifier XL', ref: null }),
    'Re repair · Dehumidifier XL: ',
  );
});

test('blank label drops the label segment', () => {
  assert.equal(
    buildDiscussDraft({ kind: 'equipment', label: '   ', ref: 'A-102' }),
    'Re equipment A-102: ',
  );
});

test('label is trimmed', () => {
  assert.equal(
    buildDiscussDraft({ kind: 'job', label: '  Flood on 5th  ', ref: null }),
    'Re job · Flood on 5th: ',
  );
});

test('both missing still yields a usable stem', () => {
  assert.equal(
    buildDiscussDraft({ kind: 'equipment', label: '', ref: null }),
    'Re equipment: ',
  );
});
