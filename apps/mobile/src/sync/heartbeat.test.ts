import { test } from 'node:test';
import assert from 'node:assert';
import { shouldEmitHeartbeat, HEARTBEAT_INTERVAL_MS } from './heartbeat';

// #236: pure throttle/gate logic for the fleet sync-health heartbeat. Kept
// framework-free (no db/schema import) so it can run under plain node:test —
// engine.ts owns the one call site that wires this to track()/getOutboxCounts().

test('never emitted before (lastMs null) + all-zero counts: no emit (no signal yet)', () => {
  assert.equal(
    shouldEmitHeartbeat(1_000_000, null, { pending: 0, failed: 0, denied: 0 }),
    false
  );
});

test('never emitted before (lastMs null) + nonzero counts: emits immediately', () => {
  assert.equal(
    shouldEmitHeartbeat(1_000_000, null, { pending: 3, failed: 0, denied: 0 }),
    true
  );
});

test('nonzero counts always emit once the throttle window has elapsed, regardless of last emit', () => {
  const last = 1_000_000;
  const now = last + HEARTBEAT_INTERVAL_MS; // exactly at the boundary
  assert.equal(
    shouldEmitHeartbeat(now, last, { pending: 0, failed: 1, denied: 0 }),
    true
  );
});

test('nonzero counts within the 30-minute throttle window: suppressed', () => {
  const last = 1_000_000;
  const now = last + HEARTBEAT_INTERVAL_MS - 1;
  assert.equal(
    shouldEmitHeartbeat(now, last, { pending: 5, failed: 0, denied: 0 }),
    false
  );
});

test('all-zero counts, still within throttle window, no prior nonzero emit: suppressed', () => {
  const last = 1_000_000;
  const now = last + 1_000;
  assert.equal(
    shouldEmitHeartbeat(now, last, { pending: 0, failed: 0, denied: 0 }, false),
    false
  );
});

test('all-zero counts right after a nonzero emit: emits the return-to-zero transition even inside the window', () => {
  const last = 1_000_000;
  const now = last + 1_000; // well inside the 30-minute window
  assert.equal(
    shouldEmitHeartbeat(now, last, { pending: 0, failed: 0, denied: 0 }, true),
    true
  );
});

test('all-zero counts after a prior all-zero emit and window elapsed: still suppressed (no new signal)', () => {
  const last = 1_000_000;
  const now = last + HEARTBEAT_INTERVAL_MS + 1;
  assert.equal(
    shouldEmitHeartbeat(now, last, { pending: 0, failed: 0, denied: 0 }, false),
    false
  );
});

// #236 reviewer regression: the heartbeat's whole payload is {pending, failed,
// denied} — if those keys ever fall out of TELEMETRY_PROP_ALLOWLIST, track()'s
// redactProps silently strips them and every heartbeat lands as props: {}.
test('heartbeat count props survive redactProps intact', async () => {
  const { redactProps } = await import('../telemetry/redact');
  assert.deepEqual(
    redactProps({ pending: 3, failed: 1, denied: 0 }),
    { pending: 3, failed: 1, denied: 0 }
  );
});
