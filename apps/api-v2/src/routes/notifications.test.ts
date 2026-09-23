import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAudience } from './notifications';

test('resolveAudience everyone → all active users minus sender', async () => {
  const pg = {
    query: async (sql: string) => {
      if (sql.includes('FROM users WHERE active')) {
        return { rows: [{ id: 'u1' }, { id: 'u2' }, { id: 'me' }] };
      }
      return { rows: [] as any[] };
    },
  };
  const to = await resolveAudience(pg as any, { everyone: true }, 'me');
  assert.deepEqual([...to].sort(), ['u1', 'u2']); // sender removed
});

test('resolveAudience unions roles + teams, deduped, minus sender', async () => {
  const pg = {
    query: async (sql: string) => {
      if (sql.includes('FROM users WHERE role = ANY')) return { rows: [{ id: 'r1' }, { id: 'shared' }] };
      if (sql.includes('team_members')) return { rows: [{ user_id: 'shared' }, { user_id: 't1' }, { user_id: 'me' }] };
      return { rows: [] as any[] };
    },
  };
  const to = await resolveAudience(pg as any, { roles: ['office_manager'], teams: ['team-1'] }, 'me');
  assert.deepEqual([...to].sort(), ['r1', 'shared', 't1']); // 'shared' deduped, sender removed
});

test('resolveAudience empty audience → []', async () => {
  const pg = { query: async () => ({ rows: [] as any[] }) };
  assert.deepEqual(await resolveAudience(pg as any, {}, 'me'), []);
});

test('resolveAudience everyone ignores roles/teams and never queries them', async () => {
  const seen: string[] = [];
  const pg = {
    query: async (sql: string) => {
      seen.push(sql);
      if (sql.includes('FROM users WHERE active')) return { rows: [{ id: 'u1' }] };
      return { rows: [] as any[] };
    },
  };
  const to = await resolveAudience(pg as any, { everyone: true, roles: ['office_manager'], teams: ['t'] }, 'me');
  assert.deepEqual(to, ['u1']);
  assert.ok(!seen.some(s => s.includes('team_members') || s.includes('role = ANY')));
});
