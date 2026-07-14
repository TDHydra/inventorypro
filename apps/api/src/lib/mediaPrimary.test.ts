import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimsPrimary, isPrimaryConflict, resolvePrimaryClaim, PRIMARY_CONFLICT_INDEX } from './mediaPrimary';

// A fake pg that records the queries it was asked to run and replays canned rows.
function fakePg(responses: unknown[][]) {
  const calls: { sql: string; params: unknown[] }[] = [];
  let i = 0;
  return {
    calls,
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return { rows: responses[i++] ?? [] };
    },
  };
}

const JOB = 'job';
const ENTITY = '11111111-1111-4111-8111-111111111111';
const MINE = '22222222-2222-4222-8222-222222222222';

test('claimsPrimary normalizes every shape a client can send', () => {
  assert.equal(claimsPrimary({ is_primary: true }), true);
  assert.equal(claimsPrimary({ is_primary: 1 }), true);
  assert.equal(claimsPrimary({ is_primary: 'true' }), true);
  assert.equal(claimsPrimary({ is_primary: 't' }), true);
  assert.equal(claimsPrimary({ is_primary: '1' }), true);

  assert.equal(claimsPrimary({ is_primary: false }), false);
  assert.equal(claimsPrimary({ is_primary: 0 }), false);
  assert.equal(claimsPrimary({ is_primary: 'false' }), false);
  // absent / junk is not a claim — never coerce a row that said nothing
  assert.equal(claimsPrimary({}), false);
  assert.equal(claimsPrimary({ is_primary: null }), false);
});

test('a losing claim is coerced to false — first claim wins (bug #50)', async () => {
  // The race: device B's photo claims primary, but device A already holds it.
  const pg = fakePg([[{ '?column?': 1 }]]); // existing primary found
  const row: Record<string, unknown> = {
    id: MINE, entity_type: JOB, entity_id: ENTITY, is_primary: true,
  };

  await resolvePrimaryClaim(pg, row, row.id);

  assert.equal(row.is_primary, false);
  // Scoped to the entity, and excludes the row itself (a re-pushed INSERT of the
  // reigning primary must not demote itself).
  assert.deepEqual(pg.calls[0].params, [JOB, ENTITY, MINE]);
});

test('an uncontested claim survives', async () => {
  const pg = fakePg([[]]); // no existing primary
  const row: Record<string, unknown> = {
    id: MINE, entity_type: JOB, entity_id: ENTITY, is_primary: true,
  };

  await resolvePrimaryClaim(pg, row, row.id);

  assert.equal(row.is_primary, true);
});

test('a row that claims nothing is never touched — and costs no query', async () => {
  const pg = fakePg([[{ '?column?': 1 }]]);
  const row: Record<string, unknown> = {
    id: MINE, entity_type: JOB, entity_id: ENTITY, is_primary: false,
  };

  await resolvePrimaryClaim(pg, row, row.id);

  assert.equal(row.is_primary, false);
  assert.equal(pg.calls.length, 0);
});

test('a partial UPDATE resolves the entity from the stored row', async () => {
  // The move feature sends only the columns it changed, so entity_type/entity_id
  // can be absent from the payload; look them up rather than skipping the check.
  const pg = fakePg([
    [{ entity_type: JOB, entity_id: ENTITY }], // stored row
    [{ '?column?': 1 }],                       // existing primary
  ]);
  const row: Record<string, unknown> = { is_primary: true };

  await resolvePrimaryClaim(pg, row, MINE);

  assert.equal(row.is_primary, false);
  assert.deepEqual(pg.calls[1].params, [JOB, ENTITY, MINE]);
});

test('an unresolvable entity leaves the claim alone (the unique index backstops it)', async () => {
  const pg = fakePg([[]]); // stored row not found
  const row: Record<string, unknown> = { is_primary: true };

  await resolvePrimaryClaim(pg, row, MINE);

  assert.equal(row.is_primary, true);
});

test('isPrimaryConflict matches only the primary index violation', () => {
  assert.equal(isPrimaryConflict({ code: '23505', constraint: PRIMARY_CONFLICT_INDEX }), true);
  assert.equal(
    isPrimaryConflict({ code: '23505', message: `duplicate key value violates unique constraint "${PRIMARY_CONFLICT_INDEX}"` }),
    true,
  );
  // A different unique violation must still surface as a real conflict, not be
  // silently retried as non-primary.
  assert.equal(isPrimaryConflict({ code: '23505', constraint: 'media_pkey' }), false);
  assert.equal(isPrimaryConflict({ code: '23503', constraint: PRIMARY_CONFLICT_INDEX }), false);
  assert.equal(isPrimaryConflict(new Error('boom')), false);
  assert.equal(isPrimaryConflict(null), false);
});
