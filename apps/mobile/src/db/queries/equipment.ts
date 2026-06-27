import { getDb, rowsAs } from '../schema';

/**
 * Returns the next available asset tag for the given prefix.
 *
 * Queries equipment_units for all tags that start with `prefix`, parses the
 * trailing integer from each, and returns prefix + (max + 1) zero-padded to
 * three digits.  Returns prefix + '001' when no matching tags exist yet.
 *
 * Example: prefix 'AM-', existing tags ['AM-001','AM-003'] → 'AM-004'.
 */
export function nextAssetTag(prefix: string): string {
  const db = getDb();
  const rows = rowsAs<{ asset_tag: string }>(
    db.executeSync(
      `SELECT asset_tag FROM equipment_units WHERE asset_tag LIKE ?`,
      [prefix + '%'],
    ).rows,
  );

  let max = 0;
  for (const { asset_tag } of rows) {
    const suffix = asset_tag.slice(prefix.length);
    const n = parseInt(suffix, 10);
    if (!isNaN(n) && n > max) max = n;
  }

  return prefix + String(max + 1).padStart(3, '0');
}
