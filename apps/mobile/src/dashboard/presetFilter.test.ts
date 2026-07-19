import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterTilesForRoles } from './presetFilter';
import type { WidgetType } from './widgets';

// checkout requires checkout_inventory; users requires manage_users;
// fast-checkout and manage-my-team have NO requiredPermission (data-driven).
const TILES: WidgetType[] = ['fast-checkout', 'checkout', 'users', 'manage-my-team'];

test('no assigned roles → every tile is offered (nothing to check against)', () => {
  assert.deepEqual(filterTilesForRoles(TILES, [], () => false), TILES);
});

test('permissionless tiles are always offered', () => {
  const out = filterTilesForRoles(TILES, ['construction_crew'], () => false);
  assert.deepEqual(out, ['fast-checkout', 'manage-my-team']);
});

test('a gated tile needs EVERY assigned role to pass', () => {
  const perms: Record<string, string[]> = {
    construction_crew: ['checkout_inventory'],
    hr_manager: ['manage_users'],
  };
  const roleHasPerm = (role: string, perm: string) => (perms[role] ?? []).includes(perm);
  assert.deepEqual(
    filterTilesForRoles(TILES, ['construction_crew', 'hr_manager'], roleHasPerm),
    ['fast-checkout', 'manage-my-team'],   // neither tile passes BOTH roles
  );
  assert.deepEqual(
    filterTilesForRoles(TILES, ['construction_crew'], roleHasPerm),
    ['fast-checkout', 'checkout', 'manage-my-team'],
  );
});
