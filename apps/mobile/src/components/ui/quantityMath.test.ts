import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampQuantity, parseQuantityInput } from './quantityMath';

test('clampQuantity: within range is unchanged', () => {
  assert.equal(clampQuantity(5, 0, 10), 5);
});

test('clampQuantity: below min clamps to min', () => {
  assert.equal(clampQuantity(-5, 0, 10), 0);
});

test('clampQuantity: above max clamps to max', () => {
  assert.equal(clampQuantity(15, 0, 10), 10);
});

test('clampQuantity: undefined max means no upper bound', () => {
  assert.equal(clampQuantity(1000, 0, undefined), 1000);
});

test('clampQuantity: min equal to max pins the value', () => {
  assert.equal(clampQuantity(5, 3, 3), 3);
});

test('parseQuantityInput: plain integer parses', () => {
  assert.equal(parseQuantityInput('7', 0, 10, false), 7);
});

test('parseQuantityInput: typing -5 with min 0 commits 0', () => {
  assert.equal(parseQuantityInput('-5', 0, undefined, false), 0);
});

test('parseQuantityInput: value above max clamps down', () => {
  assert.equal(parseQuantityInput('999', 0, 50, false), 50);
});

test('parseQuantityInput: non-numeric input is rejected', () => {
  assert.equal(parseQuantityInput('abc', 0, undefined, false), null);
});

test('parseQuantityInput: empty string is rejected', () => {
  assert.equal(parseQuantityInput('', 0, undefined, false), null);
});

test('parseQuantityInput: bare minus sign is rejected (mid-typing state)', () => {
  assert.equal(parseQuantityInput('-', 0, undefined, false), null);
});

test('parseQuantityInput: decimal rejected when allowDecimal is false', () => {
  assert.equal(parseQuantityInput('1.5', 0, undefined, false), null);
});

test('parseQuantityInput: decimal accepted when allowDecimal is true', () => {
  assert.equal(parseQuantityInput('1.5', 0, undefined, true), 1.5);
});

test('parseQuantityInput: trailing decimal point mid-typing is rejected as non-final', () => {
  // "1." is a valid intermediate typing state under the decimal pattern but
  // Number("1.") === 1, so it should resolve rather than error out.
  assert.equal(parseQuantityInput('1.', 0, undefined, true), 1);
});
