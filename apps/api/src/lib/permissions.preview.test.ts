import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canEditRolePermission,
  previewRolePermissions,
  FULL_ADMIN_ONLY_GRANT,
} from './permissions';

// Pre-flight editability preview (#82). These MUST mirror the server-side
// role_settings write guard in routes/sync.ts so preview and enforcement can't
// drift: (1) tier guard, (2) full_admin self-lockout floor, (3) full_admin-only
// destructive delete grant.

// ── Tier guard (MAY vs MAY NOT edit a given role) ──────────────────────────────

test('canEditRolePermission: caller MAY edit an ordinary perm on a lower-tier role', () => {
  // franchise_manager (tier 4) editing office_manager (tier 3) — normal perm.
  const r = canEditRolePermission('franchise_manager', 'office_manager', 'create_jobs');
  assert.equal(r.editable, true);
  assert.equal(r.reason, null);
});

test('canEditRolePermission: caller MAY edit a peer-tier role', () => {
  const r = canEditRolePermission('office_manager', 'hr_manager', 'manage_users');
  assert.equal(r.editable, true);
});

test('canEditRolePermission: caller MAY NOT edit a role above their tier', () => {
  // office_manager (tier 3) cannot touch franchise_manager (tier 4).
  const r = canEditRolePermission('office_manager', 'franchise_manager', 'create_jobs');
  assert.equal(r.editable, false);
  assert.match(r.reason as string, /at or above your access level/i);
});

test('canEditRolePermission: only full_admin may edit a full_admin (apex)', () => {
  // A tier-4 franchise_manager still cannot edit the apex full_admin role.
  assert.equal(canEditRolePermission('franchise_manager', 'full_admin', 'create_jobs').editable, false);
  assert.equal(canEditRolePermission('full_admin', 'full_admin', 'create_jobs').editable, true);
});

// ── Full_admin self-lockout floor (forced-ON, non-toggleable) ──────────────────

test('canEditRolePermission: full_admin floor perms are non-editable even for a full_admin caller', () => {
  for (const perm of ['manage_roles_permissions', 'system_settings']) {
    const r = canEditRolePermission('full_admin', 'full_admin', perm);
    assert.equal(r.editable, false, `${perm} should be locked ON for full_admin`);
    assert.match(r.reason as string, /required for full admin/i);
  }
});

test('canEditRolePermission: the floor lock is scoped to the full_admin target only', () => {
  // The same perms ARE editable on a non-apex role (subject to the tier guard).
  const r = canEditRolePermission('full_admin', 'hr_manager', 'system_settings');
  assert.equal(r.editable, true);
});

// ── Destructive delete grant (full_admin only) ────────────────────────────────

test('canEditRolePermission: a non-full_admin MAY NOT grant/revoke destructive delete perms', () => {
  for (const perm of FULL_ADMIN_ONLY_GRANT) {
    // franchise_manager is tier 4 → passes the tier guard for a tier-2 role, but
    // is still blocked from the destructive grant.
    const r = canEditRolePermission('franchise_manager', 'production_manager', perm);
    assert.equal(r.editable, false, `${perm} grant should be full_admin-only`);
    assert.match(r.reason as string, /only a full admin/i);
  }
});

test('canEditRolePermission: full_admin MAY grant/revoke destructive delete perms', () => {
  for (const perm of FULL_ADMIN_ONLY_GRANT) {
    assert.equal(canEditRolePermission('full_admin', 'production_manager', perm).editable, true);
  }
});

test('canEditRolePermission: tier guard beats the delete-grant check (order matches server)', () => {
  // A caller who fails the tier guard gets the tier reason, not the delete reason.
  const r = canEditRolePermission('office_manager', 'full_admin', 'delete_inventory');
  assert.equal(r.editable, false);
  assert.match(r.reason as string, /at or above your access level/i);
});

// ── Fail closed on unknown/missing roles ──────────────────────────────────────

test('canEditRolePermission: fails closed on unknown/missing caller or target', () => {
  assert.equal(canEditRolePermission(null, 'construction_crew', 'create_jobs').editable, false);
  assert.equal(canEditRolePermission(undefined, 'construction_crew', 'create_jobs').editable, false);
  assert.equal(canEditRolePermission('office_manager', 'not_a_role', 'create_jobs').editable, false);
});

// ── Aggregate preview ─────────────────────────────────────────────────────────

const SAMPLE_PERMS = ['create_jobs', 'delete_inventory', 'manage_roles_permissions', 'system_settings'];

test('previewRolePermissions: aggregates the whole matrix for an allowed role', () => {
  const p = previewRolePermissions('full_admin', 'office_manager', SAMPLE_PERMS);
  assert.equal(p.role, 'office_manager');
  assert.equal(p.canEditRole, true);
  assert.equal(p.roleReason, null);
  // Every listed permission has an entry; ordinary perms editable for full_admin.
  assert.equal(Object.keys(p.permissions).length, SAMPLE_PERMS.length);
  assert.equal(p.permissions.create_jobs.editable, true);
  assert.equal(p.permissions.delete_inventory.editable, true); // full_admin may grant
  // Floor lock only applies to the full_admin target, so these are editable here.
  assert.equal(p.permissions.manage_roles_permissions.editable, true);
});

test('previewRolePermissions: a blocked role reports canEditRole=false and every cell non-editable', () => {
  const p = previewRolePermissions('office_manager', 'franchise_manager', SAMPLE_PERMS);
  assert.equal(p.canEditRole, false);
  assert.match(p.roleReason as string, /at or above your access level/i);
  for (const perm of SAMPLE_PERMS) {
    assert.equal(p.permissions[perm].editable, false, `${perm} should be non-editable`);
  }
});

test('previewRolePermissions: mixed locks on the full_admin target for a full_admin caller', () => {
  const p = previewRolePermissions('full_admin', 'full_admin', SAMPLE_PERMS);
  assert.equal(p.canEditRole, true);
  assert.equal(p.permissions.create_jobs.editable, true);       // ordinary → editable
  assert.equal(p.permissions.delete_inventory.editable, true);  // full_admin may grant
  assert.equal(p.permissions.manage_roles_permissions.editable, false); // floor lock
  assert.equal(p.permissions.system_settings.editable, false);          // floor lock
});
