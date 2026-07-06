import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseThreshold,
  isThresholdMovement,
  shouldNotifyDecision,
  approvalUpdateAllowed,
} from './approvals';

test('parseThreshold: blank/garbage/0/negative disable, positive int enables', () => {
  assert.equal(parseThreshold(undefined), 0);
  assert.equal(parseThreshold(null), 0);
  assert.equal(parseThreshold(''), 0);
  assert.equal(parseThreshold('   '), 0);
  assert.equal(parseThreshold('0'), 0);
  assert.equal(parseThreshold('-5'), 0);
  assert.equal(parseThreshold('abc'), 0);
  assert.equal(parseThreshold('10'), 10);
  assert.equal(parseThreshold(' 25 '), 25);
});

test('isThresholdMovement: stock ADJUST at/over threshold (either sign) flags', () => {
  const mk = (delta: unknown) => ({ operation: 'ADJUST', table_name: 'stock_by_location', payload: { delta } });
  assert.equal(isThresholdMovement(mk(-10), 10), true); // checkout leg, |−10| >= 10
  assert.equal(isThresholdMovement(mk(10), 10), true);
  assert.equal(isThresholdMovement(mk(-25), 10), true);
  assert.equal(isThresholdMovement(mk(-9), 10), false); // below threshold
  assert.equal(isThresholdMovement(mk(5), 10), false);
  assert.equal(isThresholdMovement(mk('-15'), 10), true); // numeric string coerced
});

test('isThresholdMovement: disabled/other tables/ops/non-numeric → false', () => {
  const mk = (delta: unknown) => ({ operation: 'ADJUST', table_name: 'stock_by_location', payload: { delta } });
  assert.equal(isThresholdMovement(mk(-100), 0), false); // threshold off
  assert.equal(isThresholdMovement(mk(-100), -1), false);
  assert.equal(isThresholdMovement({ operation: 'UPDATE', table_name: 'stock_by_location', payload: { delta: -100 } }, 10), false);
  assert.equal(isThresholdMovement({ operation: 'ADJUST', table_name: 'inventory_items', payload: { delta: -100 } }, 10), false);
  assert.equal(isThresholdMovement(mk(undefined), 10), false);
  assert.equal(isThresholdMovement(mk('nope'), 10), false);
  assert.equal(isThresholdMovement(null, 10), false);
});

test('shouldNotifyDecision: only real open->approved/rejected transitions notify', () => {
  assert.equal(shouldNotifyDecision('open', 'approved'), true);
  assert.equal(shouldNotifyDecision('open', 'rejected'), true);
  assert.equal(shouldNotifyDecision('open', 'cancelled'), false); // requester cancel: no notify
  assert.equal(shouldNotifyDecision('open', 'open'), false); // no-op
  assert.equal(shouldNotifyDecision('approved', 'approved'), false); // retry of settled row
  assert.equal(shouldNotifyDecision('approved', 'rejected'), false); // not from open
  assert.equal(shouldNotifyDecision(undefined, 'approved'), false);
  assert.equal(shouldNotifyDecision(null, 'rejected'), false);
});

test('approvalUpdateAllowed: a non-approver may not stamp decision fields without a status change', () => {
  // Touching decided_by/decided_at without moving status (changesStatus:false) is
  // still a decision-field write and must require approver authority.
  assert.equal(
    approvalUpdateAllowed({ changesStatus: false, callerIsApprover: false, callerIsRequester: false }).allowed,
    false,
  );
  // An approver may write decision fields even without a status change (e.g. note).
  assert.equal(
    approvalUpdateAllowed({ changesStatus: false, callerIsApprover: true, callerIsRequester: false }).allowed,
    true,
  );
});

test('approvalUpdateAllowed: approver may decide, non-approver may not', () => {
  assert.equal(
    approvalUpdateAllowed({ changesStatus: true, nextStatus: 'approved', callerIsApprover: true, callerIsRequester: false }).allowed,
    true,
  );
  const denied = approvalUpdateAllowed({ changesStatus: true, nextStatus: 'approved', callerIsApprover: false, callerIsRequester: false });
  assert.equal(denied.allowed, false);
  assert.match(denied.reason ?? '', /approver/);
});

test('approvalUpdateAllowed: requester may only cancel own request, not approve/reject', () => {
  assert.equal(
    approvalUpdateAllowed({ changesStatus: true, nextStatus: 'cancelled', callerIsApprover: false, callerIsRequester: true }).allowed,
    true,
  );
  assert.equal(
    approvalUpdateAllowed({ changesStatus: true, nextStatus: 'approved', callerIsApprover: false, callerIsRequester: true }).allowed,
    false,
  );
  assert.equal(
    approvalUpdateAllowed({ changesStatus: true, nextStatus: 'rejected', callerIsApprover: false, callerIsRequester: true }).allowed,
    false,
  );
});
