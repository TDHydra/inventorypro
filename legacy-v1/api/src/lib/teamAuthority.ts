import { effectiveTier } from './permissions';

// Org-wide authority over teams: may see every team, and bypasses the manager
// restrictions below. Tier 3+ = office_manager, hr_manager, franchise_manager;
// full_admin is apex (tier 5). Deliberately NOT keyed on the `manage_teams`
// permission — tier 2 crew leads hold it, and a tier-2 lead running one crew is
// exactly who these restrictions exist for. Unknown role → tier undefined → false.
export function isOrgAuthority(role: string | null | undefined): boolean {
  return (effectiveTier(role) ?? 0) >= 3;
}

// Single source of truth for "what may this caller do to this team?", shared by the
// generic /sync/push guard and the REST mirrors in routes/teams.ts. Two copies of
// this logic would drift and reopen a bypass on whichever path lagged.
//
// is_manager is resolved from the AUTHENTICATED caller id, never from the pushed
// payload — a client that sets added_by/user_id to someone else must not thereby
// inherit their authority.

export interface TeamAuthority {
  /** Org-level authority: may do anything to any team. */
  orgAdmin: boolean;
  /** Manages this team but has no org authority — subject to the manager limits. */
  managerOnly: boolean;
}

// A team manager, acting on their OWN team, may not do these. An org admin may.
export type ManagerRestrictedAction =
  | 'set_manager'      // promote or demote any manager, including themselves
  | 'remove_self'      // leave a team they manage (would orphan it)
  | 'rename_team'
  | 'delete_team';

interface Pg {
  query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }>;
}

export async function resolveTeamAuthority(pg: Pg, callerId: string, teamId: string): Promise<TeamAuthority> {
  const { rows } = await pg.query(
    `SELECT u.role, u.permission_overrides, rs.permission_overrides AS role_overrides,
            COALESCE(tm.is_manager, FALSE) AS is_manager
       FROM users u
       LEFT JOIN role_settings rs ON rs.role = u.role
       LEFT JOIN team_members tm  ON tm.user_id = u.id AND tm.team_id = $2
      WHERE u.id = $1`,
    [callerId, teamId],
  );
  const r = rows[0] as
    | { role: string; permission_overrides: Record<string, boolean> | null;
        role_overrides: Record<string, boolean> | null; is_manager: boolean }
    | undefined;

  // Unknown caller → no authority at all (fail closed).
  if (!r) return { orgAdmin: false, managerOnly: false };

  // ORDER MATTERS. Org authority is checked FIRST: a franchise_manager who also
  // happens to manage a crew must not be classified manager-only and thereby locked
  // out of renaming their own team.
  //
  // Org authority is a TIER test, not `manage_teams`. Tier 2 (production_manager,
  // head_of_construction, …) already holds manage_teams — gating on the permission
  // would make every team manager an org admin and the four restrictions below would
  // fire for nobody. Tier 3+ is office_manager / hr_manager / franchise_manager, and
  // full_admin is apex at tier 5.
  const orgAdmin = isOrgAuthority(r.role);

  return { orgAdmin, managerOnly: !orgAdmin && r.is_manager === true };
}

// ── #162 team-scoped unit inventory ─────────────────────────────────────────
// Inventory inside a Vehicle/Locker UNIT may only be managed by its owning
// team: the owner, or anyone sharing a parent team with the owner. Everyone
// else needs the manage_other_team_inventory permission (tier-4 default).
// Main (non-unit) locations, ownerless units, and unknown locations are
// unrestricted — only owned units restrict. Visibility is NOT touched (#157);
// this gates WRITES only. KEEP IN SYNC with the mobile mirror
// (apps/mobile/src/access/accessResolution.ts isUnitInventoryBlocked).

export interface UnitInventoryFacts {
  /** Location type label ('Vehicle' | 'Locker' | anything else / null). */
  type: string | null;
  ownerUserId: string | null;
  /** The caller IS the owner. */
  isOwner: boolean;
  /** The caller shares at least one parent team with the owner. */
  sharesOwnerTeam: boolean;
}

/**
 * Resolve the ownership facts for one location, from the DB (never the
 * payload). Returns null for an unknown location id (→ unrestricted; the write
 * will fail/FK elsewhere if the location truly doesn't exist). Type falls back
 * to the taxonomy label when locations.type is null (the #84 crew-vehicle
 * INSERT path can create rows with only type_id set).
 */
export async function resolveUnitInventoryFacts(
  pg: Pg,
  locationId: unknown,
  callerId: string,
): Promise<UnitInventoryFacts | null> {
  if (locationId == null) return null;
  const { rows } = await pg.query(
    `SELECT COALESCE(l.type, (SELECT label FROM taxonomy_types tt
                               WHERE tt.id = l.type_id AND tt.category = 'location_type')) AS type,
            l.owner_user_id,
            (l.owner_user_id = $2) AS is_owner,
            EXISTS (SELECT 1 FROM team_members om
                      JOIN team_members cm ON cm.team_id = om.team_id
                     WHERE om.user_id = l.owner_user_id AND cm.user_id = $2) AS shares_team
       FROM locations l WHERE l.id = $1`,
    [locationId, callerId],
  );
  const r = rows[0] as
    | { type: string | null; owner_user_id: string | null; is_owner: boolean | null; shares_team: boolean }
    | undefined;
  if (!r) return null;
  return {
    type: r.type == null ? null : String(r.type),
    ownerUserId: r.owner_user_id == null ? null : String(r.owner_user_id),
    isOwner: r.is_owner === true,
    sharesOwnerTeam: r.shares_team === true,
  };
}

/**
 * True when an inventory write touching this location must be BLOCKED for the
 * caller: the location is a unit (Vehicle/Locker), it has an owner, the caller
 * neither is the owner nor shares a team with them, and the caller lacks
 * manage_other_team_inventory. Everything else passes (main locations,
 * ownerless units, unknown locations, same-team, perm holders).
 */
export function foreignTeamUnitBlocked(
  facts: UnitInventoryFacts | null | undefined,
  canManageOtherTeamInventory: boolean,
): boolean {
  if (canManageOtherTeamInventory) return false;
  if (!facts) return false; // unknown location → unrestricted
  if (facts.type !== 'Vehicle' && facts.type !== 'Locker') return false; // main locations unrestricted
  if (facts.ownerUserId == null) return false; // ownerless units unrestricted
  if (facts.isOwner || facts.sharesOwnerTeam) return false; // own team
  return true;
}

// True when this action must be blocked for this caller on this team.
export function managerActionBlocked(auth: TeamAuthority, _action: ManagerRestrictedAction): boolean {
  if (auth.orgAdmin) return false;
  // A plain member has no business performing any of these either; the caller's own
  // permission gate (manage_teams) already rejected them before we got here, so the
  // only remaining case is the manager-without-org-authority.
  return auth.managerOnly;
}
