import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateReturnDestination, buildReturnLogRows } from './returnBatch';

// ── validateReturnDestination ────────────────────────────────────────────────

test('validateReturnDestination: location destination → ok', () => {
  assert.deepEqual(
    validateReturnDestination({ type: 'location', toLocationId: 'loc1' }),
    { ok: true },
  );
});

test('validateReturnDestination: job destination → rejected', () => {
  const res = validateReturnDestination({ type: 'job', toLocationId: null });
  assert.equal(res.ok, false);
});

test('validateReturnDestination: manager destination → rejected', () => {
  const res = validateReturnDestination({ type: 'manager', toLocationId: 'loc2' });
  assert.equal(res.ok, false);
});

test('validateReturnDestination: office destination → rejected (v1 location-only policy)', () => {
  const res = validateReturnDestination({ type: 'office', toLocationId: 'loc3' });
  assert.equal(res.ok, false);
});

test('validateReturnDestination: location type but null toLocationId → rejected (defensive)', () => {
  const res = validateReturnDestination({ type: 'location', toLocationId: null });
  assert.equal(res.ok, false);
});

// ── buildReturnLogRows ───────────────────────────────────────────────────────

const units = [
  { id: 'u1', item_id: 'item1', asset_tag: 'AM-001', current_job_id: 'job1' },
  { id: 'u2', item_id: 'item2', asset_tag: 'AM-002', current_job_id: null },
];

test('buildReturnLogRows: exact log shape contract (getDeployedUnitsForUser depends on this)', () => {
  const rows = buildReturnLogRows(units, 'destLoc', 'event-1');
  assert.deepEqual(rows, [
    {
      action: 'checkin', entity_id: 'item1', from_location_id: null,
      to_location_id: 'destLoc', job_id: 'job1', quantity: 1, note: 'unit AM-001',
      id: 'event-1',
    },
    {
      action: 'checkin', entity_id: 'item2', from_location_id: null,
      to_location_id: 'destLoc', job_id: null, quantity: 1, note: 'unit AM-002',
    },
  ]);
});

test('buildReturnLogRows: stable event id rides ONLY the first row', () => {
  const rows = buildReturnLogRows(units, 'destLoc', 'event-1');
  assert.equal(rows[0].id, 'event-1');
  assert.equal('id' in rows[1], false);
});

test('buildReturnLogRows: empty batch → empty rows', () => {
  assert.deepEqual(buildReturnLogRows([], 'destLoc', 'event-1'), []);
});

test('buildReturnLogRows: job_id is the CAPTURED current_job_id, not derived from destination', () => {
  const rows = buildReturnLogRows(
    [{ id: 'u3', item_id: 'item3', asset_tag: 'AM-003', current_job_id: 'jobABC' }],
    'someOtherLoc',
    'event-2',
  );
  assert.equal(rows[0].job_id, 'jobABC');
  assert.equal(rows[0].to_location_id, 'someOtherLoc');
});
