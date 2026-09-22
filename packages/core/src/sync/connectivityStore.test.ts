import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  noteNetInfoState,
  noteServerReachable,
  getConnectivity,
  subscribeConnectivity,
  isDefinitelyOffline,
  resetConnectivityForTest,
} from './connectivityStore';

beforeEach(() => resetConnectivityForTest());

test('starts unknown; a definite NetInfo report applies', () => {
  assert.equal(getConnectivity(), null);
  noteNetInfoState(false);
  assert.equal(getConnectivity(), false);
  assert.equal(isDefinitelyOffline(), true);
  noteNetInfoState(true);
  assert.equal(getConnectivity(), true);
  assert.equal(isDefinitelyOffline(), false);
});

test('a null (unknown) NetInfo report never clobbers a known state', () => {
  noteNetInfoState(false);
  noteNetInfoState(null);
  assert.equal(getConnectivity(), false);
  noteNetInfoState(true);
  noteNetInfoState(null);
  assert.equal(getConnectivity(), true);
});

test('a null report is accepted while the state is still unknown', () => {
  noteNetInfoState(null);
  assert.equal(getConnectivity(), null);
  assert.equal(isDefinitelyOffline(), false); // unknown must not cry offline
});

test('a server round-trip forces online over a NetInfo false-negative', () => {
  noteNetInfoState(false);
  noteServerReachable();
  assert.equal(getConnectivity(), true);
});

test('subscribers fire on change only, and unsubscribe cleanly', () => {
  let fires = 0;
  const unsub = subscribeConnectivity(() => { fires += 1; });
  noteNetInfoState(true);
  assert.equal(fires, 1);
  noteNetInfoState(true); // no change → no notify
  assert.equal(fires, 1);
  noteNetInfoState(false);
  assert.equal(fires, 2);
  unsub();
  noteNetInfoState(true);
  assert.equal(fires, 2);
});
