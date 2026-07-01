import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dedupKeys, getNotifyConfig } from './notifications';

test('dedupKeys build stable keys', () => {
  assert.equal(dedupKeys.assign('r1', 'u1'), 'assign:repair:r1:u1');
  assert.equal(dedupKeys.lowstock('i1'), 'lowstock:item:i1');
  assert.equal(dedupKeys.session('u1', '2026-07-01T10:00:00Z'), 'session:user:u1:2026-07-01T10:00:00Z');
});
test('getNotifyConfig applies defaults + parses + clamps + disable flag', async () => {
  const pgEmpty = { query: async () => ({ rows: [] }) };
  assert.deepEqual(await getNotifyConfig(pgEmpty as any), { enabled: true, pollMin: 5, idleMin: 15 });
  const pgSet = { query: async () => ({ rows: [
    { key: 'notify_enabled', value: '0' },
    { key: 'notify_poll_interval_min', value: '2' },
    { key: 'notify_checkout_idle_min', value: '30' },
  ] }) };
  assert.deepEqual(await getNotifyConfig(pgSet as any), { enabled: false, pollMin: 2, idleMin: 30 });
});
test('getNotifyConfig clamps durations to [1,1440] (guards setInterval overflow + dead-timer)', async () => {
  const pgHuge = { query: async () => ({ rows: [
    { key: 'notify_poll_interval_min', value: '999999' },
    { key: 'notify_checkout_idle_min', value: '99999' },
  ] }) };
  assert.deepEqual(await getNotifyConfig(pgHuge as any), { enabled: true, pollMin: 1440, idleMin: 1440 });
  // Invalid/zero/garbage → falls back to the default (0 is falsy → default), never < 1.
  const pgZero = { query: async () => ({ rows: [{ key: 'notify_poll_interval_min', value: '0' }] }) };
  assert.equal((await getNotifyConfig(pgZero as any)).pollMin, 5);
});
