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
};

// users columns that are ALWAYS denied via sync regardless of permission — these
// are credentials / auth material, never editable through the generic write path.
const USERS_ALWAYS_DENY = new Set(['pin_hash', 'pin_set', 'enrollment_code_hash']);

// users columns that require manage_roles_permissions specifically — a caller
// with only manage_users (e.g. an hr_manager editing name/active/expires_at via
// the mobile admin UI's sync outbox) must NOT be able to escalate role or the
// permission matrix.
const USERS_ROLE_GATED = new Set(['role', 'permission_overrides']);

// Attribution columns: forced to the caller on INSERT (can't claim another creator)
// and dropped on UPDATE (creator can't be reassigned). NOTE: locations.owner_user_id
// is intentionally NOT here — it's a deliberate assignment, not "who created it".
export const ATTRIBUTION_COLUMNS: Record<string, string[]> = {
  jobs: ['created_by'], repairs: ['created_by'], media: ['uploaded_by'], team_members: ['added_by'],
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
const OPERATION_PERM: Record<string, Partial<Record<Op, string>>> = {
  inventory_items: { INSERT: 'add_inventory', UPDATE: 'edit_inventory', DELETE: 'delete_inventory' },
  equipment_units: { INSERT: 'add_inventory', UPDATE: 'edit_inventory', DELETE: 'delete_inventory' },
  locations:       { INSERT: 'manage_locations', UPDATE: 'manage_locations', DELETE: 'manage_locations' },
  jobs:            { INSERT: 'create_jobs', UPDATE: 'create_jobs', DELETE: 'close_jobs' },
  repairs:         { INSERT: 'add_inventory', UPDATE: 'edit_inventory', DELETE: 'edit_inventory' },
  taxonomy_types:  { INSERT: 'add_inventory', UPDATE: 'edit_inventory', DELETE: 'edit_inventory' },
  media:           { INSERT: 'upload_media', UPDATE: 'upload_media', DELETE: 'upload_media' },
  stock_by_location: { INSERT: 'checkin_inventory', UPDATE: 'edit_inventory', DELETE: 'edit_inventory' },
};

// Tables handled entirely by dedicated logic / gated separately → no op-perm here.
const OPERATION_PERM_EXEMPT = new Set(['activity_log', 'users', 'role_settings', 'app_config', 'teams', 'team_members']);

export function requiredOperationPerm(table: string, op: Op): string | null | 'DENY' {
  if (OPERATION_PERM_EXEMPT.has(table)) return null;
  const perm = OPERATION_PERM[table]?.[op];
  return perm ?? 'DENY'; // operational table with no mapping → fail closed
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
  'team_member_added', 'team_member_removed', 'unit_edited', 'unit_retired',
  'user_permission_changed', 'user_pin_reset', 'user_role_changed',
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
const JOBS_BASE = 'id, name, status, type, job_number, reference_number, site_location_id, created_by, created_at, updated_at';
const JOBS_SENSITIVE = ', customer_name, site_address, description, insurance_carrier';
const USERS_COLS = 'id, name, role, pin_length_required, pin_set, permission_overrides, active, expires_at, created_at, updated_at';

export function selectColumnsFor(table: string, canViewFinancial: boolean): string {
  if (table === 'users') return USERS_COLS;
  if (table === 'jobs') return canViewFinancial ? JOBS_BASE + JOBS_SENSITIVE : JOBS_BASE;
  if (table === 'app_config') return 'key, value, updated_at'; // no secret columns exist today; explicit projection prevents future leakage
  return '*';
}
