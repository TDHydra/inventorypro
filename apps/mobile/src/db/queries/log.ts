import { getDb, rowsAs } from '../schema';
import { generateUUID } from '../../utils/uuid';
import { appendOutbox } from '../../sync/outbox';
import { track } from '../../telemetry';

export interface LogEntry {
  id: string;
  user_id: string | null;
  team_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  from_location_id: string | null;
  to_location_id: string | null;
  quantity: number | null;
  unit: string | null;
  job_id: string | null;
  note: string | null;
  metadata: string | null; // JSON string
  device_id: string | null;
  created_at: string;
  synced_at: string | null;
  latitude: number | null;
  longitude: number | null;
  location_accuracy: number | null;
  // Present when the query joins the users table
  user_name?: string | null;
}

export function appendLog(
  // Coords are Omitted from the base and re-added as optional so the existing
  // (non-move) call sites don't have to pass them; they default to null.
  // id is optional: callers that supply it (e.g. the move-confirm flow re-using
  // checkoutEventId) get a deterministic row id; omitting it auto-generates one.
  entry: Omit<LogEntry, 'id' | 'created_at' | 'synced_at' | 'latitude' | 'longitude' | 'location_accuracy'> & {
    id?: string;
    latitude?: number | null;
    longitude?: number | null;
    location_accuracy?: number | null;
  },
): void {
  const db = getDb();
  const id = entry.id ?? generateUUID();
  const created_at = new Date().toISOString();
  const latitude = entry.latitude ?? null;
  const longitude = entry.longitude ?? null;
  const location_accuracy = entry.location_accuracy ?? null;
  db.executeSync(
    `INSERT INTO activity_log
       (id, user_id, team_id, action, entity_type, entity_id,
        from_location_id, to_location_id, quantity, unit, job_id,
        note, metadata, device_id, created_at, synced_at,
        latitude, longitude, location_accuracy)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    [id, entry.user_id, entry.team_id, entry.action, entry.entity_type,
     entry.entity_id, entry.from_location_id, entry.to_location_id,
     entry.quantity, entry.unit, entry.job_id, entry.note,
     entry.metadata, entry.device_id, created_at,
     latitude, longitude, location_accuracy]
  );
  // Sync the row to the server's append-only log (idempotent insert server-side).
  appendOutbox('INSERT', 'activity_log', {
    id, user_id: entry.user_id, team_id: entry.team_id, action: entry.action,
    entity_type: entry.entity_type, entity_id: entry.entity_id,
    from_location_id: entry.from_location_id, to_location_id: entry.to_location_id,
    quantity: entry.quantity, unit: entry.unit, job_id: entry.job_id,
    note: entry.note, metadata: entry.metadata, device_id: entry.device_id, created_at,
    latitude, longitude, location_accuracy,
  });
  // Audit blend: every business action logged here also shows up in
  // telemetry as an 'audit' event (name only, entity kind via the allowlisted
  // `table` prop — never note/metadata content) so dashboards see business
  // activity without instrumenting each call site individually. track() never
  // throws, so this can't affect the business log write above.
  track('audit', entry.action, { props: { table: entry.entity_type } });
}

export function getLogForUser(userId: string, limit = 50): LogEntry[] {
  const db = getDb();
  const result = db.executeSync(
    `SELECT al.*, u.name AS user_name
     FROM activity_log al
     LEFT JOIN users u ON u.id = al.user_id
     WHERE al.user_id = ?
     ORDER BY al.created_at DESC LIMIT ?`,
    [userId, limit]
  );
  return rowsAs<LogEntry>(result.rows);
}

export function getLogForJob(jobId: string): LogEntry[] {
  const db = getDb();
  const result = db.executeSync(
    `SELECT al.*, u.name AS user_name
     FROM activity_log al
     LEFT JOIN users u ON u.id = al.user_id
     WHERE al.job_id = ?
     ORDER BY al.created_at DESC`,
    [jobId]
  );
  return rowsAs<LogEntry>(result.rows);
}

export function getUnsyncedLogs(): LogEntry[] {
  const db = getDb();
  const result = db.executeSync(
    `SELECT * FROM activity_log WHERE synced_at IS NULL ORDER BY created_at ASC LIMIT 100`
  );
  return rowsAs<LogEntry>(result.rows);
}

export function markLogsSynced(ids: string[]): void {
  if (ids.length === 0) return;
  const db = getDb();
  const placeholders = ids.map(() => '?').join(',');
  const now = new Date().toISOString();
  db.executeSync(
    `UPDATE activity_log SET synced_at = ? WHERE id IN (${placeholders})`,
    [now, ...ids]
  );
}

/**
 * Reconciles each local activity_log row's synced_at against the outbox.
 *
 * activity_log is push-only (it's never pulled back from the server), so a
 * row's synced_at is ONLY ever cleared here. A row is considered synced once
 * it no longer has an un-synced outbox entry referencing it. Idempotent, and
 * self-heals rows left permanently "pending" by older builds that pushed the
 * row but never updated its synced_at.
 *
 * Done in JS (not a json_extract subquery) so it doesn't depend on the SQLite
 * JSON1 extension being available in op-sqlite.
 */
export function reconcileLogSyncState(): void {
  const db = getDb();

  const unsynced = (db.executeSync(
    `SELECT id FROM activity_log WHERE synced_at IS NULL`
  ).rows as { id: string }[]).map(r => r.id);
  if (unsynced.length === 0) return;

  // Row ids still awaiting a push (un-synced activity_log outbox entries).
  const pendingRows = db.executeSync(
    `SELECT payload FROM outbox WHERE table_name = 'activity_log' AND synced_at IS NULL`
  ).rows as { payload: string }[];
  const stillPending = new Set<string>();
  for (const r of pendingRows) {
    try {
      const id = (JSON.parse(r.payload) as { id?: string }).id;
      if (id) stillPending.add(String(id));
    } catch {
      // Unparseable payload — leave its row pending rather than guess.
    }
  }

  markLogsSynced(unsynced.filter(id => !stillPending.has(id)));
}

export function getLogForEntity(
  entityType: string,
  entityId: string,
  limit = 50,
): LogEntry[] {
  const db = getDb();
  const result = db.executeSync(
    `SELECT al.*, u.name AS user_name
     FROM activity_log al
     LEFT JOIN users u ON u.id = al.user_id
     WHERE al.entity_type = ? AND al.entity_id = ?
     ORDER BY al.created_at DESC LIMIT ?`,
    [entityType, entityId, limit],
  );
  return rowsAs<LogEntry>(result.rows);
}

export function getRecentLog(limit = 100): LogEntry[] {
  const db = getDb();
  const result = db.executeSync(
    `SELECT al.*, u.name AS user_name
     FROM activity_log al
     LEFT JOIN users u ON u.id = al.user_id
     ORDER BY al.created_at DESC LIMIT ?`,
    [limit],
  );
  return rowsAs<LogEntry>(result.rows);
}

export interface LogFilter {
  userId?: string;
  action?: string;
  entityType?: string;
  teamId?: string;
  sinceISO?: string;
  untilISO?: string;
  /** Case-insensitive substring match over the row's note. */
  search?: string;
}

export function getLogFiltered(f: LogFilter, limit = 200): LogEntry[] {
  const db = getDb();
  const clauses: string[] = [];
  const params: (string | number | null)[] = [];

  if (f.userId != null) {
    clauses.push('al.user_id = ?');
    params.push(f.userId);
  }
  if (f.action != null) {
    clauses.push('al.action = ?');
    params.push(f.action);
  }
  if (f.entityType != null) {
    clauses.push('al.entity_type = ?');
    params.push(f.entityType);
  }
  if (f.teamId != null) {
    clauses.push('al.team_id = ?');
    params.push(f.teamId);
  }
  if (f.sinceISO != null) {
    clauses.push('al.created_at >= ?');
    params.push(f.sinceISO);
  }
  if (f.untilISO != null) {
    clauses.push('al.created_at <= ?');
    params.push(f.untilISO);
  }
  const search = f.search?.trim();
  if (search) {
    clauses.push('al.note LIKE ?');
    params.push(`%${search}%`);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(limit);

  const result = db.executeSync(
    `SELECT al.*, u.name AS user_name
     FROM activity_log al
     LEFT JOIN users u ON u.id = al.user_id
     ${where}
     ORDER BY al.created_at DESC LIMIT ?`,
    params,
  );
  return rowsAs<LogEntry>(result.rows);
}

// ── id → human-name resolution ────────────────────────────────────────────────
// Activity-log rows reference users/teams/jobs/locations by id. Loading these
// four tiny (id, name) maps ONCE per render lets the screen resolve every row's
// actor/team/job/location by lookup instead of a per-row DB query. Locations are
// pulled unfiltered (incl. archived) so ids on historical rows still resolve.

export interface LogNameMaps {
  users: Record<string, string>;
  teams: Record<string, string>;
  jobs: Record<string, string>;
  locations: Record<string, string>;
}

function idNameMap(table: string): Record<string, string> {
  const rows = getDb().executeSync(`SELECT id, name FROM ${table}`).rows as {
    id: string;
    name: string | null;
  }[];
  const map: Record<string, string> = {};
  for (const r of rows) if (r.name) map[r.id] = r.name;
  return map;
}

export function getLogNameMaps(): LogNameMaps {
  return {
    users: idNameMap('users'),
    teams: idNameMap('teams'),
    jobs: idNameMap('jobs'),
    locations: idNameMap('locations'),
  };
}

// Resolve a log row's entity_id to a display name when entity_type names a table
// we hold an id→name map for (user/team/job/location + their plural forms). Falls
// back to null so the caller can hide the field rather than show a raw uuid.
export function resolveEntityName(
  maps: LogNameMaps,
  entityType: string | null | undefined,
  entityId: string | null | undefined,
): string | null {
  if (!entityId) return null;
  switch (entityType) {
    case 'user':
    case 'users':
      return maps.users[entityId] ?? null;
    case 'team':
    case 'teams':
      return maps.teams[entityId] ?? null;
    case 'job':
    case 'jobs':
      return maps.jobs[entityId] ?? null;
    case 'location':
    case 'locations':
      return maps.locations[entityId] ?? null;
    default:
      return null;
  }
}
