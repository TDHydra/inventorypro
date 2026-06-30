export type ScanResult =
  | { kind: 'item'; id: string }
  | { kind: 'unit'; assetTag: string }
  | { kind: 'barcode'; code: string }
  | null;

// Item ids are UUIDs (server-authoritative). Accept only a canonical UUID so a
// crafted `INV:item:<junk>` can't be fed straight into getItemById / nav params.
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// Asset tags are short, human-printable identifiers. Bound the charset to
// printable ASCII (no spaces/control chars) and a sane length so a malicious
// `INV:unit:<huge/control junk>` is rejected rather than queried on.
const MAX_ASSET_TAG_LENGTH = 128;
const ASSET_TAG_RE = /^[\x21-\x7E]{1,128}$/;

/**
 * Parse a scanned string into a typed result.
 *
 * - `INV:item:<id>`   → { kind:'item', id }      (id must be a UUID)
 * - `INV:unit:<tag>`  → { kind:'unit', assetTag } (printable, ≤128 chars)
 * - anything else     → { kind:'barcode', code }
 * - malformed prefix / malformed id or tag → null
 */
export function resolveScan(data: string): ScanResult {
  if (data.startsWith('INV:item:')) {
    const id = data.slice('INV:item:'.length);
    return UUID_RE.test(id) ? { kind: 'item', id } : null;
  }
  if (data.startsWith('INV:unit:')) {
    const assetTag = data.slice('INV:unit:'.length);
    return assetTag.length <= MAX_ASSET_TAG_LENGTH && ASSET_TAG_RE.test(assetTag)
      ? { kind: 'unit', assetTag }
      : null;
  }
  return { kind: 'barcode', code: data };
}
