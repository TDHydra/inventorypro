import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canaryBucket, shouldAlertCanary, canaryBody, runErrorCanaryCheck,
  CANARY_THRESHOLD, CANARY_WINDOW_MIN,
} from './errorCanary';

// #210: 5xx-spike canary — counts recent server_error rows in
// api_request_audit and notifies admin roles through deliver(), deduped to at
// most one alert per hour bucket.

test('canaryBucket buckets by UTC hour', () => {
  assert.equal(canaryBucket(new Date('2026-08-02T14:07:33Z')), '2026-08-02T14');
  assert.equal(canaryBucket(new Date('2026-08-02T14:59:59Z')), '2026-08-02T14');
  assert.equal(canaryBucket(new Date('2026-08-02T15:00:00Z')), '2026-08-02T15');
});

test('shouldAlertCanary fires at the threshold, not below', () => {
  assert.equal(shouldAlertCanary(CANARY_THRESHOLD - 1), false);
  assert.equal(shouldAlertCanary(CANARY_THRESHOLD), true);
  assert.equal(shouldAlertCanary(CANARY_THRESHOLD + 10), true);
  assert.equal(shouldAlertCanary(0), false);
});

test('canaryBody names the count and window', () => {
  assert.equal(canaryBody(12, 15), '12 server errors in the last 15 min — check the API logs.');
  assert.equal(canaryBody(1, 15), '1 server error in the last 15 min — check the API logs.');
});

// Fake pg routing the queries runErrorCanaryCheck (and the notifications
// helpers it calls) issue. Same structural-Pg trick as notifications.test.ts.
function fakePg(opts: { errorCount: number; admins?: string[]; alreadyClaimed?: boolean }) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const pg = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      if (sql.includes('api_request_audit')) return { rows: [{ n: opts.errorCount }] };
      if (sql.includes('app_config')) return { rows: [] as any[] };
      if (sql.includes('FROM users WHERE role = ANY')) return { rows: (opts.admins ?? []).map(id => ({ id })) };
      if (sql.includes('id = ANY') && sql.includes('active = TRUE')) {
        return { rows: (params[0] as string[]).map(id => ({ id })) };
      }
      if (sql.includes('notification_dedup')) {
        return { rows: opts.alreadyClaimed ? [] : [{ event_key: params[0] }] };
      }
      return { rows: [] as any[] };
    },
  };
  return { pg, calls };
}

test('below threshold: counts and stops — no recipients, no dedup, no delivery', async () => {
  const { pg, calls } = fakePg({ errorCount: CANARY_THRESHOLD - 1, admins: ['a1'] });
  await runErrorCanaryCheck(pg as any, new Date('2026-08-02T14:07:33Z'));
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /api_request_audit/);
  assert.match(calls[0].sql, /server_error/);
});

test('at threshold: claims the hour bucket and delivers to admin roles', async () => {
  const { pg, calls } = fakePg({ errorCount: 7, admins: ['a1', 'a2'] });
  await runErrorCanaryCheck(pg as any, new Date('2026-08-02T14:07:33Z'));
  const dedup = calls.filter(c => c.sql.includes('notification_dedup') && c.sql.includes('INSERT'));
  assert.equal(dedup.length, 1);
  assert.equal(dedup[0].params[0], 'canary:5xx:2026-08-02T14');
  const inserts = calls.filter(c => c.sql.includes('INSERT INTO notifications'));
  assert.equal(inserts.length, 2);
  assert.deepEqual(inserts.map(c => c.params[1]).sort(), ['a1', 'a2']);
  assert.equal(inserts[0].params[2], 'server_error_spike');
  assert.equal(inserts[0].params[4], canaryBody(7, CANARY_WINDOW_MIN));
});

test('same hour bucket already claimed: no second delivery', async () => {
  const { pg, calls } = fakePg({ errorCount: 9, admins: ['a1'], alreadyClaimed: true });
  await runErrorCanaryCheck(pg as any, new Date('2026-08-02T14:40:00Z'));
  assert.equal(calls.filter(c => c.sql.includes('INSERT INTO notifications')).length, 0);
});

test('no admin recipients: dedup key is not burned', async () => {
  const { pg, calls } = fakePg({ errorCount: 9, admins: [] });
  await runErrorCanaryCheck(pg as any, new Date('2026-08-02T14:40:00Z'));
  assert.equal(calls.filter(c => c.sql.includes('notification_dedup')).length, 0);
  assert.equal(calls.filter(c => c.sql.includes('INSERT INTO notifications')).length, 0);
});
