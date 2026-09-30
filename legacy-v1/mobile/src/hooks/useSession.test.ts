import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveEffectiveUser } from './useSession';
// Type-only: auth/permissions also exports value bindings (hasPermission, etc.)
// that transitively import the native op-sqlite binding via db/queries/users.
// `import type` guarantees this stays erased at runtime so this test needs no
// DB scaffolding — deriveEffectiveUser itself is pure.
import type { UserSession } from '../auth/permissions';

const realUser: UserSession = {
  id: 'u1',
  name: 'Real Admin',
  role: 'full_admin',
  permission_overrides: { manage_users: true },
  pin_length_required: 8,
  active: 1,
  expires_at: null,
  team_contexts: [{ team_id: 't1', team_permission_overrides: { checkout_inventory: false } }],
};

test('deriveEffectiveUser: no previewRole returns the exact real-user reference (default behavior unchanged)', () => {
  const effective = deriveEffectiveUser(realUser, null);
  assert.equal(effective, realUser);
});

test('deriveEffectiveUser: null realUser stays null regardless of previewRole', () => {
  assert.equal(deriveEffectiveUser(null, 'mitigation_technician'), null);
});

test('deriveEffectiveUser: previewRole swaps role and empties permission_overrides/team_contexts, keeps identity', () => {
  const effective = deriveEffectiveUser(realUser, 'mitigation_technician');
  assert.ok(effective);
  // Identity fields pass through untouched — audit/self-by-id logic (activity
  // log attribution, "is this me" checks) is unaffected by a preview.
  assert.equal(effective!.id, realUser.id);
  assert.equal(effective!.name, realUser.name);
  assert.equal(effective!.pin_length_required, realUser.pin_length_required);
  assert.equal(effective!.active, realUser.active);
  // Role + the two override layers specific to the real identity are swapped/cleared.
  assert.equal(effective!.role, 'mitigation_technician');
  assert.deepEqual(effective!.permission_overrides, {});
  assert.deepEqual(effective!.team_contexts, []);
});

test('deriveEffectiveUser: never mutates the real user object', () => {
  deriveEffectiveUser(realUser, 'mitigation_technician');
  assert.equal(realUser.role, 'full_admin');
  assert.deepEqual(realUser.permission_overrides, { manage_users: true });
  assert.equal(realUser.team_contexts!.length, 1);
});

test('deriveEffectiveUser: previewing the SAME role as the real one still clears overrides (not a no-op passthrough)', () => {
  // previewRole is truthy even if it happens to equal the real role — the
  // provider always derives a fresh object in that case rather than special-
  // casing "same role", so behavior stays simple and predictable.
  const effective = deriveEffectiveUser(realUser, 'full_admin');
  assert.notEqual(effective, realUser);
  assert.deepEqual(effective!.permission_overrides, {});
});
