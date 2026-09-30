import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateInboxAlerts, INBOX_SEEN_KEY, MAX_INBOX_ALERTS } from './inboxAlerts';

const row = (id: string, created_at: string, read_at: string | null = null) =>
  ({ id, title: `t-${id}`, body: `b-${id}`, created_at, read_at });

test('watermark key and cap are stable', () => {
  assert.equal(INBOX_SEEN_KEY, 'alert:inbox_seen');
  assert.equal(MAX_INBOX_ALERTS, 5);
});

test('first run seeds the watermark without notifying', () => {
  const out = evaluateInboxAlerts([row('a', '2026-08-02T10:00:00Z')], null);
  assert.deepEqual(out.toNotify, []);
  assert.equal(out.nextWatermark, '2026-08-02T10:00:00Z');
});

test('rows newer than the watermark notify, oldest first', () => {
  const out = evaluateInboxAlerts(
    [row('b', '2026-08-02T11:00:00Z'), row('a', '2026-08-02T10:00:00Z')],
    '2026-08-02T09:00:00Z',
  );
  assert.deepEqual(out.toNotify.map(r => r.id), ['a', 'b']);
  assert.equal(out.nextWatermark, '2026-08-02T11:00:00Z');
});

test('already-read and already-seen rows never notify', () => {
  const out = evaluateInboxAlerts(
    [
      row('read', '2026-08-02T11:00:00Z', '2026-08-02T11:01:00Z'),
      row('old', '2026-08-02T08:00:00Z'),
    ],
    '2026-08-02T09:00:00Z',
  );
  assert.deepEqual(out.toNotify, []);
  // Watermark still advances past the read row so it can't re-qualify later.
  assert.equal(out.nextWatermark, '2026-08-02T11:00:00Z');
});

test('a burst is capped at the newest MAX_INBOX_ALERTS rows', () => {
  const rows = Array.from({ length: 8 }, (_, i) =>
    row(`r${i}`, `2026-08-02T10:0${i}:00Z`));
  const out = evaluateInboxAlerts(rows, '2026-08-02T09:00:00Z');
  assert.equal(out.toNotify.length, 5);
  assert.deepEqual(out.toNotify.map(r => r.id), ['r3', 'r4', 'r5', 'r6', 'r7']);
});

test('empty inbox keeps the existing watermark', () => {
  const out = evaluateInboxAlerts([], '2026-08-02T09:00:00Z');
  assert.deepEqual(out.toNotify, []);
  assert.equal(out.nextWatermark, '2026-08-02T09:00:00Z');
});
