import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  keepRealColumns,
  applyWritePolicy,
  requiredOperationPerm,
  isAllowedActivity,
  selectColumnsFor,
} from './syncPolicy';

const real = new Map([['jobs', new Set(['id', 'name', 'status'])]]);

test('keepRealColumns drops injection-style keys not matching a real column', () => {
  const payload = {
    id: 'x',
    name: 'ok',
    "name = (SELECT pin_hash FROM users LIMIT 1)--": 'evil',
  };
  const { kept, dropped } = keepRealColumns('jobs', payload, real);
  assert.deepEqual(Object.keys(kept), ['id', 'name']);
  assert.deepEqual(dropped, ["name = (SELECT pin_hash FROM users LIMIT 1)--"]);
});

test('keepRealColumns drops everything for an unknown table (fail closed)', () => {
  const { kept } = keepRealColumns('not_a_table', { id: 'x' }, real);
  assert.deepEqual(kept, {});
});

const realUsers = new Map([['users', new Set(['id', 'name', 'role', 'pin_hash', 'permission_overrides', 'active', 'expires_at', 'updated_at'])]]);

test('applyWritePolicy rejects privilege columns on users', () => {
  const { rejected } = applyWritePolicy(
    'users', 'UPDATE',
    { id: 'self', role: 'full_admin', permission_overrides: { system_settings: true } },
    'self', realUsers,
  );
  assert.deepEqual(rejected.sort(), ['permission_overrides', 'role']);
});

test('applyWritePolicy allows a benign users.name edit', () => {
  const { row, rejected } = applyWritePolicy('users', 'UPDATE', { id: 'self', name: 'New Name' }, 'self', realUsers);
  assert.deepEqual(rejected, []);
  assert.deepEqual(row, { id: 'self', name: 'New Name' });
});

test('applyWritePolicy forces attribution to caller on INSERT', () => {
  const realJobs = new Map([['jobs', new Set(['id', 'name', 'created_by'])]]);
  const { row } = applyWritePolicy('jobs', 'INSERT', { id: 'j', name: 'J', created_by: 'someone-else' }, 'caller', realJobs);
  assert.equal(row.created_by, 'caller');
});

test('operational tables map op -> permission', () => {
  assert.equal(requiredOperationPerm('inventory_items', 'DELETE'), 'delete_inventory');
  assert.equal(requiredOperationPerm('inventory_items', 'UPDATE'), 'edit_inventory');
  assert.equal(requiredOperationPerm('locations', 'UPDATE'), 'manage_locations');
  assert.equal(requiredOperationPerm('jobs', 'INSERT'), 'create_jobs');
});

test('privileged tables return null here (gated elsewhere)', () => {
  assert.equal(requiredOperationPerm('users', 'UPDATE'), null);
  assert.equal(requiredOperationPerm('activity_log', 'INSERT'), null);
});

test('activity_log action/entity_type constrained to enum', () => {
  assert.equal(isAllowedActivity('checkout', 'item'), true);
  assert.equal(isAllowedActivity('DROP TABLE users', 'item'), false);
  assert.equal(isAllowedActivity('checkout', 'nonsense'), false);
});

test('jobs hides PII/financial columns without view_financial_data', () => {
  const restricted = selectColumnsFor('jobs', false);
  assert.ok(!/customer_name|site_address|insurance_carrier/.test(restricted));
  const full = selectColumnsFor('jobs', true);
  assert.ok(/customer_name/.test(full));
});

test('users never exposes pin_hash or enrollment_code_hash', () => {
  const cols = selectColumnsFor('users', true);
  assert.ok(!/pin_hash|enrollment_code_hash/.test(cols));
});

test('app_config only exposes non-secret keys via projection marker', () => {
  assert.equal(selectColumnsFor('app_config', false), 'key, value, updated_at');
});
