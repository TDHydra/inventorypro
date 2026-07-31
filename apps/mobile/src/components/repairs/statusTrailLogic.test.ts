import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStatusTrail, visitedStatusLabels } from './statusTrailLogic';

const STATUSES = [
  { id: 'st-open', label: 'Open' },
  { id: 'st-parts', label: 'Awaiting Parts' },
  { id: 'st-progress', label: 'In Progress' },
  { id: 'st-done', label: 'Repaired' },
];

test('buildStatusTrail: no log rows → only the current status is toned, everything else neutral', () => {
  const trail = buildStatusTrail(STATUSES, [], 'st-open');
  assert.deepEqual(trail.map(t => t.tone), ['primary', 'neutral', 'neutral', 'neutral']);
});

test('buildStatusTrail: visited statuses (from activity_log) tone success, current tones primary', () => {
  const logRows = [
    { action: 'repair_status_changed', note: 'Status → Awaiting Parts' },
    { action: 'repair_status_changed', note: 'Status → In Progress' },
  ];
  const trail = buildStatusTrail(STATUSES, logRows, 'st-progress');
  assert.deepEqual(trail.map(t => t.tone), ['neutral', 'success', 'primary', 'neutral']);
});

test('buildStatusTrail: current status wins over visited (a reopened/revisited status stays primary, not success)', () => {
  const logRows = [
    { action: 'repair_status_changed', note: 'Status → In Progress' },
    { action: 'repair_completed', note: 'Status → Repaired' },
    { action: 'repair_status_changed', note: 'Status → In Progress' }, // reopened
  ];
  const trail = buildStatusTrail(STATUSES, logRows, 'st-progress');
  assert.deepEqual(trail.map(t => t.tone), ['neutral', 'neutral', 'primary', 'success']);
});

test('buildStatusTrail: a skipped status (Open → Repaired) is never falsely marked visited', () => {
  const logRows = [{ action: 'repair_completed', note: 'Status → Repaired' }];
  const trail = buildStatusTrail(STATUSES, logRows, 'st-done');
  assert.deepEqual(trail.map(t => t.tone), ['neutral', 'neutral', 'neutral', 'primary']);
});

test('buildStatusTrail: null currentStatusId (unresolved status_id) never crashes, no status is primary', () => {
  const logRows = [{ action: 'repair_status_changed', note: 'Status → Open' }];
  const trail = buildStatusTrail(STATUSES, logRows, null);
  assert.deepEqual(trail.map(t => t.tone), ['success', 'neutral', 'neutral', 'neutral']);
});

test('visitedStatusLabels: ignores unrelated actions and notes without the Status → prefix', () => {
  const logRows = [
    { action: 'repair_updated', note: 'Status → Open' }, // wrong action
    { action: 'repair_status_changed', note: 'Notes updated' }, // wrong note shape
    { action: 'repair_status_changed', note: null },
  ];
  assert.deepEqual([...visitedStatusLabels(logRows)], []);
});

test('visitedStatusLabels: dedupes repeated visits to the same label', () => {
  const logRows = [
    { action: 'repair_status_changed', note: 'Status → In Progress' },
    { action: 'repair_status_changed', note: 'Status → Open' },
    { action: 'repair_status_changed', note: 'Status → In Progress' },
  ];
  assert.deepEqual([...visitedStatusLabels(logRows)].sort(), ['In Progress', 'Open']);
});
