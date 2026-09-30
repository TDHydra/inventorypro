import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tagFor, signPayload, verifyScanPayload } from './qrSign';

// Interop vector — the SAME (secret, canonical) is asserted in apps/api/src/lib/
// qrSign.test.ts to prove client (js-sha256) and server (node:crypto) agree.
const SECRET = 'inv-test-secret-abcdef 0123456789';
const CANON = 'INV:item:11111111-1111-4111-8111-111111111111';
const SIG16 = 'd6c13ecaecbb2653';
const SIGNED = `INVS:item:11111111-1111-4111-8111-111111111111:${SIG16}`;

test('tagFor matches the cross-platform interop vector', () => {
  assert.equal(tagFor(CANON, SECRET), SIG16);
});

test('signPayload produces INVS:<type>:<value>:<sig>', () => {
  assert.equal(signPayload(CANON, SECRET), SIGNED);
});

test('signPayload is a no-op without a key or on non-INV input', () => {
  assert.equal(signPayload(CANON, null), CANON);
  assert.equal(signPayload('random-barcode', SECRET), 'random-barcode');
});

test('verify: valid signature → canonical', () => {
  assert.equal(verifyScanPayload(SIGNED, { secret: SECRET, requireSigned: false }), CANON);
  assert.equal(verifyScanPayload(SIGNED, { secret: SECRET, requireSigned: true }), CANON);
});

test('verify: tampered signature or value → reject (null)', () => {
  assert.equal(verifyScanPayload(SIGNED.slice(0, -1) + '0', { secret: SECRET, requireSigned: false }), null);
  const tamperedValue = `INVS:item:22222222-2222-4222-8222-222222222222:${SIG16}`;
  assert.equal(verifyScanPayload(tamperedValue, { secret: SECRET, requireSigned: false }), null);
});

test('verify: signed label but no local key → reject', () => {
  assert.equal(verifyScanPayload(SIGNED, { secret: null, requireSigned: false }), null);
});

test('verify grace mode: unsigned legacy INV: accepted when not enforcing', () => {
  assert.equal(verifyScanPayload(CANON, { secret: SECRET, requireSigned: false }), CANON);
  assert.equal(verifyScanPayload(CANON, { secret: null, requireSigned: true }), CANON); // no key → can't enforce
});

test('verify strict mode: unsigned legacy INV: rejected when enforcing + key present', () => {
  assert.equal(verifyScanPayload(CANON, { secret: SECRET, requireSigned: true }), null);
});

test('verify: non-INV strings pass through (barcode fallback)', () => {
  assert.equal(verifyScanPayload('9781234567890', { secret: SECRET, requireSigned: true }), '9781234567890');
});

test('rotation: a label signed with the PREVIOUS key verifies while prevSecret is kept', () => {
  const oldKey = 'old-key-000000000000000000000000';
  const newKey = 'new-key-111111111111111111111111';
  const oldLabel = signPayload(CANON, oldKey);
  const newLabel = signPayload(CANON, newKey);
  // During rotation: current=newKey, prev=oldKey → both verify.
  assert.equal(verifyScanPayload(oldLabel, { secret: newKey, prevSecret: oldKey, requireSigned: true }), CANON);
  assert.equal(verifyScanPayload(newLabel, { secret: newKey, prevSecret: oldKey, requireSigned: true }), CANON);
  // After finishing rotation (prev dropped): old-key label no longer verifies.
  assert.equal(verifyScanPayload(oldLabel, { secret: newKey, prevSecret: null, requireSigned: false }), null);
  assert.equal(verifyScanPayload(newLabel, { secret: newKey, prevSecret: null, requireSigned: false }), CANON);
});

test('unit tags (which may contain non-colon chars) round-trip through sign+verify', () => {
  const canon = 'INV:unit:AM-0007';
  const signed = signPayload(canon, SECRET);
  assert.ok(signed.startsWith('INVS:unit:AM-0007:'));
  assert.equal(verifyScanPayload(signed, { secret: SECRET, requireSigned: true }), canon);
});
