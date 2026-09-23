import type { TableGuard } from '../types';

// Remap in-batch references from an already-merged duplicate vehicle to its
// survivor, so the batch's follow-up rows (vehicles ext, stock, checkouts,
// activity) land on the row the server actually kept. Applies to EVERY entry
// (registered '*'), ordered before the locations guards below — exactly where
// the old monolith ran it.
export const vehicleAliasRemap: TableGuard = {
  table: '*',
  async authorizeRow(ctx, entry) {
    if (ctx.batch.vehicleAlias.size === 0) return undefined;
    const refCols = ['location_id', 'vehicle_location_id', 'site_location_id', 'current_location_id', 'home_location_id', 'from_location_id', 'to_location_id', 'parent_id'];
    const cols = entry.table_name === 'locations' ? [...refCols, 'id'] : refCols;
    for (const col of cols) {
      const v = entry.payload[col];
      if (typeof v === 'string' && ctx.batch.vehicleAlias.has(v)) entry.payload[col] = ctx.batch.vehicleAlias.get(v);
    }
    return undefined;
  },
};

export const locationsGuard: TableGuard = {
  table: 'locations',
  async authorizeRow(ctx, entry) {
    // No sub-areas under vehicles/lockers (#122 A1): migration 059 flattened
    // the existing ones; block re-creation. Parent type comes from the DB,
    // never the payload. Wording matches the mobile permanent-rejection regex.
    if ((entry.operation === 'INSERT' || entry.operation === 'UPDATE')
        && entry.payload.parent_id != null) {
      let parentType: string | null = null;
      try {
        const { rows: pRows } = await ctx.pg.query(
          `SELECT type FROM locations WHERE id = $1`, [entry.payload.parent_id],
        );
        parentType = pRows[0] ? String((pRows[0] as { type: string | null }).type ?? '') : null;
      } catch { parentType = null; }
      if (parentType === 'Vehicle' || parentType === 'Locker') {
        return { error: 'Forbidden: vehicles and lockers cannot contain sub-areas', code: 'NOT_ALLOWED' };
      }
    }

    // #129: server-side normalized-name uniqueness for Vehicle-typed locations.
    // A duplicate INSERT is MERGED into the existing row: the entry is ok'd
    // (the client outbox clears), nothing is inserted, and the dup id aliases
    // to the survivor for the rest of the batch + the merged[] response (the
    // client re-points its local rows — see mobile engine).
    if (entry.operation === 'INSERT' && String(entry.payload.type ?? '') === 'Vehicle') {
      let survivorId: string | null = null;
      try {
        const { rows: dupRows } = await ctx.pg.query(
          `SELECT id FROM locations
            WHERE type = 'Vehicle' AND active = TRUE
              AND LOWER(TRIM(name)) = LOWER(TRIM($1)) AND id <> $2
            LIMIT 1`,
          [String(entry.payload.name ?? ''), entry.payload.id],
        );
        survivorId = dupRows[0] ? String((dupRows[0] as { id: string }).id) : null;
      } catch { survivorId = null; }
      if (survivorId) {
        ctx.batch.vehicleAlias.set(String(entry.payload.id), survivorId);
        ctx.batch.merged.push({ id: entry.id, duplicate_id: String(entry.payload.id), survivor_id: survivorId });
        return { handled: true };
      }
    }
    return undefined;
  },
};
