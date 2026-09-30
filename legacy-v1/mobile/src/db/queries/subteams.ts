import { getDb, rowsAs, bindParams } from '../schema';
import { appendOutbox } from '../../sync/outbox';
import { appendLog } from './log';
import { runInTransaction } from '../tx';
import { generateUUID } from '../../utils/uuid';

// Subteams (#123, migration 041 / API 053): small crews inside a team — a lead
// plus one or more helpers (e.g. Frank Turner + Matt = "TV/FT"). A member's crew
// assignment lives ON their team_members row (subteam_id / subteam_role), so
// membership writes here are UPDATEs against team_members, never new rows.
// Server-side, subteams writes require manage_teams AND (org authority OR
// is_manager of that team) — the screen's canManageRoster gate is the courtesy
// mirror, the sync push guard is the enforcement of record.

export interface Subteam {
  id: string;
  team_id: string;
  name: string;
  active: number; // 0 | 1 (SQLite has no boolean)
  created_at: string;
  updated_at: string;
  synced_at: string | null; // local-only
}

export interface CrewMember {
  id: string;
  name: string;
}

// The denormalized shape the UI consumes (CrewCard / CrewEditor).
export interface Crew {
  id: string;
  teamId: string;
  name: string;
  lead?: CrewMember;
  helpers: CrewMember[];
}

interface CrewMemberRow {
  subteam_id: string;
  subteam_role: string | null;
  user_id: string;
  user_name: string | null;
}

// Group raw assignment rows under their subteams. First 'lead' row wins (the
// data model intends exactly one lead; converging pulls could briefly disagree,
// extra leads degrade gracefully into helpers rather than vanishing).
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

// Active crews of a team, each with its lead + helpers resolved to names.
export function getSubteamsForTeam(teamId: string): Crew[] {
  const db = getDb();
  const subteams = rowsAs<Subteam>(db.executeSync(
    `SELECT * FROM subteams WHERE team_id = ? AND active = 1 ORDER BY name ASC`,
    [teamId],
  ).rows);
  return buildCrews(subteams, getCrewMemberRows(subteams.map(s => s.id)));
}

// Active crews the user is assigned to (any team), full roster included —
// powers "My Crews" on Manage My Team.
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

// Insert a subteam locally + queue the outbox INSERT (synced_at stripped — the
// server table has no such column) + write an activity_log entry. Atomic (and
// reentrant — joins a caller's transaction, so create + membership assignments
// can commit as one unit). Returns the new subteam id.
export function createSubteam(teamId: string, name: string, userId: string | null): string {
  const id = generateUUID();
  const now = new Date().toISOString();
  runInTransaction(() => {
    const db = getDb();
    db.executeSync(
      `INSERT INTO subteams (id, team_id, name, active, created_at, updated_at, synced_at)
       VALUES (?, ?, ?, 1, ?, ?, NULL)`,
      bindParams([id, teamId, name, now, now]),
    );
    appendOutbox('INSERT', 'subteams', {
      id, team_id: teamId, name, active: 1, created_at: now, updated_at: now,
    });
    appendLog({
      user_id: userId,
      team_id: teamId,
      action: 'subteam_created',
      entity_type: 'team',
      entity_id: teamId,
      from_location_id: null,
      to_location_id: null,
      quantity: null,
      unit: null,
      job_id: null,
      note: name,
      metadata: JSON.stringify({ subteam_id: id }),
      device_id: null,
    });
  });
  return id;
}

function getSubteamById(id: string): Subteam | null {
  const db = getDb();
  return rowsAs<Subteam>(
    db.executeSync(`SELECT * FROM subteams WHERE id = ?`, [id]).rows,
  )[0] ?? null;
}

// Rename a crew. Throws if the subteam is unknown locally (rolls back any
// enclosing transaction).
export function renameSubteam(subteamId: string, name: string, userId: string | null): void {
  const now = new Date().toISOString();
  runInTransaction(() => {
    const st = getSubteamById(subteamId);
    if (!st) throw new Error('Crew not found');
    const db = getDb();
    db.executeSync(
      `UPDATE subteams SET name = ?, updated_at = ? WHERE id = ?`,
      bindParams([name, now, subteamId]),
    );
    appendOutbox('UPDATE', 'subteams', { id: subteamId, name, updated_at: now });
    appendLog({
      user_id: userId,
      team_id: st.team_id,
      action: 'subteam_updated',
      entity_type: 'team',
      entity_id: st.team_id,
      from_location_id: null,
      to_location_id: null,
      quantity: null,
      unit: null,
      job_id: null,
      note: `${st.name} → ${name}`,
      metadata: JSON.stringify({ subteam_id: subteamId, renamed: true }),
      device_id: null,
    });
  });
}

// Assign (or move) a team member into a crew as lead/helper — an UPDATE on
// their existing team_members row (subteam_id/subteam_role, migration 041).
// Throws if the user has no team_members row for the crew's team (not a
// member), rolling back any enclosing transaction. Payload carries ONLY the
// composite key + subteam columns so it can't clobber concurrent edits to
// overrides (and never touches server-controlled is_manager).
export function setSubteamMembership(
  subteamId: string,
  userId: string,
  role: 'lead' | 'helper',
  actorId: string | null,
): void {
  const now = new Date().toISOString();
  runInTransaction(() => {
    const st = getSubteamById(subteamId);
    if (!st) throw new Error('Crew not found');
    const db = getDb();
    const res = db.executeSync(
      `UPDATE team_members SET subteam_id = ?, subteam_role = ?, updated_at = ?
       WHERE team_id = ? AND user_id = ?`,
      bindParams([subteamId, role, now, st.team_id, userId]),
    );
    if (res.rowsAffected < 1) throw new Error('Not a member of this team');
    appendOutbox('UPDATE', 'team_members', {
      team_id: st.team_id,
      user_id: userId,
      subteam_id: subteamId,
      subteam_role: role,
      updated_at: now,
    });
    appendLog({
      user_id: actorId,
      team_id: st.team_id,
      action: 'subteam_updated',
      entity_type: 'team',
      entity_id: st.team_id,
      from_location_id: null,
      to_location_id: null,
      quantity: null,
      unit: null,
      job_id: null,
      note: st.name,
      metadata: JSON.stringify({ subteam_id: subteamId, member_user_id: userId, subteam_role: role }),
      device_id: null,
    });
  });
}

// Remove a member's crew assignment on a team (subteam columns → NULL). No-op
// (no outbox/log) if the row doesn't exist or has no assignment — safe to call
// from diff loops.
export function clearSubteamMembership(userId: string, teamId: string, actorId: string | null): void {
  const now = new Date().toISOString();
  runInTransaction(() => {
    const db = getDb();
    const res = db.executeSync(
      `UPDATE team_members SET subteam_id = NULL, subteam_role = NULL, updated_at = ?
       WHERE team_id = ? AND user_id = ? AND subteam_id IS NOT NULL`,
      bindParams([now, teamId, userId]),
    );
    if (res.rowsAffected < 1) return;
    appendOutbox('UPDATE', 'team_members', {
      team_id: teamId,
      user_id: userId,
      subteam_id: null,
      subteam_role: null,
      updated_at: now,
    });
    appendLog({
      user_id: actorId,
      team_id: teamId,
      action: 'subteam_updated',
      entity_type: 'team',
      entity_id: teamId,
      from_location_id: null,
      to_location_id: null,
      quantity: null,
      unit: null,
      job_id: null,
      note: null,
      metadata: JSON.stringify({ member_user_id: userId, subteam_cleared: true }),
      device_id: null,
    });
  });
}

// Soft-delete a crew: active → 0 (DELETE on subteams is not part of the sync
// contract; the row stays for history) and clear every member's assignment.
// Atomic — the deactivate, the membership clears, their outbox rows, and one
// log entry commit together.
export function deleteSubteam(subteamId: string, actorId: string | null): void {
  const now = new Date().toISOString();
  runInTransaction(() => {
    const st = getSubteamById(subteamId);
    if (!st) throw new Error('Crew not found');
    const db = getDb();
    const members = rowsAs<{ user_id: string }>(db.executeSync(
      `SELECT user_id FROM team_members WHERE subteam_id = ?`,
      [subteamId],
    ).rows);
    db.executeSync(
      `UPDATE subteams SET active = 0, updated_at = ? WHERE id = ?`,
      bindParams([now, subteamId]),
    );
    appendOutbox('UPDATE', 'subteams', { id: subteamId, active: 0, updated_at: now });
    for (const m of members) {
      db.executeSync(
        `UPDATE team_members SET subteam_id = NULL, subteam_role = NULL, updated_at = ?
         WHERE team_id = ? AND user_id = ?`,
        bindParams([now, st.team_id, m.user_id]),
      );
      appendOutbox('UPDATE', 'team_members', {
        team_id: st.team_id,
        user_id: m.user_id,
        subteam_id: null,
        subteam_role: null,
        updated_at: now,
      });
    }
    appendLog({
      user_id: actorId,
      team_id: st.team_id,
      action: 'subteam_updated',
      entity_type: 'team',
      entity_id: st.team_id,
      from_location_id: null,
      to_location_id: null,
      quantity: null,
      unit: null,
      job_id: null,
      note: `${st.name} deleted`,
      metadata: JSON.stringify({ subteam_id: subteamId, deleted: true }),
      device_id: null,
    });
  });
}
