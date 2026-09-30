import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sameRows } from './useReactiveRows';

// sameRows is the guarantee behind #91: an unchanged row set must compare equal
// so the list keeps its array reference and never re-renders mid-scroll, while a
// real change (add/remove/reorder/edit) must compare unequal so the UI updates.

test('identical content compares equal (stable reference retained)', () => {
  const a = [{ id: '1', updated_at: 't1' }, { id: '2', updated_at: 't2' }];
  const b = [{ id: '1', updated_at: 't1' }, { id: '2', updated_at: 't2' }];
  assert.equal(sameRows(a, b), true);
});

test('the same array reference short-circuits to equal', () => {
  const a = [{ id: '1', updated_at: 't1' }];
  assert.equal(sameRows(a, a), true);
});

test('a changed updated_at (in-place edit) compares unequal', () => {
  const a = [{ id: '1', updated_at: 't1' }];
  const b = [{ id: '1', updated_at: 't2' }];
  assert.equal(sameRows(a, b), false);
});

test('an added row compares unequal', () => {
  const a = [{ id: '1', updated_at: 't1' }];
  const b = [{ id: '1', updated_at: 't1' }, { id: '2', updated_at: 't2' }];
  assert.equal(sameRows(a, b), false);
});

test('a reorder compares unequal (order is a real change a list must reflect)', () => {
  const a = [{ id: '1', updated_at: 't1' }, { id: '2', updated_at: 't2' }];
  const b = [{ id: '2', updated_at: 't2' }, { id: '1', updated_at: 't1' }];
  assert.equal(sameRows(a, b), false);
});

test('rows without updated_at compare on id alone', () => {
  const a = [{ id: '1' }, { id: '2' }];
  const b = [{ id: '1' }, { id: '2' }];
  assert.equal(sameRows(a, b), true);
  assert.equal(sameRows(a, [{ id: '1' }, { id: '3' }]), false);
});
