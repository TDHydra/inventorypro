import { getDb } from '../db/schema';
import { getValidJwt } from '../auth/session';

const API_BASE = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';

const TABLE_UPSERT_SQL: Record<string, string> = {
  role_settings: `INSERT OR REPLACE INTO role_settings (role, min_pin_length, updated_at) VALUES (?, ?, ?)`,
  users: `INSERT OR REPLACE INTO users (id, name, role, pin_length_required, pin_set, permission_overrides, active, expires_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
  locations: `INSERT OR REPLACE INTO locations (id, name, parent_id, color, icon, updated_at) VALUES (?,?,?,?,?,?)`,
  inventory_items: `INSERT OR REPLACE INTO inventory_items (id, name, barcode, description, sku, supplier, model, unit_category, unit, min_qty_alert, reorder_to, active, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  stock_by_location: `INSERT OR REPLACE INTO stock_by_location (item_id, location_id, quantity, updated_at) VALUES (?,?,?,?)`,
  jobs: `INSERT OR REPLACE INTO jobs (id, name, status, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?)`,
  teams: `INSERT OR REPLACE INTO teams (id, name, type, manager_id, updated_at) VALUES (?,?,?,?,?)`,
  team_members: `INSERT OR REPLACE INTO team_members (team_id, user_id, team_permission_overrides, added_by, joined_at) VALUES (?,?,?,?,?)`,
  media: `INSERT OR REPLACE INTO media (id, entity_type, entity_id, media_type, url, thumbnail_url, caption, is_primary, uploaded_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
};

function rowToValues(table: string, row: Record<string, unknown>): unknown[] {
  switch (table) {
    case 'role_settings': return [row.role, row.min_pin_length, row.updated_at];
    case 'users': return [row.id, row.name, row.role, row.pin_length_required, row.pin_set ? 1 : 0, JSON.stringify(row.permission_overrides ?? {}), row.active ? 1 : 0, row.expires_at ?? null, row.created_at, row.updated_at];
    case 'locations': return [row.id, row.name, row.parent_id ?? null, row.color ?? null, row.icon ?? null, row.updated_at];
    case 'inventory_items': return [row.id, row.name, row.barcode ?? null, row.description ?? null, row.sku ?? null, row.supplier ?? null, row.model ?? null, row.unit_category, row.unit, row.min_qty_alert, row.reorder_to ?? null, row.active ? 1 : 0, row.updated_at];
    case 'stock_by_location': return [row.item_id, row.location_id, row.quantity, row.updated_at];
    case 'jobs': return [row.id, row.name, row.status, row.created_by ?? null, row.created_at, row.updated_at];
    case 'teams': return [row.id, row.name, row.type, row.manager_id ?? null, row.updated_at];
    case 'team_members': return [row.team_id, row.user_id, JSON.stringify(row.team_permission_overrides ?? {}), row.added_by ?? null, row.joined_at];
    case 'media': return [row.id, row.entity_type, row.entity_id, row.media_type, row.url, row.thumbnail_url ?? null, row.caption ?? null, row.is_primary ? 1 : 0, row.uploaded_by ?? null, row.created_at];
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

  for (const [table, { rows }] of Object.entries(data)) {
    const sql = TABLE_UPSERT_SQL[table];
    if (!sql || rows.length === 0) continue;

    for (const row of rows) {
      const values = rowToValues(table, row);
      if (values.length > 0) {
        db.executeSync(sql, values as (string | number | null)[]);
      }
    }
  }

  setLastPulledAt(new Date().toISOString());
}
