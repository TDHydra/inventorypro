// Station D1: client-side mirror of apps/api/src/lib/chatPolicy.ts's
// participantWriteAllowed() + the inline message-write rules in
// apps/api/src/routes/sync.ts (~1406-1453). The OLD mobile app had no
// client-side chatPolicy file at all — it trusted local rows and let the
// server reject illegal outbox writes as denied entries (discovered later via
// SyncIndicator). This wave's brief explicitly asks to port the policy
// SEMANTICS client-side "where the old app enforced them" — in practice that
// means pre-flight-disabling affordances (edit/delete on someone else's
// message, adding/removing a participant you can't) instead of letting a
// doomed write reach the outbox at all.
//
// The server remains the ONLY authority — these are UI-only pre-checks, not a
// security boundary. KEEP IN SYNC with apps/api/src/lib/chatPolicy.ts.

export type ParticipantOp = 'insert' | 'update' | 'remove';

export interface ParticipantFacts {
  /** Does a conversation_participants row already exist for (conversationId, targetUserId)? */
  exists: boolean;
  /** Is the CALLER a participant of this conversation? */
  isParticipant: boolean;
  /** Did the CALLER create this conversation? */
  isCreator: boolean;
}

/**
 * Mirrors apps/api/src/lib/chatPolicy.ts's participantWriteAllowed(op,
 * targetUserId, callerId, facts):
 *  - UPDATE (notify_pref / last_read_at): only on your OWN row.
 *  - DELETE of your own row (leaving): always allowed, even if the row is
 *    already gone locally (idempotent).
 *  - Anything else requires the participant row to actually exist server-side.
 *  - INSERT (adding a member): the caller must already be a participant, or
 *    be the conversation's creator (covers the initial DM/group creation).
 *  - DELETE of someone else (removing a member): the caller must be a
 *    participant.
 */
export function canManageParticipant(
  op: ParticipantOp,
  targetUserId: string,
  callerId: string,
  facts: ParticipantFacts,
): boolean {
  if (op === 'update') return targetUserId === callerId;
  if (op === 'remove' && targetUserId === callerId) return true;
  if (!facts.exists) return false;
  if (op === 'insert') return facts.isParticipant || facts.isCreator;
  return facts.isParticipant; // remove someone else
}

/** Sending a message requires the caller to already be a conversation participant. */
export function canSendMessage(callerIsParticipant: boolean): boolean {
  return callerIsParticipant;
}

/** Edit/delete a message: sender-only (mirrors sync.ts's UPDATE guard on messages). */
export function canEditMessage(senderId: string | null, callerId: string): boolean {
  return senderId === callerId;
}

export function canDeleteMessage(senderId: string | null, callerId: string): boolean {
  return senderId === callerId;
}
