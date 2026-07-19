import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeQuickActions, isOverdueRepair } from './quickActions';

const NOW = new Date('2026-07-19T12:00:00Z').getTime();
const notTerminal = () => false;
const terminal = () => true;

// ── isOverdueRepair: the shared past-due predicate ──────────────────────────

test('#144: repair with past due_at and open status is overdue', () => {
  assert.equal(isOverdueRepair({ due_at: '2026-07-01T00:00:00Z', status: 'open' }, notTerminal, NOW), true);
});

test('#144: no due date, future due date, or terminal status are not overdue', () => {
  assert.equal(isOverdueRepair({ due_at: null, status: 'open' }, notTerminal, NOW), false);
  assert.equal(isOverdueRepair({ due_at: '2026-08-01T00:00:00Z', status: 'open' }, notTerminal, NOW), false);
  assert.equal(isOverdueRepair({ due_at: '2026-07-01T00:00:00Z', status: 'done' }, terminal, NOW), false);
});

// ── computeQuickActions: which contextual actions show ──────────────────────

const NONE = {
  activeVehicleCheckout: null,
  overdueRepairCount: 0,
  serviceDueCount: 0,
  canEditInventory: false,
  lowStockCount: 0,
};

test('#144: nothing contextual → no actions', () => {
  assert.deepEqual(computeQuickActions(NONE), []);
});

test('#144: active vehicle checkout → check-in action with vehicle name', () => {
  const actions = computeQuickActions({
    ...NONE,
    activeVehicleCheckout: { vehicle_location_id: 'v1', vehicle_name: 'Van 2' },
  });
  assert.equal(actions.length, 1);
  assert.deepEqual(actions[0], {
    key: 'vehicle-checkin',
    vehicleLocationId: 'v1',
    label: 'Check In Van 2',
  });
});

test('#144: checkout without a name falls back to generic label', () => {
  const [a] = computeQuickActions({
    ...NONE,
    activeVehicleCheckout: { vehicle_location_id: 'v1', vehicle_name: null },
  });
  assert.equal(a.label, 'Check In Vehicle');
});

test('#144: past-due needs edit_inventory; counts combine repairs + service', () => {
  // Without the permission the counts are invisible.
  assert.deepEqual(
    computeQuickActions({ ...NONE, overdueRepairCount: 2, serviceDueCount: 1 }),
    [],
  );
  const actions = computeQuickActions({
    ...NONE, canEditInventory: true, overdueRepairCount: 2, serviceDueCount: 1,
  });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].key, 'past-due');
  assert.equal((actions[0] as { count: number }).count, 3);
  // Repairs outrank service for the destination when both exist.
  assert.equal((actions[0] as { target: string }).target, 'repairs');
});

test('#144: past-due with only service due routes to equipment', () => {
  const [a] = computeQuickActions({ ...NONE, canEditInventory: true, serviceDueCount: 2 });
  assert.equal(a.key, 'past-due');
  assert.equal((a as { target: string }).target, 'equipment');
});

test('#144: low stock needs edit_inventory AND a non-empty list', () => {
  assert.deepEqual(computeQuickActions({ ...NONE, lowStockCount: 4 }), []);
  assert.deepEqual(computeQuickActions({ ...NONE, canEditInventory: true }), []);
  const [a] = computeQuickActions({ ...NONE, canEditInventory: true, lowStockCount: 4 });
  assert.deepEqual(a, { key: 'low-stock-catalog', count: 4, label: '4 low stock items' });
});

test('#144: singular label for one low stock item', () => {
  const [a] = computeQuickActions({ ...NONE, canEditInventory: true, lowStockCount: 1 });
  assert.equal(a.label, '1 low stock item');
});

test('#144: all three conditions → all three actions, checkin first', () => {
  const actions = computeQuickActions({
    activeVehicleCheckout: { vehicle_location_id: 'v1', vehicle_name: 'Van 2' },
    overdueRepairCount: 1,
    serviceDueCount: 0,
    canEditInventory: true,
    lowStockCount: 2,
  });
  assert.deepEqual(actions.map(a => a.key), ['vehicle-checkin', 'past-due', 'low-stock-catalog']);
});
