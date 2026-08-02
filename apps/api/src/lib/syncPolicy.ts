// Pure, unit-tested sync write/read policy. The ONLY place client payload keys are
// vetted before they reach generic SQL. Design: default-deny.

type Pg = { query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }> };

// Introspect the real columns of each allowed table once at boot. Any client
// payload key not present here is dropped, so no client string can ever be
// interpolated into SQL as an identifier (kills column-identifier injection).
export async function loadTableColumns(pg: Pg, tables: string[]): Promise<Map<string, Set<string>>> {
  const { rows } = await pg.query(
    `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = ANY($1)`,
    [tables],
  );
  const map = new Map<string, Set<string>>();
  for (const r of rows as { table_name: string; column_name: string }[]) {
    if (!map.has(r.table_name)) map.set(r.table_name, new Set());
    map.get(r.table_name)!.add(r.column_name);
  }
  return map;
}

// Drop any key that is not a real column of `table` (fail closed for unknown table).
export function keepRealColumns(
  table: string,
  payload: Record<string, unknown>,
  realColumns: Map<string, Set<string>>,
): { kept: Record<string, unknown>; dropped: string[] } {
  const cols = realColumns.get(table) ?? new Set<string>();
  const kept: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(payload)) {
    if (cols.has(k)) kept[k] = v;
    else dropped.push(k);
  }
  return { kept, dropped };
}

// Columns a client may NEVER write via generic sync — even though they are real
// columns — because they confer privilege / are credentials / are server-owned.
// Set ONLY through dedicated permissioned paths (REST /users, teams manager
// endpoint) or by the server. Kills mass-assignment on the write-gated tables.
export const SENSITIVE_DENY: Record<string, Set<string>> = {
  users: new Set(['role', 'pin_hash', 'pin_set', 'permission_overrides', 'active', 'expires_at', 'enrollment_code_hash', 'is_test', 'enrollment_code_public']),
  team_members: new Set(['is_manager']),
  // notifications rows are server-authored; a client may ONLY flip read_at (mark
  // read). Every other column is denied so a mark-read UPDATE can't rewrite the
  // title/body/type, re-point created_by, or re-assign ownership. user_id is denied
  // too: without it, a crafted payload can't set user_id=self to slip past the
  // own-row guard — and the notifications UPDATE is additionally SQL-scoped to the
  // caller's own rows in sync.ts (WHERE user_id = caller). (id is the key.)
  notifications: new Set(['user_id', 'type', 'title', 'body', 'data', 'created_by', 'created_at', 'updated_at']),
};

// users columns that are ALWAYS denied via sync regardless of permission — these
// are credentials / auth material, never editable through the generic write path.
// is_test/enrollment_code_public are server-owned demo-account markers: letting
// any caller set them would either sandbox a real account or plant a public
// login code on one.
const USERS_ALWAYS_DENY = new Set(['pin_hash', 'pin_set', 'enrollment_code_hash', 'is_test', 'enrollment_code_public']);

// users columns that require manage_roles_permissions specifically — a caller
// with only manage_users (e.g. an hr_manager editing name/active/expires_at via
// the mobile admin UI's sync outbox) must NOT be able to escalate role or the
// permission matrix.
const USERS_ROLE_GATED = new Set(['role', 'permission_overrides']);

// Roles that confer broad authority. Mirrors PRIVILEGED_ROLES in
// apps/api/src/routes/users.ts, which blocks a manage_users-only caller from
// changing a full_admin/franchise_manager's role via REST PATCH /users/:id.
// The sync outbox is a second write path into the SAME users table (columns
// like active/expires_at are permission-aware but not target-role-aware) —
// without this, a manage_users holder could deactivate or expire a full_admin
// via a crafted outbox entry even though REST already blocks the equivalent.
export const PRIVILEGED_ROLES = new Set(['full_admin', 'franchise_manager']);

// True when writing to a user with this role requires the caller to hold
// manage_roles_permissions (not merely manage_users) — regardless of which
// columns the write actually touches.
export function requiresRolesPermForTarget(targetRole: string | null | undefined): boolean {
  return !!targetRole && PRIVILEGED_ROLES.has(targetRole);
}

// Permission keys a team manager/admin may store in team_members.team_permission_overrides
// — SAFE (operational) perms only. MUST mirror apps/mobile/src/db/queries/teams.ts
// TEAM_OVERRIDABLE_PERMISSIONS exactly. Deliberately EXCLUDES account/system-wide
// administrative permissions (manage_teams, manage_users, manage_roles_permissions,
// set_pins, system_settings, view_all_logs) — those stay role/user-level only, never
// team-scoped, so a manage_teams holder can't use this column to mint admin authority
// for themselves or anyone else. This is the server-side enforcement of what was
// previously only an advisory UI-side limit. manage_other_team_inventory (#162) is
// likewise deliberately absent: it grants CROSS-team authority, so a team manager
// must not be able to mint it per-team.
export const TEAM_OVERRIDABLE_PERMISSIONS: Set<string> = new Set([
  'checkout_inventory', 'checkin_inventory', 'add_inventory', 'quick_add',
  'edit_inventory', 'delete_inventory', 'transfer_between_locations',
  'create_jobs', 'close_jobs', 'manage_locations', 'upload_media',
  // edit_media yes, delete_media deliberately NO: deletion is destructive and
  // its GRANT is full-admin-only (the delete_inventory pattern in routes/sync.ts),
  // so it must not be mintable per-team by a manager either.
  'edit_media',
  'view_team_activity', 'checkout_for_team', 'view_financial_data',
]);

// Filter a client-supplied team_permission_overrides map down to keys that are
// BOTH on the safe allowlist AND personally held by the caller (`can`) — a
// manage_teams holder can only grant a team member permissions they themselves
// have (can't escalate beyond their own authority). Values are coerced to
// boolean so a non-boolean payload value can't smuggle anything odd into JSONB.
// Accepts either a parsed object or a JSON string (mobile stores this column as
// TEXT and sends it pre-stringified through the sync outbox).
export function sanitizeTeamOverrides(
  overrides: unknown,
  can: (perm: string) => boolean,
): { clean: Record<string, boolean>; rejected: string[] } {
  const clean: Record<string, boolean> = {};
  const rejected: string[] = [];
  let obj: Record<string, unknown>;
  if (typeof overrides === 'string') {
    try {
      obj = JSON.parse(overrides);
    } catch {
      return { clean, rejected: ['<invalid JSON>'] };
    }
  } else if (overrides && typeof overrides === 'object' && !Array.isArray(overrides)) {
    obj = overrides as Record<string, unknown>;
  } else {
    return { clean, rejected: [] };
  }
  for (const [k, v] of Object.entries(obj)) {
    if (!TEAM_OVERRIDABLE_PERMISSIONS.has(k) || !can(k)) {
      rejected.push(k);
      continue;
    }
    clean[k] = !!v;
  }
  return { clean, rejected };
}

// Attribution columns: forced to the caller on INSERT (can't claim another creator)
// and dropped on UPDATE (creator can't be reassigned). NOTE: locations.owner_user_id
// is intentionally NOT here — it's a deliberate assignment, not "who created it".
export const ATTRIBUTION_COLUMNS: Record<string, string[]> = {
  jobs: ['created_by'], repairs: ['created_by'], repair_parts: ['created_by'],
  repair_steps: ['created_by'],
  media: ['uploaded_by'], team_members: ['added_by'],
  // requester_id is forced to the caller on INSERT (can't file a request as
  // someone else) and can't be reassigned on UPDATE.
  approval_requests: ['requester_id'],
  // Chat attribution: a client can't forge who created a conversation or who sent
  // a message — both are stamped to the authenticated caller on INSERT.
  conversations: ['created_by'],
  messages: ['sender_id'],
  // user_prefs is keyed ON its attribution column: forcing user_id to the caller
  // means the upsert (ON CONFLICT user_id) can only ever land on the caller's own
  // row — self-write enforced structurally, no dedicated guard needed.
  user_prefs: ['user_id'],
  // Field-crew (#122): who granted locker access / who holds a vehicle session /
  // who logged the service / who assigned the on-call week is always the
  // authenticated caller on INSERT and never reassignable on UPDATE. For
  // vehicle_checkouts this doubles as a guard: the close-only takeover UPDATE
  // (routes/sync.ts) cannot steal the row because user_id is dropped here.
  locker_access: ['granted_by'],
  unit_access: ['granted_by'],
  vehicle_checkouts: ['user_id'],
  vehicle_service_records: ['created_by'],
  on_call_shifts: ['created_by'],
  on_call_coverage: ['created_by'],
  // Job assignments (#160): who assigned the crew/user is always the
  // authenticated caller on INSERT and never reassignable on UPDATE.
  job_assignments: ['assigned_by'],
  // Schedule board (#184): who built the day's slot is always the authenticated
  // caller on INSERT and never reassignable on UPDATE.
  schedule_assignments: ['created_by'],
};

export function applyWritePolicy(
  table: string,
  op: 'INSERT' | 'UPDATE',
  payload: Record<string, unknown>,
  callerUserId: string,
  realColumns: Map<string, Set<string>>,
  can: (perm: string) => boolean,
): { row: Record<string, unknown>; rejected: string[] } {
  const { kept } = keepRealColumns(table, payload, realColumns);
  let deny = SENSITIVE_DENY[table];
  // `users` writes are permission-aware: credential columns are always denied,
  // but role/permission_overrides are only denied when the caller lacks
  // manage_roles_permissions (the `users` table itself is already gated on
  // manage_users at the push-handler level, so name/active/expires_at/
  // pin_length_required are allowed through here).
  if (table === 'users') {
    deny = can('manage_roles_permissions')
      ? USERS_ALWAYS_DENY
      : new Set([...USERS_ALWAYS_DENY, ...USERS_ROLE_GATED]);
  }
  const rejected: string[] = [];
  const row: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(kept)) {
    if (deny && deny.has(k)) { rejected.push(k); continue; }
    // team_permission_overrides is a normal (non-SENSITIVE_DENY) column reachable
    // through the generic sync outbox — a manage_teams holder could otherwise
    // stuff admin permission keys into its JSON directly, bypassing the gated
    // PATCH /teams/:id/members/:uid endpoint's allowlist entirely. Sanitize the
    // JSON's keys here too (value-aware, not just a column-name check); drop only
    // the disallowed inner keys rather than rejecting the whole entry so a
    // legitimate mixed payload still applies its safe keys.
    if (table === 'team_members' && k === 'team_permission_overrides') {
      const { clean } = sanitizeTeamOverrides(v, can);
      row[k] = clean;
      continue;
    }
    row[k] = v;
  }
  for (const c of ATTRIBUTION_COLUMNS[table] ?? []) {
    if (op === 'INSERT') row[c] = callerUserId;
    else delete row[c];
  }
  return { row, rejected };
}

type Op = 'INSERT' | 'UPDATE' | 'DELETE';

// Operational-table op -> required permission. Privileged tables are intentionally
// ABSENT (gated by PRIVILEGED_TABLE_PERM in the push handler) and resolve to null.
// activity_log / stock_by_location have their own handling and resolve to null.
// A `null` value means the op is allowed to any authenticated user (no specific
// permission required) — distinct from an ABSENT op, which fails closed to DENY.
// Entities media may attach to. Deliberately excludes users/teams/role_settings/
// app_config (a fixed IDOR sink — see routes/media.ts, which imports this).
// 'message' (#29-H chat attachments) is additionally participant-gated: writes
// in routes/media.ts, pulls via mediaScopeSql in routes/sync.ts.
export const MEDIA_ENTITY_TYPES = new Set(['item', 'equipment_unit', 'job', 'location', 'repair', 'activity_log', 'message', 'pool', 'service_record']);
// #87/#148: pool-share audiences. TEXT values, validated on INSERT, immutable after.
export const AUDIENCE_VALUES = new Set(['team', 'everyone', 'users']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Server-issued object key shape: entity_type/entity_id/uuid.ext — anchors any
// media URL/delete to a key WE generated in /upload-url, never a client path.
// Lives here (not lib/mediaCleanup.ts, which re-exports it) so this pure policy
// module can validate url/thumbnail_url without importing the S3 stack — s3.ts
// fails closed at import time when MinIO credentials are absent.
export const KEY_RE = /^[a-z_]+\/[a-zA-Z0-9_-]{1,64}\/[0-9a-f-]{36}\.[a-z0-9]{2,5}$/;

// A stored media URL must be exactly `${base}/${key}` — the same construction
// POST /media performs (routes/media.ts) — where base is the server's own
// PUBLIC_MEDIA_URL and key is a server-issued object key anchored under THIS
// row's entity_type/entity_id. Anything else is the SSRF/DB-pollution sink the
// REST path already closed: a client-chosen url is stored verbatim and later
// served as this entity's media. Returns an error string or null when OK.
function validateMediaUrlField(
  field: 'url' | 'thumbnail_url',
  value: unknown,
  entityType: string,
  entityId: string,
): string | null {
  if (typeof value !== 'string' || value === '') return `media ${field} must be a non-empty string`;
  const base = process.env.PUBLIC_MEDIA_URL ?? 'https://localhost/media';
  if (!value.startsWith(`${base}/`)) return `media ${field} must be under the server media URL`;
  const key = value.slice(base.length + 1);
  // KEY_RE is fully anchored, so query strings, fragments, extra path segments
  // and `..` traversal in <rest> all fail the shape check.
  if (!KEY_RE.test(key)) return `media ${field} key is not a server-issued object key`;
  if (!key.startsWith(`${entityType}/${entityId}/`)) return `media ${field} does not match its entity`;
  return null;
}

// Validate a media sync write's entity linkage AND url/thumbnail_url. Pure
// (no DB) so it unit-tests; the target-job EXISTENCE check lives in the push
// handler where pg is.
//  - INSERT must land on an allowlisted entity type (previously only the REST
//    upload path enforced this; the sync path let any entity_type through),
//    and url (plus thumbnail_url when present) must be the server-constructed
//    `${PUBLIC_MEDIA_URL}/${entity_type}/${entity_id}/${uuid}.${ext}` shape —
//    exactly what MediaGallery sends (it stores the publicUrl the server
//    returned from /upload-url).
//  - UPDATE may re-link (the "move" feature) ONLY to a job: moving media onto
//    users/teams/etc. via a crafted payload stays impossible, and moving
//    between non-job entities has no UI or use case — fail closed. url /
//    thumbnail_url changes are rejected outright: the app never updates them
//    (it only edits caption/location_note and relinks entity to job — see
//    apps/mobile/src/db/queries/media.ts), and a moved row deliberately keeps
//    its ORIGINAL upload-prefix url, so there is no legitimate url UPDATE.
// Returns an error string (becomes the sync conflict message) or null when OK.
export function validateMediaWrite(
  op: 'INSERT' | 'UPDATE',
  payload: Record<string, unknown>,
): string | null {
  if (op === 'INSERT') {
    const entityType = String(payload.entity_type);
    if (!MEDIA_ENTITY_TYPES.has(entityType)) return 'media entity_type not allowed';
    if (payload.entity_id == null) return 'media entity_id is required';
    const entityId = String(payload.entity_id);
    const urlErr = validateMediaUrlField('url', payload.url, entityType, entityId);
    if (urlErr) return urlErr;
    if (payload.thumbnail_url != null) {
      const thumbErr = validateMediaUrlField('thumbnail_url', payload.thumbnail_url, entityType, entityId);
      if (thumbErr) return thumbErr;
    }
    const isPool = entityType === 'pool';
    const audience = payload.audience == null ? null : String(payload.audience);
    if (isPool) {
      if (audience == null || !AUDIENCE_VALUES.has(audience)) return 'media audience not allowed';
      if (audience === 'users') {
        let ids: unknown;
        try { ids = JSON.parse(String(payload.audience_user_ids)); } catch { ids = null; }
        if (!Array.isArray(ids) || ids.length === 0 || ids.length > 50
          || !ids.every(v => typeof v === 'string' && UUID_RE.test(v))) {
          return 'media audience_user_ids must be a JSON array of user UUIDs';
        }
        // #169: UUID_RE accepts uppercase but mediaScopeSql's LIKE match is
        // case-sensitive (PG renders uuids lowercase) — normalize so a forged
        // uppercase entry can't hide a recipient from the pull scope.
        payload.audience_user_ids = JSON.stringify((ids as string[]).map(s => s.toLowerCase()));
      }
    } else if (audience != null || payload.audience_user_ids != null) {
      return 'media audience only applies to pool photos';
    }
    return null;
  }
  if ('url' in payload || 'thumbnail_url' in payload) {
    return 'media url/thumbnail_url cannot be changed via sync';
  }
  if ('audience' in payload || 'audience_user_ids' in payload) {
    return 'media audience cannot be changed via sync';
  }
  const touchesLink = payload.entity_type !== undefined || payload.entity_id !== undefined;
  if (!touchesLink) return null;
  if (String(payload.entity_type) !== 'job' || payload.entity_id == null) {
    return 'media can only be moved to a job';
  }
  // #169: a pool row re-linked to a job must not strand its audience columns
  // (audience only applies to pool photos). The guard above already rejected
  // client-supplied audience fields on UPDATE, so these keys are server-set
  // here and cleared together with the move.
  payload.audience = null;
  payload.audience_user_ids = null;
  return null;
}

const OPERATION_PERM: Record<string, Partial<Record<Op, string | null>>> = {
  inventory_items: { INSERT: 'add_inventory', UPDATE: 'edit_inventory', DELETE: 'delete_inventory' },
  equipment_units: { INSERT: 'add_inventory', UPDATE: 'edit_inventory', DELETE: 'delete_inventory' },
  locations:       { INSERT: 'manage_locations', UPDATE: 'manage_locations', DELETE: 'manage_locations' },
  jobs:            { INSERT: 'create_jobs', UPDATE: 'create_jobs', DELETE: 'close_jobs' },
  repairs:         { INSERT: 'add_inventory', UPDATE: 'edit_inventory', DELETE: 'edit_inventory' },
  repair_parts:    { INSERT: 'edit_inventory', UPDATE: 'edit_inventory', DELETE: 'edit_inventory' },
  // repair_steps (#178 v1): an immutable troubleshooting log — any entry once
  // written stays forever, so only INSERT is mapped; UPDATE/DELETE are
  // deliberately ABSENT (requiredOperationPerm fails an absent op closed to
  // 'DENY' on an operational table, same idiom as vehicle_checkouts DELETE).
  repair_steps:    { INSERT: 'edit_inventory' },
  maintenance_events: { INSERT: 'edit_inventory', UPDATE: 'edit_inventory', DELETE: 'edit_inventory' },
  taxonomy_types:  { INSERT: 'add_inventory', UPDATE: 'edit_inventory', DELETE: 'edit_inventory' },
  // media is a real family: uploading, editing details (caption/location-note/
  // move), and deleting are separately grantable. delete_media's GRANT is
  // additionally restricted to full_admin in routes/sync.ts.
  media:           { INSERT: 'upload_media', UPDATE: 'edit_media', DELETE: 'delete_media' },
  stock_by_location: { INSERT: 'checkin_inventory', UPDATE: 'edit_inventory', DELETE: 'edit_inventory' },
  // notifications: clients may only mark-read (UPDATE); INSERT/DELETE fail closed.
  notifications:   { UPDATE: null },
  // approval_requests: any authed user may file (INSERT) or update a request;
  // DELETE is explicitly denied (requests are resolved, never removed).
  approval_requests: { INSERT: null, UPDATE: null, DELETE: 'DENY' },
  // label_templates: org-shared label layouts — only admins (system_settings) may
  // create/edit/delete; every synced device reads them to print.
  label_templates: { INSERT: 'system_settings', UPDATE: 'system_settings', DELETE: 'system_settings' },
  // dashboard_presets: org-shared dashboard layouts — only admins (system_settings)
  // may create/edit/delete; every synced device reads them to render its hub.
  dashboard_presets: { INSERT: 'system_settings', UPDATE: 'system_settings', DELETE: 'system_settings' },
  // chat: available to every authenticated user (no special perm), so each op maps
  // to null (allowed to any authed caller). Message writes are ADDITIONALLY gated on
  // conversation membership in the push handler (a caller may only post to a
  // conversation they participate in); pull is scoped so a device can only ever see
  // conversations it belongs to. Participant DELETE = leave/remove; conversation
  // DELETE is intentionally absent (fails closed — conversations aren't torn down
  // via sync). messages carry no financial columns.
  conversations:             { INSERT: null, UPDATE: null },
  conversation_participants: { INSERT: null, UPDATE: null, DELETE: null },
  messages:                  { INSERT: null, UPDATE: null },
  // user_prefs: any authed user may set their own prefs (attribution pins the
  // row to the caller). Clients only ever INSERT (upsert on user_id); UPDATE/
  // DELETE are absent → fail closed.
  user_prefs:                { INSERT: null },
  // Field-crew (#122). vehicles state (water/truck-mount toggles) is a crew-level
  // action — no perm; the row is only ever an extension of an existing Vehicle
  // location. DELETE absent → fail closed (a vehicle row is never torn down via
  // sync). Service records are maintenance data → edit_inventory (the
  // maintenance_events precedent). Checkout sessions ride checkout_inventory;
  // DELETE absent → sessions close (checked_in_at), never vanish. locker_access
  // is all-null here because the REAL gate is the per-row owner-or-org-authority
  // guard in routes/sync.ts. on_call_shifts is roster shaping → manage_teams.
  vehicles:                  { INSERT: null, UPDATE: null },
  vehicle_service_records:   { INSERT: 'edit_inventory', UPDATE: 'edit_inventory', DELETE: 'edit_inventory' },
  vehicle_checkouts:         { INSERT: 'checkout_inventory', UPDATE: 'checkout_inventory' },
  locker_access:             { INSERT: null, UPDATE: null, DELETE: null },
  // unit_access (#122 Phase A1): all-null like locker_access — the real gate is
  // the per-row owner-or-org-authority guard in routes/sync.ts.
  unit_access:               { INSERT: null, UPDATE: null, DELETE: null },
  on_call_shifts:            { INSERT: 'manage_teams', UPDATE: 'manage_teams', DELETE: 'manage_teams' },
  // Coverage rows change who is effectively on call → same roster gate.
  on_call_coverage:          { INSERT: 'manage_teams', UPDATE: 'manage_teams', DELETE: 'manage_teams' },
  // Job assignments (#160): writes ride the same gate as the jobs table's
  // INSERT/UPDATE (create_jobs — see `jobs` above). Unassign is a soft-delete
  // (UPDATE active = FALSE); DELETE is deliberately absent → fails closed
  // (assignment rows are history, never torn down via sync).
  job_assignments:           { INSERT: 'create_jobs', UPDATE: 'create_jobs' },
  // Employee day schedule board (#184): building/editing a slot requires
  // manage_schedule. Clearing is a soft-delete (UPDATE active = FALSE); DELETE
  // is deliberately absent → fails closed (assignment rows are history, never
  // torn down via sync — job_assignments precedent).
  schedule_assignments:      { INSERT: 'manage_schedule', UPDATE: 'manage_schedule' },
};

// Tables handled entirely by dedicated logic / gated separately → no op-perm here.
// subteams is PRIVILEGED_TABLE_PERM-gated (manage_teams) plus a per-row
// resolveTeamAuthority guard in routes/sync.ts, like teams/team_members.
const OPERATION_PERM_EXEMPT = new Set(['activity_log', 'users', 'role_settings', 'app_config', 'teams', 'team_members', 'subteams']);

export function requiredOperationPerm(table: string, op: Op): string | null | 'DENY' {
  if (OPERATION_PERM_EXEMPT.has(table)) return null;
  const mapping = OPERATION_PERM[table];
  // An explicitly-listed op may resolve to null (allowed to any authed user) or
  // 'DENY' (forbidden). Only an ABSENT op on an operational table fails closed.
  if (mapping && op in mapping) return mapping[op] ?? null;
  return 'DENY'; // operational table with no mapping → fail closed
}

// Verified against actual app call sites (grep `action:` in apps/mobile/src,
// apps/mobile/app) as of this change, plus the plan's baseline set — union of
// both so no legitimate in-use action is rejected. Extend here if a new action
// string is introduced client-side.
export const ACTIVITY_ACTIONS = new Set([
  // pin_change is server-only today (#172: POST /me/change-pin writes it
  // directly, no client push) — listed anyway so the allowlist stays truthful
  // if a client ever pushes it.
  'login', 'pin_set', 'pin_change', 'checkout', 'checkin', 'transfer', 'adjust_stock',
  'add_inventory', 'edit_inventory', 'delete_inventory', 'create_job', 'close_job',
  'create_location', 'edit_location', 'role_color_changed', 'role_permission_changed',
  'role_min_pin_changed', 'user_created', 'user_updated', 'team_created', 'team_updated',
  'repair_created', 'repair_updated', 'media_uploaded', 'media_updated', 'media_deleted',
  // observed in apps/mobile call sites:
  'add_stock', 'add_units', 'checkout_to_job', 'consumed', 'item_created', 'item_updated',
  'job_archived', 'job_created', 'job_updated', 'location_archived', 'location_created',
  'location_restored', 'location_updated', 'repair_in', 'repair_opened',
  'team_member_added', 'team_member_removed', 'team_manager_added', 'team_manager_removed',
  'unit_edited', 'unit_retired',
  'user_permission_changed', 'user_pin_reset', 'user_role_changed', 'recount',
  // equipment lifecycle (migration 033): logged on maintenance_events insert.
  'maintenance_event',
  // Settings → form-field show/hide (db/hiddenFields.ts). The only client action
  // still missing from this allowlist — every one was rejected and lost (#56).
  'hidden_field_changed',
  // Field-crew epic (#122): vehicles/lockers/crews/on-call. Logged against the
  // existing entity types ('location' for vehicle/locker actions, 'team' for
  // subteam/on-call) — no new entity types.
  'vehicle_checkout', 'vehicle_checkin', 'vehicle_state_changed', 'vehicle_service_logged',
  'locker_access_granted', 'locker_access_revoked',
  'unit_access_granted', 'unit_access_revoked', 'unit_access_changed',
  'subteam_created', 'subteam_updated', 'on_call_assigned', 'on_call_coverage_added',
  // Job assignments (#160): logged against entity_type 'job' (entity_id = the
  // job's uuid — activity_log.entity_id is a UUID column, so string keys like
  // 'user'/'subteam' go in metadata, never entity_id).
  'job_assigned', 'job_unassigned',
  // Employee day schedule board (#184): logged against entity_type 'user'
  // (entity_id = the EMPLOYEE's uuid — the board is keyed by employee+day, so a
  // future "this employee's schedule history" view resolves consistently for
  // both job- and manager-kind slots). Kind/day/times/job_id/manager_id ride in
  // metadata (activity_log.entity_id is a UUID column, never a free string).
  'schedule_assigned', 'schedule_updated', 'schedule_cleared',
]);
export const ACTIVITY_ENTITY_TYPES = new Set([
  'user', 'item', 'equipment_unit', 'location', 'job', 'team', 'role_settings', 'repair', 'media',
  // db/hiddenFields.ts logs form-field show/hide against the app_config row that
  // stores them. Missing here, every such row was rejected and retried to death (#56).
  'app_config',
]);
export function isAllowedActivity(action: unknown, entityType: unknown): boolean {
  return typeof action === 'string' && ACTIVITY_ACTIONS.has(action)
      && typeof entityType === 'string' && ACTIVITY_ENTITY_TYPES.has(entityType);
}

// Server-defined SELECT lists (never '*', never client-influenced). PII/financial
// columns on jobs are gated behind view_financial_data.
const JOBS_BASE = 'id, name, status, type, type_id, job_number, reference_number, site_location_id, created_by, created_at, updated_at';
const JOBS_SENSITIVE = ', customer_name, site_address, description, insurance_carrier';
// enrollment_code_public is public BY DESIGN, but only for demo rows — the CASE
// guarantees a real user's row can never carry a code even if one were planted.
const USERS_COLS = 'id, name, role, pin_length_required, pin_set, permission_overrides, active, expires_at, created_at, updated_at, email, phone, dashboard_preset_id, is_test, CASE WHEN is_test THEN enrollment_code_public END AS enrollment_code_public';
// Real repairs columns per migrations 021_repairs.sql + 028_repair_fields_parts.sql,
// excluding `cost` (financial data, gated behind view_financial_data — mirrors jobs).
const REPAIRS_BASE = 'id, entity_type, entity_id, entity_label, notes, parts_needed, status, status_id, created_by, created_at, updated_at, completed_at, assignee_id, due_at';
const REPAIRS_SENSITIVE = ', cost';
// equipment_units: purchase_price + salvage_value are financial (gated behind
// view_financial_data — mirrors repairs.cost). Base is every other real column.
const EQUIPMENT_UNITS_BASE = 'id, item_id, asset_tag, serial_number, status, current_location_id, current_job_id, notes, created_at, updated_at, acquired_at, useful_life_months, depreciation_method, next_service_at, service_interval_months';
const EQUIPMENT_UNITS_SENSITIVE = ', purchase_price, salvage_value';
// maintenance_events: cost is financial (gated, mirrors repairs.cost). Base is
// every other synced column.
const MAINTENANCE_EVENTS_BASE = 'id, unit_id, event_date, type, notes, created_by, created_at, updated_at';
const MAINTENANCE_EVENTS_SENSITIVE = ', cost';
// notifications / approval_requests carry no financial columns — return the full
// synced column list explicitly (never '*') so the projection is server-owned.
const NOTIFICATIONS_COLS = 'id, user_id, type, title, body, data, read_at, created_by, created_at, updated_at';
const APPROVAL_REQUESTS_COLS = 'id, requester_id, kind, title, detail, status, decided_by, decided_at, decision_note, entity_type, entity_id, metadata, created_at, updated_at';
// role_settings: full synced column set (explicit, never '*') — carries the new
// dashboard_preset_id assignment (migration 039) alongside the pin/perm/color config.
const ROLE_SETTINGS_COLS = 'role, min_pin_length, permission_overrides, color, dashboard_preset_id, updated_at';
// dashboard_presets: org-shared dashboard layouts. No financial/secret columns —
// every synced device reads the full row to render its hub.
const DASHBOARD_PRESETS_COLS = 'id, name, layout, active, updated_at';
// chat: explicit synced column lists (never '*'). No financial/secret columns —
// pull is scoped to the caller's own conversations in sync.ts.
const CONVERSATIONS_COLS = 'id, kind, title, created_by, created_at, updated_at';
const CONVERSATION_PARTICIPANTS_COLS = 'conversation_id, user_id, notify_pref, last_read_at, added_at, updated_at';
const MESSAGES_COLS = 'id, conversation_id, sender_id, body, urgency, created_at, updated_at, edited_at, deleted_at';
// Field-crew tables (#122): explicit synced column lists (never '*').
// vehicle_service_records.cost is financial (gated behind view_financial_data,
// the maintenance_events pattern); the other five carry no financial columns.
const SUBTEAMS_COLS = 'id, team_id, name, active, created_at, updated_at';
const VEHICLES_COLS = 'location_id, truck_mount, water_state, model, model_id, notes, updated_at, water_tank, waste_tank, checkout_locked, debris_option, debris_level, open_checkout, locked_by, fuel_level';
const VEHICLE_SERVICE_RECORDS_BASE = 'id, vehicle_location_id, target, event_date, type, notes, odometer, created_by, created_at, updated_at, payer, job_id';
const VEHICLE_SERVICE_RECORDS_SENSITIVE = ', cost';
const VEHICLE_CHECKOUTS_COLS = 'id, vehicle_location_id, user_id, job_id, checked_out_at, checked_in_at, created_at, updated_at';
const LOCKER_ACCESS_COLS = 'location_id, user_id, granted_by, created_at, updated_at';
const UNIT_ACCESS_COLS = 'location_id, user_id, can_view, can_add, can_remove, can_move, can_edit_details, can_grant, granted_by, created_at, updated_at';
const ON_CALL_SHIFTS_COLS = 'id, subteam_id, week_start, created_by, created_at, updated_at';
const ON_CALL_COVERAGE_COLS = 'id, date_start, date_end, user_off, covering_user, note, created_by, created_at, updated_at';
// job_assignments (#160): no financial/secret columns — full synced column set.
const JOB_ASSIGNMENTS_COLS = 'id, job_id, assignee_kind, assignee_id, assigned_by, active, created_at, updated_at';
// schedule_assignments (#184): no financial/secret columns — full synced set.
const SCHEDULE_ASSIGNMENTS_COLS = 'id, employee_id, day, start_minute, end_minute, assignment_kind, job_id, manager_id, note, created_by, active, created_at, updated_at';

export function selectColumnsFor(table: string, canViewFinancial: boolean): string {
  if (table === 'users') return USERS_COLS;
  if (table === 'jobs') return canViewFinancial ? JOBS_BASE + JOBS_SENSITIVE : JOBS_BASE;
  if (table === 'repairs') return canViewFinancial ? REPAIRS_BASE + REPAIRS_SENSITIVE : REPAIRS_BASE;
  if (table === 'equipment_units') return canViewFinancial ? EQUIPMENT_UNITS_BASE + EQUIPMENT_UNITS_SENSITIVE : EQUIPMENT_UNITS_BASE;
  if (table === 'maintenance_events') return canViewFinancial ? MAINTENANCE_EVENTS_BASE + MAINTENANCE_EVENTS_SENSITIVE : MAINTENANCE_EVENTS_BASE;
  if (table === 'app_config') return 'key, value, updated_at'; // no secret columns exist today; explicit projection prevents future leakage
  // dashboard_layout/starred_widgets (#193/#196, migration 076): split out of
  // the single dashboard_prefs blob (migration 075) so each field syncs via
  // its own column-scoped upsert instead of a read-merge-write of one JSON
  // column (see mobile db/userPrefs.ts for the clobber this fixes).
  // dashboard_prefs stays in the projection too — the column is dead, never
  // dropped, kept here only so a client's full-row REPLACE on pull can't wipe
  // it as a rollback safety net. Same self-scoped projection as theme.
  if (table === 'user_prefs') return 'user_id, theme, dashboard_prefs, dashboard_layout, starred_widgets, updated_at'; // scoped to the caller in sync.ts; explicit projection regardless
  if (table === 'notifications') return NOTIFICATIONS_COLS;
  if (table === 'approval_requests') return APPROVAL_REQUESTS_COLS;
  if (table === 'role_settings') return ROLE_SETTINGS_COLS;
  if (table === 'dashboard_presets') return DASHBOARD_PRESETS_COLS;
  if (table === 'conversations') return CONVERSATIONS_COLS;
  if (table === 'conversation_participants') return CONVERSATION_PARTICIPANTS_COLS;
  if (table === 'messages') return MESSAGES_COLS;
  if (table === 'subteams') return SUBTEAMS_COLS;
  if (table === 'vehicles') return VEHICLES_COLS;
  if (table === 'vehicle_service_records') return canViewFinancial ? VEHICLE_SERVICE_RECORDS_BASE + VEHICLE_SERVICE_RECORDS_SENSITIVE : VEHICLE_SERVICE_RECORDS_BASE;
  if (table === 'vehicle_checkouts') return VEHICLE_CHECKOUTS_COLS;
  if (table === 'locker_access') return LOCKER_ACCESS_COLS;
  if (table === 'unit_access') return UNIT_ACCESS_COLS;
  if (table === 'on_call_shifts') return ON_CALL_SHIFTS_COLS;
  if (table === 'on_call_coverage') return ON_CALL_COVERAGE_COLS;
  if (table === 'job_assignments') return JOB_ASSIGNMENTS_COLS;
  if (table === 'schedule_assignments') return SCHEDULE_ASSIGNMENTS_COLS;
  return '*';
}
