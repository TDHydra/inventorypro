import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripServerControlledColumns } from './derive';
import { TABLES } from './tables';

test('strips team_members.is_manager from push payloads', () => {
  const payload = {
    team_id: 't1', user_id: 'u1', team_permission_overrides: {},
    added_by: null, joined_at: 'x', is_manager: false, updated_at: 'x',
  };
  const out = stripServerControlledColumns('team_members', payload);
  assert.ok(!('is_manager' in out));
  assert.equal(out.team_id, 't1');
  assert.equal(out.updated_at, 'x');
  // never mutates the stored outbox payload
  assert.ok('is_manager' in payload);
});

test('returns the same object when nothing applies', () => {
  const clean = { team_id: 't1', user_id: 'u1', updated_at: 'x' };
  assert.equal(stripServerControlledColumns('team_members', clean), clean);
  const other = { id: 'i1', name: 'n' };
  assert.equal(stripServerControlledColumns('inventory_items', other), other);
});

test('pushStripColumns only lists real columns', () => {
  for (const t of TABLES) {
    const cols = new Set(t.columns.map(c => c.name));
    for (const s of t.pushStripColumns ?? []) {
      assert.ok(cols.has(s), `${t.name}.${s} is not a declared column`);
    }
  }
});
