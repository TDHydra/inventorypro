import { getDb } from '../db/schema';
import { getValidJwt } from '../auth/session';
import { bumpTablesVersion } from './dataVersion';

const API_BASE = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';

const TABLE_UPSERT_SQL: Record<string, string> = {
  role_settings: `INSERT OR REPLACE INTO role_settings (role, min_pin_length, permission_overrides, color, updated_at, dashboard_preset_id) VALUES (?, ?, ?, ?, ?, ?)`,
  users: `INSERT OR REPLACE INTO users (id, name, role, pin_length_required, pin_set, permission_overrides, active, expires_at, created_at, updated_at, email, dashboard_preset_id, is_test, enrollment_code_public, phone) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  locations: `INSERT OR REPLACE INTO locations (id, name, parent_id, color, icon, owner_user_id, active, updated_at, latitude, longitude, subareas_require_owner, type, has_shelves, type_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  inventory_items: `INSERT OR REPLACE INTO inventory_items (id, name, barcode, description, sku, supplier, model, kind, category, returnable, unit_tracked, tag_prefix, unit_category, unit, min_qty_alert, reorder_to, active, updated_at, home_location_id, pack_size, category_id, type, type_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  equipment_units: `INSERT OR REPLACE INTO equipment_units (id, item_id, asset_tag, serial_number, status, current_location_id, current_job_id, notes, created_at, updated_at, purchase_price, acquired_at, useful_life_months, salvage_value, depreciation_method, next_service_at, service_interval_months) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  stock_by_location: `INSERT OR REPLACE INTO stock_by_location (item_id, location_id, quantity, updated_at) VALUES (?,?,?,?)`,
  jobs: `INSERT OR REPLACE INTO jobs (id, name, status, created_by, created_at, updated_at, job_number, customer_name, site_address, site_location_id, description, type, reference_number, insurance_carrier, type_id, team_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  teams: `INSERT OR REPLACE INTO teams (id, name, type, updated_at, type_id) VALUES (?,?,?,?,?)`,
  team_members: `INSERT OR REPLACE INTO team_members (team_id, user_id, team_permission_overrides, added_by, joined_at, is_manager, updated_at, subteam_id, subteam_role) VALUES (?,?,?,?,?,?,?,?,?)`,
  media: `INSERT OR REPLACE INTO media (id, entity_type, entity_id, media_type, url, thumbnail_url, caption, is_primary, uploaded_by, created_at, location_note, updated_at, audience, audience_user_ids) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  app_config: `INSERT OR REPLACE INTO app_config (key, value, updated_at) VALUES (?, ?, ?)`,
  user_prefs: `INSERT OR REPLACE INTO user_prefs (user_id, theme, updated_at) VALUES (?, ?, ?)`,
  taxonomy_types: `INSERT OR REPLACE INTO taxonomy_types (id, category, label, icon, sort_order, active, updated_at, meta) VALUES (?,?,?,?,?,?,?,?)`,
  repairs: `INSERT OR REPLACE INTO repairs (id, entity_type, entity_id, entity_label, notes, parts_needed, status, created_by, created_at, updated_at, completed_at, assignee_id, cost, due_at, status_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  repair_parts: `INSERT OR REPLACE INTO repair_parts (id, repair_id, item_id, qty, unit, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
  notifications: `INSERT OR REPLACE INTO notifications (id, user_id, type, title, body, data, read_at, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
  approval_requests: `INSERT OR REPLACE INTO approval_requests (id, requester_id, kind, title, detail, status, decided_by, decided_at, decision_note, entity_type, entity_id, metadata, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  maintenance_events: `INSERT OR REPLACE INTO maintenance_events (id, unit_id, event_date, type, notes, cost, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`,
  label_templates: `INSERT OR REPLACE INTO label_templates (id, name, width_in, height_in, dpi, fields, active, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
  dashboard_presets: `INSERT OR REPLACE INTO dashboard_presets (id, name, layout, active, updated_at) VALUES (?,?,?,?,?)`,
  conversations: `INSERT OR REPLACE INTO conversations (id, kind, title, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?)`,
  conversation_participants: `INSERT OR REPLACE INTO conversation_participants (conversation_id, user_id, notify_pref, last_read_at, added_at, updated_at) VALUES (?,?,?,?,?,?)`,
  messages: `INSERT OR REPLACE INTO messages (id, conversation_id, sender_id, body, urgency, created_at, updated_at, edited_at, deleted_at) VALUES (?,?,?,?,?,?,?,?,?)`,
  subteams: `INSERT OR REPLACE INTO subteams (id, team_id, name, active, created_at, updated_at) VALUES (?,?,?,?,?,?)`,
  vehicles: `INSERT OR REPLACE INTO vehicles (location_id, truck_mount, water_state, model, model_id, notes, updated_at, water_tank, waste_tank, checkout_locked, debris_option, debris_level, open_checkout, locked_by, fuel_level) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  vehicle_service_records: `INSERT OR REPLACE INTO vehicle_service_records (id, vehicle_location_id, target, event_date, type, notes, odometer, cost, created_by, created_at, updated_at, payer, job_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  vehicle_checkouts: `INSERT OR REPLACE INTO vehicle_checkouts (id, vehicle_location_id, user_id, job_id, checked_out_at, checked_in_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
  locker_access: `INSERT OR REPLACE INTO locker_access (location_id, user_id, granted_by, created_at, updated_at) VALUES (?,?,?,?,?)`,
  unit_access: `INSERT OR REPLACE INTO unit_access (location_id, user_id, can_view, can_add, can_remove, can_move, can_edit_details, can_grant, granted_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  on_call_shifts: `INSERT OR REPLACE INTO on_call_shifts (id, subteam_id, week_start, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?)`,
  on_call_coverage: `INSERT OR REPLACE INTO on_call_coverage (id, date_start, date_end, user_off, covering_user, note, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`,
  job_assignments: `INSERT OR REPLACE INTO job_assignments (id, job_id, assignee_kind, assignee_id, assigned_by, active, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
};

function rowToValues(table: string, row: Record<string, unknown>): unknown[] {
  switch (table) {
    case 'role_settings': return [row.role, row.min_pin_length, JSON.stringify(row.permission_overrides ?? {}), row.color ?? null, row.updated_at, row.dashboard_preset_id ?? null];
    case 'users': return [row.id, row.name, row.role, row.pin_length_required, row.pin_set ? 1 : 0, JSON.stringify(row.permission_overrides ?? {}), row.active ? 1 : 0, row.expires_at ?? null, row.created_at, row.updated_at, row.email ?? null, row.dashboard_preset_id ?? null, row.is_test ? 1 : 0, row.enrollment_code_public ?? null, row.phone ?? null];
    case 'locations': return [row.id, row.name, row.parent_id ?? null, row.color ?? null, row.icon ?? null, row.owner_user_id ?? null, row.active ? 1 : 0, row.updated_at, row.latitude ?? null, row.longitude ?? null, row.subareas_require_owner ? 1 : 0, row.type ?? null, row.has_shelves ? 1 : 0, row.type_id ?? null];
    case 'inventory_items': return [row.id, row.name, row.barcode ?? null, row.description ?? null, row.sku ?? null, row.supplier ?? null, row.model ?? null, row.kind ?? 'product', row.category ?? null, row.returnable ? 1 : 0, row.unit_tracked ? 1 : 0, row.tag_prefix ?? null, row.unit_category, row.unit, row.min_qty_alert, row.reorder_to ?? null, row.active ? 1 : 0, row.updated_at, row.home_location_id ?? null, row.pack_size ?? null, row.category_id ?? null, row.type ?? null, row.type_id ?? null];
    case 'equipment_units': return [row.id, row.item_id, row.asset_tag, row.serial_number ?? null, row.status, row.current_location_id ?? null, row.current_job_id ?? null, row.notes ?? null, row.created_at, row.updated_at, row.purchase_price ?? null, row.acquired_at ?? null, row.useful_life_months ?? null, row.salvage_value ?? null, row.depreciation_method ?? null, row.next_service_at ?? null, row.service_interval_months ?? null];
    case 'stock_by_location': return [row.item_id, row.location_id, row.quantity, row.updated_at];
    case 'jobs': return [row.id, row.name, row.status, row.created_by ?? null, row.created_at, row.updated_at, row.job_number ?? null, row.customer_name ?? null, row.site_address ?? null, row.site_location_id ?? null, row.description ?? null, row.type ?? null, row.reference_number ?? null, row.insurance_carrier ?? null, row.type_id ?? null, row.team_id ?? null];
    case 'teams': return [row.id, row.name, row.type, row.updated_at, row.type_id ?? null];
    case 'team_members': return [row.team_id, row.user_id, JSON.stringify(row.team_permission_overrides ?? {}), row.added_by ?? null, row.joined_at, row.is_manager ? 1 : 0, row.updated_at, row.subteam_id ?? null, row.subteam_role ?? null];
    case 'media': return [row.id, row.entity_type, row.entity_id, row.media_type, row.url, row.thumbnail_url ?? null, row.caption ?? null, row.is_primary ? 1 : 0, row.uploaded_by ?? null, row.created_at, row.location_note ?? null, row.updated_at ?? row.created_at, row.audience ?? null, row.audience_user_ids ?? null];
    case 'app_config': return [row.key, row.value, row.updated_at];
    case 'user_prefs': return [row.user_id, row.theme ?? null, row.updated_at];
    case 'taxonomy_types': return [row.id, row.category, row.label, row.icon ?? null, row.sort_order, row.active ? 1 : 0, row.updated_at, row.meta ?? null];
    case 'repairs': return [row.id, row.entity_type, row.entity_id, row.entity_label ?? null, row.notes ?? null, row.parts_needed ?? null, row.status, row.created_by ?? null, row.created_at, row.updated_at, row.completed_at ?? null, row.assignee_id ?? null, row.cost ?? null, row.due_at ?? null, row.status_id ?? null];
    case 'repair_parts': return [row.id, row.repair_id, row.item_id, row.qty, row.unit, row.created_by ?? null, row.created_at, row.updated_at];
    case 'notifications': return [row.id, row.user_id, row.type, row.title, row.body, row.data ?? null, row.read_at ?? null, row.created_by ?? null, row.created_at, row.updated_at];
    case 'approval_requests': return [row.id, row.requester_id, row.kind, row.title, row.detail ?? null, row.status, row.decided_by ?? null, row.decided_at ?? null, row.decision_note ?? null, row.entity_type ?? null, row.entity_id ?? null, row.metadata ?? null, row.created_at, row.updated_at];
    case 'maintenance_events': return [row.id, row.unit_id, row.event_date, row.type, row.notes ?? null, row.cost ?? null, row.created_by ?? null, row.created_at, row.updated_at];
    case 'label_templates': return [row.id, row.name, row.width_in, row.height_in, row.dpi, row.fields ?? '[]', row.active ? 1 : 0, row.created_by ?? null, row.created_at, row.updated_at];
    case 'dashboard_presets': return [row.id, row.name, row.layout ?? '[]', row.active ? 1 : 0, row.updated_at];
    case 'conversations': return [row.id, row.kind ?? 'dm', row.title ?? null, row.created_by ?? null, row.created_at, row.updated_at];
    case 'conversation_participants': return [row.conversation_id, row.user_id, row.notify_pref ?? 'all', row.last_read_at ?? null, row.added_at, row.updated_at];
    case 'messages': return [row.id, row.conversation_id, row.sender_id ?? null, row.body, row.urgency ?? 'urgent', row.created_at, row.updated_at, row.edited_at ?? null, row.deleted_at ?? null];
    case 'subteams': return [row.id, row.team_id, row.name, row.active ? 1 : 0, row.created_at, row.updated_at];
    case 'vehicles': return [row.location_id, row.truck_mount ? 1 : 0, row.water_state ?? null, row.model ?? null, row.model_id ?? null, row.notes ?? null, row.updated_at, row.water_tank ?? 'empty', row.waste_tank ?? 'clean', row.checkout_locked ? 1 : 0, row.debris_option ? 1 : 0, row.debris_level ?? 0, row.open_checkout ? 1 : 0, row.locked_by ?? null, row.fuel_level ?? 0];
    // cost is financial: the server omits it for callers without
    // view_financial_data (maintenance_events pattern) → null locally.
    case 'vehicle_service_records': return [row.id, row.vehicle_location_id, row.target ?? 'vehicle', row.event_date, row.type, row.notes ?? null, row.odometer ?? null, row.cost ?? null, row.created_by ?? null, row.created_at, row.updated_at, row.payer ?? null, row.job_id ?? null];
    case 'vehicle_checkouts': return [row.id, row.vehicle_location_id, row.user_id, row.job_id ?? null, row.checked_out_at, row.checked_in_at ?? null, row.created_at, row.updated_at];
    case 'locker_access': return [row.location_id, row.user_id, row.granted_by ?? null, row.created_at, row.updated_at];
    case 'unit_access': return [row.location_id, row.user_id, row.can_view ? 1 : 0, row.can_add ? 1 : 0, row.can_remove ? 1 : 0, row.can_move ? 1 : 0, row.can_edit_details ? 1 : 0, row.can_grant ? 1 : 0, row.granted_by ?? null, row.created_at, row.updated_at];
    case 'on_call_shifts': return [row.id, row.subteam_id ?? null, row.week_start, row.created_by ?? null, row.created_at, row.updated_at];
    case 'on_call_coverage': return [row.id, row.date_start, row.date_end, row.user_off ?? null, row.covering_user ?? null, row.note ?? null, row.created_by ?? null, row.created_at, row.updated_at];
    case 'job_assignments': return [row.id, row.job_id, row.assignee_kind, row.assignee_id, row.assigned_by ?? null, row.active ? 1 : 0, row.created_at, row.updated_at];
    default: return [];
  }
}

function getLastPulledAt(): string {
  const db = getDb();
  const result = db.executeSync(`SELECT value FROM app_settings WHERE key = 'last_pulled_at'`);
  return (result.rows[0] as { value: string } | undefined)?.value ?? new Date(0).toISOString();
}

function setLastPulledAt(ts: string): void {
  const db = getDb();
  db.executeSync(
    `INSERT OR REPLACE INTO app_settings (key, value) VALUES ('last_pulled_at', ?)`,
    [ts]
  );
}

export async function pullChanges(): Promise<void> {
  const jwt = await getValidJwt();
  if (!jwt) return;

  const since = getLastPulledAt();
  const res = await fetch(`${API_BASE}/sync/pull?since=${encodeURIComponent(since)}`, {
    headers: { Authorization: `Bearer ${jwt}` },
  });

  if (!res.ok) throw new Error(`Pull failed: ${res.status}`);

  const data = await res.json() as Record<string, { rows: Record<string, unknown>[] }>;
  const db = getDb();

  // Track WHICH tables actually had a row applied (#64) so per-table subscribers
  // (useTableVersion) only re-query when a table they render changed — a new
  // chat message no longer re-runs inventory search, the location tree, etc.
  // bumpTablesVersion also bumps the global counter, so screens still on
  // useDataVersion() refresh on any change. An empty-diff heartbeat pull adds
  // nothing to the set and bumps nothing.
  const changedTables = new Set<string>();

  // Suspend FK enforcement while applying the batch. Rows arrive in server
  // order, not dependency order, and locations.parent_id is self-referencing —
  // a child arriving before its parent in the same batch would fail the INSERT
  // and abort the whole cycle ("FOREIGN KEY constraint failed"), which reads as
  // sync being silently dead. The server owns FK integrity for synced rows.
  db.executeSync(`PRAGMA foreign_keys = OFF`);
  try {
    for (const [table, { rows }] of Object.entries(data)) {
      const sql = TABLE_UPSERT_SQL[table];
      if (!sql || rows.length === 0) continue;

      for (const row of rows) {
        const values = rowToValues(table, row);
        if (values.length > 0) {
          db.executeSync(sql, values as (string | number | null)[]);
          changedTables.add(table);
        }
      }
    }
  } finally {
    // Restore before any local write path runs — user edits stay FK-checked.
    db.executeSync(`PRAGMA foreign_keys = ON`);
  }

  setLastPulledAt(new Date().toISOString());

  if (changedTables.size > 0) bumpTablesVersion(changedTables);
}
