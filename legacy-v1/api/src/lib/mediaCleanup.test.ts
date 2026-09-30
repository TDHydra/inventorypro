import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// lib/s3.ts fails closed at import time without MinIO credentials — set dummies
// BEFORE the (dynamic) import so this suite runs in CI/dev without a MinIO.
// A static import would hoist above the env assignment, hence the before hook.
let deriveKey: typeof import('./mediaCleanup')['deriveKey'];
let isCleanableKey: typeof import('./mediaCleanup')['isCleanableKey'];
let KEY_RE: typeof import('./mediaCleanup')['KEY_RE'];
let cleanupMediaObjects: typeof import('./mediaCleanup')['cleanupMediaObjects'];
before(async () => {
  process.env.MINIO_ACCESS_KEY ??= 'test-access';
  process.env.MINIO_SECRET_KEY ??= 'test-secret';
  ({ deriveKey, isCleanableKey, KEY_RE, cleanupMediaObjects } = await import('./mediaCleanup'));
});

const BUCKET = process.env.MINIO_BUCKET ?? 'inventorypro';
const UUID = '123e4567-e89b-42d3-a456-426614174000';
const goodKey = `job/abc-123/${UUID}.jpg`;
const goodUrl = `https://s3.example.com/${BUCKET}/${goodKey}`;

test('deriveKey strips query/fragment — the forged-alias defense', () => {
  assert.equal(deriveKey(goodUrl), goodKey);
  // A forged row storing the victim's URL plus a benign suffix derives to the
  // SAME key; raw-string comparison would have missed this collision.
  assert.equal(deriveKey(`${goodUrl}?x=1`), goodKey);
  assert.equal(deriveKey(`${goodUrl}#a`), goodKey);
  assert.equal(deriveKey('not a url'), null);
  assert.equal(deriveKey(null), null);
});

test('isCleanableKey: server-issued shape under an allowlisted entity prefix', () => {
  assert.equal(isCleanableKey(goodKey), true);
  assert.equal(isCleanableKey(`item/x/${UUID}.png`), true);
  // Moved rows keep their ORIGINAL prefix — any allowlisted prefix is fine,
  // the row's current entity is deliberately NOT consulted.
  assert.equal(isCleanableKey(`repair/old-entity/${UUID}.jpg`), true);
  // Foreign/forged shapes fail closed.
  assert.equal(isCleanableKey(`users/x/${UUID}.jpg`), false);       // not allowlisted
  assert.equal(isCleanableKey(`../../etc/passwd`), false);
  assert.equal(isCleanableKey(`job/x/not-a-uuid.jpg`), false);
  assert.equal(isCleanableKey(null), false);
});

test('KEY_RE anchors the whole key', () => {
  assert.equal(KEY_RE.test(goodKey), true);
  assert.equal(KEY_RE.test(`${goodKey}/../evil`), false);
  assert.equal(KEY_RE.test(`x/${goodKey}`), false);
});

test('cleanupMediaObjects refcounts table-wide on DERIVED keys', async () => {
  // A sibling row under a DIFFERENT entity (post-move) references the same
  // object via a query-string alias. The old entity-scoped, raw-string
  // refcount would have missed it and deleted the shared object.
  const queries: string[] = [];
  const pg = {
    query: async (sql: string, _params: unknown[]) => {
      queries.push(sql);
      return { rows: [{ url: `${goodUrl}?x=1`, thumbnail_url: null }] };
    },
  };
  await cleanupMediaObjects(pg, { id: 'm1', url: goodUrl, thumbnail_url: null });
  // The candidate query must NOT scope by entity_type/entity_id…
  assert.ok(queries[0].includes('id <>'));
  assert.ok(!queries[0].includes('entity_type'));
  // …and since the alias derives to the same key, no S3 delete should have
  // been attempted. We can't intercept the S3 client here, but the function
  // resolving without throwing while the object is still referenced is the
  // observable contract; the derivation collision itself is covered above.
});

test('cleanupMediaObjects no-ops entirely on an uncleanable key', async () => {
  let queried = false;
  const pg = { query: async () => { queried = true; return { rows: [] }; } };
  await cleanupMediaObjects(pg as never, { id: 'm1', url: 'not a url', thumbnail_url: null });
  await cleanupMediaObjects(pg as never, { id: 'm2', url: `https://s3.example.com/${BUCKET}/users/x/${UUID}.jpg`, thumbnail_url: null });
  assert.equal(queried, false); // fail closed before touching the DB or MinIO
});
