import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAlertBus, type AlertRequest } from './alertBus';

function harness() {
  const bus = createAlertBus();
  const delivered: (AlertRequest | null)[] = [];
  bus.setListener((req) => delivered.push(req));
  return { bus, delivered };
}

test('alert delivers to the listener with a normalized OK button', () => {
  const { bus, delivered } = harness();
  bus.alert({ title: 'Hi' });
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0]?.title, 'Hi');
  assert.deepEqual(delivered[0]?.buttons, [{ text: 'OK', style: 'default' }]);
});

test('second alert queues until the first is dismissed', () => {
  const { bus, delivered } = harness();
  bus.alert({ title: 'first' });
  bus.alert({ title: 'second' });
  assert.equal(delivered.length, 1);
  bus.notifyDismissed();
  assert.equal(delivered.length, 2);
  assert.equal(delivered[1]?.title, 'second');
});

test('alerts raised before the listener mounts are drained on setListener', () => {
  const bus = createAlertBus();
  bus.alert({ title: 'early' });
  const delivered: (AlertRequest | null)[] = [];
  bus.setListener((req) => delivered.push(req));
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0]?.title, 'early');
});

test('dismissActive dismisses the showing alert when the tag matches', () => {
  const { bus, delivered } = harness();
  bus.alert({ title: 'nudge', tag: 'idle-nudge' });
  const dismissed = bus.dismissActive('idle-nudge');
  assert.equal(dismissed, true);
  assert.equal(delivered.at(-1), null);
});

test('dismissActive is a no-op when the tag does not match', () => {
  const { bus, delivered } = harness();
  bus.alert({ title: 'important', tag: 'other' });
  const dismissed = bus.dismissActive('idle-nudge');
  assert.equal(dismissed, false);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0]?.title, 'important');
});

test('dismissActive is a no-op on an untagged alert', () => {
  const { bus, delivered } = harness();
  bus.alert({ title: 'plain' });
  assert.equal(bus.dismissActive('idle-nudge'), false);
  assert.equal(delivered.length, 1);
});

test('dismissActive pumps the next queued alert', () => {
  const { bus, delivered } = harness();
  bus.alert({ title: 'nudge', tag: 'idle-nudge' });
  bus.alert({ title: 'next' });
  bus.dismissActive('idle-nudge');
  assert.equal(delivered.at(-1)?.title, 'next');
});

test('dismissActive when nothing is showing returns false', () => {
  const { bus } = harness();
  assert.equal(bus.dismissActive('idle-nudge'), false);
});

test('re-raising the same tag while it is already showing does not stack duplicates', () => {
  const { bus, delivered } = harness();
  bus.alert({ title: 'nudge', tag: 'idle-nudge' });
  bus.alert({ title: 'nudge', tag: 'idle-nudge' });
  bus.notifyDismissed();
  assert.equal(delivered.length, 1);
});
