import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createToastBus, type ToastRequest } from './toastBus';

function harness() {
  const bus = createToastBus();
  const delivered: (ToastRequest | null)[] = [];
  bus.setListener((req) => delivered.push(req));
  return { bus, delivered };
}

test('push delivers a toast with a stable, unique id', () => {
  const { bus, delivered } = harness();
  bus.push({ message: 'Requires Manage Teams' });
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0]?.message, 'Requires Manage Teams');
  assert.equal(typeof delivered[0]?.id, 'number');
});

test('a second push while one is showing queues until dismissed', () => {
  const { bus, delivered } = harness();
  bus.push({ message: 'first' });
  bus.push({ message: 'second' });
  assert.equal(delivered.length, 1);
  bus.notifyDismissed();
  assert.equal(delivered.length, 2);
  assert.equal(delivered[1]?.message, 'second');
});

test('toasts raised before the host mounts drain on setListener', () => {
  const bus = createToastBus();
  bus.push({ message: 'early' });
  const delivered: (ToastRequest | null)[] = [];
  bus.setListener((req) => delivered.push(req));
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0]?.message, 'early');
});

test('notifyDismissed with nothing showing is a no-op', () => {
  const { bus, delivered } = harness();
  bus.notifyDismissed();
  assert.equal(delivered.length, 0);
});

test('an optional durationMs rides along on the request', () => {
  const { bus, delivered } = harness();
  bus.push({ message: 'quick', durationMs: 1500 });
  assert.equal(delivered[0]?.durationMs, 1500);
});

test('an optional action (label + onPress) rides along on the request (#203)', () => {
  const { bus, delivered } = harness();
  const onPress = () => {};
  bus.push({ message: 'Requires Manage Teams', action: { label: 'Request access', onPress } });
  assert.equal(delivered[0]?.action?.label, 'Request access');
  assert.equal(delivered[0]?.action?.onPress, onPress);
});

test('a push with no action leaves it undefined, not a stale value from a prior toast', () => {
  const { bus, delivered } = harness();
  bus.push({ message: 'first', action: { label: 'Undo', onPress: () => {} } });
  bus.notifyDismissed();
  bus.push({ message: 'second' });
  assert.equal(delivered[1]?.action, undefined);
});
