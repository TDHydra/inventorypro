import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import bcrypt from 'bcrypt';
import authRoutes from './auth';
import type { DemoModeGate } from '../lib/demoMode';

// #32 S3 — the demo-mode kill switch on the auth surface:
//  - /auth/roster hides demo (is_test) accounts and their public enrollment
//    codes when demo mode is OFF, and lists them (code included) when ON.
//  - /auth/set-pin refuses a demo account with 403 when OFF — BEFORE the
//    enrollment-code comparison, so the (public) code buys nothing.
const SECRET = 'unit-test-secret-that-is-at-least-32-chars!!';
const REAL_ID = '5f0c1a2b-3d4e-4f60-8a9b-0c1d2e3f4a5b';
const DEMO_ID = '6a1d2b3c-4e5f-4a70-9b0c-1d2e3f4a5b6c';
const DEMO_CODE = '654321';

const ROSTER_ROWS = [
  { id: REAL_ID, name: 'Alice', role: 'admin', pin_length_required: 4, pin_set: true, is_test: false, test_code: null },
  { id: DEMO_ID, name: 'Demo', role: 'employee', pin_length_required: 4, pin_set: false, is_test: true, test_code: DEMO_CODE },
];

// The roster stub HONORS the demo filter the route builds into its SQL — the
// exclusion must come from the query text, not from mapping tricks.
function fakePg() {
  return {
    query: async (sql: string, params: unknown[]) => {
      if (sql.includes('pin_hash IS NOT NULL')) {
        const rows = sql.includes('AND NOT is_test')
          ? ROSTER_ROWS.filter(r => !r.is_test)
          : ROSTER_ROWS;
        return { rows };
      }
      if (sql.includes('enrollment_code_hash')) {
        // /auth/set-pin user lookup
        if (params[0] !== DEMO_ID) return { rows: [] };
        return {
          rows: [{
            id: DEMO_ID, name: 'Demo', role: 'employee',
            pin_set: false, active: true, expires_at: null,
            enrollment_code_hash: null, is_test: true, enrollment_code_public: DEMO_CODE,
          }],
        };
      }
      return { rows: [] };
    },
  };
}

function stubGate(enabled: boolean): DemoModeGate {
  return { isEnabled: async () => enabled, invalidate() {} };
}

async function buildApp(demoOn: boolean) {
  const app = Fastify();
  app.decorate('pg', fakePg() as never);
  await app.register(fastifyJwt, { secret: SECRET });
  await app.register(authRoutes, { prefix: '/auth', demoGate: stubGate(demoOn) });
  await app.ready();
  return app;
}

test('roster includes demo accounts (with their public code) when demo mode is ON', async () => {
  const app = await buildApp(true);
  const res = await app.inject({ method: 'GET', url: '/auth/roster' });
  assert.equal(res.statusCode, 200);
  const { users } = res.json() as { users: any[] };
  assert.equal(users.length, 2);
  const demo = users.find(u => u.is_test === 1);
  assert.ok(demo, 'demo account listed');
  assert.equal(demo.test_code, DEMO_CODE);
  await app.close();
});

test('roster excludes demo accounts and exposes no test_code when demo mode is OFF', async () => {
  const app = await buildApp(false);
  const res = await app.inject({ method: 'GET', url: '/auth/roster' });
  assert.equal(res.statusCode, 200);
  const { users } = res.json() as { users: any[] };
  assert.equal(users.length, 1);
  assert.ok(users.every(u => u.is_test === 0), 'no demo accounts listed');
  assert.ok(users.every(u => u.test_code === null), 'no enrollment code exposed');
  assert.ok(!res.body.includes(DEMO_CODE), 'code absent from the raw response');
  await app.close();
});

test('set-pin for a demo account is 403 when demo mode is OFF — even with the correct code', async () => {
  const app = await buildApp(false);
  const res = await app.inject({
    method: 'POST', url: '/auth/set-pin',
    payload: { user_id: DEMO_ID, pin: '1234', enrollment_code: DEMO_CODE },
  });
  assert.equal(res.statusCode, 403);
  await app.close();
});

test('set-pin for a demo account issues a session when demo mode is ON', async () => {
  const app = await buildApp(true);
  const res = await app.inject({
    method: 'POST', url: '/auth/set-pin',
    payload: { user_id: DEMO_ID, pin: '1234', enrollment_code: DEMO_CODE },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { jwt?: string; userId?: string };
  assert.ok(body.jwt, 'jwt issued');
  assert.equal(body.userId, DEMO_ID);
  await app.close();
});

// #45 — one-time enrollment codes now carry a hard expiry (migration 051).
// /auth/set-pin refuses a code whose enrollment_code_expires_at is NULL or in the
// past (403 'Enrollment code expired'), and honours an unexpired one.
const ENROLL_ID = '7b2e3c4d-5f60-4a71-8b9c-0d1e2f3a4b5c';
const ENROLL_CODE = '112233';

// Fake pg for a REAL (non-test) user mid-enrollment: it returns the set-pin user
// row with the new enrollment_code_expires_at column, and no-ops the success-path
// UPDATE + activity_log INSERT so a valid code reaches the 200.
function fakePgEnroll(opts: { expiresAt: string | null; hash: string }) {
  return {
    query: async (sql: string, _params: unknown[]) => {
      if (sql.trimStart().startsWith('SELECT') && sql.includes('enrollment_code_hash')) {
        return {
          rows: [{
            id: ENROLL_ID, name: 'Bob', role: 'employee',
            pin_set: false, active: true, expires_at: null,
            enrollment_code_hash: opts.hash,
            enrollment_code_expires_at: opts.expiresAt,
            is_test: false, enrollment_code_public: null,
          }],
        };
      }
      return { rows: [] };
    },
  };
}

async function buildEnrollApp(opts: { expiresAt: string | null; hash: string }) {
  const app = Fastify();
  app.decorate('pg', fakePgEnroll(opts) as never);
  await app.register(fastifyJwt, { secret: SECRET });
  await app.register(authRoutes, { prefix: '/auth', demoGate: stubGate(true) });
  await app.ready();
  return app;
}

test('set-pin with an EXPIRED enrollment code is 403 (before the code is even compared)', async () => {
  const past = new Date(Date.now() - 60_000).toISOString();
  const hash = await bcrypt.hash(ENROLL_CODE, 10);
  const app = await buildEnrollApp({ expiresAt: past, hash });
  const res = await app.inject({
    method: 'POST', url: '/auth/set-pin',
    payload: { user_id: ENROLL_ID, pin: '4321', enrollment_code: ENROLL_CODE },
  });
  assert.equal(res.statusCode, 403);
  assert.equal((res.json() as { error: string }).error, 'Enrollment code expired');
  await app.close();
});

test('set-pin with a NULL expiry (never stamped) is treated as expired → 403', async () => {
  const hash = await bcrypt.hash(ENROLL_CODE, 10);
  const app = await buildEnrollApp({ expiresAt: null, hash });
  const res = await app.inject({
    method: 'POST', url: '/auth/set-pin',
    payload: { user_id: ENROLL_ID, pin: '4321', enrollment_code: ENROLL_CODE },
  });
  assert.equal(res.statusCode, 403);
  assert.equal((res.json() as { error: string }).error, 'Enrollment code expired');
  await app.close();
});

test('set-pin with a valid UNEXPIRED enrollment code succeeds', async () => {
  const future = new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString();
  const hash = await bcrypt.hash(ENROLL_CODE, 10);
  const app = await buildEnrollApp({ expiresAt: future, hash });
  const res = await app.inject({
    method: 'POST', url: '/auth/set-pin',
    payload: { user_id: ENROLL_ID, pin: '4321', enrollment_code: ENROLL_CODE },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { jwt?: string; userId?: string };
  assert.ok(body.jwt, 'jwt issued');
  assert.equal(body.userId, ENROLL_ID);
  await app.close();
});
