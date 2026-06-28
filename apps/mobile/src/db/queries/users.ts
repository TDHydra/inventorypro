import { getDb, rowsAs, bindParams } from '../schema';
import { UserRole } from '../../constants/roles';
import { appendOutbox } from '../../sync/outbox';

export interface User {
  id: string;
  name: string;
  role: UserRole;
  pin_length_required: number;
  pin_set: number; // 0 = must set PIN on first login, 1 = set
  permission_overrides: string; // JSON string
  active: number;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
  synced_at: string | null;
}

export function getAllActiveUsers(): User[] {
  const db = getDb();
  const now = new Date().toISOString();
  const result = db.executeSync(
    `SELECT * FROM users
     WHERE active = 1
       AND (expires_at IS NULL OR expires_at > ?)
     ORDER BY name`,
    [now]
  );
  return rowsAs<User>(result.rows);
}

// Admin list needs EVERYONE — including deactivated/expired users, so they can
// be reactivated. (getAllActiveUsers is for the login picker, which must not.)
export function getAllUsers(): User[] {
  const db = getDb();
  const result = db.executeSync(`SELECT * FROM users ORDER BY active DESC, name`);
  return rowsAs<User>(result.rows);
}

export function getUserById(id: string): User | null {
  const db = getDb();
  const result = db.executeSync(`SELECT * FROM users WHERE id = ?`, [id]);
  return (result.rows[0] as unknown as User) ?? null;
}

export function upsertUser(user: User): void {
  const db = getDb();
  db.executeSync(
    `INSERT OR REPLACE INTO users
       (id, name, role, pin_length_required, pin_set, permission_overrides,
        active, expires_at, created_at, updated_at, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    bindParams([user.id, user.name, user.role,
     user.pin_length_required, user.pin_set, user.permission_overrides,
     user.active, user.expires_at, user.created_at,
     user.updated_at, user.synced_at])
  );
}

// Mark a user's PIN as set locally right after first-login setup, so we don't
// re-prompt before the next sync round-trip confirms it server-side.
export function markUserPinSet(userId: string, pinLength: number): void {
  const db = getDb();
  db.executeSync(
    `UPDATE users SET pin_set = 1, pin_length_required = ? WHERE id = ?`,
    [pinLength, userId]
  );
}

export function getRoleSettings(): Record<string, number> {
  const db = getDb();
  const result = db.executeSync(`SELECT role, min_pin_length FROM role_settings`);
  return Object.fromEntries(
    (result.rows as { role: string; min_pin_length: number }[])
      .map(r => [r.role, r.min_pin_length])
  );
}

// Apply admin edits to the local users row. PIN/pin_set are NEVER written here —
// PIN reset is server-only (see resetUserPinOnline in the screen). Returns the
// updated_at stamp so the caller can mirror it into the sync outbox.
type EditableUserFields = Partial<Pick<User, 'name' | 'role' | 'active' | 'expires_at' | 'pin_length_required'>>;
export function updateUserLocal(userId: string, fields: EditableUserFields): string {
  const db = getDb();
  const now = new Date().toISOString();
  const cols = Object.keys(fields);
  if (cols.length === 0) return now;
  const assignments = cols.map(c => `${c} = ?`).join(', ');
  db.executeSync(
    `UPDATE users SET ${assignments}, updated_at = ? WHERE id = ?`,
    bindParams([...cols.map(c => (fields as Record<string, unknown>)[c]), now, userId])
  );
  return now;
}

// Batch helpers — DRY the local-update + outbox-UPDATE pair that single-row edits
// in users.tsx do inline (see users.tsx:181-182, 224-225). Each writes the local
// row (0/1 in SQLite) and mirrors a sync outbox UPDATE with a REAL boolean for
// `active` and NO synced_at. Returns the updated_at stamp.
export function setUserActive(id: string, active: boolean): string {
  const now = updateUserLocal(id, { active: active ? 1 : 0 });
  appendOutbox('UPDATE', 'users', { id, active: !!active, updated_at: now });
  return now;
}

// A role change must also move pin_length_required to the new role's minimum —
// exactly like the single-row edit in users.tsx saveEdits (a crew→manager
// promotion must not keep the shorter PIN requirement). The caller passes the
// resolved minimum (roleMinPins[role] ?? PIN_LENGTH_BY_TIER[ROLE_TIER[role]])
// so this query layer stays free of the role-settings cache.
export function setUserRole(id: string, role: string, pinLengthRequired?: number): string {
  const fields: EditableUserFields = { role: role as UserRole };
  if (pinLengthRequired != null) fields.pin_length_required = pinLengthRequired;
  const now = updateUserLocal(id, fields);
  appendOutbox('UPDATE', 'users', {
    id, role, updated_at: now,
    ...(pinLengthRequired != null ? { pin_length_required: pinLengthRequired } : {}),
  });
  return now;
}

// Mark a user's PIN as cleared locally after an admin reset, so this device
// reflects it immediately (other devices pick it up on the next pull).
export function markUserPinReset(userId: string): void {
  const db = getDb();
  db.executeSync(`UPDATE users SET pin_set = 0 WHERE id = ?`, [userId]);
}

// Active users of a given role — e.g. the production-manager dropdown in checkout.
export function getUsersByRole(role: string): User[] {
  const db = getDb();
  const result = db.executeSync(
    `SELECT * FROM users WHERE active = 1 AND role = ? ORDER BY name`,
    [role]
  );
  return rowsAs<User>(result.rows);
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
// the role's override map, INSERT OR REPLACE preserving min_pin_length, and mirror
// the JSON object to the outbox (real booleans; synced_at stripped). Returns the
// updated_at stamp.
export function setRolePermission(role: string, perm: string, allowed: boolean | null): string {
  const db = getDb();
  const now = new Date().toISOString();
  const existing = db.executeSync(
    `SELECT min_pin_length, permission_overrides FROM role_settings WHERE role = ?`,
    [role]
  );
  const cur = existing.rows[0] as
    | { min_pin_length: number; permission_overrides: string | null }
    | undefined;
  const minPin = cur?.min_pin_length ?? 4;
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
  db.executeSync(
    `INSERT OR REPLACE INTO role_settings (role, min_pin_length, permission_overrides, updated_at)
     VALUES (?, ?, ?, ?)`,
    [role, minPin, JSON.stringify(overrides), now]
  );
  appendOutbox('UPDATE', 'role_settings', { role, permission_overrides: overrides, updated_at: now });
  return now;
}

export function setRoleMinPin(role: string, minPinLength: number): string {
  const db = getDb();
  const now = new Date().toISOString();
  db.executeSync(
    `INSERT INTO role_settings (role, min_pin_length, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(role) DO UPDATE SET min_pin_length = excluded.min_pin_length, updated_at = excluded.updated_at`,
    [role, minPinLength, now]
  );
  return now;
}
