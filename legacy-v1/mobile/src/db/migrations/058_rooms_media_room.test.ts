import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqlJsDb } from './sqljsTestDb';
import { migration } from './058_rooms_media_room';
import type { SqlDb } from '../types';

let db: SqlDb;
before(async () => {
  db = await makeSqlJsDb();
  // Pre-058 media shape (minimal columns relevant here).
  db.executeSync(`CREATE TABLE media (
    id TEXT PRIMARY KEY, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
    media_type TEXT NOT NULL, url TEXT NOT NULL, caption TEXT,
    created_at TEXT NOT NULL, updated_at TEXT, synced_at TEXT
  )`);
  db.executeSync(
    `INSERT INTO media (id, entity_type, entity_id, media_type, url, created_at)
     VALUES ('m-1', 'job', 'j-1', 'image', 'https://x/y.jpg', '2026-07-01T00:00:00.000Z')`,
  );
  migration.up(db);
});

test('058: rooms table created with expected columns', () => {
  db.executeSync(
    `INSERT INTO rooms (id, name, active, created_at, updated_at)
     VALUES ('r-1', 'Kitchen', 1, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')`,
  );
  const r = db.executeSync(`SELECT * FROM rooms WHERE id = 'r-1'`).rows[0] as {
    name: string; active: number; synced_at: string | null;
  };
  assert.equal(r.name, 'Kitchen');
  assert.equal(r.active, 1);
  assert.equal(r.synced_at, null);
});

test('058: rooms.active defaults to 1', () => {
  db.executeSync(
    `INSERT INTO rooms (id, name, created_at, updated_at)
     VALUES ('r-2', 'Garage', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')`,
  );
  const r = db.executeSync(`SELECT active FROM rooms WHERE id = 'r-2'`).rows[0] as { active: number };
  assert.equal(r.active, 1);
});

test('058: existing media row gets a NULL room_id', () => {
  const r = db.executeSync(`SELECT room_id FROM media WHERE id = 'm-1'`).rows[0] as { room_id: string | null };
  assert.equal(r.room_id, null);
});

test('058: a new media row can carry a room_id', () => {
  db.executeSync(
    `INSERT INTO media (id, entity_type, entity_id, media_type, url, room_id, created_at)
     VALUES ('m-2', 'job', 'j-1', 'image', 'https://x/z.jpg', 'r-1', '2026-07-02T00:00:00.000Z')`,
  );
  const r = db.executeSync(`SELECT room_id FROM media WHERE id = 'm-2'`).rows[0] as { room_id: string | null };
  assert.equal(r.room_id, 'r-1');
});
