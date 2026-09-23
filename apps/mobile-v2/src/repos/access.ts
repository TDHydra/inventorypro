// unit_access domain — ported from apps/mobile/src/db/queries/access.ts (381
// ln) + src/db/queries/unitAccess.ts + src/access/unitGrants.ts. Per-action
// grants (#122 Phase A1/B) on Locker/Vehicle UNIT locations — who besides the
// owner/owning team can view/add/remove/move/edit/grant inside one.
//
// Station C3 (Wave C): un-stubbed the Vehicle-coupled access surface Station
// B3 had left as a stub — getAccessibleSourceLocations, getTeamUnits,
// getCheckoutSourceLocations, isTeamManagerAnywhere, getVisibleUnits,
// canManageVehicle, canLiftVehicleLockFor all ported below (import-mapping
// only from apps/mobile/src/db/queries/access.ts); getGrantableUnits widened
// back to Vehicle ∪ Locker (was Locker-only). getAllUnitAccessGrants (admin
// grants-list) stays Locker-only — that surface's own scope, not part of this
// station's brief. getAccessibleLocationIds/canSeeAllUnitsInManage are
// inlined as private helpers below (ported from the old app's pure kernel,
// src/access/accessResolution.ts) rather than a separate module — same
// reasoning as isUnitInventoryBlocked's existing inline precedent in this
// file: only this file's functions need them.
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
import {
  getAllLocations, getLocationById, getUnitLocations, getNonShelfLocations,
  isUnitLocation, type Location,
} from './locations';
import { getDefaultActionsForRole } from '../db/unitAccessDefaults';
import { canLiftVehicleLock } from '../components/vehicles/vehicleSessionLogic';

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
 * per unit). Vehicle ∪ Locker (Station C3: widened back from Locker-only —
 * see header note).
 */
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

// ── Access resolution (Station C3) ──────────────────────────────────────────
// The DB-backed wrapper around the pure access kernel, inlined below
// (getAccessibleLocationIds/canSeeAllUnitsInManage — ported from the old
// app's src/access/accessResolution.ts) since only this file's functions
// need them (same reasoning as isUnitInventoryBlocked's existing inline
// precedent further down this file).

interface AccessLockerRow { id: string; ownerUserId: string | null; }
interface AccessGrantRow { locationId: string; userId: string; }
interface TeamMemberRow { teamId: string; userId: string; }

/**
 * The Set of location ids from `lockers` that `userId` may access: owned by
 * them, explicitly granted to them via unit_access, or owned by any user who
 * shares at least one parent team with them. Grants pointing at locations not
 * present in `lockers` are ignored (stale grant / non-asset location).
 * Ownerless lockers are reachable only via an explicit grant.
 */
function getAccessibleLocationIds(
  input: { lockers: AccessLockerRow[]; grants: AccessGrantRow[]; teamMembers: TeamMemberRow[] },
  userId: string,
): Set<string> {
  const { lockers, grants, teamMembers } = input;
  const lockerIds = new Set(lockers.map(l => l.id));

  const myTeamIds = new Set<string>();
  for (const tm of teamMembers) {
    if (tm.userId === userId) myTeamIds.add(tm.teamId);
  }
  const teammateIds = new Set<string>();
  for (const tm of teamMembers) {
    if (myTeamIds.has(tm.teamId)) teammateIds.add(tm.userId);
  }

  const accessible = new Set<string>();
  for (const locker of lockers) {
    if (locker.ownerUserId === null) continue;
    if (locker.ownerUserId === userId || teammateIds.has(locker.ownerUserId)) {
      accessible.add(locker.id);
    }
  }
  for (const grant of grants) {
    if (grant.userId === userId && lockerIds.has(grant.locationId)) {
      accessible.add(grant.locationId);
    }
  }
  return accessible;
}

/**
 * #130 (Frank's Locker invisible to Matt): manage contexts list ALL units for
 * tier-3+ org authority, Production Managers (tier 2 — the spec names them),
 * team managers (team_members.is_manager), and unit owners. Day-to-day
 * surfaces (fast-checkout picker) keep using getAccessibleLocationIds —
 * explicit visibility via unit_access.can_view.
 */
function canSeeAllUnitsInManage(ctx: { roleTier: number; isTeamManager: boolean; ownsAnyUnit: boolean; isProductionManager: boolean }): boolean {
  return ctx.roleTier >= 3 || ctx.isProductionManager || ctx.isTeamManager || ctx.ownsAnyUnit;
}

/** Shared row loader for getAccessibleSourceLocations / getTeamUnits. */
function loadUnitAccessRows(): { assets: Location[]; grants: AccessGrantRow[]; teamMembers: TeamMemberRow[] } {
  const db = getDb();
  const assets = getAllLocations().filter(l => l.type === 'Locker' || l.type === 'Vehicle');
  const grants: AccessGrantRow[] = rowsAs<{ location_id: string; user_id: string }>(
    db.executeSync(`SELECT location_id, user_id FROM unit_access WHERE can_view = 1`).rows,
  ).map(g => ({ locationId: g.location_id, userId: g.user_id }));
  const teamMembers: TeamMemberRow[] = rowsAs<{ team_id: string; user_id: string }>(
    db.executeSync(`SELECT team_id, user_id FROM team_members`).rows,
  ).map(tm => ({ teamId: tm.team_id, userId: tm.user_id }));
  return { assets, grants, teamMembers };
}

export interface AccessibleSourceLocations {
  lockers: Location[];
  vehicles: Location[];
}

/**
 * The Locker- and Vehicle-typed locations `userId` may work from, partitioned
 * by type. Access = owned by them ∪ granted via unit_access (can_view = 1) ∪
 * owned by any user sharing a parent team with them (whole team, not just the
 * subteam). Backs the fast-checkout source picker and Manage My Team. NOTE:
 * org-authority (tier 3+) bypass is deliberately NOT applied here — the
 * picker shows an admin their own assets, not every locker in the org.
 *
 * #157: VEHICLES are exempt from the access filter — every Vehicle-kind unit
 * is visible to everyone (whoever needs the van can find it); the owner's
 * checkout_locked flag gates the checkout ACTION instead (repos/vehicles.ts
 * isCheckoutLockedFor). Locker behavior is unchanged.
 */
export function getAccessibleSourceLocations(userId: string): AccessibleSourceLocations {
  const { assets, grants, teamMembers } = loadUnitAccessRows();
  const lockerRows: AccessLockerRow[] = assets.map(l => ({ id: l.id, ownerUserId: l.owner_user_id }));
  const accessible = getAccessibleLocationIds({ lockers: lockerRows, grants, teamMembers }, userId);

  const lockers: Location[] = [];
  const vehicles: Location[] = [];
  for (const loc of assets) {
    if (loc.type === 'Vehicle') {
      vehicles.push(loc); // #157: all vehicles, regardless of ownership/grants
      continue;
    }
    if (accessible.has(loc.id)) lockers.push(loc);
  }
  return { lockers, vehicles };
}

/**
 * The kind-filtered unit set the pure KERNEL grants — owned by me ∪ granted
 * via unit_access (can_view = 1) ∪ owned by anyone sharing a parent team with
 * me — WITHOUT the #157 all-vehicles bypass. Backs the "Team Vehicles"
 * segment on the Vehicles screen; getAccessibleSourceLocations/
 * getVisibleUnits keep the bypass for every other caller. Additive only —
 * nothing else routes through this.
 */
export function getTeamUnits(user: UserSession, kind: 'Vehicle' | 'Locker'): Location[] {
  const { assets, grants, teamMembers } = loadUnitAccessRows();
  const lockerRows: AccessLockerRow[] = assets.map(l => ({ id: l.id, ownerUserId: l.owner_user_id }));
  const accessible = getAccessibleLocationIds({ lockers: lockerRows, grants, teamMembers }, user.id);
  return assets.filter(l => l.type === kind && accessible.has(l.id));
}

export interface CheckoutSources {
  /** Main stock-holding locations (role-gated at the screen; no per-object ACL). */
  locations: Location[];
  lockers: Location[];
  vehicles: Location[];
}

/**
 * #139 source taxonomy: the full Location ∪ Vehicle ∪ Locker source set for
 * the fast-checkout picker. Units come from the access-gated resolver (owned
 * ∪ granted ∪ teammate); main locations are added explicitly and gated by
 * role only. Kept separate from getAccessibleSourceLocations so Manage My
 * Team / getVisibleUnits (units only) are unaffected.
 * #158: ALL active TYPED main locations (incl. empty ones), not just
 * stock-holding ones — see getNonShelfLocations' own doc.
 */
export function getCheckoutSourceLocations(userId: string): CheckoutSources {
  const units = getAccessibleSourceLocations(userId);
  return {
    locations: getNonShelfLocations(),
    lockers: units.lockers,
    vehicles: units.vehicles,
  };
}

// ── Unit visibility (#130) ───────────────────────────────────────────────────

export function isTeamManagerAnywhere(userId: string): boolean {
  const db = getDb();
  return (rowsAs<{ n: number }>(db.executeSync(
    `SELECT COUNT(*) AS n FROM team_members WHERE user_id = ? AND is_manager = 1`, [userId],
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

/**
 * Locker access-management authority (Station C3, ported from apps/mobile's
 * canManageLockerAccess): owner or tier-3+ org authority — the exact mirror
 * of the server's locker_access write guard (routes/sync.ts). Unknown roles
 * fail closed.
 */
export function canManageLockerAccess(
  user: UserSession | null | undefined,
  location: Pick<Location, 'owner_user_id'> | null | undefined,
): boolean {
  if (!user || !location) return false;
  if (location.owner_user_id !== null && location.owner_user_id === user.id) return true;
  return (ROLE_TIER[user.role] ?? 0) >= 3;
}

/**
 * #165: vehicle management authority — lock/unlock checkout, bypass a lock,
 * edit state. Owner and tier-3+ (same as canManageLockerAccess), PLUS tier-2
 * managers for vehicles owned by someone on one of their teams ("their team's
 * vehicles" — the PM slice of the #156 device review).
 */
export function canManageVehicle(
  user: UserSession | null | undefined,
  location: Pick<Location, 'owner_user_id'> | null | undefined,
): boolean {
  if (!user || !location) return false;
  if (location.owner_user_id !== null && location.owner_user_id === user.id) return true;
  const tier = ROLE_TIER[user.role] ?? 0;
  if (tier >= 3) return true;
  return tier >= 2 && sharesTeamWithOwner(user.id, location.owner_user_id);
}

/**
 * #167: may `user` lift the vehicle's current lock (and therefore flip the
 * toggle OFF / bypass it)? Unlocked → true (locking ON is gated by
 * canManageVehicle alone). Locker tier resolves from their CURRENT role;
 * a deleted locker resolves to tier 0. SQL twin: isCheckoutLockedFor
 * (repos/vehicles.ts) — kept in sync manually.
 */
export function canLiftVehicleLockFor(
  user: UserSession | null | undefined,
  location: Pick<Location, 'owner_user_id'> | null | undefined,
  vehicle: { checkout_locked: number; locked_by: string | null } | null | undefined,
): boolean {
  if (!user || !location) return false;
  if (!vehicle?.checkout_locked) return true;
  let lockerRole: string | null = null;
  if (vehicle.locked_by) {
    lockerRole = rowsAs<{ role: string | null }>(getDb().executeSync(
      `SELECT role FROM users WHERE id = ?`, [vehicle.locked_by],
    ).rows)[0]?.role ?? null;
  }
  return canLiftVehicleLock({
    canManage: canManageVehicle(user, location),
    lockedBy: vehicle.locked_by,
    lockerTier: ROLE_TIER[lockerRole as UserRole] ?? 0,
    userId: user.id,
    userTier: ROLE_TIER[user.role] ?? 0,
  });
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
