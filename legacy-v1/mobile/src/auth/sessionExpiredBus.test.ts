import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  setSessionExpiredHandler,
  noteSessionExpired,
  resetSessionExpiredNotice,
  resetSessionExpiredBusForTest,
} from './sessionExpiredBus';

beforeEach(() => resetSessionExpiredBusForTest());

test('noteSessionExpired runs the registered handler', () => {
  let calls = 0;
  setSessionExpiredHandler(() => { calls += 1; });
  noteSessionExpired();
  assert.equal(calls, 1);
});

test('fires at most once until re-armed (push + pull 401 in one cycle → one logout)', () => {
  let calls = 0;
  setSessionExpiredHandler(() => { calls += 1; });
  noteSessionExpired();
  noteSessionExpired();
  assert.equal(calls, 1);
  resetSessionExpiredNotice();
  noteSessionExpired();
  assert.equal(calls, 2);
});

test('no handler registered → a no-op, but still consumes the once-guard', () => {
  noteSessionExpired(); // must not throw
  let calls = 0;
  setSessionExpiredHandler(() => { calls += 1; });
  noteSessionExpired();
  assert.equal(calls, 0); // already fired this session; stays quiet until re-armed
  resetSessionExpiredNotice();
  noteSessionExpired();
  assert.equal(calls, 1);
});

test('clearing the handler with null stops delivery', () => {
  let calls = 0;
  setSessionExpiredHandler(() => { calls += 1; });
  setSessionExpiredHandler(null);
  noteSessionExpired();
  assert.equal(calls, 0);
});
