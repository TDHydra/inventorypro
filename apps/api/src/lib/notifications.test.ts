import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dedupKeys, getNotifyConfig, deliver, resolveRecipients, claimEvent } from './notifications';

test('dedupKeys build stable keys', () => {
  assert.equal(dedupKeys.assign('r1', 'u1'), 'assign:repair:r1:u1');
  assert.equal(dedupKeys.lowstock('i1'), 'lowstock:item:i1');
  assert.equal(dedupKeys.session('u1', '2026-07-01T10:00:00Z'), 'session:user:u1:2026-07-01T10:00:00Z');
  assert.equal(dedupKeys.approval('a1'), 'approval:req:a1');
  assert.equal(dedupKeys.apprDecision('a1', 'approved'), 'approval:dec:a1:approved');
});

test('deliver writes one inbox row per deduped user and fires exactly one push', async () => {
  const calls: { sql: string; params: unknown[] }[] = [];
  const pg = { query: async (sql: string, params: unknown[]) => { calls.push({ sql, params }); return { rows: [] as any[] }; } };
  await deliver(pg as any, ['u1', 'u2', 'u1'], { type: 'broadcast', title: 't', body: 'b', data: { screen: 'notifications' } });
  const inserts = calls.filter(c => c.sql.includes('INSERT INTO notifications'));
  assert.equal(inserts.length, 2); // duplicate u1 deduped to one row
  assert.deepEqual(inserts.map(c => c.params[1]).sort(), ['u1', 'u2']);
  // sendPush runs once: a single device_push_tokens lookup keyed by the deduped id list.
  const pushLookups = calls.filter(c => c.sql.includes('device_push_tokens'));
  assert.equal(pushLookups.length, 1);
  assert.deepEqual(pushLookups[0].params[0], ['u1', 'u2']);
});

test('deliver is a no-op on empty recipients', async () => {
  const calls: { sql: string }[] = [];
  const pg = { query: async (sql: string) => { calls.push({ sql }); return { rows: [] as any[] }; } };
  await deliver(pg as any, [], { type: 'broadcast', title: 't', body: 'b' });
  assert.equal(calls.length, 0);
});

test('resolveRecipients merges intrinsic roles + configured route, deduped', async () => {
  const cfg = JSON.stringify({ roles: ['office_manager'], teams: [], users: ['u9'] });
  const pg = { query: async (sql: string, params: unknown[]) => {
    if (sql.includes('app_config')) return { rows: [{ value: cfg }] };
    if (sql.includes('FROM users WHERE role = ANY')) {
      const roles = params[0] as string[];
      return { rows: roles.includes('office_manager') ? [{ id: 'u5' }] : [{ id: 'a1' }] };
    }
    // final active-only pass: echo the queried ids back as active
    if (sql.includes('id = ANY') && sql.includes('active = TRUE')) {
      return { rows: (params[0] as string[]).map(id => ({ id })) };
    }
    return { rows: [] as any[] };
  } };
  const to = await resolveRecipients(pg as any, 'low_stock');
  assert.deepEqual([...to].sort(), ['a1', 'u5', 'u9']); // intrinsic managers + role members + explicit user
});

test('resolveRecipients falls back to intrinsic defaults when route unset', async () => {
  const pg = { query: async (sql: string, params: unknown[]) => {
    if (sql.includes('app_config')) return { rows: [] as any[] };
    if (sql.includes('FROM users WHERE role = ANY')) return { rows: [{ id: 'a1' }] };
    if (sql.includes('id = ANY') && sql.includes('active = TRUE')) {
      return { rows: (params[0] as string[]).map(id => ({ id })) };
    }
    return { rows: [] as any[] };
  } };
  assert.deepEqual(await resolveRecipients(pg as any, 'low_stock'), ['a1']);
});

test('resolveRecipients assignment channel always includes the assignee', async () => {
  const pg = { query: async (sql: string, params: unknown[]) => {
    if (sql.includes('id = ANY') && sql.includes('active = TRUE')) {
      return { rows: (params[0] as string[]).map(id => ({ id })) };
    }
    return { rows: [] as any[] };
  } };
  assert.deepEqual(await resolveRecipients(pg as any, 'assignment', { userId: 'u1' }), ['u1']);
});

// #48: the assignment channel must not fan out to a user the actor can't reach.
test('resolveRecipients assignment drops an assignee who shares NO team with the actor', async () => {
  const pg = { query: async (sql: string, params: unknown[]) => {
    if (sql.includes('FROM team_members a')) return { rows: [] as any[] }; // no shared team
    if (sql.includes('id = ANY') && sql.includes('active = TRUE')) {
      return { rows: (params[0] as string[]).map(id => ({ id })) };
    }
    return { rows: [] as any[] };
  } };
  // A crafted repair UPDATE by `actor` targeting an unrelated `stranger` yields no recipient.
  assert.deepEqual(await resolveRecipients(pg as any, 'assignment', { userId: 'stranger', actorId: 'actor' }), []);
});

test('resolveRecipients assignment keeps an assignee who shares a team with the actor', async () => {
  const pg = { query: async (sql: string, params: unknown[]) => {
    if (sql.includes('FROM team_members a')) return { rows: [{ '?column?': 1 }] }; // shared team
    if (sql.includes('id = ANY') && sql.includes('active = TRUE')) {
      return { rows: (params[0] as string[]).map(id => ({ id })) };
    }
    return { rows: [] as any[] };
  } };
  assert.deepEqual(await resolveRecipients(pg as any, 'assignment', { userId: 'teammate', actorId: 'actor' }), ['teammate']);
});

// #48: repeated identical assignments are deduped via the claimEvent ledger — the
// first (repair, assignee) claim wins and notifies; a duplicate within the window
// (the key still present) is suppressed. Mirrors the ON CONFLICT DO NOTHING ledger.
test('assignment dedup: an identical (repair, assignee) claim is suppressed on repeat', async () => {
  const claimed = new Set<string>();
  const pg = { query: async (sql: string, params: unknown[]) => {
    if (sql.includes('INSERT INTO notification_dedup')) {
      const key = params[0] as string;
      if (claimed.has(key)) return { rows: [] as any[] }; // ON CONFLICT DO NOTHING → no row
      claimed.add(key);
      return { rows: [{ event_key: key }] };
    }
    return { rows: [] as any[] };
  } };
  const key = dedupKeys.assign('r1', 'u1');
  assert.equal(await claimEvent(pg as any, key), true);  // first assignment: claim won → notify
  assert.equal(await claimEvent(pg as any, key), false); // duplicate: key present → suppressed
});
// #122 Phase C: the on_call channel — coverage saves fan out to the other PMs.
test('resolveRecipients on_call: other production managers, actor excluded', async () => {
  const pg = { query: async (sql: string, params: unknown[]) => {
    if (sql.includes('app_config')) return { rows: [] as any[] };
    if (sql.includes('FROM users WHERE role = ANY')) {
      assert.deepEqual(params[0], ['production_manager']);
      return { rows: [{ id: 'pm1' }, { id: 'pm2' }] };
    }
    if (sql.includes('id = ANY') && sql.includes('active = TRUE')) {
      return { rows: (params[0] as string[]).map(id => ({ id })) };
    }
    return { rows: [] as any[] };
  } };
  assert.deepEqual(await resolveRecipients(pg as any, 'on_call', { actorId: 'pm1' }), ['pm2']);
});

test('resolveRecipients on_call: unions notify_route_on_call users', async () => {
  const cfg = JSON.stringify({ roles: [], teams: [], users: ['boss1'] });
  const pg = { query: async (sql: string, params: unknown[]) => {
    if (sql.includes('app_config')) return { rows: [{ value: cfg }] };
    if (sql.includes('FROM users WHERE role = ANY')) return { rows: [{ id: 'pm2' }] };
    if (sql.includes('id = ANY') && sql.includes('active = TRUE')) {
      return { rows: (params[0] as string[]).map(id => ({ id })) };
    }
    return { rows: [] as any[] };
  } };
  assert.deepEqual((await resolveRecipients(pg as any, 'on_call', { actorId: 'pm1' })).sort(), ['boss1', 'pm2']);
});

test('dedupKeys.coverage is stable', () => {
  assert.equal(dedupKeys.coverage('c1'), 'oncall:coverage:c1');
});

test('getNotifyConfig applies defaults + parses + clamps + disable flag', async () => {
  const pgEmpty = { query: async () => ({ rows: [] }) };
  assert.deepEqual(await getNotifyConfig(pgEmpty as any), { enabled: true, pollMin: 5, idleMin: 15 });
  const pgSet = { query: async () => ({ rows: [
    { key: 'notify_enabled', value: '0' },
    { key: 'notify_poll_interval_min', value: '2' },
    { key: 'notify_checkout_idle_min', value: '30' },
  ] }) };
  assert.deepEqual(await getNotifyConfig(pgSet as any), { enabled: false, pollMin: 2, idleMin: 30 });
});
test('getNotifyConfig clamps durations to [1,1440] (guards setInterval overflow + dead-timer)', async () => {
  const pgHuge = { query: async () => ({ rows: [
    { key: 'notify_poll_interval_min', value: '999999' },
    { key: 'notify_checkout_idle_min', value: '99999' },
  ] }) };
  assert.deepEqual(await getNotifyConfig(pgHuge as any), { enabled: true, pollMin: 1440, idleMin: 1440 });
  // Invalid/zero/garbage → falls back to the default (0 is falsy → default), never < 1.
  const pgZero = { query: async () => ({ rows: [{ key: 'notify_poll_interval_min', value: '0' }] }) };
  assert.equal((await getNotifyConfig(pgZero as any)).pollMin, 5);
});
