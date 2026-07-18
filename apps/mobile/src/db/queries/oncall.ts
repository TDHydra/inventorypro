import { getDb, rowsAs, bindParams } from '../schema';
import { appendOutbox } from '../../sync/outbox';
import { appendLog } from './log';
import { runInTransaction } from '../tx';
import { generateUUID } from '../../utils/uuid';
import { weekStartIso } from '../../components/oncall/weekMath';

// On-call calendar queries (#128). One crew (subteam) covers each week —
// on_call_shifts is UNIQUE(week_start) locally AND the server's upsert conflict
// target, so a reassignment is a plain INSERT with a NEW id: the server replaces
// the row for that week, and the local INSERT OR REPLACE converges the same way
// (see migration 044). week_start is always the ISO Monday from weekMath.ts.

// An on_call_shifts row joined to its crew (subteam) for display. subteam_name /
// team_id are null when the shift references a crew this device hasn't pulled
// yet (soft FK, sync-order-safe).
export interface OnCallShift {
  id: string;
  subteam_id: string | null;
  week_start: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  synced_at: string | null;
  subteam_name: string | null;
  team_id: string | null;
}

// A crew option for the assignment picker. NOTE (B4): queries/subteams.ts (B1)
// didn't exist when this module was written, so this queries subteams directly;
// if B1 lands richer crew queries (getMyCrews/getSubteamsForTeam) callers can
// switch — the shape here is deliberately minimal (picker-only).
export interface AssignableCrew {
  id: string;
  name: string;
  team_id: string;
  team_name: string | null;
}

// Shifts whose week_start falls in [fromWeekIso, toWeekIso] (inclusive),
// ascending. ISO dates of equal length compare correctly as strings.
export function getShifts(fromWeekIso: string, toWeekIso: string): OnCallShift[] {
  const db = getDb();
  return rowsAs<OnCallShift>(db.executeSync(
    `SELECT ocs.*, st.name AS subteam_name, st.team_id AS team_id
       FROM on_call_shifts ocs
       LEFT JOIN subteams st ON st.id = ocs.subteam_id
      WHERE ocs.week_start >= ? AND ocs.week_start <= ?
      ORDER BY ocs.week_start ASC`,
    [fromWeekIso, toWeekIso],
  ).rows);
}

// The shift covering the week that contains todayIso (Monday-start weeks —
// weekMath canonical form), or null when unassigned. 'Today' is a parameter so
// the function stays pure over the clock (callers pass their local date).
export function getCurrentShift(todayIso: string): OnCallShift | null {
  const db = getDb();
  return rowsAs<OnCallShift>(db.executeSync(
    `SELECT ocs.*, st.name AS subteam_name, st.team_id AS team_id
       FROM on_call_shifts ocs
       LEFT JOIN subteams st ON st.id = ocs.subteam_id
      WHERE ocs.week_start = ?`,
    [weekStartIso(todayIso)],
  ).rows)[0] ?? null;
}

// Active crews for the assignment picker, alphabetical, with the parent team's
// name for the sublabel. See AssignableCrew note re: B1's subteams module.
export function getAssignableCrews(): AssignableCrew[] {
  const db = getDb();
  return rowsAs<AssignableCrew>(db.executeSync(
    `SELECT st.id, st.name, st.team_id, t.name AS team_name
       FROM subteams st
       LEFT JOIN teams t ON t.id = st.team_id
      WHERE st.active = 1
      ORDER BY st.name ASC`,
  ).rows);
}

// Assign a crew to a week (subteamId set) or clear the week (subteamId null).
// Atomic local write + outbox + activity log (createMaintenanceEvent pattern).
//
// - Assign: INSERT OR REPLACE keyed on UNIQUE(week_start) with a NEW id +
//   outbox INSERT — the server upserts on conflict target week_start, so a
//   reassignment pushed as INSERT replaces the previous crew for that week.
// - Clear: local DELETE + outbox DELETE by id (on_call_shifts DELETE requires
//   manage_teams server-side — same gate as INSERT, fine). No-op when the week
//   is already unassigned.
//
// Logs action 'on_call_assigned' against entity_type 'team' (activity_log
// entity_id/team_id are UUID columns server-side — never put week_start or a
// crew label there; the week/crew go in note + metadata instead).
// Returns the new shift id, or null when clearing.
export function assignWeek(
  weekStartIso: string,
  subteamId: string | null,
  userId: string | null,
): string | null {
  const db = getDb();
  const now = new Date().toISOString();
  const existing = rowsAs<{ id: string; subteam_id: string | null }>(db.executeSync(
    `SELECT id, subteam_id FROM on_call_shifts WHERE week_start = ?`,
    [weekStartIso],
  ).rows)[0] ?? null;

  if (subteamId === null) {
    if (!existing) return null; // already unassigned
    const prevTeamId = existing.subteam_id ? subteamTeamId(existing.subteam_id) : null;
    runInTransaction(() => {
      getDb().executeSync(`DELETE FROM on_call_shifts WHERE id = ?`, [existing.id]);
      appendOutbox('DELETE', 'on_call_shifts', { id: existing.id });
      appendLog({
        action: 'on_call_assigned',
        entity_type: 'team',
        entity_id: prevTeamId,
        user_id: userId,
        team_id: prevTeamId,
        job_id: null,
        note: `On-call cleared for week of ${weekStartIso}`,
        from_location_id: null,
        to_location_id: null,
        quantity: null,
        unit: null,
        metadata: JSON.stringify({ week_start: weekStartIso, subteam_id: null }),
        device_id: null,
      });
    });
    return null;
  }

  const id = generateUUID();
  const crew = rowsAs<{ name: string; team_id: string }>(getDb().executeSync(
    `SELECT name, team_id FROM subteams WHERE id = ?`,
    [subteamId],
  ).rows)[0] ?? null;
  runInTransaction(() => {
    // INSERT OR REPLACE resolves the UNIQUE(week_start) conflict by replacing
    // any superseded assignment — mirrors the server's week_start upsert.
    getDb().executeSync(
      `INSERT OR REPLACE INTO on_call_shifts (id, subteam_id, week_start, created_by, created_at, updated_at, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      bindParams([id, subteamId, weekStartIso, userId, now, now]),
    );
    appendOutbox('INSERT', 'on_call_shifts', {
      id, subteam_id: subteamId, week_start: weekStartIso,
      created_by: userId, created_at: now, updated_at: now,
    });
    appendLog({
      action: 'on_call_assigned',
      entity_type: 'team',
      entity_id: crew?.team_id ?? null,
      user_id: userId,
      team_id: crew?.team_id ?? null,
      job_id: null,
      note: `On-call ${crew?.name ?? 'crew'} — week of ${weekStartIso}`,
      from_location_id: null,
      to_location_id: null,
      quantity: null,
      unit: null,
      metadata: JSON.stringify({ week_start: weekStartIso, subteam_id: subteamId }),
      device_id: null,
    });
  });
  return id;
}

function subteamTeamId(subteamId: string): string | null {
  const db = getDb();
  return rowsAs<{ team_id: string }>(db.executeSync(
    `SELECT team_id FROM subteams WHERE id = ?`,
    [subteamId],
  ).rows)[0]?.team_id ?? null;
}
