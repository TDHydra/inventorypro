import { test } from 'node:test';
import assert from 'node:assert';
import { splitRequestRef } from './requestRef';

// #235: engine.ts appends ' [ref <request-id>]' to last_error from the
// server's X-Request-Id header — SyncIndicator needs to pull that back out
// to render it as its own subtle line.
test('splitRequestRef: pulls a trailing ref off the message', () => {
  assert.deepEqual(
    splitRequestRef("HTTP 500: internal error [ref 3f2a1e4b-1234-4a1a-9f0e-abcdef012345]"),
    { text: 'HTTP 500: internal error', ref: '3f2a1e4b-1234-4a1a-9f0e-abcdef012345' }
  );
});

test('splitRequestRef: no ref present returns the message unchanged with a null ref', () => {
  assert.deepEqual(
    splitRequestRef('Forbidden: teams requires manage_teams'),
    { text: 'Forbidden: teams requires manage_teams', ref: null }
  );
});

test('splitRequestRef: only strips a ref at the very end, not one embedded mid-string', () => {
  const msg = 'Rejected: [ref abc] but then more text';
  assert.deepEqual(splitRequestRef(msg), { text: msg, ref: null });
});

test('splitRequestRef: empty string has no ref', () => {
  assert.deepEqual(splitRequestRef(''), { text: '', ref: null });
});
