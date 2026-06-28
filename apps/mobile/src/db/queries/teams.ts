import { getDb, rowsAs, bindParams } from '../schema';
import { appendOutbox } from '../../sync/outbox';

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
  is_manager: number; // 0 | 1 (SQLite has no boolean)
  updated_at: string;
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
  return rowsAs<Team>(result.rows)[0] ?? null;
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

// Pure local write — returns { joined_at } on a real insert, or null if the
// composite key already existed (INSERT OR IGNORE skipped the row).
// Callers must check for null before enqueuing outbox/log entries.
// overrides defaults to {} (no per-member permission overrides on create).
export function addTeamMember(
  teamId: string,
  userId: string,
  overrides: Record<string, boolean> = {},
  addedBy?: string | null,
): { joined_at: string } | null {
  const db = getDb();
  const joined_at = new Date().toISOString();
  const res = db.executeSync(
    `INSERT OR IGNORE INTO team_members
       (team_id, user_id, team_permission_overrides, added_by, joined_at, is_manager, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, ?)`,
    bindParams([teamId, userId, JSON.stringify(overrides), addedBy ?? null, joined_at, joined_at]),
  );
  if (res.rowsAffected < 1) return null;
  return { joined_at };
}

// Pure local write — callers queue the DELETE outbox row with {team_id, user_id}.
export function removeTeamMember(teamId: string, userId: string): void {
  const db = getDb();
  db.executeSync(
    `DELETE FROM team_members WHERE team_id = ? AND user_id = ?`,
    bindParams([teamId, userId]),
  );
}

// Teams where this user is flagged as a manager (team_members.is_manager = 1).
export function getTeamsManagedBy(userId: string): Team[] {
  const db = getDb();
  const result = db.executeSync(
    `SELECT t.*
       FROM teams t
       JOIN team_members tm ON tm.team_id = t.id
      WHERE tm.user_id = ? AND tm.is_manager = 1
      ORDER BY t.name ASC`,
    [userId],
  );
  return rowsAs<Team>(result.rows);
}

// Distinct member user_ids across every team this user manages (offline "My Team").
export function getManagedTeamMemberIds(userId: string): string[] {
  const db = getDb();
  const result = db.executeSync(
    `SELECT DISTINCT tm.user_id AS user_id
       FROM team_members tm
      WHERE tm.team_id IN (
        SELECT team_id FROM team_members
         WHERE user_id = ? AND is_manager = 1
      )`,
    [userId],
  );
  return (result.rows as { user_id: string }[]).map(r => r.user_id);
}

// Promote/demote an existing member as a team manager. Bundles the outbox row
// (UPDATE team_members) itself — real boolean payload, no synced_at.
export function setMemberManager(teamId: string, userId: string, isManager: boolean): void {
  const db = getDb();
  const updated_at = new Date().toISOString();
  db.executeSync(
    `UPDATE team_members SET is_manager = ?, updated_at = ? WHERE team_id = ? AND user_id = ?`,
    bindParams([isManager ? 1 : 0, updated_at, teamId, userId]),
  );
  appendOutbox('UPDATE', 'team_members', {
    team_id: teamId,
    user_id: userId,
    is_manager: isManager,
    updated_at,
  });
}
