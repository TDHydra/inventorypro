import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunk, buildMessages, deadTokensFromReceipts, pollReceiptsAndDisable, scheduleReceiptRepoll, RECEIPT_REPOLL_MS, messageRecipients } from './push';

test('messageRecipients: urgent notifies pref all + urgent, excludes sender + muted', () => {
  const parts = [
    { user_id: 'sender', notify_pref: 'all' },
    { user_id: 'a', notify_pref: 'all' },
    { user_id: 'b', notify_pref: 'urgent' },
    { user_id: 'c', notify_pref: 'muted' },
  ];
  assert.deepEqual(messageRecipients(parts, 'sender', 'urgent'), ['a', 'b']);
});

test('messageRecipients: regular notifies pref all only (not urgent-only, not muted)', () => {
  const parts = [
    { user_id: 'sender', notify_pref: 'all' },
    { user_id: 'a', notify_pref: 'all' },
    { user_id: 'b', notify_pref: 'urgent' },
    { user_id: 'c', notify_pref: 'muted' },
  ];
  assert.deepEqual(messageRecipients(parts, 'sender', 'regular'), ['a']);
});

test('messageRecipients: sender is always excluded even with pref all', () => {
  const parts = [{ user_id: 'sender', notify_pref: 'all' }];
  assert.deepEqual(messageRecipients(parts, 'sender', 'urgent'), []);
});

test('chunk splits into batches of size', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});
test('buildMessages maps tokens to expo messages with payload', () => {
  const msgs = buildMessages(['ExpoTok1', 'ExpoTok2'], { title: 'Hi', body: 'B', data: { screen: 's' } });
  assert.equal(msgs.length, 2);
  assert.deepEqual(msgs[0], { to: 'ExpoTok1', title: 'Hi', body: 'B', data: { screen: 's' } });
});
test('deadTokensFromReceipts returns DeviceNotRegistered tokens', () => {
  const receipts = { r1: { status: 'ok' }, r2: { status: 'error', details: { error: 'DeviceNotRegistered' } } };
  const dead = deadTokensFromReceipts(receipts, { r1: 'tokA', r2: 'tokB' });
  assert.deepEqual(dead, ['tokB']);
});

test('pollReceiptsAndDisable disables tokens Expo reports dead on the receipt', async () => {
  const disabled: string[] = [];
  const pg = { query: async (sql: string, params: any[]) => {
    if (sql.includes('disabled = TRUE')) disabled.push(...(params[0] as string[]));
    return { rows: [] as any[] };
  } };
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => ({ json: async () => ({ data: {
    r1: { status: 'ok' },
    r2: { status: 'error', details: { error: 'DeviceNotRegistered' } },
  } }) })) as any;
  try {
    await pollReceiptsAndDisable(pg as any, { r1: 'tokA', r2: 'tokB' });
    assert.deepEqual(disabled, ['tokB']); // only the dead token disabled
  } finally { globalThis.fetch = orig; }
});

test('pollReceiptsAndDisable is a no-op with no receipt ids (no fetch, no query)', async () => {
  let called = false;
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => { called = true; return { json: async () => ({}) }; }) as any;
  const pg = { query: async () => { called = true; return { rows: [] as any[] }; } };
  try {
    await pollReceiptsAndDisable(pg as any, {});
    assert.equal(called, false);
  } finally { globalThis.fetch = orig; }
});

test('scheduleReceiptRepoll fires the re-poll after the delay (unref, injectable delay)', async () => {
  const disabled: string[] = [];
  const pg = { query: async (sql: string, params: any[]) => {
    if (sql.includes('disabled = TRUE')) disabled.push(...(params[0] as string[]));
    return { rows: [] as any[] };
  } };
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => ({ json: async () => ({ data: {
    r2: { status: 'error', details: { error: 'DeviceNotRegistered' } },
  } }) })) as any;
  try {
    scheduleReceiptRepoll(pg as any, { r2: 'tokB' }, 5); // 5ms delay for the test
    await new Promise(r => setTimeout(r, 40)); // let the timer fire + async poll flush
    assert.deepEqual(disabled, ['tokB']);
  } finally { globalThis.fetch = orig; }
});

test('scheduleReceiptRepoll no-ops (schedules nothing) with no receipts; default delay ~15m', () => {
  assert.equal(RECEIPT_REPOLL_MS, 15 * 60 * 1000);
  // no throw + nothing scheduled when there are no receipt ids
  scheduleReceiptRepoll({ query: async () => ({ rows: [] }) } as any, {});
});
