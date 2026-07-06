import { getDb } from '../db/schema';
import { getValidJwt } from '../auth/session';
import { bumpDataVersion } from './dataVersion';

const API_BASE = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';

const TABLE_UPSERT_SQL: Record<string, string> = {
  role_settings: `INSERT OR REPLACE INTO role_settings (role, min_pin_length, permission_overrides, color, updated_at) VALUES (?, ?, ?, ?, ?)`,
  users: `INSERT OR REPLACE INTO users (id, name, role, pin_length_required, pin_set, permission_overrides, active, expires_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
  locations: `INSERT OR REPLACE INTO locations (id, name, parent_id, color, icon, owner_user_id, active, updated_at, latitude, longitude, subareas_require_owner, type, has_shelves, type_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  inventory_items: `INSERT OR REPLACE INTO inventory_items (id, name, barcode, description, sku, supplier, model, kind, category, returnable, unit_tracked, tag_prefix, unit_category, unit, min_qty_alert, reorder_to, active, updated_at, home_location_id, pack_size, category_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  equipment_units: `INSERT OR REPLACE INTO equipment_units (id, item_id, asset_tag, serial_number, status, current_location_id, current_job_id, notes, created_at, updated_at, purchase_price, acquired_at, useful_life_months, salvage_value, depreciation_method, next_service_at, service_interval_months) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  stock_by_location: `INSERT OR REPLACE INTO stock_by_location (item_id, location_id, quantity, updated_at) VALUES (?,?,?,?)`,
  jobs: `INSERT OR REPLACE INTO jobs (id, name, status, created_by, created_at, updated_at, job_number, customer_name, site_address, site_location_id, description, type, reference_number, insurance_carrier, type_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  teams: `INSERT OR REPLACE INTO teams (id, name, type, updated_at, type_id) VALUES (?,?,?,?,?)`,
  team_members: `INSERT OR REPLACE INTO team_members (team_id, user_id, team_permission_overrides, added_by, joined_at, is_manager, updated_at) VALUES (?,?,?,?,?,?,?)`,
  media: `INSERT OR REPLACE INTO media (id, entity_type, entity_id, media_type, url, thumbnail_url, caption, is_primary, uploaded_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
  app_config: `INSERT OR REPLACE INTO app_config (key, value, updated_at) VALUES (?, ?, ?)`,
  taxonomy_types: `INSERT OR REPLACE INTO taxonomy_types (id, category, label, icon, sort_order, active, updated_at, meta) VALUES (?,?,?,?,?,?,?,?)`,
  repairs: `INSERT OR REPLACE INTO repairs (id, entity_type, entity_id, entity_label, notes, parts_needed, status, created_by, created_at, updated_at, completed_at, assignee_id, cost, due_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  repair_parts: `INSERT OR REPLACE INTO repair_parts (id, repair_id, item_id, qty, unit, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
  notifications: `INSERT OR REPLACE INTO notifications (id, user_id, type, title, body, data, read_at, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
  approval_requests: `INSERT OR REPLACE INTO approval_requests (id, requester_id, kind, title, detail, status, decided_by, decided_at, decision_note, entity_type, entity_id, metadata, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  maintenance_events: `INSERT OR REPLACE INTO maintenance_events (id, unit_id, event_date, type, notes, cost, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`,
  label_templates: `INSERT OR REPLACE INTO label_templates (id, name, width_in, height_in, dpi, fields, active, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
};

function rowToValues(table: string, row: Record<string, unknown>): unknown[] {
  switch (table) {
    case 'role_settings': return [row.role, row.min_pin_length, JSON.stringify(row.permission_overrides ?? {}), row.color ?? null, row.updated_at];
    case 'users': return [row.id, row.name, row.role, row.pin_length_required, row.pin_set ? 1 : 0, JSON.stringify(row.permission_overrides ?? {}), row.active ? 1 : 0, row.expires_at ?? null, row.created_at, row.updated_at];
    case 'locations': return [row.id, row.name, row.parent_id ?? null, row.color ?? null, row.icon ?? null, row.owner_user_id ?? null, row.active ? 1 : 0, row.updated_at, row.latitude ?? null, row.longitude ?? null, row.subareas_require_owner ? 1 : 0, row.type ?? null, row.has_shelves ? 1 : 0, row.type_id ?? null];
    case 'inventory_items': return [row.id, row.name, row.barcode ?? null, row.description ?? null, row.sku ?? null, row.supplier ?? null, row.model ?? null, row.kind ?? 'product', row.category ?? null, row.returnable ? 1 : 0, row.unit_tracked ? 1 : 0, row.tag_prefix ?? null, row.unit_category, row.unit, row.min_qty_alert, row.reorder_to ?? null, row.active ? 1 : 0, row.updated_at, row.home_location_id ?? null, row.pack_size ?? null, row.category_id ?? null];
    case 'equipment_units': return [row.id, row.item_id, row.asset_tag, row.serial_number ?? null, row.status, row.current_location_id ?? null, row.current_job_id ?? null, row.notes ?? null, row.created_at, row.updated_at, row.purchase_price ?? null, row.acquired_at ?? null, row.useful_life_months ?? null, row.salvage_value ?? null, row.depreciation_method ?? null, row.next_service_at ?? null, row.service_interval_months ?? null];
    case 'stock_by_location': return [row.item_id, row.location_id, row.quantity, row.updated_at];
    case 'jobs': return [row.id, row.name, row.status, row.created_by ?? null, row.created_at, row.updated_at, row.job_number ?? null, row.customer_name ?? null, row.site_address ?? null, row.site_location_id ?? null, row.description ?? null, row.type ?? null, row.reference_number ?? null, row.insurance_carrier ?? null, row.type_id ?? null];
    case 'teams': return [row.id, row.name, row.type, row.updated_at, row.type_id ?? null];
    case 'team_members': return [row.team_id, row.user_id, JSON.stringify(row.team_permission_overrides ?? {}), row.added_by ?? null, row.joined_at, row.is_manager ? 1 : 0, row.updated_at];
    case 'media': return [row.id, row.entity_type, row.entity_id, row.media_type, row.url, row.thumbnail_url ?? null, row.caption ?? null, row.is_primary ? 1 : 0, row.uploaded_by ?? null, row.created_at];
    case 'app_config': return [row.key, row.value, row.updated_at];
    case 'taxonomy_types': return [row.id, row.category, row.label, row.icon ?? null, row.sort_order, row.active ? 1 : 0, row.updated_at, row.meta ?? null];
    case 'repairs': return [row.id, row.entity_type, row.entity_id, row.entity_label ?? null, row.notes ?? null, row.parts_needed ?? null, row.status, row.created_by ?? null, row.created_at, row.updated_at, row.completed_at ?? null, row.assignee_id ?? null, row.cost ?? null, row.due_at ?? null];
    case 'repair_parts': return [row.id, row.repair_id, row.item_id, row.qty, row.unit, row.created_by ?? null, row.created_at, row.updated_at];
    case 'notifications': return [row.id, row.user_id, row.type, row.title, row.body, row.data ?? null, row.read_at ?? null, row.created_by ?? null, row.created_at, row.updated_at];
    case 'approval_requests': return [row.id, row.requester_id, row.kind, row.title, row.detail ?? null, row.status, row.decided_by ?? null, row.decided_at ?? null, row.decision_note ?? null, row.entity_type ?? null, row.entity_id ?? null, row.metadata ?? null, row.created_at, row.updated_at];
    case 'maintenance_events': return [row.id, row.unit_id, row.event_date, row.type, row.notes ?? null, row.cost ?? null, row.created_by ?? null, row.created_at, row.updated_at];
    case 'label_templates': return [row.id, row.name, row.width_in, row.height_in, row.dpi, row.fields ?? '[]', row.active ? 1 : 0, row.created_by ?? null, row.created_at, row.updated_at];
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

  // Track whether any row was actually applied so open lists (via
  // useDataVersion) only re-query when a pull genuinely changed local data,
  // not on every empty-diff heartbeat pull.
  let changed = false;

  for (const [table, { rows }] of Object.entries(data)) {
    const sql = TABLE_UPSERT_SQL[table];
    if (!sql || rows.length === 0) continue;

    for (const row of rows) {
      const values = rowToValues(table, row);
      if (values.length > 0) {
        db.executeSync(sql, values as (string | number | null)[]);
        changed = true;
      }
    }
  }

  setLastPulledAt(new Date().toISOString());

  if (changed) bumpDataVersion();
}
