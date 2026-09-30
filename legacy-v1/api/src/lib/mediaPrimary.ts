// One primary photo per entity — server-side enforcement (bug #50).
//
// The client elects "first photo on this entity becomes its primary" from its
// LOCAL replica (mobile media/uploadCore.ts). Two devices uploading to the same
// empty entity both see zero media, both stamp is_primary=true, and because each
// media row carries its own client-generated UUID the two INSERTs never collide
// on the sync upsert's conflict target — both land, and the entity shows two
// stars forever. The client cannot close this race on its own.
//
// Semantics: FIRST CLAIM WINS. is_primary=true is always an automatic election
// (there is no "set as primary" UI anywhere), so deferring to the existing
// primary loses no user intent and keeps the star stable — clear-others-on-insert
// would make it jump whenever a stale offline batch syncs hours later.

export const PRIMARY_CONFLICT_INDEX = 'media_one_primary_idx';

type Pg = { query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }> };

type Row = Record<string, unknown>;

// Does this payload claim primary? The mobile outbox sends a JS boolean, but the
// web client and hand-rolled payloads can send 1 / 'true' / 't' — normalize them
// all, and treat anything else (including undefined) as "no claim".
export function claimsPrimary(row: Row): boolean {
  const v = row.is_primary;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v === 1;
  if (typeof v === 'string') return v === 'true' || v === '1' || v === 't';
  return false;
}

// A unique violation on the partial index = another device won the race between
// our existence check and our write (migration 050). Callers retry as non-primary
// rather than letting the entry strand as a permanent conflict — an unsynced photo
// is worse than an unstarred one.
export function isPrimaryConflict(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string; message?: string } | null;
  if (!e || e.code !== '23505') return false;
  return e.constraint === PRIMARY_CONFLICT_INDEX
    || (e.message?.includes(PRIMARY_CONFLICT_INDEX) ?? false);
}

// Coerce a losing primary claim to false, in place, before the row is written.
// No-op unless the row actually claims primary. The entity comes from the payload
// when present (INSERT always carries it); on a partial UPDATE it may not, so fall
// back to the stored row. If the entity can't be resolved at all we leave the claim
// alone — the unique index still backstops it.
export async function resolvePrimaryClaim(pg: Pg, row: Row, id: unknown): Promise<void> {
  if (!claimsPrimary(row)) return;

  let entityType = row.entity_type;
  let entityId = row.entity_id;

  if ((entityType == null || entityId == null) && id != null) {
    const { rows } = await pg.query(
      `SELECT entity_type, entity_id FROM media WHERE id = $1`,
      [id],
    );
    const stored = rows[0] as { entity_type: string; entity_id: string } | undefined;
    if (!stored) return;
    entityType ??= stored.entity_type;
    entityId ??= stored.entity_id;
  }
  if (entityType == null || entityId == null) return;

  const { rows } = await pg.query(
    `SELECT 1 FROM media
     WHERE entity_type = $1 AND entity_id = $2 AND is_primary AND id IS DISTINCT FROM $3
     LIMIT 1`,
    [entityType, entityId, id ?? null],
  );
  if (rows.length > 0) row.is_primary = false; // someone already holds it — first claim wins
}
