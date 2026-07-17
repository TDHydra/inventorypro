import { getDb, rowsAs, bindParams } from '../schema';
import { appendOutbox } from '../../sync/outbox';
import { generateUUID } from '../../utils/uuid';

// Offline-first chat queries (migration 034, mirrors API migration 040). Every
// write follows the taxonomy.ts pattern: apply the row locally, then queue the
// matching outbox entry so it syncs to the server (which re-forces attribution +
// authorizes message writes against conversation membership).

export type ConversationKind = 'dm' | 'group';
export type NotifyPref = 'all' | 'urgent' | 'muted';
export type MessageUrgency = 'urgent' | 'regular';

export interface ConversationRow {
  id: string;
  kind: ConversationKind;
  title: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  sender_id: string | null;
  body: string;
  urgency: MessageUrgency;
  created_at: string;
  updated_at: string;
  edited_at?: string | null;
  deleted_at?: string | null;
  sender_name?: string | null;
}

export interface ParticipantRow {
  conversation_id: string;
  user_id: string;
  notify_pref: NotifyPref;
  last_read_at: string | null;
  added_at: string;
  updated_at: string;
  name?: string | null;
}

// A conversation list entry: the conversation plus the caller's notify_pref, a
// preview of the last message, and this user's unread count.
export interface ConversationListItem {
  id: string;
  kind: ConversationKind;
  title: string | null;
  notify_pref: NotifyPref;
  last_body: string | null;
  last_at: string | null;
  unread: number;
  peer_name: string | null; // the OTHER member's name (used as the DM title)
}

// ── local write helpers ──────────────────────────────────────────────────────

function insertParticipantLocal(conversationId: string, userId: string, addedAt: string): void {
  const db = getDb();
  db.executeSync(
    `INSERT OR REPLACE INTO conversation_participants
       (conversation_id, user_id, notify_pref, last_read_at, added_at, updated_at)
     VALUES (?, ?, 'all', NULL, ?, ?)`,
    [conversationId, userId, addedAt, addedAt],
  );
  appendOutbox('INSERT', 'conversation_participants', {
    conversation_id: conversationId, user_id: userId,
    notify_pref: 'all', last_read_at: null, added_at: addedAt, updated_at: addedAt,
  });
}

// ── conversation creation ────────────────────────────────────────────────────

// Existing 1:1 conversation between exactly these two users, if any (so a DM
// isn't duplicated each time it's opened). Returns the id or null.
export function findDmConversation(currentUserId: string, otherUserId: string): string | null {
  const db = getDb();
  const result = db.executeSync(
    `SELECT c.id FROM conversations c
      WHERE c.kind = 'dm'
        AND EXISTS (SELECT 1 FROM conversation_participants WHERE conversation_id = c.id AND user_id = ?)
        AND EXISTS (SELECT 1 FROM conversation_participants WHERE conversation_id = c.id AND user_id = ?)
        AND (SELECT COUNT(*) FROM conversation_participants WHERE conversation_id = c.id) = 2
      LIMIT 1`,
    [currentUserId, otherUserId],
  );
  return (result.rows[0] as { id: string } | undefined)?.id ?? null;
}

// Create (or reuse) a 1:1 DM with `otherUserId`. Returns the conversation id.
export function createDmConversation(currentUserId: string, otherUserId: string): string {
  const existing = findDmConversation(currentUserId, otherUserId);
  if (existing) return existing;
  const id = generateUUID();
  const now = new Date().toISOString();
  const db = getDb();
  db.executeSync(
    `INSERT OR REPLACE INTO conversations (id, kind, title, created_by, created_at, updated_at)
     VALUES (?, 'dm', NULL, ?, ?, ?)`,
    [id, currentUserId, now, now],
  );
  appendOutbox('INSERT', 'conversations', {
    id, kind: 'dm', title: null, created_by: currentUserId, created_at: now, updated_at: now,
  });
  insertParticipantLocal(id, currentUserId, now);
  insertParticipantLocal(id, otherUserId, now);
  return id;
}

// Create a group conversation with a title and member ids (the creator is added
// automatically). Returns the conversation id.
export function createGroupConversation(
  currentUserId: string,
  title: string,
  memberIds: string[],
): string {
  const id = generateUUID();
  const now = new Date().toISOString();
  const db = getDb();
  db.executeSync(
    `INSERT OR REPLACE INTO conversations (id, kind, title, created_by, created_at, updated_at)
     VALUES (?, 'group', ?, ?, ?, ?)`,
    [id, title, currentUserId, now, now],
  );
  appendOutbox('INSERT', 'conversations', {
    id, kind: 'group', title, created_by: currentUserId, created_at: now, updated_at: now,
  });
  // Dedupe + always include the creator.
  const members = Array.from(new Set([currentUserId, ...memberIds]));
  for (const uid of members) insertParticipantLocal(id, uid, now);
  return id;
}

// ── messaging ────────────────────────────────────────────────────────────────

// Send a message: local INSERT + outbox (sender_id = current user; the server
// re-forces this and authorizes against membership). Bumps the conversation's
// updated_at locally so the list re-sorts immediately.
export function sendMessage(
  conversationId: string,
  senderId: string,
  body: string,
  urgency: MessageUrgency = 'urgent',
): MessageRow {
  const db = getDb();
  const now = new Date().toISOString();
  const row: MessageRow = {
    id: generateUUID(),
    conversation_id: conversationId,
    sender_id: senderId,
    body,
    urgency,
    created_at: now,
    updated_at: now,
  };
  db.executeSync(
    `INSERT INTO messages (id, conversation_id, sender_id, body, urgency, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    bindParams([row.id, row.conversation_id, row.sender_id, row.body, row.urgency, row.created_at, row.updated_at]),
  );
  db.executeSync(`UPDATE conversations SET updated_at = ? WHERE id = ?`, [now, conversationId]);
  appendOutbox('INSERT', 'messages', {
    id: row.id, conversation_id: conversationId, sender_id: senderId,
    body, urgency, created_at: now, updated_at: now,
  });
  return row;
}

// Edit a message's body (sender-only, enforced server-side). MUST be an outbox
// UPDATE: messages is INSERT_NO_UPSERT on the server, so a re-INSERT with the
// existing id is a no-op there — only an UPDATE op applies the new body.
export function editMessage(id: string, body: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.executeSync(
    `UPDATE messages SET body = ?, edited_at = ?, updated_at = ? WHERE id = ?`,
    [body, now, now, id],
  );
  appendOutbox('UPDATE', 'messages', { id, body, edited_at: now });
}

// Soft-delete a message: stamp deleted_at and blank the body (the server also
// forces body = '' on any deleted_at UPDATE, so content never survives). Same
// INSERT_NO_UPSERT constraint as editMessage — this must be an UPDATE op.
export function deleteMessage(id: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.executeSync(
    `UPDATE messages SET deleted_at = ?, body = '', updated_at = ? WHERE id = ?`,
    [now, now, id],
  );
  appendOutbox('UPDATE', 'messages', { id, deleted_at: now, body: '' });
}

// Image attachments (#29-H) for a conversation's messages: media rows keyed to
// entity_type='message', grouped by message id. Images only — other mime types
// are never attached by the composer and are not rendered. Deleted messages'
// rows may still exist locally; the render path checks deleted_at first.
export function getMessageMedia(conversationId: string): Map<string, string[]> {
  const db = getDb();
  const result = db.executeSync(
    `SELECT md.entity_id, md.url
       FROM media md
       JOIN messages m ON m.id = md.entity_id
      WHERE md.entity_type = 'message' AND md.media_type = 'image'
        AND m.conversation_id = ?
      ORDER BY md.created_at ASC`,
    [conversationId],
  );
  const byMessage = new Map<string, string[]>();
  for (const r of rowsAs<{ entity_id: string; url: string }>(result.rows)) {
    const urls = byMessage.get(r.entity_id);
    if (urls) urls.push(r.url);
    else byMessage.set(r.entity_id, [r.url]);
  }
  return byMessage;
}

// Messages for a conversation, oldest first (ascending) — capped. Joins the
// sender's name for display (LEFT JOIN so an unknown sender still renders).
export function getMessages(conversationId: string, limit = 500): MessageRow[] {
  const db = getDb();
  const result = db.executeSync(
    `SELECT m.*, u.name AS sender_name
       FROM messages m
       LEFT JOIN users u ON u.id = m.sender_id
      WHERE m.conversation_id = ?
      ORDER BY m.created_at ASC
      LIMIT ?`,
    [conversationId, limit],
  );
  return rowsAs<MessageRow>(result.rows);
}

// ── conversation list ────────────────────────────────────────────────────────

// The caller's conversations, most-recently-active first, each with a last-message
// preview, this user's unread count, and (for DMs) the other member's name.
export function listConversations(currentUserId: string): ConversationListItem[] {
  const db = getDb();
  const result = db.executeSync(
    `SELECT
        c.id, c.kind, c.title, cp.notify_pref,
        (SELECT m.body FROM messages m WHERE m.conversation_id = c.id AND m.deleted_at IS NULL ORDER BY m.created_at DESC LIMIT 1) AS last_body,
        (SELECT m.created_at FROM messages m WHERE m.conversation_id = c.id AND m.deleted_at IS NULL ORDER BY m.created_at DESC LIMIT 1) AS last_at,
        (SELECT COUNT(*) FROM messages m
           WHERE m.conversation_id = c.id
             AND m.sender_id != ?
             AND m.deleted_at IS NULL
             AND (cp.last_read_at IS NULL OR m.created_at > cp.last_read_at)) AS unread,
        (SELECT u.name FROM conversation_participants p JOIN users u ON u.id = p.user_id
           WHERE p.conversation_id = c.id AND p.user_id != ? LIMIT 1) AS peer_name
      FROM conversations c
      JOIN conversation_participants cp ON cp.conversation_id = c.id AND cp.user_id = ?
      ORDER BY COALESCE(last_at, c.updated_at) DESC`,
    [currentUserId, currentUserId, currentUserId],
  );
  return rowsAs<ConversationListItem>(result.rows);
}

// Total unread across all of the caller's conversations (drives the store badge).
export function totalUnread(currentUserId: string): number {
  const db = getDb();
  const result = db.executeSync(
    `SELECT COUNT(*) AS cnt
       FROM messages m
       JOIN conversation_participants cp
         ON cp.conversation_id = m.conversation_id AND cp.user_id = ?
      WHERE m.sender_id != ?
        AND m.deleted_at IS NULL
        AND (cp.last_read_at IS NULL OR m.created_at > cp.last_read_at)`,
    [currentUserId, currentUserId],
  );
  return (result.rows[0] as { cnt: number } | undefined)?.cnt ?? 0;
}

// ── single conversation + participants ───────────────────────────────────────

export function getConversation(conversationId: string): ConversationRow | undefined {
  const db = getDb();
  const result = db.executeSync(`SELECT * FROM conversations WHERE id = ?`, [conversationId]);
  return rowsAs<ConversationRow>(result.rows)[0];
}

export function getParticipants(conversationId: string): ParticipantRow[] {
  const db = getDb();
  const result = db.executeSync(
    `SELECT cp.*, u.name AS name
       FROM conversation_participants cp
       LEFT JOIN users u ON u.id = cp.user_id
      WHERE cp.conversation_id = ?
      ORDER BY u.name`,
    [conversationId],
  );
  return rowsAs<ParticipantRow>(result.rows);
}

export function getMyParticipant(conversationId: string, userId: string): ParticipantRow | undefined {
  const db = getDb();
  const result = db.executeSync(
    `SELECT * FROM conversation_participants WHERE conversation_id = ? AND user_id = ?`,
    [conversationId, userId],
  );
  return rowsAs<ParticipantRow>(result.rows)[0];
}

// Display title for a conversation: the group title, or (for a DM) the other
// member's name. Falls back gracefully when data is incomplete.
export function conversationTitle(conv: ConversationRow, participants: ParticipantRow[], currentUserId: string): string {
  if (conv.kind === 'group') return conv.title?.trim() || 'Group';
  const other = participants.find(p => p.user_id !== currentUserId);
  return other?.name?.trim() || 'Direct message';
}

// ── mark read / notify pref ──────────────────────────────────────────────────

// Mark a conversation read for this user: stamp last_read_at + queue the outbox
// UPDATE carrying the composite key + last_read_at. Idempotent-ish (always safe
// to call; queues one minimal UPDATE).
export function markConversationRead(conversationId: string, userId: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.executeSync(
    `UPDATE conversation_participants SET last_read_at = ?, updated_at = ?
      WHERE conversation_id = ? AND user_id = ?`,
    [now, now, conversationId, userId],
  );
  appendOutbox('UPDATE', 'conversation_participants', {
    conversation_id: conversationId, user_id: userId, last_read_at: now,
  });
}

// Set this user's notify preference for a conversation ('all'|'urgent'|'muted').
export function setNotifyPref(conversationId: string, userId: string, pref: NotifyPref): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.executeSync(
    `UPDATE conversation_participants SET notify_pref = ?, updated_at = ?
      WHERE conversation_id = ? AND user_id = ?`,
    [pref, now, conversationId, userId],
  );
  appendOutbox('UPDATE', 'conversation_participants', {
    conversation_id: conversationId, user_id: userId, notify_pref: pref,
  });
}

// ── group membership ─────────────────────────────────────────────────────────

// Add a participant to a conversation (group management). No-op if already present.
export function addParticipant(conversationId: string, userId: string): void {
  const existing = getMyParticipant(conversationId, userId);
  if (existing) return;
  insertParticipantLocal(conversationId, userId, new Date().toISOString());
}

// Remove a participant locally + queue the outbox DELETE (composite key).
export function removeParticipant(conversationId: string, userId: string): void {
  const db = getDb();
  db.executeSync(
    `DELETE FROM conversation_participants WHERE conversation_id = ? AND user_id = ?`,
    [conversationId, userId],
  );
  appendOutbox('DELETE', 'conversation_participants', {
    conversation_id: conversationId, user_id: userId,
  });
}

// Leave a conversation (remove self).
export function leaveConversation(conversationId: string, userId: string): void {
  removeParticipant(conversationId, userId);
}
