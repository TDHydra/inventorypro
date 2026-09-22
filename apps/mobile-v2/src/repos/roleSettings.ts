// role_settings domain — split out of the old app's single db/queries/users.ts
// (which bundled users + role_settings together). Writes route through
// createRepository('role_settings') via .mirror() rather than .insert()/
// .update(): every write here preserves the old app's `INSERT ... ON CONFLICT
// DO UPDATE` column-scoped upsert (a role_settings row for a given role may not
// exist locally yet — e.g. before the fullDownload-order-0 pull completes, or a
// newly added role — so a plain UPDATE would silently no-op). A full-row
// `INSERT OR REPLACE` would also be wrong here: it resets every unlisted column
// to its default on an existing row (mig-060 postmortem, see setRolePermission
// below) — ON CONFLICT DO UPDATE naming only the touched column(s) avoids that.
//
// Callers (roles/index.tsx) wrap `runInTransaction(() => { setXxx(...);
// appendLog({...}); })` themselves — mirrors the old app's roles.tsx exactly,
// and works because runInTransaction is reentrant: the mirror() call inside
// each setter here just joins the caller's outer transaction instead of
// committing separately.
import { getDb } from '../db/schema';
import { createRepository } from '@invenpro/core';
import { resolveRoleColor } from '../constants/roles';

const roleSettingsRepo = createRepository('role_settings');

export function getRoleSettings(): Record<string, number> {
  const db = getDb();
  const result = db.executeSync(`SELECT role, min_pin_length FROM role_settings`);
  return Object.fromEntries(
    (result.rows as { role: string; min_pin_length: number }[])
      .map(r => [r.role, r.min_pin_length])
  );
}

// Role → idle re-auth minutes (#244). 0 = disabled (DEFAULT for every role
// until an admin opts in via the Roles editor). Missing rows read as 0/disabled
// via the caller's own `?? 0` fallback, same convention as getRoleSettings.
export function getRoleIdleReauthMinutes(): Record<string, number> {
  const db = getDb();
  const result = db.executeSync(`SELECT role, idle_reauth_minutes FROM role_settings`);
  return Object.fromEntries(
    (result.rows as { role: string; idle_reauth_minutes: number }[])
      .map(r => [r.role, r.idle_reauth_minutes])
  );
}

// Set a role's idle re-auth minutes. Returns the new updated_at stamp.
export function setRoleIdleReauthMinutes(role: string, minutes: number): string {
  const now = new Date().toISOString();
  roleSettingsRepo.mirror('UPDATE', { role, idle_reauth_minutes: minutes, updated_at: now }, () => {
    getDb().executeSync(
      `INSERT INTO role_settings (role, idle_reauth_minutes, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(role) DO UPDATE SET idle_reauth_minutes = excluded.idle_reauth_minutes, updated_at = excluded.updated_at`,
      [role, minutes, now]
    );
  });
  return now;
}

// Role → override color (only non-null overrides). Callers build this ONCE per
// screen and pass it to roleColor() per row to avoid per-row DB reads.
export function getRoleColorMap(): Record<string, string> {
  const db = getDb();
  const result = db.executeSync(`SELECT role, color FROM role_settings WHERE color IS NOT NULL`);
  const map: Record<string, string> = {};
  for (const row of result.rows as { role: string; color: string | null }[]) {
    if (row.color) map[row.role] = row.color;
  }
  return map;
}

// Effective name color for a role. Pass a prebuilt map in hot lists.
export function roleColor(role: string, map?: Record<string, string>): string {
  const override = (map ?? getRoleColorMap())[role];
  return resolveRoleColor(role, override);
}

// Set (or clear, with null) a role's override color. Returns new updated_at.
export function setRoleColor(role: string, color: string | null): string {
  const now = new Date().toISOString();
  roleSettingsRepo.mirror('UPDATE', { role, color, updated_at: now }, () => {
    getDb().executeSync(
      `INSERT INTO role_settings (role, color, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(role) DO UPDATE SET color = excluded.color, updated_at = excluded.updated_at`,
      [role, color, now]
    );
  });
  return now;
}

// Read all role-level permission deviations from ROLE_DEFAULTS, keyed by role.
// Each value is that role's override map ({perm: bool}); empty = pure default.
// JSON is parsed per row with a safe {} fallback so one bad/null row can't break
// the rest.
export function getRolePermissionOverrides(): Record<string, Record<string, boolean>> {
  const db = getDb();
  const result = db.executeSync(`SELECT role, permission_overrides FROM role_settings`);
  const out: Record<string, Record<string, boolean>> = {};
  for (const r of result.rows as { role: string; permission_overrides: string | null }[]) {
    try {
      out[r.role] = r.permission_overrides ? JSON.parse(r.permission_overrides) : {};
    } catch {
      out[r.role] = {};
    }
  }
  return out;
}

// Toggle a single role→permission deviation. `allowed === null` DELETES the key
// (clean reset to the ROLE_DEFAULTS value); a boolean sets it. Read-modify-write
// the role's override map, upsert preserving every other column, and mirror the
// JSON object to the outbox (real booleans; synced_at stripped). Returns the
// updated_at stamp.
export function setRolePermission(role: string, perm: string, allowed: boolean | null): string {
  const db = getDb();
  const now = new Date().toISOString();
  const existing = db.executeSync(
    `SELECT permission_overrides FROM role_settings WHERE role = ?`,
    [role]
  );
  const cur = existing.rows[0] as { permission_overrides: string | null } | undefined;
  let overrides: Record<string, boolean> = {};
  try {
    overrides = cur?.permission_overrides ? JSON.parse(cur.permission_overrides) : {};
  } catch {
    overrides = {};
  }
  if (allowed === null) {
    delete overrides[perm];
  } else {
    overrides[perm] = allowed;
  }
  roleSettingsRepo.mirror('UPDATE', { role, permission_overrides: overrides, updated_at: now }, () => {
    // Column-scoped upsert (ON CONFLICT DO UPDATE touching ONLY
    // permission_overrides + updated_at) — a full-row `INSERT OR REPLACE`
    // naming a column subset resets every unlisted column (color/
    // dashboard_preset_id/idle_reauth_minutes) to its default instead of
    // preserving it (mig-060 postmortem, verified against sql.js).
    getDb().executeSync(
      `INSERT INTO role_settings (role, permission_overrides, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(role) DO UPDATE SET permission_overrides = excluded.permission_overrides, updated_at = excluded.updated_at`,
      [role, JSON.stringify(overrides), now]
    );
  });
  return now;
}

export function setRoleMinPin(role: string, minPinLength: number): string {
  const now = new Date().toISOString();
  roleSettingsRepo.mirror('UPDATE', { role, min_pin_length: minPinLength, updated_at: now }, () => {
    getDb().executeSync(
      `INSERT INTO role_settings (role, min_pin_length, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(role) DO UPDATE SET min_pin_length = excluded.min_pin_length, updated_at = excluded.updated_at`,
      [role, minPinLength, now]
    );
  });
  return now;
}
