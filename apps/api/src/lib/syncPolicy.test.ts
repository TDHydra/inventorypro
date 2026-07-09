import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  keepRealColumns,
  applyWritePolicy,
  requiredOperationPerm,
  isAllowedActivity,
  selectColumnsFor,
  requiresRolesPermForTarget,
  sanitizeTeamOverrides,
  TEAM_OVERRIDABLE_PERMISSIONS,
  validateMediaWrite,
} from './syncPolicy';

const real = new Map([['jobs', new Set(['id', 'name', 'status'])]]);

test('keepRealColumns drops injection-style keys not matching a real column', () => {
  const payload = {
    id: 'x',
    name: 'ok',
    "name = (SELECT pin_hash FROM users LIMIT 1)--": 'evil',
  };
  const { kept, dropped } = keepRealColumns('jobs', payload, real);
  assert.deepEqual(Object.keys(kept), ['id', 'name']);
  assert.deepEqual(dropped, ["name = (SELECT pin_hash FROM users LIMIT 1)--"]);
});

test('keepRealColumns drops everything for an unknown table (fail closed)', () => {
  const { kept } = keepRealColumns('not_a_table', { id: 'x' }, real);
  assert.deepEqual(kept, {});
});

const realUsers = new Map([['users', new Set(['id', 'name', 'role', 'pin_hash', 'permission_overrides', 'active', 'expires_at', 'updated_at'])]]);

test('applyWritePolicy rejects privilege columns on users (no manage_roles_permissions)', () => {
  const { rejected } = applyWritePolicy(
    'users', 'UPDATE',
    { id: 'self', role: 'full_admin', permission_overrides: { system_settings: true } },
    'self', realUsers, () => false,
  );
  assert.deepEqual(rejected.sort(), ['permission_overrides', 'role']);
});

test('applyWritePolicy allows role + permission_overrides with manage_roles_permissions, but still rejects pin_hash', () => {
  const { row, rejected } = applyWritePolicy(
    'users', 'UPDATE',
    { id: 'self', role: 'full_admin', permission_overrides: { system_settings: true }, pin_hash: 'x' },
    'self', realUsers, () => true,
  );
  assert.deepEqual(rejected, ['pin_hash']);
  assert.equal(row.role, 'full_admin');
  assert.deepEqual(row.permission_overrides, { system_settings: true });
});

test('applyWritePolicy allows a benign users.name edit', () => {
  const { row, rejected } = applyWritePolicy('users', 'UPDATE', { id: 'self', name: 'New Name' }, 'self', realUsers, () => false);
  assert.deepEqual(rejected, []);
  assert.deepEqual(row, { id: 'self', name: 'New Name' });
});

test('applyWritePolicy forces attribution to caller on INSERT', () => {
  const realJobs = new Map([['jobs', new Set(['id', 'name', 'created_by'])]]);
  const { row } = applyWritePolicy('jobs', 'INSERT', { id: 'j', name: 'J', created_by: 'someone-else' }, 'caller', realJobs, () => true);
  assert.equal(row.created_by, 'caller');
});

test('operational tables map op -> permission', () => {
  assert.equal(requiredOperationPerm('inventory_items', 'DELETE'), 'delete_inventory');
  assert.equal(requiredOperationPerm('inventory_items', 'UPDATE'), 'edit_inventory');
  assert.equal(requiredOperationPerm('locations', 'UPDATE'), 'manage_locations');
  assert.equal(requiredOperationPerm('jobs', 'INSERT'), 'create_jobs');
});

test('label_templates writes require system_settings (admin-only)', () => {
  assert.equal(requiredOperationPerm('label_templates', 'INSERT'), 'system_settings');
  assert.equal(requiredOperationPerm('label_templates', 'UPDATE'), 'system_settings');
  assert.equal(requiredOperationPerm('label_templates', 'DELETE'), 'system_settings');
});

test('privileged tables return null here (gated elsewhere)', () => {
  assert.equal(requiredOperationPerm('users', 'UPDATE'), null);
  assert.equal(requiredOperationPerm('activity_log', 'INSERT'), null);
});

test('activity_log action/entity_type constrained to enum', () => {
  assert.equal(isAllowedActivity('checkout', 'item'), true);
  assert.equal(isAllowedActivity('DROP TABLE users', 'item'), false);
  assert.equal(isAllowedActivity('checkout', 'nonsense'), false);
});

test('jobs hides PII/financial columns without view_financial_data', () => {
  const restricted = selectColumnsFor('jobs', false);
  assert.ok(!/customer_name|site_address|insurance_carrier/.test(restricted));
  const full = selectColumnsFor('jobs', true);
  assert.ok(/customer_name/.test(full));
});

test('users never exposes pin_hash or enrollment_code_hash', () => {
  const cols = selectColumnsFor('users', true);
  assert.ok(!/pin_hash|enrollment_code_hash/.test(cols));
});

test('app_config only exposes non-secret keys via projection marker', () => {
  assert.equal(selectColumnsFor('app_config', false), 'key, value, updated_at');
});

test('requiresRolesPermForTarget flags privileged roles, mirroring users.ts PRIVILEGED_ROLES', () => {
  assert.equal(requiresRolesPermForTarget('full_admin'), true);
  assert.equal(requiresRolesPermForTarget('franchise_manager'), true);
  assert.equal(requiresRolesPermForTarget('crew'), false);
  assert.equal(requiresRolesPermForTarget('hr_manager'), false);
});

test('requiresRolesPermForTarget is false for null/undefined target role', () => {
  assert.equal(requiresRolesPermForTarget(null), false);
  assert.equal(requiresRolesPermForTarget(undefined), false);
});

test('repairs hides cost without view_financial_data, exposes it with', () => {
  const restricted = selectColumnsFor('repairs', false);
  assert.ok(!/\bcost\b/.test(restricted));
  assert.ok(/entity_type|assignee_id|due_at/.test(restricted));
  const full = selectColumnsFor('repairs', true);
  assert.ok(/\bcost\b/.test(full));
});

test('TEAM_OVERRIDABLE_PERMISSIONS excludes admin/system-wide keys', () => {
  for (const admin of ['manage_teams', 'manage_users', 'manage_roles_permissions', 'set_pins', 'system_settings']) {
    assert.equal(TEAM_OVERRIDABLE_PERMISSIONS.has(admin), false, `${admin} must not be team-overridable`);
  }
  assert.ok(TEAM_OVERRIDABLE_PERMISSIONS.has('checkin_inventory'));
  assert.ok(TEAM_OVERRIDABLE_PERMISSIONS.has('view_financial_data'));
});

test('sanitizeTeamOverrides strips admin keys even if the caller "holds" them', () => {
  const canEverything = () => true;
  const { clean, rejected } = sanitizeTeamOverrides(
    { checkin_inventory: true, manage_users: true, system_settings: true, manage_teams: false },
    canEverything,
  );
  assert.deepEqual(clean, { checkin_inventory: true });
  assert.deepEqual(rejected.sort(), ['manage_teams', 'manage_users', 'system_settings']);
});

test('sanitizeTeamOverrides blocks a caller from granting a safe key they do not personally hold', () => {
  const canOnlyCheckin = (perm: string) => perm === 'checkin_inventory';
  const { clean, rejected } = sanitizeTeamOverrides(
    { checkin_inventory: true, view_financial_data: true },
    canOnlyCheckin,
  );
  assert.deepEqual(clean, { checkin_inventory: true });
  assert.deepEqual(rejected, ['view_financial_data']);
});

test('sanitizeTeamOverrides accepts a JSON string (mobile stores this column as TEXT)', () => {
  const canAll = () => true;
  const { clean, rejected } = sanitizeTeamOverrides(
    JSON.stringify({ edit_inventory: true, manage_teams: true }),
    canAll,
  );
  assert.deepEqual(clean, { edit_inventory: true });
  assert.deepEqual(rejected, ['manage_teams']);
});

test('sanitizeTeamOverrides coerces truthy/falsy values to real booleans', () => {
  const canAll = () => true;
  const { clean } = sanitizeTeamOverrides({ checkin_inventory: 1, checkout_inventory: 0 }, canAll);
  assert.deepEqual(clean, { checkin_inventory: true, checkout_inventory: false });
});

test('applyWritePolicy sanitizes team_permission_overrides JSON keys without rejecting the whole entry', () => {
  const realTeamMembers = new Map([
    ['team_members', new Set(['team_id', 'user_id', 'team_permission_overrides', 'is_manager', 'updated_at'])],
  ]);
  const canOnlyCheckin = (perm: string) => perm === 'checkin_inventory';
  const { row, rejected } = applyWritePolicy(
    'team_members', 'UPDATE',
    {
      team_id: 't1', user_id: 'u1',
      team_permission_overrides: { checkin_inventory: true, manage_users: true, view_financial_data: true },
    },
    'caller', realTeamMembers, canOnlyCheckin,
  );
  // The column itself is not rejected — only its unsafe inner keys are dropped.
  assert.deepEqual(rejected, []);
  assert.deepEqual(row.team_permission_overrides, { checkin_inventory: true });
});

test('applyWritePolicy still rejects is_manager on team_members (unrelated SENSITIVE_DENY column)', () => {
  const realTeamMembers = new Map([
    ['team_members', new Set(['team_id', 'user_id', 'team_permission_overrides', 'is_manager', 'updated_at'])],
  ]);
  const { rejected } = applyWritePolicy(
    'team_members', 'UPDATE',
    { team_id: 't1', user_id: 'u1', is_manager: true },
    'caller', realTeamMembers, () => true,
  );
  assert.deepEqual(rejected, ['is_manager']);
});

test('media op-perms are a real family: upload / edit / delete are separate grants', () => {
  assert.equal(requiredOperationPerm('media', 'INSERT'), 'upload_media');
  assert.equal(requiredOperationPerm('media', 'UPDATE'), 'edit_media');
  assert.equal(requiredOperationPerm('media', 'DELETE'), 'delete_media');
});

test('edit_media is team-overridable; delete_media deliberately is not', () => {
  // delete_media's GRANT is full-admin-only (routes/sync.ts role_settings guard),
  // so a team manager must not be able to mint it per-team either.
  assert.equal(TEAM_OVERRIDABLE_PERMISSIONS.has('edit_media'), true);
  assert.equal(TEAM_OVERRIDABLE_PERMISSIONS.has('delete_media'), false);
});

test('validateMediaWrite: INSERT requires an allowlisted entity type', () => {
  assert.equal(validateMediaWrite('INSERT', { entity_type: 'job', entity_id: 'j1' }), null);
  assert.equal(validateMediaWrite('INSERT', { entity_type: 'item', entity_id: 'i1' }), null);
  // users/teams were the original IDOR sink the REST allowlist closed — the
  // sync path must reject them too now.
  assert.notEqual(validateMediaWrite('INSERT', { entity_type: 'users', entity_id: 'u1' }), null);
  assert.notEqual(validateMediaWrite('INSERT', { entity_type: 'role_settings', entity_id: 'r' }), null);
  assert.notEqual(validateMediaWrite('INSERT', {}), null);
});

test('validateMediaWrite: UPDATE may re-link only to a job; metadata-only edits pass', () => {
  // caption/location_note edit — no linkage touched
  assert.equal(validateMediaWrite('UPDATE', { id: 'm1', caption: 'x', location_note: 'master bedroom' }), null);
  // the move feature
  assert.equal(validateMediaWrite('UPDATE', { id: 'm1', entity_type: 'job', entity_id: 'j2' }), null);
  // moving onto a non-job entity, or half a link, fails closed
  assert.notEqual(validateMediaWrite('UPDATE', { id: 'm1', entity_type: 'item', entity_id: 'i1' }), null);
  assert.notEqual(validateMediaWrite('UPDATE', { id: 'm1', entity_type: 'job' }), null);
  assert.notEqual(validateMediaWrite('UPDATE', { id: 'm1', entity_id: 'j2' }), null);
});
