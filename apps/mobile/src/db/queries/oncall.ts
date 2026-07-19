import { getDb, rowsAs, bindParams } from '../schema';
import { appendOutbox } from '../../sync/outbox';
import { appendLog } from './log';
import { runInTransaction } from '../tx';
import { generateUUID } from '../../utils/uuid';
import {
  boundaryWeekStartIso, enumerateWeeks, parseWeekBoundary, rotationIndexForWeek,
  type WeekBoundary,
} from '../../components/oncall/weekMath';
import { getAppConfig } from '../appConfig';

// On-call calendar queries (#128). One crew (subteam) covers each week —
// on_call_shifts is UNIQUE(week_start) locally AND the server's upsert conflict
// target, so a reassignment is a plain INSERT with a NEW id: the server replaces
// the row for that week, and the local INSERT OR REPLACE converges the same way
// (see migration 044). week_start is the boundary-week date from weekMath.ts
// (admin-configured day/hour, default Thursday 08:00 — migration 048 re-keyed
// the legacy Monday rows).

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

// The admin-configured week boundary (app_config 'on_call_week_boundary'),
// tolerant-parsed with the Thursday 08:00 default.
export function getWeekBoundary(): WeekBoundary {
  return parseWeekBoundary(getAppConfig('on_call_week_boundary'));
}

// The admin-configured rotation order (app_config 'on_call_rotation'): an
// ordered JSON array of subteam ids. Malformed/absent → empty (no auto-fill).
export function getRotation(): string[] {
  try {
    const parsed = JSON.parse(getAppConfig('on_call_rotation') ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
}

// Current + 8 forward — matches OnCallCalendar's weeksForward default.
export const ROTATION_FILL_WEEKS = 9;

// Materialize the rotation into on_call_shifts for the current + next 8
// boundary weeks. Fills ONLY empty weeks (a manual assignWeek override is a
// real row → sticky, and never shifts the rest: slots are calendar-anchored
// via rotationIndexForWeek). Caller MUST hold manage_teams (server gate on
// on_call_shifts INSERT) — gate at the call site. No activity log per row
// (autofill is mechanical, not a user action). Returns rows inserted.
export function ensureRotationFill(todayIso: string, hourOfDay: number, userId: string | null): number {
  const rotation = getRotation();
  if (rotation.length === 0) return 0;
  const boundary = getWeekBoundary();
  const weeks = enumerateWeeks(
    boundaryWeekStartIso(todayIso, hourOfDay, boundary), ROTATION_FILL_WEEKS, boundary.day);
  const have = new Set(getShifts(weeks[0], weeks[weeks.length - 1]).map(s => s.week_start));
  const missing = weeks.filter(w => !have.has(w));
  if (missing.length === 0) return 0;
  const now = new Date().toISOString();
  runInTransaction(() => {
    for (const week of missing) {
      const id = generateUUID();
      const subteamId = rotation[rotationIndexForWeek(week, rotation.length)];
      getDb().executeSync(
        `INSERT OR REPLACE INTO on_call_shifts (id, subteam_id, week_start, created_by, created_at, updated_at, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`,
        bindParams([id, subteamId, week, userId, now, now]),
      );
      appendOutbox('INSERT', 'on_call_shifts', {
        id, subteam_id: subteamId, week_start: week,
        created_by: userId, created_at: now, updated_at: now,
      });
    }
  });
  return missing.length;
}

// The shift covering the boundary week containing the local instant (todayIso,
// hourOfDay), or null when unassigned. Hours BEFORE the boundary hour on the
// boundary day still belong to the previous week (Thursday 07:59 → last
// week's crew). 'Now' is parameters so the function stays pure over the clock.
export function getCurrentShift(todayIso: string, hourOfDay: number): OnCallShift | null {
  const db = getDb();
  return rowsAs<OnCallShift>(db.executeSync(
    `SELECT ocs.*, st.name AS subteam_name, st.team_id AS team_id
       FROM on_call_shifts ocs
       LEFT JOIN subteams st ON st.id = ocs.subteam_id
      WHERE ocs.week_start = ?`,
    [boundaryWeekStartIso(todayIso, hourOfDay, getWeekBoundary())],
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

// A coverage/time-off row ("X is covering for Y from A to B") joined to the
// two user names for display. Soft FKs — names are null when the user row
// hasn't synced yet.
export interface CoverageRow {
  id: string;
  date_start: string;
  date_end: string;
  user_off: string | null;
  covering_user: string | null;
  note: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  synced_at: string | null;
  user_off_name: string | null;
  covering_user_name: string | null;
}

// Coverage rows OVERLAPPING [fromIso, toIso] (inclusive both ends), ascending
// by start date. ISO dates of equal length compare correctly as strings.
export function getCoverage(fromIso: string, toIso: string): CoverageRow[] {
  const db = getDb();
  return rowsAs<CoverageRow>(db.executeSync(
    `SELECT oc.*, uo.name AS user_off_name, uc.name AS covering_user_name
       FROM on_call_coverage oc
       LEFT JOIN users uo ON uo.id = oc.user_off
       LEFT JOIN users uc ON uc.id = oc.covering_user
      WHERE oc.date_end >= ? AND oc.date_start <= ?
      ORDER BY oc.date_start ASC`,
    [fromIso, toIso],
  ).rows);
}

// PM-authored coverage entry: atomic local INSERT + outbox + activity log
// (the assignWeek transaction shape). Server-side the INSERT is gated on
// manage_teams — gate the form at the call site. Logs entity_type 'team' with
// entity_id NULL (activity_log entity_id is a UUID column server-side — the
// names/dates go in note + metadata, never entity_id). Returns the new id.
export function createCoverage(input: {
  dateStart: string;
  dateEnd: string;
  userOff: string;
  coveringUser: string;
  note: string | null;
  createdBy: string | null;
}): string {
  const id = generateUUID();
  const now = new Date().toISOString();
  const userName = (userId: string): string => rowsAs<{ name: string }>(getDb().executeSync(
    `SELECT name FROM users WHERE id = ?`,
    [userId],
  ).rows)[0]?.name ?? 'someone';
  const offName = userName(input.userOff);
  const coveringName = userName(input.coveringUser);
  runInTransaction(() => {
    getDb().executeSync(
      `INSERT INTO on_call_coverage
         (id, date_start, date_end, user_off, covering_user, note, created_by, created_at, updated_at, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      bindParams([id, input.dateStart, input.dateEnd, input.userOff, input.coveringUser,
        input.note, input.createdBy, now, now]),
    );
    appendOutbox('INSERT', 'on_call_coverage', {
      id, date_start: input.dateStart, date_end: input.dateEnd,
      user_off: input.userOff, covering_user: input.coveringUser,
      note: input.note, created_by: input.createdBy, created_at: now, updated_at: now,
    });
    appendLog({
      action: 'on_call_coverage_added',
      entity_type: 'team',
      entity_id: null,
      user_id: input.createdBy,
      team_id: null,
      job_id: null,
      note: `Coverage: ${coveringName} for ${offName}, ${input.dateStart} – ${input.dateEnd}`,
      from_location_id: null,
      to_location_id: null,
      quantity: null,
      unit: null,
      metadata: JSON.stringify({
        coverage_id: id, date_start: input.dateStart, date_end: input.dateEnd,
        user_off: input.userOff, covering_user: input.coveringUser,
      }),
      device_id: null,
    });
  });
  return id;
}
