// Chat domain — conversations / conversation_participants / messages.
// Ported from apps/mobile/src/db/queries/chat.ts (migration 034, mirrors API
// migration 040). The three tables already existed in the manifest
// (packages/core/src/manifest/tables.ts, scope: 'chat') before this station —
// Wave A/B/C never wrote to them, so the DDL just needed real repo functions.
//
// Writes go through createRepository('conversations'/'conversation_participants'
// /'messages') per the standing convention — repo functions here do NOT call
// appendLog (same B1 users.ts/roleSettings.ts convention every other repo
// follows) — EXCEPT chat additionally does not log to activity_log AT ALL,
// matching the old app's db/queries/chat.ts (grepped: zero appendLog calls
// there). Message send/edit/delete/read-receipts are too high-frequency to
// belong in the audit log; the messages/conversation_participants rows ARE
// the record.
//
// Image attachments (getMessageMedia, backed by the `media` table): cut at
// Station D1, restored Station D2 once src/media landed. @mentions
// (mentioned_user_ids) were ported at D1 (../chat/mentions.ts — pure text
// parsing, no media dependency).
import { getDb, rowsAs, bindParams } from '../db/schema';
import { createRepository, runInTransaction, queueTableBump } from '@invenpro/core';
import { generateUUID } from '../utils/uuid';

const conversationsRepo = createRepository('conversations');
const participantsRepo = createRepository('conversation_participants');
const messagesRepo = createRepository('messages');

export type ConversationKind = 'dm' | 'group';
export type NotifyPref = 'all' | 'urgent' | 'muted';
export type MessageUrgency = 'urgent' | 'regular';

export interface Conversation {
  id: string;
  kind: ConversationKind;
  title: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface Message {
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
  // #241: JSON array of @mentioned user ids (mirrors media.audience_user_ids).
  mentioned_user_ids?: string | null;
}

export interface Participant {
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

function insertParticipant(conversationId: string, userId: string, addedAt: string): void {
  participantsRepo.insert({
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
    bindParams([currentUserId, otherUserId]),
  );
  return (result.rows[0] as { id: string } | undefined)?.id ?? null;
}

// Create (or reuse) a 1:1 DM with `otherUserId`. Returns the conversation id.
// Wrapped in runInTransaction (mirrors the old app's #203 fix) so a
// write-blocked caller (maintenance mode / session preview) rolls back
// cleanly instead of leaving an orphaned, participant-less conversations row.
export function createDmConversation(currentUserId: string, otherUserId: string): string {
  const existing = findDmConversation(currentUserId, otherUserId);
  if (existing) return existing;
  const id = generateUUID();
  const now = new Date().toISOString();
  runInTransaction(() => {
    conversationsRepo.insert({ id, kind: 'dm', title: null, created_by: currentUserId, created_at: now, updated_at: now });
    insertParticipant(id, currentUserId, now);
    insertParticipant(id, otherUserId, now);
  });
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
  const members = Array.from(new Set([currentUserId, ...memberIds]));
  runInTransaction(() => {
    conversationsRepo.insert({ id, kind: 'group', title, created_by: currentUserId, created_at: now, updated_at: now });
    for (const uid of members) insertParticipant(id, uid, now);
  });
  return id;
}

// ── messaging ────────────────────────────────────────────────────────────────

// Send a message: local INSERT + outbox (sender_id = current user; the server
// re-forces this and authorizes against membership). Also bumps the
// conversation's updated_at LOCALLY ONLY (no separate outbox write for that —
// matches the old app exactly) so the list re-sorts immediately; the server
// already touches conversations on message insert, so the real value
// converges on the next pull regardless.
export function sendMessage(
  conversationId: string,
  senderId: string,
  body: string,
  urgency: MessageUrgency = 'urgent',
  mentionedUserIds?: string[],
): Message {
  const now = new Date().toISOString();
  const mentionedJson = mentionedUserIds && mentionedUserIds.length > 0
    ? JSON.stringify(mentionedUserIds) : null;
  const row: Message = {
    id: generateUUID(),
    conversation_id: conversationId,
    sender_id: senderId,
    body,
    urgency,
    created_at: now,
    updated_at: now,
    mentioned_user_ids: mentionedJson,
  };
  runInTransaction(() => {
    messagesRepo.insert({ ...row });
    getDb().executeSync(`UPDATE conversations SET updated_at = ? WHERE id = ?`, bindParams([now, conversationId]));
    queueTableBump('conversations');
  });
  return row;
}

// Edit a message's body (sender-only, enforced server-side AND pre-checked
// client-side via chatPolicy.canEditMessage before this is called).
export function editMessage(id: string, body: string): void {
  const now = new Date().toISOString();
  messagesRepo.update({ id, body, edited_at: now });
}

// Soft-delete a message: stamp deleted_at and blank the body (the server also
// forces body = '' on any deleted_at UPDATE, so content never survives).
export function deleteMessage(id: string): void {
  const now = new Date().toISOString();
  messagesRepo.update({ id, deleted_at: now, body: '' });
}

// Messages for a conversation, oldest first (ascending) — capped. Joins the
// sender's name for display (LEFT JOIN so an unknown sender still renders).
export function getMessages(conversationId: string, limit = 500): Message[] {
  const db = getDb();
  const result = db.executeSync(
    `SELECT m.*, u.name AS sender_name
       FROM messages m
       LEFT JOIN users u ON u.id = m.sender_id
      WHERE m.conversation_id = ?
      ORDER BY m.created_at ASC
      LIMIT ?`,
    bindParams([conversationId, limit]),
  );
  return rowsAs<Message>(result.rows);
}

// #29-H: image attachments for every message in a conversation, keyed by
// message id — synced media rows (entity_type='message').
export function getMessageMedia(conversationId: string): Map<string, string[]> {
  const db = getDb();
  const result = db.executeSync(
    `SELECT md.entity_id, md.url
       FROM media md
       JOIN messages m ON m.id = md.entity_id
      WHERE md.entity_type = 'message' AND md.media_type = 'image'
        AND m.conversation_id = ?
      ORDER BY md.created_at ASC`,
    bindParams([conversationId]),
  );
  const byMessage = new Map<string, string[]>();
  for (const r of rowsAs<{ entity_id: string; url: string }>(result.rows)) {
    const urls = byMessage.get(r.entity_id);
    if (urls) urls.push(r.url);
    else byMessage.set(r.entity_id, [r.url]);
  }
  return byMessage;
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
    bindParams([currentUserId, currentUserId, currentUserId]),
  );
  return rowsAs<ConversationListItem>(result.rows);
}

// Total unread across all of the caller's conversations (drives the ChatBell
// badge via ../chat/unread.ts's createConfigCache-backed cache).
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
    bindParams([currentUserId, currentUserId]),
  );
  return (result.rows[0] as { cnt: number } | undefined)?.cnt ?? 0;
}

// ── single conversation + participants ───────────────────────────────────────

export function getConversation(conversationId: string): Conversation | undefined {
  const db = getDb();
  const result = db.executeSync(`SELECT * FROM conversations WHERE id = ?`, bindParams([conversationId]));
  return rowsAs<Conversation>(result.rows)[0];
}

export function getParticipants(conversationId: string): Participant[] {
  const db = getDb();
  const result = db.executeSync(
    `SELECT cp.*, u.name AS name
       FROM conversation_participants cp
       LEFT JOIN users u ON u.id = cp.user_id
      WHERE cp.conversation_id = ?
      ORDER BY u.name`,
    bindParams([conversationId]),
  );
  return rowsAs<Participant>(result.rows);
}

export function getMyParticipant(conversationId: string, userId: string): Participant | undefined {
  const db = getDb();
  const result = db.executeSync(
    `SELECT * FROM conversation_participants WHERE conversation_id = ? AND user_id = ?`,
    bindParams([conversationId, userId]),
  );
  return rowsAs<Participant>(result.rows)[0];
}

// Display title for a conversation: the group title, or (for a DM) the other
// member's name. Falls back gracefully when data is incomplete.
export function conversationTitle(conv: Conversation, participants: Participant[], currentUserId: string): string {
  if (conv.kind === 'group') return conv.title?.trim() || 'Group';
  const other = participants.find(p => p.user_id !== currentUserId);
  return other?.name?.trim() || 'Direct message';
}

// ── mark read / notify pref ──────────────────────────────────────────────────

// Mark a conversation read for this user: stamp last_read_at (local write +
// outbox UPDATE via the repo). Idempotent-ish (always safe to call).
export function markConversationRead(conversationId: string, userId: string): void {
  const now = new Date().toISOString();
  participantsRepo.update({ conversation_id: conversationId, user_id: userId, last_read_at: now });
}

// Set this user's notify preference for a conversation ('all'|'urgent'|'muted').
export function setNotifyPref(conversationId: string, userId: string, pref: NotifyPref): void {
  participantsRepo.update({ conversation_id: conversationId, user_id: userId, notify_pref: pref });
}

// ── group membership ─────────────────────────────────────────────────────────

// Add a participant to a conversation (group management). No-op if already present.
export function addParticipant(conversationId: string, userId: string): void {
  const existing = getMyParticipant(conversationId, userId);
  if (existing) return;
  insertParticipant(conversationId, userId, new Date().toISOString());
}

// Remove a participant + queue the outbox DELETE (composite key).
export function removeParticipant(conversationId: string, userId: string): void {
  participantsRepo.remove({ conversation_id: conversationId, user_id: userId });
}

// Leave a conversation (remove self).
export function leaveConversation(conversationId: string, userId: string): void {
  removeParticipant(conversationId, userId);
}
