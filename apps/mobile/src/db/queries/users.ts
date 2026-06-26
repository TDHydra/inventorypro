import { getDb, rowsAs, bindParams } from '../schema';
import { UserRole } from '../../constants/roles';

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
