-- Synced chat: 1:1 (dm) + group messaging with per-participant notify prefs.
-- All three tables ARE synced (registered in ALLOWED_TABLES/FULL_TABLES/pull.ts/
-- fullDownload/syncPolicy). Pull is SCOPED: a device only ever downloads
-- conversations/participants/messages for conversations it participates in
-- (see sync.ts chatScopeSql). Attribution is server-forced: conversations.created_by
-- and messages.sender_id are set to the authenticated caller on INSERT
-- (ATTRIBUTION_COLUMNS). A message INSERT is authorized against membership, and
-- notifies the OTHER participants filtered by each one's notify_pref vs urgency.
--   conversations              — the DM/group container.
--   conversation_participants  — membership + per-user notify_pref/last_read_at
--                                (composite PK conversation_id,user_id).
--   messages                   — the message stream; urgency gates push fan-out.
CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'dm',            -- 'dm' | 'group'
  title TEXT,                                 -- group title; null for dm
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS conversation_participants (
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notify_pref TEXT NOT NULL DEFAULT 'all',    -- 'all' | 'urgent' | 'muted'
  last_read_at TIMESTAMPTZ,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX IF NOT EXISTS conversation_participants_user_idx ON conversation_participants (user_id);

CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id UUID,
  body TEXT NOT NULL,
  urgency TEXT NOT NULL DEFAULT 'urgent',     -- 'urgent' | 'regular'
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS messages_conversation_created_idx ON messages (conversation_id, created_at);
