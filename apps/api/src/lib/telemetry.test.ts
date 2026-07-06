import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeEvent, sanitizeLabel, ingestEvents, getTelemetrySummary } from './telemetry';

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

test('getTelemetrySummary shapes the report + binds the day window', async () => {
  const seenParams: unknown[][] = [];
  const pg = { query: async (sql: string, params: unknown[]) => {
    seenParams.push(params);
    if (sql.includes('FILTER (WHERE type')) return { rows: [{ events: 100, sessions: 12, users: 8, devices: 9, errors: 3 }] };
    if (sql.includes("type = 'screen'")) return { rows: [{ name: 'inventory', count: 40 }, { name: 'hub', count: 25 }] };
    if (sql.includes("type = 'action'")) return { rows: [{ name: 'checkout_confirm', count: 15 }] };
    if (sql.includes("type = 'error'")) return { rows: [{ name: 'render_crash', count: 2 }] };
    if (sql.includes('GROUP BY platform')) return { rows: [{ platform: 'android', count: 90 }] };
    if (sql.includes('GROUP BY app_version')) return { rows: [{ version: '1.0.0', count: 100 }] };
    return { rows: [] };
  } };
  const s = await getTelemetrySummary(pg as any, 30);
  assert.equal(s.windowDays, 30);
  assert.deepEqual(s.totals, { events: 100, sessions: 12, users: 8, devices: 9, errors: 3 });
  assert.equal(s.topScreens[0].name, 'inventory');
  assert.equal(s.topActions[0].name, 'checkout_confirm');
  assert.equal(s.byPlatform[0].platform, 'android');
  // every query is parameterized on the day window (never string-interpolated)
  assert.ok(seenParams.every(p => p[0] === 30));
});
