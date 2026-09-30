import { test } from 'node:test';
import assert from 'node:assert/strict';
import { derivePreviewAuditEvents } from './previewAudit';
// Type-only, same rationale as useSession.test.ts: keeps this test free of
// the native op-sqlite import chain.
import type { UserRole } from '../constants/roles';

test('derivePreviewAuditEvents: null -> null is a no-op (initial mount, nothing to log)', () => {
  assert.deepEqual(derivePreviewAuditEvents(null, null), []);
});

test('derivePreviewAuditEvents: null -> role logs a single preview_started for that role', () => {
  const role: UserRole = 'mitigation_technician';
  assert.deepEqual(derivePreviewAuditEvents(null, role), [
    { type: 'preview_started', role },
  ]);
});

test('derivePreviewAuditEvents: role -> null logs a single preview_ended for the role that was active', () => {
  const role: UserRole = 'mitigation_technician';
  assert.deepEqual(derivePreviewAuditEvents(role, null), [
    { type: 'preview_ended', role },
  ]);
});

test('derivePreviewAuditEvents: role A -> role B (switching while previewing) logs ended(A) then started(B)', () => {
  const a: UserRole = 'mitigation_technician';
  const b: UserRole = 'full_admin';
  assert.deepEqual(derivePreviewAuditEvents(a, b), [
    { type: 'preview_ended', role: a },
    { type: 'preview_started', role: b },
  ]);
});

test('derivePreviewAuditEvents: role -> the SAME role is a no-op (no redundant log)', () => {
  const role: UserRole = 'full_admin';
  assert.deepEqual(derivePreviewAuditEvents(role, role), []);
});
