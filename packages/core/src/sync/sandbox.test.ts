import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setSandboxActive, isSandboxActive } from './sandbox';

test('sandbox is off by default', () => {
  assert.equal(isSandboxActive(), false);
});

test('setSandboxActive toggles the flag', () => {
  setSandboxActive(true);
  assert.equal(isSandboxActive(), true);
  setSandboxActive(false);
  assert.equal(isSandboxActive(), false);
});
