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
