// users domain — split out of the old app's single db/queries/users.ts (which
// bundled users + role_settings together; role_settings now lives in
// ./roleSettings.ts). Outbox-mirrored writes route through
// createRepository('users'); PIN columns (pin_hash/pin_set/
// enrollment_code_hash/is_test/enrollment_code_public) are ALWAYS_DENY on the
// sync outbox server-side (apps/api/src/lib/syncPolicy.ts) — every PIN write
// below is a dedicated online-only REST round-trip instead, exactly like the
// old app.
//
// Callers (users/index.tsx, UserQuickAdd) wrap `runInTransaction(() => {
// setXxx(...); appendLog({...}); })` themselves for the offline-capable writes
// — mirrors the old app's users.tsx exactly, and works because
// runInTransaction is reentrant: each mirror()/update() call below just joins
// the caller's outer transaction instead of committing separately.
import { getDb, rowsAs, bindParams } from '../db/schema';
import { createRepository, queueTableBump } from '@invenpro/core';
import { UserRole, ROLE_TIER, resolveRoleColor } from '../constants/roles';
import { getValidJwt } from '../auth/session';

const API_BASE = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';

const usersRepo = createRepository('users');

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
  phone?: string | null; // normalized: optional leading '+', 7–15 digits (migration 049)
  dashboard_preset_id?: string | null; // TODO(wave-D): dashboard preset engine is cut this wave; column kept for schema parity, unused by any v2 UI.
  is_test?: number; // 1 = public demo account (sandboxed session, code shown at login)
  enrollment_code_public?: string | null; // display-only; non-null only when is_test
  created_at: string;
  updated_at: string;
  synced_at: string | null;
}

// ── Reads ────────────────────────────────────────────────────────────────

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
// <= now+days). Drives the temp-employee-expiry local alert.
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

// Active users of a given role — e.g. the production-manager dropdown in checkout.
export function getUsersByRole(role: string): User[] {
  const db = getDb();
  const result = db.executeSync(
    `SELECT * FROM users WHERE active = 1 AND role = ? ORDER BY name`,
    [role]
  );
  return rowsAs<User>(result.rows);
}

// Active user count for a role — the "this affects N users" line in the role
// editor's impact-preview confirm.
export function getActiveUserCountByRole(role: string): number {
  return getUsersByRole(role).length;
}

// Active users at manager tier (ROLE_TIER >= 2) — the checkout "Manager"
// destination.
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

// Role display-color helper kept here too (screens importing users.ts for the
// roster already have it in scope); the canonical color read/write lives in
// ./roleSettings.ts.
export function roleColor(role: string, map?: Record<string, string>): string {
  return resolveRoleColor(role, map?.[role]);
}

// ── Online-only writes (PIN columns can never travel the sync outbox) ──────

// User creation is ONLINE-ONLY: the server creates the account (the employee
// sets their own PIN at first sign-in) — the raw PIN never touches the device
// DB or the sync outbox, and pin_hash is NOT NULL server-side so a generic
// outbox INSERT would fail. The returned row (sans pin_hash) is mirrored
// locally (no outbox — the server already has it) for immediate display.
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
  queueTableBump('users');
  return created.id;
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
// columns), so THIS case must go through a REST PATCH instead of the outbox —
// same as resetUserPinOnline. A same-length role change should NOT call this —
// it stays on the offline-capable setUserRole below.
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

// Mirror a changeRoleOnline result into the local row (role + the new
// pin_length_required) and mark the PIN reset locally — the change already
// landed server-side, so this is local-cache-only, no outbox entry (mirrors
// createUserOnline's "no re-push" reasoning).
export function applyOnlineRoleChange(userId: string, role: UserRole, pinLengthRequired: number): void {
  getDb().executeSync(
    `UPDATE users SET role = ?, pin_length_required = ?, pin_set = 0 WHERE id = ?`,
    [role, pinLengthRequired, userId],
  );
  queueTableBump('users');
}

// PIN reset is server-only: only the API can clear the bcrypt hash (it never
// lives on the device). After this the user re-sets their own PIN on next login.
export async function resetUserPinOnline(userId: string): Promise<void> {
  const jwt = await getValidJwt();
  if (!jwt) throw new Error('Connect to the server to reset a PIN.');
  const res = await fetch(`${API_BASE}/users/${userId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ reset_pin: true }),
  });
  if (!res.ok) {
    throw new Error(res.status === 403 ? 'You do not have permission to reset PINs.' : `Could not reset PIN (${res.status}).`);
  }
  markUserPinReset(userId);
}

// Reissue a one-time enrollment code for a not-yet-onboarded user. Online-only
// (mirrors resetUserPinOnline/createUserOnline): the server hashes the new code
// and returns the plaintext so the admin can hand it off directly. If an email
// is available (stored or overridden), the server also attempts delivery.
export async function resetEnrollmentCodeOnline(
  userId: string,
  email?: string,
): Promise<{ emailed: boolean; code: string }> {
  const jwt = await getValidJwt();
  if (!jwt) throw new Error('Connect to the server to reset an access code.');
  const res = await fetch(`${API_BASE}/users/${userId}/reset-enrollment-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
    body: JSON.stringify(email ? { email } : {}),
  });
  if (!res.ok) {
    if (res.status === 403) throw new Error('You do not have permission to reset access codes.');
    if (res.status === 409) throw new Error('This user has already set a PIN. Use Reset PIN instead.');
    throw new Error(`Could not reset access code (${res.status}).`);
  }
  return res.json() as Promise<{ emailed: boolean; code: string }>;
}

// ── Local-only writes (never mirrored — pin_set is server-authoritative) ───

// Mark a user's PIN as set locally right after first-login setup, so we don't
// re-prompt before the next sync round-trip confirms it server-side.
export function markUserPinSet(userId: string, pinLength: number): void {
  getDb().executeSync(
    `UPDATE users SET pin_set = 1, pin_length_required = ? WHERE id = ?`,
    [pinLength, userId]
  );
  queueTableBump('users');
}

// Mark a user's PIN as cleared locally after an admin reset, so this device
// reflects it immediately (other devices pick it up on the next pull).
export function markUserPinReset(userId: string): void {
  getDb().executeSync(`UPDATE users SET pin_set = 0 WHERE id = ?`, [userId]);
  queueTableBump('users');
}

// ── Offline-capable, outbox-mirrored writes ─────────────────────────────────

export function setUserActive(id: string, active: boolean): string {
  const now = new Date().toISOString();
  usersRepo.update({ id, active, updated_at: now });
  return now;
}

// Generic partial edit (name/email/expires_at, and — ONLY for a same-length
// role change — role/pin_length_required together). Callers build the diff
// dict themselves (mirrors the old app's users.tsx `otherFields`).
type EditableUserFields = Partial<Pick<User, 'name' | 'role' | 'active' | 'expires_at' | 'pin_length_required' | 'email' | 'phone'>>;
export function saveUserFields(id: string, fields: EditableUserFields): string {
  const now = new Date().toISOString();
  usersRepo.update({ id, ...fields, updated_at: now });
  return now;
}

// A role change must also move pin_length_required to the new role's minimum —
// the caller passes the resolved minimum (roleMinPins[role] ??
// PIN_LENGTH_BY_TIER[ROLE_TIER[role]]) so this layer stays free of the
// role-settings cache. Only call this for a SAME-length change (or no length
// check needed) — a different-length change must go through changeRoleOnline +
// applyOnlineRoleChange instead (the outbox always denies pin_set writes, so a
// length change here would leave the user's old PIN silently still valid).
export function setUserRole(id: string, role: string, pinLengthRequired?: number): string {
  const now = new Date().toISOString();
  const payload: Record<string, unknown> = { id, role, updated_at: now };
  if (pinLengthRequired != null) payload.pin_length_required = pinLengthRequired;
  usersRepo.mirror('UPDATE', payload, () => {
    if (pinLengthRequired != null) {
      getDb().executeSync(
        `UPDATE users SET role = ?, pin_length_required = ?, updated_at = ? WHERE id = ?`,
        [role, pinLengthRequired, now, id],
      );
    } else {
      getDb().executeSync(`UPDATE users SET role = ?, updated_at = ? WHERE id = ?`, [role, now, id]);
    }
  });
  return now;
}

// Set/clear the FULL permission-overrides map for a user in one write (the
// screen computes the diffed map — toggling a key back to the role's current
// effective value removes it, same "clean reset" rule role_settings uses).
// permission_overrides is TEXT locally but a real JSON object over the outbox
// (same split as role_settings.permission_overrides), so this goes through
// mirror() rather than update().
export function setUserPermissionOverrides(userId: string, overrides: Record<string, boolean>): string {
  const now = new Date().toISOString();
  usersRepo.mirror('UPDATE', { id: userId, permission_overrides: overrides, updated_at: now }, () => {
    getDb().executeSync(
      `UPDATE users SET permission_overrides = ?, updated_at = ? WHERE id = ?`,
      bindParams([JSON.stringify(overrides), now, userId]),
    );
  });
  return now;
}
