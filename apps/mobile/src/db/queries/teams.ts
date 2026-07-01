import { getDb, rowsAs, bindParams } from '../schema';
import { appendOutbox } from '../../sync/outbox';
import { getValidJwt } from '../../auth/session';
import { Permission } from '../../constants/roles';

const API_BASE = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';

// Permission keys a team manager/admin may override per-member, scoped to this
// team (auth/permissions.ts hasPermission() merges these in via user.team_contexts).
// Deliberately excludes account/system-wide administrative permissions
// (manage_users, manage_teams, manage_roles_permissions, set_pins,
// system_settings, view_all_logs) — those stay role/user-level only, never
// team-scoped, so a team-level editor can't be used to hand out admin authority.
export const TEAM_OVERRIDABLE_PERMISSIONS: Permission[] = [
  'checkout_inventory', 'checkin_inventory', 'add_inventory', 'quick_add',
  'edit_inventory', 'delete_inventory', 'transfer_between_locations',
  'create_jobs', 'close_jobs', 'manage_locations', 'upload_media',
  'view_team_activity', 'checkout_for_team', 'view_financial_data',
];

export const TEAM_PERMISSION_LABELS: Record<Permission, string> = {
  checkout_inventory: 'Check out inventory',
  checkin_inventory: 'Check in inventory',
  add_inventory: 'Add catalog items',
  quick_add: 'Quick add',
  edit_inventory: 'Edit catalog items',
  delete_inventory: 'Delete catalog items',
  transfer_between_locations: 'Transfer between locations',
  create_jobs: 'Create jobs',
  close_jobs: 'Close jobs',
  manage_locations: 'Manage locations',
  upload_media: 'Upload photos/video',
  view_all_logs: 'View all activity logs',
  view_own_logs: 'View own activity logs',
  view_team_activity: "View team's activity",
  manage_teams: 'Manage teams',
  checkout_for_team: 'Check out for a team',
  manage_users: 'Manage users',
  set_pins: 'Set / reset PINs',
  manage_roles_permissions: 'Manage roles & permissions',
  view_financial_data: 'View financial data',
  system_settings: 'Change system settings',
};

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

// Set a member's per-team permission overrides (a full replace, not a merge —
// callers pass the complete override map). Unlike is_manager, this column is
// NOT in SENSITIVE_DENY on the server, so it can legally flow through the
// generic sync outbox too — but we still go through the same gated PATCH
// endpoint first for an immediate online round-trip (consistent 403 handling,
// same UX as the manager toggle), then mirror the write locally AND queue a
// matching outbox UPDATE so other in-flight sync/reconciliation paths see a
// normal team_members row change rather than depending solely on this one-off
// REST call.
export async function setMemberPermissionOverridesOnline(
  teamId: string,
  userId: string,
  overrides: Record<string, boolean>,
): Promise<void> {
  const jwt = await getValidJwt();
  if (!jwt) throw new Error('Connect to the server to change team permissions.');
  const res = await fetch(`${API_BASE}/teams/${teamId}/members/${userId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ team_permission_overrides: overrides }),
  });
  if (!res.ok) {
    throw new Error(res.status === 403
      ? 'You do not have permission to change team permissions.'
      : `Could not update permissions (${res.status}).`);
  }
  const now = new Date().toISOString();
  const overridesJson = JSON.stringify(overrides);
  getDb().executeSync(
    `UPDATE team_members SET team_permission_overrides = ?, updated_at = ? WHERE team_id = ? AND user_id = ?`,
    bindParams([overridesJson, now, teamId, userId]),
  );
  appendOutbox('UPDATE', 'team_members', {
    team_id: teamId,
    user_id: userId,
    team_permission_overrides: overridesJson,
  });
}
