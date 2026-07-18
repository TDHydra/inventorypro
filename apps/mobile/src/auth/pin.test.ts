import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isWeakPin, validatePinFormat } from './pin';

test('isWeakPin flags repeats, sequences, and common PINs', () => {
  assert.equal(isWeakPin('0000'), true);
  assert.equal(isWeakPin('111111'), true);
  assert.equal(isWeakPin('1234'), true);
  assert.equal(isWeakPin('4321'), true);
  assert.equal(isWeakPin('987654'), true);
  assert.equal(isWeakPin('1212'), true);
  assert.equal(isWeakPin('6969'), true);
});

test('isWeakPin allows random PINs and ignores wrap-around / non-digits', () => {
  assert.equal(isWeakPin('1957'), false);
  assert.equal(isWeakPin('8264'), false);
  assert.equal(isWeakPin('9012'), false); // wrap-around, not a run
  assert.equal(isWeakPin('12a4'), false);
  assert.equal(isWeakPin(''), false);
});

test('validatePinFormat is unchanged and does NOT reject weak PINs (login path)', () => {
  // Existing users may have a weak PIN; the login/verify path must still accept
  // its format so they can sign in. Weakness is only enforced at set-PIN.
  assert.equal(validatePinFormat('1234', 4), null);
  assert.equal(validatePinFormat('0000', 4), null);
  assert.equal(validatePinFormat('12a4', 4), 'PIN must contain only digits');
});
