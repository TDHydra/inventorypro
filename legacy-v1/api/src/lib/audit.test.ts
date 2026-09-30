import { test } from 'node:test';
import assert from 'node:assert';
import {
  outcomeFor, isSecurityClass, shouldAudit, stripQuery,
  sanitizeErrorMessage, buildAuditRow, setAuditDebug, isAuditDebug,
} from './audit';

test('outcomeFor separates rate limiting from ordinary client errors', () => {
  assert.equal(outcomeFor(200), 'success');
  assert.equal(outcomeFor(204), 'success');
  assert.equal(outcomeFor(400), 'client_error');
  assert.equal(outcomeFor(401), 'denied');
  assert.equal(outcomeFor(403), 'denied');
  // Brute-force throttling must be distinguishable from a validation typo.
  assert.equal(outcomeFor(429), 'rate_limited');
  assert.equal(outcomeFor(500), 'server_error');
  assert.equal(outcomeFor(503), 'server_error');
});

test('outcomeFor flags schema-validation rejects distinctly — but only on 4xx', () => {
  assert.equal(outcomeFor(400, true), 'validation_reject');
  assert.equal(outcomeFor(400), 'client_error');          // no flag → ordinary 4xx
  assert.equal(outcomeFor(400, false), 'client_error');
  assert.equal(outcomeFor(500, true), 'server_error');    // 5xx always wins
  assert.equal(outcomeFor(429, true), 'rate_limited');    // throttling wins too
  assert.equal(outcomeFor(200, true), 'success');         // stray flag on a 2xx is ignored
});

test('outcomeFor flags injection attempts and lets them win over the status code', () => {
  // A crafted table/column write strands the entry as a conflict but /sync/push
  // still returns 200 — the flag must win so it is not filed as a plain success.
  assert.equal(outcomeFor(200, false, true), 'injection_attempt');
  assert.equal(outcomeFor(400, false, true), 'injection_attempt');
  assert.equal(outcomeFor(500, false, true), 'injection_attempt'); // beats 5xx: intent matters more than the incidental status
  assert.equal(outcomeFor(200, true, true), 'injection_attempt');  // beats validation_reject too
  assert.equal(outcomeFor(200, false, false), 'success');          // no flag → unchanged
});

test('security class covers failures, all auth traffic, and privilege changes', () => {
  assert.equal(isSecurityClass('POST', '/auth/token', 'success'), true);   // successful login
  assert.equal(isSecurityClass('POST', '/auth/token', 'denied'), true);    // failed login
  assert.equal(isSecurityClass('GET', '/items', 'denied'), true);
  assert.equal(isSecurityClass('GET', '/items', 'rate_limited'), true);
  assert.equal(isSecurityClass('GET', '/items', 'server_error'), true);
  assert.equal(isSecurityClass('PATCH', '/users/abc', 'success'), true);   // role change
  assert.equal(isSecurityClass('POST', '/teams/x/members', 'success'), true);
  assert.equal(isSecurityClass('GET', '/items', 'success'), false);        // routine read
  assert.equal(isSecurityClass('POST', '/sync/push', 'success'), false);   // routine write
  // Schema-invalid input is probe-shaped traffic — retained like other failures.
  assert.equal(isSecurityClass('POST', '/items', 'validation_reject'), true);
  assert.equal(isSecurityClass('GET', '/items', 'validation_reject'), true);
  // A crafted table/column write is the clearest intrusion signal — always retained,
  // even on the /sync/push routine-write path that is otherwise dropped on success.
  assert.equal(isSecurityClass('POST', '/sync/push', 'injection_attempt'), true);
  // Toggling the demo-account kill switch changes who can sign in; reading it doesn't.
  assert.equal(isSecurityClass('PATCH', '/audit/demo-mode', 'success'), true);
  assert.equal(isSecurityClass('GET', '/audit/demo-mode', 'success'), false);
});

test('shouldAudit drops routine sync polls but never a failure or a mutation', () => {
  setAuditDebug(false);
  // The polls every device makes continuously — dropped only when successful.
  assert.equal(shouldAudit('GET', '/sync/pull?since=1', 'success'), false);
  assert.equal(shouldAudit('GET', '/sync/full', 'success'), false);
  assert.equal(shouldAudit('GET', '/health', 'success'), false);
  assert.equal(shouldAudit('GET', '/telemetry/summary', 'success'), false);
  assert.equal(shouldAudit('GET', '/audit', 'success'), false);            // no self-noise

  // Telemetry ingest is a POST, not a GET. Skipping only GETs would let every
  // device's telemetry flush write an audit row — caught in prod, not in test.
  assert.equal(shouldAudit('POST', '/telemetry', 'success'), false);

  // A failing poll is still a failure.
  assert.equal(shouldAudit('GET', '/sync/pull', 'denied'), true);
  assert.equal(shouldAudit('GET', '/sync/pull', 'server_error'), true);
  assert.equal(shouldAudit('POST', '/telemetry', 'server_error'), true);
  // The write surface is always captured.
  assert.equal(shouldAudit('POST', '/sync/push', 'success'), true);
  assert.equal(shouldAudit('PATCH', '/users/abc', 'success'), true);
  assert.equal(shouldAudit('POST', '/auth/token', 'success'), true);
  // Ordinary reads are captured — "who read what" is part of the ask.
  assert.equal(shouldAudit('GET', '/items', 'success'), true);
  // A prefix must not match a sibling route by string prefix alone.
  assert.equal(shouldAudit('GET', '/healthcheck-ish', 'success'), true);
});

test('debug mode captures every request, including the sync polls', () => {
  setAuditDebug(true);
  assert.equal(isAuditDebug(), true);
  assert.equal(shouldAudit('GET', '/sync/pull?since=1', 'success'), true);
  assert.equal(shouldAudit('GET', '/health', 'success'), true);
  assert.equal(shouldAudit('GET', '/audit', 'success'), true);
  setAuditDebug(false);
  assert.equal(isAuditDebug(), false);
});

test('stripQuery removes caller-supplied query strings', () => {
  assert.equal(stripQuery('/sync/pull?since=123&x=1'), '/sync/pull');
  assert.equal(stripQuery('/items'), '/items');
});

test('sanitizeErrorMessage never stores 5xx internals or /auth 4xx messages', () => {
  // 5xx internals (SQL text, stack) are never persisted — mirrors index.ts.
  assert.equal(sanitizeErrorMessage('/items', 500, 'relation "x" does not exist'), null);
  // /auth 4xx can echo submitted field context back out of validation errors.
  assert.equal(sanitizeErrorMessage('/auth/token', 401, 'Invalid credentials'), null);
  assert.equal(sanitizeErrorMessage('/auth/set-pin?x=1', 400, 'body/pin must be 4 digits'), null);
  // Ordinary 4xx messages are useful and safe.
  assert.equal(sanitizeErrorMessage('/items', 400, 'body/name is required'), 'body/name is required');
});

// The central security invariant: the audit row is built from method/url/status/
// timing/ip and a fixed set of headers. It must be structurally impossible for a
// request body or an Authorization header to reach the table. If someone widens
// buildAuditRow to read them, this test fails.
test('buildAuditRow never captures the body, Authorization, or Cookie', () => {
  const secret = 'eyJhbGciOiJIUzI1NiJ9.SUPERSECRET.sig';
  const fakeRequest = {
    method: 'POST',
    url: '/auth/set-pin?trace=1',
    id: '11111111-1111-1111-1111-111111111111',
    ip: '10.0.0.5',
    routeOptions: { url: '/auth/set-pin' },
    // Everything below is sensitive and must not appear in the row.
    body: { user_id: 'u1', pin: '4821', enrollment_code: '918273' },
    headers: {
      authorization: `Bearer ${secret}`,
      cookie: 'refresh=abc123',
      'user-agent': 'InventoryPro/1.0',
      'x-telemetry-device': 'dev-1',
      'x-telemetry-platform': 'android',
      'x-telemetry-appver': '1.0.0',
    },
  } as any;

  const row = buildAuditRow(fakeRequest, 401, 12.7, { id: null, name: null, role: null }, null);
  const serialized = JSON.stringify(row);

  for (const leaked of ['4821', '918273', secret, 'SUPERSECRET', 'abc123', 'Bearer']) {
    assert.ok(!serialized.includes(leaked), `audit row leaked ${leaked}: ${serialized}`);
  }

  // And it captured what it should.
  assert.equal(row.method, 'POST');
  assert.equal(row.route, '/auth/set-pin');
  assert.equal(row.path, '/auth/set-pin');       // query string stripped
  assert.equal(row.status_code, 401);
  assert.equal(row.outcome, 'denied');
  assert.equal(row.duration_ms, 13);
  assert.equal(row.ip, '10.0.0.5');
  assert.equal(row.user_agent, 'InventoryPro/1.0');
  assert.equal(row.device_id, 'dev-1');
  assert.equal(row.security_class, true);
});

// The validation_reject flag threads through to the row WITHOUT weakening the
// invariant above: still a boolean stashed by the error handler, never the
// offending body itself.
test('buildAuditRow marks validation rejects and keeps them security-class', () => {
  const fakeRequest = {
    method: 'POST',
    url: '/items?x=1',
    id: 'r-vr',
    ip: '10.0.0.9',
    routeOptions: { url: '/items' },
    body: { name: 12345, oversized: 'x'.repeat(9000) },   // must never leak
    headers: { 'user-agent': 'InventoryPro/1.0' },
  } as any;

  const row = buildAuditRow(fakeRequest, 400, 3, { id: null, name: null, role: null }, 'body/name must be string', true);
  assert.equal(row.outcome, 'validation_reject');
  assert.equal(row.security_class, true);
  assert.ok(!JSON.stringify(row).includes('oversized'), 'audit row leaked the body');

  // Same request without the flag stays an ordinary client_error.
  const plain = buildAuditRow(fakeRequest, 400, 3, { id: null, name: null, role: null }, null);
  assert.equal(plain.outcome, 'client_error');
});

test('buildAuditRow snapshots the actor so a deleted user stays identifiable', () => {
  const row = buildAuditRow(
    { method: 'GET', url: '/items', id: 'r1', ip: '1.2.3.4', routeOptions: { url: '/items' }, headers: {} } as any,
    200, 5, { id: 'u1', name: 'Dylan', role: 'head_of_construction' }, null,
  );
  assert.equal(row.user_id, 'u1');
  assert.equal(row.actor_name, 'Dylan');
  assert.equal(row.actor_role, 'head_of_construction');
});

// api_request_audit holds cross-user PII and must never replicate to devices.
test('api_request_audit is absent from every sync surface', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const files = [
    path.join(__dirname, '../routes/sync.ts'),
    path.join(__dirname, 'syncPolicy.ts'),
  ];
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    const src = fs.readFileSync(f, 'utf8');
    assert.ok(!src.includes('api_request_audit'), `${path.basename(f)} must not reference api_request_audit`);
  }
});
