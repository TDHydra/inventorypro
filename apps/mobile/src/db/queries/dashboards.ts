import { getDb, rowsAs, bindParams } from '../schema';
import { appendOutbox } from '../../sync/outbox';
import { generateUUID } from '../../utils/uuid';
import type { Layout } from '../../dashboard/widgets';

// dashboard_presets CRUD, mirroring the taxonomy.ts mutators: each write does a
// local INSERT OR REPLACE of the full row + appendOutbox('INSERT','dashboard_presets',{...})
// with a REAL boolean `active` (the server upsert is gated on system_settings via
// syncPolicy). `layout` is a JSON string (array of LayoutBlock, see widgets.ts).
export type DashboardPreset = {
  id: string;
  name: string;
  layout: string; // JSON array of LayoutBlock
  active: number;
  updated_at: string;
};

export function getDashboardPresets(): DashboardPreset[] {
  const db = getDb();
  const result = db.executeSync(`SELECT * FROM dashboard_presets ORDER BY name ASC`);
  return rowsAs<DashboardPreset>(result.rows);
}

export function getDashboardPresetById(id: string): DashboardPreset | null {
  const db = getDb();
  const result = db.executeSync(`SELECT * FROM dashboard_presets WHERE id = ? LIMIT 1`, [id]);
  return rowsAs<DashboardPreset>(result.rows)[0] ?? null;
}

// role → that role's assigned dashboard_preset_id (only non-null). Feeds the store's
// role-precedence resolution.
export function getRoleDashboardPresetIds(): Record<string, string | null> {
  const db = getDb();
  const result = db.executeSync(
    `SELECT role, dashboard_preset_id FROM role_settings WHERE dashboard_preset_id IS NOT NULL`,
  );
  const out: Record<string, string | null> = {};
  for (const r of result.rows as { role: string; dashboard_preset_id: string | null }[]) {
    if (r.dashboard_preset_id) out[r.role] = r.dashboard_preset_id;
  }
  return out;
}

// A single user's assigned preset id (highest precedence). Read live from the DB so
// an admin assignment synced onto the users row takes effect on the next resolve.
export function getUserDashboardPresetId(userId: string): string | null {
  const db = getDb();
  const result = db.executeSync(
    `SELECT dashboard_preset_id FROM users WHERE id = ? LIMIT 1`,
    [userId],
  );
  const row = result.rows[0] as { dashboard_preset_id: string | null } | undefined;
  return row?.dashboard_preset_id ?? null;
}

function upsertPreset(p: DashboardPreset): void {
  const db = getDb();
  db.executeSync(
    `INSERT OR REPLACE INTO dashboard_presets (id, name, layout, active, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
    bindParams([p.id, p.name, p.layout, p.active, p.updated_at]),
  );
  appendOutbox('INSERT', 'dashboard_presets', {
    id: p.id, name: p.name, layout: p.layout, active: p.active === 1, updated_at: p.updated_at,
  });
}

export function createDashboardPreset({ name }: { name: string }): string {
  const id = generateUUID();
  upsertPreset({ id, name, layout: '[]', active: 1, updated_at: new Date().toISOString() });
  return id;
}

export function renameDashboardPreset(id: string, name: string): void {
  const existing = getDashboardPresetById(id);
  if (!existing) return;
  upsertPreset({ ...existing, name, updated_at: new Date().toISOString() });
}

export function setDashboardPresetLayout(id: string, layout: Layout): void {
  const existing = getDashboardPresetById(id);
  if (!existing) return;
  upsertPreset({ ...existing, layout: JSON.stringify(layout), updated_at: new Date().toISOString() });
}

export function setDashboardPresetActive(id: string, active: boolean): void {
  const existing = getDashboardPresetById(id);
  if (!existing) return;
  upsertPreset({ ...existing, active: active ? 1 : 0, updated_at: new Date().toISOString() });
}

// Per-user / per-role ASSIGNMENT writes (Wave C surface; trivial to expose now).
// Each mirrors the existing single-row update + outbox UPDATE pattern (real value,
// no synced_at). `presetId === null` clears the assignment back to the default.
export function setUserDashboardPreset(userId: string, presetId: string | null): string {
  const db = getDb();
  const now = new Date().toISOString();
  db.executeSync(
    `UPDATE users SET dashboard_preset_id = ?, updated_at = ? WHERE id = ?`,
    [presetId, now, userId],
  );
  appendOutbox('UPDATE', 'users', { id: userId, dashboard_preset_id: presetId, updated_at: now });
  return now;
}

export function setRoleDashboardPreset(role: string, presetId: string | null): string {
  const db = getDb();
  const now = new Date().toISOString();
  db.executeSync(
    `INSERT INTO role_settings (role, dashboard_preset_id, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(role) DO UPDATE SET dashboard_preset_id = excluded.dashboard_preset_id, updated_at = excluded.updated_at`,
    [role, presetId, now],
  );
  appendOutbox('UPDATE', 'role_settings', { role, dashboard_preset_id: presetId, updated_at: now });
  return now;
}
