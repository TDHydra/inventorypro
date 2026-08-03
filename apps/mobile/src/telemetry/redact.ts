// Client mirror of the server's prop allowlist (apps/api/src/lib/telemetry.ts
// sanitizeEvent). The two sets MUST stay identical — this is the client-side
// half of the privacy guarantee (never PINs, raw field values, or PII in
// `props`; names/ids/counts/durations/flags only).
export const TELEMETRY_PROP_ALLOWLIST = new Set([
  'itemId', 'unitId', 'locationId', 'jobId', 'teamId', 'repairId', 'userId',
  'count', 'qty', 'durationMs', 'ms', 'code', 'status', 'httpStatus', 'ok',
  'reason', 'table', 'operation', 'attempts', 'kind', 'mode', 'from', 'to', 'tab',
  // validation_reject metadata: the FIELD PATH and RULE NAME only — never the
  // entered value (which must not appear anywhere in telemetry).
  'field', 'rule',
  // outbox_heartbeat (#236): fleet sync-health counts — three independent
  // buckets, so 'count' alone can't carry them.
  'pending', 'failed', 'denied',
]);

// Ring-buffer cap: telemetry_buffer never grows past this many rows — the
// oldest rows are evicted first. Telemetry loss is acceptable; blocking the
// UI or growing local storage unbounded is not.
export const BUFFER_CAP = 2000;

// How many oldest rows track() must evict after an insert to hold the buffer at
// BUFFER_CAP. Pure + exported so the ring-buffer policy is unit-testable without
// a live SQLite handle (track() does the actual DELETE with this count).
export function excessToEvict(count: number, cap: number = BUFFER_CAP): number {
  return count > cap ? count - cap : 0;
}

// Mirror of the server's sanitizeLabel (apps/api/src/lib/telemetry.ts). name/
// screen are identifiers (route patterns, testIDs, action keys), NOT free text
// — the props allowlist can't guard them, so strip control chars, collapse
// whitespace, and cap length before they ever leave the device.
export function sanitizeLabel(s: string, max = 120): string {
  return s.replace(/[\x00-\x1f\x7f]+/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function redactProps(obj: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!obj) return out;
  for (const k of Object.keys(obj)) {
    if (!TELEMETRY_PROP_ALLOWLIST.has(k)) continue;
    const v = obj[k];
    if (typeof v === 'string') out[k] = v.slice(0, 200);
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  }
  return out;
}
