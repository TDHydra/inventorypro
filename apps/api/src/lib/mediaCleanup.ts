import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { s3, BUCKET } from './s3';
import { MEDIA_ENTITY_TYPES } from './syncPolicy';

// MinIO object cleanup for deleted media rows — shared by the REST
// DELETE /media/:id route and the sync-push DELETE branch (which previously
// orphaned every object: only the REST route cleaned up, and no client calls
// the REST route).

// Server-issued object key shape: entity_type/entity_id/uuid.ext — anchors any
// delete to a key WE generated in /upload-url, never a client-controlled path.
export const KEY_RE = /^[a-z_]+\/[a-zA-Z0-9_-]{1,64}\/[0-9a-f-]{36}\.[a-z0-9]{2,5}$/;

// Derive the object key from a stored media URL. new URL().pathname strips
// query/fragment, which is load-bearing for the forged-alias defense below.
export function deriveKey(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).pathname.replace(`/${BUCKET}/`, '');
  } catch {
    return null;
  }
}

// A key is cleanable when it has the server-issued shape AND sits under an
// allowlisted entity prefix. Deliberately NOT checked against the row's
// CURRENT entity_type/entity_id: the move feature re-links a row to another
// job while its object stays under the ORIGINAL upload prefix, so the old
// row-prefix check would refuse cleanup for every moved photo. The key was
// server-issued either way; shape + allowlist still blocks foreign/forged paths.
export function isCleanableKey(key: string | null): key is string {
  return key != null && KEY_RE.test(key) && MEDIA_ENTITY_TYPES.has(key.split('/')[0]);
}

interface MediaRowForCleanup {
  id: string;
  url: string;
  thumbnail_url: string | null;
}

type Pg = { query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }> };

// Delete the MinIO object(s) behind a just-deleted media row, unless another
// row still references them. Best-effort by design: the DB row is already
// gone, and a failed object delete only leaves an orphan (never data loss).
//
// The refcount is TABLE-WIDE, not scoped to the row's entity: after a move,
// sibling rows sharing the object can live under a DIFFERENT entity, and the
// old entity-scoped query would miss them and destroy a still-referenced
// object. Candidates are narrowed with a LIKE on the '/uuid.ext' suffix (the
// uuid filename is globally unique and contains no LIKE metacharacters), then
// compared on DERIVED keys — a raw-string compare would miss a forged alias
// like the victim's URL plus '?x=1', whose derived key collides.
export async function cleanupMediaObjects(pg: Pg, row: MediaRowForCleanup): Promise<void> {
  const key = deriveKey(row.url);
  if (!isCleanableKey(key)) return; // fail closed — never touch an odd-shaped key
  const derivedThumb = deriveKey(row.thumbnail_url);
  const thumbKey = isCleanableKey(derivedThumb) && derivedThumb !== key ? derivedThumb : null;

  const suffixes = [...new Set([key, thumbKey].filter((k): k is string => k != null)
    .map(k => `/${k.split('/').pop()}`))];
  const where = suffixes
    .map((_, i) => `url LIKE $${i + 2} OR thumbnail_url LIKE $${i + 2}`)
    .join(' OR ');
  const { rows } = await pg.query(
    `SELECT url, thumbnail_url FROM media WHERE id <> $1 AND (${where})`,
    [row.id, ...suffixes.map(s => `%${s}`)],
  );

  const referenced = new Set<string>();
  for (const candidate of rows as { url: string; thumbnail_url: string | null }[]) {
    const k = deriveKey(candidate.url);
    if (k) referenced.add(k);
    const t = deriveKey(candidate.thumbnail_url);
    if (t) referenced.add(t);
  }

  if (!referenced.has(key)) {
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
    } catch {
      // best-effort — an orphaned object is acceptable, a blocked delete is not
    }
  }
  if (thumbKey && !referenced.has(thumbKey)) {
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: thumbKey }));
    } catch {
      // same
    }
  }
}
