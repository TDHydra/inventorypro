import { test } from 'node:test';
import assert from 'node:assert';
import { applyCheckIn, markClean } from './cleanliness';

test('applyCheckIn: AirMax cadence (N=1) — every check-in dirties a clean unit', () => {
  const r = applyCheckIn({ cleanliness: 'clean', jobs_since_clean: 0 }, 1);
  assert.deepEqual(r, { cleanliness: 'dirty', jobs_since_clean: 1, autoDirtied: true });
});

test('applyCheckIn: Velo cadence (N=2) — first check-in stays clean, second dirties', () => {
  const first = applyCheckIn({ cleanliness: 'clean', jobs_since_clean: 0 }, 2);
  assert.deepEqual(first, { cleanliness: 'clean', jobs_since_clean: 1, autoDirtied: false });

  const second = applyCheckIn({ cleanliness: first.cleanliness, jobs_since_clean: first.jobs_since_clean }, 2);
  assert.deepEqual(second, { cleanliness: 'dirty', jobs_since_clean: 2, autoDirtied: true });
});

test('applyCheckIn: null cadence (off) — counter increments, never auto-dirties', () => {
  const r = applyCheckIn({ cleanliness: 'clean', jobs_since_clean: 5 }, null);
  assert.deepEqual(r, { cleanliness: 'clean', jobs_since_clean: 6, autoDirtied: false });
});

test('applyCheckIn: 0 cadence (off) — same as null, counter still increments', () => {
  const r = applyCheckIn({ cleanliness: 'clean', jobs_since_clean: 3 }, 0);
  assert.deepEqual(r, { cleanliness: 'clean', jobs_since_clean: 4, autoDirtied: false });
});

test('applyCheckIn: already-dirty unit — counter keeps incrementing, no re-log', () => {
  const r = applyCheckIn({ cleanliness: 'dirty', jobs_since_clean: 4 }, 1);
  assert.deepEqual(r, { cleanliness: 'dirty', jobs_since_clean: 5, autoDirtied: false });
});

test('applyCheckIn: already-dirty unit past cadence again — still no re-flip/re-log', () => {
  // Cadence of 2, already dirty at count 2 — a third check-in must not
  // produce a second autoDirtied:true (double-logging guard).
  const r = applyCheckIn({ cleanliness: 'dirty', jobs_since_clean: 2 }, 2);
  assert.deepEqual(r, { cleanliness: 'dirty', jobs_since_clean: 3, autoDirtied: false });
});

test('applyCheckIn: negative cadence treated as off', () => {
  const r = applyCheckIn({ cleanliness: 'clean', jobs_since_clean: 0 }, -1);
  assert.deepEqual(r, { cleanliness: 'clean', jobs_since_clean: 1, autoDirtied: false });
});

test('markClean: resets cleanliness to clean and counter to zero', () => {
  assert.deepEqual(markClean(), { cleanliness: 'clean', jobs_since_clean: 0 });
});
