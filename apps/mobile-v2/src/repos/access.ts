// unit_access domain — ported from apps/mobile/src/db/queries/access.ts (381
// ln) + src/db/queries/unitAccess.ts + src/access/unitGrants.ts. Per-action
// grants (#122 Phase A1/B) on Locker/Vehicle UNIT locations — who besides the
// owner/owning team can view/add/remove/move/edit/grant inside one.
//
// SCOPE THIS STATION (Station B3): Vehicle-coupled surfaces are OUT — vehicles
// aren't ported to mobile-v2 at all yet (see repos/locations.ts's own PORT
// NOTE). Cut from this port: getAccessibleSourceLocations, getTeamUnits,
// getCheckoutSourceLocations, getVisibleUnits, canManageVehicle,
// canLiftVehicleLockFor (all Vehicle-coupled — TODO(wave-C), same wave as
// locations.ts's findOrCreateVehicleByName/retireVehicle). getGrantableUnits
// below is trimmed to Locker-type units only (was Vehicle ∪ Locker).
//
// Self-log convention (DIVERGENCE from the old app): old db/queries/
// unitAccess.ts's upsertUnitAccess/revokeUnitAccess called appendLog
// internally (unit_access_granted / unit_access_revoked). Every other B1/B2
// repo in this codebase (users.ts, teams.ts, locations.ts's mirror-based
// writes) does NOT self-log — callers wrap
// `runInTransaction(() => { repoFn(...); appendLog({...}); })` themselves.
// Applied that same convention here for consistency: upsertUnitAccess/
// revokeUnitAccess below do NOT call appendLog. Callers (MemberPermissionsSheet,
// myteam.tsx "My Lockers", access/index.tsx) own the appendLog call, using the
// exact old action names/metadata shapes documented on each function below.
//
// Outbox payload booleans: per the established convention (teams.ts's
// addTeamMember, `is_manager: false`), RAW booleans go into outbox payloads —
// bindParams (local SQL binding) converts to 0/1 for us; appendOutbox's raw
// JSON.stringify preserves true/false. This is a DIVERGENCE from the old
// app's explicit `b(v) => v ? 1 : 0` — that conversion is unnecessary here
// (the outbox JSON literal true/false round-trips fine server-side).
import { getDb, rowsAs } from '../db/schema';
import { createRepository } from '@invenpro/core';
import type { UserSession } from '../auth/permissions';
import { ROLE_TIER, ROLE_DEFAULTS } from '../constants/roles';
import type { UserRole } from '../constants/roles';
import { canManageUnitAccess } from '../access/unitAccessPolicy';
import { getAllLocations, getLocationById, isUnitLocation, type Location } from './locations';
import { getDefaultActionsForRole } from '../db/unitAccessDefaults';

const accessRepo = createRepository('unit_access');

// ── Types ────────────────────────────────────────────────────────────────

export interface UnitAccessRow {
  location_id: string; user_id: string;
  can_view: number; can_add: number; can_remove: number; can_move: number;
  can_edit_details: number; can_grant: number;
  granted_by: string | null; created_at: string; updated_at: string;
  synced_at: string | null; // local-only
  user_name?: string | null; // present on getUnitAccessRows reads
}

export interface UnitPerms {
  view: boolean; add: boolean; remove: boolean; move: boolean;
  editDetails: boolean; grant: boolean;
}

/** Grant flags accept booleans or raw 0/1 (callers spread stored rows in). */
export type AccessFlag = boolean | 0 | 1;

export interface UnitAccessUpsert {
  location_id: string; user_id: string;
  can_view: AccessFlag; can_add: AccessFlag; can_remove: AccessFlag; can_move: AccessFlag;
  can_edit_details: AccessFlag; can_grant: AccessFlag;
  granted_by: string | null;
  /** Optional — defaulted to now when absent; grant EDITS may carry the original created_at. */
  created_at?: string; updated_at?: string;
}

export interface UserUnitGrant {
  location_id: string; user_id: string;
  can_view: number; can_add: number; can_remove: number; can_move: number;
  can_edit_details: number; can_grant: number;
  granted_by: string | null; created_at: string; updated_at: string;
  location_name: string; location_type: string; owner_user_id: string | null;
}

export interface UnitInventoryLock {
  locked: boolean;
  /** Human lock reason, e.g. "🔒 Team inventory — Mitigation". Null when unlocked. */
  reason: string | null;
}

const UNLOCKED: UnitInventoryLock = { locked: false, reason: null };

// ── Reads: grants on a unit / for a user ────────────────────────────────────

/** Every grant on a unit, with user names, name order (access-panel listing). */
export function getUnitAccessRows(locationId: string): UnitAccessRow[] {
  const db = getDb();
  return rowsAs<UnitAccessRow>(db.executeSync(
    `SELECT ua.*, u.name AS user_name
       FROM unit_access ua LEFT JOIN users u ON u.id = ua.user_id
      WHERE ua.location_id = ?
      ORDER BY u.name, ua.user_id`,
    [locationId],
  ).rows);
}

/** One user's per-action perms on one unit. No row → all false (fail closed). */
export function getUserUnitPerms(userId: string, locationId: string): UnitPerms {
  const db = getDb();
  const r = rowsAs<UnitAccessRow>(db.executeSync(
    `SELECT * FROM unit_access WHERE location_id = ? AND user_id = ?`,
    [locationId, userId],
  ).rows)[0];
  return {
    view: !!r?.can_view, add: !!r?.can_add, remove: !!r?.can_remove,
    move: !!r?.can_move, editDetails: !!r?.can_edit_details, grant: !!r?.can_grant,
  };
}

/** Every unit_access grant `userId` holds, joined with the unit it's on. */
export function getUserUnitGrants(userId: string): UserUnitGrant[] {
  const db = getDb();
  return rowsAs<UserUnitGrant>(db.executeSync(
    `SELECT ua.location_id, ua.user_id, ua.can_view, ua.can_add, ua.can_remove, ua.can_move,
            ua.can_edit_details, ua.can_grant, ua.granted_by, ua.created_at, ua.updated_at,
            l.name AS location_name, l.type AS location_type, l.owner_user_id
       FROM unit_access ua
       JOIN locations l ON l.id = ua.location_id
      WHERE ua.user_id = ? AND l.active = 1
      ORDER BY l.type, l.name`,
    [userId],
  ).rows);
}

/**
 * Every grant across every ACTIVE Locker unit, joined with the unit + grantee
 * name — backs the new admin `access/index.tsx` surface (list grants with
 * filters). Vehicle units are excluded (out of scope this station — see the
 * header PORT NOTE).
 */
export function getAllUnitAccessGrants(): UserUnitGrant[] {
  const db = getDb();
  return rowsAs<UserUnitGrant>(db.executeSync(
    `SELECT ua.location_id, ua.user_id, ua.can_view, ua.can_add, ua.can_remove, ua.can_move,
            ua.can_edit_details, ua.can_grant, ua.granted_by, ua.created_at, ua.updated_at,
            l.name AS location_name, l.type AS location_type, l.owner_user_id
       FROM unit_access ua
       JOIN locations l ON l.id = ua.location_id
      WHERE l.active = 1 AND l.type = 'Locker'
      ORDER BY l.name, ua.user_id`,
  ).rows);
}

/** User ids who share a team on which `callerId` is a manager (is_manager=1). */
export function getManagedOwnerIds(callerId: string): Set<string> {
  const db = getDb();
  const rows = rowsAs<{ user_id: string }>(db.executeSync(
    `SELECT DISTINCT om.user_id
       FROM team_members om
       JOIN team_members cm ON cm.team_id = om.team_id
      WHERE cm.user_id = ? AND cm.is_manager = 1`,
    [callerId],
  ).rows);
  return new Set(rows.map(r => r.user_id));
}

/**
 * Units `user` may create a grant on for `granteeRole` (canManageUnitAccess
 * per unit). Trimmed to Locker-type units this station — Vehicle grants are
 * out of scope (see header PORT NOTE).
 */
export function getGrantableUnits(user: UserSession, granteeRole: string | null): Location[] {
  const managed = getManagedOwnerIds(user.id);
  return getAllLocations()
    .filter(l => l.type === 'Locker')
    .filter(l => canManageUnitAccess({
      callerId: user.id,
      callerRole: user.role,
      ownerUserId: l.owner_user_id,
      callerManagesOwnersTeam: l.owner_user_id != null && managed.has(l.owner_user_id),
      granteeRole,
    }));
}

// ── Writes: grant / revoke ──────────────────────────────────────────────────
// NO appendLog here — see the header comment. Callers own the activity log
// (action 'unit_access_granted' / 'unit_access_revoked', same metadata shapes
// as the old app — see each function's doc below).

/**
 * Create or edit a grant. Local upsert (composite PK location_id+user_id) +
 * outbox INSERT (the server upserts on the same conflict target and
 * re-forces granted_by to the caller). created_at/updated_at default to now
 * when the caller doesn't supply them (grant EDITS should pass the original
 * created_at through — see MemberPermissionsSheet's toggleUnitAction).
 *
 * Caller must log (old shape):
 *   action: 'unit_access_granted', entity_type: 'location', entity_id: location_id,
 *   metadata: { grantee_user_id: user_id, actions: { view, add, remove, move, edit_details, grant } }
 */
export function upsertUnitAccess(row: UnitAccessUpsert): void {
  const now = new Date().toISOString();
  accessRepo.insert({
    location_id: row.location_id,
    user_id: row.user_id,
    can_view: !!row.can_view,
    can_add: !!row.can_add,
    can_remove: !!row.can_remove,
    can_move: !!row.can_move,
    can_edit_details: !!row.can_edit_details,
    can_grant: !!row.can_grant,
    granted_by: row.granted_by,
    created_at: row.created_at ?? now,
    updated_at: row.updated_at ?? now,
  });
}

/**
 * Delete a grant. Composite-key outbox DELETE.
 *
 * Caller must log (old shape):
 *   action: 'unit_access_revoked', entity_type: 'location', entity_id: locationId,
 *   metadata: { grantee_user_id: userId }
 */
export function revokeUnitAccess(locationId: string, userId: string): void {
  accessRepo.remove({ location_id: locationId, user_id: userId });
}

/**
 * Create a grant with the admin's per-role defaults auto-applied (#122 Phase
 * B). Caller still owns the appendLog — see upsertUnitAccess's doc.
 */
export function grantUnitAccessWithDefaults(
  locationId: string, userId: string, granteeRole: string, actorUserId: string | null,
): void {
  const actions = getDefaultActionsForRole(granteeRole);
  const now = new Date().toISOString();
  upsertUnitAccess({
    location_id: locationId, user_id: userId,
    can_view: actions.view, can_add: actions.add, can_remove: actions.remove,
    can_move: actions.move, can_edit_details: actions.editDetails, can_grant: actions.grant,
    granted_by: actorUserId, created_at: now, updated_at: now,
  });
}

// ── #162 team-scoped unit inventory lock ────────────────────────────────────

/** The owning team's display label for a lock reason: the owner's team
 * name(s), falling back to the owner's name when they're on no team. */
function ownerTeamLabel(ownerUserId: string): string {
  const db = getDb();
  const teams = rowsAs<{ name: string }>(db.executeSync(
    `SELECT DISTINCT t.name FROM teams t
       JOIN team_members tm ON tm.team_id = t.id
      WHERE tm.user_id = ? ORDER BY t.name`,
    [ownerUserId],
  ).rows).map(r => r.name);
  if (teams.length > 0) return teams.join(', ');
  const owner = rowsAs<{ name: string }>(db.executeSync(
    `SELECT name FROM users WHERE id = ?`, [ownerUserId],
  ).rows)[0];
  return owner ? `${owner.name}'s team` : 'another team';
}

export function sharesTeamWithOwner(userId: string, ownerUserId: string | null): boolean {
  if (!ownerUserId) return false;
  if (ownerUserId === userId) return true;
  const db = getDb();
  return (rowsAs<{ n: number }>(db.executeSync(
    `SELECT COUNT(*) AS n FROM team_members a JOIN team_members b ON b.team_id = a.team_id
      WHERE a.user_id = ? AND b.user_id = ?`, [userId, ownerUserId],
  ).rows)[0]?.n ?? 0) > 0;
}

/**
 * manage_other_team_inventory for one actor, resolved the way the SERVER
 * resolves it for sync-push authorization: role default → role_settings
 * override → user override. Team-level overrides are deliberately not
 * consulted (excluded from TEAM_OVERRIDABLE_PERMISSIONS on both sides).
 * Resolved via direct SQL (not auth/permissions.hasPermission) so this stays
 * free of the session/secure-store import graph, same as the old app.
 */
function hasCrossTeamPerm(role: string, userOverrides: Record<string, boolean> | null): boolean {
  const PERM = 'manage_other_team_inventory';
  let result = ROLE_DEFAULTS[role as UserRole]?.[PERM] ?? false;
  try {
    const row = rowsAs<{ permission_overrides: string | null }>(getDb().executeSync(
      `SELECT permission_overrides FROM role_settings WHERE role = ?`, [role],
    ).rows)[0];
    const roleOv = row?.permission_overrides
      ? JSON.parse(row.permission_overrides) as Record<string, boolean>
      : null;
    if (roleOv && PERM in roleOv) result = !!roleOv[PERM];
  } catch { /* role_settings missing/unparsable — keep the role default */ }
  if (userOverrides && PERM in userOverrides) result = !!userOverrides[PERM];
  return result;
}

/**
 * Pure gate, inlined from the old app's access/accessResolution.ts
 * (isUnitInventoryBlocked) — only 2 call sites need it here (getUnitInventoryLock
 * / getUnitInventoryLockForUserId below), and the testDb.ts harness already
 * handles RN-import isolation for this whole repo file, so a separate pure-
 * kernel module isn't worth splitting out this station.
 */
function isUnitInventoryBlocked(input: {
  isUnit: boolean; ownerUserId: string | null; actorSharesOwnerTeam: boolean; hasCrossTeamPerm: boolean;
}): boolean {
  if (input.hasCrossTeamPerm) return false;
  if (!input.isUnit) return false;              // main locations unrestricted
  if (input.ownerUserId === null) return false; // ownerless units unrestricted
  if (input.actorSharesOwnerTeam) return false; // own / own-team unit
  return true;
}

/**
 * #162: may `user` manage inventory INTO/OUT OF `locationId`? Locked only
 * when the location is a UNIT (Vehicle/Locker) owned by a user on a team
 * `user` doesn't share, and `user` lacks manage_other_team_inventory. Main
 * locations, ownerless units, unknown ids and null ids are all unlocked — the
 * exact mirror of the server's foreignTeamUnitBlocked guard, so what the UI
 * locks locally is what the server rejects on push.
 */
export function getUnitInventoryLock(
  user: UserSession | null | undefined,
  locationId: string | null | undefined,
): UnitInventoryLock {
  if (!user || !locationId) return UNLOCKED;
  const loc = getLocationById(locationId);
  if (!loc || !isUnitLocation(loc) || loc.owner_user_id == null) return UNLOCKED;
  const blocked = isUnitInventoryBlocked({
    isUnit: true,
    ownerUserId: loc.owner_user_id,
    actorSharesOwnerTeam: sharesTeamWithOwner(user.id, loc.owner_user_id),
    hasCrossTeamPerm: hasCrossTeamPerm(user.role, user.permission_overrides ?? null),
  });
  if (!blocked) return UNLOCKED;
  return { locked: true, reason: `🔒 Team inventory — ${ownerTeamLabel(loc.owner_user_id)}` };
}

/**
 * getUnitInventoryLock for call sites that only carry a user id (e.g. the
 * quickadd/move-stock funnels). Resolves the actor's row from the local DB;
 * an unknown or null actor is unlocked locally (the server still enforces on push).
 */
export function getUnitInventoryLockForUserId(
  userId: string | null | undefined,
  locationId: string | null | undefined,
): UnitInventoryLock {
  if (!userId || !locationId) return UNLOCKED;
  const u = rowsAs<{ id: string; name: string; role: string; permission_overrides: string | null }>(
    getDb().executeSync(
      `SELECT id, name, role, permission_overrides FROM users WHERE id = ?`, [userId],
    ).rows,
  )[0];
  if (!u) return UNLOCKED;
  let overrides: Record<string, boolean> | null = null;
  try { overrides = u.permission_overrides ? JSON.parse(u.permission_overrides) : null; } catch { overrides = null; }
  return getUnitInventoryLock(
    { id: u.id, role: u.role as UserRole, permission_overrides: overrides ?? {} } as UserSession,
    locationId,
  );
}
