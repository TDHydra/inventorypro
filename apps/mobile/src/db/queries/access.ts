import { getDb, rowsAs, bindParams } from '../schema';
import { appendOutbox } from '../../sync/outbox';
import { appendLog } from './log';
import { runInTransaction } from '../tx';
import {
  getAccessibleLocationIds,
  canSeeAllUnitsInManage,
  AccessLockerRow,
  AccessGrantRow,
  TeamMemberRow,
} from '../../access/accessResolution';
import { getAllLocations, getUnitLocations, isUnitLocation, Location } from './locations';
import { ROLE_TIER } from '../../constants/roles';
import type { UserSession } from '../../auth/permissions';
import { canManageUnitAccess } from '../../access/unitAccessPolicy';

// Locker/vehicle access queries (#126) — the DB-backed wrapper around the pure
// access kernel in src/access/accessResolution.ts. The kernel mirrors the
// server's negative-delta ADJUST guard on Locker-typed locations exactly
// (owned ∪ granted ∪ owned-by-anyone-sharing-a-parent-team ∪ org authority is
// server-side only), so what these queries surface locally is what the server
// will accept on push. locker_access writes are hard-enforced server-side:
// only locations.owner_user_id or tier-3+ org authority may grant/revoke.

// ── Access resolution ────────────────────────────────────────────────────────

export interface AccessibleSourceLocations {
  lockers: Location[];
  vehicles: Location[];
}

/**
 * The Locker- and Vehicle-typed locations `userId` may work from, partitioned
 * by type. Access = owned by them ∪ granted via unit_access (can_view = 1;
 * #122 Phase A1 — locker_access stays on disk, deprecated, no longer read
 * here) ∪ owned by any
 * user sharing a parent team with them (user decision 2026-07-18: whole team,
 * not just the subteam). Backs the fast-checkout source picker and Manage My
 * Team. NOTE: org-authority (tier 3+) bypass is deliberately NOT applied here
 * — the picker shows an admin their own assets, not every locker in the org.
 */
export function getAccessibleSourceLocations(userId: string): AccessibleSourceLocations {
  const db = getDb();
  const assets = getAllLocations().filter(l => l.type === 'Locker' || l.type === 'Vehicle');

  const lockerRows: AccessLockerRow[] = assets.map(l => ({
    id: l.id,
    ownerUserId: l.owner_user_id,
  }));
  const grants: AccessGrantRow[] = rowsAs<{ location_id: string; user_id: string }>(
    db.executeSync(`SELECT location_id, user_id FROM unit_access WHERE can_view = 1`).rows,
  ).map(g => ({ locationId: g.location_id, userId: g.user_id }));
  const teamMembers: TeamMemberRow[] = rowsAs<{ team_id: string; user_id: string }>(
    db.executeSync(`SELECT team_id, user_id FROM team_members`).rows,
  ).map(tm => ({ teamId: tm.team_id, userId: tm.user_id }));

  const accessible = getAccessibleLocationIds({ lockers: lockerRows, grants, teamMembers }, userId);

  const lockers: Location[] = [];
  const vehicles: Location[] = [];
  for (const loc of assets) {
    if (!accessible.has(loc.id)) continue;
    if (loc.type === 'Vehicle') vehicles.push(loc);
    else lockers.push(loc);
  }
  return { lockers, vehicles };
}

// ── Unit visibility (#130) ───────────────────────────────────────────────────

export function isTeamManagerAnywhere(userId: string): boolean {
  const db = getDb();
  return (rowsAs<{ n: number }>(db.executeSync(
    `SELECT COUNT(*) AS n FROM team_members WHERE user_id = ? AND is_manager = 1`, [userId],
  ).rows)[0]?.n ?? 0) > 0;
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

export interface VisibleUnits { units: Location[]; showsAll: boolean; }

/** Unit list for the Vehicles/Lockers screens (#130): full census for managers, accessible-only otherwise. */
export function getVisibleUnits(user: UserSession, kind: 'Vehicle' | 'Locker'): VisibleUnits {
  const ctx = {
    roleTier: ROLE_TIER[user.role] ?? 0,
    isTeamManager: isTeamManagerAnywhere(user.id),
    ownsAnyUnit: getAllLocations().some(l => isUnitLocation(l) && l.owner_user_id === user.id),
    isProductionManager: user.role === 'production_manager',
  };
  if (canSeeAllUnitsInManage(ctx)) return { units: getUnitLocations(kind), showsAll: true };
  const acc = getAccessibleSourceLocations(user.id);
  return { units: kind === 'Vehicle' ? acc.vehicles : acc.lockers, showsAll: false };
}

// ── Access list ──────────────────────────────────────────────────────────────

export interface LockerAccessEntry {
  location_id: string;
  user_id: string;
  granted_by: string | null;
  created_at: string;
  updated_at: string;
  // Joined from users (null when the user row hasn't synced yet)
  user_name: string | null;
  granted_by_name: string | null;
}

/** Explicit locker_access grants for a location, with user names, name order. */
export function getLockerAccessList(locationId: string): LockerAccessEntry[] {
  const db = getDb();
  return rowsAs<LockerAccessEntry>(db.executeSync(
    `SELECT la.location_id, la.user_id, la.granted_by, la.created_at, la.updated_at,
            u.name AS user_name, gb.name AS granted_by_name
       FROM locker_access la
       LEFT JOIN users u ON u.id = la.user_id
       LEFT JOIN users gb ON gb.id = la.granted_by
      WHERE la.location_id = ?
      ORDER BY u.name NULLS LAST, la.user_id`,
    [locationId],
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

export interface UserUnitGrant {
  location_id: string; user_id: string;
  can_view: number; can_add: number; can_remove: number; can_move: number;
  can_edit_details: number; can_grant: number;
  granted_by: string | null; created_at: string; updated_at: string;
  location_name: string; location_type: string; owner_user_id: string | null;
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

/** Units `user` may create a grant on for `granteeRole` (canManageUnitAccess per unit). */
export function getGrantableUnits(user: UserSession, granteeRole: string | null): Location[] {
  const managed = getManagedOwnerIds(user.id);
  return getAllLocations()
    .filter(l => l.type === 'Vehicle' || l.type === 'Locker')
    .filter(l => canManageUnitAccess({
      callerId: user.id,
      callerRole: user.role,
      ownerUserId: l.owner_user_id,
      callerManagesOwnersTeam: l.owner_user_id != null && managed.has(l.owner_user_id),
      granteeRole,
    }));
}

/**
 * Whether `user` may edit the access list of `location`: its owner, or tier-3+
 * org authority — the exact mirror of the server's locker_access write guard
 * (routes/sync.ts). Unknown roles fail closed.
 */
export function canManageLockerAccess(
  user: UserSession | null | undefined,
  location: Pick<Location, 'owner_user_id'> | null | undefined,
): boolean {
  if (!user || !location) return false;
  if (location.owner_user_id !== null && location.owner_user_id === user.id) return true;
  return (ROLE_TIER[user.role] ?? 0) >= 3;
}

// ── Grant / revoke ───────────────────────────────────────────────────────────

function lookupUserName(userId: string): string | null {
  const db = getDb();
  const rows = rowsAs<{ name: string }>(
    db.executeSync(`SELECT name FROM users WHERE id = ?`, [userId]).rows,
  );
  return rows[0]?.name ?? null;
}

/**
 * Grant `userId` access to the locker/vehicle location. Local upsert (composite
 * PK — re-granting refreshes the row) + outbox INSERT + activity log, atomic.
 * The server re-forces granted_by to the authenticated caller (attribution)
 * and rejects the write unless the caller is the location owner or tier-3+.
 */
export function grantLockerAccess(locationId: string, userId: string, actorUserId: string | null): void {
  const now = new Date().toISOString();
  const granteeName = lookupUserName(userId);
  runInTransaction(() => {
    const db = getDb();
    db.executeSync(
      `INSERT OR REPLACE INTO locker_access (location_id, user_id, granted_by, created_at, updated_at, synced_at)
       VALUES (?, ?, ?, ?, ?, NULL)`,
      bindParams([locationId, userId, actorUserId, now, now]),
    );
    appendOutbox('INSERT', 'locker_access', {
      location_id: locationId,
      user_id: userId,
      granted_by: actorUserId,
      created_at: now,
      updated_at: now,
    });
    appendLog({
      action: 'locker_access_granted',
      entity_type: 'location',
      entity_id: locationId,
      user_id: actorUserId,
      team_id: null,
      job_id: null,
      note: granteeName,
      from_location_id: null,
      to_location_id: null,
      quantity: null,
      unit: null,
      metadata: JSON.stringify({ grantee_user_id: userId }),
      device_id: null,
    });
  });
}

/**
 * Revoke `userId`'s access grant. Composite-key DELETE (server matches by
 * {location_id, user_id}) + activity log, atomic. Same server-side guard as
 * grant. Revoking a non-existent grant is a harmless no-op locally; the
 * outbox DELETE converges server-side.
 */
export function revokeLockerAccess(locationId: string, userId: string, actorUserId: string | null): void {
  const revokeeName = lookupUserName(userId);
  runInTransaction(() => {
    const db = getDb();
    db.executeSync(
      `DELETE FROM locker_access WHERE location_id = ? AND user_id = ?`,
      bindParams([locationId, userId]),
    );
    appendOutbox('DELETE', 'locker_access', {
      location_id: locationId,
      user_id: userId,
    });
    appendLog({
      action: 'locker_access_revoked',
      entity_type: 'location',
      entity_id: locationId,
      user_id: actorUserId,
      team_id: null,
      job_id: null,
      note: revokeeName,
      from_location_id: null,
      to_location_id: null,
      quantity: null,
      unit: null,
      metadata: JSON.stringify({ grantee_user_id: userId }),
      device_id: null,
    });
  });
}
