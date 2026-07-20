import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import bcrypt from 'bcrypt';
import meRoutes, { normalizePhone } from './me';
import type { SendMailResult } from '../lib/mail';

// Self-service profile routes (role-dashboards spec §5):
//  - /me/change-pin validation matrix (wrong current PIN, digits, exact length,
//    weak, same-as-current, success).
//  - /me/email request-code + confirm (code stored hashed, expiry, email/code
//    mismatch, SMTP-unavailable {sent:false} fallback with NULL code_hash).
//  - /me/phone normalization (separators stripped, optional leading +, 7–15
//    digits, null clears) — and that email/phone writes bump users.updated_at.
//
// Fake-pg + authenticate-stub pattern per media-message-scope.test.ts. NOTE:
// the per-user rate-limit buckets in lib/rateLimit are module-global, so each
// test uses its own caller id to keep buckets independent.

const CURRENT_PIN = '4826';
const CURRENT_HASH = bcrypt.hashSync(CURRENT_PIN, 4);

interface FakeState {
  user?: { pin_hash: string | null; pin_length_required: number; name: string } | null;
  pending?: { email: string; code_hash: string | null; expires_at: string } | null;
}

// Dispatching fake pg: answers the routes' SELECTs from `state` and records
// every mutation so tests can assert exactly what was written.
function fakePg(state: FakeState) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  return {
    queries,
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      if (sql.includes('SELECT pin_hash, pin_length_required')) {
        return { rows: state.user ? [state.user] : [] };
      }
      if (sql.includes('SELECT name FROM users')) {
        return { rows: state.user ? [{ name: state.user.name }] : [] };
      }
      if (sql.includes('FROM user_email_changes') && sql.includes('SELECT')) {
        return { rows: state.pending ? [state.pending] : [] };
      }
      return { rows: [] };
    },
  };
}

function defaultUser(): FakeState['user'] {
  return { pin_hash: CURRENT_HASH, pin_length_required: 4, name: 'Alice' };
}

async function buildApp(opts: {
  callerId: string;
  state?: FakeState;
  sendResult?: SendMailResult;
  onSend?: (to: string, code: string, userName: string) => void;
}) {
  const state = opts.state ?? { user: defaultUser() };
  const pg = fakePg(state);
  const app = Fastify();
  app.decorate('pg', pg as never);
  app.decorate('authenticate', async (request: { user?: unknown }) => {
    request.user = { sub: opts.callerId };
  });
  await app.register(meRoutes, {
    prefix: '/me',
    sendCode: async (to, code, userName) => {
      opts.onSend?.(to, code, userName);
      return opts.sendResult ?? { sent: true, messageId: 'test' };
    },
  });
  await app.ready();
  return { app, pg, state };
}

const wrote = (pg: { queries: Array<{ sql: string }> }, fragment: string) =>
  pg.queries.some(q => q.sql.includes(fragment));

// ---------------------------------------------------------------------------
// POST /me/change-pin — validation matrix
// ---------------------------------------------------------------------------

test('change-pin: wrong current PIN → 403, nothing written', async () => {
  const { app, pg } = await buildApp({ callerId: 'cp-wrong' });
  const res = await app.inject({
    method: 'POST', url: '/me/change-pin',
    payload: { currentPin: '9999', newPin: '7391' },
  });
  assert.equal(res.statusCode, 403);
  assert.ok(!wrote(pg, 'UPDATE users'), 'no UPDATE ran');
  await app.close();
});

test('change-pin: non-digit new PIN → 400', async () => {
  const { app } = await buildApp({ callerId: 'cp-digits' });
  const res = await app.inject({
    method: 'POST', url: '/me/change-pin',
    payload: { currentPin: CURRENT_PIN, newPin: '12ab' },
  });
  assert.equal(res.statusCode, 400);
  assert.match((res.json() as { error: string }).error, /digits/i);
  await app.close();
});

test('change-pin: wrong length (pin_length_required not met) → 400', async () => {
  const { app } = await buildApp({
    callerId: 'cp-length',
    state: { user: { pin_hash: CURRENT_HASH, pin_length_required: 6, name: 'Alice' } },
  });
  const res = await app.inject({
    method: 'POST', url: '/me/change-pin',
    payload: { currentPin: CURRENT_PIN, newPin: '7391' }, // 4 digits, needs 6
  });
  assert.equal(res.statusCode, 400);
  assert.match((res.json() as { error: string }).error, /exactly 6 digits/);
  await app.close();
});

test('change-pin: weak new PIN (straight sequence) → 400', async () => {
  const { app } = await buildApp({ callerId: 'cp-weak' });
  const res = await app.inject({
    method: 'POST', url: '/me/change-pin',
    payload: { currentPin: CURRENT_PIN, newPin: '1234' },
  });
  assert.equal(res.statusCode, 400);
  assert.match((res.json() as { error: string }).error, /easy to guess/i);
  await app.close();
});

test('change-pin: new PIN equal to current → 400', async () => {
  const { app, pg } = await buildApp({ callerId: 'cp-same' });
  const res = await app.inject({
    method: 'POST', url: '/me/change-pin',
    payload: { currentPin: CURRENT_PIN, newPin: CURRENT_PIN },
  });
  assert.equal(res.statusCode, 400);
  assert.match((res.json() as { error: string }).error, /different/i);
  assert.ok(!wrote(pg, 'UPDATE users'), 'no UPDATE ran');
  await app.close();
});

test('change-pin: valid change → 204, new hash stored, updated_at bumped', async () => {
  const { app, pg } = await buildApp({ callerId: 'cp-ok' });
  const res = await app.inject({
    method: 'POST', url: '/me/change-pin',
    payload: { currentPin: CURRENT_PIN, newPin: '7391' },
  });
  assert.equal(res.statusCode, 204);
  const upd = pg.queries.find(q => q.sql.includes('UPDATE users SET pin_hash'));
  assert.ok(upd, 'pin UPDATE ran');
  assert.ok(upd!.sql.includes('updated_at = NOW()'));
  assert.ok(await bcrypt.compare('7391', String(upd!.params[0])), 'stored hash matches the new PIN');
  assert.equal(upd!.params[1], 'cp-ok');
  await app.close();
});

test('change-pin: no PIN set yet → 403 (flow does not apply)', async () => {
  const { app } = await buildApp({
    callerId: 'cp-nopin',
    state: { user: { pin_hash: null, pin_length_required: 4, name: 'Alice' } },
  });
  const res = await app.inject({
    method: 'POST', url: '/me/change-pin',
    payload: { currentPin: '4826', newPin: '7391' },
  });
  assert.equal(res.statusCode, 403);
  await app.close();
});

// ---------------------------------------------------------------------------
// POST /me/email/request-code + /me/email/confirm
// ---------------------------------------------------------------------------

test('request-code: emails a 6-digit code and stores its bcrypt hash, {sent:true}', async () => {
  let sentCode = '';
  let sentTo = '';
  const { app, pg } = await buildApp({
    callerId: 'ec-sent',
    onSend: (to, code) => { sentTo = to; sentCode = code; },
  });
  const res = await app.inject({
    method: 'POST', url: '/me/email/request-code',
    payload: { email: 'new@example.com' },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { sent: true });
  assert.equal(sentTo, 'new@example.com');
  assert.match(sentCode, /^[0-9]{6}$/);
  const ins = pg.queries.find(q => q.sql.includes('INSERT INTO user_email_changes'));
  assert.ok(ins, 'pending row upserted');
  assert.equal(ins!.params[1], 'new@example.com');
  assert.ok(ins!.params[2] != null, 'code_hash stored');
  assert.ok(await bcrypt.compare(sentCode, String(ins!.params[2])), 'stored hash matches the emailed code');
  await app.close();
});

test('request-code: SMTP unavailable → pending stored with NULL code_hash, {sent:false}', async () => {
  const { app, pg } = await buildApp({
    callerId: 'ec-fallback',
    sendResult: { sent: false, reason: 'smtp-not-configured' },
  });
  const res = await app.inject({
    method: 'POST', url: '/me/email/request-code',
    payload: { email: 'new@example.com' },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { sent: false });
  const ins = pg.queries.find(q => q.sql.includes('INSERT INTO user_email_changes'));
  assert.ok(ins, 'pending row still upserted');
  assert.equal(ins!.params[2], null, 'code_hash is NULL in the fallback path');
  await app.close();
});

test('request-code: transport failure (SMTP configured but erroring) → 502, NO codeless fallback', async () => {
  // Spec §5: the NULL-code_hash fallback is ONLY for unconfigured SMTP. A
  // transient outage must not let callers commit an email without a code.
  const { app, pg } = await buildApp({
    callerId: 'ec-sendfail',
    sendResult: { sent: false, reason: 'send-failed', error: 'ETIMEDOUT' },
  });
  const res = await app.inject({
    method: 'POST', url: '/me/email/request-code',
    payload: { email: 'new@example.com' },
  });
  assert.equal(res.statusCode, 502);
  assert.ok(
    !wrote(pg, 'INSERT INTO user_email_changes'),
    'no pending row written/overwritten on a failed send',
  );
  await app.close();
});

test('confirm: correct code before expiry → 204, email set + updated_at bumped, pending cleared', async () => {
  const codeHash = bcrypt.hashSync('654321', 4);
  const { app, pg } = await buildApp({
    callerId: 'ec-ok',
    state: {
      user: defaultUser(),
      pending: { email: 'new@example.com', code_hash: codeHash, expires_at: new Date(Date.now() + 60_000).toISOString() },
    },
  });
  const res = await app.inject({
    method: 'POST', url: '/me/email/confirm',
    payload: { email: 'new@example.com', code: '654321' },
  });
  assert.equal(res.statusCode, 204);
  const upd = pg.queries.find(q => q.sql.includes('UPDATE users SET email'));
  assert.ok(upd, 'email UPDATE ran');
  assert.ok(upd!.sql.includes('updated_at = NOW()'), 'updated_at bumped so the change syncs');
  assert.deepEqual(upd!.params, ['new@example.com', 'ec-ok']);
  assert.ok(wrote(pg, 'DELETE FROM user_email_changes'), 'pending row cleared');
  await app.close();
});

test('confirm: wrong code → 403, email unchanged', async () => {
  const codeHash = bcrypt.hashSync('654321', 4);
  const { app, pg } = await buildApp({
    callerId: 'ec-badcode',
    state: {
      user: defaultUser(),
      pending: { email: 'new@example.com', code_hash: codeHash, expires_at: new Date(Date.now() + 60_000).toISOString() },
    },
  });
  const res = await app.inject({
    method: 'POST', url: '/me/email/confirm',
    payload: { email: 'new@example.com', code: '111111' },
  });
  assert.equal(res.statusCode, 403);
  assert.ok(!wrote(pg, 'UPDATE users SET email'), 'no email UPDATE ran');
  await app.close();
});

test('confirm: expired pending row → 400', async () => {
  const codeHash = bcrypt.hashSync('654321', 4);
  const { app, pg } = await buildApp({
    callerId: 'ec-expired',
    state: {
      user: defaultUser(),
      pending: { email: 'new@example.com', code_hash: codeHash, expires_at: new Date(Date.now() - 1_000).toISOString() },
    },
  });
  const res = await app.inject({
    method: 'POST', url: '/me/email/confirm',
    payload: { email: 'new@example.com', code: '654321' },
  });
  assert.equal(res.statusCode, 400);
  assert.match((res.json() as { error: string }).error, /expired/i);
  assert.ok(!wrote(pg, 'UPDATE users SET email'));
  await app.close();
});

test('confirm: email does not match the pending change → 400', async () => {
  const codeHash = bcrypt.hashSync('654321', 4);
  const { app, pg } = await buildApp({
    callerId: 'ec-mismatch',
    state: {
      user: defaultUser(),
      pending: { email: 'new@example.com', code_hash: codeHash, expires_at: new Date(Date.now() + 60_000).toISOString() },
    },
  });
  const res = await app.inject({
    method: 'POST', url: '/me/email/confirm',
    payload: { email: 'other@example.com', code: '654321' },
  });
  assert.equal(res.statusCode, 400);
  assert.ok(!wrote(pg, 'UPDATE users SET email'));
  await app.close();
});

test('confirm: no pending change → 400', async () => {
  const { app } = await buildApp({ callerId: 'ec-none', state: { user: defaultUser(), pending: null } });
  const res = await app.inject({
    method: 'POST', url: '/me/email/confirm',
    payload: { email: 'new@example.com', code: '654321' },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('confirm: NULL code_hash (SMTP fallback) accepts the matching email without a code', async () => {
  const { app, pg } = await buildApp({
    callerId: 'ec-nullhash',
    state: {
      user: defaultUser(),
      pending: { email: 'new@example.com', code_hash: null, expires_at: new Date(Date.now() + 60_000).toISOString() },
    },
  });
  const res = await app.inject({
    method: 'POST', url: '/me/email/confirm',
    payload: { email: 'new@example.com' },
  });
  assert.equal(res.statusCode, 204);
  assert.ok(wrote(pg, 'UPDATE users SET email'));
  await app.close();
});

test('confirm: code required when a hash exists but none supplied → 400', async () => {
  const codeHash = bcrypt.hashSync('654321', 4);
  const { app } = await buildApp({
    callerId: 'ec-nocode',
    state: {
      user: defaultUser(),
      pending: { email: 'new@example.com', code_hash: codeHash, expires_at: new Date(Date.now() + 60_000).toISOString() },
    },
  });
  const res = await app.inject({
    method: 'POST', url: '/me/email/confirm',
    payload: { email: 'new@example.com' },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

// ---------------------------------------------------------------------------
// PATCH /me/phone — normalization
// ---------------------------------------------------------------------------

test('normalizePhone strips separators, keeps optional +, enforces 7–15 digits', () => {
  assert.equal(normalizePhone('(555) 123-4567'), '5551234567');
  assert.equal(normalizePhone('+1 555 123 4567'), '+15551234567');
  assert.equal(normalizePhone('555.123.4567'), '5551234567');
  assert.equal(normalizePhone('  +447911123456 '), '+447911123456');
  assert.equal(normalizePhone('1234567'), '1234567'); // 7-digit minimum ok
  assert.equal(normalizePhone('123456'), null); // too short
  assert.equal(normalizePhone('1234567890123456'), null); // 16 digits — too long
  assert.equal(normalizePhone('555-CALL-NOW'), null); // letters
  assert.equal(normalizePhone('55+51234567'), null); // + only allowed leading
  assert.equal(normalizePhone(''), null);
});

test('phone: separated input stored normalized, 204, updated_at bumped', async () => {
  const { app, pg } = await buildApp({ callerId: 'ph-ok' });
  const res = await app.inject({
    method: 'PATCH', url: '/me/phone',
    payload: { phone: '+1 (555) 123-4567' },
  });
  assert.equal(res.statusCode, 204);
  const upd = pg.queries.find(q => q.sql.includes('UPDATE users SET phone'));
  assert.ok(upd, 'phone UPDATE ran');
  assert.ok(upd!.sql.includes('updated_at = NOW()'), 'updated_at bumped so the change syncs');
  assert.deepEqual(upd!.params, ['+15551234567', 'ph-ok']);
  await app.close();
});

test('phone: invalid number → 400, nothing written', async () => {
  const { app, pg } = await buildApp({ callerId: 'ph-bad' });
  const res = await app.inject({
    method: 'PATCH', url: '/me/phone',
    payload: { phone: '12345' },
  });
  assert.equal(res.statusCode, 400);
  assert.ok(!wrote(pg, 'UPDATE users SET phone'), 'no UPDATE ran');
  await app.close();
});

test('phone: null clears the stored number → 204', async () => {
  const { app, pg } = await buildApp({ callerId: 'ph-null' });
  const res = await app.inject({
    method: 'PATCH', url: '/me/phone',
    payload: { phone: null },
  });
  assert.equal(res.statusCode, 204);
  const upd = pg.queries.find(q => q.sql.includes('UPDATE users SET phone'));
  assert.ok(upd);
  assert.deepEqual(upd!.params, [null, 'ph-null']);
  await app.close();
});
