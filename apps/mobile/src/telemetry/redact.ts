// Client mirror of the server's prop allowlist (apps/api/src/lib/telemetry.ts
// sanitizeEvent). The two sets MUST stay identical — this is the client-side
// half of the privacy guarantee (never PINs, raw field values, or PII in
// `props`; names/ids/counts/durations/flags only).
export const TELEMETRY_PROP_ALLOWLIST = new Set([
  'itemId', 'unitId', 'locationId', 'jobId', 'teamId', 'repairId', 'userId',
  'count', 'qty', 'durationMs', 'ms', 'code', 'status', 'httpStatus', 'ok',
  'reason', 'table', 'operation', 'attempts', 'kind', 'mode', 'from', 'to', 'tab',
]);

// Ring-buffer cap: telemetry_buffer never grows past this many rows — the
// oldest rows are evicted first. Telemetry loss is acceptable; blocking the
// UI or growing local storage unbounded is not.
export const BUFFER_CAP = 2000;

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
