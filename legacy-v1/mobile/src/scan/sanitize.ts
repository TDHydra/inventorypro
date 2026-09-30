// Scanned input is attacker-influenceable: a malicious QR code or a misbehaving
// USB/Bluetooth HID scanner can emit megabytes of data or control characters.
// Bound and clean every scanned value at ingestion, before it reaches queries,
// outbox payloads, or navigation params.

export const MAX_BARCODE_LENGTH = 512;

// ASCII control chars (NUL..US plus DEL). A wedge scanner often appends CR/LF/Tab.
// Built from escapes (not literal bytes) so the source stays plain-ASCII.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = new RegExp('[\\x00-\\x1F\\x7F]', 'g');

/**
 * Normalizes a raw scanned/typed code: strips control characters and trims
 * surrounding whitespace. Returns null when the result is empty or longer than
 * MAX_BARCODE_LENGTH — callers should ignore a null (treat as "no valid scan")
 * rather than act on it.
 */
export function sanitizeScan(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const cleaned = raw.replace(CONTROL_CHARS, '').trim();
  if (!cleaned) return null;
  if (cleaned.length > MAX_BARCODE_LENGTH) return null;
  return cleaned;
}

/** True when a raw scan is usable (non-empty, within the length bound). */
export function isValidScanLength(raw: string | null | undefined): boolean {
  return sanitizeScan(raw) !== null;
}
