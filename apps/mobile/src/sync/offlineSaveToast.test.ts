import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOfflineSaveToaster } from './offlineSaveToast';

// #218: "Saved — will sync" confirmation for offline writes. Framework-free
// factory (toastBus/confirmQueue precedent): fed committed outbox-append
// notifications, decides when a toast is warranted.

function harness(opts: { offline: boolean; coolDownMs?: number }) {
  const toasts: { message: string; actionLabel: string }[] = [];
  let viewed = 0;
  let clock = 1_000_000;
  const state = { offline: opts.offline };
  const toaster = createOfflineSaveToaster({
    isOffline: () => state.offline,
    toast: (message, action) => { toasts.push({ message, actionLabel: action.label }); action.onPress(); },
    onView: () => { viewed++; },
    coolDownMs: opts.coolDownMs,
    now: () => clock,
  });
  return { toaster, toasts, state, advance: (ms: number) => { clock += ms; }, viewed: () => viewed };
}

test('offline save toasts once with a View action that opens the sync view', () => {
  const h = harness({ offline: true });
  h.toaster.noteOutboxChange();
  assert.equal(h.toasts.length, 1);
  assert.equal(h.toasts[0].message, 'Saved — will sync when back online');
  assert.equal(h.toasts[0].actionLabel, 'View');
  assert.equal(h.viewed(), 1);
});

test('online saves never toast', () => {
  const h = harness({ offline: false });
  h.toaster.noteOutboxChange();
  assert.equal(h.toasts.length, 0);
});

test('rapid saves inside the cooldown collapse to one toast', () => {
  const h = harness({ offline: true, coolDownMs: 5000 });
  h.toaster.noteOutboxChange();
  h.advance(1000);
  h.toaster.noteOutboxChange();
  h.toaster.noteOutboxChange();
  assert.equal(h.toasts.length, 1);
});

test('a save after the cooldown toasts again', () => {
  const h = harness({ offline: true, coolDownMs: 5000 });
  h.toaster.noteOutboxChange();
  h.advance(5001);
  h.toaster.noteOutboxChange();
  assert.equal(h.toasts.length, 2);
});

test('going back online stops toasts even mid-cooldown-cycle', () => {
  const h = harness({ offline: true, coolDownMs: 5000 });
  h.toaster.noteOutboxChange();
  h.advance(6000);
  h.state.offline = false;
  h.toaster.noteOutboxChange();
  assert.equal(h.toasts.length, 1);
});
