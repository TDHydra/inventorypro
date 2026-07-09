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

// True when this action must be blocked for this caller on this team.
export function managerActionBlocked(auth: TeamAuthority, _action: ManagerRestrictedAction): boolean {
  if (auth.orgAdmin) return false;
  // A plain member has no business performing any of these either; the caller's own
  // permission gate (manage_teams) already rejected them before we got here, so the
  // only remaining case is the manager-without-org-authority.
  return auth.managerOnly;
}
