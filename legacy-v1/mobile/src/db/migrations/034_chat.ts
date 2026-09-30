import type { SqlDb } from '../types';

// Migration 034: synced chat (DM + group messaging). Mirrors API migration 040.
// SQLite has no native uuid/timestamptz (TEXT here) and no REFERENCES (the server
// owns FK integrity). All three tables sync; pull is SCOPED server-side so a device
// only ever holds conversations/participants/messages it participates in.
//   conversations              — the DM/group container.
//   conversation_participants  — membership + per-user notify_pref/last_read_at
//                                (composite PK conversation_id,user_id).
//   messages                   — the message stream; urgency gates push fan-out.
export const migration = {
  version: 34,
  up: (db: SqlDb): void => {
    db.executeSync(`CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'dm',
      title TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);

    db.executeSync(`CREATE TABLE IF NOT EXISTS conversation_participants (
      conversation_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      notify_pref TEXT NOT NULL DEFAULT 'all',
      last_read_at TEXT,
      added_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (conversation_id, user_id)
    )`);
    db.executeSync(`CREATE INDEX IF NOT EXISTS conversation_participants_user_idx ON conversation_participants (user_id)`);

    db.executeSync(`CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      sender_id TEXT,
      body TEXT NOT NULL,
      urgency TEXT NOT NULL DEFAULT 'urgent',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    db.executeSync(`CREATE INDEX IF NOT EXISTS messages_conversation_created_idx ON messages (conversation_id, created_at)`);
  },
};
