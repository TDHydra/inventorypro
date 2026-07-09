import { getDb, rowsAs, bindParams } from '../schema';
import { resolveTypeId, resolveLabels, TEAM_CATEGORY } from './taxonomy';
import { getValidJwt } from '../../auth/session';
import { syncNow } from '../../sync/engine';
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
  // edit_media yes, delete_media deliberately NO — its GRANT is full-admin-only
  // (roles.tsx + the server role_settings guard), so a team manager must not be
  // able to mint it per-team either. Must mirror apps/api/src/lib/syncPolicy.ts.
  'edit_media',
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
  edit_media: 'Edit media details (caption/location, move)',
  // Exhaustiveness only — NOT team-overridable (destructive; full-admin grant).
  delete_media: 'Delete photos/video',
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
  send_notifications: 'Send broadcast notifications',
  // Present for the Record<Permission,…> exhaustiveness check only — deliberately
  // absent from TEAM_OVERRIDABLE_PERMISSIONS above: the audit log is org-wide and
  // carries cross-user PII, so it stays role/user-level, never team-grantable.
  view_audit_log: 'View the API audit log',
};

export interface Team {
  id: string;
  name: string;
  type: string;
  // Durable taxonomy FK (migration 029, #74) — `type` is the label cache.
  type_id?: string | null;
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
  // Resolve `type` from type_id so a taxonomy rename shows immediately (#74 P2).
  return resolveLabels(rowsAs<Team>(result.rows), 'type_id', 'type');
}

export function getTeamById(id: string): Team | null {
  const db = getDb();
  const result = db.executeSync(`SELECT * FROM teams WHERE id = ?`, [id]);
  return resolveLabels(rowsAs<Team>(result.rows), 'type_id', 'type')[0] ?? null;
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
// Returns the dual-written taxonomy FK (#74) so callers can include it in their
// outbox payload (prefer an explicit team.type_id from a pulled row, else resolve
// from the label).
export function upsertTeam(team: Team): string | null {
  const db = getDb();
  const typeId = team.type_id ?? resolveTypeId(TEAM_CATEGORY, team.type);
  db.executeSync(
    `INSERT OR REPLACE INTO teams (id, name, type, updated_at, synced_at, type_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    bindParams([team.id, team.name, team.type, team.updated_at, team.synced_at, typeId]),
  );
  return typeId;
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

// Shared gated PATCH for a single team_members row (both the manager toggle and
// the per-member override editor use PATCH /teams/:id/members/:uid). If the team
// + member were just created offline, the server has no team_members row yet and
// PATCH returns 404 "Member not found". So we flush local writes first (syncNow)
// to create the row server-side, then PATCH; a single 404 triggers ONE more sync
// + retry before giving up with a friendly "still syncing" error. Returns the
// final Response so callers can interpret 403/other statuses with their own copy.
async function patchTeamMemberRow(
  teamId: string,
  userId: string,
  jwt: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const url = `${API_BASE}/teams/${teamId}/members/${userId}`;
  const init: RequestInit = {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
    body: JSON.stringify(body),
  };
  // Push any pending offline writes so the server has the team + member rows.
  await syncNow().catch(() => undefined);
  let res = await fetch(url, init);
  if (res.status === 404) {
    // Row may still be in flight — force one more sync, then retry exactly once.
    await syncNow().catch(() => undefined);
    res = await fetch(url, init);
    if (res.status === 404) {
      throw new Error('Member is still syncing — try again in a moment.');
    }
  }
  return res;
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
  const res = await patchTeamMemberRow(teamId, userId, jwt, { is_manager: isManager });
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
// generic sync outbox too — but we go through the same gated PATCH endpoint
// first for an immediate online round-trip (consistent 403 handling, same UX
// as the manager toggle), then mirror the write into the LOCAL row only, so
// this device's UI reflects the change now. Deliberately NOT also queuing a
// matching outbox UPDATE: the PATCH above is already authoritative and
// persisted server-side, and other devices see it on their next pull — a
// second, blind full-replace outbox entry for the same column would race a
// concurrent edit from another device (whichever entry's outbox flush lands
// last on the server wins and silently clobbers the other), a lost-update bug
// with no benefit since the online write already succeeded.
export async function setMemberPermissionOverridesOnline(
  teamId: string,
  userId: string,
  overrides: Record<string, boolean>,
): Promise<void> {
  const jwt = await getValidJwt();
  if (!jwt) throw new Error('Connect to the server to change team permissions.');
  const res = await patchTeamMemberRow(teamId, userId, jwt, { team_permission_overrides: overrides });
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
}
