import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSyncStuckAlert, SYNC_STUCK_KEY } from './syncStuckAlert';

// #205: decision logic for the "changes couldn't sync" self-notification.
// Framework-free (no expo/db imports) so it runs under plain node:test, same
// precedent as toastBus.ts / confirmQueue.ts.

test('notifies once when failures appear and nothing was notified yet', () => {
  const d = evaluateSyncStuckAlert(3, false);
  assert.equal(d.action, 'notify');
  assert.equal(d.body, "3 changes couldn't sync — tap to review and retry");
});

test('uses singular wording for one stuck change', () => {
  const d = evaluateSyncStuckAlert(1, false);
  assert.equal(d.action, 'notify');
  assert.equal(d.body, "1 change couldn't sync — tap to review and retry");
});

test('stays quiet while the alert is already outstanding', () => {
  assert.equal(evaluateSyncStuckAlert(3, true).action, 'none');
});

test('clears the dedup key once every failure recovered, so it can re-fire later', () => {
  assert.equal(evaluateSyncStuckAlert(0, true).action, 'clear');
});

test('does nothing when there are no failures and no outstanding alert', () => {
  assert.equal(evaluateSyncStuckAlert(0, false).action, 'none');
});

test('exports the app_settings dedup key used by the localAlerts twins', () => {
  assert.equal(SYNC_STUCK_KEY, 'alert:sync_stuck');
});
