// Pure authorization rules for chat sync writes. DB-free so they unit-test
// without Postgres: routes/sync.ts resolves the facts (does the conversation
// exist, is the caller its creator / a participant) and these decide.
//
// Wording is load-bearing. The mobile outbox treats /forbidden|cannot|not
// allowed/i in a conflict message as PERMANENT and drops the entry
// (apps/mobile/src/sync/engine.ts). Participant INSERT/DELETE denials
// deliberately avoid those words: in a conversation-creation batch the
// participant rows ride behind the conversations INSERT, and if that INSERT
// hits a transient error the follow-on rows must be RETRIED, not dropped, or
// the conversation converges with no members. The UPDATE denial keeps
// "cannot" on purpose — no legitimate client flow ever writes another user's
// row, so retrying is never right.

export interface ChatConversationFacts {
  exists: boolean;        // the conversations row is present
  isCreator: boolean;     // conversations.created_by = caller (attribution-forced, so trustworthy)
  isParticipant: boolean; // caller has a conversation_participants row
}

export type ChatVerdict = { allowed: true } | { allowed: false; error: string };

// Transient wording — see the module comment.
const NOT_MEMBER = 'not a participant of this conversation';

// conversation_participants: an INSERT is how a user BECOMES a member, so an
// unguarded one lets anyone add themselves to any conversation and pull its
// entire history. Semantics mirror the (chat)/[id].tsx UI: any member manages
// the group (add/remove), everyone manages only their own prefs row, and the
// creator may insert rows before their own membership row lands (the creation
// batch applies conversations → participants sequentially in outbox order).
export function participantWriteAllowed(
  op: 'INSERT' | 'UPDATE' | 'DELETE',
  targetUserId: string | null,
  callerId: string,
  facts: ChatConversationFacts,
): ChatVerdict {
  if (op === 'UPDATE') {
    // Own row only (notify_pref / last_read_at). Membership is irrelevant: a
    // non-member updating their own nonexistent row no-ops harmlessly.
    if (targetUserId != null && targetUserId === callerId) return { allowed: true };
    return { allowed: false, error: "Forbidden: cannot modify another participant's row" };
  }
  if (op === 'DELETE' && targetUserId != null && targetUserId === callerId) {
    // Leaving is always allowed — idempotent even when the row is already gone
    // (a re-queued leave must not strand as a conflict).
    return { allowed: true };
  }
  if (!facts.exists) return { allowed: false, error: NOT_MEMBER };
  if (op === 'INSERT') {
    return facts.isParticipant || facts.isCreator
      ? { allowed: true }
      : { allowed: false, error: NOT_MEMBER };
  }
  // DELETE of someone else: membership required.
  return facts.isParticipant ? { allowed: true } : { allowed: false, error: NOT_MEMBER };
}
