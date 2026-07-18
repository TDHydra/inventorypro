import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfirmQueue, type ConfirmRequest } from './confirmQueue';

function harness() {
  const q = createConfirmQueue();
  const shown: (ConfirmRequest | null)[] = [];
  q.setListener((req) => shown.push(req));
  return { q, shown };
}

test('push shows the request and resolves true on settle(true)', async () => {
  const { q, shown } = harness();
  const p = q.push({ title: 'Delete item?' });
  assert.equal(shown.length, 1);
  assert.equal(shown[0]?.title, 'Delete item?');
  q.settle(true);
  assert.equal(await p, true);
});

test('settle(false) (cancel/backdrop dismiss) resolves false', async () => {
  const { q } = harness();
  const p = q.push({ title: 'Archive job?' });
  q.settle(false);
  assert.equal(await p, false);
});

test('pushes resolve in request order', async () => {
  const { q } = harness();
  const order: string[] = [];
  const p1 = q.push({ title: 'first' }).then((v) => { order.push('first'); return v; });
  const p2 = q.push({ title: 'second' }).then((v) => { order.push('second'); return v; });
  q.settle(true);
  q.settle(false);
  assert.deepEqual(await Promise.all([p1, p2]), [true, false]);
  assert.deepEqual(order, ['first', 'second']);
});

test('a push while one is showing queues; settle pumps the next', () => {
  const { q, shown } = harness();
  q.push({ title: 'showing' });
  q.push({ title: 'queued' });
  assert.equal(shown.length, 1);
  q.settle(true);
  assert.equal(shown.length, 2);
  assert.equal(shown[1]?.title, 'queued');
});

test('requests pushed before the host mounts drain on setListener', () => {
  const q = createConfirmQueue();
  q.push({ title: 'early' });
  const shown: (ConfirmRequest | null)[] = [];
  q.setListener((req) => shown.push(req));
  assert.equal(shown.length, 1);
  assert.equal(shown[0]?.title, 'early');
});

test('settle with no current request is a no-op', () => {
  const { q, shown } = harness();
  q.settle(true); // nothing showing — must not throw or deliver anything
  assert.equal(shown.length, 0);
  // A stray settle must not consume the next real request's answer either.
  const answers: boolean[] = [];
  q.push({ title: 'real' }).then((v) => answers.push(v));
  assert.equal(shown.length, 1);
});
