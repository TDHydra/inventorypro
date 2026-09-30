import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldLockTarget } from './repairTargetLock';

// The entry points that pre-fill a target: ItemCard, equipment/[id] (per unit)
// and locations/[id] all push sheet=repair with entityType + entityId.
test('#288: opening the sheet FOR a specific thing locks the target', () => {
  assert.equal(shouldLockTarget('equipment_unit', '725bb119-a39e-445d-b1ec-1c9e99f8f88d'), true);
  assert.equal(shouldLockTarget('item', 'abc'), true);
  assert.equal(shouldLockTarget('location', 'veh-1'), true);
});

test('#288: the blank chooser (Repairs > New) stays unlocked', () => {
  assert.equal(shouldLockTarget(null, undefined), false);
});

test('#288: NEVER lock without a target — that would strand the user', () => {
  // Locking hides the picker and disables the type chips. If it ever fired on
  // entityType alone, a caller that forgot entityId would render a form with
  // nothing selected, no way to select, and a "Choose what to repair." error
  // on every save attempt.
  assert.equal(shouldLockTarget('equipment_unit', undefined), false);
  assert.equal(shouldLockTarget('equipment_unit', null), false);
  assert.equal(shouldLockTarget('equipment_unit', ''), false);
  assert.equal(shouldLockTarget('equipment_unit', '   '), false);
});

test('#288: an unrecognized entity type falls back to the chooser', () => {
  // initialEntityType is null when the param is not one of the three known
  // types, even though an entityId rode along with it.
  assert.equal(shouldLockTarget(null, 'some-id'), false);
});
