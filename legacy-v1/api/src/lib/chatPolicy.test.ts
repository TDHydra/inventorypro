import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { participantWriteAllowed, ChatConversationFacts } from './chatPolicy';

const CALLER = 'caller-uuid';
const OTHER = 'other-uuid';

// Mirror of the client's permanent-rejection classifier
// (apps/mobile/src/sync/engine.ts PERMANENT_REJECTION). If this drifts, the
// wording assertions below are what catch a denial silently changing between
// "retry" and "drop the outbox entry".
const PERMANENT = /forbidden|cannot|not allowed/i;

const facts = (f: Partial<ChatConversationFacts>): ChatConversationFacts => ({
  exists: false, isCreator: false, isParticipant: false, ...f,
});

test('INSERT: an outsider cannot add themselves to an existing conversation', () => {
  const v = participantWriteAllowed('INSERT', CALLER, CALLER, facts({ exists: true }));
  assert.equal(v.allowed, false);
});

test('INSERT: an outsider cannot add anyone else either', () => {
  const v = participantWriteAllowed('INSERT', OTHER, CALLER, facts({ exists: true }));
  assert.equal(v.allowed, false);
});

test('INSERT: the creator may add rows before their own membership row lands', () => {
  // The conversation-creation batch: conversations INSERT (created_by = caller)
  // applies first, then the participant rows — including the caller's own.
  const v = participantWriteAllowed('INSERT', CALLER, CALLER, facts({ exists: true, isCreator: true }));
  assert.equal(v.allowed, true);
  const v2 = participantWriteAllowed('INSERT', OTHER, CALLER, facts({ exists: true, isCreator: true }));
  assert.equal(v2.allowed, true);
});

test('INSERT: any member may add someone (group management, matches the UI)', () => {
  const v = participantWriteAllowed('INSERT', OTHER, CALLER, facts({ exists: true, isParticipant: true }));
  assert.equal(v.allowed, true);
});

test('INSERT: a missing conversation fails closed', () => {
  const v = participantWriteAllowed('INSERT', CALLER, CALLER, facts({}));
  assert.equal(v.allowed, false);
});

test('UPDATE: own prefs row only; another user\'s row is a permanent denial', () => {
  assert.equal(participantWriteAllowed('UPDATE', CALLER, CALLER, facts({ exists: true })).allowed, true);
  const denied = participantWriteAllowed('UPDATE', OTHER, CALLER, facts({ exists: true, isParticipant: true }));
  assert.equal(denied.allowed, false);
  // No legitimate flow ever writes another user's row → the client must DROP
  // this entry, not retry it.
  assert.ok(!denied.allowed && PERMANENT.test(denied.error));
  // A payload missing user_id entirely is also denied (fail closed).
  assert.equal(participantWriteAllowed('UPDATE', null, CALLER, facts({ exists: true })).allowed, false);
});

test('DELETE: leaving is always allowed, even when the row is already gone', () => {
  // Idempotent: a re-queued leave against a vanished conversation must not
  // strand as a conflict.
  assert.equal(participantWriteAllowed('DELETE', CALLER, CALLER, facts({})).allowed, true);
});

test('DELETE: removing someone else requires membership', () => {
  assert.equal(
    participantWriteAllowed('DELETE', OTHER, CALLER, facts({ exists: true, isParticipant: true })).allowed,
    true,
  );
  const denied = participantWriteAllowed('DELETE', OTHER, CALLER, facts({ exists: true }));
  assert.equal(denied.allowed, false);
});

test('INSERT/DELETE denials use transient wording; the client retries them', () => {
  // In a creation batch the participant rows ride behind the conversations
  // INSERT; if that INSERT hit a transient error, these rows must be retried,
  // not dropped, or the conversation converges with no members.
  for (const op of ['INSERT', 'DELETE'] as const) {
    const denied = participantWriteAllowed(op, OTHER, CALLER, facts({ exists: true }));
    assert.equal(denied.allowed, false);
    assert.ok(!denied.allowed && !PERMANENT.test(denied.error),
      `${op} denial "${!denied.allowed && denied.error}" must not match the client's permanent-rejection regex`);
  }
});

test('sync.ts closes the INSERT-with-existing-id upsert for the chat tables', () => {
  // participantWriteAllowed keys on created_by and membership; if a crafted
  // INSERT could still ON CONFLICT DO UPDATE an existing conversation, the
  // attacker would become its "creator" (attribution forces created_by to the
  // caller) and walk straight through the guard. Same shape for messages
  // (rewrite another sender's body) and participants (reset a member's prefs).
  const src = readFileSync(join(__dirname, '..', 'routes', 'sync.ts'), 'utf8');
  const setMatch = src.match(/INSERT_NO_UPSERT = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(setMatch, 'INSERT_NO_UPSERT set must exist in routes/sync.ts');
  for (const table of ['approval_requests', 'conversations', 'conversation_participants', 'messages']) {
    assert.ok(setMatch![1].includes(`'${table}'`), `INSERT_NO_UPSERT must include ${table}`);
  }
  assert.ok(src.includes('!INSERT_NO_UPSERT.has(table_name)'),
    'the upsert chooser must consult INSERT_NO_UPSERT');
  // And the participant guard must actually be wired into the push loop.
  assert.ok(src.includes('participantWriteAllowed('), 'push loop must call participantWriteAllowed');
});
