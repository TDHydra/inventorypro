// Server-side telemetry event sanitizer. Mirrors the client's redactProps
// (apps/mobile/src/telemetry/redact.ts) — the two allowlists MUST stay
// identical, since a prop that's meaningless on one side but present on the
// other is a sign the contract has drifted.
const TYPES = new Set(['screen', 'action', 'error', 'audit']);

// Safe, non-PII prop keys. Names/ids/metrics only — never field contents.
export const TELEMETRY_PROP_ALLOWLIST = new Set([
  'itemId', 'unitId', 'locationId', 'jobId', 'teamId', 'repairId', 'userId',
  'count', 'qty', 'durationMs', 'ms', 'code', 'status', 'httpStatus', 'ok',
  'reason', 'table', 'operation', 'attempts', 'kind', 'mode', 'from', 'to', 'tab',
]);

export interface CleanEvent {
  type: string; name: string; screen: string | null;
  props: Record<string, unknown>; client_ts: string | null;
}

// name/screen are identifiers (route patterns, testIDs, action keys) — NOT free
// text. The props allowlist can't protect these fields, so this is their guard:
// drop control chars + collapse whitespace runs (a defense against a caller
// smuggling multi-word content), and hard-cap length. The primary defense is
// upstream (clients source these from route patterns / testIDs, never raw
// accessibility labels), but the server never trusts that.
export function sanitizeLabel(s: string, max = 120): string {
  return s.replace(/[\x00-\x1f\x7f]+/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function sanitizeEvent(raw: any): CleanEvent | null {
  if (!raw || typeof raw.type !== 'string' || !TYPES.has(raw.type)) return null;
  if (typeof raw.name !== 'string' || !raw.name) return null;
  const name = sanitizeLabel(raw.name);
  if (!name) return null;
  const props: Record<string, unknown> = {};
  if (raw.props && typeof raw.props === 'object') {
    for (const k of Object.keys(raw.props)) {
      if (!TELEMETRY_PROP_ALLOWLIST.has(k)) continue;
      const v = raw.props[k];
      if (typeof v === 'string') props[k] = v.slice(0, 200);
      else if (typeof v === 'number' || typeof v === 'boolean') props[k] = v;
    }
  }
  return {
    type: raw.type,
    name,
    screen: typeof raw.screen === 'string' ? sanitizeLabel(raw.screen) : null,
    props,
    client_ts: typeof raw.client_ts === 'string' ? raw.client_ts.slice(0, 40) : null,
  };
}
