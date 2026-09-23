/**
 * Golden contract test (Phase 7): replay identical /sync/full, /sync/pull and
 * /sync/push exchanges against the OLD api (apps/api) and api-v2, both running
 * over the SAME dev Postgres, and diff the responses byte-for-byte (rows sorted
 * canonically — SQL row order isn't guaranteed).
 *
 * Run:
 *   old api on :3001  (scripts/dev-api.sh)
 *   api-v2  on :3002  (same env, PORT=3002)
 *   npx tsx scripts/golden-contract.ts
 *
 * Expected, documented differences (the ONLY tolerated ones):
 *   - locker_access + dashboard_presets: dropped from the v2 manifest. Pulls
 *     no longer include them (v2 /full 400s), pushes reject 'Table not
 *     allowed'. Everything else must match exactly.
 *
 * Push probes cover the contract's sharp edges: SENSITIVE_DENY (users.pin_hash,
 * notifications.title), server-only + permission-gated activity actions,
 * allowlist rejection, malformed payload, privileged-table gate, a malformed
 * ADJUST, and one REAL idempotent write (activity_log WHERE NOT EXISTS —
 * applied by the old api, no-op'd on replay by v2, same 'ok' both times).
 */
import { createHmac, randomUUID } from 'node:crypto';
import { Client } from 'pg';

const OLD = process.env.OLD_API ?? 'http://127.0.0.1:3001';
const NEW = process.env.NEW_API ?? 'http://127.0.0.1:3002';
const SECRET = process.env.JWT_SECRET ?? 'dev-local-secret-not-prod-0123456789abcdef';
const DB = process.env.DATABASE_URL ?? 'postgres://invenpro:devlocal@127.0.0.1:5433/inventorypro';

const DROPPED = new Set(['locker_access', 'dashboard_presets']);

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');
function signJwt(payload: Record<string, unknown>): string {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ ...payload, iat: now, exp: now + 900 }));
  const sig = createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

type Json = Record<string, unknown>;
async function call(base: string, path: string, jwt: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const res = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Json };
}

// Canonical JSON: object keys sorted so diffs are content diffs, not key-order.
function canon(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v as Json).sort().map(k => [k, canon((v as Json)[k])]));
  }
  return v;
}
const stable = (v: unknown) => JSON.stringify(canon(v));
const sortRows = (rows: unknown[]) => rows.map(r => stable(r)).sort();

let failures = 0;
function check(label: string, okay: boolean, detail?: string) {
  if (okay) { console.log(`  ok   ${label}`); return; }
  failures++;
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
}

async function fullDump(base: string, jwt: string, table: string): Promise<{ status: number; rows: unknown[] }> {
  const rows: unknown[] = [];
  for (let page = 0; page < 200; page++) {
    const { status, body } = await call(base, `/sync/full?table=${table}&page=${page}&limit=500`, jwt);
    if (status !== 200) return { status, rows };
    rows.push(...(body.rows as unknown[]));
    if (!body.hasMore) break;
  }
  return { status: 200, rows };
}

async function main() {
  const db = new Client({ connectionString: DB });
  await db.connect();
  const admin = (await db.query(
    `SELECT id, name, role FROM users WHERE role = 'full_admin' AND active AND NOT COALESCE(is_test, false) ORDER BY created_at LIMIT 1`,
  )).rows[0];
  const crew = (await db.query(
    `SELECT id, name, role FROM users WHERE role = 'construction_crew' AND active AND NOT COALESCE(is_test, false) ORDER BY created_at LIMIT 1`,
  )).rows[0];
  if (!admin || !crew) throw new Error('dev DB needs one active non-test full_admin and construction_crew');
  console.log(`identities: admin=${admin.id} crew=${crew.id}`);
  const adminJwt = signJwt({ sub: admin.id, name: admin.name, role: admin.role });
  const crewJwt = signJwt({ sub: crew.id, name: crew.name, role: crew.role });

  // v2's table list comes from the manifest — import the same module the
  // server boots with so the probe list can never drift from the allowlist.
  const { FULL_TABLES } = await import('../src/sync/tables');

  // ── /sync/full parity, both identities ────────────────────────────────────
  for (const [who, jwt] of [['admin', adminJwt], ['crew', crewJwt]] as const) {
    console.log(`\n/sync/full (${who}):`);
    for (const table of FULL_TABLES) {
      const [o, n] = await Promise.all([fullDump(OLD, jwt, table), fullDump(NEW, jwt, table)]);
      if (o.status !== 200 || n.status !== 200) {
        check(`${table}`, false, `status old=${o.status} new=${n.status}`);
        continue;
      }
      const os = sortRows(o.rows); const ns = sortRows(n.rows);
      const same = os.length === ns.length && os.every((r, i) => r === ns[i]);
      let detail = `rows old=${os.length} new=${ns.length}`;
      if (!same && os.length === ns.length) {
        const i = os.findIndex((r, i2) => r !== ns[i2]);
        detail = `first diff at sorted row ${i}:\n    old ${os[i]?.slice(0, 300)}\n    new ${ns[i]?.slice(0, 300)}`;
      }
      check(`${table} (${o.rows.length} rows)`, same, detail);
    }
  }

  // Dropped tables: old still serves them, v2 400s.
  console.log('\ndropped tables:');
  for (const table of DROPPED) {
    const [o, n] = await Promise.all([fullDump(OLD, adminJwt, table), fullDump(NEW, adminJwt, table)]);
    check(`${table}: old serves (${o.rows.length} rows), v2 rejects 400`, o.status === 200 && n.status === 400,
      `old=${o.status} new=${n.status}`);
  }

  // ── /sync/pull parity, both identities ────────────────────────────────────
  for (const [who, jwt] of [['admin', adminJwt], ['crew', crewJwt]] as const) {
    console.log(`\n/sync/pull since=epoch (${who}):`);
    const [o, n] = await Promise.all([
      call(OLD, `/sync/pull?since=${encodeURIComponent(new Date(0).toISOString())}`, jwt),
      call(NEW, `/sync/pull?since=${encodeURIComponent(new Date(0).toISOString())}`, jwt),
    ]);
    check('status 200/200', o.status === 200 && n.status === 200, `old=${o.status} new=${n.status}`);
    const oldTables = Object.keys(o.body).sort();
    const newTables = Object.keys(n.body).sort();
    check('v2 table set = old minus dropped',
      stable(newTables) === stable(oldTables.filter(t => !DROPPED.has(t)).sort()),
      `old=${oldTables.length} new=${newTables.length}`);
    for (const table of newTables) {
      const or = sortRows((o.body[table] as { rows: unknown[] }).rows);
      const nr = sortRows((n.body[table] as { rows: unknown[] }).rows);
      const same = or.length === nr.length && or.every((r, i) => r === nr[i]);
      let detail = `rows old=${or.length} new=${nr.length}`;
      if (!same && or.length === nr.length) {
        const i = or.findIndex((r, i2) => r !== nr[i2]);
        detail = `first diff:\n    old ${or[i]?.slice(0, 300)}\n    new ${nr[i]?.slice(0, 300)}`;
      }
      check(`${table} (${or.length} rows)`, same, detail);
    }
  }

  // ── /sync/push probes ─────────────────────────────────────────────────────
  // Deterministic rejections + one idempotent apply. Entry ids fixed so the
  // response arrays are directly comparable. EXPECTED-DIFF entries (dropped
  // tables) are asserted separately, not diffed.
  const goldenActivityId = randomUUID(); // fresh row: old applies it, v2 no-ops idempotently
  const adminEntries = [
    // SENSITIVE_DENY: pin_hash on users (admin holds manage_users — the column
    // is denied regardless) → ForbiddenColumnsError → generic 'write rejected'.
    { id: 'g-users-pinhash', operation: 'UPDATE', table_name: 'users', payload: { id: admin.id, pin_hash: 'forged' }, created_at: new Date().toISOString() },
    // SENSITIVE_DENY: notifications.title on a mark-read UPDATE.
    { id: 'g-notif-title', operation: 'UPDATE', table_name: 'notifications', payload: { id: randomUUID(), title: 'forged' }, created_at: new Date().toISOString() },
    // Allowlist rejection + injection flag.
    { id: 'g-bad-table', operation: 'INSERT', table_name: 'pg_shadow', payload: { id: '1' }, created_at: new Date().toISOString() },
    // Server-only activity action.
    { id: 'g-act-login', operation: 'INSERT', table_name: 'activity_log', payload: { id: randomUUID(), action: 'login', entity_type: 'user' }, created_at: new Date().toISOString() },
    // Malformed payload.
    { id: 'g-malformed', operation: 'UPDATE', table_name: 'users', payload: null, created_at: new Date().toISOString() },
    // Malformed ADJUST (missing delta) → applyEntry throws before any SQL.
    { id: 'g-adjust-bad', operation: 'ADJUST', table_name: 'stock_by_location', payload: { item_id: randomUUID() }, created_at: new Date().toISOString() },
    // REAL idempotent write.
    { id: 'g-act-ok', operation: 'INSERT', table_name: 'activity_log', payload: { id: goldenActivityId, action: 'recount', entity_type: 'item', note: 'golden contract probe' }, created_at: new Date().toISOString() },
  ];
  const droppedEntries = [
    { id: 'g-locker', operation: 'DELETE', table_name: 'locker_access', payload: { location_id: randomUUID(), user_id: randomUUID() }, created_at: new Date().toISOString() },
    { id: 'g-dash', operation: 'DELETE', table_name: 'dashboard_presets', payload: { id: randomUUID() }, created_at: new Date().toISOString() },
  ];
  const crewEntries = [
    // Privileged-table gate.
    { id: 'g-roleset', operation: 'UPDATE', table_name: 'role_settings', payload: { role: 'construction_crew', color: '#fff' }, created_at: new Date().toISOString() },
    // Permission-gated activity action.
    { id: 'g-act-perm', operation: 'INSERT', table_name: 'activity_log', payload: { id: randomUUID(), action: 'user_role_changed', entity_type: 'user' }, created_at: new Date().toISOString() },
    // app_config without system_settings.
    { id: 'g-appcfg', operation: 'INSERT', table_name: 'app_config', payload: { key: 'demo_mode', value: '0' }, created_at: new Date().toISOString() },
    // notifications INSERT (op-perm DENY path).
    { id: 'g-notif-ins', operation: 'INSERT', table_name: 'notifications', payload: { id: randomUUID(), user_id: crew.id }, created_at: new Date().toISOString() },
  ];

  console.log('\n/sync/push (admin probes — old first, then v2 replay):');
  const oPushA = await call(OLD, '/sync/push', adminJwt, { entries: adminEntries });
  const nPushA = await call(NEW, '/sync/push', adminJwt, { entries: adminEntries });
  check('status 200/200', oPushA.status === 200 && nPushA.status === 200, `old=${oPushA.status} new=${nPushA.status}`);
  check('response parity (ok/conflicts/merged)', stable(oPushA.body) === stable(nPushA.body),
    `\n    old ${stable(oPushA.body)}\n    new ${stable(nPushA.body)}`);
  check('SENSITIVE_DENY probes rejected on both',
    ['g-users-pinhash', 'g-notif-title'].every(id =>
      (oPushA.body.conflicts as Json[]).some(c => c.id === id) && (nPushA.body.conflicts as Json[]).some(c => c.id === id)));
  check('idempotent activity write ok on both',
    (oPushA.body.ok as string[]).includes('g-act-ok') && (nPushA.body.ok as string[]).includes('g-act-ok'));
  const actRow = await db.query(`SELECT COUNT(*)::int AS n FROM activity_log WHERE id = $1`, [goldenActivityId]);
  check('activity row applied exactly once', actRow.rows[0].n === 1, `n=${actRow.rows[0].n}`);

  console.log('\n/sync/push (dropped-table probes — expected divergence):');
  const oPushD = await call(OLD, '/sync/push', adminJwt, { entries: droppedEntries });
  const nPushD = await call(NEW, '/sync/push', adminJwt, { entries: droppedEntries });
  for (const id of ['g-locker', 'g-dash']) {
    const nc = (nPushD.body.conflicts as Json[]).find(c => c.id === id);
    check(`${id}: v2 rejects 'Table not allowed'`, nc?.error === 'Table not allowed' && nc?.code === 'NOT_ALLOWED', stable(nc));
    const oc = (oPushD.body.conflicts as Json[] | undefined)?.find(c => c.id === id);
    console.log(`       old response for ${id}: ${oc ? stable(oc) : `ok (${stable(oPushD.body.ok)})`}`);
  }

  console.log('\n/sync/push (crew probes):');
  const oPushC = await call(OLD, '/sync/push', crewJwt, { entries: crewEntries });
  const nPushC = await call(NEW, '/sync/push', crewJwt, { entries: crewEntries });
  check('status 200/200', oPushC.status === 200 && nPushC.status === 200, `old=${oPushC.status} new=${nPushC.status}`);
  check('response parity (ok/conflicts/merged)', stable(oPushC.body) === stable(nPushC.body),
    `\n    old ${stable(oPushC.body)}\n    new ${stable(nPushC.body)}`);

  await db.end();
  console.log(failures === 0 ? '\nGOLDEN CONTRACT: PASS' : `\nGOLDEN CONTRACT: ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(2); });
