import { createRequire } from 'node:module';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// #29 — chat edit/delete semantics. chat.ts can't load under `node --test`
// as-is (db/schema imports the native op-sqlite binding, utils/uuid imports
// react-native-get-random-values), so this uses the locationsShelf.test.ts
// Module._load redirect: db/schema becomes a REAL sql.js database
// (locationsShelf.testdb.ts) and the actual chat queries run end-to-end,
// including their outbox side effects. The load-bearing constraint under test:
// messages is INSERT_NO_UPSERT on the server, so edits/deletes MUST queue
// UPDATE outbox ops — a re-INSERT with the existing id is a server no-op.
const requireCjs = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Module = requireCjs('node:module') as any;
const testDb = requireCjs('./locationsShelf.testdb') as typeof import('./locationsShelf.testdb');

const origLoad = Module._load;
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  // Side-effect-only crypto polyfill; node already has crypto.getRandomValues.
  if (request === 'react-native-get-random-values') return {};
  let resolved = '';
  try { resolved = Module._resolveFilename(request, parent); } catch { /* not ours — fall through */ }
  if (resolved.endsWith('/src/db/schema.ts')) return testDb;
  if (resolved.endsWith('/src/telemetry/index.ts')) return { track() {} };
  return origLoad.call(this, request, parent, isMain);
};

let chat: typeof import('./chat');
let maintenance: typeof import('../maintenance');

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

before(async () => {
  await testDb.initTestDb(); // locations/taxonomy_types/outbox
  // Chat tables mirror mobile migrations 034 + 039; users for the name joins;
  // app_config so the outbox maintenance guard reads a real (empty) table.
  exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'dm', title TEXT,
      created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE conversation_participants (
      conversation_id TEXT NOT NULL, user_id TEXT NOT NULL,
      notify_pref TEXT NOT NULL DEFAULT 'all', last_read_at TEXT,
      added_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (conversation_id, user_id)
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, sender_id TEXT,
      body TEXT NOT NULL, urgency TEXT NOT NULL DEFAULT 'urgent',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      edited_at TEXT, deleted_at TEXT
    );
    CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE app_config (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
  `);
  exec(`INSERT INTO users (id, name) VALUES (?, ?), (?, ?)`, [ALICE, 'Alice', BOB, 'Bob']);
  chat = requireCjs('./chat') as typeof import('./chat');
  maintenance = requireCjs('../maintenance') as typeof import('../maintenance');
  convId = chat.createDmConversation(ALICE, BOB);
  clearOutbox(); // conversation-creation ops aren't under test
});

// #203: PermissionGate's "Request access" toast action and SyncIndicator's
// handleRequestAccess called createDmConversation with no isWriteBlocked()
// pre-check, and createDmConversation itself did a raw local INSERT into
// conversations BEFORE appendOutbox (the only place assertWritable() throws)
// — so a blocked write left an orphaned, participant-less conversations row
// behind an uncaught MaintenanceLockedError. createDmConversation now runs its
// whole insert flow inside runInTransaction, so the throw rolls everything
// back. (setPreviewWriteBlock is the #199 in-module flag exercised the same
// way maintenance.test.ts does — this test double's app_config table is real
// but empty, so toggling actual maintenance mode isn't needed to prove this.)
test('#203: a write-blocked createDmConversation leaves zero local rows and throws (not an uncaught orphan write)', () => {
  const CAROL = 'user-carol';
  exec(`INSERT INTO users (id, name) VALUES (?, ?)`, [CAROL, 'Carol']);
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
  const convRows = exec(
    `SELECT COUNT(*) AS cnt FROM conversations WHERE created_by = ? AND id NOT IN (SELECT id FROM conversations WHERE id = ?)`,
    [ALICE, convId],
  ).rows as { cnt: number }[];
  assert.equal(convRows[0].cnt, 0, 'the blocked attempt must not leave a second conversations row');
  // ...and no orphaned participant row either (the #203 hazard: a
  // participant-less conversations row, or vice versa).
  const partRows = exec(
    `SELECT COUNT(*) AS cnt FROM conversation_participants WHERE user_id = ?`,
    [CAROL],
  ).rows as { cnt: number }[];
  assert.equal(partRows[0].cnt, 0, 'a blocked write must not leave an orphaned participant row');
  // ...and no queued outbox entries for the rolled-back attempt.
  assert.equal(outboxEntries().length, 0, 'the blocked attempt must not queue any outbox entries');

  // Once unblocked, the exact same call succeeds normally (proves the guard
  // doesn't permanently wedge the table/insert path).
  const newConvId = chat.createDmConversation(ALICE, CAROL);
  assert.ok(newConvId);
  assert.equal(chat.findDmConversation(ALICE, CAROL), newConvId);
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

  // Alice has never read the conversation: both of Bob's live messages count.
  let conv = chat.listConversations(ALICE).find(c => c.id === convId);
  assert.equal(conv?.unread, 2);
  assert.equal(conv?.last_body, 'secret plans');
  assert.equal(chat.totalUnread(ALICE), 2);

  chat.deleteMessage(b2.id);

  // The deleted message vanishes from BOTH the unread count and the preview —
  // the list falls back to the newest surviving message, not a blank body.
  conv = chat.listConversations(ALICE).find(c => c.id === convId);
  assert.equal(conv?.unread, 1);
  assert.equal(conv?.last_body, 'hello');
  assert.equal(conv?.last_at, '2030-01-01T00:00:01.000Z');
  assert.equal(chat.totalUnread(ALICE), 1);
});
