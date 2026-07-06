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
  users: new Set(['role', 'pin_hash', 'pin_set', 'permission_overrides', 'active', 'expires_at', 'enrollment_code_hash']),
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
const USERS_ALWAYS_DENY = new Set(['pin_hash', 'pin_set', 'enrollment_code_hash']);

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
// previously only an advisory UI-side limit.
export const TEAM_OVERRIDABLE_PERMISSIONS: Set<string> = new Set([
  'checkout_inventory', 'checkin_inventory', 'add_inventory', 'quick_add',
  'edit_inventory', 'delete_inventory', 'transfer_between_locations',
  'create_jobs', 'close_jobs', 'manage_locations', 'upload_media',
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
  media: ['uploaded_by'], team_members: ['added_by'],
  // requester_id is forced to the caller on INSERT (can't file a request as
  // someone else) and can't be reassigned on UPDATE.
  approval_requests: ['requester_id'],
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
const OPERATION_PERM: Record<string, Partial<Record<Op, string | null>>> = {
  inventory_items: { INSERT: 'add_inventory', UPDATE: 'edit_inventory', DELETE: 'delete_inventory' },
  equipment_units: { INSERT: 'add_inventory', UPDATE: 'edit_inventory', DELETE: 'delete_inventory' },
  locations:       { INSERT: 'manage_locations', UPDATE: 'manage_locations', DELETE: 'manage_locations' },
  jobs:            { INSERT: 'create_jobs', UPDATE: 'create_jobs', DELETE: 'close_jobs' },
  repairs:         { INSERT: 'add_inventory', UPDATE: 'edit_inventory', DELETE: 'edit_inventory' },
  repair_parts:    { INSERT: 'edit_inventory', UPDATE: 'edit_inventory', DELETE: 'edit_inventory' },
  maintenance_events: { INSERT: 'edit_inventory', UPDATE: 'edit_inventory', DELETE: 'edit_inventory' },
  taxonomy_types:  { INSERT: 'add_inventory', UPDATE: 'edit_inventory', DELETE: 'edit_inventory' },
  media:           { INSERT: 'upload_media', UPDATE: 'upload_media', DELETE: 'upload_media' },
  stock_by_location: { INSERT: 'checkin_inventory', UPDATE: 'edit_inventory', DELETE: 'edit_inventory' },
  // notifications: clients may only mark-read (UPDATE); INSERT/DELETE fail closed.
  notifications:   { UPDATE: null },
  // approval_requests: any authed user may file (INSERT) or update a request;
  // DELETE is explicitly denied (requests are resolved, never removed).
  approval_requests: { INSERT: null, UPDATE: null, DELETE: 'DENY' },
  // label_templates: org-shared label layouts — only admins (system_settings) may
  // create/edit/delete; every synced device reads them to print.
  label_templates: { INSERT: 'system_settings', UPDATE: 'system_settings', DELETE: 'system_settings' },
};

// Tables handled entirely by dedicated logic / gated separately → no op-perm here.
const OPERATION_PERM_EXEMPT = new Set(['activity_log', 'users', 'role_settings', 'app_config', 'teams', 'team_members']);

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
  'login', 'pin_set', 'checkout', 'checkin', 'transfer', 'adjust_stock',
  'add_inventory', 'edit_inventory', 'delete_inventory', 'create_job', 'close_job',
  'create_location', 'edit_location', 'role_color_changed', 'role_permission_changed',
  'role_min_pin_changed', 'user_created', 'user_updated', 'team_created', 'team_updated',
  'repair_created', 'repair_updated', 'media_uploaded',
  // observed in apps/mobile call sites:
  'add_stock', 'add_units', 'checkout_to_job', 'consumed', 'item_created', 'item_updated',
  'job_archived', 'job_created', 'job_updated', 'location_archived', 'location_created',
  'location_restored', 'location_updated', 'repair_in', 'repair_opened',
  'team_member_added', 'team_member_removed', 'team_manager_added', 'team_manager_removed',
  'unit_edited', 'unit_retired',
  'user_permission_changed', 'user_pin_reset', 'user_role_changed', 'recount',
  // equipment lifecycle (migration 033): logged on maintenance_events insert.
  'maintenance_event',
]);
export const ACTIVITY_ENTITY_TYPES = new Set([
  'user', 'item', 'equipment_unit', 'location', 'job', 'team', 'role_settings', 'repair', 'media',
]);
export function isAllowedActivity(action: unknown, entityType: unknown): boolean {
  return typeof action === 'string' && ACTIVITY_ACTIONS.has(action)
      && typeof entityType === 'string' && ACTIVITY_ENTITY_TYPES.has(entityType);
}

// Server-defined SELECT lists (never '*', never client-influenced). PII/financial
// columns on jobs are gated behind view_financial_data.
const JOBS_BASE = 'id, name, status, type, type_id, job_number, reference_number, site_location_id, created_by, created_at, updated_at';
const JOBS_SENSITIVE = ', customer_name, site_address, description, insurance_carrier';
const USERS_COLS = 'id, name, role, pin_length_required, pin_set, permission_overrides, active, expires_at, created_at, updated_at, email';
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

export function selectColumnsFor(table: string, canViewFinancial: boolean): string {
  if (table === 'users') return USERS_COLS;
  if (table === 'jobs') return canViewFinancial ? JOBS_BASE + JOBS_SENSITIVE : JOBS_BASE;
  if (table === 'repairs') return canViewFinancial ? REPAIRS_BASE + REPAIRS_SENSITIVE : REPAIRS_BASE;
  if (table === 'equipment_units') return canViewFinancial ? EQUIPMENT_UNITS_BASE + EQUIPMENT_UNITS_SENSITIVE : EQUIPMENT_UNITS_BASE;
  if (table === 'maintenance_events') return canViewFinancial ? MAINTENANCE_EVENTS_BASE + MAINTENANCE_EVENTS_SENSITIVE : MAINTENANCE_EVENTS_BASE;
  if (table === 'app_config') return 'key, value, updated_at'; // no secret columns exist today; explicit projection prevents future leakage
  if (table === 'notifications') return NOTIFICATIONS_COLS;
  if (table === 'approval_requests') return APPROVAL_REQUESTS_COLS;
  return '*';
}
