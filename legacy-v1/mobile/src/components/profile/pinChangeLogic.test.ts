import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePinChange } from './pinChangeLogic';

test('validatePinChange passes a well-formed change', () => {
  assert.deepEqual(validatePinChange('1957', '8264', '8264', 4), {});
});

test('validatePinChange requires the current PIN in the right format', () => {
  assert.match(validatePinChange('', '8264', '8264', 4).current ?? '', /current PIN/i);
  assert.match(validatePinChange('12a4', '8264', '8264', 4).current ?? '', /digits/);
  assert.match(validatePinChange('123', '8264', '8264', 4).current ?? '', /4 digits/);
});

test('validatePinChange enforces format and length on the new PIN', () => {
  assert.match(validatePinChange('1957', '', '', 4).next ?? '', /new PIN/i);
  assert.match(validatePinChange('1957', '82x4', '82x4', 4).next ?? '', /digits/);
  assert.match(validatePinChange('195726', '8264', '8264', 6).next ?? '', /6 digits/);
});

test('validatePinChange rejects weak new PINs (repeats, sequences, common list)', () => {
  assert.match(validatePinChange('1957', '0000', '0000', 4).next ?? '', /easy to guess/i);
  assert.match(validatePinChange('1957', '1234', '1234', 4).next ?? '', /easy to guess/i);
  assert.match(validatePinChange('1957', '2580', '2580', 4).next ?? '', /easy to guess/i);
});

test('validatePinChange rejects new == current (mirrors the server rule)', () => {
  assert.match(validatePinChange('1957', '1957', '1957', 4).next ?? '', /different/i);
});

test('validatePinChange requires a matching confirmation', () => {
  assert.match(validatePinChange('1957', '8264', '8265', 4).confirm ?? '', /match/i);
  assert.match(validatePinChange('1957', '8264', '', 4).confirm ?? '', /confirm/i);
  // The confirm error is suppressed while the new PIN itself is invalid — one
  // problem at a time.
  assert.equal(validatePinChange('1957', '0000', '', 4).confirm, undefined);
});
