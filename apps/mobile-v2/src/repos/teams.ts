// teams / team_members / subteams domain — split out of the old app's
// db/queries/teams.ts + db/queries/subteams.ts + sync/teamPurge.ts.
//
// Membership model: there is NO users.team_id column. Team membership is
// entirely the team_members join table (composite key team_id+user_id).
// Subteams ("crews") are a lead + helpers inside a team; a member's crew
// assignment lives ON their team_members row (subteam_id/subteam_role) —
// crew membership writes are UPDATEs against team_members, never new rows.
//
// Callers (teams/[id].tsx, myteam.tsx, TeamQuickAdd) wrap
// `runInTransaction(() => { setXxx(...); appendLog({...}); })` themselves —
// mirrors the B1 users.ts/roleSettings.ts convention: repo functions here do
// NOT call appendLog. Works because runInTransaction is reentrant: each
// mirror()/runInTransaction() call below just joins the caller's outer
// transaction instead of committing separately.
//
// rowsAffected note: @invenpro/core's SqlDb.executeSync only returns
// { rows }, unlike the old app's op-sqlite wrapper which also exposed
// rowsAffected. Where the old app checked `res.rowsAffected < 1` to detect a
// skipped INSERT OR IGNORE / no-op UPDATE, this port checks row existence
// with a SELECT first instead — behaviorally identical, and portable to the
// sql.js test harness (testDb.ts), which has no rowsAffected field either.
import { getDb, rowsAs, bindParams } from '../db/schema';
import {
  createRepository,
  appendOutbox,
  runInTransaction,
  queueTableBump,
  getAppSetting,
  setAppSetting,
  deleteAppSetting,
  syncNow,
} from '@invenpro/core';
import { resolveTypeId, resolveLabels, TEAM_CATEGORY } from './taxonomy';
import { generateUUID } from '../utils/uuid';
import { getValidJwt } from '../auth/session';
import { TEAM_OVERRIDABLE_PERMISSIONS } from '../auth/teamPerms';
import { Permission } from '../constants/roles';

const API_BASE = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';

const teamsRepo = createRepository('teams');
const teamMembersRepo = createRepository('team_members');
const subteamsRepo = createRepository('subteams');

// Team-scoped permission overrides a manager may grant per member — the
// allowlist itself lives in auth/teamPerms.ts (staged pre-Wave-B since
// auth/session.ts needs it from day one to build user.team_contexts).
// Re-exported here so screens importing the teams repo don't need a second
// import for the same list.
export { TEAM_OVERRIDABLE_PERMISSIONS };

export const TEAM_PERMISSION_LABELS: Record<Permission, string> = {
  checkout_inventory: 'Check out inventory',
  checkin_inventory: 'Check in inventory',
  add_inventory: 'Add catalog items',
  quick_add: 'Quick add',
  edit_inventory: 'Edit catalog items',
  delete_inventory: 'Delete catalog items',
  transfer_between_locations: 'Transfer between locations',
  manage_other_team_inventory: "Manage other teams' inventory",
  create_jobs: 'Create jobs',
  close_jobs: 'Close jobs',
  manage_schedule: 'Manage employee schedule board',
  manage_locations: 'Manage locations',
  upload_media: 'Upload photos/video',
  edit_media: 'Edit media details (caption/location, move)',
  delete_media: 'Delete photos/video',
  view_all_logs: 'View all activity logs',
  view_own_logs: 'View own activity logs',
  view_team_activity: "View team's activity",
  view_teams: 'View teams',
  view_locations: 'View locations',
  manage_teams: 'Manage teams',
  checkout_for_team: 'Check out for a team',
  manage_users: 'Manage users',
  set_pins: 'Set / reset PINs',
  manage_roles_permissions: 'Manage roles & permissions',
  view_financial_data: 'View financial data',
  system_settings: 'Change system settings',
  send_notifications: 'Send broadcast notifications',
  view_audit_log: 'View the API audit log',
};

// ── Types ────────────────────────────────────────────────────────────────

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
  is_manager: number; // 0 | 1
  updated_at: string;
  subteam_id: string | null;
  subteam_role: string | null;
  // Populated by getTeamMembers LEFT JOIN users
  user_name?: string | null;
  user_role?: string | null;
}

export interface Subteam {
  id: string;
  team_id: string;
  name: string;
  active: number; // 0 | 1
  created_at: string;
  updated_at: string;
  synced_at: string | null;
}

export interface CrewMember {
  id: string;
  name: string;
}

export interface Crew {
  id: string;
  teamId: string;
  name: string;
  lead?: CrewMember;
  helpers: CrewMember[];
}

// ── Reads: teams ─────────────────────────────────────────────────────────

export function getAllTeams(): Team[] {
  const db = getDb();
  const result = db.executeSync(`SELECT * FROM teams ORDER BY name ASC`);
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

// Teams a given user belongs to (their own team_contexts, roster-side view).
export function getTeamsForUser(userId: string): Team[] {
  const db = getDb();
  const result = db.executeSync(
    `SELECT t.* FROM teams t
     JOIN team_members tm ON tm.team_id = t.id
     WHERE tm.user_id = ?
     ORDER BY t.name ASC`,
    [userId],
  );
  return resolveLabels(rowsAs<Team>(result.rows), 'type_id', 'type');
}

// ── Writes: teams ────────────────────────────────────────────────────────
// Dual-writes the taxonomy FK (#74) exactly like locations.ts's
// upsertLocation: type_id is resolved from the label and written locally for
// immediate label resolution, but excluded from the outbox payload — the
// server resolves/owns type_id itself from the pushed label (routes/sync.ts
// TAXONOMY_FK_COLUMNS), and synced_at is local-only.

export function createTeam(name: string, type: string): { id: string; now: string } {
  const id = generateUUID();
  const now = new Date().toISOString();
  const typeId = resolveTypeId(TEAM_CATEGORY, type);
  teamsRepo.mirror('INSERT', { id, name, type, updated_at: now }, () => {
    getDb().executeSync(
      `INSERT OR REPLACE INTO teams (id, name, type, updated_at, synced_at, type_id)
       VALUES (?, ?, ?, ?, NULL, ?)`,
      bindParams([id, name, type, now, typeId]),
    );
  });
  return { id, now };
}

export function updateTeam(team: Team, name: string, type: string): string {
  const now = new Date().toISOString();
  const typeId = team.type_id ?? resolveTypeId(TEAM_CATEGORY, type);
  teamsRepo.mirror('UPDATE', { id: team.id, name, type, updated_at: now }, () => {
    getDb().executeSync(
      `INSERT OR REPLACE INTO teams (id, name, type, updated_at, synced_at, type_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      bindParams([team.id, name, type, now, team.synced_at, typeId]),
    );
  });
  return now;
}

// ── Writes: team_members (roster) ───────────────────────────────────────

// Add a member. Returns { joined_at } on a real insert, or null if the
// composite key already existed (no outbox/log churn on a duplicate add —
// mirrors the old app's INSERT OR IGNORE + rowsAffected check).
export function addTeamMember(
  teamId: string,
  userId: string,
  overrides: Record<string, boolean> = {},
  addedBy?: string | null,
): { joined_at: string } | null {
  const db = getDb();
  const exists = db.executeSync(
    `SELECT 1 FROM team_members WHERE team_id = ? AND user_id = ? LIMIT 1`,
    [teamId, userId],
  ).rows.length > 0;
  if (exists) return null;

  const joined_at = new Date().toISOString();
  runInTransaction(() => {
    getDb().executeSync(
      `INSERT INTO team_members
         (team_id, user_id, team_permission_overrides, added_by, joined_at, is_manager, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?)`,
      bindParams([teamId, userId, JSON.stringify(overrides), addedBy ?? null, joined_at, joined_at]),
    );
    queueTableBump('team_members');
    // NO is_manager here: it is server-controlled (SENSITIVE_DENY — the server
    // rejects the whole entry if present; it also gets stripped at push time).
    // The server defaults it to false; promotion goes through the gated PATCH.
    appendOutbox('INSERT', 'team_members', {
      team_id: teamId,
      user_id: userId,
      team_permission_overrides: overrides,
      added_by: addedBy ?? null,
      joined_at,
      updated_at: joined_at,
    });
  });
  return { joined_at };
}

export function removeTeamMember(teamId: string, userId: string): void {
  teamMembersRepo.mirror('DELETE', { team_id: teamId, user_id: userId }, () => {
    getDb().executeSync(
      `DELETE FROM team_members WHERE team_id = ? AND user_id = ?`,
      bindParams([teamId, userId]),
    );
  });
}

// Shared gated PATCH for a single team_members row (manager toggle + the
// per-member override editor both use PATCH /teams/:id/members/:uid). If the
// team + member were just created offline, the server has no team_members
// row yet and PATCH 404s — flush local writes first (syncNow), then PATCH;
// a single 404 gets ONE retry after another sync before giving up.
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
  await syncNow().catch(() => undefined);
  let res = await fetch(url, init);
  if (res.status === 404) {
    await syncNow().catch(() => undefined);
    res = await fetch(url, init);
    if (res.status === 404) {
      throw new Error('Member is still syncing — try again in a moment.');
    }
  }
  return res;
}

// Promote/demote a member as team manager. is_manager is server-controlled
// (the sync push ignores client writes to it — a self-promotion vector), so
// this is online-only via the gated PATCH endpoint, then reflected locally
// with no outbox row (the server is authoritative; other devices pull it).
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
  queueTableBump('team_members');
}

// Set a member's per-team permission overrides (full replace). Goes through
// the same gated PATCH endpoint first for an immediate, authoritative online
// round-trip, then mirrors the write into the LOCAL row only — deliberately
// NOT also queuing an outbox UPDATE for the same column (a second blind
// full-replace outbox entry could race a concurrent edit from another
// device and clobber it after the PATCH already landed server-side).
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
  getDb().executeSync(
    `UPDATE team_members SET team_permission_overrides = ?, updated_at = ? WHERE team_id = ? AND user_id = ?`,
    bindParams([JSON.stringify(overrides), now, teamId, userId]),
  );
  queueTableBump('team_members');
}

// ── Subteams ("crews") ───────────────────────────────────────────────────

interface CrewMemberRow {
  subteam_id: string;
  subteam_role: string | null;
  user_id: string;
  user_name: string | null;
}

// Group raw assignment rows under their subteams. First 'lead' row wins (the
// data model intends exactly one lead; converging pulls could briefly
// disagree — extra leads degrade to helpers rather than vanishing).
function buildCrews(subteams: Subteam[], memberRows: CrewMemberRow[]): Crew[] {
  const bySubteam = new Map<string, CrewMemberRow[]>();
  for (const row of memberRows) {
    const list = bySubteam.get(row.subteam_id);
    if (list) list.push(row); else bySubteam.set(row.subteam_id, [row]);
  }
  return subteams.map(st => {
    const rows = bySubteam.get(st.id) ?? [];
    let lead: CrewMember | undefined;
    const helpers: CrewMember[] = [];
    for (const r of rows) {
      const member: CrewMember = { id: r.user_id, name: r.user_name ?? r.user_id };
      if (r.subteam_role === 'lead' && !lead) lead = member;
      else helpers.push(member);
    }
    return { id: st.id, teamId: st.team_id, name: st.name, lead, helpers };
  });
}

function getCrewMemberRows(subteamIds: string[]): CrewMemberRow[] {
  if (subteamIds.length === 0) return [];
  const db = getDb();
  const placeholders = subteamIds.map(() => '?').join(',');
  return rowsAs<CrewMemberRow>(db.executeSync(
    `SELECT tm.subteam_id, tm.subteam_role, tm.user_id, u.name AS user_name
     FROM team_members tm
     LEFT JOIN users u ON u.id = tm.user_id
     WHERE tm.subteam_id IN (${placeholders})
     ORDER BY CASE tm.subteam_role WHEN 'lead' THEN 0 ELSE 1 END, u.name ASC`,
    subteamIds,
  ).rows);
}

export function getSubteamsForTeam(teamId: string): Crew[] {
  const db = getDb();
  const subteams = rowsAs<Subteam>(db.executeSync(
    `SELECT * FROM subteams WHERE team_id = ? AND active = 1 ORDER BY name ASC`,
    [teamId],
  ).rows);
  return buildCrews(subteams, getCrewMemberRows(subteams.map(s => s.id)));
}

// Active crews the user is assigned to (any team) — powers "My Crews".
export function getMyCrews(userId: string): Crew[] {
  const db = getDb();
  const subteams = rowsAs<Subteam>(db.executeSync(
    `SELECT s.* FROM subteams s
     JOIN team_members tm ON tm.subteam_id = s.id AND tm.user_id = ?
     WHERE s.active = 1
     ORDER BY s.name ASC`,
    [userId],
  ).rows);
  return buildCrews(subteams, getCrewMemberRows(subteams.map(s => s.id)));
}

function getSubteamById(id: string): Subteam | null {
  const db = getDb();
  return rowsAs<Subteam>(
    db.executeSync(`SELECT * FROM subteams WHERE id = ?`, [id]).rows,
  )[0] ?? null;
}

export function createSubteam(teamId: string, name: string): string {
  const id = generateUUID();
  const now = new Date().toISOString();
  subteamsRepo.mirror('INSERT', { id, team_id: teamId, name, active: true, created_at: now, updated_at: now }, () => {
    getDb().executeSync(
      `INSERT INTO subteams (id, team_id, name, active, created_at, updated_at, synced_at)
       VALUES (?, ?, ?, 1, ?, ?, NULL)`,
      bindParams([id, teamId, name, now, now]),
    );
  });
  return id;
}

// Returns the pre-rename { team_id, oldName } so the caller can build a log note.
export function renameSubteam(subteamId: string, name: string): { team_id: string; oldName: string } {
  const st = getSubteamById(subteamId);
  if (!st) throw new Error('Crew not found');
  const now = new Date().toISOString();
  subteamsRepo.mirror('UPDATE', { id: subteamId, name, updated_at: now }, () => {
    getDb().executeSync(`UPDATE subteams SET name = ?, updated_at = ? WHERE id = ?`, bindParams([name, now, subteamId]));
  });
  return { team_id: st.team_id, oldName: st.name };
}

// Assign/move a team member into a crew as lead/helper — an UPDATE on their
// existing team_members row. Throws if the user has no team_members row for
// the crew's team (not a member).
export function setSubteamMembership(
  subteamId: string,
  userId: string,
  role: 'lead' | 'helper',
): { team_id: string; name: string } {
  const st = getSubteamById(subteamId);
  if (!st) throw new Error('Crew not found');
  const now = new Date().toISOString();
  teamMembersRepo.mirror('UPDATE', { team_id: st.team_id, user_id: userId, subteam_id: subteamId, subteam_role: role, updated_at: now }, () => {
    const db = getDb();
    const exists = db.executeSync(
      `SELECT 1 FROM team_members WHERE team_id = ? AND user_id = ? LIMIT 1`,
      [st.team_id, userId],
    ).rows.length > 0;
    if (!exists) throw new Error('Not a member of this team');
    db.executeSync(
      `UPDATE team_members SET subteam_id = ?, subteam_role = ?, updated_at = ? WHERE team_id = ? AND user_id = ?`,
      bindParams([subteamId, role, now, st.team_id, userId]),
    );
  });
  return { team_id: st.team_id, name: st.name };
}

// Remove a member's crew assignment on a team. Returns null (no-op, no
// outbox/log) if the row doesn't exist or has no assignment.
export function clearSubteamMembership(teamId: string, userId: string): { team_id: string } | null {
  const row = getDb().executeSync(
    `SELECT subteam_id FROM team_members WHERE team_id = ? AND user_id = ?`,
    [teamId, userId],
  ).rows[0] as { subteam_id: string | null } | undefined;
  if (!row || row.subteam_id == null) return null;
  const now = new Date().toISOString();
  teamMembersRepo.mirror('UPDATE', { team_id: teamId, user_id: userId, subteam_id: null, subteam_role: null, updated_at: now }, () => {
    getDb().executeSync(
      `UPDATE team_members SET subteam_id = NULL, subteam_role = NULL, updated_at = ? WHERE team_id = ? AND user_id = ?`,
      bindParams([now, teamId, userId]),
    );
  });
  return { team_id: teamId };
}

// Soft-delete a crew: active → 0 (subteams DELETE is not part of the sync
// contract; the row stays for history) and clear every member's assignment.
// Atomic across both tables via runInTransaction; uses raw
// appendOutbox/queueTableBump directly since the write spans two repos.
export function deleteSubteam(subteamId: string): { team_id: string; name: string; memberUserIds: string[] } {
  const st = getSubteamById(subteamId);
  if (!st) throw new Error('Crew not found');
  const now = new Date().toISOString();
  const members = rowsAs<{ user_id: string }>(
    getDb().executeSync(`SELECT user_id FROM team_members WHERE subteam_id = ?`, [subteamId]).rows,
  );
  runInTransaction(() => {
    const db = getDb();
    db.executeSync(`UPDATE subteams SET active = 0, updated_at = ? WHERE id = ?`, bindParams([now, subteamId]));
    queueTableBump('subteams');
    appendOutbox('UPDATE', 'subteams', { id: subteamId, active: false, updated_at: now });
    for (const m of members) {
      db.executeSync(
        `UPDATE team_members SET subteam_id = NULL, subteam_role = NULL, updated_at = ? WHERE team_id = ? AND user_id = ?`,
        bindParams([now, st.team_id, m.user_id]),
      );
      queueTableBump('team_members');
      appendOutbox('UPDATE', 'team_members', {
        team_id: st.team_id, user_id: m.user_id, subteam_id: null, subteam_role: null, updated_at: now,
      });
    }
  });
  return { team_id: st.team_id, name: st.name, memberUserIds: members.map(m => m.user_id) };
}

// ── reconcileTeams (afterPull hook) ─────────────────────────────────────
// Ported from apps/mobile/src/sync/teamPurge.ts. Incremental /sync/pull is
// UPSERT-ONLY — it never deletes. Two consequences, the second permanent:
//  1. Pre-scoping devices downloaded every team's roster/overrides; scoping
//     the server does not retract those rows (one-time purge, flagged below).
//  2. Ongoing: when a user is removed from a team, the scoped pull just stops
//     returning it — nothing tells the device to forget it. So this must run
//     on every pull cycle (throttled internally), not just once.
// Deliberately does NOT call resetLocalDb() (would drop the outbox and
// destroy unpushed offline edits) — only touches teams + team_members.
const PURGE_FLAG = 'teams_purge_pending';
const LAST_RUN_KEY = 'teams_reconciled_at';
const RECONCILE_INTERVAL_MS = 60 * 60 * 1000;

function isTeamPurgePending(): boolean {
  return getAppSetting(PURGE_FLAG) === '1';
}

async function fetchServerIds(table: string, idCol: string, jwt: string): Promise<Set<string> | null> {
  const ids = new Set<string>();
  const limit = 500;
  for (let offset = 0; ; offset += limit) {
    const res = await fetch(`${API_BASE}/sync/full?table=${table}&limit=${limit}&offset=${offset}`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    // Any non-OK response means we do NOT know the authoritative set. Deleting
    // on a guess would wipe the user's own teams on a transient 500.
    if (!res.ok) return null;
    const body = (await res.json()) as { rows: Record<string, unknown>[]; hasMore: boolean };
    for (const row of body.rows) {
      const v = row[idCol];
      if (typeof v === 'string') ids.add(v);
    }
    if (!body.hasMore) break;
  }
  return ids;
}

function deleteLocalRowsNotIn(table: string, idCol: string, keep: Set<string>): number {
  const db = getDb();
  const local = db.executeSync(`SELECT DISTINCT ${idCol} AS id FROM ${table}`).rows as { id: string }[];
  const stale = local.map(r => r.id).filter(id => !keep.has(id));
  for (const id of stale) {
    db.executeSync(`DELETE FROM ${table} WHERE ${idCol} = ?`, [id]);
  }
  return stale.length;
}

/**
 * Delete local team rows the server no longer returns. Safe to call on every
 * pull cycle (throttled internally via app_settings). No-ops without a
 * session. Returns the number of rows removed, 0 if skipped, or -1 if the
 * server set could not be established (nothing deleted in that case).
 */
export async function reconcileTeams(): Promise<number> {
  const pending = isTeamPurgePending();
  if (!pending) {
    const last = Number(getAppSetting(LAST_RUN_KEY) ?? 0);
    if (Number.isFinite(last) && Date.now() - last < RECONCILE_INTERVAL_MS) return 0;
  }

  const jwt = await getValidJwt();
  if (!jwt) return -1;

  const teamIds = await fetchServerIds('teams', 'id', jwt);
  if (!teamIds) return -1;

  // team_members is keyed (team_id, user_id). Scoping it by team_id mirrors
  // the server's own predicate exactly.
  let removed = deleteLocalRowsNotIn('team_members', 'team_id', teamIds);
  removed += deleteLocalRowsNotIn('teams', 'id', teamIds);

  if (pending) deleteAppSetting(PURGE_FLAG);
  setAppSetting(LAST_RUN_KEY, String(Date.now()));
  return removed;
}
