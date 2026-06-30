import { getDb, rowsAs, bindParams } from '../schema';
import { appendOutbox } from '../../sync/outbox';
import { getValidJwt } from '../../auth/session';

const API_BASE = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';

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

// Promote/demote an existing member as a team manager. Bundles the outbox row
// (UPDATE team_members) itself — real boolean payload, no synced_at.
// is_manager is server-controlled: the sync push ignores client writes to it (it
// was a self-promotion vector). Promotion therefore goes through the gated
// PATCH /teams/:id/members/:uid endpoint (online), then reflects locally. No
// outbox row — the server is authoritative and other devices pull the change.
export async function setMemberManagerOnline(teamId: string, userId: string, isManager: boolean): Promise<void> {
  const jwt = await getValidJwt();
  if (!jwt) throw new Error('Connect to the server to change team managers.');
  const res = await fetch(`${API_BASE}/teams/${teamId}/members/${userId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ is_manager: isManager }),
  });
  if (!res.ok) {
    throw new Error(res.status === 403
      ? 'You do not have permission to change team managers.'
      : `Could not update manager (${res.status}).`);
  }
  getDb().executeSync(
    `UPDATE team_members SET is_manager = ?, updated_at = ? WHERE team_id = ? AND user_id = ?`,
    bindParams([isManager ? 1 : 0, new Date().toISOString(), teamId, userId]),
  );
}
