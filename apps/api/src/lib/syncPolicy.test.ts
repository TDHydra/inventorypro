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
  MEDIA_ENTITY_TYPES,
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

// #56: an action the client actually emits but the server never allowlisted is an
// audit row rejected, retried to MAX_OUTBOX_ATTEMPTS, and lost. hiddenFields.ts was
// the last such gap. Adding a new appendLog() call site? Add it here too.
test('every action/entity_type the client emits is allowlisted (#56)', () => {
  assert.equal(isAllowedActivity('hidden_field_changed', 'app_config'), true);
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

// #178 v1: repair_steps is an immutable troubleshooting log — INSERT requires
// edit_inventory (matches repairs/repair_parts), but UPDATE/DELETE are
// deliberately absent from OPERATION_PERM so requiredOperationPerm fails them
// closed to 'DENY' (a crafted edit/delete of an existing step must never
// apply, even for a full editor).
test('repair_steps: INSERT requires edit_inventory; UPDATE/DELETE are DENY (immutable log)', () => {
  assert.equal(requiredOperationPerm('repair_steps', 'INSERT'), 'edit_inventory');
  assert.equal(requiredOperationPerm('repair_steps', 'UPDATE'), 'DENY');
  assert.equal(requiredOperationPerm('repair_steps', 'DELETE'), 'DENY');
});

test('repair_steps: created_by is forced to the caller on INSERT (attribution)', () => {
  const realRepairSteps = new Map([['repair_steps', new Set(['id', 'repair_id', 'action', 'result', 'created_by'])]]);
  const { row } = applyWritePolicy(
    'repair_steps', 'INSERT',
    { id: 's1', repair_id: 'r1', action: 'Checked the fuse', created_by: 'someone-else' },
    'caller', realRepairSteps, () => true,
  );
  assert.equal(row.created_by, 'caller');
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

// --- validateMediaWrite -----------------------------------------------------
// The url the app actually sends is the publicUrl the server returned from
// /upload-url: `${PUBLIC_MEDIA_URL}/${entity_type}/${entity_id}/${uuid}.${ext}`
// (apps/mobile/src/components/MediaGallery.tsx). PUBLIC_MEDIA_URL is read at
// call time, so these tests pin it explicitly.
const MEDIA_BASE = 'https://media.example.com/media';
process.env.PUBLIC_MEDIA_URL = MEDIA_BASE;
const MEDIA_UUID = '123e4567-e89b-42d3-a456-426614174000';
const mediaUrlFor = (entityType: string, entityId: string) =>
  `${MEDIA_BASE}/${entityType}/${entityId}/${MEDIA_UUID}.jpg`;

test('validateMediaWrite: INSERT requires an allowlisted entity type', () => {
  assert.equal(validateMediaWrite('INSERT', { entity_type: 'job', entity_id: 'j1', url: mediaUrlFor('job', 'j1') }), null);
  assert.equal(validateMediaWrite('INSERT', { entity_type: 'item', entity_id: 'i1', url: mediaUrlFor('item', 'i1') }), null);
  // users/teams were the original IDOR sink the REST allowlist closed — the
  // sync path must reject them too now.
  assert.notEqual(validateMediaWrite('INSERT', { entity_type: 'users', entity_id: 'u1', url: mediaUrlFor('users', 'u1') }), null);
  assert.notEqual(validateMediaWrite('INSERT', { entity_type: 'role_settings', entity_id: 'r', url: mediaUrlFor('role_settings', 'r') }), null);
  assert.notEqual(validateMediaWrite('INSERT', {}), null);
});

test('validateMediaWrite: INSERT accepts the exact url shape MediaGallery sends', () => {
  // entity_type 'item' with a UUID entity id — the app's real upload payload.
  const entityId = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
  assert.equal(validateMediaWrite('INSERT', {
    id: 'm1', entity_type: 'item', entity_id: entityId, media_type: 'photo',
    url: mediaUrlFor('item', entityId), location_note: 'garage', is_primary: true,
  }), null);
  // thumbnail_url, when present, passes under the same construction; absent/null is fine.
  assert.equal(validateMediaWrite('INSERT', {
    entity_type: 'item', entity_id: entityId,
    url: mediaUrlFor('item', entityId), thumbnail_url: mediaUrlFor('item', entityId),
  }), null);
  assert.equal(validateMediaWrite('INSERT', {
    entity_type: 'item', entity_id: entityId, url: mediaUrlFor('item', entityId), thumbnail_url: null,
  }), null);
});

test('validateMediaWrite: INSERT honors the default base when PUBLIC_MEDIA_URL is unset', () => {
  delete process.env.PUBLIC_MEDIA_URL;
  try {
    const url = `https://localhost/media/item/i1/${MEDIA_UUID}.jpg`;
    assert.equal(validateMediaWrite('INSERT', { entity_type: 'item', entity_id: 'i1', url }), null);
    // the env-based url no longer matches once the env var is gone
    assert.notEqual(validateMediaWrite('INSERT', { entity_type: 'item', entity_id: 'i1', url: mediaUrlFor('item', 'i1') }), null);
  } finally {
    process.env.PUBLIC_MEDIA_URL = MEDIA_BASE;
  }
});

test('validateMediaWrite: INSERT rejects missing or forged urls (SSRF/DB-pollution sink)', () => {
  // url is required — the sync path may not store a row without one it vetted.
  assert.notEqual(validateMediaWrite('INSERT', { entity_type: 'item', entity_id: 'i1' }), null);
  assert.notEqual(validateMediaWrite('INSERT', { entity_type: 'item', entity_id: 'i1', url: null }), null);
  assert.notEqual(validateMediaWrite('INSERT', { entity_type: 'item', entity_id: 'i1', url: '' }), null);
  // external host
  assert.notEqual(validateMediaWrite('INSERT', {
    entity_type: 'item', entity_id: 'i1', url: `https://evil.example.com/item/i1/${MEDIA_UUID}.jpg`,
  }), null);
  // prefix-alias host (base must match exactly up to the '/', not just as a prefix string)
  assert.notEqual(validateMediaWrite('INSERT', {
    entity_type: 'item', entity_id: 'i1', url: `${MEDIA_BASE}.evil.com/item/i1/${MEDIA_UUID}.jpg`,
  }), null);
  // mismatched entity path — url claims another entity's prefix
  assert.notEqual(validateMediaWrite('INSERT', {
    entity_type: 'item', entity_id: 'i1', url: mediaUrlFor('item', 'other-id'),
  }), null);
  assert.notEqual(validateMediaWrite('INSERT', {
    entity_type: 'item', entity_id: 'i1', url: mediaUrlFor('job', 'i1'),
  }), null);
  // path traversal
  assert.notEqual(validateMediaWrite('INSERT', {
    entity_type: 'item', entity_id: 'i1', url: `${MEDIA_BASE}/item/i1/../secrets/${MEDIA_UUID}.jpg`,
  }), null);
  assert.notEqual(validateMediaWrite('INSERT', {
    entity_type: 'item', entity_id: 'i1', url: `${MEDIA_BASE}/../item/i1/${MEDIA_UUID}.jpg`,
  }), null);
  // bad key shape: no uuid.ext, extra segments, trailing query string
  assert.notEqual(validateMediaWrite('INSERT', {
    entity_type: 'item', entity_id: 'i1', url: `${MEDIA_BASE}/item/i1/evil.jpg`,
  }), null);
  assert.notEqual(validateMediaWrite('INSERT', {
    entity_type: 'item', entity_id: 'i1', url: `${MEDIA_BASE}/item/i1/${MEDIA_UUID}.jpg/extra`,
  }), null);
  assert.notEqual(validateMediaWrite('INSERT', {
    entity_type: 'item', entity_id: 'i1', url: `${mediaUrlFor('item', 'i1')}?x=1`,
  }), null);
  // a valid url can't smuggle in a forged thumbnail_url
  assert.notEqual(validateMediaWrite('INSERT', {
    entity_type: 'item', entity_id: 'i1', url: mediaUrlFor('item', 'i1'),
    thumbnail_url: `https://evil.example.com/item/i1/${MEDIA_UUID}.jpg`,
  }), null);
  assert.notEqual(validateMediaWrite('INSERT', {
    entity_type: 'item', entity_id: 'i1', url: mediaUrlFor('item', 'i1'),
    thumbnail_url: mediaUrlFor('item', 'other-id'),
  }), null);
});

test('validateMediaWrite: UPDATE may re-link only to a job; metadata-only edits pass', () => {
  // caption/location_note edit — no linkage touched
  assert.equal(validateMediaWrite('UPDATE', { id: 'm1', caption: 'x', location_note: 'master bedroom' }), null);
  // the move feature (moveMediaToJob also clears is_primary)
  assert.equal(validateMediaWrite('UPDATE', { id: 'm1', entity_type: 'job', entity_id: 'j2' }), null);
  assert.equal(validateMediaWrite('UPDATE', { id: 'm1', entity_type: 'job', entity_id: 'j2', is_primary: false }), null);
  // moving onto a non-job entity, or half a link, fails closed
  assert.notEqual(validateMediaWrite('UPDATE', { id: 'm1', entity_type: 'item', entity_id: 'i1' }), null);
  assert.notEqual(validateMediaWrite('UPDATE', { id: 'm1', entity_type: 'job' }), null);
  assert.notEqual(validateMediaWrite('UPDATE', { id: 'm1', entity_id: 'j2' }), null);
});

test('validateMediaWrite: UPDATE rejects any url/thumbnail_url change', () => {
  // the app never updates urls (only caption/location_note edits and job
  // relinks) — so url changes via sync are forged, even "valid-looking" ones.
  assert.notEqual(validateMediaWrite('UPDATE', { id: 'm1', url: mediaUrlFor('item', 'i1') }), null);
  assert.notEqual(validateMediaWrite('UPDATE', { id: 'm1', url: 'https://evil.example.com/x.jpg' }), null);
  assert.notEqual(validateMediaWrite('UPDATE', { id: 'm1', url: null }), null);
  assert.notEqual(validateMediaWrite('UPDATE', { id: 'm1', thumbnail_url: 'https://evil.example.com/x.jpg' }), null);
  assert.notEqual(validateMediaWrite('UPDATE', { id: 'm1', caption: 'x', thumbnail_url: null }), null);
  assert.notEqual(validateMediaWrite('UPDATE', {
    id: 'm1', entity_type: 'job', entity_id: 'j2', url: mediaUrlFor('job', 'j2'),
  }), null);
});

// ── #87/#148: media pool audience validation ─────────────────────────────────
// url fixtures follow the same server-issued-key convention as every other
// entity type (see mediaUrlFor above) — validateMediaUrlField has no
// per-entity special-casing, so pool just needs `${base}/pool/${entity_id}/${uuid}.ext`.

test('media INSERT: pool requires a valid audience', () => {
  const base = { entity_type: 'pool', entity_id: 'user-1', url: mediaUrlFor('pool', 'user-1') };
  assert.match(validateMediaWrite('INSERT', { ...base }) ?? '', /audience/);
  assert.match(validateMediaWrite('INSERT', { ...base, audience: 'friends' }) ?? '', /audience/);
  assert.equal(validateMediaWrite('INSERT', { ...base, audience: 'team' }), null);
  assert.equal(validateMediaWrite('INSERT', { ...base, audience: 'everyone' }), null);
});

test('media INSERT: audience=users requires a JSON array of UUIDs', () => {
  const base = { entity_type: 'pool', entity_id: 'user-1', url: mediaUrlFor('pool', 'user-1'), audience: 'users' };
  assert.match(validateMediaWrite('INSERT', { ...base }) ?? '', /audience_user_ids/);
  assert.match(validateMediaWrite('INSERT', { ...base, audience_user_ids: '["not-a-uuid"]' }) ?? '', /audience_user_ids/);
  assert.match(validateMediaWrite('INSERT', { ...base, audience_user_ids: '{}' }) ?? '', /audience_user_ids/);
  assert.equal(validateMediaWrite('INSERT', {
    ...base, audience_user_ids: '["6f1e1c2a-9b3d-4e5f-8a7b-0c1d2e3f4a5b"]',
  }), null);
});

test('media INSERT: non-pool photos must not carry an audience', () => {
  assert.match(validateMediaWrite('INSERT', {
    entity_type: 'job', entity_id: 'job-1', url: mediaUrlFor('job', 'job-1'), audience: 'team',
  }) ?? '', /audience/);
});

test('media UPDATE: audience columns are immutable', () => {
  assert.match(validateMediaWrite('UPDATE', { audience: 'everyone' }) ?? '', /audience/);
  assert.match(validateMediaWrite('UPDATE', { audience_user_ids: '[]' }) ?? '', /audience/);
});

// #169: UUID_RE accepts uppercase but mediaScopeSql's LIKE match is
// case-sensitive — validation normalizes the ids to lowercase in place.
test('media INSERT: audience_user_ids are lowercased at validation', () => {
  const payload: Record<string, unknown> = {
    entity_type: 'pool', entity_id: 'user-1', url: mediaUrlFor('pool', 'user-1'),
    audience: 'users', audience_user_ids: '["6F1E1C2A-9B3D-4E5F-8A7B-0C1D2E3F4A5B"]',
  };
  assert.equal(validateMediaWrite('INSERT', payload), null);
  assert.equal(payload.audience_user_ids, '["6f1e1c2a-9b3d-4e5f-8a7b-0c1d2e3f4a5b"]');
});

// #169: a pool→job relink must not strand audience columns on non-pool media —
// the validator clears both server-side alongside the move.
test('media UPDATE: relinking to a job clears the audience columns', () => {
  const payload: Record<string, unknown> = { entity_type: 'job', entity_id: 'job-1' };
  assert.equal(validateMediaWrite('UPDATE', payload), null);
  assert.equal(payload.audience, null);
  assert.ok('audience' in payload && 'audience_user_ids' in payload, 'cleared keys are present so the UPDATE writes NULLs');
  // A non-relink UPDATE (caption edit) must NOT inject audience keys.
  const captionOnly: Record<string, unknown> = { id: 'm1', caption: 'hi' };
  assert.equal(validateMediaWrite('UPDATE', captionOnly), null);
  assert.ok(!('audience' in captionOnly));
});

test("MEDIA_ENTITY_TYPES includes 'pool'", () => {
  assert.ok(MEDIA_ENTITY_TYPES.has('pool'));
});

test('applyWritePolicy always rejects is_test + enrollment_code_public on users, even with manage_roles_permissions', () => {
  const realUsers = new Map([
    ['users', new Set(['id', 'name', 'is_test', 'enrollment_code_public'])],
  ]);
  const { row, rejected } = applyWritePolicy(
    'users',
    'UPDATE',
    { id: 'u1', name: 'ok', is_test: true, enrollment_code_public: '111111' },
    'caller',
    realUsers,
    () => true, // apex caller — these columns are server-owned regardless
  );
  assert.deepEqual(Object.keys(row), ['id', 'name']);
  assert.ok(rejected.includes('is_test'));
  assert.ok(rejected.includes('enrollment_code_public'));
});

// ── Field-crew epic (#122): new-table policy ─────────────────────────────────

test('field-crew op perms: vehicles state is open, DELETE fails closed', () => {
  assert.equal(requiredOperationPerm('vehicles', 'INSERT'), null);
  assert.equal(requiredOperationPerm('vehicles', 'UPDATE'), null);
  assert.equal(requiredOperationPerm('vehicles', 'DELETE'), 'DENY');
});

test('field-crew op perms: service records are maintenance data (edit_inventory)', () => {
  assert.equal(requiredOperationPerm('vehicle_service_records', 'INSERT'), 'edit_inventory');
  assert.equal(requiredOperationPerm('vehicle_service_records', 'UPDATE'), 'edit_inventory');
  assert.equal(requiredOperationPerm('vehicle_service_records', 'DELETE'), 'edit_inventory');
});

test('field-crew op perms: checkout sessions ride checkout_inventory; DELETE fails closed (sessions close, never vanish)', () => {
  assert.equal(requiredOperationPerm('vehicle_checkouts', 'INSERT'), 'checkout_inventory');
  assert.equal(requiredOperationPerm('vehicle_checkouts', 'UPDATE'), 'checkout_inventory');
  assert.equal(requiredOperationPerm('vehicle_checkouts', 'DELETE'), 'DENY');
});

test('field-crew op perms: locker_access is null here (real gate = per-row owner guard in routes/sync.ts)', () => {
  assert.equal(requiredOperationPerm('locker_access', 'INSERT'), null);
  assert.equal(requiredOperationPerm('locker_access', 'UPDATE'), null);
  assert.equal(requiredOperationPerm('locker_access', 'DELETE'), null);
});

test('field-crew op perms: on_call_shifts is roster shaping (manage_teams, all ops)', () => {
  assert.equal(requiredOperationPerm('on_call_shifts', 'INSERT'), 'manage_teams');
  assert.equal(requiredOperationPerm('on_call_shifts', 'UPDATE'), 'manage_teams');
  assert.equal(requiredOperationPerm('on_call_shifts', 'DELETE'), 'manage_teams');
});

test('subteams is op-perm exempt (gated by PRIVILEGED_TABLE_PERM + per-row team authority)', () => {
  assert.equal(requiredOperationPerm('subteams', 'INSERT'), null);
  assert.equal(requiredOperationPerm('subteams', 'DELETE'), null);
});

test('vehicle_checkouts attribution: user_id forced to the caller on INSERT, dropped on UPDATE (takeover cannot steal the row)', () => {
  const realVc = new Map([
    ['vehicle_checkouts', new Set(['id', 'vehicle_location_id', 'user_id', 'job_id', 'checked_out_at', 'checked_in_at', 'updated_at'])],
  ]);
  const ins = applyWritePolicy(
    'vehicle_checkouts', 'INSERT',
    { id: 'vc1', vehicle_location_id: 'loc1', user_id: 'someone-else' },
    'caller', realVc, () => true,
  );
  assert.equal(ins.row.user_id, 'caller');
  const upd = applyWritePolicy(
    'vehicle_checkouts', 'UPDATE',
    { id: 'vc1', checked_in_at: '2026-07-18T00:00:00.000Z', user_id: 'someone-else' },
    'caller', realVc, () => true,
  );
  assert.ok(!('user_id' in upd.row), 'UPDATE must not carry user_id');
});

test('locker_access / service records / on_call attribution forced to the caller on INSERT', () => {
  const realTables = new Map([
    ['locker_access', new Set(['location_id', 'user_id', 'granted_by', 'updated_at'])],
    ['vehicle_service_records', new Set(['id', 'vehicle_location_id', 'type', 'created_by', 'updated_at'])],
    ['on_call_shifts', new Set(['id', 'subteam_id', 'week_start', 'created_by', 'updated_at'])],
  ]);
  const la = applyWritePolicy('locker_access', 'INSERT',
    { location_id: 'l1', user_id: 'grantee', granted_by: 'forged' }, 'caller', realTables, () => true);
  assert.equal(la.row.granted_by, 'caller');
  assert.equal(la.row.user_id, 'grantee', 'the GRANTEE is data, not attribution');
  const sr = applyWritePolicy('vehicle_service_records', 'INSERT',
    { id: 's1', vehicle_location_id: 'l1', type: 'oil', created_by: 'forged' }, 'caller', realTables, () => true);
  assert.equal(sr.row.created_by, 'caller');
  const oc = applyWritePolicy('on_call_shifts', 'INSERT',
    { id: 'o1', subteam_id: 'st1', week_start: '2026-07-20', created_by: 'forged' }, 'caller', realTables, () => true);
  assert.equal(oc.row.created_by, 'caller');
});

test('vehicle_service_records hides cost without view_financial_data, exposes it with (maintenance_events pattern)', () => {
  const restricted = selectColumnsFor('vehicle_service_records', false);
  assert.ok(!/\bcost\b/.test(restricted));
  assert.ok(/vehicle_location_id|target|odometer/.test(restricted));
  const full = selectColumnsFor('vehicle_service_records', true);
  assert.ok(/\bcost\b/.test(full));
});

test('field-crew tables have explicit projections (never *)', () => {
  for (const t of ['subteams', 'vehicles', 'vehicle_checkouts', 'locker_access', 'on_call_shifts']) {
    assert.notEqual(selectColumnsFor(t, false), '*', `${t} must have an explicit projection`);
  }
});

test('field-crew activity actions are allowlisted against existing entity types (#56 rule)', () => {
  for (const a of ['vehicle_checkout', 'vehicle_checkin', 'vehicle_state_changed', 'vehicle_service_logged',
    'locker_access_granted', 'locker_access_revoked']) {
    assert.equal(isAllowedActivity(a, 'location'), true, `${a} on location`);
  }
  for (const a of ['subteam_created', 'subteam_updated', 'on_call_assigned']) {
    assert.equal(isAllowedActivity(a, 'team'), true, `${a} on team`);
  }
  // no new entity types were introduced
  assert.equal(isAllowedActivity('vehicle_checkout', 'vehicle'), false);
});

test('users exposes enrollment_code_public only through the is_test CASE guard', () => {
  const cols = selectColumnsFor('users', true);
  assert.ok(cols.includes('CASE WHEN is_test THEN enrollment_code_public'));
  // never as a bare projection that would leak a value planted on a real row
  assert.ok(!cols.includes(', enrollment_code_public,'));
});

// ── #122 Phase A1: unit_access sync policy + two-tank vehicle columns ────────

test('unit_access: ops open to any authed user (real gate is the per-row owner guard in sync.ts)', () => {
  assert.equal(requiredOperationPerm('unit_access', 'INSERT'), null);
  assert.equal(requiredOperationPerm('unit_access', 'UPDATE'), null);
  assert.equal(requiredOperationPerm('unit_access', 'DELETE'), null);
});

test('unit_access: activity actions ride the allowlist against entity_type location (#122 Phase B)', () => {
  assert.equal(requiredOperationPerm('unit_access', 'DELETE'), null);
  assert.equal(isAllowedActivity('unit_access_changed', 'location'), true);
  assert.equal(isAllowedActivity('unit_access_granted', 'location'), true);
  assert.equal(isAllowedActivity('unit_access_revoked', 'location'), true);
});

test('unit_access: granted_by is attribution-forced to the caller', () => {
  const cols = new Map([['unit_access', new Set(['location_id', 'user_id', 'can_view', 'can_add', 'can_remove', 'can_move', 'can_edit_details', 'can_grant', 'granted_by', 'created_at', 'updated_at'])]]);
  const { row } = applyWritePolicy('unit_access', 'INSERT', { location_id: 'l1', user_id: 'u2', can_view: true, granted_by: 'someone-else' }, 'caller-1', cols, () => true);
  assert.equal(row.granted_by, 'caller-1');
});

test('selectColumnsFor: unit_access + two-tank vehicle columns', () => {
  assert.equal(selectColumnsFor('unit_access', false), 'location_id, user_id, can_view, can_add, can_remove, can_move, can_edit_details, can_grant, granted_by, created_at, updated_at');
  assert.match(selectColumnsFor('vehicles', false), /water_tank, waste_tank/);
});

test('role_settings projection carries dashboard_preset_id (role assignment syncs to all devices)', () => {
  assert.match(selectColumnsFor('role_settings', false), /dashboard_preset_id/);
});

// ── #122 Phase C: on_call_coverage sync policy ───────────────────────────────

test('on_call_coverage: all ops gated on manage_teams', () => {
  assert.equal(requiredOperationPerm('on_call_coverage', 'INSERT'), 'manage_teams');
  assert.equal(requiredOperationPerm('on_call_coverage', 'UPDATE'), 'manage_teams');
  assert.equal(requiredOperationPerm('on_call_coverage', 'DELETE'), 'manage_teams');
});

test('on_call_coverage: created_by is attribution-forced to the caller', () => {
  const realColumns = new Map([[ 'on_call_coverage', new Set(['id','date_start','date_end','user_off','covering_user','note','created_by','created_at','updated_at']) ]]);
  const { row } = applyWritePolicy('on_call_coverage', 'INSERT',
    { id: 'c1', date_start: '2026-07-20', date_end: '2026-07-22', user_off: 'u1', covering_user: 'u2', created_by: 'forged' },
    'caller-1', realColumns, () => true);
  assert.equal(row.created_by, 'caller-1');
});

test('on_call_coverage: explicit pull projection, never *', () => {
  assert.equal(selectColumnsFor('on_call_coverage', false),
    'id, date_start, date_end, user_off, covering_user, note, created_by, created_at, updated_at');
});

test('on_call_coverage_added is an allowed activity against team', () => {
  assert.equal(isAllowedActivity('on_call_coverage_added', 'team'), true);
});

// ── Phase 0 (#152/#155/#167/#168): vehicles wave sync surface ────────────────

test('media INSERT: service_record is an allowed entity type', () => {
  assert.ok(MEDIA_ENTITY_TYPES.has('service_record'));
  const err = validateMediaWrite('INSERT', {
    entity_type: 'service_record',
    entity_id: '9c9e2c1a-0000-4000-8000-000000000001',
    url: mediaUrlFor('service_record', '9c9e2c1a-0000-4000-8000-000000000001'),
  });
  assert.equal(err, null);
});

test('vehicles pull carries the phase-0 option columns', () => {
  const cols = selectColumnsFor('vehicles', false);
  for (const col of ['debris_option', 'debris_level', 'open_checkout', 'locked_by']) {
    assert.ok(cols.includes(col), `VEHICLES_COLS missing ${col}`);
  }
});

test('vehicles pull carries fuel_level (#174)', () => {
  const cols = selectColumnsFor('vehicles', false);
  assert.ok(cols.includes('fuel_level'), 'VEHICLES_COLS missing fuel_level');
});

test('service-record pull carries payer/job_id ungated; cost stays financial-gated', () => {
  const base = selectColumnsFor('vehicle_service_records', false);
  assert.ok(base.includes('payer'), 'BASE missing payer');
  assert.ok(base.includes('job_id'), 'BASE missing job_id');
  assert.ok(!base.includes('cost'), 'cost must stay financial-gated, not in BASE');
  assert.ok(selectColumnsFor('vehicle_service_records', true).includes('cost'));
});
