import { test } from 'node:test';
import assert from 'node:assert';
import { denialMessage, readableFailureReason } from './denialMessages';

test('denialMessage: mapped table + INSERT reads as an edit denial (#202 example)', () => {
  assert.equal(
    denialMessage({ table_name: 'schedule_assignments', operation: 'INSERT' }),
    "Your account can't edit schedules — this change wasn't saved."
  );
});

test('denialMessage: mapped table + UPDATE also reads as an edit denial', () => {
  assert.equal(
    denialMessage({ table_name: 'schedule_assignments', operation: 'UPDATE' }),
    "Your account can't edit schedules — this change wasn't saved."
  );
});

test('denialMessage: DELETE gets its own verb, not "edit"', () => {
  assert.equal(
    denialMessage({ table_name: 'jobs', operation: 'DELETE' }),
    "Your account can't delete jobs — this change wasn't saved."
  );
});

test('denialMessage: ADJUST (stock adjustments) reads as an edit denial', () => {
  assert.equal(
    denialMessage({ table_name: 'inventory_items', operation: 'ADJUST' }),
    "Your account can't edit inventory items — this change wasn't saved."
  );
});

test('denialMessage: unmapped table falls back to a humanized entity name, not the raw identifier', () => {
  assert.equal(
    denialMessage({ table_name: 'gas_receipts', operation: 'INSERT' }),
    "Your account can't edit gas receipts — this change wasn't saved."
  );
});

test('denialMessage: never echoes the server\'s raw rejection text', () => {
  const msg = denialMessage({ table_name: 'teams', operation: 'UPDATE' });
  assert.ok(!msg.includes('Forbidden'));
  assert.ok(!msg.includes('manage_teams'));
});

// #235: readableFailureReason — raw 'HTTP <status>' strings (engine.ts's
// non-2xx branch) in SyncIndicator's failed bucket get plain-language text.
test('readableFailureReason: 500 maps to a generic server-error message', () => {
  assert.equal(
    readableFailureReason('HTTP 500: Internal Server Error'),
    'Server error — will retry'
  );
});

test('readableFailureReason: 501 also falls under the 500-class generic message', () => {
  assert.equal(
    readableFailureReason('HTTP 501: Not Implemented'),
    'Server error — will retry'
  );
});

test('readableFailureReason: 502/503/504 map to "Server unavailable" (more specific than the 500-class default)', () => {
  assert.equal(readableFailureReason('HTTP 502: Bad Gateway'), 'Server unavailable — will retry');
  assert.equal(readableFailureReason('HTTP 503: Service Unavailable'), 'Server unavailable — will retry');
  assert.equal(readableFailureReason('HTTP 504: Gateway Timeout'), 'Server unavailable — will retry');
});

test('readableFailureReason: 429 maps to "Server busy"', () => {
  assert.equal(readableFailureReason('HTTP 429: Too Many Requests'), 'Server busy — will retry');
});

test('readableFailureReason: 408 maps to "Timed out"', () => {
  assert.equal(readableFailureReason('HTTP 408: Request Timeout'), 'Timed out — will retry');
});

test('readableFailureReason: an unrecognized 4xx is returned unchanged', () => {
  assert.equal(readableFailureReason('HTTP 404: Not Found'), 'HTTP 404: Not Found');
});

test('readableFailureReason: a non-HTTP-prefixed message is returned unchanged', () => {
  assert.equal(readableFailureReason('Rejected: Forbidden: teams requires manage_teams'), 'Rejected: Forbidden: teams requires manage_teams');
});
