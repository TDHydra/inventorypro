import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createSyncSheetBus } from './syncSheetBus';

// #205: notification tap → open the SyncIndicator sheet. Framework-free bus
// (toastBus.ts precedent) so the push handler can request the open from
// non-React code and SyncIndicator subscribes on mount.

let bus: ReturnType<typeof createSyncSheetBus>;
beforeEach(() => {
  bus = createSyncSheetBus();
});

test('invokes the listener when an open is requested while mounted', () => {
  let opened = 0;
  bus.setListener(() => opened++);
  bus.requestOpen();
  assert.equal(opened, 1);
});

test('holds a pre-mount request and delivers it when the listener registers (cold start from a notification tap)', () => {
  bus.requestOpen();
  let opened = 0;
  bus.setListener(() => opened++);
  assert.equal(opened, 1);
});

test('a held request fires only once', () => {
  bus.requestOpen();
  bus.requestOpen();
  let opened = 0;
  bus.setListener(() => opened++);
  assert.equal(opened, 1);
  bus.setListener(null);
  bus.setListener(() => opened++);
  assert.equal(opened, 1);
});

test('does nothing after the listener unregisters', () => {
  let opened = 0;
  bus.setListener(() => opened++);
  bus.setListener(null);
  bus.requestOpen();
  assert.equal(opened, 0);
  // the request made while unmounted is held for the next mount
  bus.setListener(() => opened++);
  assert.equal(opened, 1);
});
