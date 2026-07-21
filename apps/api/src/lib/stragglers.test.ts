import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compareVersions, reduceDeviceRows, markBehind, sortStragglers,
  toReportRows, formatTable, summaryLine, type RawDeviceEvent,
} from './stragglers';

// ── compareVersions ─────────────────────────────────────────────────────────

test('compareVersions orders by major/minor/patch', () => {
  assert.ok(compareVersions('1.2.3', '1.2.4') < 0);
  assert.ok(compareVersions('1.3.0', '1.2.9') > 0);
  assert.ok(compareVersions('2.0.0', '1.9.9') > 0);
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
});

test('compareVersions treats missing/non-numeric segments as 0', () => {
  assert.equal(compareVersions('1.2', '1.2.0'), 0);
  assert.ok(compareVersions('1.2.1', '1.2') > 0);
});

// ── reduceDeviceRows ─────────────────────────────────────────────────────────

test('reduceDeviceRows picks the latest non-null version per device', () => {
  const rows: RawDeviceEvent[] = [
    { deviceId: 'd1', userId: 'u1', appVersion: '1.2.0', ts: '2026-07-01T00:00:00.000Z' },
    { deviceId: 'd1', userId: 'u1', appVersion: '1.3.0', ts: '2026-07-10T00:00:00.000Z' },
    { deviceId: 'd1', userId: 'u1', appVersion: null, ts: '2026-07-15T00:00:00.000Z' },
  ];
  const [d1] = reduceDeviceRows(rows);
  assert.equal(d1.latestVersion, '1.3.0');            // most recent VERSIONED sighting
  assert.equal(d1.lastSeen, '2026-07-15T00:00:00.000Z'); // overall last-seen, even sans version
});

test('reduceDeviceRows merges telemetry-only and audit-only sightings of the same device', () => {
  // Simulates the union: one row came from telemetry_events, the other from
  // api_request_audit — the reduction doesn't care about provenance.
  const rows: RawDeviceEvent[] = [
    { deviceId: 'd1', userId: 'u1', appVersion: '1.2.0', ts: '2026-07-01T00:00:00.000Z' },
    { deviceId: 'd1', userId: 'u2', appVersion: '1.3.0', ts: '2026-07-05T00:00:00.000Z' },
  ];
  const [d1] = reduceDeviceRows(rows);
  assert.equal(d1.latestVersion, '1.3.0');
  assert.deepEqual(d1.userIds, ['u1', 'u2']);
});

test('reduceDeviceRows handles a device with telemetry rows but no audit rows, and vice versa', () => {
  const rows: RawDeviceEvent[] = [
    { deviceId: 'telemetry-only', userId: 'u1', appVersion: '1.0.0', ts: '2026-07-01T00:00:00.000Z' },
    { deviceId: 'audit-only', userId: 'u2', appVersion: '1.1.0', ts: '2026-07-02T00:00:00.000Z' },
  ];
  const out = reduceDeviceRows(rows);
  assert.equal(out.length, 2);
  assert.ok(out.some(d => d.deviceId === 'telemetry-only' && d.latestVersion === '1.0.0'));
  assert.ok(out.some(d => d.deviceId === 'audit-only' && d.latestVersion === '1.1.0'));
});

test('reduceDeviceRows reports "unknown" for a device that never sent a version', () => {
  const rows: RawDeviceEvent[] = [
    { deviceId: 'no-version', userId: null, appVersion: null, ts: '2026-07-01T00:00:00.000Z' },
  ];
  const [d] = reduceDeviceRows(rows);
  assert.equal(d.latestVersion, 'unknown');
  assert.deepEqual(d.userIds, []);
});

test('reduceDeviceRows skips rows with no device_id', () => {
  const rows = [{ deviceId: '', userId: 'u1', appVersion: '1.0.0', ts: '2026-07-01T00:00:00.000Z' }] as RawDeviceEvent[];
  assert.deepEqual(reduceDeviceRows(rows), []);
});

// ── markBehind ───────────────────────────────────────────────────────────────

test('markBehind flags versions older than current, and unknown as always behind', () => {
  const devices = reduceDeviceRows([
    { deviceId: 'old', userId: null, appVersion: '1.2.0', ts: '2026-07-01T00:00:00.000Z' },
    { deviceId: 'current', userId: null, appVersion: '1.3.5', ts: '2026-07-01T00:00:00.000Z' },
    { deviceId: 'newer', userId: null, appVersion: '1.4.0', ts: '2026-07-01T00:00:00.000Z' },
    { deviceId: 'blank', userId: null, appVersion: null, ts: '2026-07-01T00:00:00.000Z' },
  ]);
  const marked = markBehind(devices, '1.3.5');
  const byId = Object.fromEntries(marked.map(d => [d.deviceId, d.behind]));
  assert.equal(byId.old, true);
  assert.equal(byId.current, false);
  assert.equal(byId.newer, false);
  assert.equal(byId.blank, true);
});

// ── sortStragglers ───────────────────────────────────────────────────────────

test('sortStragglers floats behind devices to the top, unknown first among them', () => {
  const devices = markBehind(reduceDeviceRows([
    { deviceId: 'current', userId: null, appVersion: '1.3.5', ts: '2026-07-10T00:00:00.000Z' },
    { deviceId: 'old', userId: null, appVersion: '1.2.0', ts: '2026-07-05T00:00:00.000Z' },
    { deviceId: 'blank', userId: null, appVersion: null, ts: '2026-07-01T00:00:00.000Z' },
    { deviceId: 'older', userId: null, appVersion: '1.0.0', ts: '2026-07-06T00:00:00.000Z' },
  ]), '1.3.5');
  const sorted = sortStragglers(devices);
  assert.deepEqual(sorted.map(d => d.deviceId), ['blank', 'older', 'old', 'current']);
});

// ── toReportRows / formatTable / summaryLine ─────────────────────────────────

test('toReportRows resolves users via the display callback and marks status', () => {
  const devices = markBehind(reduceDeviceRows([
    { deviceId: 'd1', userId: 'u1', appVersion: '1.0.0', ts: '2026-07-01T00:00:00.000Z' },
  ]), '1.3.5');
  const [row] = toReportRows(devices, id => `Name-${id}`);
  assert.equal(row.status, 'BEHIND');
  assert.equal(row.users, 'Name-u1');
});

test('toReportRows shows an em-dash for devices with no attributed users', () => {
  const devices = markBehind(reduceDeviceRows([
    { deviceId: 'd1', userId: null, appVersion: '1.3.5', ts: '2026-07-01T00:00:00.000Z' },
  ]), '1.3.5');
  const [row] = toReportRows(devices, id => id);
  assert.equal(row.status, 'CURRENT');
  assert.equal(row.users, '—');
});

test('formatTable pads columns and includes a header + separator row', () => {
  const table = formatTable([
    { deviceId: 'short', version: '1.0.0', status: 'BEHIND', lastSeen: '2026-07-01T00:00:00.000Z', users: 'Bob' },
    { deviceId: 'a-much-longer-device-id', version: '1.3.5', status: 'CURRENT', lastSeen: '2026-07-10T00:00:00.000Z', users: 'Alice, Carl' },
  ]);
  const lines = table.split('\n');
  assert.equal(lines.length, 4); // header + separator + 2 rows
  assert.ok(lines[0].startsWith('DEVICE ID'));
  // every row must be padded to the same width as the widest device id column
  const deviceColWidth = lines[0].indexOf('VERSION') ;
  assert.ok(lines[2].indexOf('1.0.0') >= 0);
  assert.equal(lines.every(l => l.length >= deviceColWidth), true);
});

test('summaryLine counts behind vs total, singular/plural', () => {
  const devices = markBehind(reduceDeviceRows([
    { deviceId: 'd1', userId: null, appVersion: '1.0.0', ts: '2026-07-01T00:00:00.000Z' },
    { deviceId: 'd2', userId: null, appVersion: '1.3.5', ts: '2026-07-01T00:00:00.000Z' },
  ]), '1.3.5');
  assert.equal(summaryLine(devices), '1 of 2 devices behind');
  assert.equal(summaryLine([devices[0]]), '1 of 1 device behind');
});
