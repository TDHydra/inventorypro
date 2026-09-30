import { isOrgAuthority } from './teamAuthority';

// Team / media read-scoping predicates, shared by the generic sync path
// (routes/sync.ts) and the REST read route routes/media.ts.
//
// H7 (2026-08-09 audit): team compartmentalisation was previously enforced ONLY
// in the sync pull. The REST reads (`GET /jobs/:id`, `GET /jobs`,
// `GET /media/job/:id`) bypassed it, so any authenticated user who knew an id
// could read another team's job (customer PII, insurance detail) and its media.
// Centralising the predicates here makes "team is a security boundary" one
// choke point both read layers call, so the two can't drift apart again.
//
// The /jobs REST routes were deleted 2026-08-23 (no client ever called them),
// so the job predicates below now serve the sync path only — they are kept
// because sync pull relies on the same team_scope subquery.

// team_scope subquery keyed on the caller's memberships. A subquery (not a join
// on user_id) so a caller sees every member of their teams, not just their own
// membership row.
//
//   teams        → the teams I belong to
//   team_members → every member of the teams I belong to (my teammates)
//   jobs         → my teams' jobs, PLUS every unassigned job (team_id IS NULL is
//                  "org-wide")
//   subteams     → crews of my teams (mirrors team_members)
//
// Only applied when the caller may NOT see all teams — see canSeeAllTeams.
export function teamScopeSql(table: string, callerParam: string): string | null {
  const mine = `SELECT team_id FROM team_members WHERE user_id = ${callerParam}`;
  switch (table) {
    case 'teams': return `id IN (${mine})`;
    case 'team_members': return `team_id IN (${mine})`;
    case 'jobs': return `(team_id IS NULL OR team_id IN (${mine}))`;
    case 'subteams': return `team_id IN (${mine})`;
    default: return null;
  }
}

// Media pull scoping. #29-H: message attachments are private to the message's
// conversation. #87/#148: pool shares are visible to the uploader, 'everyone'
// shares, the uploader's teammates ('team'), and listed users ('users'). Other
// entity media stays unscoped here (job media is team-scoped separately at the
// REST layer via teamScopeSql('jobs') — see media.ts).
export function mediaScopeSql(callerParam: string): string {
  const mine = `SELECT conversation_id FROM conversation_participants WHERE user_id = ${callerParam}`;
  const myTeams = `SELECT team_id FROM team_members WHERE user_id = ${callerParam}`;
  const msg = `(entity_type != 'message' OR entity_id IN (SELECT id FROM messages WHERE conversation_id IN (${mine})))`;
  const pool = `(entity_type != 'pool' OR uploaded_by = ${callerParam} OR audience = 'everyone'
    OR (audience = 'team' AND uploaded_by IN (SELECT user_id FROM team_members WHERE team_id IN (${myTeams})))
    OR (audience = 'users' AND audience_user_ids LIKE '%' || ${callerParam} || '%'))`;
  return `(${msg} AND ${pool})`;
}

// May this caller see every team's data? Tier 3+ (office_manager, hr_manager,
// franchise_manager) and full_admin (apex) — see lib/teamAuthority. A tier check
// (not a runtime permission) so a stray override cannot re-open cross-team reads.
export function canSeeAllTeams(caller: { role: string }): boolean {
  return isOrgAuthority(caller.role);
}

export type Caller = {
  role: string;
  permission_overrides: Record<string, boolean> | null;
  role_overrides: Record<string, boolean> | null;
  is_test: boolean;
  // #76: team_permission_overrides from every team_members row the caller
  // belongs to. Empty array when the caller is on no team.
  team_overrides: Array<Record<string, boolean>>;
};

export async function resolveCaller(
  pg: { query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }> },
  userId: string,
): Promise<Caller | undefined> {
  const { rows } = await pg.query(
    `SELECT u.role, u.permission_overrides, u.is_test, rs.permission_overrides AS role_overrides,
            COALESCE(
              (SELECT jsonb_agg(tm.team_permission_overrides)
                 FROM team_members tm WHERE tm.user_id = u.id),
              '[]'::jsonb
            ) AS team_overrides
       FROM users u
       LEFT JOIN role_settings rs ON rs.role = u.role
      WHERE u.id = $1`,
    [userId],
  );
  const row = rows[0] as
    | {
        role: string;
        permission_overrides: Record<string, boolean> | null;
        role_overrides: Record<string, boolean> | null;
        is_test: boolean;
        team_overrides?: Array<Record<string, boolean> | null> | null;
      }
    | undefined;
  if (!row) return undefined;
  return { ...row, team_overrides: (row.team_overrides ?? []).filter((t): t is Record<string, boolean> => t != null) };
}
