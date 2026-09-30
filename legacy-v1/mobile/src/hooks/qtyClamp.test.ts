import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampQtyInput, stepQty } from './qtyClamp';

// ── clampQtyInput: sanitize typed text, cap at max ──────────────────────────

test('typing above max clamps to max', () => {
  assert.equal(clampQtyInput('12', 5), '5');
  assert.equal(clampQtyInput('5.1', 5), '5');
});

test('typing at or below max passes through as typed', () => {
  assert.equal(clampQtyInput('3', 5), '3');
  assert.equal(clampQtyInput('5', 5), '5');
  assert.equal(clampQtyInput('2.5', 5), '2.5');
});

test('partial decimal input is preserved while typing', () => {
  assert.equal(clampQtyInput('', 5), '');
  assert.equal(clampQtyInput('.', 5), '.');
  assert.equal(clampQtyInput('1.', 5), '1.');
});

test('non-numeric characters are stripped', () => {
  assert.equal(clampQtyInput('1a2', 99), '12');
  assert.equal(clampQtyInput('-3', 99), '3');
  assert.equal(clampQtyInput('1.2.3', 99), '1.23');
});

test('fractional max clamps typed input', () => {
  assert.equal(clampQtyInput('1', 0.5), '0.5');
});

test('no max (null) leaves values unclamped', () => {
  assert.equal(clampQtyInput('9999', null), '9999');
});

// ── stepQty: +/- buttons, clamped to [lower, max] ───────────────────────────

test('step up and down by one', () => {
  assert.equal(stepQty('2', 1, 10), '3');
  assert.equal(stepQty('2', -1, 10), '1');
});

test('step up stops at max', () => {
  assert.equal(stepQty('10', 1, 10), '10');
  assert.equal(stepQty('9.5', 1, 10), '10');
});

test('step down stops at 1', () => {
  assert.equal(stepQty('1', -1, 10), '1');
  assert.equal(stepQty('0.5', -1, 10), '1');
});

test('fractional max below 1 becomes the whole range', () => {
  assert.equal(stepQty('0.5', 1, 0.5), '0.5');
  assert.equal(stepQty('0.5', -1, 0.5), '0.5');
});

test('garbage input steps from zero', () => {
  assert.equal(stepQty('', 1, 10), '1');
  assert.equal(stepQty('abc', 1, 10), '1');
});

test('no max (null) still floors at 1', () => {
  assert.equal(stepQty('7', 1, null), '8');
  assert.equal(stepQty('1', -1, null), '1');
});

test('float noise is rounded away', () => {
  assert.equal(stepQty('0.1', 1, 10), '1.1');
  assert.equal(stepQty('2.2', 1, 10), '3.2');
});
