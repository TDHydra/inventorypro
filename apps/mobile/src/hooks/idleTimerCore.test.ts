import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createIdleTimer } from './idleTimerCore';

const MIN = 60_000;

beforeEach(() => {
  mock.timers.enable({ apis: ['setTimeout'] });
});
afterEach(() => {
  mock.timers.reset();
});

function counters() {
  let timeouts = 0;
  let warns = 0;
  return {
    onTimeout: () => { timeouts++; },
    onWarn: () => { warns++; },
    get timeouts() { return timeouts; },
    get warns() { return warns; },
  };
}

test('fires onTimeout after getMinutes() minutes of no reset', () => {
  const c = counters();
  const t = createIdleTimer({ getMinutes: () => 15, onTimeout: c.onTimeout });
  t.arm();
  mock.timers.tick(15 * MIN - 1);
  assert.equal(c.timeouts, 0);
  mock.timers.tick(1);
  assert.equal(c.timeouts, 1);
});

test('fires onWarn 60s before onTimeout', () => {
  const c = counters();
  const t = createIdleTimer({ getMinutes: () => 15, onTimeout: c.onTimeout, onWarn: c.onWarn });
  t.arm();
  mock.timers.tick(14 * MIN - 1);
  assert.equal(c.warns, 0);
  mock.timers.tick(1);
  assert.equal(c.warns, 1);
  assert.equal(c.timeouts, 0);
  mock.timers.tick(MIN);
  assert.equal(c.timeouts, 1);
});

test('skips onWarn when the timeout is 90s or shorter', () => {
  const c = counters();
  const t = createIdleTimer({ getMinutes: () => 1.5, onTimeout: c.onTimeout, onWarn: c.onWarn });
  t.arm();
  mock.timers.tick(1.5 * MIN);
  assert.equal(c.warns, 0);
  assert.equal(c.timeouts, 1);
});

test('re-arm restarts both timers (no warn/timeout from the old arm)', () => {
  const c = counters();
  const t = createIdleTimer({ getMinutes: () => 15, onTimeout: c.onTimeout, onWarn: c.onWarn });
  t.arm();
  mock.timers.tick(14 * MIN - 1); // just before the first warn
  t.arm();
  mock.timers.tick(14 * MIN - 1); // just before the re-armed warn
  assert.equal(c.warns, 0);
  assert.equal(c.timeouts, 0);
  mock.timers.tick(1);
  assert.equal(c.warns, 1);
  mock.timers.tick(MIN);
  assert.equal(c.timeouts, 1);
});

test('disabled when getMinutes() <= 0', () => {
  const c = counters();
  const t = createIdleTimer({ getMinutes: () => 0, onTimeout: c.onTimeout, onWarn: c.onWarn });
  t.arm();
  mock.timers.tick(24 * 60 * MIN);
  assert.equal(c.timeouts, 0);
  assert.equal(c.warns, 0);
});

test('overrideMinutes wins over getMinutes, even when the setting disables idle logout', () => {
  const c = counters();
  const t = createIdleTimer({ getMinutes: () => 0, overrideMinutes: 15, onTimeout: c.onTimeout });
  t.arm();
  mock.timers.tick(15 * MIN);
  assert.equal(c.timeouts, 1);
});

test('overrideMinutes wins over a longer configured timeout', () => {
  const c = counters();
  const t = createIdleTimer({ getMinutes: () => 60, overrideMinutes: 15, onTimeout: c.onTimeout });
  t.arm();
  mock.timers.tick(15 * MIN);
  assert.equal(c.timeouts, 1);
});

test('getMinutes is re-read on every arm (setting changes take effect on next reset)', () => {
  const c = counters();
  let mins = 15;
  const t = createIdleTimer({ getMinutes: () => mins, onTimeout: c.onTimeout });
  t.arm();
  mins = 2;
  t.arm();
  mock.timers.tick(2 * MIN);
  assert.equal(c.timeouts, 1);
});

test('dispose cancels pending timers', () => {
  const c = counters();
  const t = createIdleTimer({ getMinutes: () => 15, onTimeout: c.onTimeout, onWarn: c.onWarn });
  t.arm();
  t.dispose();
  mock.timers.tick(20 * MIN);
  assert.equal(c.timeouts, 0);
  assert.equal(c.warns, 0);
});

test('timeout fires only once per arm', () => {
  const c = counters();
  const t = createIdleTimer({ getMinutes: () => 15, onTimeout: c.onTimeout });
  t.arm();
  mock.timers.tick(45 * MIN);
  assert.equal(c.timeouts, 1);
});
