import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterTilesForRoles, blockVisibleForRole, filterTilesForUser } from './presetFilter';
import type { WidgetType, LayoutBlock } from './widgets';

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

// ── blockVisibleForRole (#192 view-as-role preview) ──────────────────────────

test('a block with no requiredPermission is always visible', () => {
  const block: LayoutBlock = { widget: 'fast-checkout', width: 'half' };
  assert.equal(blockVisibleForRole(block, 'construction_crew', () => false), true);
});

test('a section header (no requiredPermission) is always visible', () => {
  const block: LayoutBlock = { widget: 'section', width: 'full', config: { sectionTitle: 'Ops' } };
  assert.equal(blockVisibleForRole(block, 'temporary_employee', () => false), true);
});

test('a gated tile is visible only when the role passes its requiredPermission', () => {
  const block: LayoutBlock = { widget: 'checkout', width: 'full' }; // requiredPermission: checkout_inventory
  const roleHasPerm = (role: string, perm: string) =>
    role === 'construction_crew' && perm === 'checkout_inventory';
  assert.equal(blockVisibleForRole(block, 'construction_crew', roleHasPerm), true);
  assert.equal(blockVisibleForRole(block, 'temporary_employee', roleHasPerm), false);
});

test('a gated non-tile block (activity-preview) is checked the same way as a tile', () => {
  const block: LayoutBlock = { widget: 'activity-preview', width: 'full' }; // requiredPermission: view_all_logs
  const roleHasPerm = (role: string, perm: string) => role === 'hr_manager' && perm === 'view_all_logs';
  assert.equal(blockVisibleForRole(block, 'hr_manager', roleHasPerm), true);
  assert.equal(blockVisibleForRole(block, 'office_manager', roleHasPerm), false);
});

// --- Personal dashboard editor (#193): per-user permission filter ------------

test('filterTilesForUser: permissionless tiles are always offered', () => {
  assert.deepEqual(filterTilesForUser(TILES, () => false), ['fast-checkout', 'manage-my-team']);
});

test('filterTilesForUser: gated tiles need the CALLER (not a role) to pass', () => {
  const granted = new Set(['checkout_inventory']);
  const out = filterTilesForUser(TILES, (perm) => granted.has(perm));
  assert.deepEqual(out, ['fast-checkout', 'checkout', 'manage-my-team']);
});

test('filterTilesForUser: every gate passing offers every tile', () => {
  assert.deepEqual(filterTilesForUser(TILES, () => true), TILES);
});
