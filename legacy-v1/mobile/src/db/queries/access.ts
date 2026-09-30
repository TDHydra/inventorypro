import { getDb, rowsAs } from '../schema';
import {
  getAccessibleLocationIds,
  canSeeAllUnitsInManage,
  isUnitInventoryBlocked,
  AccessLockerRow,
  AccessGrantRow,
  TeamMemberRow,
} from '../../access/accessResolution';
import {
  getAllLocations, getUnitLocations, isUnitLocation,
  getNonShelfLocations, getLocationById, Location,
} from './locations';
import { ROLE_TIER, ROLE_DEFAULTS, UserRole } from '../../constants/roles';
import type { UserSession } from '../../auth/permissions';
import { canManageUnitAccess } from '../../access/unitAccessPolicy';
import { canLiftVehicleLock } from '../../components/vehicles/vehicleSessionLogic';

// Locker/vehicle access queries (#126) — the DB-backed wrapper around the pure
// access kernel in src/access/accessResolution.ts. The kernel mirrors the
// server's negative-delta ADJUST guard on Locker-typed locations exactly
// (owned ∪ granted ∪ owned-by-anyone-sharing-a-parent-team ∪ org authority is
// server-side only), so what these queries surface locally is what the server
// will accept on push. Grants live in unit_access (#122 Phase A1/B; the old
// locker_access read/write trio was deleted in Phase B — queries/unitAccess.ts
// and access/unitGrants.ts own grant writes now).

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
 *
 * #157: VEHICLES are exempt from the access filter — every Vehicle-kind unit
 * is visible to everyone (whoever needs the van can find it); the owner's
 * checkout_locked flag gates the checkout ACTION instead (queries/vehicles.ts
 * isCheckoutLockedFor). Locker behavior is unchanged.
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
 * segment on the Vehicles screen; getAccessibleSourceLocations /
 * getVisibleUnits keep the bypass for every other caller. Additive only —
 * nothing else routes through this.
 */
export function getTeamUnits(user: UserSession, kind: 'Vehicle' | 'Locker'): Location[] {
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
 * #139 source taxonomy: the full Location ∪ Vehicle ∪ Locker source set for the
 * fast-checkout picker. Units come from the access-gated resolver (owned ∪
 * granted ∪ teammate); main locations are added explicitly and gated by role
 * only. Kept separate from getAccessibleSourceLocations so Manage My Team /
 * getVisibleUnits (units only) are unaffected.
 * #158: ALL active TYPED main locations (incl. empty ones — a truck restocking
 * an empty warehouse must still be able to start there), not just stock-holding
 * ones. Type-less rows stay hidden (they're legacy pre-taxonomy child rows,
 * user-confirmed junk 2026-07-20) — typing a location is what surfaces it.
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

// ── #162 team-scoped unit inventory ─────────────────────────────────────────

export interface UnitInventoryLock {
  locked: boolean;
  /** Human lock reason, e.g. "🔒 Team inventory — Mitigation". Null when unlocked. */
  reason: string | null;
}

const UNLOCKED: UnitInventoryLock = { locked: false, reason: null };

/** The owning team's display label for a lock reason: the owner's team name(s),
 * falling back to the owner's name when they're on no team. */
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

/**
 * manage_other_team_inventory for one actor, resolved the way the SERVER
 * resolves it for sync-push authorization (lib/permissions.ts
 * userHasPermission): role default → role_settings override → user override.
 * Team-level overrides are deliberately not consulted — this permission is
 * excluded from TEAM_OVERRIDABLE_PERMISSIONS on both sides. Resolved via
 * direct SQL (not auth/permissions.hasPermission) so this module stays free
 * of the session/secure-store import graph and loadable under node tests.
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
 * #162: may `user` manage inventory INTO/OUT OF `locationId`? Locked only when
 * the location is a UNIT (Vehicle/Locker) owned by a user on a team `user`
 * doesn't share, and `user` lacks manage_other_team_inventory. Main locations,
 * ownerless units, unknown ids and null ids are all unlocked — the exact
 * mirror of the server's foreignTeamUnitBlocked guard (routes/sync.ts), so
 * what the UI locks locally is what the server rejects on push. Visibility is
 * NOT restricted (#157) — this gates inventory WRITES only; the vehicle
 * SESSION lock (checkout_locked) is separate.
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
 * getUnitInventoryLock for call sites that only carry a user id (e.g. the scan
 * stock-action funnel). Resolves the actor's row from the local DB; an unknown
 * or null actor is unlocked locally (the server still enforces on push).
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
    { id: u.id, role: u.role, permission_overrides: overrides ?? {} } as UserSession,
    locationId,
  );
}

// ── Access list ──────────────────────────────────────────────────────────────

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
 * (queries/vehicles.ts) — kept in sync manually.
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

