import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PERMISSION_LABELS, ROLE_DEFAULTS } from './roles';
import type { Permission, UserRole } from './roles';

// #76: PermissionGate's disable-mode reason text ("Requires " + label) reads
// PERMISSION_LABELS[permission] for whichever Permission the caller passes in.
// A missing key would render "Requires undefined" — this test is the guardrail.
test('PERMISSION_LABELS has a label for every Permission key', () => {
  // Every permission actually used across ROLE_DEFAULTS is a Permission — use
  // one role's map (they all share the same PermissionMap shape) as the
  // authoritative key list so this test doesn't hand-maintain a second copy of
  // the Permission union.
  const samplePermissionMap = ROLE_DEFAULTS.full_admin as Record<Permission, boolean>;
  const permissionKeys = Object.keys(samplePermissionMap) as Permission[];

  assert.ok(permissionKeys.length > 0, 'sanity: ROLE_DEFAULTS.full_admin should not be empty');

  for (const perm of permissionKeys) {
    const label = PERMISSION_LABELS[perm];
    assert.ok(
      typeof label === 'string' && label.length > 0,
      `PERMISSION_LABELS is missing a non-empty label for "${perm}"`,
    );
  }

  // No stray labels either — every PERMISSION_LABELS key should be a real
  // Permission (keeps the map from silently drifting from the union).
  const labelKeys = Object.keys(PERMISSION_LABELS);
  for (const key of labelKeys) {
    assert.ok(
      permissionKeys.includes(key as Permission),
      `PERMISSION_LABELS has a stray key "${key}" not present in the Permission union`,
    );
  }
  assert.equal(labelKeys.length, permissionKeys.length, 'PERMISSION_LABELS and Permission union must be the same size');
});

test('every UserRole has a ROLE_DEFAULTS entry covering every Permission', () => {
  const roles = Object.keys(ROLE_DEFAULTS) as UserRole[];
  const permissionKeys = Object.keys(PERMISSION_LABELS) as Permission[];
  for (const role of roles) {
    const map = ROLE_DEFAULTS[role] as Record<Permission, boolean>;
    for (const perm of permissionKeys) {
      assert.ok(
        typeof map[perm] === 'boolean',
        `ROLE_DEFAULTS.${role} is missing a boolean value for "${perm}"`,
      );
    }
  }
});
