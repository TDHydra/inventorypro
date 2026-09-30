import { getDb, bindParams, rowsAs } from '../schema';
import { appendOutbox } from '../../sync/outbox';
import { generateUUID } from '../../utils/uuid';

// #173: rooms catalog (Kitchen, Garage, Basement, …) — a small synced table so
// a job photo can be tagged to a specific room. Mirrors the addTaxonomyType
// dedup/reactivate pattern in ./taxonomy.ts, but rooms is its own dedicated
// table (not a taxonomy_types category) since it carries no label/icon/
// sort_order/meta shape.
export interface Room {
  id: string;
  name: string;
  active: number;
  created_at: string;
  updated_at: string;
}

export function getRooms(opts?: { includeInactive?: boolean }): Room[] {
  const db = getDb();
  const sql = opts?.includeInactive
    ? `SELECT * FROM rooms ORDER BY name COLLATE NOCASE ASC`
    : `SELECT * FROM rooms WHERE active = 1 ORDER BY name COLLATE NOCASE ASC`;
  return rowsAs<Room>(db.executeSync(sql).rows);
}

// Case-insensitive dedup: reactivate an inactive match instead of inserting a
// second row (would cause duplicate React keys in the picker). Returns the
// resolved room id either way, so a picker's "+ Create" can select it
// immediately.
export function addRoom(name: string): string {
  const db = getDb();
  const trimmed = name.trim();

  const dupResult = db.executeSync(
    `SELECT * FROM rooms WHERE LOWER(name) = LOWER(?) LIMIT 1`,
    [trimmed],
  );
  const dup = rowsAs<Room>(dupResult.rows)[0];
  if (dup) {
    if (dup.active !== 1) {
      const updated_at = new Date().toISOString();
      db.executeSync(`UPDATE rooms SET active = 1, updated_at = ? WHERE id = ?`, [updated_at, dup.id]);
      appendOutbox('INSERT', 'rooms', { id: dup.id, name: dup.name, active: true, created_at: dup.created_at, updated_at });
    }
    return dup.id;
  }

  const id = generateUUID();
  const now = new Date().toISOString();
  db.executeSync(
    `INSERT OR REPLACE INTO rooms (id, name, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    bindParams([id, trimmed, 1, now, now]),
  );
  appendOutbox('INSERT', 'rooms', { id, name: trimmed, active: true, created_at: now, updated_at: now });
  return id;
}
