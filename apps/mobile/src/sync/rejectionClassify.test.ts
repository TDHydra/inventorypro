import { test } from 'node:test';
import assert from 'node:assert';
import { isPermanentRejection } from './rejectionClassify';

// #235: server-supplied `code` (apps/api/src/routes/sync.ts conflicts.push
// sites) is authoritative when present.
test('isPermanentRejection: code FORBIDDEN is permanent', () => {
  assert.equal(isPermanentRejection('Forbidden: teams requires manage_teams', 'FORBIDDEN'), true);
});

test('isPermanentRejection: code NOT_ALLOWED is permanent', () => {
  assert.equal(isPermanentRejection('Table not allowed', 'NOT_ALLOWED'), true);
});

test('isPermanentRejection: code VALIDATION is permanent', () => {
  assert.equal(isPermanentRejection('Forbidden: media entity_type not allowed', 'VALIDATION'), true);
});

test('isPermanentRejection: code MAINTENANCE is transient (retries once the freeze lifts)', () => {
  assert.equal(isPermanentRejection('Maintenance mode: writes are frozen', 'MAINTENANCE'), false);
});

test('isPermanentRejection: code CONFLICT is transient', () => {
  assert.equal(isPermanentRejection('team inventory check failed', 'CONFLICT'), false);
});

// Old servers (pre-#235) never send a `code` — fall back to the wording regex.
test('isPermanentRejection: no code falls back to the legacy wording regex (Forbidden)', () => {
  assert.equal(isPermanentRejection('Forbidden: teams requires manage_teams', undefined), true);
});

test('isPermanentRejection: no code falls back to the legacy wording regex (not allowed)', () => {
  assert.equal(isPermanentRejection('Table not allowed', undefined), true);
});

test('isPermanentRejection: no code, no matching wording is transient', () => {
  assert.equal(isPermanentRejection('Maintenance mode: writes are frozen', undefined), false);
});

test('isPermanentRejection: no error and no code is transient', () => {
  assert.equal(isPermanentRejection(undefined, undefined), false);
});

// An unrecognized code (future server, unknown value) must not silently drop
// an entry the client can't classify — falls back to the wording regex too.
test('isPermanentRejection: unrecognized code falls back to the wording regex', () => {
  assert.equal(isPermanentRejection('write rejected', 'SOMETHING_NEW'), false);
  assert.equal(isPermanentRejection('Forbidden: something', 'SOMETHING_NEW'), true);
});
