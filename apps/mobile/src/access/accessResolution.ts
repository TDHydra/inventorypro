// Pure access-resolution kernel for the field-crew epic (#122), split into
// its own file (no React/React Native/db imports) so it's importable from a
// plain `node --test` run — react-native's Flow syntax breaks the tsx loader
// used by node:test, so nothing under this file's import graph may pull it in.
//
// Answers "which locker/vehicle locations can this user work from?" over
// plain row arrays the caller has already loaded (and, for `lockers`,
// already filtered to Locker/Vehicle-type locations). The rule mirrors the
// server-side ADJUST locker guard exactly — access = owned ∪ granted ∪
// owned by anyone sharing a parent TEAM with me (user decision 2026-07-18:
// whole team, NOT just my subteam) — so what the picker shows locally is
// what the server will accept on push.

/** A Locker/Vehicle-type location row (caller pre-filters by type). */
export interface AccessLockerRow {
  id: string;
  ownerUserId: string | null;
}

/** One `locker_access` grant row. */
export interface AccessGrantRow {
  locationId: string;
  userId: string;
}

/** One `team_members` row (parent-team membership; subteams are irrelevant here). */
export interface TeamMemberRow {
  teamId: string;
  userId: string;
}

/** A `team_members` row carrying the subteam columns (migration 041). */
export interface SubteamMemberRow extends TeamMemberRow {
  subteamId: string | null;
  subteamRole: string | null; // 'lead' | 'helper' | null
}

export interface AccessResolutionInput {
  lockers: AccessLockerRow[];
  grants: AccessGrantRow[];
  teamMembers: TeamMemberRow[];
}

/**
 * The Set of location ids from `lockers` that `userId` may access:
 * owned by them, explicitly granted to them via `locker_access`, or owned by
 * any user who shares at least one parent team with them. Grants pointing at
 * locations not present in `lockers` are ignored (stale grant / non-asset
 * location). Ownerless lockers are reachable only via an explicit grant.
 */
export function getAccessibleLocationIds(input: AccessResolutionInput, userId: string): Set<string> {
  const { lockers, grants, teamMembers } = input;
  const lockerIds = new Set(lockers.map((l) => l.id));

  // Everyone sharing a parent team with me (includes me when I'm on a team).
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
 * tier-3+ org authority, Production Managers (tier 2 — the spec names them, so
 * an explicit fact, mirroring B Task 1's privileged set), team managers
 * (team_members.is_manager), and unit owners. Day-to-day surfaces
 * (fast-checkout picker) keep using getAccessibleLocationIds — explicit
 * visibility via unit_access.can_view.
 */
export function canSeeAllUnitsInManage(ctx: { roleTier: number; isTeamManager: boolean; ownsAnyUnit: boolean; isProductionManager: boolean }): boolean {
  return ctx.roleTier >= 3 || ctx.isProductionManager || ctx.isTeamManager || ctx.ownsAnyUnit;
}

export interface UnitActionPerms {
  view: boolean; add: boolean; remove: boolean; move: boolean; editDetails: boolean; grant: boolean;
}

/**
 * Effective per-action perms on a unit: owner/tier-3+ → everything; otherwise the
 * explicit unit_access row (getUserUnitPerms; all-false when no row) UNIONed with
 * the implicit teammate-of-owner work access (view/add/remove/move — preserves the
 * pre-#122 team rule so grants only ever ADD access). editDetails/grant are never
 * implicit.
 */
export function resolveUnitActionPerms(input: {
  isOwner: boolean; roleTier: number; isTeammateOfOwner: boolean; rowPerms: UnitActionPerms;
}): UnitActionPerms {
  if (input.isOwner || input.roleTier >= 3) {
    return { view: true, add: true, remove: true, move: true, editDetails: true, grant: true };
  }
  const t = input.isTeammateOfOwner;
  return {
    view: input.rowPerms.view || t,
    add: input.rowPerms.add || t,
    remove: input.rowPerms.remove || t,
    move: input.rowPerms.move || t,
    editDetails: input.rowPerms.editDetails,
    grant: input.rowPerms.grant,
  };
}

// ── #162 team-scoped unit inventory ──────────────────────────────────────────

export interface UnitInventoryGateInput {
  /** True when the location is a Vehicle/Locker-type UNIT (isUnitLocation). */
  isUnit: boolean;
  ownerUserId: string | null;
  /** Actor shares at least one parent team with the owner, or IS the owner. */
  actorSharesOwnerTeam: boolean;
  /** manage_other_team_inventory resolved for the actor (tier-4 default). */
  hasCrossTeamPerm: boolean;
}

/**
 * #162: inventory inside a UNIT (Vehicle/Locker) may only be managed by its
 * owning team — the owner, or anyone sharing a parent team with the owner —
 * unless the actor holds manage_other_team_inventory. Main locations and
 * ownerless units are unrestricted; visibility is untouched (#157 — this gates
 * WRITES only). Mirrors the server guard exactly
 * (apps/api/src/lib/teamAuthority.ts foreignTeamUnitBlocked), so what the UI
 * locks locally is what the server rejects on push.
 */
export function isUnitInventoryBlocked(input: UnitInventoryGateInput): boolean {
  if (input.hasCrossTeamPerm) return false;
  if (!input.isUnit) return false;              // main locations unrestricted
  if (input.ownerUserId === null) return false; // ownerless units unrestricted
  if (input.actorSharesOwnerTeam) return false; // own / own-team unit
  return true;
}

/**
 * User ids of the lead(s) of `userId`'s subteam(s) — deduped, in first-seen
 * order. A user on multiple subteams gets every lead; the user themself is
 * included when they are a lead. Users with no subteam assignment get `[]`.
 */
export function resolveMyLead(teamMembers: SubteamMemberRow[], userId: string): string[] {
  const mySubteamIds = new Set<string>();
  for (const tm of teamMembers) {
    if (tm.userId === userId && tm.subteamId !== null) mySubteamIds.add(tm.subteamId);
  }
  if (mySubteamIds.size === 0) return [];

  const leads: string[] = [];
  const seen = new Set<string>();
  for (const tm of teamMembers) {
    if (tm.subteamId !== null && mySubteamIds.has(tm.subteamId) && tm.subteamRole === 'lead' && !seen.has(tm.userId)) {
      seen.add(tm.userId);
      leads.push(tm.userId);
    }
  }
  return leads;
}
