import { getDb, rowsAs, bindParams } from '../schema';

export interface Team {
  id: string;
  name: string;
  type: string;
  manager_id: string | null;
  updated_at: string;
  synced_at: string | null;
}

export interface TeamMember {
  team_id: string;
  user_id: string;
  team_permission_overrides: string; // JSON string
  added_by: string | null;
  joined_at: string;
  // Populated by getTeamMembers LEFT JOIN users
  user_name?: string | null;
  user_role?: string | null;
}

export function getAllTeams(): Team[] {
  const db = getDb();
  const result = db.executeSync(`SELECT * FROM teams ORDER BY name ASC`);
  return rowsAs<Team>(result.rows);
}

export function getTeamById(id: string): Team | null {
  const db = getDb();
  const result = db.executeSync(`SELECT * FROM teams WHERE id = ?`, [id]);
  return (result.rows[0] as unknown as Team) ?? null;
}

export function getTeamMembers(teamId: string): TeamMember[] {
  const db = getDb();
  const result = db.executeSync(
    `SELECT tm.*, u.name AS user_name, u.role AS user_role
     FROM team_members tm
     LEFT JOIN users u ON u.id = tm.user_id
     WHERE tm.team_id = ?
     ORDER BY u.name ASC`,
    [teamId],
  );
  return rowsAs<TeamMember>(result.rows);
}

// Pure local write — callers are responsible for appendOutbox + appendLog.
export function upsertTeam(team: Team): void {
  const db = getDb();
  db.executeSync(
    `INSERT OR REPLACE INTO teams (id, name, type, manager_id, updated_at, synced_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    bindParams([team.id, team.name, team.type, team.manager_id, team.updated_at, team.synced_at]),
  );
}

// Pure local write — returns joined_at so the caller can include the exact
// same timestamp in the outbox INSERT payload for consistency.
// overrides defaults to {} (no per-member permission overrides on create).
export function addTeamMember(
  teamId: string,
  userId: string,
  overrides: Record<string, boolean> = {},
  addedBy?: string | null,
): string {
  const db = getDb();
  const joined_at = new Date().toISOString();
  db.executeSync(
    `INSERT OR IGNORE INTO team_members
       (team_id, user_id, team_permission_overrides, added_by, joined_at)
     VALUES (?, ?, ?, ?, ?)`,
    bindParams([teamId, userId, JSON.stringify(overrides), addedBy ?? null, joined_at]),
  );
  return joined_at;
}

// Pure local write — callers queue the DELETE outbox row with {team_id, user_id}.
export function removeTeamMember(teamId: string, userId: string): void {
  const db = getDb();
  db.executeSync(
    `DELETE FROM team_members WHERE team_id = ? AND user_id = ?`,
    [teamId, userId],
  );
}
