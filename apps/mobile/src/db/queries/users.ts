import { getDb, rowsAs, bindParams } from '../schema';
import { UserRole, ROLE_TIER, resolveRoleColor } from '../../constants/roles';
import { appendOutbox } from '../../sync/outbox';
import { getValidJwt } from '../../auth/session';

const API_BASE = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';

// User creation is ONLINE-ONLY: the server creates the account (the employee sets
// their own PIN at first sign-in) — the raw PIN never touches the device DB or the
// sync outbox, and pin_hash is NOT NULL server-side so a generic outbox INSERT
// would fail. The returned row (sans pin_hash) is mirrored locally for display.
// Returns the new user's id. Throws (with a friendly message) when offline / 403.
export async function createUserOnline(name: string, role: UserRole): Promise<string> {
  const jwt = await getValidJwt();
  if (!jwt) throw new Error('Connect to the server to create users.');
  const res = await fetch(`${API_BASE}/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ name, role }),
  });
  if (!res.ok) {
    throw new Error(res.status === 403 ? 'You do not have permission to create users.' : `Could not create user (${res.status}).`);
  }
  const created = await res.json() as {
    id: string; name: string; role: string; pin_length_required: number; pin_set: boolean; created_at: string;
  };
  const now = created.created_at ?? new Date().toISOString();
  getDb().executeSync(
    `INSERT OR REPLACE INTO users
       (id, name, role, pin_length_required, pin_set, permission_overrides, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    [created.id, created.name, created.role, created.pin_length_required, created.pin_set ? 1 : 0, JSON.stringify({}), now, now],
  );
  return created.id;
}

export interface User {
  id: string;
  name: string;
  role: UserRole;
  pin_length_required: number;
  pin_set: number; // 0 = must set PIN on first login, 1 = set
  permission_overrides: string; // JSON string
  active: number;
  expires_at: string | null;
  email?: string | null;
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

// Active users whose access expires within the next `days` days (now < expires_at
// <= now+days). Drives the temp-employee-expiry local alert. Mirrors the bind
// style of getAllActiveUsers (ISO-string comparisons against expires_at).
export function getExpiringUsers(days: number): User[] {
  const db = getDb();
  const now = new Date();
  const until = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  const result = db.executeSync(
    `SELECT * FROM users
     WHERE active = 1
       AND expires_at IS NOT NULL
       AND expires_at > ?
       AND expires_at <= ?
     ORDER BY expires_at`,
    [now.toISOString(), until.toISOString()]
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
  const db = getDb();
  const now = new Date().toISOString();
  db.executeSync(
    `INSERT INTO role_settings (role, color, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(role) DO UPDATE SET color = excluded.color, updated_at = excluded.updated_at`,
    [role, color, now]
  );
  return now;
}

// Apply admin edits to the local users row. PIN/pin_set are NEVER written here —
// PIN reset is server-only (see resetUserPinOnline in the screen). Returns the
// updated_at stamp so the caller can mirror it into the sync outbox.
type EditableUserFields = Partial<Pick<User, 'name' | 'role' | 'active' | 'expires_at' | 'pin_length_required' | 'email'>>;
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

export interface RoleChangeResult {
  id: string;
  name: string;
  role: string;
  pin_length_required: number;
  active: boolean;
  expires_at: string | null;
  // Present only when the role change also changed the required PIN length —
  // the server cleared the old PIN and this is the ONE time the fresh
  // enrollment code is ever returned, so the caller must surface it to the admin.
  enrollment_code?: string;
}

// A role change whose new role requires a DIFFERENT PIN length must go through
// the server: PATCH /users/:id is the only path that can clear pin_hash/pin_set
// and reissue an enrollment_code (the sync outbox always denies writes to those
// columns — see appendOutbox's always-denied list — so routing this through
// appendOutbox would silently leave the user's old PIN active with no code to
// set a new one). Mirrors resetUserPinOnline/createUserOnline: online-only,
// throws a friendly error when offline/forbidden so the caller can refuse to
// apply the change locally. A same-length role change should NOT call this —
// it stays on the offline-capable setUserRole/outbox path below.
export async function changeRoleOnline(userId: string, role: UserRole): Promise<RoleChangeResult> {
  const jwt = await getValidJwt();
  if (!jwt) throw new Error("Changing to this role resets the user's PIN and requires a connection.");
  const res = await fetch(`${API_BASE}/users/${userId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ role }),
  });
  if (!res.ok) {
    throw new Error(res.status === 403 ? 'You do not have permission to change roles.' : `Could not change role (${res.status}).`);
  }
  return res.json() as Promise<RoleChangeResult>;
}

// A role change must also move pin_length_required to the new role's minimum —
// exactly like the single-row edit in users.tsx saveEdits (a crew→manager
// promotion must not keep the shorter PIN requirement). The caller passes the
// resolved minimum (roleMinPins[role] ?? PIN_LENGTH_BY_TIER[ROLE_TIER[role]])
// so this query layer stays free of the role-settings cache.
//
// When that minimum DIFFERS from the user's current required length, the
// user's existing PIN no longer satisfies the new role's policy — mirror the
// API's PATCH /users/:id behavior by also clearing pin_set locally (via
// markUserPinReset, the same helper the admin reset-PIN flow uses), so this
// device stops accepting the old PIN even before the next sync pulls the
// server's authoritative pin_hash=NULL/enrollment_code state. A same-length
// role change must NOT touch pin_set.
export function setUserRole(id: string, role: string, pinLengthRequired?: number): string {
  const current = getUserById(id);
  const lengthChanged = pinLengthRequired != null && current != null
    && current.pin_length_required !== pinLengthRequired;
  const fields: EditableUserFields = { role: role as UserRole };
  if (pinLengthRequired != null) fields.pin_length_required = pinLengthRequired;
  const now = updateUserLocal(id, fields);
  if (lengthChanged) markUserPinReset(id);
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

// Active users at manager tier (ROLE_TIER >= 2) — the checkout "Manager"
// destination. Managers are grouped in practice (heads of construction/contents,
// office/franchise managers all act as destinations), so the picker must offer
// all of them, not just production_manager. Ordered by tier desc (most senior
// first) then name.
export function getManagerTierUsers(): User[] {
  return getAllActiveUsers()
    .filter(u => (ROLE_TIER[u.role] ?? 0) >= 2)
    .sort((a, b) => (ROLE_TIER[b.role] - ROLE_TIER[a.role]) || a.name.localeCompare(b.name));
}

// Active users whose name matches the query (case-insensitive), for global search.
export function searchUsers(q: string, limit = 20): User[] {
  const db = getDb();
  const result = db.executeSync(
    `SELECT * FROM users WHERE active = 1 AND name LIKE ? ORDER BY name LIMIT ?`,
    [`%${q}%`, limit],
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
