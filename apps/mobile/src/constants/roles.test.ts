import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PERMISSION_LABELS, ROLE_DEFAULTS, PERMISSION_GROUPS, PERMISSION_GROUP_NAMES } from './roles';
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

// #200: the role editor groups the flat permission matrix into collapsible
// sections (Inventory / Jobs / Scheduling / Financial / Admin). Every
// Permission key must land in exactly one group, or the editor either drops a
// permission from the UI entirely or lets it appear (and be toggled) twice.
test('PERMISSION_GROUPS partitions every Permission key exactly once', () => {
  const samplePermissionMap = ROLE_DEFAULTS.full_admin as Record<Permission, boolean>;
  const permissionKeys = Object.keys(samplePermissionMap) as Permission[];

  const seenCount = new Map<string, number>();
  for (const group of PERMISSION_GROUP_NAMES) {
    for (const perm of PERMISSION_GROUPS[group]) {
      seenCount.set(perm, (seenCount.get(perm) ?? 0) + 1);
    }
  }

  for (const perm of permissionKeys) {
    const count = seenCount.get(perm) ?? 0;
    assert.equal(count, 1, `"${perm}" appears in ${count} groups (expected exactly 1)`);
  }

  // No stray grouped keys either — every grouped permission should be a real
  // Permission (keeps PERMISSION_GROUPS from drifting from the union).
  for (const perm of seenCount.keys()) {
    assert.ok(
      permissionKeys.includes(perm as Permission),
      `PERMISSION_GROUPS has a stray key "${perm}" not present in the Permission union`,
    );
  }
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
