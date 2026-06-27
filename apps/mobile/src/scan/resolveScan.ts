export type ScanResult =
  | { kind: 'item'; id: string }
  | { kind: 'unit'; assetTag: string }
  | { kind: 'barcode'; code: string }
  | null;

/**
 * Parse a scanned string into a typed result.
 *
 * - `INV:item:<id>`   → { kind:'item', id }
 * - `INV:unit:<tag>`  → { kind:'unit', assetTag }
 * - anything else     → { kind:'barcode', code }
 * - malformed prefix  → null
 */
export function resolveScan(data: string): ScanResult {
  if (data.startsWith('INV:item:')) {
    const id = data.slice('INV:item:'.length);
    return id ? { kind: 'item', id } : null;
  }
  if (data.startsWith('INV:unit:')) {
    const assetTag = data.slice('INV:unit:'.length);
    return assetTag ? { kind: 'unit', assetTag } : null;
  }
  return { kind: 'barcode', code: data };
}
