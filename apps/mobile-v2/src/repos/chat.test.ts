import { createRequire } from 'node:module';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { configureCore } from '@invenpro/core';

// Ported from apps/mobile/src/db/queries/chat.test.ts (#29 edit/delete
// semantics + #203 write-block rollback), on the v2 manifest-DDL harness
// (same Module._load redirect as notifications.test.ts/teams.test.ts). The
// load-bearing constraint under test is unchanged: messages is
// INSERT_NO_UPSERT on the server, so edits/deletes MUST queue UPDATE outbox
// ops — a re-INSERT with the existing id is a server no-op.
const requireCjs = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Module = requireCjs('node:module') as any;
const testDb = requireCjs('./testDb') as typeof import('./testDb');

const origLoad = Module._load;
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'react-native-get-random-values') return {};
  if (request === 'react-native' || request === 'expo' || request === 'expo-modules-core') {
    return new Proxy({ __esModule: true }, { get: (_t, p) => (p === '__esModule' ? true : () => {}) });
  }
  let resolved = '';
  try { resolved = Module._resolveFilename(request, parent); } catch { /* not ours — fall through */ }
  if (resolved.endsWith('/src/db/schema.ts')) return testDb;
  return origLoad.call(this, request, parent, isMain);
};

let chat: typeof import('./chat');
let maintenance: typeof import('../db/maintenance');

const ALICE = 'user-alice';
const BOB = 'user-bob';
let convId: string;

function exec(sql: string, params?: unknown[]) {
  return testDb.getDb().executeSync(sql, params);
}

interface OutboxRow { operation: string; table_name: string; payload: Record<string, unknown> }
function outboxEntries(): OutboxRow[] {
  const rows = exec(`SELECT operation, table_name, payload FROM outbox ORDER BY rowid ASC`).rows as
    Array<{ operation: string; table_name: string; payload: string }>;
  return rows.map(r => ({ operation: r.operation, table_name: r.table_name, payload: JSON.parse(r.payload) }));
}
function clearOutbox(): void { exec(`DELETE FROM outbox`); }

function messageRow(id: string) {
  return exec(`SELECT * FROM messages WHERE id = ?`, [id]).rows[0] as
    { body: string; edited_at: string | null; deleted_at: string | null } | undefined;
}

const NOW = new Date().toISOString();
function seedUser(id: string, name: string) {
  exec(
    `INSERT INTO users (id, name, role, pin_length_required, permission_overrides, active, created_at, updated_at)
     VALUES (?, ?, 'construction_crew', 4, '{}', 1, ?, ?)`,
    [id, name, NOW, NOW],
  );
}

let uuidCounter = 0;

before(async () => {
  await testDb.initTestDb([
    'conversations', 'conversation_participants', 'messages', 'users', 'app_config', 'outbox',
  ]);
  // Re-run configureCore to add the assertWritable seam (initTestDb's own
  // config omits it): the #203 test below needs appendOutbox to actually
  // throw MaintenanceLockedError when the preview write-block flag is on.
  // Runs before any write, so restarting the uuid counter can't collide.
  maintenance = requireCjs('../db/maintenance') as typeof import('../db/maintenance');
  configureCore({
    apiBase: 'http://test.local',
    generateUUID: () => `uuid-${String(++uuidCounter).padStart(4, '0')}`,
    auth: {
      getValidJwt: async () => 'test-jwt',
      revalidateSession: async () => undefined,
      getSavedUserId: async () => 'user-1',
    },
    assertWritable: () => maintenance.assertWritable(),
  });
  chat = requireCjs('./chat') as typeof import('./chat');
  seedUser(ALICE, 'Alice');
  seedUser(BOB, 'Bob');
  convId = chat.createDmConversation(ALICE, BOB);
  clearOutbox(); // conversation-creation ops aren't under test
});

// #203 (ported): a write-blocked createDmConversation must roll back its
// whole insert flow (runInTransaction) instead of leaving an orphaned,
// participant-less conversations row behind an uncaught MaintenanceLockedError.
test('#203: a write-blocked createDmConversation leaves zero local rows and throws', () => {
  const CAROL = 'user-carol';
  seedUser(CAROL, 'Carol');
  assert.equal(chat.findDmConversation(ALICE, CAROL), null, 'sanity: no DM exists yet for this pair');

  maintenance.setPreviewWriteBlock(true);
  try {
    assert.throws(
      () => chat.createDmConversation(ALICE, CAROL),
      (err: unknown) => err instanceof maintenance.MaintenanceLockedError,
    );
  } finally {
    maintenance.setPreviewWriteBlock(false);
  }

  // No orphaned conversations row for this pair...
  assert.equal(chat.findDmConversation(ALICE, CAROL), null);
  // ...and no orphaned participant row either (the #203 hazard: a
  // participant-less conversations row, or vice versa).
  const partRows = exec(
    `SELECT COUNT(*) AS cnt FROM conversation_participants WHERE user_id = ?`,
    [CAROL],
  ).rows as { cnt: number }[];
  assert.equal(partRows[0].cnt, 0, 'a blocked write must not leave an orphaned participant row');
  assert.equal(outboxEntries().length, 0, 'the blocked attempt must not queue any outbox entries');

  // Once unblocked, the exact same call succeeds normally (proves the guard
  // doesn't permanently wedge the insert path).
  const newConvId = chat.createDmConversation(ALICE, CAROL);
  assert.ok(newConvId);
  assert.equal(chat.findDmConversation(ALICE, CAROL), newConvId);
  clearOutbox();
});

test('sendMessage with no mentions stores NULL, not an empty array', () => {
  const msg = chat.sendMessage(convId, ALICE, 'no mentions here', 'regular');
  const row = exec(`SELECT mentioned_user_ids FROM messages WHERE id = ?`, [msg.id]).rows[0] as
    { mentioned_user_ids: string | null };
  assert.equal(row.mentioned_user_ids, null);
  assert.equal(msg.mentioned_user_ids, null);
  const msgOps = outboxEntries().filter(o => o.table_name === 'messages');
  assert.equal(msgOps[msgOps.length - 1].payload.mentioned_user_ids, null);
});

test('sendMessage threads mentioned_user_ids through the local row and the outbox payload', () => {
  const msg = chat.sendMessage(convId, ALICE, '@Bob check this out', 'regular', [BOB]);
  const row = exec(`SELECT mentioned_user_ids FROM messages WHERE id = ?`, [msg.id]).rows[0] as
    { mentioned_user_ids: string | null };
  assert.deepEqual(JSON.parse(row.mentioned_user_ids!), [BOB]);
  assert.deepEqual(JSON.parse(msg.mentioned_user_ids!), [BOB]);
  const msgOps = outboxEntries().filter(o => o.table_name === 'messages');
  const last = msgOps[msgOps.length - 1];
  assert.deepEqual(JSON.parse(last.payload.mentioned_user_ids as string), [BOB]);
});

test('editMessage sets body + edited_at locally and queues an outbox UPDATE op', () => {
  const msg = chat.sendMessage(convId, ALICE, 'first draft', 'regular');
  clearOutbox();
  chat.editMessage(msg.id, 'final text');
  const row = messageRow(msg.id);
  assert.equal(row?.body, 'final text');
  assert.ok(row?.edited_at, 'edited_at must be stamped');
  assert.equal(row?.deleted_at ?? null, null);
  const ops = outboxEntries();
  assert.equal(ops.length, 1);
  // MUST be UPDATE: messages is INSERT_NO_UPSERT server-side — an INSERT op
  // with the existing id would be silently dropped and the edit never sync.
  assert.equal(ops[0].operation, 'UPDATE');
  assert.equal(ops[0].table_name, 'messages');
  assert.equal(ops[0].payload.id, msg.id);
  assert.equal(ops[0].payload.body, 'final text');
  assert.ok(ops[0].payload.edited_at, 'the outbox payload must carry edited_at');
});

test('deleteMessage blanks the body + sets deleted_at, locally and in the outbox UPDATE', () => {
  const msg = chat.sendMessage(convId, BOB, 'to be removed');
  clearOutbox();
  chat.deleteMessage(msg.id);
  const row = messageRow(msg.id);
  assert.equal(row?.body, '', 'a deleted message must not retain its content locally');
  assert.ok(row?.deleted_at, 'deleted_at must be stamped');
  const ops = outboxEntries();
  assert.equal(ops.length, 1);
  assert.equal(ops[0].operation, 'UPDATE');
  assert.equal(ops[0].table_name, 'messages');
  assert.equal(ops[0].payload.id, msg.id);
  assert.equal(ops[0].payload.body, '', 'the synced payload must carry the blanked body');
  assert.ok(ops[0].payload.deleted_at);
});

test('deleted messages are excluded from unread counts and the last_body preview', () => {
  // Pin created_at explicitly (sends within the same ms would tie-break
  // ambiguously in the ORDER BY created_at subselects).
  const b1 = chat.sendMessage(convId, BOB, 'hello');
  const b2 = chat.sendMessage(convId, BOB, 'secret plans');
  exec(`UPDATE messages SET created_at = ? WHERE id = ?`, ['2030-01-01T00:00:01.000Z', b1.id]);
  exec(`UPDATE messages SET created_at = ? WHERE id = ?`, ['2030-01-01T00:00:02.000Z', b2.id]);

  // Alice has never read the conversation: both of Bob's live messages count
  // (plus any earlier Bob sends from the tests above — count relatively).
  const beforeDelete = chat.listConversations(ALICE).find(c => c.id === convId);
  assert.ok(beforeDelete);
  assert.equal(beforeDelete.last_body, 'secret plans');
  const unreadBefore = beforeDelete.unread;
  const totalBefore = chat.totalUnread(ALICE);

  chat.deleteMessage(b2.id);

  // The deleted message vanishes from BOTH the unread count and the preview —
  // the list falls back to the newest surviving message, not a blank body.
  const conv = chat.listConversations(ALICE).find(c => c.id === convId);
  assert.equal(conv?.unread, unreadBefore - 1);
  assert.equal(conv?.last_body, 'hello');
  assert.equal(conv?.last_at, '2030-01-01T00:00:01.000Z');
  assert.equal(chat.totalUnread(ALICE), totalBefore - 1);
});

test('markConversationRead zeroes unread and mirrors last_read_at through the outbox', () => {
  // The previous test pinned a surviving message into 2030 — pull any
  // future-dated rows back to now so the fresh last_read_at stamp can cover them.
  exec(`UPDATE messages SET created_at = ? WHERE created_at > ?`, [new Date().toISOString(), '2029-01-01']);
  clearOutbox();
  chat.markConversationRead(convId, ALICE);
  const conv = chat.listConversations(ALICE).find(c => c.id === convId);
  assert.equal(conv?.unread, 0);
  const ops = outboxEntries().filter(o => o.table_name === 'conversation_participants');
  assert.equal(ops.length, 1);
  assert.equal(ops[0].operation, 'UPDATE');
  assert.equal(ops[0].payload.conversation_id, convId);
  assert.equal(ops[0].payload.user_id, ALICE);
  assert.ok(ops[0].payload.last_read_at, 'the outbox payload must carry last_read_at');
});
