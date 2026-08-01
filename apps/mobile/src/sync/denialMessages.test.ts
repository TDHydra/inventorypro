import { test } from 'node:test';
import assert from 'node:assert';
import { denialMessage } from './denialMessages';

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
