import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDemoModeGate } from './demoMode';

// Same style as testAccounts.test.ts: fake pg + mocked Date so the TTL is
// deterministic.
function fakePg(initial: string | null) {
  let value = initial;
  let calls = 0;
  return {
    get calls() { return calls; },
    set value(v: string | null) { value = v; },
    query: async (_sql: string, _params: unknown[]) => {
      calls++;
      return { rows: value === null ? [] : [{ value }] };
    },
  };
}

beforeEach(() => {
  mock.timers.enable({ apis: ['Date'] });
});
afterEach(() => {
  mock.timers.reset();
});

test('a missing demo_mode row means ON (absence is enabled)', async () => {
  const gate = createDemoModeGate(fakePg(null));
  assert.equal(await gate.isEnabled(), true);
});

test("'1' is on, '0' is off", async () => {
  assert.equal(await createDemoModeGate(fakePg('1')).isEnabled(), true);
  assert.equal(await createDemoModeGate(fakePg('0')).isEnabled(), false);
});

test('result is cached within the TTL — one query, not one per check', async () => {
  const pg = fakePg('1');
  const gate = createDemoModeGate(pg);
  await gate.isEnabled();
  await gate.isEnabled();
  await gate.isEnabled();
  assert.equal(pg.calls, 1);
});

test('cache expires after the TTL and re-reads the DB', async () => {
  const pg = fakePg('1');
  const gate = createDemoModeGate(pg, 60_000);
  assert.equal(await gate.isEnabled(), true);
  pg.value = '0';
  assert.equal(await gate.isEnabled(), true); // still cached
  mock.timers.tick(61_000);
  assert.equal(await gate.isEnabled(), false); // TTL elapsed → fresh read
  assert.equal(pg.calls, 2);
});

test('invalidate() drops the cache immediately (PATCH /audit/demo-mode path)', async () => {
  const pg = fakePg('1');
  const gate = createDemoModeGate(pg);
  assert.equal(await gate.isEnabled(), true);
  pg.value = '0';
  gate.invalidate();
  assert.equal(await gate.isEnabled(), false); // no TTL wait needed
  assert.equal(pg.calls, 2);
});
