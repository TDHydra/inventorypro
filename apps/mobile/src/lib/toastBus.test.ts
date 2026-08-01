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
