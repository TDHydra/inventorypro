import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestAccountGate, TEST_ACCOUNT_WRITE_ERROR } from './testAccounts';

// Must match the client's PERMANENT_REJECTION classes (apps/mobile/src/sync/engine.ts)
// so a test-account push rejection is dropped from the outbox instead of retried
// forever / dead-lettered as a stuck pending entry.
const CLIENT_PERMANENT_REJECTION = /forbidden|cannot|not allowed/i;

test('write-wall error message is a client-permanent rejection (never wedges an outbox)', () => {
  assert.match(TEST_ACCOUNT_WRITE_ERROR, CLIENT_PERMANENT_REJECTION);
});

function fakePg(isTestById: Record<string, boolean>) {
  let calls = 0;
  return {
    get calls() { return calls; },
    query: async (_sql: string, params: unknown[]) => {
      calls++;
      const id = params[0] as string;
      return {
        rows: id in isTestById ? [{ is_test: isTestById[id] }] : [],
      };
    },
  };
}

beforeEach(() => {
  mock.timers.enable({ apis: ['Date'] });
});
afterEach(() => {
  mock.timers.reset();
});

test('isTestUser reflects the DB flag', async () => {
  const pg = fakePg({ t1: true, u1: false });
  const gate = createTestAccountGate(pg);
  assert.equal(await gate.isTestUser('t1'), true);
  assert.equal(await gate.isTestUser('u1'), false);
});

test('unknown user is not a test user (fail open to the route auth, not the wall)', async () => {
  const pg = fakePg({});
  const gate = createTestAccountGate(pg);
  assert.equal(await gate.isTestUser('ghost'), false);
});

test('result is cached within the TTL — one query per user, not per request', async () => {
  const pg = fakePg({ t1: true });
  const gate = createTestAccountGate(pg);
  await gate.isTestUser('t1');
  await gate.isTestUser('t1');
  await gate.isTestUser('t1');
  assert.equal(pg.calls, 1);
});

test('cache expires after the TTL and re-queries', async () => {
  const pg = fakePg({ t1: true });
  const gate = createTestAccountGate(pg, 60_000);
  await gate.isTestUser('t1');
  mock.timers.tick(61_000);
  await gate.isTestUser('t1');
  assert.equal(pg.calls, 2);
});

test('cache is per-user', async () => {
  const pg = fakePg({ t1: true, u1: false });
  const gate = createTestAccountGate(pg);
  await gate.isTestUser('t1');
  await gate.isTestUser('u1');
  assert.equal(pg.calls, 2);
});
