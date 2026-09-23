import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import authRoutes, { nextLockMs, sweepAttempts, WINDOW_MS, isRefreshToken, TOKEN_IP_LIMIT } from '../routes/auth';

test('exponential backoff grows with fail count and caps', () => {
  assert.equal(nextLockMs(2), 0);            // below threshold, no lock
  assert.ok(nextLockMs(3) > 0);
  assert.ok(nextLockMs(8) > nextLockMs(3));
  assert.ok(nextLockMs(50) <= 60 * 60_000);  // capped at 1h
});

test('sweepAttempts deletes expired unlocked entries only', () => {
  const now = Date.now();
  const map = new Map<string, { count: number; first: number; lockedUntil: number }>([
    // window elapsed, not locked → swept
    ['unit-test:expired', { count: 2, first: now - WINDOW_MS - 1, lockedUntil: 0 }],
    // window elapsed but lockout still active → kept (never drop a live lock)
    ['unit-test:locked', { count: 9, first: now - WINDOW_MS - 1, lockedUntil: now + 60_000 }],
    // window still open → kept
    ['unit-test:fresh', { count: 1, first: now - 1_000, lockedUntil: 0 }],
    // lock expired AND window elapsed → swept
    ['unit-test:lock-expired', { count: 5, first: now - WINDOW_MS - 1, lockedUntil: now - 1 }],
  ]);
  const removed = sweepAttempts(now, map);
  assert.equal(removed, 2);
  assert.equal(map.has('unit-test:expired'), false);
  assert.equal(map.has('unit-test:lock-expired'), false);
  assert.equal(map.has('unit-test:locked'), true);
  assert.equal(map.has('unit-test:fresh'), true);
});

test('sweepAttempts on an empty map is a no-op', () => {
  const map = new Map<string, { count: number; first: number; lockedUntil: number }>();
  assert.equal(sweepAttempts(Date.now(), map), 0);
  assert.equal(map.size, 0);
});

test('isRefreshToken flags refresh payloads and passes legacy access payloads', () => {
  assert.equal(isRefreshToken({ sub: 'u1', type: 'refresh' }), true);
  assert.equal(isRefreshToken({ sub: 'u1', name: 'n', role: 'admin' }), false); // legacy, no type
  assert.equal(isRefreshToken({ sub: 'u1', type: 'access' }), false);
  assert.equal(isRefreshToken(null), false);
  assert.equal(isRefreshToken('refresh'), false);
});

// --- per-IP cap on /auth/token (SEC-H residual) ----------------------------
// The UUID schema stops junk user_ids, but distinct VALID-format UUIDs sprayed
// from one IP still added one attempts-map entry per request between sweeps.
// Route-level tests in the style of auth-schema.test.ts: minimal app, stubbed
// pg that never finds a user, so every allowed request takes the recordFail
// (401) path. Map growth is observed through sweepAttempts on the module
// singleton — sweeping "far in the future" removes exactly the entries the
// requests added (FUTURE clears any entry, even one carrying the max 1h lock).
const FUTURE = () => Date.now() + WINDOW_MS + 2 * 60 * 60_000;

async function buildTokenApp() {
  const app = Fastify();
  // /auth/token only queries users; empty rows → unknown user → recordFail+401.
  app.decorate('pg', { query: async () => ({ rows: [] }) } as any);
  await app.register(authRoutes, { prefix: '/auth' });
  await app.ready();
  return app;
}

// Distinct, well-formed v4-shaped UUIDs so the schema passes every time.
function uuidN(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function injectToken(app: Awaited<ReturnType<typeof buildTokenApp>>, ip: string, n: number) {
  return app.inject({
    method: 'POST', url: '/auth/token', remoteAddress: ip,
    payload: { user_id: uuidN(n), pin: '9317' },
  });
}

test('under the per-IP cap /auth/token behaves unchanged (401 + attempts entries)', async () => {
  const app = await buildTokenApp();
  sweepAttempts(FUTURE()); // drain the singleton for exact accounting
  const ip = '203.0.113.10';
  for (let i = 0; i < 5; i++) {
    const res = await injectToken(app, ip, i);
    assert.equal(res.statusCode, 401); // unknown user → generic invalid credentials
  }
  // Exactly the 5 sprayed user_ids were recorded — normal lockout bookkeeping.
  assert.equal(sweepAttempts(FUTURE()), 5);
  await app.close();
});

test('over the per-IP cap /auth/token → 429 and the attempts map stops growing', async () => {
  const app = await buildTokenApp();
  const ip = '203.0.113.20';
  // Exhaust this IP's quota with distinct valid-format UUIDs (all recorded).
  for (let i = 0; i < TOKEN_IP_LIMIT; i++) {
    const res = await injectToken(app, ip, 1_000 + i);
    assert.equal(res.statusCode, 401);
  }
  sweepAttempts(FUTURE()); // drain — any growth from here on must be zero
  for (let i = 0; i < 10; i++) {
    const res = await injectToken(app, ip, 500_000 + i);
    assert.equal(res.statusCode, 429);
    assert.match(res.json().error, /too many requests/i);
  }
  // The over-cap spray added NOTHING to the attempts map.
  assert.equal(sweepAttempts(FUTURE()), 0);
  // A different IP has its own bucket — still served (and recorded) normally.
  const other = await injectToken(app, '203.0.113.21', 900_000);
  assert.equal(other.statusCode, 401);
  assert.equal(sweepAttempts(FUTURE()), 1);
  await app.close();
});
