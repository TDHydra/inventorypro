import { participantWriteAllowed, ChatConversationFacts } from '../../lib/chatPolicy';
import { filterMuted, filterQuietHours } from '../../lib/notifications';
import { sendPush, messageRecipients } from '../../lib/push';
import type { Pg, TableGuard } from '../types';

// Resolve the caller's relationship to a conversation for the chat write guards
// (lib/chatPolicy.ts decides; this only gathers facts). Fails closed: a missing
// row, a null id, or a malformed uuid (the cast throws) all come back as
// "doesn't exist", which the policy rejects with the transient wording.
async function conversationFacts(
  pg: Pg,
  conversationId: unknown,
  callerId: string,
): Promise<ChatConversationFacts> {
  try {
    const { rows } = await pg.query(
      `SELECT (c.created_by = $2) AS is_creator,
              EXISTS (SELECT 1 FROM conversation_participants cp
                       WHERE cp.conversation_id = c.id AND cp.user_id = $2) AS is_participant
         FROM conversations c WHERE c.id = $1`,
      [conversationId, callerId],
    );
    const r = rows[0] as { is_creator: boolean | null; is_participant: boolean } | undefined;
    if (!r) return { exists: false, isCreator: false, isParticipant: false };
    return { exists: true, isCreator: r.is_creator === true, isParticipant: r.is_participant === true };
  } catch {
    return { exists: false, isCreator: false, isParticipant: false };
  }
}

// messages: a user may only post to a conversation they PARTICIPATE in
// (sender_id is forced to the caller by ATTRIBUTION_COLUMNS). UPDATE is
// sender-only — otherwise any participant could rewrite another member's
// message body — and a soft-delete forces body blank server-side. The
// INSERT-with-existing-id takeover is closed by INSERT_NO_UPSERT.
export const messagesGuard: TableGuard = {
  table: 'messages',
  async authorizeRow(ctx, entry) {
    if (entry.operation === 'INSERT') {
      const convId = entry.payload.conversation_id;
      const { rows: partRows } = await ctx.pg.query(
        `SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2`,
        [convId, ctx.userId],
      );
      if (!partRows[0]) {
        ctx.log.warn(
          { userId: ctx.userId, conversationId: convId },
          'sync push message denied (not a participant)',
        );
        return { error: 'Forbidden: not a participant of this conversation', code: 'FORBIDDEN' };
      }
    }
    if (entry.operation === 'UPDATE') {
      let senderId: string | undefined;
      try {
        const { rows: msgRows } = await ctx.pg.query(
          `SELECT sender_id FROM messages WHERE id = $1`,
          [entry.payload.id],
        );
        senderId = (msgRows[0] as { sender_id: string } | undefined)?.sender_id;
      } catch { senderId = undefined; }
      if (senderId == null || String(senderId) !== ctx.userId) {
        ctx.log.warn(
          { userId: ctx.userId, messageId: entry.payload.id },
          'sync push message update denied (not the sender)',
        );
        return { error: 'Forbidden: only the sender can edit a message', code: 'FORBIDDEN' };
      }
      // Soft-delete (#29): a deleted message must never retain its content —
      // force the body blank server-side rather than trusting the client to
      // have cleared it.
      if (entry.payload.deleted_at != null) entry.payload.body = '';
    }
    return undefined;
  },
  // New chat message → notify the OTHER participants, filtered by each one's
  // notify_pref vs the message urgency (messageRecipients). Fire-and-forget:
  // never blocks or fails the sync write. sender_id was forced to the caller.
  afterApply(ctx, entry) {
    if (entry.operation !== 'INSERT') return;
    const { pg, userId } = ctx;
    const convId = entry.payload.conversation_id;
    const urgency = entry.payload.urgency === 'regular' ? 'regular' : 'urgent';
    const body = String(entry.payload.body ?? '');
    // #241: @mentions (JSON array of user ids, mirrors media.audience_user_ids).
    // messageRecipients only ever notifies ids that are ALSO participants, so a
    // crafted/garbage list here can't reach anyone outside the conversation.
    let mentionedUserIds: string[] = [];
    try {
      const parsed: unknown = JSON.parse(String(entry.payload.mentioned_user_ids ?? '[]'));
      if (Array.isArray(parsed)) mentionedUserIds = parsed.filter((v): v is string => typeof v === 'string');
    } catch { /* malformed — treat as no mentions */ }
    void (async () => {
      try {
        const { rows: parts } = await pg.query(
          `SELECT user_id, notify_pref FROM conversation_participants WHERE conversation_id = $1`,
          [convId],
        );
        const recipients = messageRecipients(
          parts as { user_id: string; notify_pref: string }[],
          userId,
          urgency,
          mentionedUserIds,
        );
        if (!recipients.length) return;
        // Best-effort title: group title, else the sender's name.
        const { rows: cRows } = await pg.query(`SELECT kind, title FROM conversations WHERE id = $1`, [convId]);
        const { rows: uRows } = await pg.query(`SELECT name FROM users WHERE id = $1`, [userId]);
        const conv = cRows[0] as { kind: string; title: string | null } | undefined;
        const senderName = uRows[0] ? String((uRows[0] as { name: string }).name) : 'New message';
        const isGroup = conv?.kind === 'group';
        const title = isGroup && conv?.title ? conv.title : senderName;
        const pushBody = isGroup ? `${senderName}: ${body}` : body;
        // #242: chat pushes bypass deliver() entirely, so quiet hours need
        // their own gate here (@mentions bypass quiet hours — a direct
        // @mention is the sender explicitly reaching for that person).
        // #245: chat also bypasses deliver()'s TYPE_TO_CATEGORY filter, so a
        // user who globally muted 'chat' in My Notifications needs its own
        // gate too (a global mute wins over a mention).
        let pushTo = await filterQuietHours(pg, recipients, new Set(mentionedUserIds));
        pushTo = await filterMuted(pg, pushTo, 'chat');
        if (pushTo.length) {
          await sendPush(pg, pushTo, { title, body: pushBody, data: { screen: 'chat', conversationId: String(convId) }, categoryId: 'chat-message' }); // #231
        }
      } catch { /* never disrupt sync */ }
    })();
  },
};

// conversation_participants: an INSERT is how a user BECOMES a member, so an
// unguarded one lets anyone add themselves to any conversation and pull its
// entire history. Rules live in lib/chatPolicy.ts; the facts are fresh per
// entry because a batch may create the conversation earlier in this same push.
export const conversationParticipantsGuard: TableGuard = {
  table: 'conversation_participants',
  async authorizeRow(ctx, entry) {
    const facts = await conversationFacts(ctx.pg, entry.payload.conversation_id, ctx.userId);
    const targetUser = entry.payload.user_id == null ? null : String(entry.payload.user_id);
    const verdict = participantWriteAllowed(entry.operation as 'INSERT' | 'UPDATE' | 'DELETE', targetUser, ctx.userId, facts);
    if (!verdict.allowed) {
      ctx.log.warn(
        { userId: ctx.userId, conversationId: entry.payload.conversation_id, targetUser, operation: entry.operation },
        'sync push participant write denied',
      );
      // #235: participantWriteAllowed doesn't carry a code of its own —
      // classify from the text. The UPDATE-of-another's-row denial
      // ("cannot modify...") is a genuine authorization failure; the
      // membership/existence denial ("not a participant...") is deliberately
      // transient wording so it must NOT resolve to a permanent code.
      return {
        error: verdict.error,
        code: verdict.error.startsWith('Forbidden:') ? 'FORBIDDEN' : 'CONFLICT',
      };
    }
    return undefined;
  },
};

// conversations UPDATE: no client flow renames conversations today, so fail
// closed to members — a non-participant must not retitle or re-kind someone
// else's conversation. (created_by is attribution-protected, and the
// INSERT-with-existing-id takeover is closed by INSERT_NO_UPSERT.)
export const conversationsGuard: TableGuard = {
  table: 'conversations',
  async authorizeRow(ctx, entry) {
    if (entry.operation !== 'UPDATE') return undefined;
    const facts = await conversationFacts(ctx.pg, entry.payload.id, ctx.userId);
    if (!facts.isParticipant) {
      ctx.log.warn(
        { userId: ctx.userId, conversationId: entry.payload.id },
        'sync push conversation update denied (not a participant)',
      );
      return { error: 'Forbidden: not a participant of this conversation', code: 'FORBIDDEN' };
    }
    return undefined;
  },
};
