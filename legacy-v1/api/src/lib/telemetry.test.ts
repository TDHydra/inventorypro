import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeEvent, sanitizeLabel, ingestEvents, getTelemetrySummary,
  zeroFillDailyTrend, shapeTelemetrySummary,
} from './telemetry';

const CTRL0 = String.fromCharCode(0);   // NUL
const CTRL31 = String.fromCharCode(31);  // unit separator

test('drops event with unknown type', () => {
  assert.equal(sanitizeEvent({ type: 'evil', name: 'x' }), null);
});
test('keeps only allowlisted prop keys, drops PII-ish keys', () => {
  const e = sanitizeEvent({ type: 'action', name: 'tap', screen: 'inventory',
    props: { itemId: 'i1', durationMs: 12, pin: '1234', customerName: 'Bob' } });
  assert.deepEqual(Object.keys(e!.props).sort(), ['durationMs', 'itemId']);
});
test('truncates over-long name', () => {
  const e = sanitizeEvent({ type: 'screen', name: 'x'.repeat(500) });
  assert.ok(e!.name.length <= 200);
});
test('sanitizeLabel strips control chars + collapses whitespace + caps length', () => {
  assert.equal(sanitizeLabel('a' + CTRL0 + 'b' + CTRL31 + 'c'), 'abc');
  assert.equal(sanitizeLabel('foo   bar\t baz'), 'foo bar baz');
  assert.equal(sanitizeLabel('y'.repeat(500)).length, 120);
});
test('sanitizeEvent cleans name + screen (not just props)', () => {
  const e = sanitizeEvent({ type: 'screen', name: '  home' + CTRL0 + '  ', screen: 'a' + CTRL31 + 'b' });
  assert.equal(e!.name, 'home');
  assert.equal(e!.screen, 'ab');
});
test('sanitizeEvent drops events missing/empty name or bad props', () => {
  assert.equal(sanitizeEvent({ type: 'action' }), null);          // no name
  assert.equal(sanitizeEvent({ type: 'action', name: '' }), null); // empty name
  assert.equal(sanitizeEvent(null), null);
  // non-object props are ignored, event still valid with empty props
  const e = sanitizeEvent({ type: 'audit', name: 'x', props: 'nope' });
  assert.deepEqual(e!.props, {});
});

const ctx = { sessionId: 's', userId: null, deviceId: null, platform: null, appVersion: null };

test('ingestEvents inserts only the sanitized survivors + returns accepted count', async () => {
  const inserts: unknown[][] = [];
  const pg = { query: async (_sql: string, params: unknown[]) => { inserts.push(params); return { rows: [] }; } };
  const accepted = await ingestEvents(pg as any, [
    { type: 'action', name: 'tap' },       // ok
    { type: 'evil', name: 'x' },            // bad type → skipped
    { type: 'screen', name: '' },           // empty name → skipped
    { type: 'audit', name: 'save' },        // ok
  ], ctx);
  assert.equal(accepted, 2);
  assert.equal(inserts.length, 2);
  assert.deepEqual(inserts.map(p => p[6]), ['tap', 'save']); // names in insert order
});

test('ingestEvents never aborts the batch when one INSERT throws', async () => {
  let n = 0;
  const pg = { query: async () => { n++; if (n === 1) throw new Error('boom'); return { rows: [] }; } };
  const accepted = await ingestEvents(pg as any, [
    { type: 'action', name: 'a' }, // INSERT throws → not counted
    { type: 'action', name: 'b' }, // INSERT ok
  ], ctx);
  assert.equal(accepted, 1);
});

// ── #243: outbox_heartbeat → stuck-outbox server nudge ──────────────────────
//
// notifySyncStuck (lib/notifications.ts) is exercised in full elsewhere
// (notifications.test.ts); these tests only prove ingestEvents' HOOK fires
// under the right conditions, by asserting on the notification_dedup claim
// query it triggers (its first DB call) — a query that fires only if
// notifySyncStuck actually ran with failed>0.
function pgRecording() {
  const calls: { sql: string; params: unknown[] }[] = [];
  const pg = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      if (sql.includes('INSERT INTO telemetry_events')) return { rows: [] };
      if (sql.includes('INSERT INTO notification_dedup')) return { rows: [{ event_key: params[0] }] }; // fresh claim
      if (sql.includes('id = ANY') && sql.includes('active = TRUE')) {
        return { rows: (params[0] as string[]).map(id => ({ id })) };
      }
      return { rows: [] };
    },
  };
  return { pg, calls };
}

test('ingestEvents: outbox_heartbeat with failed>0 + authenticated user triggers exactly one notify claim', async () => {
  const { pg, calls } = pgRecording();
  const authedCtx = { ...ctx, userId: 'u1' };
  await ingestEvents(pg as any, [
    { type: 'audit', name: 'outbox_heartbeat', props: { pending: 2, failed: 3, denied: 0 } },
  ], authedCtx);
  // notifySyncStuck runs fire-and-forget (void .catch) — give its microtasks a tick.
  await new Promise(r => setTimeout(r, 0));
  const claims = calls.filter(c => c.sql.includes('INSERT INTO notification_dedup'));
  assert.equal(claims.length, 1);
  assert.equal(claims[0].params[0], 'sync_stuck:user:u1');
});

test('ingestEvents: outbox_heartbeat with failed=0 does not claim/notify', async () => {
  const { pg, calls } = pgRecording();
  const authedCtx = { ...ctx, userId: 'u1' };
  await ingestEvents(pg as any, [
    { type: 'audit', name: 'outbox_heartbeat', props: { pending: 1, failed: 0, denied: 0 } },
  ], authedCtx);
  await new Promise(r => setTimeout(r, 0));
  assert.equal(calls.filter(c => c.sql.includes('INSERT INTO notification_dedup')).length, 0);
});

test('ingestEvents: outbox_heartbeat with no authenticated user never triggers a notify claim', async () => {
  const { pg, calls } = pgRecording();
  await ingestEvents(pg as any, [
    { type: 'audit', name: 'outbox_heartbeat', props: { pending: 1, failed: 5, denied: 0 } },
  ], ctx); // ctx.userId is null
  await new Promise(r => setTimeout(r, 0));
  assert.equal(calls.filter(c => c.sql.includes('INSERT INTO notification_dedup')).length, 0);
});

test('ingestEvents: two consecutive failed>0 heartbeats in the same episode claim only once', async () => {
  const claimed = new Set<string>();
  const calls: { sql: string; params: unknown[] }[] = [];
  const pg = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      if (sql.includes('INSERT INTO telemetry_events')) return { rows: [] };
      if (sql.includes('INSERT INTO notification_dedup')) {
        const key = params[0] as string;
        if (claimed.has(key)) return { rows: [] };
        claimed.add(key);
        return { rows: [{ event_key: key }] };
      }
      if (sql.includes('id = ANY') && sql.includes('active = TRUE')) {
        return { rows: (params[0] as string[]).map(id => ({ id })) };
      }
      return { rows: [] };
    },
  };
  const authedCtx = { ...ctx, userId: 'u1' };
  await ingestEvents(pg as any, [{ type: 'audit', name: 'outbox_heartbeat', props: { pending: 0, failed: 2, denied: 0 } }], authedCtx);
  await new Promise(r => setTimeout(r, 0));
  await ingestEvents(pg as any, [{ type: 'audit', name: 'outbox_heartbeat', props: { pending: 0, failed: 2, denied: 0 } }], authedCtx);
  await new Promise(r => setTimeout(r, 0));
  const inboxInserts = calls.filter(c => c.sql.includes('INSERT INTO notifications'));
  assert.equal(inboxInserts.length, 1); // second heartbeat's claim is suppressed → no second notify
});

// The full aggregate now comes back as a SINGLE row (one CTE round-trip): each
// list is a json_agg column and the mock stands in for what pg/json_agg returns.
const SUMMARY_ROW = {
  totals: { events: 100, sessions: 12, users: 8, devices: 9, errors: 3, anon_sessions: 4 },
  screens: [{ name: 'inventory', count: 40 }, { name: 'hub', count: 25 }],
  actions: [{ name: 'checkout_confirm', count: 15 }],
  errors: [{ name: 'render_crash', count: 2 }],
  err_trend: [{ day: '2026-07-04', count: 2 }, { day: '2026-07-06', count: 1 }],
  by_user: [{ userId: 'u1', name: 'Alice', role: 'full_admin', count: 30 }],
  by_role: [{ name: 'full_admin', count: 30 }, { name: 'contents_crew', count: 12 }],
  by_team: [{ name: 'North Crew', count: 22 }],
  platforms: [{ platform: 'android', count: 90 }],
  versions: [{ version: '1.0.0', count: 100 }],
};

test('getTelemetrySummary runs ONE query, binds the day window, shapes the report', async () => {
  const seen: { sql: string; params: unknown[] }[] = [];
  const pg = { query: async (sql: string, params: unknown[]) => {
    seen.push({ sql, params });
    return { rows: [SUMMARY_ROW] };
  } };
  const s = await getTelemetrySummary(pg as any, 30);
  assert.equal(seen.length, 1);                       // single round-trip
  assert.equal(seen[0].params[0], 30);                // parameterized window ($1)
  assert.ok(seen[0].sql.includes('make_interval'));   // never string-interpolated
  assert.equal(s.windowDays, 30);
  assert.deepEqual(s.totals, { events: 100, sessions: 12, users: 8, devices: 9, errors: 3 });
  assert.deepEqual(s.active, { users: 8, devices: 9, sessions: 12, anonSessions: 4 });
  assert.equal(s.topScreens[0].name, 'inventory');
  assert.equal(s.topActions[0].name, 'checkout_confirm');
  assert.equal(s.byUser[0].name, 'Alice');
  assert.equal(s.byRole[0].name, 'full_admin');
  assert.equal(s.byTeam[0].name, 'North Crew');
  assert.equal(s.byPlatform[0].platform, 'android');
  assert.equal(s.errorTrend.length, 30);              // zero-filled to the window
});

test('shapeTelemetrySummary defaults everything on an empty window (no throws, no NaN)', () => {
  // json_agg over an empty set is NULL; totals CTE still returns a row of zeros.
  const empty = { totals: { events: 0, sessions: 0, users: 0, devices: 0, errors: 0, anon_sessions: 0 } };
  const s = shapeTelemetrySummary(empty, 7, new Date('2026-07-06T12:00:00Z'));
  assert.deepEqual(s.totals, { events: 0, sessions: 0, users: 0, devices: 0, errors: 0 });
  assert.deepEqual(s.active, { users: 0, devices: 0, sessions: 0, anonSessions: 0 });
  for (const list of [s.topScreens, s.topActions, s.topErrors, s.byUser, s.byRole, s.byTeam, s.byPlatform, s.byVersion]) {
    assert.deepEqual(list, []);
  }
  assert.equal(s.errorTrend.length, 7);
  assert.ok(s.errorTrend.every(d => d.count === 0));
});

test('shapeTelemetrySummary tolerates a totally empty/undefined row', () => {
  const s = shapeTelemetrySummary({}, 1, new Date('2026-07-06T12:00:00Z'));
  assert.equal(s.totals.events, 0);
  assert.equal(s.errorTrend.length, 1);
  assert.deepEqual(s.byUser, []);
});

test('zeroFillDailyTrend produces N consecutive UTC-day buckets ending today', () => {
  const now = new Date('2026-07-06T09:30:00Z');
  const out = zeroFillDailyTrend([{ day: '2026-07-04', count: 2 }, { day: '2026-07-06', count: 5 }], 3, now);
  assert.deepEqual(out, [
    { day: '2026-07-04', count: 2 },
    { day: '2026-07-05', count: 0 },   // gap zero-filled
    { day: '2026-07-06', count: 5 },
  ]);
});

test('zeroFillDailyTrend guards empty/undefined input and merges duplicate days', () => {
  const now = new Date('2026-07-06T00:00:00Z');
  assert.deepEqual(zeroFillDailyTrend(undefined, 2, now), [
    { day: '2026-07-05', count: 0 }, { day: '2026-07-06', count: 0 },
  ]);
  // duplicate day keys sum; days out of the window are ignored, not thrown on
  const merged = zeroFillDailyTrend(
    [{ day: '2026-07-06', count: 1 }, { day: '2026-07-06', count: 4 }, { day: '2026-01-01', count: 9 }], 1, now);
  assert.deepEqual(merged, [{ day: '2026-07-06', count: 5 }]);
});
