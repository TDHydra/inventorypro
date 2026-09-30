import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isWeakPin, COMMON_PINS } from './weakPin';

test('rejects all-same-digit repeats of any length', () => {
  assert.equal(isWeakPin('0000'), true);
  assert.equal(isWeakPin('1111'), true);
  assert.equal(isWeakPin('9999'), true);
  assert.equal(isWeakPin('111111'), true);
  assert.equal(isWeakPin('88888888'), true);
});

test('rejects straight ascending sequences', () => {
  assert.equal(isWeakPin('1234'), true);
  assert.equal(isWeakPin('3456'), true);
  assert.equal(isWeakPin('4567'), true);
  assert.equal(isWeakPin('123456'), true);
  assert.equal(isWeakPin('6789'), true);
});

test('rejects straight descending sequences', () => {
  assert.equal(isWeakPin('4321'), true);
  assert.equal(isWeakPin('3210'), true);
  assert.equal(isWeakPin('9876'), true);
  assert.equal(isWeakPin('987654'), true);
});

test('does not treat wrap-around as a sequence', () => {
  // 8901 / 9012 wrap past 9→0; not a straight run, and not on the list.
  assert.equal(isWeakPin('8901'), false);
  assert.equal(isWeakPin('9012'), false);
});

test('rejects known common PINs from the blocklist', () => {
  for (const pin of COMMON_PINS) {
    assert.equal(isWeakPin(pin), true, `${pin} should be weak`);
  }
  assert.equal(isWeakPin('1212'), true);
  assert.equal(isWeakPin('6969'), true);
});

test('accepts reasonably random PINs', () => {
  assert.equal(isWeakPin('1957'), false);
  assert.equal(isWeakPin('8264'), false);
  assert.equal(isWeakPin('047319'), false);
  assert.equal(isWeakPin('7392'), false);
});

test('ignores non-digit input (format is validated elsewhere)', () => {
  assert.equal(isWeakPin(''), false);
  assert.equal(isWeakPin('12a4'), false);
  assert.equal(isWeakPin('abcd'), false);
});
